import { createServer } from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import { readFile, mkdtemp, chmod, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Store } from "../../server/node-store.js";
import { createHandler } from "../../server/handler.js";
import { identityFor } from "../../server/guest-identities.js";
import { referenceFor } from "../../server/rsvp-cards.js";
import { ensurePersonalProfile } from "../../server/personal-accounts.js";
import {
  CENTRAL,
  PROJECT,
  requireTest,
  tokenPhone,
  NetworkPolicy,
} from "./policy.mjs";
export const PREFIX = "gather-fictional-firebase-";
export async function isolatedFixture(
  config,
  { policy = new NetworkPolicy(config), scenario = "guest" } = {},
) {
  requireTest(["guest", "host"].includes(scenario), "SCENARIO_INVALID");
  const actor = {
    first: "Firebase",
    last: scenario === "host" ? "Test Host" : "Test Guest",
  };
  const directory = await mkdtemp(join(tmpdir(), PREFIX));
  await chmod(directory, 0o700);
  await writeFile(
    join(directory, "owner.json"),
    JSON.stringify({ kind: PREFIX, pid: process.pid }),
    { mode: 0o600 },
  );
  let store;
  const servers = [],
    sites = new Map(),
    hosts = new Set([
      "harness-primary.ilymmd.com",
      "harness-secondary.ilymmd.com",
    ]);
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await Promise.all(
      servers.map(
        (server) =>
          new Promise((resolve) => {
            server.closeAllConnections();
            server.close(resolve);
          }),
      ),
    );
    try {
      store?.db.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  try {
    store = new Store(join(directory, "isolated.sqlite"));
    const password = randomBytes(32).toString("base64url");
    await store.createAdmin("admin@harness.invalid", password);
    const records = [];
    for (const name of ["Harness Primary", "Harness Secondary"]) {
      const email =
        name.toLowerCase().replaceAll(" ", "-") + "@harness.invalid";
      store.run("INSERT INTO approvals VALUES(?,?)", email, "isolated-harness");
      const host = await store.register({ email, password, name });
      records.push({
        host,
        origin:
          "https://" +
          store.household(host.household).subdomain +
          ".ilymmd.com",
      });
    }
    const env = {
      FIREBASE_PROJECT_ID: PROJECT,
      FIREBASE_API_KEY: config.apiKey,
      FIREBASE_AUTH_DOMAIN: config.authDomain,
      FIREBASE_AUTH_ENABLED: "true",
      FIREBASE_ACTIVATION_APPROVED: "true",
      GATHER_UNIVERSAL_ENABLED: "true",
      SMS_ENABLED: "false",
      AUTH_SMS_ENABLED: "false",
      LEGACY_SMS_FALLBACK_APPROVED: "false",
    };
    for (const origin of [CENTRAL, ...records.map((r) => r.origin)]) {
      const handler = createHandler({
        store,
        env,
        origin,
        canonicalOrigin: CENTRAL,
        householdHosts: hosts,
        householdHostname: origin === CENTRAL ? "" : new URL(origin).hostname,
        readAsset: (file) =>
          readFile(new URL("../../public/" + file, import.meta.url)),
        firebaseFetcher: (...args) => policy.backendFetch(...args),
        logger: { error() {} },
      });
      const server = createServer(async (req, res) => {
        try {
          const parts = [];
          let size = 0;
          for await (const part of req) {
            size += part.length;
            requireTest(size <= 64000, "REQUEST_TOO_LARGE");
            parts.push(part);
          }
          const data = Buffer.concat(parts);
          if (req.url.split("?")[0] === "/api/firebase/start")
            policy.phone(JSON.parse(data).phone);
          if (req.url.split("?")[0] === "/api/firebase/verify")
            policy.phone(tokenPhone(JSON.parse(data).idToken));
          const replay = Readable.from(data.length ? [data] : []);
          Object.assign(replay, {
            method: req.method,
            url: req.url,
            headers: req.headers,
            socket: { remoteAddress: "isolated-harness" },
          });
          await handler(replay, res);
        } catch {
          if (!res.headersSent)
            res.writeHead(403, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Isolated test request blocked." }));
        }
      });
      servers.push(server);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      sites.set(origin, {
        origin,
        url: "http://127.0.0.1:" + server.address().port,
      });
    }
    async function seed(record, path, data) {
      const auth = store.newSession(
        { ...record.host, role: "host" },
        record.origin,
      );
      const response = await fetch(sites.get(record.origin).url + path, {
        method: "POST",
        headers: {
          Origin: record.origin,
          Cookie: "__Host-events_session=" + auth.token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
        redirect: "error",
      });
      requireTest(response.status === 201, "FIXTURE_SEED_FAILED");
      return response.json();
    }
    for (const record of records)
      record.guest = await seed(record, "/api/host/guests", {
        first: actor.first,
        last: actor.last,
        phone: config.fictionalPhoneNumbers[0],
      });
    let identity = identityFor(
      store,
      records[0].guest,
      records[0].host.household,
    ).id;
    if (scenario === "host") {
      // Synthetic fixture only: establish a pre-existing, independently verified
      // owner association using the same shared profile model as auth tests.
      // This never enrolls/claims a production account or derives host authority
      // from a typed phone. Registration approval above establishes the owner.
      const ready = ensurePersonalProfile(store, {
        ...records[0].host,
        role: "host",
      });
      identity = ready.identity;
      store.put(
        "personal-household",
        ready.profile.id,
        "platform",
        {
          ...ready.profile,
          members: ready.profile.members.map((m) =>
            m.identity === identity
              ? { ...m, ...actor, phone: config.fictionalPhoneNumbers[0] }
              : m,
          ),
        },
        ready.profile.version,
      );
      store.put("guest-auth-contact", identity, "platform", {
        phone: config.fictionalPhoneNumbers[0],
        verified: true,
        verifiedAt: Date.now(),
      });
      store.run(
        "UPDATE guest_identity_links SET identity=? WHERE household=? AND guest=?",
        identity,
        records[0].host.household,
        records[0].guest.id,
      );
    }
    store.run(
      "UPDATE guest_identity_links SET identity=? WHERE household=? AND guest=?",
      identity,
      records[1].host.household,
      records[1].guest.id,
    );
    for (const record of records) {
      record.event = await seed(record, "/api/host/events", {
        title: "Isolated Firebase invitation",
        description: "Temporary harness data only",
        date: "2099-01-01",
        deadline: "2098-12-31",
        invited: [record.guest.id],
        menu: [],
        registries: [],
      });
      record.reference = referenceFor(
        store,
        record.host.household,
        record.event,
        { id: record.guest.id, guests: [record.guest.id] },
      );
    }
    return {
      directory,
      store,
      records,
      identity,
      scenario,
      actor,
      sites,
      policy,
      close,
      profile: join(directory, "browser-profile"),
      invitation: CENTRAL + "/invite/" + records[0].reference,
      entry:
        scenario === "host"
          ? records[0].origin
          : CENTRAL + "/invite/" + records[0].reference,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

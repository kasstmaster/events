import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { Store } from "../server/node-store.js";
import {
  runProvisioning,
  provisionHousehold,
} from "../cloudflare/household-provisioner.js";
import {
  cloudflareRouting,
  waitForActive,
} from "./helpers/cloudflare-routing.js";
import {
  domainRuntime,
  seedDomains,
  canonical,
  password,
} from "./helpers/domain-runtime.js";

async function fixture() {
  const store = new Store();
  store.run(
    "INSERT INTO approvals VALUES(?,?)",
    "new@example.test",
    "synthetic",
  );
  const account = await store.register({
    email: "new@example.test",
    password,
    name: "Dubois",
  });
  return { store, account, job: store.routingJob("dubois") };
}
const env = {
  HOUSEHOLD_ROUTING_ENABLED: "true",
  HOUSEHOLD_DNS_TOKEN: "synthetic-not-real",
};
function network(
  store,
  api,
  { badProof = false, failAssets = false, retire = false } = {},
) {
  return async (input, init) => {
    if (input.startsWith("https://api.cloudflare.com/"))
      return api.fetcher(input, init);
    const url = new URL(input);
    assert.equal(url.hostname, "dubois.ilymmd.com");
    assert.equal(init.redirect, "manual");
    const job = store.routingJob("dubois");
    assert.equal(
      store.activeRoutingHosts().length,
      0,
      "must remain pending during verification",
    );
    assert.equal(init.headers["x-events-routing-probe"], job.probe);
    if (retire)
      store.run("UPDATE household_domains SET retired=1 WHERE label='dubois'");
    if (url.pathname === "/api/routing/probe")
      return Response.json({
        probe: badProof ? "wrong" : job.probe,
        household: job.household,
      });
    if (url.pathname === "/api/public/context")
      return Response.json({ household: { id: job.household } });
    if (failAssets && url.pathname === "/app.js")
      return new Response("missing", { status: 404 });
    return new Response(
      url.pathname === "/"
        ? '<script src="/app.js"></script>'
        : url.pathname === "/app.js"
          ? "suggestLabel"
          : url.pathname === "/household-address.js"
            ? "export function suggestLabel"
            : "--background",
    );
  };
}

test("durable provisioning creates exact resources once, verifies, activates and recovers receipts", async () => {
  const { store, job } = await fixture();
  const api = cloudflareRouting();
  try {
    await provisionHousehold(job, { store, env, fetcher: network(store, api) });
    assert.deepEqual(store.activeRoutingHosts(), ["dubois.ilymmd.com"]);
    assert.equal(api.writes.length, 2);
    assert.equal(api.records[0].type, "AAAA");
    assert.equal(api.routes[0].pattern, "dubois.ilymmd.com/*");
    store.routingPhase(job.label, "pending"); // crash/retry after successful API writes
    await provisionHousehold(store.routingJob("dubois"), {
      store,
      env,
      fetcher: network(store, api),
    });
    assert.equal(api.writes.length, 2);
  } finally {
    store.db.close();
  }
});

test("existing DNS, catch-all routes, custom domains and wildcard DNS are never changed", async () => {
  for (const conflict of ["dns", "route", "domain", "wildcard"]) {
    const { store, job } = await fixture();
    const api = cloudflareRouting();
    if (conflict === "dns")
      api.records.push({
        name: "dubois.ilymmd.com",
        type: "A",
        content: "192.0.2.1",
      });
    if (conflict === "route")
      api.routes.push({ pattern: "*.ilymmd.com/*", script: "existing" });
    if (conflict === "domain")
      api.domains.push({ hostname: "dubois.ilymmd.com", service: "existing" });
    if (conflict === "wildcard")
      api.records.push({ name: "*.ilymmd.com", type: "A" });
    try {
      const snapshot = JSON.stringify([api.records, api.routes, api.domains]);
      await runProvisioning(store, env, network(store, api), () => 1000);
      assert.equal(api.writes.length, 0);
      assert.equal(
        JSON.stringify([api.records, api.routes, api.domains]),
        snapshot,
      );
      assert.equal(store.routingJob(job.label).phase, "pending");
      assert.match(store.routingJob(job.label).error, /conflict/);
    } finally {
      store.db.close();
    }
  }
});

test("permission failures, incomplete verification and retirement stay pending with durable bounded retries", async () => {
  for (const scenario of [
    "credentials",
    "permission",
    "proof",
    "assets",
    "retired",
  ]) {
    const { store, job } = await fixture();
    const api = cloudflareRouting();
    if (scenario === "permission") api.fail(403);
    const fetcher = network(store, api, {
      badProof: scenario === "proof",
      failAssets: scenario === "assets",
      retire: scenario === "retired",
    });
    try {
      await runProvisioning(
        store,
        scenario === "credentials"
          ? { HOUSEHOLD_ROUTING_ENABLED: "true" }
          : env,
        fetcher,
        () => 1000,
      );
      const failed = store.routingJob(job.label);
      assert.equal(failed.phase, "pending");
      assert.equal(failed.next_attempt, 31000);
      assert.equal(failed.attempts, 1);
      assert.equal(store.activeRoutingHosts().length, 0);
      assert.doesNotMatch(failed.error, /private|token/);
      const before = api.writes.length;
      await runProvisioning(store, env, fetcher, () => 2000);
      assert.equal(api.writes.length, before);
    } finally {
      store.db.close();
    }
  }
});

test(
  "actual gateway/Worker/DO alarm activates two registered names without allowlist deployment",
  { timeout: 60000 },
  async () => {
    const api = cloudflareRouting();
    const f = await domainRuntime({
      automatic: true,
      cloudflareFetch: api.fetcher,
    });
    try {
      const { hosts } = await seedDomains(f, { simpleNames: true });
      for (const host of hosts) {
        const active = await waitForActive(f, host);
        assert.equal(active.shareUrl, `https://${host.subdomain}.ilymmd.com/`);
        const page = await f.request("/api/public/context", {
          origin: `https://${host.subdomain}.ilymmd.com`,
        });
        assert.equal(page.status, 200);
        assert.equal(page.body.household.id, host.id);
      }
      assert.equal(api.writes.length, 4);
      assert.equal(
        (await f.request("/", { origin: "https://unclaimed.ilymmd.com" }))
          .status,
        404,
      );
      const fake = await f.request("/api/routing/probe", {
        origin: `https://${hosts[0].subdomain}.ilymmd.com`,
        headers: { "x-events-routing-probe": "fake" },
      });
      assert.equal(fake.status, 404);
      assert.equal((await f.request("/api/routing/status")).status, 404);
      const forged = await f.request("/api/session", {
        headers: {
          "x-events-verified-hostname": `${hosts[0].subdomain}.ilymmd.com`,
        },
      });
      assert.equal(forged.body.role, null);
      // Fault injection only into the isolated SQLite fixture: probes may never
      // authorize sessions or mutations before public activation.
      const storage = await f.runtime.unsafeGetDurableObjectStorage(
        "events",
        "EventsDatabase",
        { name: "events-platform-v1" },
      );
      const [job] = await storage.exec(
        "SELECT label,probe FROM household_routing WHERE label=?",
        hosts[0].subdomain,
      );
      await storage.exec(
        "UPDATE household_routing SET phase='verifying' WHERE label=?",
        job.label,
      );
      const origin = `https://${job.label}.ilymmd.com`;
      const headers = { "x-events-routing-probe": job.probe };
      assert.equal((await f.request("/", { origin })).status, 404);
      assert.equal(
        (await f.request("/api/public/context", { origin, headers })).status,
        200,
      );
      assert.equal(
        (await f.request("/api/session", { origin, headers })).status,
        404,
      );
      assert.equal(
        (
          await f.request("/api/login", {
            origin,
            headers,
            method: "POST",
            data: { email: hosts[0].email, password },
          })
        ).status,
        404,
      );
      assert.equal(
        (await f.request("/api/host", { cookie: hosts[0].cookie })).body
          .household.subdomainStatus,
        "pending",
      );
      await storage.exec(
        "UPDATE household_routing SET phase='pending', next_attempt=0 WHERE label=?",
        job.label,
      );
      const namespace = await f.runtime.getDurableObjectNamespace(
        "EVENTS_DATABASE",
        "events",
      );
      await namespace
        .get(namespace.idFromName("events-platform-v1"))
        .wakeRouting();
      await waitForActive(f, hosts[0]);
      assert.equal(api.writes.length, 4);
    } finally {
      await f.runtime.dispose();
    }
  },
);

test("API races and interrupted writes cannot overwrite existing sites or activate without verification", async () => {
  const { store, job } = await fixture();
  const api = cloudflareRouting();
  try {
    const fetcher = async (url, init) => {
      const response = await api.fetcher(url, init);
      if (init.method === "POST" && url.includes("dns_records"))
        api.records.push({
          name: "dubois.ilymmd.com",
          type: "A",
          content: "192.0.2.1",
        });
      return response;
    };
    await runProvisioning(store, env, fetcher, () => 1000);
    assert.equal(api.writes.length, 1);
    assert.equal(api.routes.length, 0);
    assert.equal(api.records[1].content, "192.0.2.1");
    assert.equal(store.routingJob(job.label).error, "dns_conflict");
  } finally {
    store.db.close();
  }
});

test("routing work survives database restart and resumes without duplicate resources", async () => {
  const dir = await mkdtemp(join(tmpdir(), "events-routing-"));
  const api = cloudflareRouting();
  let store = new Store(join(dir, "synthetic.sqlite"));
  try {
    store.run(
      "INSERT INTO approvals VALUES(?,?)",
      "restart@example.test",
      "synthetic",
    );
    await store.register({
      email: "restart@example.test",
      password,
      name: "Dubois",
    });
    await runProvisioning(
      store,
      env,
      network(store, api, { failAssets: true }),
      () => 1000,
    );
    assert.equal(api.writes.length, 2);
    store.db.close();
    store = new Store(join(dir, "synthetic.sqlite"));
    assert.equal(store.routingJob("dubois").phase, "pending");
    await runProvisioning(store, env, network(store, api), () => 32000);
    assert.equal(api.writes.length, 2);
    assert.equal(store.routingJob("dubois").phase, "active");
  } finally {
    store.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("incomplete paginated inventories and redirects fail closed", async () => {
  for (const redirect of [false, true]) {
    const { store, job } = await fixture();
    let writes = 0;
    try {
      await runProvisioning(
        store,
        env,
        async (url, init) => {
          if (init.method !== "GET") writes++;
          if (redirect)
            return new Response(null, {
              status: 302,
              headers: { Location: "https://untrusted.test" },
            });
          return Response.json({
            success: true,
            result: [],
            result_info: { total_pages: 200 },
          });
        },
        () => 1000,
      );
      assert.equal(writes, 0);
      assert.equal(store.routingJob(job.label).phase, "pending");
      assert.match(
        store.routingJob(job.label).error,
        /inventory_incomplete|cloudflare_unavailable/,
      );
    } finally {
      store.db.close();
    }
  }
});

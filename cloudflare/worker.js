import { runReminders } from "../server/reminders.js";
import { runAccountCleanup } from "./account-cleanup.js";
import { DurableObject } from "cloudflare:workers";
import { Buffer } from "node:buffer";
import { Store } from "../server/model.js";
import { createHandler } from "../server/handler.js";
import { configuredHosts, hostnameLabel } from "../server/household-domains.js";
import { verifyRequest, unavailable } from "./gateway-protocol.js";

import { runProvisioning } from "./household-provisioner.js";
import { routingDiagnostic } from "./routing-diagnostics.js";

// Thin runtime adapters only: authorization, validation and RSVP behavior remain shared.
function database(storage) {
  return {
    exec(query) {
      for (const statement of query
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean))
        storage.sql.exec(statement);
    },
    prepare(query) {
      return {
        all: (...args) => storage.sql.exec(query, ...args).toArray(),
        get: (...args) => storage.sql.exec(query, ...args).toArray()[0],
        run: (...args) => {
          const cursor = storage.sql.exec(query, ...args);
          return { changes: cursor.rowsWritten };
        },
      };
    },
    transaction: (callback) => storage.transactionSync(callback),
  };
}
async function serve(request, options) {
  const headers = new Headers();
  let status = 200,
    ended = false,
    payload = "";
  const req = {
    url: new URL(request.url).pathname + new URL(request.url).search,
    method: request.method,
    headers: Object.fromEntries(request.headers),
    socket: {
      remoteAddress: request.headers.get("x-events-client-ip") || "unknown",
    },
    async *[Symbol.asyncIterator]() {
      if (request.body)
        for await (const part of request.body) yield Buffer.from(part);
    },
  };
  const res = {
    get headersSent() {
      return ended;
    },
    setHeader(name, value) {
      headers.set(name, value);
    },
    writeHead(code, values = {}) {
      status = code;
      for (const [key, value] of Object.entries(values))
        headers.set(key, value);
    },
    end(value = "") {
      payload = value;
      ended = true;
    },
  };
  await createHandler(options)(req, res);
  return new Response(payload, { status, headers });
}
export class EventsDatabase extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new Store(database(ctx.storage));
    ctx.blockConcurrencyWhile(() => this.scheduleRouting());
  }
  async scheduleRouting() {
    const tasks = [
      this.env.HOUSEHOLD_ROUTING_ENABLED === "true"
        ? this.store.routingDue()
        : null,
      this.env.ACCOUNT_CLEANUP_ENABLED === "false"
        ? null
        : this.store.one(
            "SELECT min(next_attempt) AS due FROM household_deletions WHERE phase!='complete'",
          )?.due,
      this.env.SMS_ENABLED === "true" ? Date.now() + 60000 : null,
    ].filter((value) => value !== null && value !== undefined);
    const due = tasks.length ? Math.min(...tasks) : null;
    if (due === null || due === undefined) return;
    const next = Math.max(Date.now() + 1000, due);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next)
      await this.ctx.storage.setAlarm(next);
  }
  async alarm() {
    await this.ctx.storage.setAlarm(Date.now() + 60000);
    try {
      await runAccountCleanup(this.store, this.env);
      await runReminders(this.store, this.env);
      if (this.env.HOUSEHOLD_ROUTING_ENABLED === "true")
        await runProvisioning(this.store, this.env);
    } finally {
      const remaining =
        this.env.ACCOUNT_CLEANUP_ENABLED !== "false" &&
        this.store.one(
          "SELECT household FROM household_deletions WHERE phase!='complete' LIMIT 1",
        );
      if (
        (this.env.HOUSEHOLD_ROUTING_ENABLED !== "true" ||
          this.store.routingDue() === null) &&
        !remaining &&
        this.env.SMS_ENABLED !== "true"
      )
        await this.ctx.storage.deleteAlarm();
      else await this.scheduleRouting();
    }
  }
  async wakeRouting() {
    await this.scheduleRouting();
  }
  async fetch(request) {
    const store = this.store;
    const householdHostname =
      request.headers.get("x-events-verified-hostname") || "";
    const path = new URL(request.url).pathname;
    // Diagnostic codes only, for signed gateway verification reads. Never log
    // hostname, headers, probe, household, response body or exception values.
    const routingCheck = (stage, status) => {
      if (
        householdHostname &&
        request.headers.has("x-events-routing-probe") &&
        ["/api/routing/status", "/api/public/context"].includes(path)
      )
        routingDiagnostic(
          path === "/api/routing/status" ? "status" : "context",
          stage,
          status,
        );
    };
    if (
      householdHostname &&
      !configuredHosts(this.env.HOUSEHOLD_HOSTS).has(householdHostname)
    ) {
      const label = hostnameLabel(householdHostname);
      if (
        this.env.HOUSEHOLD_ROUTING_ENABLED !== "true" ||
        !store.routingAllowed(
          label,
          request.headers.get("x-events-routing-probe"),
        )
      ) {
        routingCheck("claim_denied", 404);
        return unavailable();
      }
      const job = store.routingJob(label);
      if (
        job.phase !== "active" &&
        (request.method !== "GET" ||
          ![
            "/api/routing/status",
            "/api/routing/probe",
            "/",
            "/app.js",
            "/household-address.js",
            "/style.css",
            "/editor-tools.js",
            "/ui-system.js",
            "/ui-runtime.js",
            "/ui-copy.js",
            "/icons.js",
            "/card-system.js",
            "/reminder-time.js",
            "/api/public/context",
          ].includes(path))
      )
        return unavailable();
    }
    if (path === "/api/routing/status" || path === "/api/routing/probe") {
      if (!householdHostname || request.method !== "GET") return unavailable();
      const label = hostnameLabel(householdHostname);
      try {
        store.hostnameHousehold(label);
      } catch {
        routingCheck("household_missing", 404);
        return unavailable();
      }
      if (path === "/api/routing/status") {
        routingCheck("allowed", 200);
        return Response.json(
          { allowed: true, hostname: householdHostname },
          { headers: { "Cache-Control": "no-store" } },
        );
      }
      const job = store.routingJob(label);
      if (!job || request.headers.get("x-events-routing-probe") !== job.probe)
        return unavailable();
      return Response.json(
        { probe: job.probe, household: job.household },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    // Only this Worker's private DO binding can invoke this adapter. The public edge
    // deletes these internal headers before it verifies the gateway envelope.
    if (householdHostname && request.method !== "GET") {
      try {
        store.consumeGatewayNonce(request.headers.get("x-events-nonce"));
      } catch {
        return unavailable(403);
      }
    }
    if (!store.adminSetupComplete()) {
      const address = this.env.BOOTSTRAP_ADMIN_EMAIL,
        hash = this.env.BOOTSTRAP_ADMIN_HASH;
      // Legacy operator alternative: accept only an already-derived scrypt hash.
      if (address && /^[0-9a-f]{32}:[0-9a-f]{128}$/.test(hash || "")) {
        const { email, id } = await import("../server/model.js");
        store.transaction(() => {
          if (!store.adminSetupComplete())
            store.run(
              "INSERT INTO users VALUES(?,?,?,?,NULL)",
              id(),
              email(address),
              hash,
              "admin",
            );
        });
      }
    }
    const response = await serve(request, {
      store,
      env: this.env,
      setupSecret: this.env.ADMIN_SETUP_TOKEN || "",
      setupEmail: this.env.BOOTSTRAP_ADMIN_EMAIL || "",
      requireAdmin: true,
      origin: householdHostname
        ? `https://${householdHostname}`
        : this.env.APP_ORIGIN || new URL(request.url).origin,
      canonicalOrigin: this.env.APP_ORIGIN || new URL(request.url).origin,
      householdHostname,
      householdHosts: new Set([
        ...configuredHosts(this.env.HOUSEHOLD_HOSTS),
        ...(this.env.HOUSEHOLD_ROUTING_ENABLED === "true"
          ? store.activeRoutingHosts()
          : []),
      ]),
      readAsset: async (file) => {
        const response = await this.env.ASSETS.fetch(
          new URL("/" + file, request.url),
        );
        if (!response.ok) throw new Error("Missing frontend asset");
        return Buffer.from(await response.arrayBuffer());
      },
    });
    if (
      ["POST", "PUT", "DELETE"].includes(request.method) &&
      response.status < 400
    ) {
      // Claim + job already committed together; retry scheduling on the next wake
      // if storage scheduling itself fails, without pretending registration failed.
      try {
        await this.scheduleRouting();
      } catch {
        /* durable outbox retained */
      }
    }
    routingCheck("shared_response", response.status);
    return response;
  }
}
export default {
  async scheduled(event, env) {
    const stub = env.EVENTS_DATABASE.get(
      env.EVENTS_DATABASE.idFromName("events-platform-v1"),
    );
    await stub.wakeRouting();
  },
  async fetch(request, env) {
    if (env.EVENTS_ORIGIN && new URL(request.url).origin !== env.EVENTS_ORIGIN)
      return unavailable(403);
    const headers = new Headers(request.headers);
    headers.delete("x-events-verified-hostname");
    const gatewayAttempt = [
      "x-events-hostname",
      "x-events-signature",
      "x-events-time",
      "x-events-nonce",
    ].some((name) => headers.has(name));
    let householdHostname = "";
    if (gatewayAttempt) {
      try {
        householdHostname = await verifyRequest(request, env);
      } catch {
        return unavailable(403);
      }
      if (!householdHostname) return unavailable(403);
      headers.set("x-events-verified-hostname", householdHostname);
    }
    if (
      householdHostname ||
      new URL(request.url).pathname.startsWith("/api/")
    ) {
      // Always overwrite a caller-supplied forwarding header at the trusted Cloudflare edge.
      headers.set(
        "x-events-client-ip",
        householdHostname
          ? request.headers.get("x-events-client-ip")
          : request.headers.get("CF-Connecting-IP") || "unknown",
      );
      const stub = env.EVENTS_DATABASE.get(
        env.EVENTS_DATABASE.idFromName("events-platform-v1"),
      );
      return stub.fetch(new Request(request, { headers }));
    }
    return serve(request, {
      store: null,
      origin: env.APP_ORIGIN || new URL(request.url).origin,
      readAsset: async (file) => {
        const response = await env.ASSETS.fetch(
          new URL("/" + file, request.url),
        );
        if (!response.ok) throw new Error("Missing frontend asset");
        return Buffer.from(await response.arrayBuffer());
      },
    });
  },
};

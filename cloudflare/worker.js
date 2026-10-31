import { DurableObject } from "cloudflare:workers";
import { Buffer } from "node:buffer";
import { Store } from "../server/model.js";
import { createHandler } from "../server/handler.js";
import { configuredHosts } from "../server/household-domains.js";
import { verifyRequest, unavailable } from "./gateway-protocol.js";

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
  }
  async fetch(request) {
    const store = this.store;
    const householdHostname =
      request.headers.get("x-events-verified-hostname") || "";
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
    return serve(request, {
      store,
      setupSecret: this.env.ADMIN_SETUP_TOKEN || "",
      setupEmail: this.env.BOOTSTRAP_ADMIN_EMAIL || "",
      requireAdmin: true,
      origin: householdHostname
        ? `https://${householdHostname}`
        : this.env.APP_ORIGIN || new URL(request.url).origin,
      canonicalOrigin: this.env.APP_ORIGIN || new URL(request.url).origin,
      householdHostname,
      householdHosts: configuredHosts(this.env.HOUSEHOLD_HOSTS),
      readAsset: async (file) => {
        const response = await this.env.ASSETS.fetch(
          new URL("/" + file, request.url),
        );
        if (!response.ok) throw new Error("Missing frontend asset");
        return Buffer.from(await response.arrayBuffer());
      },
    });
  }
}
export default {
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

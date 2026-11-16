import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile } from "node:fs/promises";
import { forwardRequest } from "../cloudflare/gateway-protocol.js";
const origin = "https://gather.ilymmd.com",
  canonical = "https://events.synthetic.workers.dev";
const flags = {
  PASSWORDLESS_ENABLED: "true",
  PASSWORDLESS_ACTIVATION_APPROVED: "true",
  GATHER_UNIVERSAL_ENABLED: "true",
  GATHER_PWA_ENABLED: "true",
  GATHER_DOMAIN_APPROVED: "true",
};
test(
  "actual Worker/SQLite universal entry is gated, origin-verified, unassigned and uses the existing database",
  { timeout: 90000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "gather-runtime-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    try {
      execFileSync(
        process.execPath,
        [
          "node_modules/wrangler/bin/wrangler.js",
          "deploy",
          "--dry-run",
          "--name",
          "events",
          "--config",
          "wrangler.jsonc",
          "--outdir",
          dir,
        ],
        {
          stdio: "pipe",
          env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        },
      );
    } catch {
      throw new Error("Local Worker build failed; no upload attempted.");
    }
    const base = {
      modules: true,
      script: await readFile(join(dir, "worker.js"), "utf8"),
      compatibilityDate: "2026-10-23",
      compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
      durableObjects: {
        EVENTS_DATABASE: { className: "EventsDatabase", useSQLite: true },
      },
      serviceBindings: {
        ASSETS: async (request) => {
          try {
            return new Response(
              await readFile(
                new URL(
                  "../public/" + new URL(request.url).pathname.slice(1),
                  import.meta.url,
                ),
              ),
            );
          } catch {
            return new Response("Missing", { status: 404 });
          }
        },
      },
    };
    const secret = "synthetic-setup-token-more-than-32-characters";
    const env = {
      ...flags,
      EVENTS_ORIGIN: canonical,
      ADMIN_SETUP_TOKEN: secret,
      EVENTS_GATEWAY_SECRET: "synthetic-gateway-secret-more-than-32-characters",
      HOUSEHOLD_HOSTS: "",
    };
    const disabled = new Miniflare(
      convertV4MiniflareOptions({
        ...base,
        bindings: { ...env, GATHER_DOMAIN_APPROVED: "false" },
      }),
    );
    t.after(() => disabled.dispose());
    assert.equal(
      (await disabled.dispatchFetch(origin + "/api/setup")).status,
      403,
    );
    const mf = new Miniflare(
      convertV4MiniflareOptions({ ...base, bindings: env }),
    );
    t.after(() => mf.dispose());
    const created = await mf.dispatchFetch(origin + "/api/setup", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({
        token: secret,
        email: "admin@example.test",
        password: "Synthetic-runtime-password",
        confirmPassword: "Synthetic-runtime-password",
      }),
    });
    assert.equal(created.status, 201);
    assert.ok(
      created.headers.get("set-cookie").startsWith("__Host-events_session="),
    );
    const context = await (
      await mf.dispatchFetch(origin + "/api/public/context")
    ).json();
    assert.equal(context.household, null);
    const manifest = await (
      await mf.dispatchFetch(origin + "/api/app/manifest")
    ).json();
    assert.equal(manifest.name, "Gather");
    assert.equal(manifest.scope, "/");
    const signed = await forwardRequest(
      new Request(origin + "/api/app/manifest"),
      env,
    );
    assert.ok(signed);
    assert.equal((await mf.dispatchFetch(signed.url, signed)).status, 200);
    const forged = await mf.dispatchFetch(canonical + "/api/setup", {
      method: "POST",
      headers: {
        Origin: origin,
        "x-events-verified-universal": origin,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    assert.equal(forged.status, 403);
    assert.equal(
      (
        await mf.dispatchFetch(origin + "/api/passwordless/start", {
          method: "POST",
          headers: { Origin: origin, "Content-Type": "application/json" },
          body: JSON.stringify({
            first: "Unknown",
            last: "Person",
            phone: "+15005550123",
          }),
        })
      ).status,
      200,
    );
    assert.equal((await mf.dispatchFetch(origin + "/api/session")).status, 200);
  },
);

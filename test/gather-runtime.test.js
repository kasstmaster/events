import { createHash } from "node:crypto";
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
      HOUSEHOLD_HOSTS: "alpha.ilymmd.com",
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
    const adminCookie = created.headers.get("set-cookie").split(";")[0];
    const approval = await mf.dispatchFetch(origin + "/api/admin/approvals", {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: adminCookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: "host@example.test" }),
    });
    assert.equal(approval.status, 201);
    const registered = await mf.dispatchFetch(origin + "/api/register", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "host@example.test",
        password: "Synthetic-runtime-password",
        name: "Alpha",
      }),
    });
    assert.equal(registered.status, 201);
    // Every release-manifest file must be publicly routable, including binary
    // icons. Uploading an asset does not make it reachable with worker-first routing.
    const policy = JSON.parse(
      await readFile(".github/release/approved-application.json", "utf8"),
    );
    for (const entryOrigin of [canonical, origin, "https://alpha.ilymmd.com"]) {
      for (const [path, expectedHash] of Object.entries(policy.appearance)) {
        const url =
          entryOrigin +
          "/" +
          (path === "public/index.html" ? "" : path.slice(7));
        const forwarded =
          entryOrigin === "https://alpha.ilymmd.com"
            ? await forwardRequest(new Request(url), env)
            : null;
        const asset = forwarded
          ? await mf.dispatchFetch(forwarded.url, forwarded)
          : await mf.dispatchFetch(url);
        assert.equal(asset.status, 200, path + " on " + entryOrigin);
        const bytes = Buffer.from(await asset.arrayBuffer());
        assert.equal(
          createHash("sha256").update(bytes).digest("hex"),
          expectedHash,
          path + " bytes on " + entryOrigin,
        );
        if (path.endsWith(".png"))
          assert.equal(asset.headers.get("content-type"), "image/png");
      }
    }
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

    const firebaseRuntime = new Miniflare(
      convertV4MiniflareOptions({
        ...base,
        bindings: {
          ...env,
          FIREBASE_AUTH_ENABLED: "true",
          FIREBASE_ACTIVATION_APPROVED: "true",
          FIREBASE_PROJECT_ID: "gather-runtime-test",
          FIREBASE_API_KEY: "synthetic-public-key",
          FIREBASE_AUTH_DOMAIN: "gather-runtime-test.firebaseapp.com",
        },
      }),
    );
    t.after(() => firebaseRuntime.dispose());
    const firebaseSetup = await firebaseRuntime.dispatchFetch(
      origin + "/api/setup",
      {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({
          token: secret,
          email: "admin@example.test",
          password: "Synthetic-runtime-password",
          confirmPassword: "Synthetic-runtime-password",
        }),
      },
    );
    assert.equal(firebaseSetup.status, 201);

    const configResponse = await firebaseRuntime.dispatchFetch(
      origin + "/api/passwordless/config",
    );
    assert.equal(configResponse.status, 200);
    assert.equal(
      (await configResponse.json()).firebase.projectId,
      "gather-runtime-test",
    );
    const attempt = await firebaseRuntime.dispatchFetch(
      origin + "/api/firebase/start",
      {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({
          first: "Synthetic",
          last: "Person",
          phone: "+15005550123",
        }),
      },
    );
    assert.equal(attempt.status, 200);
    assert.match(
      attempt.headers.get("set-cookie"),
      /HttpOnly; Secure; SameSite=Strict/,
    );
    const refused = await firebaseRuntime.dispatchFetch(
      origin + "/api/firebase/verify",
      {
        method: "POST",
        headers: {
          Origin: origin,
          "Content-Type": "application/json",
          Cookie: attempt.headers.get("set-cookie").split(";")[0],
        },
        body: JSON.stringify({
          reference: (await attempt.json()).reference,
          idToken: "invalid",
        }),
      },
    );
    assert.equal(refused.status, 401);
    const recovery = await firebaseRuntime.dispatchFetch(
      origin + "/api/account-recovery",
      {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({
          first: "Synthetic",
          last: "Person",
          householdId: "0000",
        }),
      },
    );
    assert.equal(recovery.status, 200);
    const runtimeCookie = firebaseSetup.headers.get("set-cookie").split(";")[0];
    assert.equal(
      (
        await firebaseRuntime.dispatchFetch(origin + "/api/admin/approvals", {
          method: "POST",
          headers: {
            Origin: origin,
            Cookie: runtimeCookie,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ email: "host@example.test" }),
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await firebaseRuntime.dispatchFetch(origin + "/api/register", {
          method: "POST",
          headers: { Origin: origin, "Content-Type": "application/json" },
          body: JSON.stringify({
            email: "host@example.test",
            password: "Synthetic-runtime-password",
            name: "Alpha",
          }),
        })
      ).status,
      201,
    );
    async function householdRequest(path, method = "GET", data) {
      const signed = await forwardRequest(
        new Request("https://alpha.ilymmd.com" + path, {
          method,
          headers: {
            Origin: "https://alpha.ilymmd.com",
            ...(data ? { "Content-Type": "application/json" } : {}),
          },
          body: data ? JSON.stringify(data) : undefined,
        }),
        env,
      );
      return firebaseRuntime.dispatchFetch(signed.url, signed);
    }
    const householdConfig = await (
      await householdRequest("/api/passwordless/config")
    ).json();
    assert.equal(householdConfig.firebase, null);
    assert.equal(householdConfig.firebaseOrigin, origin);
    assert.equal(
      (
        await householdRequest("/api/firebase/start", "POST", {
          first: "Unknown",
          phone: "+15005550123",
        })
      ).status,
      403,
    );
    const route = await householdRequest(
      "/api/firebase/routing/start",
      "POST",
      {},
    );
    assert.equal(route.status, 200);
    const destination = new URL((await route.json()).url);
    assert.equal(destination.origin, origin);
    const reference = destination.hash.slice("#login-context=".length);
    const contextRequest = await firebaseRuntime.dispatchFetch(
      origin + "/api/firebase/routing/context",
      {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ reference }),
      },
    );
    assert.equal(contextRequest.status, 200);
    assert.equal((await contextRequest.json()).entry, "alpha");
    assert.match(
      contextRequest.headers.get("set-cookie"),
      /HttpOnly; Secure; SameSite=Strict/,
    );
  },
);

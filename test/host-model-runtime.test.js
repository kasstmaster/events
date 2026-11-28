// Actual local workerd/SQLite; no Cloudflare API or external provider requests.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { parse } from "jsonc-parser";
test(
  "replacement host registration and retired guest routes run in the unchanged SQLite Worker",
  { timeout: 90000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "gather-native-runtime-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
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
    const index = await readFile("public/index.html", "utf8");
    const config = parse(await readFile("wrangler.jsonc", "utf8")),
      origin = "https://gather.ilymmd.com",
      password = "Synthetic-native-runtime-password";
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: await readFile(join(dir, "worker.js"), "utf8"),
        compatibilityDate: config.compatibility_date,
        compatibilityFlags: config.compatibility_flags,
        durableObjects: {
          EVENTS_DATABASE: { className: "EventsDatabase", useSQLite: true },
        },
        bindings: {
          EVENTS_ORIGIN: "https://events.synthetic.workers.dev",
          GATHER_UNIVERSAL_ENABLED: "true",
          GATHER_DOMAIN_APPROVED: "true",
          HOST_ONLY_MODEL_ENABLED: "true",
          HOST_ONLY_MODEL_ACTIVATION_APPROVED: "true",
          ADMIN_SETUP_TOKEN:
            "synthetic-native-setup-token-with-more-than-32-characters",
        },
        serviceBindings: {
          ASSETS: async (request) =>
            new Response(
              new URL(request.url).pathname === "/index.html"
                ? index
                : "isolated asset",
            ),
        },
      }),
    );
    t.after(() => mf.dispose());
    const call = async (path, data, cookie) =>
      mf.dispatchFetch(origin + path, {
        method: data ? "POST" : "GET",
        headers: {
          Origin: origin,
          ...(data ? { "Content-Type": "application/json" } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: data ? JSON.stringify(data) : undefined,
      });
    const beforeSetup = await call("/api/startup");
    assert.equal(beforeSetup.headers.get("cache-control"), "no-store");
    assert.deepEqual(await beforeSetup.json(), {
      setup: { required: true, enabled: true },
    });
    const created = await call("/api/setup", {
      token: "synthetic-native-setup-token-with-more-than-32-characters",
      email: "admin@example.test",
      password,
      confirmPassword: password,
    });
    assert.equal(created.status, 201);
    const cookie = created.headers.get("set-cookie").split(";")[0];
    assert.ok(cookie.startsWith("__Host-events_session="));
    const documentResponse = await call("/", null, cookie);
    assert.equal(documentResponse.status, 200);
    const rendered = await documentResponse.text();
    const inline = rendered.match(/<script>([\s\S]+?)<\/script>/)?.[1];
    assert.ok(inline);
    const hash = createHash("sha256").update(inline).digest("base64");
    assert.ok(
      documentResponse.headers
        .get("content-security-policy")
        .includes(`'sha256-${hash}'`),
    );
    const window = { addEventListener() {} };
    const listeners = [];
    runInNewContext(inline, {
      window,
      document: { addEventListener: (type) => listeners.push(type) },
    });
    assert.equal(typeof window.gatherEarly.claim, "function");
    assert.ok(listeners.includes("click") && listeners.includes("submit"));
    const startup = await (await call("/api/startup", null, cookie)).json();
    assert.equal(startup.session.role, "admin");
    assert.equal(startup.host, undefined);
    const anonymous = await (await call("/api/startup")).json();
    assert.deepEqual(anonymous.session, { role: null });
    assert.equal(anonymous.host, undefined);
    const invite = await call(
      "/api/admin/host-signup-invitations",
      { email: "synthetic@example.test", password },
      cookie,
    );
    assert.equal(invite.status, 201);
    const url = (await invite.json()).url;
    assert.ok(url.startsWith(origin + "/host-signup#invite="));
    const token = new URL(url).hash.slice("#invite=".length);
    const context = await call("/api/host-signup/context", { invite: token });
    assert.equal(context.status, 200);
    assert.equal((await context.json()).email, "synthetic@example.test");
    assert.equal(
      (
        await call("/api/host-signup/email", {
          invite: token,
          email: "synthetic@example.test",
          name: "Synthetic Family",
          password,
        })
      ).status,
      503,
    );
    for (const path of [
      "/api/firebase/start",
      "/api/passwordless/start",
      "/api/guest/login",
      "/api/personal/account",
      "/api/admin/approvals",
    ])
      assert.equal((await call(path, {}, cookie)).status, 410, path);
    assert.equal((await call("/api/app/manifest")).status, 404);
    const flags = await (await call("/api/passwordless/config")).json();
    assert.equal(flags.hostOnly, true);
    assert.equal(flags.enabled, false);
    const hosts = await call(
      "/api/admin/host-management",
      { password },
      cookie,
    );
    assert.equal(hosts.status, 200);
    assert.deepEqual((await hosts.json()).hosts, []);
  },
);

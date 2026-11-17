import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  compareApplication,
  moduleIdentity,
  checkConfiguration,
  validateReceipt,
  diagnose,
  ACTIVE,
  BASE,
  COMMIT,
  sha,
} from "./production-provenance-diagnostic.mjs";
import {
  ACCOUNT,
  NAMESPACE,
  fingerprint,
  runtimeSettingsFingerprint,
} from "./automatic-events-release.mjs";
import { safeSettings } from "./manual-events-release.mjs";
const version = (id) => ({
  id,
  main_module: "worker.js",
  modules: [
    {
      name: "worker.js",
      content_type: "application/javascript+module",
      content_base64: Buffer.from("export default {}").toString("base64"),
    },
  ],
  assets: {
    config: { run_worker_first: true },
  },
});
function fixture() {
  const old = {
    compatibility_date: "2026-10-30",
    compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
    bindings: [
      { name: "ASSETS", type: "assets" },
      {
        name: "EVENTS_DATABASE",
        type: "durable_object_namespace",
        namespace_id: NAMESPACE,
        class_name: "EventsDatabase",
      },
    ],
    placement: {},
    annotations: { "workers/message": COMMIT },
  };
  const receipt = {
    release: COMMIT,
    version_id: BASE,
    verified_at: "2026-11-16T22:53:37.000Z",
    health:
      "All reviewed public assets match on canonical and representative household origin; setup closed.",
    preserved: {
      settings: safeSettings(old),
      runtime_digest: runtimeSettingsFingerprint(old),
      crons: ["*/5 * * * *"],
      environment: "production",
      routes_digest: fingerprint([]),
      domains_digest: fingerprint([]),
    },
  };
  const current = structuredClone(old);
  current.annotations = {
    "workers/message": "Add variable: FIREBASE_ACTIVATION_APPROVED",
  };
  for (const [name, text] of Object.entries({
    FIREBASE_PROJECT_ID: "gather-58a79",
    FIREBASE_AUTH_DOMAIN: "gather-58a79.firebaseapp.com",
    FIREBASE_API_KEY: "AIza" + "x".repeat(35),
    FIREBASE_AUTH_ENABLED: "false",
    FIREBASE_ACTIVATION_APPROVED: "false",
  }))
    current.bindings.push({ name, type: "plain_text", text });
  const deployment = {
    deployments: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        created_on: "2026-11-17T00:00:00Z",
        versions: [{ version_id: ACTIVE, percentage: 100 }],
      },
    ],
  };
  const payloads = new Map([
    [
      `/accounts/${ACCOUNT}/workers/scripts/events/versions/${BASE}`,
      {
        id: BASE,
        annotations: { "workers/message": COMMIT },
        resources: { script_runtime: { migration_tag: "events-v1" } },
      },
    ],
    [
      `/accounts/${ACCOUNT}/workers/scripts/events/versions/${ACTIVE}`,
      {
        id: ACTIVE,
        resources: { script_runtime: { migration_tag: "events-v1" } },
      },
    ],
    [`/accounts/${ACCOUNT}/workers/scripts/events/deployments`, deployment],
    [
      `/accounts/${ACCOUNT}/workers/workers/events/versions/${BASE}?include=modules`,
      version(BASE),
    ],
    [
      `/accounts/${ACCOUNT}/workers/workers/events/versions/${ACTIVE}?include=modules`,
      version(ACTIVE),
    ],
    [`/accounts/${ACCOUNT}/workers/scripts/events/settings`, current],
    [
      `/accounts/${ACCOUNT}/workers/scripts/events/schedules`,
      { schedules: [{ cron: "*/5 * * * *" }] },
    ],
    [
      `/accounts/${ACCOUNT}/workers/scripts/events/subdomain`,
      { enabled: true, previews_enabled: false },
    ],
    [
      `/accounts/${ACCOUNT}/workers/services/events`,
      { default_environment: { environment: "production" } },
    ],
    [
      `/accounts/${ACCOUNT}/workers/services/events/environments/production/routes?show_zonename=true`,
      [],
    ],
    [
      `/accounts/${ACCOUNT}/workers/domains/records?page=0&per_page=100&service=events&environment=production`,
      [],
    ],
  ]);
  const calls = [],
    logs = [];
  const fetcher = async (url, options) => {
    calls.push(url);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    const u = new URL(url);
    if (u.origin === "https://api.cloudflare.com") {
      assert.equal(options.headers.Authorization, "Bearer synthetic-token");
      const key = (u.pathname + u.search).slice("/client/v4".length);
      assert.ok(payloads.has(key), "unapproved endpoint");
      return Response.json({ success: true, result: payloads.get(key) });
    }
    assert.ok(
      [
        "https://events.kassandraraudman.workers.dev",
        "https://name.ilymmd.com",
      ].includes(u.origin),
    );
    assert.equal(u.pathname, "/app.js");
    assert.equal(options.headers?.Authorization, undefined);
    return new Response("synthetic asset");
  };
  return {
    current,
    receipt,
    payloads,
    calls,
    logs,
    options: {
      env: { CLOUDFLARE_API_TOKEN: "synthetic-token" },
      fetcher,
      receipt,
      manifest: { "public/app.js": sha("synthetic asset") },
      log: (value) => logs.push(value),
    },
  };
}
test("module-byte proof accepts configuration-only versions and ignores display annotations", () => {
  const base = version(BASE),
    active = version(ACTIVE);
  active.annotations = { "workers/message": "dashboard edit" };
  assert.equal(
    compareApplication(base, active).code_sha256,
    moduleIdentity(base, BASE).fingerprint,
  );
  active.modules[0].content_base64 =
    Buffer.from("modified code").toString("base64");
  assert.throws(
    () => compareApplication(base, active),
    /APPLICATION_CODE_MISMATCH/,
  );
});
test("missing byte provenance, malformed inventories and different entrypoints never pass", () => {
  for (const update of [
    (v) => delete v.modules,
    (v) => v.modules.push(v.modules[0]),
    (v) => (v.main_module = "missing"),
    (v) => (v.modules[0].content_base64 = "not-base64!"),
  ]) {
    const active = version(ACTIVE);
    update(active);
    assert.throws(() => compareApplication(version(BASE), active));
  }
  assert.throws(
    () => moduleIdentity(version(BASE), ACTIVE),
    /MODULE_VERSION_MISMATCH/,
  );
  assert.throws(
    () => validateReceipt(Buffer.from("{}")),
    /TRUSTED_RECEIPT_BYTES_MISMATCH/,
  );
});
test("only the five authorized Firebase additions preserve the baseline; sensitive or unrelated settings fail", () => {
  const f = fixture();
  assert.equal(
    checkConfiguration(f.current, f.receipt).firebase_disabled,
    true,
  );
  for (const mutate of [
    (c) =>
      (c.bindings.find((b) => b.name === "FIREBASE_AUTH_ENABLED").text =
        "true"),
    (c) =>
      (c.bindings.find((b) => b.name === "FIREBASE_ACTIVATION_APPROVED").text =
        "true"),
    (c) =>
      (c.bindings.find((b) => b.name === "FIREBASE_PROJECT_ID").text =
        "other-project"),
    (c) =>
      (c.bindings.find((b) => b.name === "EVENTS_DATABASE").namespace_id =
        "other"),
    (c) =>
      c.bindings.push({
        name: "UNKNOWN_FLAG",
        type: "plain_text",
        text: "false",
      }),
    (c) => c.compatibility_flags.pop(),
    (c) => (c.logpush = true),
    (c) => (c.placement = { mode: "smart" }),
    (c) => c.bindings.push(c.bindings[0]),
  ]) {
    const raw = structuredClone(f.current);
    mutate(raw);
    assert.throws(() => checkConfiguration(raw, f.receipt));
  }
});
test("end-to-end diagnostic is GET-only, checks both origins, emits no raw values and grants no release authorization", async () => {
  const f = fixture();
  const report = await diagnose(f.options);
  assert.equal(report.status, "verified-diagnostic-only");
  assert.equal(report.purpose, "diagnostic-only-not-release-authorization");
  assert.equal(report.checks.length, 10);
  assert.equal(report.asset_count, 1);
  const output = JSON.stringify({ report, logs: f.logs });
  for (const value of [
    "synthetic-token",
    "synthetic-asset-reference",
    "Add variable:",
    "AIza",
    "export default",
    "gather-58a79.firebaseapp.com",
  ])
    assert.ok(!output.includes(value));
  assert.equal(f.calls.filter((u) => u.endsWith("/app.js")).length, 2);
});
test("unknown active version, unrecognized baseline release, changed migration, routes or code fail closed", async () => {
  const script = `/accounts/${ACCOUNT}/workers/scripts/events`;
  for (const [key, mutate, blocker] of [
    [
      script + "/deployments",
      (v) => (v.deployments[0].versions[0].version_id = BASE),
      "ACTIVE_VERSION_CHANGED",
    ],
    [
      script + `/versions/${BASE}`,
      (v) => (v.annotations["workers/message"] = "unknown"),
      "BASELINE_RELEASE_ANNOTATION_MISMATCH",
    ],
    [
      script + `/versions/${ACTIVE}`,
      (v) => (v.resources.script_runtime.migration_tag = "other"),
      "MIGRATION_LINEAGE_MISMATCH",
    ],
    [
      `/accounts/${ACCOUNT}/workers/workers/events/versions/${ACTIVE}?include=modules`,
      (v) => delete v.modules,
      "MODULE_BYTES_UNAVAILABLE",
    ],
    [
      `/accounts/${ACCOUNT}/workers/services/events/environments/production/routes?show_zonename=true`,
      (v) => v.push({ id: "other" }),
      "ROUTING_MISMATCH",
    ],
  ]) {
    const f = fixture();
    mutate(f.payloads.get(key));
    const report = await diagnose(f.options);
    assert.equal(report.status, "blocked");
    assert.equal(report.blocker, blocker);
  }
});
test("provider errors, redirects, public asset mismatches and changed inventory produce sanitized blockers", async () => {
  for (const kind of ["transport", "http", "asset", "changed"]) {
    const f = fixture(),
      real = f.options.fetcher;
    let deployments = 0;
    f.options.fetcher = async (url, o) => {
      if (kind === "transport") throw Error("secret provider diagnostics");
      if (kind === "http")
        return new Response("secret provider diagnostics", { status: 302 });
      if (kind === "asset" && !url.startsWith("https://api.cloudflare.com"))
        return new Response("modified asset");
      if (
        kind === "changed" &&
        url.endsWith("/deployments") &&
        ++deployments === 2
      )
        f.payloads.get(
          `/accounts/${ACCOUNT}/workers/scripts/events/deployments`,
        ).deployments[0].id = "changed";
      return real(url, o);
    };
    const report = await diagnose(f.options);
    assert.equal(report.status, "blocked");
    assert.ok(!JSON.stringify(report).includes("secret provider diagnostics"));
  }
});
test("diagnostic workflow is owner-confirmed dispatch/call only, with fixed anchor and no deployment integration", async () => {
  const workflow = await readFile(
    new URL(
      "../.github/workflows/verify-production-provenance.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.ok(workflow.includes("VERIFY_READ_ONLY"));
  assert.ok(workflow.includes('artifact-ids: "14280212512"'));
  assert.ok(
    !/pull_request:|push:|schedule:|wrangler|npm run deploy|automatic-events-release.mjs/.test(
      workflow,
    ),
  );
  const source = await readFile(
    new URL("./production-provenance-diagnostic.mjs", import.meta.url),
    "utf8",
  );
  assert.ok(!/method: ["'](?:POST|PUT|PATCH|DELETE)/.test(source));
});

test("CLI fails closed before any provider read when the pinned anchor is unavailable", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gather-provenance-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const child = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL("./production-provenance-diagnostic.mjs", import.meta.url),
      ),
    ],
    {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, RUNNER_TEMP: directory, CLOUDFLARE_API_TOKEN: "" },
      timeout: 10000,
    },
  );
  assert.equal(child.status, 1);
  assert.equal(child.stderr, "");
  const report = JSON.parse(
    await readFile(
      join(directory, "production-provenance-report.json"),
      "utf8",
    ),
  );
  assert.deepEqual(report, {
    schema: 1,
    status: "blocked",
    blocker: "TRUSTED_INPUT_UNAVAILABLE",
  });
});

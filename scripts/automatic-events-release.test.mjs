import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  run,
  validateEvent,
  validateForward,
  validateConfiguration,
  validateSource,
  appearanceManifest,
  runtimeOverlay,
  runtimeSettingsFingerprint,
  normalizedPlacement,
  verifyCheckpointArtifact,
  versionAnnotations,
  annotationSchemaSummary,
  publishExact,
  wranglerFailure,
  ReleaseError,
  ACCOUNT,
  NAMESPACE,
  INITIAL_VERSION,
} from "./automatic-events-release.mjs";
const RELEASE = "b".repeat(40),
  VERSION = "12345678-1234-1234-1234-123456789abc";
const hash = (x) => createHash("sha256").update(x).digest("hex");
const policy = JSON.parse(
  await readFile(".github/release/approved-application.json", "utf8"),
);
const event = () => ({
  action: "closed",
  pull_request: {
    number: 75,
    merged: true,
    merged_by: { login: "kasstmaster" },
    merge_commit_sha: RELEASE,
    base: { ref: "main", repo: { full_name: "kasstmaster/events" } },
    head: { repo: { full_name: "kasstmaster/events" } },
  },
});
const environment = () => ({
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "kasstmaster/events",
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_RUN_ID: "99",
  GITHUB_RUN_ATTEMPT: "1",
  MERGED_SHA: RELEASE,
  CLOUDFLARE_API_TOKEN: "synthetic-cloudflare",
  ACTIONS_GITHUB_TOKEN: "synthetic-github",
});
test("only an exact owner-merged same-repository PR to main is authorized", () => {
  assert.equal(validateEvent(event(), RELEASE, environment()), 75);
  const mutations = [
    (e) => (e.action = "opened"),
    (e) => (e.pull_request.merged = false),
    (e) => (e.pull_request.base.ref = "feature"),
    (e) => (e.pull_request.merged_by.login = "other"),
    (e) => (e.pull_request.head.repo.full_name = "fork/events"),
    (e) => (e.pull_request.merge_commit_sha = "a".repeat(40)),
  ];
  for (const change of mutations) {
    const e = event();
    change(e);
    assert.throws(() => validateEvent(e, RELEASE, environment()), /Event/);
  }
  for (const name of ["push", "workflow_dispatch", "workflow_run", "create"])
    assert.throws(
      () =>
        validateEvent(event(), RELEASE, {
          ...environment(),
          GITHUB_EVENT_NAME: name,
        }),
      /Only/,
    );
});
test("configuration is exact; dropped flags, variables, routes and namespace/migrations cannot slip through", async () => {
  await validateConfiguration(policy);
  const dir = await mkdtemp(join(tmpdir(), "events-config-"));
  try {
    const original = await readFile("wrangler.jsonc", "utf8");
    for (const text of [
      original.replace("global_fetch_strictly_public", "missing"),
      original.replace('"keep_vars": true', '"keep_vars": false'),
      original.replace("events-v1", "events-v2"),
      original.replace('"name": "events"', '"name": "other"'),
    ]) {
      await writeFile(join(dir, "wrangler.jsonc"), text);
      await assert.rejects(
        validateConfiguration(
          { ...policy, configuration_sha256: hash(text) },
          dir,
        ),
        /configuration differs/,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("source guard checks integrated history, missing modules, appearance parity, untracked assets and storage adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "events-source-"));
  const g = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    }).trim();
  try {
    const required = [
      "public/editor-tools.js",
      "public/style.css",
      "server/personal-accounts.js",
      "server/family-api.js",
      "cloudflare/gateway-protocol.js",
      "test/personal-mobile.js",
    ];
    for (const path of required) {
      await mkdir(resolve(root, path, ".."), { recursive: true });
      await writeFile(resolve(root, path), "synthetic\n");
    }
    await mkdir(join(root, ".github/release"), { recursive: true });
    await mkdir(join(root, "cloudflare"), { recursive: true });
    await writeFile(
      join(root, "cloudflare/worker.js"),
      await readFile("cloudflare/worker.js"),
    );
    await writeFile(
      join(root, "wrangler.jsonc"),
      await readFile("wrangler.jsonc"),
    );
    const p = {
      ...policy,
      required_application_paths: required,
      appearance: await appearanceManifestFixture(root, required),
    };
    await writeFile(
      join(root, ".github/release/approved-application.json"),
      JSON.stringify(p),
    );
    g("init");
    g("add", ".");
    g(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "fixture",
    );
    const head = g("rev-parse", "HEAD");
    await validateSource(head, { root, floor: head });
    await writeFile(join(root, "public/unreviewed.js"), "unreviewed");
    await assert.rejects(
      validateSource(head, { root, floor: head }),
      /Unreviewed/,
    );
    await rm(join(root, "public/unreviewed.js"));
    await writeFile(join(root, "public/style.css"), "unexpected");
    await assert.rejects(
      validateSource(head, { root, floor: head }),
      /Tracked source/,
    );
    g("add", ".");
    g(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "unexpected appearance",
    );
    const changed = g("rev-parse", "HEAD");
    await assert.rejects(
      validateSource(changed, { root, floor: head }),
      /Public files differ/,
    );
    g("reset", "--hard", head);
    g("rm", "server/personal-accounts.js");
    g(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "older tree",
    );
    await assert.rejects(
      validateSource(g("rev-parse", "HEAD"), { root, floor: head }),
      /modules are missing/,
    );
    assert.throws(
      () =>
        validateForward(
          { version_id: VERSION, release: "f".repeat(40) },
          head,
          root,
        ),
      /newer or unrelated/,
    );
    assert.throws(
      () => validateForward({ version_id: VERSION, release: head }, head, root),
      /already-active/,
    );
    assert.throws(
      () => validateForward({ version_id: VERSION, release: null }, head, root),
      /Unknown/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
async function appearanceManifestFixture(root, paths) {
  const entries = await Promise.all(
    paths
      .filter((p) => p.startsWith("public/"))
      .map(async (p) => [p, hash(await readFile(join(root, p)))]),
  );
  return Object.fromEntries(entries);
}
const settings = () => ({
  compatibility_date: "2026-10-30",
  compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
  annotations: {
    "workers/message": "previous-release",
    "workers/triggered_by": "rollback",
  },
  observability: { enabled: true },
  bindings: [
    { name: "ASSETS", type: "assets" },
    {
      name: "EVENTS_DATABASE",
      type: "durable_object_namespace",
      namespace_id: NAMESPACE,
      class_name: "EventsDatabase",
    },
    {
      name: "PRIVATE_VALUE",
      type: "plain_text",
      text: "synthetic-private-value",
    },
    { name: "PRIVATE_SECRET", type: "secret_text" },
  ],
});
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "events-auto-"));
  await mkdir(join(root, "recovery"));
  const env = environment(),
    state = {
      version: INITIAL_VERSION,
      versionTag: "retained-version-tag",
      publishes: 0,
      protected: true,
      latest: RELEASE,
      prMerged: true,
      artifact: true,
      drift: false,
      wrongNamespace: false,
      openSetup: false,
      previews: false,
      publicChange: false,
      manifestChange: true,
      ownerLabel: true,
      ownerLabelActor: true,
      healthFailures: 0,
      httpFailure: false,
    };
  const p = {
    ...policy,
    appearance: {
      "public/index.html": hash("approved-index"),
      "public/style.css": hash("approved-style"),
    },
  };
  const fetcher = async (url, options = {}) => {
    const u = new URL(url);
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    if (u.hostname === "api.github.com") {
      assert.equal(options.headers.Authorization, "Bearer synthetic-github");
      if (u.pathname.endsWith("/branches/main"))
        return Response.json({
          protected: state.protected,
          commit: { sha: state.latest },
        });
      if (u.pathname.endsWith("/pulls/75"))
        return Response.json({
          ...event().pull_request,
          merged: state.prMerged,
          labels: state.ownerLabel
            ? [{ name: "approved-appearance-change" }]
            : [],
        });
      if (u.pathname.endsWith("/files"))
        return Response.json(
          state.publicChange
            ? [
                { filename: "public/style.css" },
                ...(state.manifestChange
                  ? [{ filename: ".github/release/approved-application.json" }]
                  : []),
              ]
            : [{ filename: "server/handler.js" }],
        );
      if (u.pathname.endsWith("/events"))
        return Response.json([
          {
            event: "labeled",
            label: { name: "approved-appearance-change" },
            actor: { login: state.ownerLabelActor ? "kasstmaster" : "other" },
          },
        ]);
      if (u.pathname.endsWith("/artifacts")) {
        state.artifactReads = (state.artifactReads || 0) + 1;
        if (state.artifactDelay > 0) {
          state.artifactDelay--;
          return Response.json({ artifacts: [] });
        }
        return Response.json({
          artifacts: state.artifact
            ? [
                {
                  id: 123,
                  name: "events-recovery-99-1",
                  expired: false,
                  size_in_bytes: 20,
                  digest: "sha256:" + "f".repeat(64),
                },
              ]
            : [],
        });
      }
      assert.fail("Unexpected GitHub route");
    }
    if (u.hostname === "api.cloudflare.com") {
      assert.equal(
        options.headers.Authorization,
        "Bearer synthetic-cloudflare",
      );
      if (state.httpFailure)
        return Response.json({ private: "must-not-escape" }, { status: 403 });
      let result;
      if (u.pathname.endsWith("/settings")) {
        result = settings();
        result.placement =
          state.version === INITIAL_VERSION ? {} : { mode: "off" };
        result.annotations["workers/tag"] = state.versionTag;
        result.annotations["workers/triggered_by"] =
          state.version === INITIAL_VERSION ? "rollback" : "upload";
        result.annotations["workers/message"] =
          state.version === INITIAL_VERSION ? "previous-release" : RELEASE;
        if (state.drift) result.observability.enabled = false;
        if (state.wrongNamespace) result.bindings[1].namespace_id = "wrong";
      } else if (u.pathname.endsWith("/deployments"))
        result = {
          deployments: [
            {
              id: state.version,
              created_on: new Date().toISOString(),
              versions: [{ version_id: state.version, percentage: 100 }],
            },
          ],
        };
      else if (u.pathname.includes("/versions/"))
        result = {
          resources: { script_runtime: { migration_tag: "events-v1" } },
          annotations:
            state.version === INITIAL_VERSION
              ? {}
              : { "workers/message": RELEASE },
        };
      else if (u.pathname.endsWith("/schedules"))
        result = { schedules: [{ cron: "*/5 * * * *" }] };
      else if (u.pathname.endsWith("/subdomain"))
        result = { enabled: true, previews_enabled: state.previews };
      else if (u.pathname.endsWith("/services/events"))
        result = { default_environment: { environment: "production" } };
      else if (
        u.pathname.endsWith("/routes") ||
        u.pathname.endsWith("/domains/records")
      )
        result = [];
      else assert.fail("Unexpected Cloudflare route");
      return Response.json(
        { success: true, result },
        { headers: { date: new Date().toUTCString() } },
      );
    }
    assert.ok(
      ["events.kassandraraudman.workers.dev", "name.ilymmd.com"].includes(
        u.hostname,
      ),
    );
    assert.ok(!options.headers?.Authorization);
    if (u.pathname === "/api/setup")
      return Response.json({
        required: state.openSetup,
        enabled: state.openSetup,
      });
    if (state.healthFailures-- > 0) return new Response("stale");
    return new Response(
      u.pathname === "/" ? "approved-index" : "approved-style",
    );
  };
  const options = {
    env,
    root,
    policy: p,
    event: event(),
    fetcher,
    sourceValidator: async () => {},
    wait: async () => {},
    publisher: async (...args) => {
      const release = args[0];
      assert.equal(args[6], state.versionTag);
      assert.deepEqual(args[3].placement, { mode: "off" });
      assert.equal(release, RELEASE);
      state.publishes++;
      state.version = VERSION;
      return VERSION;
    },
  };
  const preflight = async () => {
    await run("preflight", options);
    env.CHECKPOINT_SHA256 = hash(
      await readFile(join(root, "recovery/events-checkpoint.json")),
    );
    env.CHECKPOINT_ARTIFACT_ID = "123";
    env.CHECKPOINT_ARTIFACT_DIGEST = "sha256:" + "f".repeat(64);
  };
  try {
    await fn({ state, options, preflight, env, root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test("checkpoint precedes a single exact publish; verification checks all assets and preserved state without writes", () =>
  fixture(async ({ state, options, preflight, root }) => {
    await preflight();
    assert.equal(state.publishes, 0);
    const text = await readFile(
      join(root, "recovery/events-checkpoint.json"),
      "utf8",
    );
    assert.ok(!text.includes("synthetic-private-value"));
    assert.ok(!text.includes("synthetic-cloudflare"));
    await run("publish", options);
    assert.equal(state.publishes, 1);
    state.latest = "c".repeat(40);
    state.healthFailures = 1;
    await run("verify", options);
    assert.equal(state.publishes, 1);
    const v = JSON.parse(
      await readFile(join(root, "recovery/events-verification.json"), "utf8"),
    );
    assert.equal(v.release, RELEASE);
    assert.equal(v.version_id, VERSION);
  }));
test("branch protection, stale main and merge identity fail before publishing", () =>
  fixture(async ({ state, options }) => {
    state.protected = false;
    await assert.rejects(run("preflight", options), /branch protection/);
    state.protected = true;
    state.latest = "a".repeat(40);
    await assert.rejects(run("preflight", options), /latest main/);
    state.latest = RELEASE;
    state.prMerged = false;
    await assert.rejects(run("preflight", options), /owner merge/);
    assert.equal(state.publishes, 0);
  }));
test("public changes require manifest update and label actually applied by owner", () =>
  fixture(async ({ state, options }) => {
    state.publicChange = true;
    state.manifestChange = false;
    await assert.rejects(run("preflight", options), /appearance approval/);
    state.manifestChange = true;
    state.ownerLabel = false;
    await assert.rejects(run("preflight", options), /appearance approval/);
    state.ownerLabel = true;
    state.ownerLabelActor = false;
    await assert.rejects(run("preflight", options), /applied by the owner/);
    assert.equal(state.publishes, 0);
  }));
test("failed artifact upload, altered checkpoint and prepublish runtime drift never publish", () =>
  fixture(async ({ state, options, preflight, env }) => {
    await preflight();
    state.artifact = false;
    await assert.rejects(run("publish", options), /artifact upload/);
    state.artifact = true;
    env.CHECKPOINT_SHA256 = "wrong";
    await assert.rejects(run("publish", options), /changed after upload/);
    await preflight();
    state.drift = true;
    await assert.rejects(run("publish", options), /changed after checkpoint/);
    assert.equal(state.publishes, 0);
  }));
test("namespace mismatch, open setup, enabled previews and raw provider failures stop safely", () =>
  fixture(async ({ state, options }) => {
    state.wrongNamespace = true;
    await assert.rejects(run("preflight", options), /namespace/);
    state.wrongNamespace = false;
    state.openSetup = true;
    await assert.rejects(run("preflight", options), /setup/);
    state.openSetup = false;
    state.previews = true;
    await assert.rejects(run("preflight", options), /previews/);
    state.previews = false;
    state.httpFailure = true;
    await assert.rejects(
      run("preflight", options),
      (e) =>
        e.message.includes("403") && !e.message.includes("must-not-escape"),
    );
    assert.equal(state.publishes, 0);
  }));
test("post-deployment drift and assets that never converge fail without re-publishing", () =>
  fixture(async ({ state, options, preflight }) => {
    await preflight();
    await run("publish", options);
    state.drift = true;
    await assert.rejects(run("verify", options), /Runtime settings/);
    state.drift = false;
    state.healthFailures = 1000;
    await assert.rejects(run("verify", options), /not converged/);
    assert.equal(state.publishes, 1);
  }));
test("workflow gates exact merged source, all suites, shared lock and mandatory checkpoint upload", async () => {
  const text = await readFile(
    ".github/workflows/deploy-approved-events.yml",
    "utf8",
  );
  assert.match(text, /types: \[closed\]/);
  assert.match(text, /merged_by.login == 'kasstmaster'/);
  assert.match(text, /merge_commit_sha/);
  assert.match(text, /needs: \[checks, browser\]/);
  assert.match(text, /group: events-production/);
  assert.match(text, /cancel-in-progress: false/);
  assert.ok(text.indexOf("id: checkpoint") < text.indexOf("mjs publish"));
  for (const command of [
    "npm run format:check",
    "npm test",
    "npm run test:cloudflare",
    "--dry-run",
    "test/mobile.cjs",
    "test/domains-mobile.js",
    "test/family-mobile.js",
    "test/navigation-mobile.js",
    "test/features-mobile.js",
    "test/toolbar-mobile.js",
    "test/household-ui-mobile.js",
    "test/information-popups-mobile.js",
    "test/cards-mobile.js",
    "test/personal-mobile.js",
    "test/evites-mobile.js",
  ])
    assert.ok(text.includes(command), command);
  assert.doesNotMatch(
    text,
    /^\s+(push|workflow_run|workflow_dispatch|schedule):/m,
  );
  assert.doesNotMatch(text, /ref: [0-9a-f]{40}|925c25ad/);
  assert.match(text, /CHECKPOINT_ARTIFACT_DIGEST/);
  assert.match(text, /if-no-files-found: error/);
});

test("runtime overlay preserves observability and optional settings but rejects unknown metadata/bindings", () => {
  const raw = settings();
  raw.cache = false;
  raw.limits = { cpu_ms: 30 };
  raw.placement = { mode: "off" };
  const mapped = runtimeOverlay(raw);
  assert.equal(mapped.observability.enabled, true);
  assert.deepEqual(mapped.cache, { enabled: false });
  assert.deepEqual(mapped.limits, { cpu_ms: 30 });
  assert.ok(!("bindings" in mapped));
  assert.throws(
    () => runtimeOverlay({ ...raw, unknown_runtime_field: true }),
    /Unknown live/,
  );
  for (const field of ["assets", "id", "synthetic-secret-field"]) {
    assert.throws(
      () => runtimeOverlay({ ...raw, [field]: "synthetic-private-value" }),
      (error) =>
        error.stage === "settings-schema" &&
        error.message.includes("Schema (names/types only)") &&
        !error.message.includes("synthetic-private-value") &&
        !error.message.includes("synthetic-secret-field"),
    );
  }

  assert.throws(
    () =>
      runtimeOverlay({
        ...raw,
        bindings: [
          ...raw.bindings,
          { name: "OTHER_DATABASE", type: "durable_object_namespace" },
        ],
      }),
    /additional binding/,
  );
});
test("publisher validates private runtime config locally, rechecks immediately before one publish, and discards raw output", async () => {
  let calls = 0,
    checked = false,
    configPath;
  const execute = async (command, args, options) => {
    assert.equal(command, process.execPath);
    configPath = args[args.indexOf("--config") + 1];
    const effective = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(effective.observability, { enabled: true });
    assert.ok(effective.main.startsWith("/"));
    assert.ok(effective.assets.directory.startsWith("/"));
    assert.equal(effective.account_id, ACCOUNT);
    calls++;
    assert.equal(args[args.indexOf("--tag") + 1], "retained-version-tag");
    if (args.includes("--dry-run"))
      return { stdout: "bundle validated", stderr: "" };
    assert.ok(checked);
    assert.equal(args[args.indexOf("--message") + 1], RELEASE);
    assert.equal(args[args.indexOf("--tag") + 1], "retained-version-tag");
    assert.ok(args.includes("--keep-vars"));
    assert.equal(options.env.HTTPS_PROXY, "http://proxy.invalid");
    await writeFile(
      options.env.WRANGLER_OUTPUT_FILE_PATH,
      JSON.stringify({
        type: "deploy",
        version: 1,
        worker_name: "events",
        version_id: VERSION,
      }) + "\n",
    );
    return { stdout: "private raw output", stderr: "" };
  };
  const version = await publishExact(
    RELEASE,
    { ...environment(), HTTPS_PROXY: "http://proxy.invalid" },
    ".",
    { observability: { enabled: true } },
    execute,
    async () => {
      checked = true;
    },
    "retained-version-tag",
  );
  assert.equal(version, VERSION);
  assert.equal(calls, 2);
  await assert.rejects(readFile(configPath), /ENOENT/);
  let rejectedCalls = 0;
  await assert.rejects(
    publishExact(RELEASE, environment(), ".", {}, async () => {
      rejectedCalls++;
      return {
        stdout: "Unexpected fields found in runtime config",
        stderr: "",
      };
    }),
    /cannot preserve/,
  );
  assert.equal(rejectedCalls, 1);
});

test("version annotations do not masquerade as runtime changes; all actual settings and tag drift remain protected", () => {
  const raw = settings();
  assert.doesNotThrow(() => runtimeOverlay(raw));
  assert.ok(!("annotations" in runtimeOverlay(raw)));
  for (const annotations of [
    {},
    undefined,
    { "workers/message": RELEASE },
    {
      "workers/message": RELEASE,
      "workers/commit_sha": RELEASE,
      "workers/pull_request_number": "76",
      "workers/pull_request_title": "Reviewed release",
      "workers/pull_request_url":
        "https://github.com/kasstmaster/events/pull/76",
      "workers/repository_url": "https://github.com/kasstmaster/events",
    },
  ])
    assert.equal(
      runtimeSettingsFingerprint({ ...raw, annotations }),
      runtimeSettingsFingerprint(raw),
    );
  const tagged = {
    ...raw,
    annotations: { "workers/tag": "retained-version-tag" },
  };
  assert.notEqual(
    runtimeSettingsFingerprint(tagged),
    runtimeSettingsFingerprint(raw),
  );
  assert.notEqual(
    runtimeSettingsFingerprint({ ...raw, placement: { mode: "smart" } }),
    runtimeSettingsFingerprint(raw),
  );
  assert.notEqual(
    runtimeSettingsFingerprint({ ...raw, unexpected_runtime: true }),
    runtimeSettingsFingerprint(raw),
  );
  assert.notEqual(
    runtimeSettingsFingerprint({
      ...raw,
      bindings: [
        ...raw.bindings,
        { type: "plain_text", name: "OTHER", text: "private-value" },
      ],
    }),
    runtimeSettingsFingerprint(raw),
  );
  assert.notEqual(
    runtimeSettingsFingerprint({
      ...raw,
      compatibility_flags: ["nodejs_compat"],
    }),
    runtimeSettingsFingerprint(raw),
  );
});
test("malformed or unknown annotation metadata stops with no secret-bearing diagnostics", () => {
  for (const annotations of [
    null,
    [],
    "private-value",
    { "custom/secret": "private-value" },
    { "workers/tag": { secret: "private-value" } },
    { "workers/tag": "x".repeat(101) },
    { "workers/tag": "é".repeat(51) },
  ]) {
    assert.throws(
      () => versionAnnotations({ annotations }),
      (e) =>
        e.stage === "settings-schema" &&
        !e.message.includes("private-value") &&
        !e.message.includes("custom/secret"),
    );
    assert.throws(
      () => runtimeOverlay({ ...settings(), annotations }),
      /Unsupported version annotations/,
    );
  }
});

test("Cloudflare provenance for restored and new versions is recognized without weakening runtime protection", () => {
  const raw = settings();
  for (const trigger of [
    "upload",
    "secret",
    "rollback",
    "promotion",
    "api",
    "dashboard_rollback",
    "deployment-rollback",
    "private-provenance",
    "x".repeat(1024),
  ]) {
    const observed = {
      ...raw,
      annotations: { ...raw.annotations, "workers/triggered_by": trigger },
    };
    assert.doesNotThrow(() => runtimeOverlay(observed));
    assert.equal(
      runtimeSettingsFingerprint(observed),
      runtimeSettingsFingerprint(raw),
    );
    assert.ok(!("annotations" in runtimeOverlay(observed)));
  }
  for (const trigger of [
    "x".repeat(1025),
    "é".repeat(513),
    null,
    123,
    { secret: "private-provenance" },
  ]) {
    assert.throws(
      () =>
        versionAnnotations({
          annotations: { "workers/triggered_by": trigger },
        }),
      (e) =>
        e.stage === "settings-schema" &&
        !e.message.includes("private-provenance") &&
        e.message.includes("workers/triggered_by:"),
    );
  }
});
test("annotation shape diagnostics never expose values or arbitrary annotation names", () => {
  const summary = annotationSchemaSummary({
    "workers/triggered_by": "private-provenance",
    "workers/message": "private-message",
    "private-annotation-name": "private-value",
  });
  assert.ok(summary.includes("workers/triggered_by:string"));
  assert.ok(summary.includes("[unrecognized-annotation]:string"));
  assert.ok(!summary.includes("private-"));
  assert.equal(annotationSchemaSummary(null), "null");
  assert.equal(annotationSchemaSummary([]), "array");
  assert.equal(annotationSchemaSummary({}), "empty-object");
});

test("Wrangler failures distinguish build from upload and reveal only fixed categories and numeric codes", () => {
  const privateText =
    "synthetic-private-secret https://private.invalid Authorization: Bearer private";
  for (const operation of ["local-build", "publish"]) {
    const error = wranglerFailure(
      {
        code: 1,
        stdout: privateText,
        stderr: "Authentication error [code: 10000] " + privateText,
      },
      operation,
    );
    assert.equal(error.stage, operation);
    assert.ok(error.message.includes("category authentication"));
    assert.ok(error.message.includes("10000"));
    assert.ok(!error.message.includes("synthetic-private"));
    assert.ok(!error.message.includes("Authorization"));
    assert.ok(!error.message.includes("private.invalid"));
    assert.ok(
      error.message.includes(
        operation === "local-build"
          ? "No upload was attempted"
          : "Inspect active version",
      ),
    );
  }
  assert.ok(
    wranglerFailure(
      { code: "PRIVATE", stderr: privateText },
      "publish",
    ).message.includes("exit unavailable"),
  );
});
test("diagnostic build can only invoke the dry run and never calls publication callback", async () => {
  let calls = 0;
  const result = await publishExact(
    undefined,
    environment(),
    ".",
    {},
    async (command, args) => {
      calls++;
      assert.ok(args.includes("--dry-run"));
      return { stdout: "bundle ready", stderr: "" };
    },
    () => assert.fail("must not invoke publication callback"),
    undefined,
    true,
  );
  assert.equal(result, undefined);
  assert.equal(calls, 1);
  await assert.rejects(
    publishExact(
      undefined,
      environment(),
      ".",
      {},
      async () => {
        throw { code: 1, stderr: "Could not resolve synthetic-private-path" };
      },
      () => assert.fail("must not publish"),
      undefined,
      true,
    ),
    (e) =>
      e.stage === "local-build" &&
      e.message.includes("category bundle") &&
      !e.message.includes("synthetic-private-path"),
  );
});

test("configuration diagnostics recognize pinned Wrangler required-field errors without echoing values", () => {
  const error = wranglerFailure(
    {
      code: 1,
      stdout: "Proxy environment variables detected",
      stderr:
        '\u001b[31mProcessing PRIVATE-PATH configuration:\u001b[0m\n - "placement.mode" is a required field. PRIVATE-SECRET',
    },
    "local-build",
  );
  assert.ok(error.message.includes("category configuration"));
  assert.ok(error.message.includes("fields placement.mode"));
  assert.ok(error.message.includes("reasons required-field"));
  assert.ok(!error.message.includes("PRIVATE"));
  assert.ok(!error.message.includes("Proxy environment"));
});

test("only Cloudflare's empty disabled placement is converted to explicit Wrangler off", () => {
  const raw = { ...settings(), placement: {} };
  assert.deepEqual(runtimeOverlay(raw).placement, { mode: "off" });
  assert.deepEqual(raw.placement, {});
  assert.equal(
    runtimeSettingsFingerprint(raw),
    runtimeSettingsFingerprint({ ...raw, placement: { mode: "off" } }),
  );
  for (const placement of [
    { mode: "smart" },
    { mode: "smart", hint: "synthetic-region" },
    { mode: "targeted", region: "synthetic-region" },
    { status: "unknown" },
    { mode: "off", unexpected: true },
    null,
    [],
  ]) {
    assert.deepEqual(normalizedPlacement(placement), placement);
    assert.notEqual(
      runtimeSettingsFingerprint({ ...raw, placement }),
      runtimeSettingsFingerprint(raw),
    );
  }
  assert.ok(!("placement" in runtimeOverlay(settings())));
  assert.notEqual(
    runtimeSettingsFingerprint({
      ...raw,
      bindings: [
        ...raw.bindings,
        { name: "OTHER", type: "plain_text", text: "private" },
      ],
    }),
    runtimeSettingsFingerprint(raw),
  );
});

test("delayed recovery artifact visibility waits read-only before exactly one publish", () =>
  fixture(async ({ state, options, preflight }) => {
    await preflight();
    state.artifactDelay = 2;
    let waits = 0;
    options.wait = async (ms) => {
      assert.equal(ms, 3000);
      assert.equal(state.publishes, 0);
      waits++;
    };
    await run("publish", options);
    assert.equal(waits, 2);
    assert.equal(state.artifactReads, 3);
    assert.equal(state.publishes, 1);
  }));
test("artifact digest visibility may converge but mismatches, expiry and read failures stop immediately", async () => {
  const env = {
    CHECKPOINT_ARTIFACT_ID: "123",
    CHECKPOINT_ARTIFACT_DIGEST: "sha256:" + "f".repeat(64),
    GITHUB_RUN_ID: "99",
    GITHUB_RUN_ATTEMPT: "1",
  };
  const good = {
    id: 123,
    name: "events-recovery-99-1",
    digest: env.CHECKPOINT_ARTIFACT_DIGEST,
    expired: false,
    size_in_bytes: 20,
  };
  let reads = 0,
    waits = 0;
  await verifyCheckpointArtifact({
    env,
    readArtifacts: async () => ({
      artifacts: [{ ...good, digest: ++reads < 3 ? null : good.digest }],
    }),
    wait: async () => {
      waits++;
    },
  });
  assert.equal(reads, 3);
  assert.equal(waits, 2);
  for (const change of [
    { digest: "sha256:" + "a".repeat(64) },
    { expired: true },
    { expired: undefined },
    { size_in_bytes: 0 },
    { name: "wrong" },
  ]) {
    await assert.rejects(
      verifyCheckpointArtifact({
        env,
        readArtifacts: async () => ({ artifacts: [{ ...good, ...change }] }),
        wait: () => assert.fail("must not retry a mismatch"),
      }),
      (e) => e.stage === "checkpoint-upload",
    );
  }
  await assert.rejects(
    verifyCheckpointArtifact({
      env,
      readArtifacts: async () => {
        throw new ReleaseError("checkpoint-upload", "HTTP 403");
      },
      wait: () => assert.fail("must not retry permission failures"),
    }),
    /403/,
  );
  let exhausted = 0;
  await assert.rejects(
    verifyCheckpointArtifact({
      env,
      readArtifacts: async () => {
        exhausted++;
        return { artifacts: [] };
      },
      wait: async () => {},
    }),
    /No publishing was attempted/,
  );
  assert.equal(exhausted, 9);
});

test("artifact visibility waits cannot bypass changed production or a newer main commit", async () => {
  for (const mutate of [
    (state) => {
      state.drift = true;
    },
    (state) => {
      state.latest = "a".repeat(40);
    },
  ]) {
    await fixture(async ({ state, options, preflight }) => {
      await preflight();
      state.artifactDelay = 1;
      options.wait = async () => {
        mutate(state);
      };
      await assert.rejects(
        run("publish", options),
        /changed after checkpoint|latest main/,
      );
      assert.equal(state.publishes, 0);
    });
  }
});

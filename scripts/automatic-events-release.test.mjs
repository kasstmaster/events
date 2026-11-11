import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("automatic Gather deployment only runs for merged PRs targeting main", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/deploy-events-auto.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    workflow,
    /pull_request:\s*\n\s*types: \[closed\]\s*\n\s*branches: \[main\]/,
  );
  assert.match(workflow, /pull_request\.merged == true/);
  assert.doesNotMatch(workflow, /^\s+push:/m);
  assert.match(workflow, /pull_request\.merge_commit_sha/);
  assert.match(workflow, /group: events-production/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /test:cloudflare/);
  assert.match(workflow, /automatic-events-release\.mjs preflight/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.match(workflow, /--keep-vars/);
  assert.match(workflow, /automatic-events-release\.mjs verify/);
  assert.match(workflow, /secrets\.CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(workflow, /925c25ad0f89b6deb85838ae36f13d168444b1d0/);
});

test("separate manual release remains opt-in and pinned", async () => {
  const manual = await readFile(
    new URL("../.github/workflows/deploy-events-manual.yml", import.meta.url),
    "utf8",
  );
  assert.match(manual, /workflow_dispatch:/);
  assert.doesNotMatch(manual, /^\s+push:/m);
  assert.match(manual, /925c25ad0f89b6deb85838ae36f13d168444b1d0/);
});

import { mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  runAuto,
  validateConfig,
  validateSource,
  validateProductionRelease,
  safeFailure,
} from "./automatic-events-release.mjs";

const release = "a".repeat(40);
const before = "11111111-1111-4111-8111-111111111111";
const after = "22222222-2222-4222-8222-222222222222";
const privateValue = "private-credential-and-response-sentinel";
const config = () => ({
  name: "events",
  account_id: "37d068144865a0b725ee272bc7b2eb71",
  main: "cloudflare/worker.js",
  compatibility_date: "2026-10-30",
  compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
  workers_dev: true,
  preview_urls: false,
  keep_vars: true,
  assets: { directory: "./public", binding: "ASSETS", run_worker_first: true },
  durable_objects: {
    bindings: [{ name: "EVENTS_DATABASE", class_name: "EventsDatabase" }],
  },
  migrations: [{ tag: "events-v1", new_sqlite_classes: ["EventsDatabase"] }],
  triggers: { crons: ["*/5 * * * *"] },
});
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "events-auto-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const f = {
    version: before,
    flags: ["nodejs_compat", "global_fetch_strictly_public"],
    crons: ["*/5 * * * *"],
    setup: { required: false, enabled: false },
    message: "",
    paths: [],
    waits: [],
    transient: 0,
    lag: 0,
  };
  const file = join(dir, "checkpoint.json"),
    configPath = join(dir, "wrangler.jsonc"),
    outputFile = join(dir, "wrangler.jsonl");
  await writeFile(configPath, JSON.stringify(config()));
  await writeFile(
    outputFile,
    JSON.stringify({
      type: "deploy",
      version: 1,
      worker_name: "events",
      version_id: after,
    }) + "\n",
  );
  f.options = {
    file,
    configPath,
    outputFile,
    env: {
      MERGED_SHA: release,
      GITHUB_SHA: "b".repeat(40),
      CLOUDFLARE_API_TOKEN: privateValue,
    },
    wait: async (ms) => f.waits.push(ms),
    fetcher: async (url, init) => {
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "error");
      f.paths.push(url);
      f.onRead?.(url);
      if (f.transient > 0) {
        f.transient--;
        throw Error(privateValue);
      }
      if (f.http) return new Response(privateValue, { status: f.http });
      if (url.endsWith("/api/setup")) {
        assert.equal(init.headers, undefined);
        return Response.json(f.setup);
      }
      assert.equal(init.headers.Authorization, "Bearer " + privateValue);
      let result;
      if (url.endsWith("/settings"))
        result = {
          compatibility_date: "2026-10-30",
          compatibility_flags: f.flags,
          bindings: [
            { type: "assets", name: "ASSETS" },
            {
              type: "durable_object_namespace",
              name: "EVENTS_DATABASE",
              namespace_id: "8203f4cd7fde45d2ab49de62e239d744",
              class_name: "EventsDatabase",
            },
            { type: "plain_text", name: "PRIVATE_SETTING", text: privateValue },
            { type: "secret_text", name: "SECRET" },
          ],
        };
      else if (url.endsWith("/deployments")) {
        const version = f.lag-- > 0 ? before : f.version;
        result = {
          deployments: [
            {
              id: "deployment",
              created_on: "2026-11-10T23:40:00Z",
              versions: [{ version_id: version, percentage: 100 }],
            },
          ],
        };
      } else if (url.includes("/versions/"))
        result = {
          resources: { script_runtime: { migration_tag: "events-v1" } },
          annotations: { "workers/message": f.message },
        };
      else if (url.endsWith("/schedules"))
        result = { schedules: f.crons.map((cron) => ({ cron })) };
      else if (url.endsWith("/subdomain"))
        result = { enabled: true, previews_enabled: f.preview ?? false };
      else assert.fail("Unexpected fixed endpoint");
      return Response.json(
        { success: true, result },
        { headers: { date: "Tue, 10 Nov 2026 23:40:00 GMT" } },
      );
    },
  };
  f.checkpoint = async () => {
    await runAuto("preflight", f.options);
    f.paths = [];
    f.version = after;
    f.message = release;
  };
  f.noAfter = () =>
    assert.rejects(access(file.replace(/\.json$/, "-after.json")));
  return f;
}

test("formatting and source/configuration gates precede production credentials and checkpoint upload precedes publication", async () => {
  const text = await readFile(
    new URL("../.github/workflows/deploy-events-auto.yml", import.meta.url),
    "utf8",
  );
  const formatting = text.indexOf("run: npm run format:check"),
    preflight = text.indexOf(
      "node scripts/automatic-events-release.mjs preflight",
    ),
    upload = text.indexOf("name: Save recovery checkpoint"),
    deploy = text.indexOf("name: Deploy exact merged Gather revision");
  assert.ok(
    formatting > 0 &&
      formatting < preflight &&
      preflight < upload &&
      upload < deploy,
  );
  assert.match(text, /fetch-depth: 0/);
  assert.match(text, /automatic-events-release\.mjs source/);
  assert.match(text, /automatic-events-release\.mjs configuration/);
  assert.match(
    text,
    /WRANGLER_OUTPUT_FILE_PATH: recovery\/events-wrangler-output\.jsonl/,
  );
  assert.match(text, /--message "\$MERGED_SHA"/);
  assert.doesNotMatch(
    text,
    /^\s+(workflow_dispatch|workflow_run|schedule|push):/m,
  );
});

test("reject the older production config before network access, including the lost fetch flag and cron", () => {
  validateConfig(config());
  for (const edit of [
    (c) => c.compatibility_flags.pop(),
    (c) => delete c.triggers,
    (c) => delete c.account_id,
    (c) => (c.keep_vars = false),
    (c) => (c.preview_urls = true),
    (c) => (c.routes = ["example.test/*"]),
    (c) => (c.migrations[0].deleted_classes = ["EventsDatabase"]),
    (c) => (c.durable_objects.bindings[0].script_name = "other"),
  ]) {
    const c = config();
    edit(c);
    assert.throws(() => validateConfig(c), /configuration differs/);
  }
});

test("source gate proves approved ancestry, exact checkout and unchanged tracked files using real local Git history", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "events-source-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init");
  git("config", "user.email", "synthetic@example.test");
  git("config", "user.name", "Synthetic fixture");
  await writeFile(join(dir, "app.txt"), "approved");
  git("add", ".");
  git("commit", "-m", "Approved application");
  const base = git("rev-parse", "HEAD");
  await writeFile(join(dir, "operations.txt"), "checked workflow");
  git("add", ".");
  git("commit", "-m", "Reviewed operations");
  const head = git("rev-parse", "HEAD");
  validateSource(head, { root: dir, approvedBase: base });
  validateProductionRelease(base, head, { root: dir });
  assert.throws(
    () => validateProductionRelease(head, base, { root: dir }),
    /overwriting a newer release/,
  );
  assert.throws(
    () => validateProductionRelease(head, head, { root: dir }),
    /already active/,
  );
  assert.throws(
    () => validateSource(base, { root: dir, approvedBase: base }),
    /exact owner-merged/,
  );
  assert.throws(
    () => validateSource(head, { root: dir, approvedBase: "f".repeat(40) }),
    /approved Gather application history/,
  );
  await writeFile(join(dir, "app.txt"), "changed after merge");
  assert.throws(
    () => validateSource(head, { root: dir, approvedBase: base }),
    /Tracked files changed/,
  );
});

test("preflight and exact-version verification retain only safe recovery/settings metadata", async (t) => {
  const f = await fixture(t);
  await f.checkpoint();
  const checkpoint = await readFile(f.options.file, "utf8");
  assert.doesNotMatch(checkpoint, new RegExp(privateValue));
  assert.equal(
    JSON.parse(checkpoint).recovery.timestamp,
    "2026-11-10T23:40:00.000Z",
  );
  await runAuto("verify", f.options);
  const result = await readFile(
    f.options.file.replace(/\.json$/, "-after.json"),
    "utf8",
  );
  assert.equal(JSON.parse(result).after.version_id, after);
  assert.equal(JSON.parse(result).release, release);
  assert.doesNotMatch(result, new RegExp(privateValue));
});

test("regression: losing global_fetch_strictly_public produces the actual safe runtime failure, never a misleading transport error", async (t) => {
  const f = await fixture(t);
  await f.checkpoint();
  f.flags = ["nodejs_compat"];
  await assert.rejects(runAuto("verify", f.options), (error) => {
    const message = safeFailure(error);
    assert.match(message, /live-settings.*Runtime date\/flags differ/);
    assert.doesNotMatch(message, /transport|private-credential/);
    return true;
  });
  assert.deepEqual(f.waits, []);
  await f.noAfter();
});

test("only transient verification reads and delayed activation are retried; publication is never retried", async (t) => {
  const f = await fixture(t);
  await f.checkpoint();
  f.transient = 1;
  f.lag = 1;
  await runAuto("verify", f.options);
  assert.equal(f.waits.length, 2);
  assert.ok(f.paths.every((p) => p.startsWith("https://")));
});

test("authorization errors stop immediately without logging response or token values", async (t) => {
  const f = await fixture(t);
  await f.checkpoint();
  f.http = 403;
  await assert.rejects(runAuto("verify", f.options), (e) => {
    assert.match(safeFailure(e), /HTTP 403/);
    assert.doesNotMatch(safeFailure(e), new RegExp(privateValue));
    return true;
  });
  assert.deepEqual(f.waits, []);
  await f.noAfter();
});

test("a new but unrelated active version cannot pass verification", async (t) => {
  const f = await fixture(t);
  await f.checkpoint();
  f.version = "33333333-3333-4333-8333-333333333333";
  await assert.rejects(
    runAuto("verify", f.options),
    /version emitted by Wrangler/,
  );
  assert.equal(f.waits.length, 3);
  await f.noAfter();
});

test("mismatched release identity, changed cron, preview enablement or open setup fail closed", async (t) => {
  for (const mutate of [
    (f) => (f.message = "b".repeat(40)),
    (f) => (f.crons = []),
    (f) => (f.preview = true),
    (f) => (f.setup.required = true),
  ]) {
    const f = await fixture(t);
    await f.checkpoint();
    mutate(f);
    await assert.rejects(runAuto("verify", f.options));
    await f.noAfter();
  }
});

test("missing structured output or mismatched checkpoint stops before any live read", async (t) => {
  const f = await fixture(t);
  await f.checkpoint();
  await rm(f.options.outputFile);
  await assert.rejects(
    runAuto("verify", f.options),
    /structured deployment output is missing/,
  );
  assert.equal(f.paths.length, 0);
  const checkpoint = JSON.parse(await readFile(f.options.file, "utf8"));
  checkpoint.account = "other";
  await writeFile(f.options.file, JSON.stringify(checkpoint));
  await assert.rejects(
    runAuto("verify", f.options),
    /checkpoint does not match/,
  );
  assert.equal(f.paths.length, 0);
});

test("preflight refuses changed production or missing cron and keeps setup closed", async (t) => {
  const f = await fixture(t);
  f.crons = [];
  await assert.rejects(runAuto("preflight", f.options), /Live cron differs/);
  assert.equal(
    safeFailure(Error(privateValue)),
    "Automatic release check failed [unexpected]; private transport details withheld.",
  );
});

test("concurrent production changes during preflight prevent checkpoint creation", async (t) => {
  const f = await fixture(t);
  f.onRead = (url) => {
    if (url.endsWith("/api/setup")) f.version = after;
  };
  await assert.rejects(
    runAuto("preflight", f.options),
    /Production changed during preflight/,
  );
  await assert.rejects(access(f.options.file));
});

test("repository configuration retains the approved production runtime footprint", async () => {
  const { parse } = await import("jsonc-parser");
  validateConfig(
    parse(
      await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
    ),
  );
});

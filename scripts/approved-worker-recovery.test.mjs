import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, MAIN, GOOD, BEFORE } from "./approved-worker-recovery.mjs";
const settings = () => ({
  compatibility_date: "2026-10-30",
  compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
  bindings: [
    { name: "ASSETS", type: "assets" },
    {
      name: "EVENTS_DATABASE",
      type: "durable_object_namespace",
      namespace_id: "8203f4cd7fde45d2ab49de62e239d744",
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
  const directory = await mkdtemp(join(tmpdir(), "gather-recovery-"));
  const state = {
    version: BEFORE,
    posts: 0,
    secretChanged: false,
    targetDrift: false,
    drift: false,
    auto: false,
  };
  const fetcher = async (url, options = {}) => {
    const u = new URL(url);
    const path = u.pathname;
    assert.equal(options.redirect, "error");
    if (u.host === "api.github.com") {
      assert.equal(options.method, undefined);
      if (path.endsWith("/git/ref/heads/main"))
        return Response.json({ object: { sha: MAIN } });
      if (path.endsWith("/deploy-events-auto.yml"))
        return Response.json({}, { status: state.auto ? 200 : 404 });
      if (path.endsWith("/actions/runs"))
        return Response.json({ workflow_runs: [] });
      assert.fail("Unexpected GitHub read");
    }
    if (path === "/api/setup")
      return Response.json({ required: false, enabled: false });
    assert.equal(u.host, "api.cloudflare.com");
    let result;
    if (options.method === "POST") {
      assert.ok(path.endsWith("/scripts/events/deployments"));
      assert.equal(u.search, "");
      state.posts++;
      const body = JSON.parse(options.body);
      assert.deepEqual(body.versions, [{ version_id: GOOD, percentage: 100 }]);
      assert.equal(body.strategy, "percentage");
      assert.ok(!("force" in body));
      if (state.secretChanged)
        return Response.json(
          {
            success: false,
            errors: [
              { code: 10220, message: "private diagnostic must not escape" },
            ],
          },
          { status: 400 },
        );
      state.version = GOOD;
      result = { id: "rollback" };
    } else {
      assert.equal(options.method, "GET");
      if (path.endsWith("/settings")) {
        result = settings();
        if (state.drift) result.bindings[2].text = "changed";
      } else if (path.endsWith("/deployments"))
        result = {
          deployments: [
            {
              id: state.version,
              created_on: "2026-11-11T08:00:00Z",
              versions: [{ version_id: state.version, percentage: 100 }],
            },
          ],
        };
      else if (path.includes("/versions/")) {
        const id = path.split("/").at(-1);
        const s = settings();
        if (state.targetDrift && id === GOOD)
          s.bindings[2].text = "target-drift";
        result = {
          id,
          resources: {
            script_runtime: { ...s, migration_tag: "events-v1" },
            bindings: s.bindings,
          },
        };
      } else if (path.endsWith("/schedules"))
        result = { schedules: [{ cron: "*/5 * * * *" }] };
      else if (path.endsWith("/subdomain"))
        result = { enabled: true, previews_enabled: false };
      else if (path.endsWith("/services/events"))
        result = { default_environment: { environment: "production" } };
      else if (path.endsWith("/routes")) result = [];
      else assert.fail("Unexpected Cloudflare read");
    }
    return Response.json(
      { success: true, result },
      { headers: { date: new Date().toUTCString() } },
    );
  };
  const options = {
    directory,
    fetcher,
    env: {
      CLOUDFLARE_API_TOKEN: "synthetic-cf",
      ACTIONS_GITHUB_TOKEN: "synthetic-gh",
    },
  };
  try {
    await fn(state, options);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test("preflight is read only, activation is exact and single, verification preserves database and runtime", () =>
  fixture(async (s, o) => {
    await run("preflight", o);
    assert.equal(s.posts, 0);
    const checkpoint = await readFile(
      join(o.directory, "checkpoint.json"),
      "utf8",
    );
    assert.ok(!checkpoint.includes("synthetic-private-value"));
    assert.ok(!checkpoint.includes("synthetic-cf"));
    await run("activate", o);
    assert.equal(s.posts, 1);
    await run("verify", o);
    const result = JSON.parse(
      await readFile(join(o.directory, "verification.json"), "utf8"),
    );
    assert.equal(result.active_version, GOOD);
    assert.equal(result.database_restore, false);
  }));
test("changed secrets are rejected without force, retry, or raw diagnostics", () =>
  fixture(async (s, o) => {
    await run("preflight", o);
    s.secretChanged = true;
    await assert.rejects(
      run("activate", o),
      (e) =>
        e.message.includes("10220") &&
        !e.message.includes("private diagnostic"),
    );
    assert.equal(s.posts, 1);
    assert.equal(s.version, BEFORE);
  }));
test("unknown current version and mismatched historical settings block activation", () =>
  fixture(async (s, o) => {
    s.version = "unknown";
    await assert.rejects(run("preflight", o), /baseline/);
    assert.equal(s.posts, 0);
    s.version = BEFORE;
    s.targetDrift = true;
    await assert.rejects(run("preflight", o), /differ/);
    assert.equal(s.posts, 0);
  }));
test("runtime drift after checkpoint and presence of automatic workflow fail closed", () =>
  fixture(async (s, o) => {
    await run("preflight", o);
    s.drift = true;
    await assert.rejects(run("activate", o), /changed/);
    assert.equal(s.posts, 0);
    s.drift = false;
    s.auto = true;
    await assert.rejects(run("activate", o), /GitHub release-safety/);
    assert.equal(s.posts, 0);
  }));

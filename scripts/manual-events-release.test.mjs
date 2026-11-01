import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACCOUNT,
  NAMESPACE,
  safeSettings,
  activeDeployment,
  run,
} from "./manual-events-release.mjs";

const settings = () => ({
  compatibility_date: "2026-10-30",
  compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
  bindings: [
    { type: "assets", name: "ASSETS" },
    {
      type: "durable_object_namespace",
      name: "EVENTS_DATABASE",
      namespace_id: NAMESPACE,
    },
    { type: "secret_text", name: "EVENTS_GATEWAY_SECRET" },
    { type: "plain_text", name: "HOUSEHOLD_ROUTING_ENABLED", text: "true" },
  ],
});
test("reject wrong database, missing assets and enabled SMS", () => {
  const wrong = settings();
  wrong.bindings[1].namespace_id = "other";
  assert.throws(() => safeSettings(wrong), /approved namespace/);
  const missing = settings();
  missing.bindings.shift();
  assert.throws(() => safeSettings(missing), /ASSETS/);
  const sms = settings();
  sms.bindings.push({ type: "plain_text", name: "SMS_ENABLED", text: "true" });
  assert.throws(() => safeSettings(sms), /SMS/);
  assert.throws(
    () =>
      activeDeployment({
        deployments: [{ id: "split", versions: [{ percentage: 50 }] }],
      }),
    /split traffic/,
  );
});
test("missing credential stops before making any request", async () => {
  await assert.rejects(
    run("preflight", {
      env: {},
      fetcher: () => {
        assert.fail("must not fetch");
      },
    }),
    /secret/,
  );
});
test("unauthorized API response stops without exposing body", async () => {
  await assert.rejects(
    run("preflight", {
      env: { CLOUDFLARE_API_TOKEN: "synthetic" },
      fetcher: async () => new Response("private", { status: 401 }),
    }),
    /HTTP 401/,
  );
});
test("checkpoint then verify uses GET only and excludes private settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "events-release-"));
  const file = join(directory, "checkpoint.json");
  let version = "c80d8337-d13c-4763-94d9-9aed825d83ef",
    changed = false,
    badNamespace = false;
  const fetcher = async (url, options = {}) => {
    assert.equal(options.method ?? "GET", "GET");
    if (url.endsWith("/api/setup"))
      return Response.json({ required: false, enabled: false });
    let result;
    if (url.endsWith("/settings")) {
      result = settings();
      result.bindings.push({
        name: "PRIVATE_VARIABLE",
        type: "plain_text",
        text: changed ? "changed-private-value" : "private-value",
      });
    } else if (url.endsWith("/deployments"))
      result = {
        deployments: [
          {
            id: "deployment",
            created_on: "2026-11-01T01:00:00Z",
            versions: [{ version_id: version, percentage: 100 }],
          },
        ],
      };
    else {
      assert.match(
        url,
        new RegExp(`/accounts/${ACCOUNT}/workers/durable_objects/namespaces`),
      );
      result = [
        {
          id: NAMESPACE,
          script: "events",
          class: "EventsDatabase",
          use_sqlite: !badNamespace,
        },
      ];
    }
    return Response.json(
      { success: true, result },
      { headers: { date: "Sun, 01 Nov 2026 04:00:00 GMT" } },
    );
  };
  const options = {
    file,
    fetcher,
    env: { CLOUDFLARE_API_TOKEN: "synthetic-token" },
  };
  try {
    badNamespace = true;
    await assert.rejects(run("preflight", options), /SQLite namespace/);
    badNamespace = false;
    await run("preflight", options);
    const text = await readFile(file, "utf8");
    assert.ok(
      !text.includes("private-value") && !text.includes("synthetic-token"),
    );
    assert.equal(
      JSON.parse(text).recovery.timestamp,
      "2026-11-01T04:00:00.000Z",
    );
    await assert.rejects(run("verify", options), /not active/);
    version = "new";
    changed = true;
    await assert.rejects(run("verify", options), /settings changed/);
    changed = false;
    await run("verify", options);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

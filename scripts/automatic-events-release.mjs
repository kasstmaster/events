import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { activeDeployment, safeSettings } from "./manual-events-release.mjs";

const ACCOUNT = "37d068144865a0b725ee272bc7b2eb71";
const WORKER = "events";
const NAMESPACE = "8203f4cd7fde45d2ab49de62e239d744";
const ORIGIN = "https://events.kassandraraudman.workers.dev";
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${WORKER}`;
const CHECKPOINT = "recovery/events-auto-checkpoint.json";
const fail = (message) => { throw new Error(message); };

async function cloudflare(path, token) {
  const response = await fetch(API + path, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) fail(`Cloudflare read failed (HTTP ${response.status}); no deployment attempted if in preflight.`);
  const body = await response.json();
  if (body.success !== true) fail("Cloudflare rejected a read; response details withheld.");
  return { value: body.result, serverTime: response.headers.get("date") };
}

async function snapshot(token) {
  const settings = safeSettings((await cloudflare("/settings", token)).value);
  const result = await cloudflare("/deployments", token);
  const deployment = activeDeployment(result.value);
  const version = (await cloudflare(`/versions/${deployment.version_id}`, token)).value;
  if (version?.resources?.script_runtime?.migration_tag !== "events-v1") {
    fail("Existing SQLite migration tag differs from events-v1.");
  }
  const setupResponse = await fetch(ORIGIN + "/api/setup", {
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (!setupResponse.ok) fail("Live administrator setup check failed.");
  const setup = await setupResponse.json();
  if (setup.required !== false || setup.enabled !== false) {
    fail("Live administrator setup is not closed.");
  }
  return { settings, deployment, serverTime: result.serverTime };
}

async function validateRelease() {
  const { parse } = await import("jsonc-parser");
  const config = parse(await readFile("wrangler.jsonc", "utf8"));
  if (
    config.name !== WORKER ||
    config.main !== "cloudflare/worker.js" ||
    config.compatibility_date !== "2026-10-30" ||
    config.preview_urls !== false ||
    config.assets?.binding !== "ASSETS" ||
    config.durable_objects?.bindings?.length !== 1 ||
    config.durable_objects.bindings[0].name !== "EVENTS_DATABASE" ||
    config.durable_objects.bindings[0].class_name !== "EventsDatabase" ||
    config.migrations?.length !== 1 ||
    config.migrations[0].tag !== "events-v1" ||
    !config.migrations[0].new_sqlite_classes?.includes("EventsDatabase")
  ) fail("Wrangler configuration differs from the approved Gather production identity or SQLite schema.");
}

export async function runAuto(mode, options = {}) {
  if (!["preflight", "verify"].includes(mode)) fail("Expected preflight or verify.");
  const env = options.env ?? process.env;
  const token = env.CLOUDFLARE_API_TOKEN;
  const release = env.GITHUB_SHA;
  if (!token) fail("Missing GitHub CLOUDFLARE_API_TOKEN secret.");
  if (!/^[0-9a-f]{40}$/.test(release ?? "")) fail("Missing exact merged commit SHA.");
  await validateRelease();
  const current = await snapshot(token);
  if (mode === "preflight") {
    // Store names and SHA256 digests of variables, never token values.
    if (!current.serverTime || !Number.isFinite(Date.parse(current.serverTime))) {
      fail("No trustworthy Cloudflare server timestamp for the recovery checkpoint.");
    }
    const checkpoint = {
      release,
      account: ACCOUNT,
      worker: WORKER,
      namespace_id: NAMESPACE,
      object_name: "events-platform-v1",
      sqlite_migration_tag: "events-v1",
      before: current.deployment,
      settings: current.settings,
      recovery: {
        kind: "sqlite-pitr-timestamp",
        timestamp: new Date(current.serverTime).toISOString(),
        expires_at: new Date(Date.parse(current.serverTime) + 30 * 86400000).toISOString(),
        precision: "approximate timestamp; not an exact SQLite bookmark",
      },
    };
    // Detect changes during preflight so a concurrent dashboard/manual update blocks release.
    const second = await snapshot(token);
    if (JSON.stringify(second.deployment) !== JSON.stringify(current.deployment) ||
        JSON.stringify(second.settings) !== JSON.stringify(current.settings)) {
      fail("Production changed during preflight.");
    }
    await writeFile(options.file ?? CHECKPOINT, JSON.stringify(checkpoint, null, 2) + "\n", { mode: 0o600 });
    console.log("Preflight passed. Existing SQLite binding, runtime settings and recovery timestamp recorded.");
    return;
  }
  const checkpoint = JSON.parse(await readFile(options.file ?? CHECKPOINT, "utf8"));
  if (checkpoint.release !== release || checkpoint.namespace_id !== NAMESPACE || checkpoint.worker !== WORKER) {
    fail("Recovery checkpoint does not match this merge.");
  }
  if (JSON.stringify(current.settings) !== JSON.stringify(checkpoint.settings)) {
    fail("Worker runtime bindings, variables or compatibility settings changed after deployment.");
  }
  if (current.deployment.version_id === checkpoint.before.version_id) {
    fail("A new deployed Worker version was not detected.");
  }
  await writeFile((options.file ?? CHECKPOINT).replace(/\.json$/, "-after.json"),
    JSON.stringify({ release, after: current.deployment, verified_at: new Date().toISOString() }, null, 2) + "\n",
    { mode: 0o600 });
  console.log("New Worker deployed; existing runtime settings, SQLite namespace, and closed setup verified.");
  console.log("Interactive Gather sign-in, RSVP, and editor acceptance checks remain recommended.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAuto(process.argv[2]).catch((error) => {
    console.error(error?.message?.startsWith("Worker runtime") ? error.message : 
      /^(Missing|Expected|Wrangler|Cloudflare|Existing|Live|No trustworthy|Production|Recovery|A new)/.test(error?.message ?? "") ? error.message :
      "Automatic release check failed; transport details withheld.");
    process.exitCode = 1;
  });
}

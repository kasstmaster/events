import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  activeDeployment,
  safeSettings,
  ReleaseCheckError,
} from "./manual-events-release.mjs";

export const APPROVED_APPLICATION_BASE =
  "925c25ad0f89b6deb85838ae36f13d168444b1d0";
// Baseline only: the documented PR #67 upload lost this required flag.
// It never selects the commit/version to deploy or authorizes settings writes.
export const RECOVERABLE_RUNTIME_VERSION =
  "db244c24-b170-4cb9-a171-809462344b1a";
const PUBLIC_FETCH_FLAG = "global_fetch_strictly_public";
const APPROVED_FLAGS = [PUBLIC_FETCH_FLAG, "nodejs_compat"];
const correctionPlan = () => ({
  kind: "restore-required-public-fetch-flag",
  from_version_id: RECOVERABLE_RUNTIME_VERSION,
  flag: PUBLIC_FETCH_FLAG,
});
const ACCOUNT = "37d068144865a0b725ee272bc7b2eb71";
const WORKER = "events";
const NAMESPACE = "8203f4cd7fde45d2ab49de62e239d744";
const OBJECT = "events-platform-v1";
const ORIGIN = "https://events.kassandraraudman.workers.dev";
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${WORKER}`;
const CHECKPOINT = "recovery/events-auto-checkpoint.json";
const OUTPUT = "recovery/events-wrangler-output.jsonl";
const fail = (stage, message, retryable = false) => {
  throw new AutomaticReleaseError(stage, message, retryable);
};
export class AutomaticReleaseError extends Error {
  constructor(stage, message, retryable = false) {
    super(message);
    this.stage = stage;
    this.retryable = retryable;
  }
}
export function safeFailure(error) {
  if (error instanceof AutomaticReleaseError)
    return `Automatic release check failed [${error.stage}]: ${error.message}`;
  if (error instanceof ReleaseCheckError)
    return `Automatic release check failed [live-settings]: ${error.message}`;
  return "Automatic release check failed [unexpected]; private transport details withheld.";
}

// This is an ancestry floor, never the commit selected for deployment. Main was
// historically operations-only. The exact owner-merged commit must include the
// approved application's history before it may replace the production app.
export function validateSource(
  release,
  { root = ".", approvedBase = APPROVED_APPLICATION_BASE } = {},
) {
  if (!/^[0-9a-f]{40}$/.test(release ?? ""))
    fail("source", "Missing exact merged commit SHA.");
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    if (git("rev-parse", "HEAD") !== release)
      fail("source", "Checkout does not match the exact owner-merged commit.");
    if (git("rev-parse", "--is-shallow-repository") !== "false")
      fail(
        "source",
        "Full Git history is required to verify the approved application ancestry.",
      );
    git("merge-base", "--is-ancestor", approvedBase, release);
    try {
      git("diff", "--quiet", release, "--");
    } catch {
      fail(
        "source",
        "Tracked files changed after the owner-merged revision. Stop before production access.",
      );
    }
  } catch (error) {
    if (error instanceof AutomaticReleaseError) throw error;
    fail(
      "source",
      "Main lacks the approved Gather application history. Integrate the approved application through an owner-reviewed PR before automatic deployment.",
    );
  }
}
export function validateProductionRelease(
  currentRelease,
  release,
  { root = "." } = {},
) {
  // Legacy manually pinned versions have no SHA annotation. Source/configuration
  // guards still apply to that transition. Annotated automatic releases must
  // advance production history, even if queued workflows arrive out of order.
  if (!/^[0-9a-f]{40}$/.test(currentRelease ?? "")) return;
  if (currentRelease === release)
    fail(
      "source",
      "This merged commit is already active. Inspect verification instead of republishing it.",
    );
  try {
    execFileSync(
      "git",
      ["merge-base", "--is-ancestor", currentRelease, release],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch {
    fail(
      "source",
      "The merged commit does not include the current production release history. Stop for review instead of overwriting a newer release.",
    );
  }
}
export function validateConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config))
    fail("configuration", "Wrangler configuration is not an object.");
  const bindings = config.durable_objects?.bindings;
  const migrations = config.migrations;
  if (
    config.name !== WORKER ||
    config.account_id !== ACCOUNT ||
    config.main !== "cloudflare/worker.js" ||
    config.compatibility_date !== "2026-10-30" ||
    JSON.stringify([...(config.compatibility_flags || [])].sort()) !==
      JSON.stringify(["global_fetch_strictly_public", "nodejs_compat"]) ||
    config.workers_dev !== true ||
    config.preview_urls !== false ||
    config.keep_vars !== true ||
    config.assets?.directory !== "./public" ||
    config.assets.binding !== "ASSETS" ||
    config.assets.run_worker_first !== true ||
    bindings?.length !== 1 ||
    bindings[0].name !== "EVENTS_DATABASE" ||
    bindings[0].class_name !== "EventsDatabase" ||
    bindings[0].script_name ||
    migrations?.length !== 1 ||
    migrations[0].tag !== "events-v1" ||
    JSON.stringify(migrations[0].new_sqlite_classes) !==
      JSON.stringify(["EventsDatabase"]) ||
    Object.keys(migrations[0]).some(
      (key) => !["tag", "new_sqlite_classes"].includes(key),
    ) ||
    JSON.stringify(config.triggers?.crons) !==
      JSON.stringify(["*/5 * * * *"]) ||
    config.route ||
    config.routes?.length ||
    config.env
  )
    fail(
      "configuration",
      "Wrangler configuration differs from the approved account, runtime flags, cron, bindings or SQLite identity. Do not deploy the older operations-only application.",
    );
}
async function releaseConfig(path) {
  const { parse } = await import("jsonc-parser");
  const errors = [];
  const config = parse(await readFile(path, "utf8"), errors, {
    allowTrailingComma: true,
  });
  if (errors.length)
    fail("configuration", "Wrangler configuration is not valid JSONC.");
  validateConfig(config);
  return config;
}
async function responseJSON(response, stage) {
  try {
    return await response.json();
  } catch {
    fail(
      stage,
      "Response was not valid JSON; private response details withheld.",
    );
  }
}
async function request(fetcher, url, token, stage) {
  let response;
  try {
    response = await fetcher(url, {
      method: "GET",
      redirect: "error",
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    fail(
      stage,
      "Read-only request failed; private transport details withheld.",
      true,
    );
  }
  if (!response.ok)
    fail(
      stage,
      `Read-only request failed (HTTP ${response.status}); no response body logged.`,
      response.status === 429 || response.status >= 500,
    );
  const body = await responseJSON(response, stage);
  if (token && body?.success !== true)
    fail(
      stage,
      "Cloudflare rejected a read; private response details withheld.",
    );
  return {
    value: token ? body.result : body,
    serverTime: response.headers.get("date"),
  };
}
function runtimeSettings(raw, versionId, allowCorrection) {
  if (
    allowCorrection &&
    versionId === RECOVERABLE_RUNTIME_VERSION &&
    raw?.compatibility_date === "2026-10-30" &&
    JSON.stringify(raw.compatibility_flags) ===
      JSON.stringify(["nodejs_compat"])
  ) {
    // Validate every other setting using the unchanged strict validator.
    // Record the real pre-deployment state; only Wrangler may apply the approved flag.
    const approved = safeSettings({
      ...raw,
      compatibility_flags: APPROVED_FLAGS,
    });
    return {
      settings: { ...approved, compatibility_flags: ["nodejs_compat"] },
      runtimeCorrection: correctionPlan(),
    };
  }
  return { settings: safeSettings(raw), runtimeCorrection: null };
}
function expectedCheckpointSettings(checkpoint) {
  if (!Object.hasOwn(checkpoint, "runtime_correction"))
    return checkpoint.settings;
  if (
    JSON.stringify(checkpoint.runtime_correction) !==
      JSON.stringify(correctionPlan()) ||
    checkpoint.before.version_id !== RECOVERABLE_RUNTIME_VERSION ||
    checkpoint.settings.compatibility_date !== "2026-10-30" ||
    JSON.stringify(checkpoint.settings.compatibility_flags) !==
      JSON.stringify(["nodejs_compat"])
  )
    fail(
      "checkpoint",
      "Runtime correction does not match the documented recovery baseline.",
    );
  return { ...checkpoint.settings, compatibility_flags: [...APPROVED_FLAGS] };
}
async function snapshot(token, fetcher, allowCorrection = false) {
  const read = (path, stage) => request(fetcher, API + path, token, stage);
  const rawSettings = (await read("/settings", "live-settings")).value;
  const result = await read("/deployments", "deployment");
  const deployment = activeDeployment(result.value);
  const version = (await read(`/versions/${deployment.version_id}`, "version"))
    .value;
  if (version?.resources?.script_runtime?.migration_tag !== "events-v1")
    fail("sqlite", "Existing SQLite migration tag differs from events-v1.");
  const { settings, runtimeCorrection } = runtimeSettings(
    rawSettings,
    deployment.version_id,
    allowCorrection,
  );
  const schedules = (await read("/schedules", "cron")).value;
  if (!Array.isArray(schedules?.schedules))
    fail("cron", "Existing cron inventory was not returned.");
  const crons = schedules.schedules.map((s) => s.cron).sort();
  const domain = (await read("/subdomain", "workers-dev")).value;
  if (domain?.enabled !== true || domain?.previews_enabled !== false)
    fail(
      "workers-dev",
      "Worker URL or preview settings differ from the approved production settings.",
    );
  const setup = (await request(fetcher, ORIGIN + "/api/setup", null, "setup"))
    .value;
  if (setup.required !== false || setup.enabled !== false)
    fail("setup", "Live administrator setup is not closed.");
  return {
    settings,
    runtimeCorrection,
    deployment,
    version,
    crons,
    serverTime: result.serverTime,
  };
}
async function expectedVersion(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    fail(
      "deployment-output",
      "Wrangler's structured deployment output is missing. Do not rerun deployment to retry verification.",
    );
  }
  if (text.length > 1000000)
    fail(
      "deployment-output",
      "Wrangler deployment output exceeded its bounded size.",
    );
  let records;
  try {
    records = text
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    fail("deployment-output", "Wrangler deployment output is not valid JSONL.");
  }
  const deploys = records.filter((r) => r?.type === "deploy");
  if (
    deploys.length !== 1 ||
    deploys[0].version !== 1 ||
    deploys[0].worker_name !== WORKER ||
    deploys[0].wrangler_environment ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(
      deploys[0].version_id || "",
    )
  )
    fail(
      "deployment-output",
      "Wrangler output does not identify exactly one events production version.",
    );
  return deploys[0].version_id;
}
export async function runAuto(mode, options = {}) {
  if (!["source", "configuration", "preflight", "verify"].includes(mode))
    fail("arguments", "Expected source, configuration, preflight or verify.");
  const env = options.env ?? process.env;
  const release = env.MERGED_SHA ?? env.GITHUB_SHA;
  if (mode === "source") {
    validateSource(release, options);
    return;
  }
  if (!/^[0-9a-f]{40}$/.test(release ?? ""))
    fail("source", "Missing exact merged commit SHA.");
  const config = await releaseConfig(options.configPath ?? "wrangler.jsonc");
  if (mode === "configuration") return;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!token)
    fail("authentication", "Missing GitHub CLOUDFLARE_API_TOKEN secret.");
  const file = options.file ?? CHECKPOINT;
  const fetcher = options.fetcher ?? fetch;
  if (mode === "preflight") {
    const current = await snapshot(token, fetcher, true);
    validateProductionRelease(
      current.version.annotations?.["workers/message"],
      release,
      options,
    );
    if (
      JSON.stringify(current.crons) !==
      JSON.stringify([...config.triggers.crons].sort())
    )
      fail(
        "cron",
        "Live cron differs from the reviewed configuration. Inspect before publishing.",
      );
    if (!current.serverTime || !Number.isFinite(Date.parse(current.serverTime)))
      fail(
        "recovery",
        "No trustworthy Cloudflare server timestamp for the recovery checkpoint.",
      );
    const second = await snapshot(token, fetcher, true);
    if (
      JSON.stringify(second.deployment) !==
        JSON.stringify(current.deployment) ||
      JSON.stringify(second.settings) !== JSON.stringify(current.settings) ||
      JSON.stringify(second.crons) !== JSON.stringify(current.crons) ||
      JSON.stringify(second.runtimeCorrection) !==
        JSON.stringify(current.runtimeCorrection)
    )
      fail("preflight", "Production changed during preflight.");
    const checkpoint = {
      release,
      account: ACCOUNT,
      worker: WORKER,
      namespace_id: NAMESPACE,
      object_name: OBJECT,
      sqlite_migration_tag: "events-v1",
      before: current.deployment,
      settings: current.settings,
      ...(current.runtimeCorrection
        ? { runtime_correction: current.runtimeCorrection }
        : {}),
      crons: current.crons,
      recovery: {
        kind: "sqlite-pitr-timestamp",
        timestamp: new Date(current.serverTime).toISOString(),
        expires_at: new Date(
          Date.parse(current.serverTime) + 30 * 86400000,
        ).toISOString(),
        precision: "approximate timestamp; not an exact SQLite bookmark",
      },
    };
    await writeFile(file, JSON.stringify(checkpoint, null, 2) + "\n", {
      mode: 0o600,
    });
    console.log(
      current.runtimeCorrection
        ? "Preflight passed. Known lost-flag baseline and recovery checkpoint recorded; the reviewed deployment must restore only the required public-fetch flag."
        : "Preflight passed. Runtime settings, cron, SQLite binding and recovery timestamp recorded.",
    );
    return;
  }
  let checkpoint;
  try {
    checkpoint = JSON.parse(await readFile(file, "utf8"));
  } catch {
    fail(
      "checkpoint",
      "Recovery checkpoint is missing or malformed; no private file details logged.",
    );
  }
  if (
    !checkpoint ||
    !checkpoint.before?.version_id ||
    !Array.isArray(checkpoint.settings?.bindings) ||
    checkpoint.release !== release ||
    checkpoint.account !== ACCOUNT ||
    checkpoint.namespace_id !== NAMESPACE ||
    checkpoint.worker !== WORKER ||
    checkpoint.object_name !== OBJECT ||
    checkpoint.sqlite_migration_tag !== "events-v1" ||
    !Array.isArray(checkpoint.crons)
  )
    fail(
      "checkpoint",
      "Recovery checkpoint does not match this merge and production identity.",
    );
  const expectedSettings = expectedCheckpointSettings(checkpoint);
  const deployedVersion = await expectedVersion(options.outputFile ?? OUTPUT);
  const wait =
    options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const current = await snapshot(token, fetcher);
      if (JSON.stringify(current.settings) !== JSON.stringify(expectedSettings))
        fail(
          "live-settings",
          "Worker runtime bindings, variables or compatibility settings changed after deployment.",
        );
      if (JSON.stringify(current.crons) !== JSON.stringify(checkpoint.crons))
        fail("cron", "Cron settings changed after deployment.");
      if (current.deployment.version_id !== deployedVersion)
        fail(
          "version",
          "The version emitted by Wrangler is not yet active at 100% traffic.",
          true,
        );
      if (deployedVersion === checkpoint.before.version_id)
        fail("version", "Wrangler did not publish a new Worker version.");
      if (current.version.annotations?.["workers/message"] !== release)
        fail(
          "release",
          "Active Worker version does not identify the exact owner-merged commit.",
        );
      await writeFile(
        file.replace(/\.json$/, "-after.json"),
        JSON.stringify(
          {
            release,
            ...(checkpoint.runtime_correction
              ? { runtime_correction: checkpoint.runtime_correction }
              : {}),
            after: current.deployment,
            verified_at: new Date().toISOString(),
            crons: current.crons,
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );
      console.log(
        checkpoint.runtime_correction
          ? "Exact merged Worker version active; required public-fetch flag restored; other runtime settings, cron, SQLite namespace and closed setup verified."
          : "Exact merged Worker version active; runtime settings, cron, SQLite namespace and closed setup verified.",
      );
      return;
    } catch (error) {
      if (
        !(error instanceof AutomaticReleaseError) ||
        !error.retryable ||
        attempt === 3
      )
        throw error;
      await wait(2000);
    }
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runAuto(process.argv[2]).catch((error) => {
    console.error(safeFailure(error));
    process.exitCode = 1;
  });
}

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import {
  safeSettings,
  activeDeployment,
  settingsChanges,
} from "./manual-events-release.mjs";
export const ACCOUNT = "37d068144865a0b725ee272bc7b2eb71";
export const GOOD = "2445780c-00a8-4be8-be81-64e450420038";
export const BEFORE = "466edc14-ed97-42b1-9759-0bcbb571ecd4";
export const APPLICATION = "925c25ad0f89b6deb85838ae36f13d168444b1d0";
export const MAIN = "ca8f74cde96b7f5a91555ba77e9a1ab240cf2b63";
const SCRIPT = `/accounts/${ACCOUNT}/workers/scripts/events`;
const ORIGIN = "https://events.kassandraraudman.workers.dev";
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class RecoveryError extends Error {}
const requireValue = (condition, message) => {
  if (!condition) throw new RecoveryError(message);
};
export async function run(
  mode,
  { fetcher = fetch, env = process.env, directory = "recovery" } = {},
) {
  requireValue(
    ["preflight", "activate", "verify"].includes(mode),
    "Invalid recovery operation.",
  );
  requireValue(
    env.CLOUDFLARE_API_TOKEN && env.ACTIONS_GITHUB_TOKEN,
    "Existing recovery credentials are unavailable.",
  );
  let serverTime;
  async function cf(path, body) {
    let r;
    try {
      r = await fetcher(`https://api.cloudflare.com/client/v4${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new RecoveryError(
        body
          ? "Rollback request transport failed; outcome uncertain. Inspect active version before any further action."
          : "Cloudflare inventory transport failed.",
      );
    }
    let j;
    try {
      j = await r.json();
    } catch {
      throw new RecoveryError(
        "Cloudflare response could not be safely parsed.",
      );
    }
    const codes = (j?.errors || []).map((e) => e.code).filter(Number.isInteger);
    requireValue(
      r.ok && j.success === true,
      `Cloudflare ${body ? "rollback" : "inventory"} failed: HTTP ${r.status}; codes ${codes.join(",") || "none"}. No force or retry is permitted.`,
    );
    if (
      r.headers.get("date") &&
      Number.isFinite(Date.parse(r.headers.get("date")))
    )
      serverTime = new Date(r.headers.get("date")).toISOString();
    return j.result;
  }
  async function github(path, expected = 200) {
    let r;
    try {
      r = await fetcher(
        `https://api.github.com/repos/kasstmaster/events${path}`,
        {
          headers: {
            Authorization: `Bearer ${env.ACTIONS_GITHUB_TOKEN}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          redirect: "error",
          signal: AbortSignal.timeout(20000),
        },
      );
    } catch {
      throw new RecoveryError("GitHub release-safety read failed.");
    }
    requireValue(
      r.status === expected,
      `GitHub release-safety read failed: HTTP ${r.status}.`,
    );
    return expected === 404 ? null : r.json();
  }
  async function releaseSafety() {
    const main = await github("/git/ref/heads/main");
    requireValue(
      main.object?.sha === MAIN,
      "Main changed since recovery was reviewed.",
    );
    await github(
      "/contents/.github/workflows/deploy-events-auto.yml?ref=main",
      404,
    );
    const runs = await github("/actions/runs?per_page=100");
    requireValue(
      Array.isArray(runs.workflow_runs),
      "Release run inventory missing.",
    );
    requireValue(
      !runs.workflow_runs.some(
        (r) =>
          r.status !== "completed" &&
          (r.name === "Deploy Gather after PR merge" ||
            r.name === "Deploy events manually"),
      ),
      "Another production release is active.",
    );
  }
  async function snapshot() {
    const raw = await cf(`${SCRIPT}/settings`);
    const settings = safeSettings(raw);
    const deployment = activeDeployment(await cf(`${SCRIPT}/deployments`));
    const version = await cf(`${SCRIPT}/versions/${deployment.version_id}`);
    requireValue(
      version.resources?.script_runtime?.migration_tag === "events-v1",
      "Current SQLite migration lineage changed.",
    );
    const schedule = await cf(`${SCRIPT}/schedules`);
    const schedules = schedule.schedules?.map((s) => s.cron).sort();
    requireValue(
      JSON.stringify(schedules) === JSON.stringify(["*/5 * * * *"]),
      "Existing cron differs from reviewed production.",
    );
    const subdomain = await cf(`${SCRIPT}/subdomain`);
    requireValue(
      subdomain.enabled === true && subdomain.previews_enabled === false,
      "Worker URL/preview safety differs.",
    );
    const service = await cf(`/accounts/${ACCOUNT}/workers/services/events`);
    const environment = service.default_environment?.environment;
    requireValue(
      typeof environment === "string" &&
        /^[a-zA-Z0-9_-]{1,64}$/.test(environment),
      "Service environment is unavailable.",
    );
    const routes = await cf(
      `/accounts/${ACCOUNT}/workers/services/events/environments/${environment}/routes?show_zonename=true`,
    );
    let response;
    try {
      response = await fetcher(`${ORIGIN}/api/setup`, {
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new RecoveryError("Live setup read failed.");
    }
    const setup = await response.json();
    requireValue(
      response.ok && setup.required === false && setup.enabled === false,
      "Production setup is not closed.",
    );
    return {
      deployment,
      settings,
      schedules,
      subdomain: {
        enabled: subdomain.enabled,
        previews_enabled: subdomain.previews_enabled,
      },
      environment,
      routes_digest: digest(routes),
      setup_closed: true,
    };
  }
  await releaseSafety();
  const current = await snapshot();
  if (mode === "preflight") {
    requireValue(
      current.deployment.version_id === BEFORE,
      "Current Worker differs from reviewed recovery baseline.",
    );
    const version = await cf(`${SCRIPT}/versions/${GOOD}`);
    requireValue(
      version.id === GOOD &&
        version.resources?.script_runtime?.migration_tag === "events-v1",
      "Original approved Worker or SQLite lineage could not be established.",
    );
    const targetSettings = safeSettings({
      ...version.resources.script_runtime,
      bindings: version.resources.bindings,
    });
    requireValue(
      settingsChanges(targetSettings, current.settings).length === 0,
      "Original Worker runtime/bindings/variables differ; rollback stopped.",
    );
    requireValue(
      digest(await snapshot()) === digest(current),
      "Production changed during recovery preflight.",
    );
    requireValue(serverTime, "Recovery timestamp is unavailable.");
    const checkpoint = {
      account: ACCOUNT,
      worker: "events",
      approved_application: APPLICATION,
      approved_version: GOOD,
      repository_recovery: MAIN,
      namespace: "8203f4cd7fde45d2ab49de62e239d744",
      class: "EventsDatabase",
      object: "events-platform-v1",
      migration_tag: "events-v1",
      before: current,
      target_settings: targetSettings,
      recovery: {
        kind: "approximate SQLite PITR timestamp; not an exact bookmark or exported backup",
        timestamp: serverTime,
        nominal_expires_at: new Date(
          Date.parse(serverTime) + 30 * 86400000,
        ).toISOString(),
      },
      build_controls:
        "Owner confirmed Cloudflare builds and GitHub automatic workflow disabled; automatic workflow removed from main.",
      secret_safety:
        "Activation uses Cloudflare deployment API WITHOUT force; changed-secret rejection 10220 must stop. No secret writes.",
      production_changed: false,
    };
    await mkdir(directory, { recursive: true });
    await writeFile(
      `${directory}/checkpoint.json`,
      JSON.stringify(checkpoint, null, 2) + "\n",
      { mode: 0o600 },
    );
    console.log(
      "Recovery preflight passed; stable current version, original bundle, SQLite namespace, runtime settings and closed setup verified.",
    );
    return checkpoint;
  }
  const checkpoint = JSON.parse(
    await readFile(`${directory}/checkpoint.json`, "utf8"),
  );
  requireValue(
    checkpoint.account === ACCOUNT &&
      checkpoint.approved_version === GOOD &&
      checkpoint.approved_application === APPLICATION &&
      checkpoint.repository_recovery === MAIN &&
      checkpoint.before?.deployment?.version_id === BEFORE,
    "Checkpoint does not match the reviewed recovery.",
  );
  requireValue(
    Math.abs(Date.now() - Date.parse(checkpoint.recovery.timestamp)) <
      15 * 60000,
    "Recovery checkpoint is stale.",
  );
  if (mode === "activate") {
    requireValue(
      digest(checkpoint.before) === digest(current),
      "Production changed after checkpoint upload.",
    );
    await cf(`${SCRIPT}/deployments`, {
      strategy: "percentage",
      versions: [{ version_id: GOOD, percentage: 100 }],
      annotations: {
        "workers/message":
          "Owner-approved recovery: original PR65 application 925c25ad; preserve all data and secrets",
      },
    });
    await writeFile(
      `${directory}/activation.json`,
      JSON.stringify(
        {
          requested_version: GOOD,
          force: false,
          database_restore: false,
          credentials_changed: false,
        },
        null,
        2,
      ) + "\n",
    );
    console.log("Original approved Worker activation accepted without force.");
    return;
  }
  requireValue(
    current.deployment.version_id === GOOD,
    "Approved Worker is not active at 100 percent.",
  );
  const { deployment: oldDeployment, ...before } = checkpoint.before;
  const { deployment: newDeployment, ...after } = current;
  requireValue(
    digest(before) === digest(after),
    "Post-rollback runtime/binding/routes/cron/setup preservation failed.",
  );
  await writeFile(
    `${directory}/verification.json`,
    JSON.stringify(
      {
        approved_application: APPLICATION,
        active_version: GOOD,
        checked_at: serverTime,
        preserved: after,
        database_restore: false,
        migrations_changed: false,
        secret_force: false,
        authenticated_flows:
          "Unverified; requires existing authorized sessions, no live fixtures.",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "Verified: original Worker active at 100 percent; database namespace, bindings, variable fingerprints, flags, routes, cron, disabled previews and closed setup preserved.",
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await run(process.argv[2]);
  } catch (e) {
    console.error(
      e instanceof RecoveryError
        ? e.message
        : "Recovery stopped; raw diagnostics suppressed.",
    );
    process.exitCode = 1;
  }
}

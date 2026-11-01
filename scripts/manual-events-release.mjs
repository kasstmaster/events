import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const ACCOUNT = "37d068144865a0b725ee272bc7b2eb71";
export const NAMESPACE = "8203f4cd7fde45d2ab49de62e239d744";
export const RELEASE = "5c024bf79727d79894a21184cdaa248e595f66b2";
const ORIGIN = "https://events.kassandraraudman.workers.dev";
const SCRIPT = `/accounts/${ACCOUNT}/workers/scripts/events`;
const REQUIRED_FLAGS = ["nodejs_compat", "global_fetch_strictly_public"];
const EXPECTED_PREVIOUS_VERSION = "c80d8337-d13c-4763-94d9-9aed825d83ef";
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
class ReleaseCheckError extends Error {}
function requireValue(condition, message) {
  if (!condition) throw new ReleaseCheckError(message);
}

// Never serialize raw API responses: settings may include private variable values.
export function safeSettings(settings) {
  const bindings = settings.bindings;
  requireValue(Array.isArray(bindings), "Worker bindings were not returned.");
  const database = bindings.find(
    (binding) => binding.name === "EVENTS_DATABASE",
  );
  requireValue(
    database?.type === "durable_object_namespace" &&
      database.namespace_id === NAMESPACE &&
      database.class_name === "EventsDatabase" &&
      (!database.script_name || database.script_name === "events"),
    "Existing EVENTS_DATABASE binding does not match the approved namespace.",
  );
  requireValue(
    bindings.some(
      (binding) => binding.name === "ASSETS" && binding.type === "assets",
    ),
    "Existing ASSETS binding is missing.",
  );
  const sms = bindings.find((binding) => binding.name === "SMS_ENABLED");
  requireValue(
    !sms || (sms.type === "plain_text" && sms.text === "false"),
    "SMS must remain disabled.",
  );
  requireValue(
    settings.compatibility_date === "2026-10-30" &&
      REQUIRED_FLAGS.every((flag) =>
        settings.compatibility_flags?.includes(flag),
      ),
    "Runtime date/flags differ from the approved release.",
  );
  return {
    compatibility_date: settings.compatibility_date,
    compatibility_flags: [...settings.compatibility_flags].sort(),
    bindings: bindings
      .map((binding) => ({
        name: binding.name,
        type: binding.type,
        ...(binding.type === "durable_object_namespace"
          ? { namespace_id: binding.namespace_id }
          : {}),
        ...(binding.type === "plain_text"
          ? { value_digest: digest(binding.text) }
          : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function activeDeployment(result) {
  const deployments = result?.deployments;
  requireValue(
    Array.isArray(deployments) && deployments.length,
    "No current deployment was returned.",
  );
  const latest = [...deployments].sort(
    (a, b) => Date.parse(b.created_on) - Date.parse(a.created_on),
  )[0];
  requireValue(
    latest.id &&
      latest.versions?.length === 1 &&
      latest.versions[0].percentage === 100 &&
      latest.versions[0].version_id,
    "Current deployment is missing or has split traffic.",
  );
  return { id: latest.id, version_id: latest.versions[0].version_id };
}

export async function run(
  mode,
  {
    fetcher = fetch,
    env = process.env,
    file = "recovery/events-checkpoint.json",
  } = {},
) {
  requireValue(
    ["preflight", "verify"].includes(mode),
    "Expected preflight or verify.",
  );
  requireValue(
    env.CLOUDFLARE_API_TOKEN,
    "GitHub secret CLOUDFLARE_API_TOKEN is missing; deployment was not attempted.",
  );
  let serverTime;
  async function api(path) {
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4${path}`,
      {
        headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
        signal: AbortSignal.timeout(20000),
      },
    );
    requireValue(
      response.ok,
      `Cloudflare read failed (HTTP ${response.status}); check the existing GitHub deployment secret and account permissions.`,
    );
    const value = await response.json();
    requireValue(
      value.success === true,
      "Cloudflare rejected a preflight read; no response details were logged.",
    );
    const date = response.headers.get("date");
    if (date && Number.isFinite(Date.parse(date)))
      serverTime = new Date(date).toISOString();
    return value.result;
  }
  async function setupClosed() {
    const response = await fetcher(`${ORIGIN}/api/setup`, {
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    requireValue(response.ok, "Public setup check failed.");
    const setup = await response.json();
    requireValue(
      setup.required === false && setup.enabled === false,
      "Administrator setup is not closed.",
    );
  }
  const settings = safeSettings(await api(`${SCRIPT}/settings`));
  const deployment = activeDeployment(await api(`${SCRIPT}/deployments`));
  const version = await api(`${SCRIPT}/versions/${deployment.version_id}`);
  requireValue(
    version?.resources?.script_runtime?.migration_tag === "events-v1",
    "The existing SQLite migration record changed; stop for review.",
  );
  await setupClosed();
  if (mode === "preflight") {
    requireValue(
      deployment.version_id === EXPECTED_PREVIOUS_VERSION,
      "Production changed since this release was reviewed. Stop for a fresh release review.",
    );
    // The reviewed production version and exact namespace above identify the
    // previously verified SQLite object. Its events-v1 migration created
    // EventsDatabase via new_sqlite_classes; storage type is immutable.
    // Do not list account-wide namespaces or expand this per-Worker token.
    // The server's clock anchors timestamp-based whole-object PITR; no fabricated bookmark.
    const finalDeployment = activeDeployment(
      await api(`${SCRIPT}/deployments`),
    );
    requireValue(
      JSON.stringify(finalDeployment) === JSON.stringify(deployment),
      "Production changed during preflight; deployment was not attempted.",
    );
    requireValue(
      serverTime,
      "Cloudflare server time was unavailable; no recovery checkpoint recorded.",
    );
    const checkpoint = {
      release: RELEASE,
      account: ACCOUNT,
      worker: "events",
      namespace_id: NAMESPACE,
      object_name: "events-platform-v1",
      sqlite_evidence: {
        reviewed_version: EXPECTED_PREVIOUS_VERSION,
        migration_tag: "events-v1",
        class_name: "EventsDatabase",
        basis: "previously verified SQLite namespace; immutable storage backend",
      },
      before: deployment,
      settings,
      recovery: {
        kind: "sqlite-pitr-timestamp",
        timestamp: serverTime,
        expires_at: new Date(
          Date.parse(serverTime) + 30 * 86400000,
        ).toISOString(),
        precision:
          "getBookmarkForTime resolves an approximate timestamp, not an exact captured bookmark",
        docs: "https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api",
      },
    };
    await writeFile(file, JSON.stringify(checkpoint, null, 2) + "\n", {
      mode: 0o600,
    });
    console.log(
      "Authentication, existing bindings, SQLite recovery support and closed setup verified. Recovery timestamp recorded.",
    );
  } else {
    const checkpoint = JSON.parse(await readFile(file, "utf8"));
    requireValue(
      checkpoint.release === RELEASE && checkpoint.namespace_id === NAMESPACE,
      "Checkpoint does not match the approved release.",
    );
    requireValue(
      JSON.stringify(settings) === JSON.stringify(checkpoint.settings),
      "Runtime bindings, variables or compatibility settings changed. Inspect before any rollback.",
    );
    requireValue(
      deployment.version_id !== checkpoint.before.version_id,
      "The expected new deployment is not active.",
    );
    await writeFile(
      file.replace(/\.json$/, "-after.json"),
      JSON.stringify(
        {
          release: RELEASE,
          after: deployment,
          verified_at: new Date().toISOString(),
        },
        null,
        2,
      ) + "\n",
    );
    console.log(
      "New deployment active; setup remains closed and runtime bindings/settings preserved. Interactive sign-in, RSVP and editor checks remain manual.",
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run(process.argv[2]).catch((error) => {
    // Our validation errors are fixed text; transport errors must not leak request details.
    console.error(
      error instanceof ReleaseCheckError
        ? error.message
        : "Release check failed; no transport details logged.",
    );
    process.exitCode = 1;
  });
}

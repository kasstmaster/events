import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ACCOUNT,
  NAMESPACE,
  fingerprint,
  runtimeOverlay,
  runtimeSettingsFingerprint,
} from "./automatic-events-release.mjs";
import { safeSettings, activeDeployment } from "./manual-events-release.mjs";

export const ACTIVE = "6ad2eca8-f6fe-44e0-8683-a448a613d4ab";
export const BASE = "b43cd66d-43de-44a5-bdb2-f62c4c2ba371";
export const COMMIT = "39bf57fd6b3f1a3e11176d1aeadbbdc31aa31138";
export const MAIN = "c5e402a9fc5ce3803830aebf9526a59f1a28f789";
export const RECEIPT_HASH =
  "63a8f799a09320c77f8cca31ee41eab4c4f6c979ae5ca12f0a250acd5bae9dd0";
const SCRIPT = `/accounts/${ACCOUNT}/workers/scripts/events`;
const MODULES = `/accounts/${ACCOUNT}/workers/workers/events/versions/`;
const ORIGINS = [
  "https://events.kassandraraudman.workers.dev",
  "https://name.ilymmd.com",
];
export const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
export class DiagnosticError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const need = (condition, code) => {
  if (!condition) throw new DiagnosticError(code);
};

export { moduleIdentity } from "./application-provenance.mjs";
import {
  moduleIdentity,
  approvedManifest,
  historicalAssets,
  verifyAssetBytes,
  assetRouting,
  ProvenanceError,
} from "./application-provenance.mjs";

export function compareApplication(previous, active) {
  const before = moduleIdentity(previous, BASE),
    after = moduleIdentity(active, ACTIVE);
  need(before.fingerprint === after.fingerprint, "APPLICATION_CODE_MISMATCH");
  return { code_sha256: before.fingerprint, module_count: before.count };
}

export function checkConfiguration(raw, receipt) {
  const normalized = safeSettings(raw);
  runtimeOverlay(raw); // Reject unsupported settings/binding schemas.
  const expected = new Map([
    ["FIREBASE_PROJECT_ID", (v) => v === "gather-58a79"],
    ["FIREBASE_AUTH_DOMAIN", (v) => v === "gather-58a79.firebaseapp.com"],
    [
      "FIREBASE_API_KEY",
      (v) => typeof v === "string" && /^AIza[A-Za-z0-9_-]{35}$/.test(v),
    ],
    ["FIREBASE_AUTH_ENABLED", (v) => v === "false"],
    ["FIREBASE_ACTIVATION_APPROVED", (v) => v === "false"],
  ]);
  need(
    new Set(raw.bindings.map((b) => b.name)).size === raw.bindings.length,
    "DUPLICATE_BINDING",
  );
  for (const [name, check] of expected) {
    const binding = raw.bindings.find((b) => b.name === name);
    need(
      binding?.type === "plain_text" && check(binding.text),
      "FIREBASE_CONFIGURATION_NOT_APPROVED",
    );
  }
  const restored = {
    ...raw,
    bindings: raw.bindings.filter((b) => !expected.has(b.name)),
  };
  need(
    fingerprint(safeSettings(restored)) ===
      fingerprint(receipt.preserved.settings),
    "BASELINE_BINDINGS_MISMATCH",
  );
  need(
    runtimeSettingsFingerprint(restored) === receipt.preserved.runtime_digest,
    "BASELINE_RUNTIME_MISMATCH",
  );
  return {
    settings_sha256: runtimeSettingsFingerprint(raw),
    bindings_sha256: fingerprint(normalized.bindings),
    firebase_disabled: true,
  };
}

export function validateReceipt(bytes) {
  need(sha(bytes) === RECEIPT_HASH, "TRUSTED_RECEIPT_BYTES_MISMATCH");
  const receipt = JSON.parse(bytes.toString("utf8"));
  need(
    receipt.release === COMMIT &&
      receipt.version_id === BASE &&
      receipt.preserved?.settings,
    "TRUSTED_RECEIPT_IDENTITY_MISMATCH",
  );
  return receipt;
}

export async function diagnose({
  env = process.env,
  fetcher = fetch,
  receipt,
  manifest,
  log = console.log,
} = {}) {
  const safe = {
    schema: 1,
    status: "blocked",
    purpose: "diagnostic-only-not-release-authorization",
    worker: "events",
    account: ACCOUNT,
    active_version: ACTIVE,
    baseline_version: BASE,
    baseline_commit: COMMIT,
    approved_main: MAIN,
    namespace: NAMESPACE,
    checks: [],
  };
  const pass = (check) => {
    safe.checks.push(check);
    log(`PASS ${check}`);
  };
  // Closed set of GET targets. No caller URLs, redirects, provider writes or raw diagnostics.
  async function get(path) {
    let response;
    try {
      response = await fetcher("https://api.cloudflare.com/client/v4" + path, {
        method: "GET",
        headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new DiagnosticError("CLOUDFLARE_TRANSPORT_UNAVAILABLE");
    }
    need(response.ok, "CLOUDFLARE_READ_REJECTED");
    const body = await response.text();
    need(Buffer.byteLength(body) <= 40000000, "PROVIDER_RESPONSE_TOO_LARGE");
    let value;
    try {
      value = JSON.parse(body);
    } catch {
      throw new DiagnosticError("PROVIDER_RESPONSE_INVALID");
    }
    need(value.success === true && value.result, "PROVIDER_READ_FAILED");
    return value.result;
  }
  try {
    need(
      env.CLOUDFLARE_API_TOKEN &&
        receipt?.release === COMMIT &&
        receipt.version_id === BASE,
      "TRUSTED_CONTEXT_REQUIRED",
    );
    const baseline = await get(`${SCRIPT}/versions/${BASE}`);
    need(
      baseline.id === BASE &&
        baseline.annotations?.["workers/message"] === COMMIT,
      "BASELINE_RELEASE_ANNOTATION_MISMATCH",
    );
    pass("trusted-baseline-annotation");
    const deploymentBefore = activeDeployment(
      await get(`${SCRIPT}/deployments`),
    );
    need(deploymentBefore.version_id === ACTIVE, "ACTIVE_VERSION_CHANGED");
    need(
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(
        deploymentBefore.id,
      ),
      "DEPLOYMENT_ID_INVALID",
    );
    safe.deployment_id = deploymentBefore.id;
    pass("single-active-version");
    const current = await get(`${SCRIPT}/versions/${ACTIVE}`);
    need(
      current.id === ACTIVE &&
        [baseline, current].every(
          (v) => v.resources?.script_runtime?.migration_tag === "events-v1",
        ),
      "MIGRATION_LINEAGE_MISMATCH",
    );
    pass("sqlite-migration-lineage");
    const previousModules = await get(`${MODULES}${BASE}?include=modules`);
    const currentModules = await get(`${MODULES}${ACTIVE}?include=modules`);
    Object.assign(safe, compareApplication(previousModules, currentModules));
    pass("actual-module-bytes");
    safe.historical_asset_manifest_sha256 = historicalAssets(receipt, manifest);
    safe.historical_asset_count = Object.keys(manifest).length;
    pass("historical-complete-manifest");
    need(
      assetRouting(previousModules) === assetRouting(currentModules),
      "ASSET_ROUTING_CONFIGURATION_MISMATCH",
    );
    pass("worker-first-asset-routing");
    const settingsBefore = await get(`${SCRIPT}/settings`);
    Object.assign(safe, checkConfiguration(settingsBefore, receipt));
    pass("bindings-runtime-and-disabled-firebase");
    const schedules = await get(`${SCRIPT}/schedules`);
    need(
      fingerprint(schedules.schedules?.map((s) => s.cron).sort()) ===
        fingerprint(receipt.preserved.crons),
      "CRON_MISMATCH",
    );
    const subdomain = await get(`${SCRIPT}/subdomain`);
    need(
      subdomain.enabled === true && subdomain.previews_enabled === false,
      "PREVIEW_CONFIGURATION_MISMATCH",
    );
    const service = await get(`/accounts/${ACCOUNT}/workers/services/events`);
    const environment = service.default_environment?.environment;
    need(
      environment === receipt.preserved.environment &&
        environment === "production",
      "SERVICE_ENVIRONMENT_MISMATCH",
    );
    const routes = await get(
      `/accounts/${ACCOUNT}/workers/services/events/environments/${environment}/routes?show_zonename=true`,
    );
    const domains = await get(
      `/accounts/${ACCOUNT}/workers/domains/records?page=0&per_page=100&service=events&environment=${environment}`,
    );
    const records = Array.isArray(domains) ? domains : domains?.records;
    need(
      Array.isArray(records) &&
        records.length < 100 &&
        (domains.total_count ?? records.length) <= records.length,
      "INCOMPLETE_DOMAIN_INVENTORY",
    );
    need(
      fingerprint(routes) === receipt.preserved.routes_digest &&
        fingerprint(domains) === receipt.preserved.domains_digest,
      "ROUTING_MISMATCH",
    );
    Object.assign(safe, {
      routes_sha256: fingerprint(routes),
      domains_sha256: fingerprint(domains),
      cron_sha256: fingerprint(receipt.preserved.crons),
    });
    pass("routes-cron-service-and-previews");
    await verifyAssetBytes(manifest, fetcher);
    safe.asset_manifest_sha256 = fingerprint(manifest);
    safe.asset_count = Object.keys(manifest).length;
    safe.asset_evidence =
      "historical-verification-receipt-and-complete-live-byte-comparison";
    pass("all-reviewed-public-asset-bytes");
    need(
      fingerprint(activeDeployment(await get(`${SCRIPT}/deployments`))) ===
        fingerprint(deploymentBefore),
      "DEPLOYMENT_CHANGED_DURING_READ",
    );
    need(
      runtimeSettingsFingerprint(await get(`${SCRIPT}/settings`)) ===
        safe.settings_sha256,
      "SETTINGS_CHANGED_DURING_READ",
    );
    pass("stable-inventory");
    safe.status = "verified-diagnostic-only";
  } catch (error) {
    safe.blocker =
      error instanceof DiagnosticError || error instanceof ProvenanceError
        ? error.code
        : "UNSUPPORTED_OR_UNREADABLE_EVIDENCE";
    log(`STOP ${safe.blocker}`);
  }
  return safe;
}

export async function main() {
  let report;
  try {
    const receipt = validateReceipt(
      await readFile(
        resolve(
          process.env.RUNNER_TEMP,
          "gather-provenance-anchor/events-verification.json",
        ),
      ),
    );
    const git = (...args) =>
      execFileSync("git", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git("merge-base", "--is-ancestor", COMMIT, MAIN);
    git("merge-base", "--is-ancestor", MAIN, "HEAD");
    const manifest = approvedManifest(COMMIT);
    report = await diagnose({ receipt, manifest });
  } catch (error) {
    report = {
      schema: 1,
      status: "blocked",
      blocker:
        error instanceof DiagnosticError
          ? error.code
          : "TRUSTED_INPUT_UNAVAILABLE",
    };
    console.log(`STOP ${report.blocker}`);
  }
  await writeFile(
    "production-provenance-report.json",
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  if (report.status !== "verified-diagnostic-only") process.exitCode = 1;
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  main().catch(() => {
    console.error("STOP REPORT_UNAVAILABLE");
    process.exitCode = 1;
  });

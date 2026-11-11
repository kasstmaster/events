import { readFile, writeFile, appendFile, mkdtemp, rm } from "node:fs/promises";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { safeSettings } from "./manual-events-release.mjs";
export const ACCOUNT = "37d068144865a0b725ee272bc7b2eb71";
export const NAMESPACE = "8203f4cd7fde45d2ab49de62e239d744";
export const INTEGRATION = "562ca263097e79fa8026d6427a21ebedfe8deae1";
export const INITIAL_VERSION = "2445780c-00a8-4be8-be81-64e450420038";
const ORIGIN = "https://events.kassandraraudman.workers.dev";
const SCRIPT = `/accounts/${ACCOUNT}/workers/scripts/events`;
const STORAGE_ADAPTER_SHA256 =
  "fa6bcfe06763f4981c1362d472a2e1b241f81fb98589a8f2028fa98e16c8c5e1";
const CONFIGURATION_SHA256 =
  "c82817e99b91122bfeb344a44bcb24ec1608ff75f38dd3566046954a6483ad88";
const POLICY = ".github/release/approved-application.json";
const CHECKPOINT = "recovery/events-checkpoint.json";
const RECEIPT = "recovery/events-deployment.json";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, stable(value[k])]),
        )
      : value;
export const fingerprint = (value) => sha(JSON.stringify(stable(value)));
export class ReleaseError extends Error {
  constructor(stage, message) {
    super(message);
    this.stage = stage;
  }
}
const must = (condition, stage, message) => {
  if (!condition) throw new ReleaseError(stage, message);
};
const git = (root, ...args) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const isSHA = (value) => /^[0-9a-f]{40}$/.test(value || "");
export async function appearanceManifest(root = ".") {
  const paths = git(root, "ls-files", "public")
    .split("\n")
    .filter(Boolean)
    .sort();
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (p) => [p, sha(await readFile(resolve(root, p)))]),
    ),
  );
}
export async function validateSource(
  release,
  { root = ".", floor = INTEGRATION } = {},
) {
  must(isSHA(release), "source", "Exact merged SHA is required.");
  try {
    must(
      git(root, "rev-parse", "HEAD") === release,
      "source",
      "Checkout is not the exact merged commit.",
    );
    must(
      git(root, "rev-parse", "--is-shallow-repository") === "false",
      "source",
      "Full Git history is required.",
    );
    git(root, "merge-base", "--is-ancestor", floor, release);
    must(
      !git(root, "status", "--porcelain", "--untracked-files=no"),
      "source",
      "Tracked source changed after checkout.",
    );
    must(
      !git(
        root,
        "ls-files",
        "--others",
        "--exclude-standard",
        "--",
        "public",
        "server",
        "cloudflare",
      ),
      "source",
      "Unreviewed application files are present.",
    );
  } catch (e) {
    if (e instanceof ReleaseError) throw e;
    throw new ReleaseError(
      "source",
      "Integrated approved application history is missing.",
    );
  }
  const policy = JSON.parse(await readFile(resolve(root, POLICY), "utf8"));
  must(
    policy.schema === 1 &&
      policy.integration_floor === INTEGRATION &&
      policy.initial_worker_version === INITIAL_VERSION &&
      fingerprint(policy.public_origins) ===
        fingerprint([
          "https://events.kassandraraudman.workers.dev",
          "https://name.ilymmd.com",
        ]),
    "source",
    "Release policy identity changed.",
  );
  const paths = git(root, "ls-files").split("\n");
  for (const required of [
    "public/editor-tools.js",
    "public/style.css",
    "server/personal-accounts.js",
    "server/family-api.js",
    "cloudflare/gateway-protocol.js",
    "test/personal-mobile.js",
  ])
    must(
      paths.includes(required),
      "source",
      "Approved shared application modules are missing.",
    );
  must(
    Array.isArray(policy.required_application_paths) &&
      policy.required_application_paths.every((p) => paths.includes(p)),
    "source",
    "Required approved application files are missing.",
  );
  must(
    fingerprint(await appearanceManifest(root)) ===
      fingerprint(policy.appearance),
    "appearance",
    "Public files differ from the reviewed appearance manifest. Update it only in an explicitly reviewed appearance PR.",
  );
  must(
    policy.storage_adapter_sha256 === STORAGE_ADAPTER_SHA256 &&
      sha(await readFile(resolve(root, "cloudflare/worker.js"))) ===
        STORAGE_ADAPTER_SHA256,
    "database",
    "Production storage adapter differs from the reviewed class/object identity. Stop for explicit infrastructure review.",
  );
  await validateConfiguration(policy, root);
  return policy;
}
export async function validateConfiguration(policy, root = ".") {
  const raw = await readFile(resolve(root, "wrangler.jsonc"));
  must(
    policy.configuration_sha256 === CONFIGURATION_SHA256 &&
      sha(raw) === CONFIGURATION_SHA256,
    "configuration",
    "Worker configuration differs from the reviewed production configuration.",
  );
  const { parse } = await import("jsonc-parser");
  const errors = [];
  const config = parse(raw.toString(), errors, { allowTrailingComma: true });
  must(
    !errors.length &&
      config.name === "events" &&
      config.account_id === ACCOUNT &&
      config.main === "cloudflare/worker.js" &&
      config.keep_vars === true &&
      config.preview_urls === false &&
      config.workers_dev === true &&
      config.compatibility_date === "2026-10-30" &&
      fingerprint([...config.compatibility_flags].sort()) ===
        fingerprint(["global_fetch_strictly_public", "nodejs_compat"]) &&
      fingerprint(config.durable_objects?.bindings) ===
        fingerprint([
          { name: "EVENTS_DATABASE", class_name: "EventsDatabase" },
        ]) &&
      fingerprint(config.migrations) ===
        fingerprint([
          { tag: "events-v1", new_sqlite_classes: ["EventsDatabase"] },
        ]) &&
      fingerprint(config.triggers?.crons) === fingerprint(["*/5 * * * *"]) &&
      !config.vars &&
      !config.secrets &&
      !config.env &&
      !config.route &&
      !config.routes,
    "configuration",
    "Account, binding, runtime, migration or routing configuration is not approved.",
  );
  return config;
}
export function validateEvent(event, release, env) {
  must(
    env.GITHUB_ACTIONS === "true" &&
      env.GITHUB_REPOSITORY === "kasstmaster/events" &&
      env.GITHUB_EVENT_NAME === "pull_request",
    "event",
    "Only the owner-merged PR workflow may publish.",
  );
  const pr = event.pull_request;
  must(
    event.action === "closed" &&
      pr?.merged === true &&
      pr.base?.ref === "main" &&
      pr.base.repo?.full_name === "kasstmaster/events" &&
      pr.head?.repo?.full_name === "kasstmaster/events" &&
      pr.merged_by?.login === "kasstmaster" &&
      pr.merge_commit_sha === release &&
      Number.isInteger(pr.number),
    "event",
    "Event is not an exact owner-approved main merge.",
  );
  return pr.number;
}
export function validateForward(current, release, root = ".") {
  if (current.version_id === INITIAL_VERSION) return;
  must(
    isSHA(current.release) && current.release !== release,
    "order",
    "Unknown or already-active production release; stop for review.",
  );
  try {
    git(root, "merge-base", "--is-ancestor", current.release, release);
  } catch {
    throw new ReleaseError(
      "order",
      "Refusing to overwrite a newer or unrelated production release.",
    );
  }
}
// Wrangler deploy otherwise defaults absent observability to disabled. Preserve
// existing writable runtime settings explicitly in a private temporary config.
// Report bounded lowercase schema names and primitive types only. Never reflect
// nested keys, binding names, values, credential-shaped keys or free-form text.
export function runtimeSchemaSummary(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return "invalid-object";
  const safeName = (key) =>
    /^[a-z][a-z_]{0,31}$/.test(key) &&
    !/secret|token|password|credential|authorization|bearer/.test(key);
  const fields = Object.keys(raw).sort();
  return (
    fields
      .slice(0, 64)
      .map((key) => {
        const value = raw[key];
        const type =
          value === null
            ? "null"
            : Array.isArray(value)
              ? "array"
              : typeof value;
        return `${safeName(key) ? key : "[unrecognized-field]"}:${type}`;
      })
      .join(", ") + (fields.length > 64 ? ", [additional-fields]" : "")
  );
}
// Provider-defined annotations describe a *version*, not its runtime settings.
// Message/CI metadata must change with a release; retain the optional user tag.
// Unknown annotations still require review rather than being silently dropped.
export function annotationSchemaSummary(annotations) {
  if (
    !annotations ||
    typeof annotations !== "object" ||
    Array.isArray(annotations)
  )
    return annotations === null
      ? "null"
      : Array.isArray(annotations)
        ? "array"
        : typeof annotations;
  const known = new Set([
    "workers/alias",
    "workers/commit_sha",
    "workers/message",
    "workers/pull_request_number",
    "workers/pull_request_title",
    "workers/pull_request_url",
    "workers/repository_url",
    "workers/tag",
    "workers/triggered_by",
  ]);
  return (
    Object.entries(annotations)
      .slice(0, 32)
      .map(
        ([key, value]) =>
          `${known.has(key) ? key : "[unrecognized-annotation]"}:${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}`,
      )
      .sort()
      .join(", ") || "empty-object"
  );
}
export function versionAnnotations(raw) {
  const annotations = raw.annotations;
  if (annotations === undefined) return {};
  const limits = {
    "workers/alias": 512,
    "workers/commit_sha": 64,
    "workers/message": 1000,
    "workers/pull_request_number": 20,
    "workers/pull_request_title": 512,
    "workers/pull_request_url": 512,
    "workers/repository_url": 512,
    "workers/tag": 100,
    // Cloudflare-generated provenance, consumed by pinned Wrangler's
    // getVersionSource/formatTrigger. Its default branch handles arbitrary
    // provider strings; it is display metadata, never release authorization.
    "workers/triggered_by": 1024,
  };
  must(
    annotations !== null &&
      typeof annotations === "object" &&
      !Array.isArray(annotations) &&
      Object.entries(annotations).every(
        ([key, value]) =>
          Object.hasOwn(limits, key) &&
          typeof value === "string" &&
          Buffer.byteLength(value, "utf8") <= limits[key],
      ),
    "settings-schema",
    `Unsupported version annotations; values withheld. Review version metadata before publishing. Schema (names/types only): ${annotationSchemaSummary(annotations)}`,
  );
  return annotations;
}
// Cloudflare's observed disabled-placement response is {}, while Wrangler
// requires an explicit mode. Normalize this exact empty-object case only.
export function normalizedPlacement(value) {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
    ? { mode: "off" }
    : structuredClone(value);
}
export function runtimeSettingsFingerprint(raw) {
  const annotations = versionAnnotations(raw);
  const { annotations: _versionMetadata, ...runtime } = raw;
  return fingerprint({
    ...runtime,
    ...(Object.hasOwn(raw, "placement")
      ? { placement: normalizedPlacement(raw.placement) }
      : {}),
    // Omitted and empty version annotations have identical runtime meaning.
    ...(annotations["workers/tag"]
      ? { annotations: { "workers/tag": annotations["workers/tag"] } }
      : {}),
    bindings: [...raw.bindings].sort((a, b) => a.name.localeCompare(b.name)),
    ...(typeof raw.cache === "boolean"
      ? { cache: { enabled: raw.cache } }
      : {}),
    compatibility_flags: [...raw.compatibility_flags].sort(),
  });
}
export function runtimeOverlay(raw) {
  versionAnnotations(raw);
  const passthrough = [
    "observability",
    "logpush",
    "tail_consumers",
    "limits",
    "placement",
    "cache",
    "streaming_tail_consumers",
  ];
  const metadata = [
    "bindings",
    "compatibility_date",
    "compatibility_flags",
    "migration_tag",
    "annotations",
    "migrations",
    "usage_model",
    "tags",
  ];
  must(
    Object.keys(raw).every((key) =>
      [...passthrough, ...metadata].includes(key),
    ),
    "settings-schema",
    `Unknown live runtime metadata cannot be safely preserved; stop for infrastructure review. Schema (names/types only): ${runtimeSchemaSummary(raw)}`,
  );
  must(
    !raw.tags ||
      (Array.isArray(raw.tags) &&
        raw.tags.every(
          (tag) =>
            typeof tag === "string" && !/^cf:(service|environment)=/.test(tag),
        )),
    "settings-schema",
    "Service/environment tags require separate infrastructure review; deployment must not regroup the Worker.",
  );
  must(
    raw.bindings.every(
      (b) =>
        (b.type !== "assets" || b.name === "ASSETS") &&
        (b.type !== "durable_object_namespace" ||
          b.name === "EVENTS_DATABASE") &&
        [
          "assets",
          "durable_object_namespace",
          "plain_text",
          "json",
          "secret_text",
          "secret_key",
        ].includes(b.type),
    ),
    "bindings",
    "An additional binding type is not present in the approved deployment configuration.",
  );
  const overlay = Object.fromEntries(
    passthrough
      .filter((key) => Object.hasOwn(raw, key))
      .map((key) => [key, structuredClone(raw[key])]),
  );
  if (Object.hasOwn(overlay, "placement"))
    overlay.placement = normalizedPlacement(overlay.placement);
  if (typeof overlay.cache === "boolean")
    overlay.cache = { enabled: overlay.cache };
  return overlay;
}
export async function run(mode, options = {}) {
  const env = options.env || process.env,
    root = options.root || ".",
    release = env.MERGED_SHA;
  if (mode === "manifest") {
    const p = JSON.parse(await readFile(resolve(root, POLICY), "utf8"));
    p.appearance = await appearanceManifest(root);
    await writeFile(resolve(root, POLICY), JSON.stringify(p, null, 2) + "\n");
    return;
  }
  must(
    ["source", "configuration", "preflight", "publish", "verify"].includes(
      mode,
    ),
    "arguments",
    "Unsupported release operation.",
  );
  const policy =
    options.policy || JSON.parse(await readFile(resolve(root, POLICY), "utf8"));
  if (mode === "configuration") {
    must(
      policy.storage_adapter_sha256 === STORAGE_ADAPTER_SHA256 &&
        sha(await readFile(resolve(root, "cloudflare/worker.js"))) ===
          STORAGE_ADAPTER_SHA256,
      "database",
      "Production storage adapter differs from the reviewed class/object identity. Stop for explicit infrastructure review.",
    );
    await validateConfiguration(policy, root);
    return;
  }
  const source = options.sourceValidator || validateSource;
  await source(release, { root });
  if (mode === "source") return;
  const event =
    options.event || JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
  const number = validateEvent(event, release, env);
  must(
    env.CLOUDFLARE_API_TOKEN && env.ACTIONS_GITHUB_TOKEN,
    "authentication",
    "Existing GitHub-held credentials are required.",
  );
  const fetcher = options.fetcher || fetch;
  let serverTime, runtimeConfiguration, versionTag;
  async function json(url, token, stage, cloudflare = false) {
    let r;
    try {
      r = await fetcher(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new ReleaseError(
        stage,
        "Read-only transport failed; diagnostics withheld.",
      );
    }
    must(
      r.ok,
      stage,
      `Read-only request failed (HTTP ${r.status}); diagnostics withheld.`,
    );
    let j;
    try {
      j = await r.json();
    } catch {
      throw new ReleaseError(stage, "Response is not valid JSON.");
    }
    if (cloudflare) {
      must(j.success === true, stage, "Cloudflare inventory rejected.");
      if (Number.isFinite(Date.parse(r.headers.get("date"))))
        serverTime = new Date(r.headers.get("date")).toISOString();
      return j.result;
    }
    return j;
  }
  const gh = (path, stage = "github") =>
    json(
      `https://api.github.com/repos/kasstmaster/events${path}`,
      env.ACTIONS_GITHUB_TOKEN,
      stage,
    );
  const cf = (path, stage) =>
    json(
      `https://api.cloudflare.com/client/v4${path}`,
      env.CLOUDFLARE_API_TOKEN,
      stage,
      true,
    );
  async function githubGate() {
    const branch = await gh("/branches/main", "branch-protection");
    must(
      branch.protected === true,
      "branch-protection",
      "Enable main branch protection and required PR checks before release.",
    );
    must(
      mode === "verify" || branch.commit?.sha === release,
      "order",
      "This merge is no longer latest main; refusing an out-of-order release.",
    );
    const pr = await gh(`/pulls/${number}`, "merge");
    must(
      pr.merged === true &&
        pr.merge_commit_sha === release &&
        pr.base?.ref === "main" &&
        pr.merged_by?.login === "kasstmaster",
      "merge",
      "GitHub no longer confirms this exact owner merge.",
    );
    const files = [];
    for (let page = 1; page <= 30; page++) {
      const part = await gh(
        `/pulls/${number}/files?per_page=100&page=${page}`,
        "appearance",
      );
      must(Array.isArray(part), "appearance", "PR file inventory is missing.");
      files.push(...part.map((f) => f.filename));
      if (part.length < 100) break;
      must(
        page < 30,
        "appearance",
        "PR file inventory exceeds the safe bound.",
      );
    }
    if (files.some((p) => p.startsWith("public/"))) {
      must(
        files.includes(POLICY) &&
          pr.labels?.some((l) => l.name === "approved-appearance-change"),
        "appearance",
        "Public changes require a manifest update and owner appearance approval label.",
      );
      const events = await gh(
        `/issues/${number}/events?per_page=100`,
        "appearance",
      );
      must(
        Array.isArray(events) && events.length < 100,
        "appearance",
        "Owner label history is incomplete.",
      );
      const last = events
        .filter(
          (e) =>
            ["labeled", "unlabeled"].includes(e.event) &&
            e.label?.name === "approved-appearance-change",
        )
        .at(-1);
      must(
        last?.event === "labeled" && last.actor?.login === "kasstmaster",
        "appearance",
        "Appearance approval label must be applied by the owner.",
      );
    }
  }
  async function snapshot() {
    const raw = await cf(`${SCRIPT}/settings`, "settings");
    const settings = safeSettings(raw);
    runtimeConfiguration = runtimeOverlay(raw);
    versionTag = versionAnnotations(raw)["workers/tag"];
    // All runtime fields/bindings remain hashed. Only validated per-version
    // message/CI annotations are excluded; the optional user tag is preserved.
    const runtimeDigest = runtimeSettingsFingerprint(raw);
    const deployed = await cf(`${SCRIPT}/deployments`, "version");
    const latest = [...(deployed.deployments || [])].sort(
      (a, b) => Date.parse(b.created_on) - Date.parse(a.created_on),
    )[0];
    must(
      latest?.id &&
        latest.versions?.length === 1 &&
        latest.versions[0].percentage === 100,
      "version",
      "Production must have one version at 100 percent.",
    );
    const version_id = latest.versions[0].version_id;
    const version = await cf(`${SCRIPT}/versions/${version_id}`, "version");
    must(
      version.resources?.script_runtime?.migration_tag === "events-v1",
      "database",
      "Existing SQLite migration lineage changed.",
    );
    const schedule = await cf(`${SCRIPT}/schedules`, "cron");
    const crons = schedule.schedules?.map((s) => s.cron).sort();
    must(
      fingerprint(crons) === fingerprint(["*/5 * * * *"]),
      "cron",
      "Existing cron differs from approved configuration.",
    );
    const domain = await cf(`${SCRIPT}/subdomain`, "previews");
    must(
      domain.enabled === true && domain.previews_enabled === false,
      "previews",
      "Worker URL or disabled previews differ.",
    );
    const service = await cf(
      `/accounts/${ACCOUNT}/workers/services/events`,
      "service",
    );
    const environment = service.default_environment?.environment;
    must(
      typeof environment === "string" &&
        /^[A-Za-z0-9_-]{1,64}$/.test(environment),
      "service",
      "Worker service environment is unavailable.",
    );
    const routes = await cf(
      `/accounts/${ACCOUNT}/workers/services/events/environments/${environment}/routes?show_zonename=true`,
      "routes",
    );
    const domains = await cf(
      `/accounts/${ACCOUNT}/workers/domains/records?page=0&per_page=100&service=events&environment=${environment}`,
      "domains",
    );
    const records = Array.isArray(domains) ? domains : domains?.records;
    must(
      Array.isArray(records) &&
        records.length < 100 &&
        (domains.total_count ?? records.length) <= records.length,
      "domains",
      "Custom-domain inventory is incomplete.",
    );
    let response;
    try {
      response = await fetcher(ORIGIN + "/api/setup", {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      });
    } catch {
      throw new ReleaseError("health", "Live setup check failed.");
    }
    let setup;
    try {
      setup = await response.json();
    } catch {
      throw new ReleaseError("health", "Live setup response is invalid.");
    }
    must(
      response.ok && setup.required === false && setup.enabled === false,
      "health",
      "Administrator setup must remain closed.",
    );
    return {
      version_id,
      deployment_id: latest.id,
      release: version.annotations?.["workers/message"] || null,
      settings,
      runtime_digest: runtimeDigest,
      crons,
      subdomain: { enabled: true, previews_enabled: false },
      environment,
      routes_digest: fingerprint(routes),
      domains_digest: fingerprint(domains),
      setup_closed: true,
    };
  }
  await githubGate();
  const file = resolve(root, CHECKPOINT),
    receipt = resolve(root, RECEIPT);
  if (mode === "preflight") {
    const before = await snapshot();
    validateForward(before, release, root);
    must(
      fingerprint(before) === fingerprint(await snapshot()),
      "preflight",
      "Production changed during preflight.",
    );
    must(serverTime, "checkpoint", "Cloudflare timestamp is missing.");
    const checkpoint = {
      schema: 1,
      release,
      account: ACCOUNT,
      worker: "events",
      namespace_id: NAMESPACE,
      class_name: "EventsDatabase",
      object_name: "events-platform-v1",
      migration_tag: "events-v1",
      before,
      recovery: {
        kind: "sqlite-pitr-timestamp",
        timestamp: serverTime,
        nominal_expires_at: new Date(
          Date.parse(serverTime) + 30 * 86400000,
        ).toISOString(),
        precision:
          "approximate timestamp, not an exact bookmark or exported backup",
      },
    };
    await writeFile(file, JSON.stringify(checkpoint, null, 2) + "\n", {
      mode: 0o600,
    });
    if (env.GITHUB_OUTPUT)
      await appendFile(
        env.GITHUB_OUTPUT,
        `checkpoint_sha256=${sha(await readFile(file))}\n`,
      );
    console.log(
      "Preflight passed; stable production identity/settings and recovery checkpoint recorded.",
    );
    return checkpoint;
  }
  const bytes = await readFile(file),
    checkpoint = JSON.parse(bytes);
  must(
    checkpoint.schema === 1 &&
      checkpoint.release === release &&
      checkpoint.account === ACCOUNT &&
      checkpoint.worker === "events" &&
      checkpoint.namespace_id === NAMESPACE &&
      checkpoint.object_name === "events-platform-v1" &&
      checkpoint.migration_tag === "events-v1" &&
      checkpoint.class_name === "EventsDatabase",
    "checkpoint",
    "Checkpoint identity differs from this exact release.",
  );
  if (mode === "publish") {
    must(
      sha(bytes) === env.CHECKPOINT_SHA256 &&
        Math.abs(Date.now() - Date.parse(checkpoint.recovery.timestamp)) <
          15 * 60000,
      "checkpoint",
      "Checkpoint changed after upload or is stale.",
    );
    const artifacts = await gh(
      `/actions/runs/${env.GITHUB_RUN_ID}/artifacts?per_page=100`,
      "checkpoint-upload",
    );
    const artifact = artifacts.artifacts?.find(
      (a) => String(a.id) === env.CHECKPOINT_ARTIFACT_ID,
    );
    must(
      artifact &&
        /^sha256:[0-9a-f]{64}$/.test(env.CHECKPOINT_ARTIFACT_DIGEST || "") &&
        !artifact.expired &&
        artifact.size_in_bytes > 0 &&
        artifact.name ===
          `events-recovery-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}` &&
        artifact.digest === env.CHECKPOINT_ARTIFACT_DIGEST,
      "checkpoint-upload",
      "Successful checkpoint artifact upload was not verified.",
    );
    must(
      fingerprint(await snapshot()) === fingerprint(checkpoint.before),
      "preflight",
      "Production changed after checkpoint upload.",
    );
    await githubGate();
    await source(release, { root });
    const version_id = await (options.publisher || publishExact)(
      release,
      env,
      root,
      runtimeConfiguration,
      undefined,
      async () => {
        must(
          sha(await readFile(file)) === env.CHECKPOINT_SHA256 &&
            Math.abs(Date.now() - Date.parse(checkpoint.recovery.timestamp)) <
              15 * 60000,
          "checkpoint",
          "Checkpoint changed or expired during local build.",
        );
        await source(release, { root });
        must(
          fingerprint(await snapshot()) === fingerprint(checkpoint.before),
          "preflight",
          "Production changed during local build.",
        );
        await githubGate();
      },
      versionTag,
    );
    must(
      /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(version_id || "") &&
        version_id !== checkpoint.before.version_id,
      "publish",
      "Structured output does not identify a new Worker version.",
    );
    await writeFile(
      receipt,
      JSON.stringify(
        { release, account: ACCOUNT, worker: "events", version_id },
        null,
        2,
      ) + "\n",
    );
    console.log(
      "Exact merged commit published; live verification is required.",
    );
    return;
  }
  const output = JSON.parse(await readFile(receipt, "utf8"));
  must(
    output.release === release &&
      output.account === ACCOUNT &&
      output.worker === "events" &&
      /^[0-9a-f-]{36}$/.test(output.version_id || "") &&
      output.version_id !== checkpoint.before.version_id,
    "verification",
    "Deployment receipt does not match this release.",
  );
  const wait = options.wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 0; attempt < 13; attempt++) {
    const after = await snapshot();
    const preserved = ({
      version_id,
      deployment_id,
      release: annotation,
      ...rest
    }) => rest;
    must(
      fingerprint(preserved(after)) ===
        fingerprint(preserved(checkpoint.before)),
      "preservation",
      "Runtime settings, routes, cron, bindings or setup changed. Stop for review.",
    );
    must(
      after.version_id === output.version_id && after.release === release,
      "verification",
      "Active version or merged-source annotation differs from deployment receipt.",
    );
    let healthy = true;
    for (const origin of policy.public_origins) {
      must(
        [
          "https://events.kassandraraudman.workers.dev",
          "https://name.ilymmd.com",
        ].includes(origin),
        "health",
        "Unapproved health-check origin.",
      );
      for (const [path, hash] of Object.entries(policy.appearance)) {
        const url =
          origin +
          "/" +
          (path === "public/index.html" ? "" : path.slice("public/".length));
        try {
          const r = await fetcher(url, {
            method: "GET",
            redirect: "error",
            signal: AbortSignal.timeout(20000),
          });
          if (!r.ok || sha(Buffer.from(await r.arrayBuffer())) !== hash)
            healthy = false;
        } catch {
          healthy = false;
        }
      }
    }
    if (healthy) {
      await writeFile(
        resolve(root, "recovery/events-verification.json"),
        JSON.stringify(
          {
            release,
            version_id: after.version_id,
            verified_at: serverTime,
            preserved: preserved(after),
            health:
              "All reviewed public assets match on canonical and representative household origin; setup closed.",
            authenticated_flows:
              "Not exercised on production; isolated browser suites gate publication.",
            recovery: checkpoint.recovery,
          },
          null,
          2,
        ) + "\n",
      );
      console.log(
        "Verified exact merged version, public assets/health and preserved production configuration/database bindings.",
      );
      return;
    }
    if (attempt < 12) await wait(30000);
  }
  throw new ReleaseError(
    "health",
    "Public assets have not converged to the merged application. Do not redeploy; investigate or retry verification only.",
  );
}
// Classify captured diagnostics against fixed patterns only. Never reflect raw
// messages, headers, URLs, field values, arguments or provider response bodies.
export function wranglerFailure(error, operation) {
  const text = (
    String(error?.stdout || "") +
    "\n" +
    String(error?.stderr || "")
  ).replace(/\u001b\[[\d;]*m/g, "");
  const rules = [
    [
      "authentication",
      /authentication error|authenticate|invalid access token|invalid api token|unauthorized/i,
    ],
    [
      "permissions",
      /permission|forbidden|not authorized|authorization failed/i,
    ],
    ["rate-limit", /rate.limit|too many requests/i],
    [
      "network",
      /ENOTFOUND|ECONNRESET|ETIMEDOUT|certificate|unable to verify|fetch failed|proxy (error|failed|denied|refused)/i,
    ],
    ["unsupported-option", /unknown argument|unknown option/i],
    [
      "configuration",
      /invalid configuration|configuration.*error|unexpected fields|invalid.*placement|Processing [^\n]*configuration:|is a required field|Expected [^\n]*to be of type/i,
    ],
    [
      "bundle",
      /could not resolve|cannot find module|build failed|no such file/i,
    ],
  ];
  const category =
    rules.find(([, pattern]) => pattern.test(text))?.[0] || "unclassified";
  const diagnosticFields = [
    "placement",
    "placement.mode",
    "placement.hint",
    "placement.region",
    "placement.host",
    "placement.hostname",
    "logpush",
    "tail_consumers",
    "streaming_tail_consumers",
    "limits",
    "limits.cpu_ms",
    "cache",
    "cache.enabled",
    "observability",
    "observability.enabled",
    "observability.logs",
    "observability.traces",
    "compatibility_date",
    "compatibility_flags",
    "main",
    "assets.directory",
    "durable_objects",
    "migrations",
  ].filter(
    (field) =>
      text.includes('"' + field + '"') || text.includes("`" + field + "`"),
  );
  const reasons = [
    ["required-field", /is a required field/i],
    [
      "invalid-type",
      /Expected [^\n]*to be of type|should be an object|must be a string/i,
    ],
    ["invalid-value", /Expected [^\n]*(?:one of|values)|not a valid value/i],
    ["missing-path", /does not exist|not found|no such file/i],
    ["unknown-field", /Unexpected fields|unrecognized.{0,40}(field|key)/i],
  ]
    .filter(([, pattern]) => pattern.test(text))
    .map(([name]) => name);
  const codes = [
    ...new Set(
      [...text.matchAll(/\[code:\s*(\d{1,8})\]/g)].map((match) => match[1]),
    ),
  ].slice(0, 8);
  const exit =
    Number.isSafeInteger(error?.code) && error.code >= 0 && error.code <= 255
      ? error.code
      : "unavailable";
  return new ReleaseError(
    operation,
    `Wrangler ${operation === "local-build" ? "local build" : "upload"} failed; category ${category}; fields ${diagnosticFields.join(",") || "none"}; reasons ${reasons.join(",") || "none"}; exit ${exit}; Cloudflare codes ${codes.join(",") || "none"}. Raw diagnostics withheld.${operation === "publish" ? " Inspect active version before any retry." : " No upload was attempted."}`,
  );
}
export async function publishExact(
  release,
  env,
  root = ".",
  runtimeConfiguration = {},
  execute = promisify(execFile),
  beforePublish = async () => {},
  versionTag,
  dryRunOnly = false,
) {
  const dir = await mkdtemp(join(tmpdir(), "events-publish-"));
  const output = join(dir, "output.jsonl");
  const { parse } = await import("jsonc-parser");
  const config = parse(await readFile(resolve(root, "wrangler.jsonc"), "utf8"));
  const effective = {
    ...config,
    ...runtimeConfiguration,
    main: resolve(root, config.main),
    assets: {
      ...config.assets,
      directory: resolve(root, config.assets.directory),
    },
  };
  const effectivePath = join(dir, "wrangler.jsonc");
  await writeFile(effectivePath, JSON.stringify(effective), { mode: 0o600 });
  try {
    let operation = "local-build";
    try {
      const local = await execute(
        process.execPath,
        [
          resolve(root, "node_modules/wrangler/bin/wrangler.js"),
          "deploy",
          "--dry-run",
          ...(versionTag ? ["--tag", versionTag] : []),
          "--config",
          effectivePath,
          "--outdir",
          join(dir, "bundle"),
        ],
        {
          cwd: root,
          env: { ...env, WRANGLER_SEND_METRICS: "false" },
          timeout: 180000,
          maxBuffer: 2000000,
        },
      );
      must(
        !/Unexpected fields|unrecognized.{0,40}(field|key)/i.test(
          (local.stdout || "") + (local.stderr || ""),
        ),
        "runtime-schema",
        "Wrangler cannot preserve an observed runtime field; stop before publishing.",
      );
      if (dryRunOnly) return;
      await beforePublish();
      operation = "publish";
      await execute(
        process.execPath,
        [
          resolve(root, "node_modules/wrangler/bin/wrangler.js"),
          "deploy",
          "--name",
          "events",
          "--config",
          effectivePath,
          "--keep-vars",
          "--message",
          release,
          ...(versionTag ? ["--tag", versionTag] : []),
        ],
        {
          cwd: root,
          env: {
            ...env,
            CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
            WRANGLER_SEND_METRICS: "false",
            WRANGLER_OUTPUT_FILE_PATH: output,
          },
          timeout: 240000,
          maxBuffer: 2000000,
        },
      );
    } catch (error) {
      if (error instanceof ReleaseError) throw error;
      throw wranglerFailure(error, operation);
    }
    const records = (await readFile(output, "utf8"))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((x) => JSON.parse(x));
    const deploys = records.filter((r) => r.type === "deploy");
    must(
      deploys.length === 1 &&
        deploys[0].worker_name === "events" &&
        deploys[0].version === 1 &&
        !deploys[0].wrangler_environment,
      "publish",
      "Wrangler output is not one production events deployment.",
    );
    return deploys[0].version_id;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await run(process.argv[2]);
  } catch (e) {
    console.error(
      e instanceof ReleaseError
        ? `Release stopped [${e.stage}]: ${e.message}`
        : "Release stopped; private diagnostics withheld.",
    );
    process.exitCode = 1;
  }
}

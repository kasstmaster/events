import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
export const hashBytes = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
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
export const fingerprint = (value) => hashBytes(JSON.stringify(stable(value)));
export class ProvenanceError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProvenanceError";
    this.code = code;
  }
}
const need = (value, code) => {
  if (!value) throw new ProvenanceError(code);
};
const sha = hashBytes;
// Hash ALL returned modules, including maps, WASM and asset routing modules.
// An opaque ETag, message, author or version UUID is never code evidence.
export function moduleIdentity(version, expectedID) {
  need(version?.id === expectedID, "MODULE_VERSION_MISMATCH");
  need(
    Array.isArray(version.modules) &&
      version.modules.length > 0 &&
      version.modules.length <= 1000,
    "MODULE_BYTES_UNAVAILABLE",
  );
  const names = new Set();
  let total = 0;
  const modules = version.modules
    .map((m) => {
      need(
        typeof m.name === "string" &&
          m.name.length > 0 &&
          m.name.length <= 1024 &&
          !names.has(m.name),
        "MODULE_INVENTORY_INVALID",
      );
      names.add(m.name);
      need(
        typeof m.content_type === "string" &&
          typeof m.content_base64 === "string",
        "MODULE_BYTES_UNAVAILABLE",
      );
      const bytes = Buffer.from(m.content_base64, "base64");
      need(
        bytes.toString("base64") === m.content_base64,
        "MODULE_ENCODING_INVALID",
      );
      total += bytes.length;
      need(total <= 25000000, "MODULE_BYTES_TOO_LARGE");
      return { name: m.name, type: m.content_type, sha256: sha(bytes) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  need(
    typeof version.main_module === "string" && names.has(version.main_module),
    "ENTRYPOINT_UNAVAILABLE",
  );
  return {
    fingerprint: fingerprint({ main_module: version.main_module, modules }),
    count: modules.length,
  };
}

export const ASSET_ORIGINS = [
  "https://events.kassandraraudman.workers.dev",
  "https://name.ilymmd.com",
];
export function validManifest(manifest) {
  const entries = Object.entries(manifest || {});
  need(
    entries.length > 0 &&
      entries.length <= 500 &&
      entries.every(
        ([p, h]) =>
          /^public\/[A-Za-z0-9_./-]+$/.test(p) &&
          !p.includes("..") &&
          !/\/(?:_headers|_redirects|\.assetsignore)$/.test(p) &&
          /^[a-f0-9]{64}$/.test(h),
      ),
    "ASSET_MANIFEST_INVALID",
  );
  return entries;
}
export function approvedManifest(commit, root = ".") {
  need(/^[a-f0-9]{40}$/.test(commit), "PROVENANCE_COMMIT_INVALID");
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    const manifest = JSON.parse(
      git("show", `${commit}:.github/release/approved-application.json`),
    ).appearance;
    validManifest(manifest);
    const files = git("ls-tree", "-r", "--name-only", commit, "--", "public")
      .split("\n")
      .filter(Boolean)
      .sort();
    need(
      fingerprint(files) === fingerprint(Object.keys(manifest).sort()),
      "INCOMPLETE_ASSET_MANIFEST",
    );
    for (const file of files) {
      const bytes = execFileSync("git", ["show", `${commit}:${file}`], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 8000000,
      });
      need(
        hashBytes(bytes) === manifest[file],
        "REVIEWED_ASSET_SOURCE_MISMATCH",
      );
    }
    return manifest;
  } catch (error) {
    if (error instanceof ProvenanceError) throw error;
    throw new ProvenanceError("APPROVED_MANIFEST_UNAVAILABLE");
  }
}
export function historicalAssets(receipt, manifest) {
  validManifest(manifest);
  need(
    /^[a-f0-9]{40}$/.test(receipt?.release || "") &&
      /^[a-f0-9-]{36}$/.test(receipt?.version_id || "") &&
      Number.isFinite(Date.parse(receipt?.verified_at)),
    "HISTORICAL_VERIFICATION_REQUIRED",
  );
  // This sentence was emitted only after the historical verifier compared ALL
  // reviewed files on both origins. The bootstrap caller additionally pins the
  // exact original receipt bytes; future receipts come from trusted successful jobs.
  need(
    receipt.health ===
      "All reviewed public assets match on canonical and representative household origin; setup closed.",
    "HISTORICAL_ASSET_ATTESTATION_MISSING",
  );
  if (receipt.application) {
    need(
      receipt.application.schema === 1 &&
        receipt.application.commit === receipt.release &&
        receipt.application.asset_manifest_sha256 === fingerprint(manifest) &&
        receipt.application.asset_count === Object.keys(manifest).length,
      "HISTORICAL_ASSET_MANIFEST_MISMATCH",
    );
  } else {
    need(
      receipt.release === "39bf57fd6b3f1a3e11176d1aeadbbdc31aa31138" &&
        receipt.version_id === "b43cd66d-43de-44a5-bdb2-f62c4c2ba371",
      "LEGACY_RECEIPT_NOT_APPROVED",
    );
  }
  return fingerprint(manifest);
}
export function assetRouting(version) {
  // Config is a documented read field; the upload JWT is NOT required or read.
  // With run_worker_first=true, the reviewed Worker/handler controls the complete
  // set of public files. Unknown store entries cannot bypass it as direct assets.
  need(
    version.assets?.config?.run_worker_first === true,
    "WORKER_FIRST_ASSET_ROUTING_UNPROVEN",
  );
  const config = version.assets.config;
  need(
    Object.keys(config).every((k) =>
      [
        "run_worker_first",
        "html_handling",
        "not_found_handling",
        "base_path",
      ].includes(k),
    ),
    "ASSET_ROUTING_SCHEMA_UNSUPPORTED",
  );
  const canonical = {
    run_worker_first: true,
    html_handling: config.html_handling ?? "auto-trailing-slash",
    not_found_handling: config.not_found_handling ?? "none",
    base_path: config.base_path ?? "/",
  };
  need(
    canonical.html_handling === "auto-trailing-slash" &&
      canonical.not_found_handling === "none" &&
      canonical.base_path === "/",
    "ASSET_ROUTING_CONFIGURATION_UNAPPROVED",
  );
  return fingerprint(canonical);
}
export async function verifyAssetBytes(manifest, fetcher = fetch) {
  const entries = validManifest(manifest);
  for (const origin of ASSET_ORIGINS)
    for (const [path, hash] of entries) {
      let response;
      try {
        response = await fetcher(
          origin + "/" + (path === "public/index.html" ? "" : path.slice(7)),
          {
            method: "GET",
            redirect: "error",
            cache: "no-store",
            headers: { "Cache-Control": "no-cache" },
            signal: AbortSignal.timeout(20000),
          },
        );
      } catch {
        throw new ProvenanceError("PUBLIC_ASSET_READ_FAILED");
      }
      need(response.ok, "PUBLIC_ASSET_READ_FAILED");
      const bytes = await response.arrayBuffer();
      need(
        bytes.byteLength <= 8000000 && hashBytes(Buffer.from(bytes)) === hash,
        "PUBLIC_ASSET_BYTES_MISMATCH",
      );
    }
}
export const FIREBASE_NAMES = [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_AUTH_DOMAIN",
  "FIREBASE_API_KEY",
  "FIREBASE_AUTH_ENABLED",
  "FIREBASE_ACTIVATION_APPROVED",
];
export function protectedRuntime(raw) {
  need(
    Array.isArray(raw.bindings) &&
      new Set(raw.bindings.map((b) => b.name)).size === raw.bindings.length,
    "BINDING_INVENTORY_INVALID",
  );
  const byName = new Map(raw.bindings.map((b) => [b.name, b]));
  const values = {
    FIREBASE_PROJECT_ID: (v) => v === "gather-58a79",
    FIREBASE_AUTH_DOMAIN: (v) => v === "gather-58a79.firebaseapp.com",
    FIREBASE_API_KEY: (v) =>
      typeof v === "string" && /^AIza[A-Za-z0-9_-]{35}$/.test(v),
    FIREBASE_AUTH_ENABLED: (v) => v === "false",
    FIREBASE_ACTIVATION_APPROVED: (v) => v === "false",
  };
  for (const name of FIREBASE_NAMES) {
    const b = byName.get(name);
    const reason = !b
      ? "missing-binding"
      : b.type !== "plain_text"
        ? "wrong-binding-type"
        : !values[name](b.text)
          ? "invalid-value"
          : null;
    if (reason) {
      const error = new ProvenanceError("FIREBASE_CONFIGURATION_NOT_APPROVED");
      error.field = name;
      error.reason = reason;
      throw error;
    }
  }
  return {
    ...raw,
    bindings: raw.bindings.filter((b) => !FIREBASE_NAMES.includes(b.name)),
  };
}
export function resolveApplication(receipt, historical, current, manifest) {
  historicalAssets(receipt, manifest);
  need(historical.id === receipt.version_id, "HISTORICAL_VERSION_MISMATCH");
  const before = moduleIdentity(historical, receipt.version_id),
    after = moduleIdentity(current, current.id);
  need(before.fingerprint === after.fingerprint, "APPLICATION_CODE_MISMATCH");
  if (receipt.application)
    need(
      before.fingerprint === receipt.application.code_sha256,
      "HISTORICAL_CODE_RECEIPT_MISMATCH",
    );
  need(
    assetRouting(historical) === assetRouting(current),
    "ASSET_ROUTING_CONFIGURATION_MISMATCH",
  );
  return {
    schema: 1,
    commit: receipt.release,
    code_sha256: after.fingerprint,
    module_count: after.count,
    asset_manifest_sha256: fingerprint(manifest),
    asset_count: Object.keys(manifest).length,
    asset_routing_sha256: assetRouting(current),
    evidence: "verified-release-manifest-and-observed-complete-assets",
  };
}

import { readFile, writeFile, appendFile, mkdir, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ProvenanceError, hashBytes } from "./application-provenance.mjs";
const need = (v, c) => {
  if (!v) throw new ProvenanceError(c);
};
export const BOOTSTRAP_HASH =
  "63a8f799a09320c77f8cca31ee41eab4c4f6c979ae5ca12f0a250acd5bae9dd0";
export async function selectEvidence(read) {
  const page = await read(
    "/actions/workflows/deploy-approved-events.yml/runs?status=success&per_page=100",
  );
  need(Array.isArray(page.workflow_runs), "RELEASE_HISTORY_UNAVAILABLE");
  const runs = page.workflow_runs
    .filter(
      (r) =>
        r.status === "completed" &&
        r.conclusion === "success" &&
        r.event === "pull_request" &&
        r.path === ".github/workflows/deploy-approved-events.yml",
    )
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const run = runs[0];
  need(
    run &&
      Number.isSafeInteger(run.id) &&
      Number.isSafeInteger(run.run_attempt),
    "TRUSTED_RELEASE_RUN_MISSING",
  );
  need(/^[a-f0-9]{40}$/.test(run.head_sha || ""), "RELEASE_HEAD_INVALID");
  const prs = await read(`/commits/${run.head_sha}/pulls?per_page=100`);
  need(
    Array.isArray(prs) && prs.length > 0 && prs.length < 100,
    "RUN_PULL_REQUEST_INVENTORY_INVALID",
  );
  const candidates = prs.filter(
    (p) =>
      p.head?.sha === run.head_sha &&
      p.base?.ref === "main" &&
      Number.isSafeInteger(p.number),
  );
  need(
    candidates.length > 0 && candidates.length <= 10,
    "RUN_PULL_REQUEST_INVENTORY_INVALID",
  );
  const details = [];
  for (const p of candidates) details.push(await read(`/pulls/${p.number}`));
  const owners = details.filter(
    (p) =>
      p.merged_at &&
      p.merged_by?.login === "kasstmaster" &&
      p.base?.ref === "main" &&
      p.base?.repo?.full_name === "kasstmaster/events" &&
      p.head?.repo?.full_name === "kasstmaster/events" &&
      p.head?.sha === run.head_sha &&
      /^[a-f0-9]{40}$/.test(p.merge_commit_sha || ""),
  );
  need(owners.length === 1, "SUCCESSFUL_RUN_OWNER_MERGE_UNPROVEN");
  const listing = await read(`/actions/runs/${run.id}/artifacts?per_page=100`);
  const name = `events-verification-${run.id}-${run.run_attempt}`;
  const artifacts = listing.artifacts?.filter(
    (a) => a.name === name && !a.expired,
  );
  need(
    artifacts?.length === 1 &&
      Number.isSafeInteger(artifacts[0].id) &&
      /^sha256:[a-f0-9]{64}$/.test(artifacts[0].digest || ""),
    "VERIFIED_RELEASE_ARTIFACT_MISSING",
  );
  const artifact = artifacts[0];
  return {
    schema: 1,
    run_id: run.id,
    attempt: run.run_attempt,
    artifact_id: artifact.id,
    artifact_digest: artifact.digest,
    release: owners[0].merge_commit_sha,
    bootstrap: run.id === 43939613620 && artifact.id === 14280212512,
  };
}
export async function loadEvidence(env = process.env) {
  const selection = JSON.parse(
    await readFile(
      resolve(env.RUNNER_TEMP, "gather-release-selection.json"),
      "utf8",
    ),
  );
  const bytes = await readFile(
    resolve(
      env.RUNNER_TEMP,
      "gather-release-evidence/events-verification.json",
    ),
  );
  const { hashBytes } = await import("./application-provenance.mjs");
  const receipt = JSON.parse(bytes);
  need(
    selection.schema === 1 &&
      receipt.release === selection.release &&
      receipt.preserved,
    "RELEASE_EVIDENCE_IDENTITY_MISMATCH",
  );
  if (selection.bootstrap)
    need(
      hashBytes(bytes) === BOOTSTRAP_HASH,
      "BOOTSTRAP_RECEIPT_BYTES_MISMATCH",
    );
  else
    need(
      receipt.application?.schema === 1 &&
        receipt.application.commit === receipt.release,
      "MODERN_RELEASE_RECEIPT_REQUIRED",
    );
  return { receipt, selection };
}
export async function downloadEvidence(
  selection,
  env = process.env,
  fetcher = fetch,
) {
  need(
    Number.isSafeInteger(selection.artifact_id) &&
      /^sha256:[a-f0-9]{64}$/.test(selection.artifact_digest || ""),
    "ARTIFACT_SELECTION_INVALID",
  );
  const initial = await fetcher(
    `https://api.github.com/repos/kasstmaster/events/actions/artifacts/${selection.artifact_id}/zip`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${env.ACTIONS_GITHUB_TOKEN}` },
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
    },
  );
  need(initial.status === 302, "ARTIFACT_DOWNLOAD_REDIRECT_REQUIRED");
  const target = new URL(initial.headers.get("location"));
  need(
    target.protocol === "https:" &&
      !target.port &&
      !target.username &&
      !target.password &&
      (target.hostname.endsWith(".blob.core.windows.net") ||
        target.hostname.endsWith(".actions.githubusercontent.com") ||
        target.hostname.endsWith(".githubusercontent.com")),
    "ARTIFACT_DOWNLOAD_HOST_UNAPPROVED",
  );
  const response = await fetcher(target.href, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  need(response.ok, "ARTIFACT_DOWNLOAD_REJECTED");
  const bytes = Buffer.from(await response.arrayBuffer());
  need(
    bytes.length > 0 &&
      bytes.length <= 2000000 &&
      "sha256:" + hashBytes(bytes) === selection.artifact_digest,
    "ARTIFACT_ARCHIVE_DIGEST_MISMATCH",
  );
  const zip = resolve(env.RUNNER_TEMP, "gather-release-evidence.zip");
  await writeFile(zip, bytes, { mode: 0o600 });
  try {
    const files = execFileSync("unzip", ["-Z1", zip], {
      encoding: "utf8",
      maxBuffer: 10000,
      stdio: ["ignore", "pipe", "pipe"],
    })
      .trim()
      .split("\n");
    need(
      files.length <= 3 &&
        new Set(files).size === files.length &&
        files.includes("events-verification.json") &&
        files.every((f) =>
          /^events-(?:verification|checkpoint|deployment)\.json$/.test(f),
        ),
      "ARTIFACT_ARCHIVE_INVENTORY_INVALID",
    );
    const receipt = execFileSync(
      "unzip",
      ["-p", zip, "events-verification.json"],
      { maxBuffer: 1000000, stdio: ["ignore", "pipe", "pipe"] },
    );
    const directory = resolve(env.RUNNER_TEMP, "gather-release-evidence");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(resolve(directory, "events-verification.json"), receipt, {
      mode: 0o600,
    });
  } finally {
    await rm(zip, { force: true });
  }
}
export async function main(env = process.env, fetcher = fetch) {
  if (process.argv[2] === "download") {
    const selection = JSON.parse(
      await readFile(
        resolve(env.RUNNER_TEMP, "gather-release-selection.json"),
        "utf8",
      ),
    );
    await downloadEvidence(selection, env, fetcher);
    console.log("PASS trusted-artifact-archive-digest-and-inventory");
    return;
  }
  const read = async (path) => {
    let r;
    try {
      r = await fetcher(
        "https://api.github.com/repos/kasstmaster/events" + path,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${env.ACTIONS_GITHUB_TOKEN}`,
            Accept: "application/vnd.github+json",
          },
          redirect: "error",
          signal: AbortSignal.timeout(20000),
        },
      );
    } catch {
      throw new ProvenanceError("GITHUB_EVIDENCE_READ_FAILED");
    }
    need(r.ok, "GITHUB_EVIDENCE_READ_REJECTED");
    return r.json();
  };
  const selection = await selectEvidence(read);
  await writeFile(
    resolve(env.RUNNER_TEMP, "gather-release-selection.json"),
    JSON.stringify(selection),
    { mode: 0o600 },
  );
  await appendFile(
    env.GITHUB_OUTPUT,
    `run_id=${selection.run_id}\nartifact_id=${selection.artifact_id}\n`,
  );
  console.log("PASS trusted-successful-owner-merged-release-selected");
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  main().catch((e) => {
    console.error(
      "STOP " +
        (e instanceof ProvenanceError
          ? e.code
          : "RELEASE_EVIDENCE_UNAVAILABLE"),
    );
    process.exitCode = 1;
  });

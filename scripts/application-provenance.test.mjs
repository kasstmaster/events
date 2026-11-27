import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  moduleIdentity,
  historicalAssets,
  resolveApplication,
  assetRouting,
  approvedManifest,
  verifyAssetBytes,
  reviewedSignInShell,
  protectedRuntime,
  fingerprint,
  hashBytes,
} from "./application-provenance.mjs";
import {
  selectEvidence,
  downloadEvidence,
  loadEvidence,
} from "./select-release-evidence.mjs";
import { validateForward } from "./automatic-events-release.mjs";
const COMMIT = "39bf57fd6b3f1a3e11176d1aeadbbdc31aa31138",
  BASE = "b43cd66d-43de-44a5-bdb2-f62c4c2ba371",
  ACTIVE = "3f5968c5-8813-4a77-adfa-d46c4d480e92";
const health =
  "All reviewed public assets match on canonical and representative household origin; setup closed.";
const version = (id) => ({
  id,
  main_module: "worker.js",
  modules: [
    {
      name: "worker.js",
      content_type: "application/javascript+module",
      content_base64: Buffer.from("safe-worker").toString("base64"),
    },
  ],
  assets: { config: { run_worker_first: true } },
});
const manifest = {
  "public/index.html": hashBytes("index"),
  "public/app.js": hashBytes("app"),
  "public/last.svg": hashBytes("last"),
};
const receipt = () => ({
  release: COMMIT,
  version_id: BASE,
  verified_at: "2026-11-16T22:53:37.000Z",
  health,
  preserved: {},
});
test("permanent application identity accepts successive configuration UUIDs only with the same evidence and strict Git ancestry", () => {
  const previous = version(BASE);
  for (const id of ["6ad2eca8-f6fe-44e0-8683-a448a613d4ab", ACTIVE]) {
    const current = version(id);
    current.annotations = { "workers/message": "dashboard configuration edit" };
    const resolved = resolveApplication(receipt(), previous, current, manifest);
    assert.equal(resolved.commit, COMMIT);
    assert.doesNotThrow(() =>
      validateForward(
        { version_id: id, release: resolved.commit },
        "391978f209f99e3b0f3b0e17653cf755a5595538",
      ),
    );
    assert.throws(
      () =>
        validateForward({ version_id: id, release: resolved.commit }, COMMIT),
      /already-active/,
    );
    assert.throws(
      () =>
        validateForward(
          { version_id: id, release: resolved.commit },
          "f".repeat(40),
        ),
      /newer or unrelated/,
    );
  }
});
test("historical asset proof comes from the verified receipt plus complete committed inventory, independently of current responses", () => {
  assert.equal(historicalAssets(receipt(), manifest), fingerprint(manifest));
  for (const change of [
    (r) => delete r.health,
    (r) => delete r.verified_at,
    (r) => (r.release = "a".repeat(40)),
    (r) => (r.version_id = ACTIVE),
  ]) {
    const r = receipt();
    change(r);
    assert.throws(() => historicalAssets(r, manifest));
  }
  const modern = {
    ...receipt(),
    release: "a".repeat(40),
    application: {
      schema: 1,
      commit: "a".repeat(40),
      asset_manifest_sha256: fingerprint(manifest),
      asset_count: 3,
    },
  };
  assert.equal(historicalAssets(modern, manifest), fingerprint(manifest));
  assert.throws(
    () =>
      historicalAssets(modern, {
        ...manifest,
        "public/extra.js": hashBytes("extra"),
      }),
    /MANIFEST_MISMATCH/,
  );
});
test("actual bytes and recorded historical manifest reconcile config versions without an upload JWT", () => {
  const r = receipt(),
    prior = version(BASE),
    current = version(ACTIVE);
  current.annotations = { "workers/message": "dashboard change" };
  const result = resolveApplication(r, prior, current, manifest);
  assert.equal(result.commit, COMMIT);
  assert.equal(result.asset_count, 3);
  current.modules[0].content_base64 =
    Buffer.from("modified-worker").toString("base64");
  assert.throws(
    () => resolveApplication(r, prior, current, manifest),
    /CODE_MISMATCH/,
  );
  for (const assets of [
    undefined,
    {},
    { config: { run_worker_first: false } },
    { config: { run_worker_first: ["/only"] } },
  ])
    assert.throws(() => assetRouting({ ...prior, assets }), /ROUTING_UNPROVEN/);
  assert.throws(
    () =>
      resolveApplication(
        {
          ...r,
          application: {
            schema: 1,
            commit: COMMIT,
            asset_manifest_sha256: fingerprint(manifest),
            asset_count: 3,
            code_sha256: "f".repeat(64),
          },
        },
        prior,
        version(ACTIVE),
        manifest,
      ),
    /CODE_RECEIPT_MISMATCH/,
  );
});
test("all assets are checked at both origins, including the last inventory entry; redirects or missing/altered bytes fail", async () => {
  const visited = [];
  const fetcher = async (url, o) => {
    visited.push(url);
    assert.equal(o.method, "GET");
    assert.equal(o.redirect, "error");
    assert.equal(o.headers.Authorization, undefined);
    return new Response(
      url.endsWith("/app.js")
        ? "app"
        : url.endsWith("/last.svg")
          ? "last"
          : "index",
    );
  };
  await verifyAssetBytes(manifest, fetcher);
  assert.equal(visited.length, 6);
  for (const corrupt of ["/app.js", "/last.svg", "/"])
    await assert.rejects(
      verifyAssetBytes(manifest, async (url, o) =>
        url.endsWith(corrupt) ? new Response("changed") : fetcher(url, o),
      ),
      /ASSET_BYTES_MISMATCH/,
    );
  await assert.rejects(
    verifyAssetBytes(manifest, async () => new Response("", { status: 302 })),
    /READ_FAILED/,
  );
});
test("HTML-first release verifies the exact static sign-in transform on both origins", async () => {
  const source = `<!doctype html>
<html><head>
<link rel="preload" href="/api/startup?view=home" data-gather-home>
<link rel="modulepreload" href="/app.js">
<script type="module" src="/auth-bootstrap.js"></script>
<script type="module" src="/app.js"></script>
</head><body><main id="main"><p>Getting things ready…</p></main></body></html>`;
  const document = reviewedSignInShell(Buffer.from(source));
  assert.doesNotMatch(
    document,
    /data-gather-home|modulepreload|src="\/app.js"/,
  );
  assert.match(document, /data-gather-transfer/);
  const manifest = {
    "public/index.html": hashBytes(source),
    "public/style.css": hashBytes("css"),
  };
  const paths = [];
  const read = async (url) => {
    paths.push(new URL(url).pathname);
    return new Response(url.endsWith("/signin") ? document : "css");
  };
  await verifyAssetBytes(manifest, read, { reviewedIndex: source });
  assert.deepEqual(paths, ["/signin", "/style.css", "/signin", "/style.css"]);
  await assert.rejects(
    verifyAssetBytes(
      manifest,
      async (url) =>
        new Response(url.endsWith("/signin") ? document + " " : "css"),
      { reviewedIndex: source },
    ),
    /PUBLIC_ASSET_BYTES_MISMATCH/,
  );
  await assert.rejects(
    verifyAssetBytes(manifest, read, { reviewedIndex: source + "changed" }),
    /REVIEWED_ASSET_SOURCE_MISMATCH/,
  );
});

test("manifest loader covers the whole historical Git public tree and independently checks every blob", async (t) => {
  assert.equal(Object.keys(approvedManifest(COMMIT)).length, 27);
  const root = await mkdtemp(join(tmpdir(), "asset-manifest-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...a) =>
    execFileSync("git", a, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init");
  await mkdir(join(root, "public"));
  await mkdir(join(root, ".github/release"), { recursive: true });
  await writeFile(join(root, "public/a.js"), "a");
  await writeFile(join(root, "public/b.js"), "b");
  await writeFile(
    join(root, ".github/release/approved-application.json"),
    JSON.stringify({ appearance: { "public/a.js": hashBytes("a") } }),
  );
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "incomplete",
  );
  assert.throws(
    () => approvedManifest(git("rev-parse", "HEAD"), root),
    /INCOMPLETE_ASSET_MANIFEST/,
  );
});
function ghFixture() {
  const head = "a".repeat(40),
    sha = "b".repeat(40);
  const run = {
    id: 123,
    run_attempt: 2,
    status: "completed",
    conclusion: "success",
    event: "pull_request",
    path: ".github/workflows/deploy-approved-events.yml",
    head_sha: head,
    created_at: "2026-11-17T00:00:00Z",
  };
  const pr = {
    number: 99,
    merged_at: "2026-11-17T00:00:00Z",
    merged_by: { login: "kasstmaster" },
    merge_commit_sha: sha,
    base: { ref: "main", repo: { full_name: "kasstmaster/events" } },
    head: { sha: head, repo: { full_name: "kasstmaster/events" } },
  };
  const artifact = {
    id: 456,
    name: "events-verification-123-2",
    expired: false,
    digest: "sha256:" + "c".repeat(64),
  };
  const read = async (path) =>
    path.includes("/runs?")
      ? { workflow_runs: [run] }
      : path.includes("/commits/")
        ? [pr]
        : path === "/pulls/99"
          ? pr
          : { artifacts: [artifact] };
  return { run, pr, artifact, read };
}
test("trusted evidence selection requires successful release job, exact owner merge and unexpired matching-attempt artifact", async () => {
  const f = ghFixture(),
    s = await selectEvidence(f.read);
  assert.equal(s.release, f.pr.merge_commit_sha);
  assert.equal(s.artifact_id, 456);
  for (const mutate of [
    (f) => (f.run.event = "push"),
    (f) => (f.run.conclusion = "failure"),
    (f) => (f.run.path = ".github/workflows/other.yml"),
    (f) => (f.pr.merged_by.login = "other"),
    (f) => (f.pr.head.repo.full_name = "fork/events"),
    (f) => (f.artifact.expired = true),
    (f) => (f.artifact.name = "events-verification-123-1"),
    (f) => delete f.artifact.digest,
  ]) {
    const g = ghFixture();
    mutate(g);
    await assert.rejects(selectEvidence(g.read));
  }
});
test("configuration allowlist retains ordinary public Firebase updates while keeping both activation flags false", () => {
  const raw = {
    bindings: Object.entries({
      FIREBASE_PROJECT_ID: "gather-58a79",
      FIREBASE_AUTH_DOMAIN: "gather-58a79.firebaseapp.com",
      FIREBASE_API_KEY: "AIza" + "a".repeat(35),
      FIREBASE_AUTH_ENABLED: "false",
      FIREBASE_ACTIVATION_APPROVED: "false",
      PRIVATE_VALUE: "retained",
    }).map(([name, text]) => ({ name, type: "plain_text", text })),
  };
  const protectedHash = fingerprint(protectedRuntime(raw));
  const updated = structuredClone(raw);
  updated.bindings.find((b) => b.name === "FIREBASE_API_KEY").text =
    "AIza" + "b".repeat(35);
  assert.equal(fingerprint(protectedRuntime(updated)), protectedHash);
  for (const name of [
    "FIREBASE_AUTH_ENABLED",
    "FIREBASE_ACTIVATION_APPROVED",
  ]) {
    const bad = structuredClone(raw);
    bad.bindings.find((b) => b.name === name).text = "true";
    assert.throws(() => protectedRuntime(bad));
  }
  updated.bindings.find((b) => b.name === "PRIVATE_VALUE").text = "changed";
  assert.notEqual(fingerprint(protectedRuntime(updated)), protectedHash);
});
test("artifact download verifies archive bytes before extracting only expected JSON, without forwarding credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "release-evidence-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "events-verification.json"),
    JSON.stringify({
      release: "b".repeat(40),
      application: { schema: 1, commit: "b".repeat(40) },
      preserved: {},
    }),
  );
  execFileSync("zip", ["-q", "evidence.zip", "events-verification.json"], {
    cwd: root,
  });
  const bytes = await readFile(join(root, "evidence.zip"));
  const selection = {
    schema: 1,
    artifact_id: 456,
    artifact_digest: "sha256:" + hashBytes(bytes),
    release: "b".repeat(40),
    bootstrap: false,
  };
  const env = { RUNNER_TEMP: root, ACTIONS_GITHUB_TOKEN: "synthetic" };
  let count = 0;
  const fetcher = async (url, o) => {
    assert.equal(o.method, "GET");
    if (url.startsWith("https://api.github.com")) {
      assert.equal(o.headers.Authorization, "Bearer synthetic");
      return new Response(null, {
        status: 302,
        headers: {
          location: "https://production.blob.core.windows.net/signed",
        },
      });
    }
    assert.equal(o.headers, undefined);
    count++;
    return new Response(bytes);
  };
  await downloadEvidence(selection, env, fetcher);
  assert.equal(count, 1);
  await writeFile(
    join(root, "gather-release-selection.json"),
    JSON.stringify(selection),
  );
  assert.equal((await loadEvidence(env)).receipt.release, selection.release);
  await assert.rejects(
    downloadEvidence(
      { ...selection, artifact_digest: "sha256:" + "f".repeat(64) },
      env,
      fetcher,
    ),
    /ARCHIVE_DIGEST_MISMATCH/,
  );
  await assert.rejects(
    downloadEvidence(
      selection,
      env,
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://untrusted.invalid/" },
        }),
    ),
    /HOST_UNAPPROVED/,
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm, access, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  validateConfig,
  NetworkPolicy,
  CENTRAL,
  PROJECT,
  readPrivateConfig,
  sdkShim,
} from "./policy.mjs";
import { isolatedFixture } from "./fixture.mjs";
import { cleanupStale } from "./run.mjs";
import { PREFIX } from "./fixture.mjs";
import { spawnSync } from "node:child_process";
const config = () =>
  validateConfig({
    projectId: PROJECT,
    authDomain: PROJECT + ".firebaseapp.com",
    apiKey: "AIza" + "x".repeat(35),
    fictionalPhoneNumbers: ["+15005550121"],
    acknowledgeFirebaseFictionalNumbers: true,
    acknowledgeProviderTestUserRecord: true,
  });
const api = (c, path) =>
  "https://identitytoolkit.googleapis.com/v1/" + path + "?key=" + c.apiKey;
test("private configuration requires explicit fictional/provider-record acknowledgement and never accepts codes or arbitrary projects", () => {
  const c = config();
  assert.equal(c.projectId, PROJECT);
  for (const delta of [
    { projectId: "other-project" },
    { acknowledgeFirebaseFictionalNumbers: false },
    { verificationCode: "123456" },
    { fictionalPhoneNumbers: [] },
    { fictionalPhoneNumbers: ["not-a-phone"] },
  ])
    assert.throws(() => validateConfig({ ...c, ...delta }));
  assert.ok(sdkShim(c).includes("appVerificationDisabledForTesting=true"));
  assert.ok(sdkShim(c).includes("__gatherFictionalPermit"));
});
test("live captcha tokens, unknown numbers, unapproved endpoints and arbitrary key/project requests are blocked before network", () => {
  const c = config(),
    p = new NetworkPolicy(c),
    send = api(c, "accounts:sendVerificationCode");
  assert.throws(
    () => p.permit("+15005550122", "a".repeat(50)),
    /PHONE_NOT_APPROVED/,
  );
  assert.throws(
    () => p.permit(c.fictionalPhoneNumbers[0], "live-recaptcha-token"),
    /LIVE_CAPTCHA_TOKEN_BLOCKED/,
  );
  const body = JSON.stringify({
    phoneNumber: c.fictionalPhoneNumbers[0],
    recaptchaToken: "a".repeat(50),
    clientType: "CLIENT_TYPE_WEB",
    captchaResponse: "NO_RECAPTCHA",
    recaptchaVersion: "RECAPTCHA_ENTERPRISE",
  });
  assert.throws(
    () => p.approveGoogle(send, "POST", body),
    /UNAPPROVED_SEND_BLOCKED/,
  );
  p.permit(c.fictionalPhoneNumbers[0], "a".repeat(50));
  for (const delta of [
    { captchaResponse: "live-proof" },
    { clientType: "OTHER" },
    { recaptchaVersion: "OTHER" },
    { tenantId: "other" },
  ])
    assert.throws(() =>
      p.approveGoogle(
        send,
        "POST",
        JSON.stringify({ ...JSON.parse(body), ...delta }),
      ),
    );
  assert.equal(p.approveGoogle(send, "POST", body), "fictional-send");
  assert.throws(
    () => p.approveGoogle(send, "POST", body),
    /UNAPPROVED_SEND_BLOCKED/,
  );
  for (const path of [
    "accounts:delete",
    "accounts:update",
    "accounts:signUp",
    "accounts:sendOobCode",
  ])
    assert.throws(() => p.approveGoogle(api(c, path), "POST", "{}"));
  assert.throws(() =>
    p.approveGoogle("https://api.cloudflare.com/client/v4/accounts", "GET"),
  );
  assert.throws(() => p.approveGoogle("https://example.invalid", "GET"));
  assert.throws(
    () => p.approveGoogle(send, "POST", body, "captcha"),
    /PROVIDER_WRITE_BLOCKED/,
  );
  assert.throws(
    () => p.approveGoogle(send.replace(c.apiKey, "other"), "POST", body),
    /PROJECT_KEY_MISMATCH/,
  );
});
test("provider sessions/refresh tokens are limited to the approved fictional identity and test attempt ceiling", () => {
  const c = config(),
    p = new NetworkPolicy(c),
    body = (n) =>
      JSON.stringify({
        phoneNumber: c.fictionalPhoneNumbers[0],
        recaptchaToken: String(n).repeat(50),
      });
  for (let i = 1; i <= 3; i++) {
    p.permit(c.fictionalPhoneNumbers[0], String(i).repeat(50));
    assert.equal(
      p.approveGoogle(api(c, "accounts:sendVerificationCode"), "POST", body(i)),
      "fictional-send",
    );
  }
  p.permit(c.fictionalPhoneNumbers[0], "4".repeat(50));
  assert.throws(
    () =>
      p.approveGoogle(api(c, "accounts:sendVerificationCode"), "POST", body(4)),
    /TEST_ATTEMPT_LIMIT/,
  );
  assert.throws(() =>
    p.approveGoogle(
      api(c, "accounts:signInWithPhoneNumber"),
      "POST",
      JSON.stringify({ sessionInfo: "unknown", code: "123456" }),
    ),
  );
  p.capture("fictional-send", { sessionInfo: "synthetic-session" });
  assert.equal(
    p.approveGoogle(
      api(c, "accounts:signInWithPhoneNumber"),
      "POST",
      JSON.stringify({ sessionInfo: "synthetic-session", code: "123456" }),
    ),
    "fictional-confirm",
  );
  assert.throws(() =>
    p.approveGoogle(
      "https://securetoken.googleapis.com/v1/token?key=" + c.apiKey,
      "POST",
      "grant_type=refresh_token&refresh_token=unknown",
    ),
  );
});
test("backend transport never accepts a production management request, mismatched token or redirects", async () => {
  const p = new NetworkPolicy(config());
  let calls = 0;
  const transport = async (url, options) => {
    calls++;
    assert.equal(options.redirect, "error");
    return Response.json({ keys: [] });
  };
  await p.backendFetch(
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
    {},
    transport,
  );
  await assert.rejects(
    p.backendFetch("https://api.cloudflare.com/client/v4", {}, transport),
  );
  await assert.rejects(
    p.backendFetch(
      api(p.config, "accounts:lookup"),
      { method: "POST", body: JSON.stringify({ idToken: "unknown" }) },
      transport,
    ),
  );
  assert.equal(calls, 1);
});
test("private config files must be outside the repository and owner-readable only", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gather-private-config-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "private.json");
  await writeFile(file, JSON.stringify(config()), { mode: 0o600 });
  assert.equal(
    (await readPrivateConfig(file, process.cwd())).projectId,
    PROJECT,
  );
  await chmod(file, 0o644);
  await assert.rejects(
    readPrivateConfig(file, process.cwd()),
    /CONFIG_REQUIRES_OWNER_ONLY_PERMISSIONS/,
  );
  await chmod(file, 0o600);
  await assert.rejects(
    readPrivateConfig(file, dir),
    /CONFIG_MUST_BE_OUTSIDE_REPOSITORY/,
  );
});
test("isolated fixtures seed one invited identity, two contexts, block unapproved phones and remove SQLite/profile data", async () => {
  const f = await isolatedFixture(config()),
    directory = f.directory;
  try {
    assert.equal(
      f.store.all("SELECT id FROM users WHERE role='host'").length,
      2,
    );
    assert.equal(
      f.store.all("SELECT DISTINCT identity FROM guest_identity_links").length,
      1,
    );
    assert.equal(f.store.list("person-account", "platform").length, 0);
    assert.equal(f.records.length, 2);
    assert.ok(f.invitation.startsWith(CENTRAL + "/invite/"));
    const r = await fetch(f.sites.get(CENTRAL).url + "/api/firebase/start", {
      method: "POST",
      headers: { Origin: CENTRAL, "Content-Type": "application/json" },
      body: JSON.stringify({
        first: "Firebase",
        last: "Test Guest",
        phone: "+15005550122",
      }),
    });
    assert.equal(r.status, 403);
    assert.equal(f.store.list("firebase-attempt", "platform").length, 0);
    await mkdir(f.profile);
    await writeFile(join(f.profile, "synthetic-cookie"), "synthetic");
  } finally {
    await f.close();
  }
  await assert.rejects(access(directory));
});

test("manual real-provider runner is opt-in and prints no private configuration without explicit arguments", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/firebase-test/run.mjs"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /USAGE_REAL_FICTIONAL_CONFIG_REQUIRED/);
  assert.equal(result.stdout, "");
});

test("stale cleanup removes only marked owned dead-process directories", async (t) => {
  const active = await mkdtemp(join(tmpdir(), PREFIX)),
    dead = await mkdtemp(join(tmpdir(), PREFIX)),
    unrelated = await mkdtemp(join(tmpdir(), "unrelated-gather-"));
  t.after(() =>
    Promise.all(
      [active, dead, unrelated].map((path) =>
        rm(path, { recursive: true, force: true }),
      ),
    ),
  );
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(child.status, 0);
  await writeFile(
    join(active, "owner.json"),
    JSON.stringify({ kind: PREFIX, pid: process.pid }),
  );
  await writeFile(
    join(dead, "owner.json"),
    JSON.stringify({ kind: PREFIX, pid: child.pid }),
  );
  await writeFile(
    join(unrelated, "owner.json"),
    JSON.stringify({ kind: PREFIX, pid: child.pid }),
  );
  await cleanupStale();
  await assert.rejects(access(dead));
  await access(active);
  await access(unrelated);
});

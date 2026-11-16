import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/node-store.js";
import { deviceFixture, origin } from "./helpers/passwordless-device.js";
import { password } from "./helpers/application.js";
import { ensurePersonalProfile } from "../server/personal-accounts.js";
import {
  validPasswordlessSession,
  authHash,
  subjectByKey,
  passwordlessContact,
} from "../server/passwordless.js";
import {
  DEVICE_SESSION_EXPIRY,
  DEVICE_COOKIE_SECONDS,
  DEVICE_ROTATION_MS,
  DEVICE_ROTATION_GRACE_MS,
  refreshDeviceSession,
  persistentProof,
} from "../server/device-sessions.js";
const P = "platform";
function age(store, hash) {
  const p = store.get("passwordless-session", hash, P);
  store.put(
    "passwordless-session",
    hash,
    P,
    { ...p, rotatedAt: Date.now() - DEVICE_ROTATION_MS - 1 },
    p.version,
  );
}
test("SMS devices use secure persistent cookies and survive six months of inactivity and SQLite restart", async (t) => {
  const f = await deviceFixture(t),
    signed = await f.login();
  assert.match(signed.setCookie, /HttpOnly/);
  assert.match(signed.setCookie, /Secure/);
  assert.match(signed.setCookie, /SameSite=Strict/);
  assert.match(signed.setCookie, /Expires=/);
  assert.match(
    signed.setCookie,
    new RegExp("Max-Age=" + DEVICE_COOKIE_SECONDS),
  );
  assert.doesNotMatch(signed.setCookie, /Domain=/i);
  assert.equal(
    f.store.one("SELECT expires FROM sessions WHERE token=?", signed.hash)
      .expires,
    DEVICE_SESSION_EXPIRY,
  );
  const dir = await mkdtemp(join(tmpdir(), "gather-persistent-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "isolated.sqlite");
  f.store.run("VACUUM INTO ?", path);
  const db = new Store(path);
  t.after(() => db.db.close());
  const now = Date.now;
  t.after(() => {
    Date.now = now;
  });
  Date.now = () => now() + 180 * 86400000;
  const resumed = db.session(signed.raw, origin);
  assert.ok(resumed);
  assert.equal(validPasswordlessSession(db, resumed), true);
  const next = refreshDeviceSession(db, resumed, signed.raw, origin);
  assert.ok(next);
  assert.notEqual(next.auth.token, signed.raw);
  assert.equal(
    db.session(next.auth.token, origin).expires,
    DEVICE_SESSION_EXPIRY,
  );
  assert.equal(f.messages.length, 1, "ordinary return sends no new SMS");
});
test("daily rotation is atomic, handles concurrent requests, expires old credentials and stores no raw replacement", async (t) => {
  const f = await deviceFixture(t),
    signed = await f.login();
  age(f.store, signed.hash);
  const [a, b] = await Promise.all([
    f.request("/api/session", { cookie: signed.cookie }),
    f.request("/api/session", { cookie: signed.cookie }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.ok(a.cookie);
  assert.equal(a.cookie, b.cookie);
  assert.notEqual(a.cookie, signed.cookie);
  const raw = a.cookie.split("=")[1],
    row = f.store.get("session-rotation", signed.hash, P);
  assert.equal(row.target, authHash(raw));
  assert.ok(row.box);
  assert.equal(
    JSON.stringify(f.store.list("session-rotation", P)).includes(raw),
    false,
  );
  assert.equal(f.store.session(signed.raw, "https://other.example"), null);
  f.store.put(
    "session-rotation",
    row.id,
    P,
    { ...row, expires: Date.now() - 1 },
    row.version,
  );
  assert.equal(
    (await f.request("/api/session", { cookie: signed.cookie })).body.role,
    null,
  );
  assert.equal(
    (await f.request("/api/session", { cookie: a.cookie })).body.role,
    "host",
  );
  assert.equal(f.messages.length, 1);
});
test("current-device sign-out revokes its rotated token and every handoff clone, retaining another device", async (t) => {
  const f = await deviceFixture(t),
    first = await f.login(),
    second = await f.login();
  const firstProof = f.store.get("passwordless-session", first.hash, P);
  const clone = f.store.newSession(
    {
      role: "host",
      user: f.host.user,
      household: f.host.household.id,
      passwordless: true,
    },
    "https://alpha.ilymmd.com",
  );
  f.store.put(
    "passwordless-session",
    authHash(clone.token),
    P,
    persistentProof({ ...firstProof }),
  );
  age(f.store, first.hash);
  const rotated = await f.request("/api/session", { cookie: first.cookie });
  assert.ok(rotated.cookie);
  const exited = await f.request("/api/logout", {
    method: "POST",
    cookie: rotated.cookie,
    data: {},
  });
  assert.equal(exited.status, 200);
  for (const cookie of [first.cookie, rotated.cookie])
    assert.equal((await f.request("/api/session", { cookie })).body.role, null);
  assert.equal(f.store.session(clone.token, "https://alpha.ilymmd.com"), null);
  assert.equal(
    (await f.request("/api/session", { cookie: second.cookie })).body.role,
    "host",
  );
});
test("other-device and all-device sign-out revoke the intended devices including rotated credentials", async (t) => {
  const f = await deviceFixture(t),
    one = await f.login(),
    two = await f.login();
  age(f.store, two.hash);
  const rotated = await f.request("/api/session", { cookie: two.cookie });
  assert.equal(
    (
      await f.request("/api/passwordless/sessions/revoke", {
        method: "POST",
        cookie: one.cookie,
        data: {},
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.request("/api/session", { cookie: rotated.cookie })).body.role,
    null,
  );
  assert.equal(
    (await f.request("/api/session", { cookie: two.cookie })).body.role,
    null,
  );
  assert.equal(
    (await f.request("/api/session", { cookie: one.cookie })).body.role,
    "host",
  );
  const three = await f.login();
  const ended = await f.request("/api/passwordless/sessions/revoke-all", {
    method: "POST",
    cookie: one.cookie,
    data: {},
  });
  assert.equal(ended.status, 200);
  for (const cookie of [one.cookie, three.cookie])
    assert.equal((await f.request("/api/session", { cookie })).body.role, null);
});
test("guests and approved children retain durable sessions without receiving host authority", async (t) => {
  const f = await deviceFixture(t),
    guest = await f.guest(f.host),
    legacy = await f.guestLogin(f.host, guest);
  const guestSession = f.store.session(legacy.cookie.split("=")[1], origin),
    ready = ensurePersonalProfile(f.store, guestSession),
    account = f.store.get("person-account", ready.identity, P);
  f.store.put(
    "person-account",
    ready.identity,
    P,
    { ...account, recoveryPhone: "+15005550122", recoveryVerified: true },
    account?.version,
  );
  const person = ready.profile.members.find(
      (p) => p.identity === ready.identity,
    ),
    signed = await f.login(person, "+15005550122");
  assert.equal(
    (await f.request("/api/session", { cookie: signed.cookie })).body.role,
    "guest",
  );
  assert.equal(
    f.store.session(signed.raw, origin).expires,
    DEVICE_SESSION_EXPIRY,
  );
  const profile = f.store.get("personal-household", f.profile.id, P),
    child = {
      id: randomUUID(),
      identity: randomUUID(),
      first: "Riley",
      last: "",
      phone: "",
      parent: f.person.id,
    };
  f.store.put(
    "personal-household",
    profile.id,
    P,
    { ...profile, members: [...profile.members, child] },
    profile.version,
  );
  f.store.put("personal-member", child.identity, P, {
    profile: profile.id,
    member: child.id,
  });
  f.store.put("household-member", child.identity, f.host.household.id, {
    identity: child.identity,
    role: "child",
    status: "approved",
    allowSignIn: true,
  });
  f.store.put("passwordless-contact", "person:" + child.identity, P, {
    phone: "+15005550123",
    verified: true,
  });
  const kid = await f.login(child, "+15005550123");
  assert.equal(f.store.session(kid.raw, origin).expires, DEVICE_SESSION_EXPIRY);
  assert.equal(
    (await f.request("/api/session", { cookie: kid.cookie })).body
      .householdRole,
    "kid",
  );
  assert.equal(
    (await f.request("/api/host", { cookie: kid.cookie })).status,
    403,
  );
  const membership = f.store.get(
    "household-member",
    child.identity,
    f.host.household.id,
  );
  f.store.put(
    "household-member",
    child.identity,
    f.host.household.id,
    { ...membership, allowSignIn: false },
    membership.version,
  );
  assert.equal(
    (await f.request("/api/family", { cookie: kid.cookie })).status,
    403,
  );
});
test("administrator elevation expires independently of remembered sign-in and rotates without replay grace", async (t) => {
  const f = await deviceFixture(t);
  f.store.put("platform-access", f.host.user, P, {
    email: "alpha@example.test",
  });
  const signed = await f.login();
  const elevated = await f.request("/api/passwordless/admin/step-up", {
    method: "POST",
    cookie: signed.cookie,
    data: { password },
  });
  assert.equal(elevated.status, 200);
  assert.notEqual(elevated.cookie, signed.cookie);
  assert.equal(f.store.session(signed.raw, origin), null);
  assert.equal(
    (await f.request("/api/admin", { cookie: elevated.cookie })).status,
    200,
  );
  const raw = elevated.cookie.split("=")[1],
    hash = authHash(raw),
    proof = f.store.get("passwordless-session", hash, P);
  f.store.put(
    "passwordless-session",
    hash,
    P,
    { ...proof, adminUntil: Date.now() - 1 },
    proof.version,
  );
  const remembered = (
    await f.request("/api/session", { cookie: elevated.cookie })
  ).body;
  assert.equal(remembered.role, "host");
  assert.equal(remembered.platformAdmin, false);
  assert.equal(remembered.adminStepUpAvailable, true);
  assert.equal(
    (await f.request("/api/admin", { cookie: elevated.cookie })).status,
    403,
  );
  assert.equal(f.messages.length, 1);
});
test("admin revocation and verified-phone changes immediately invalidate durable devices and rotation aliases", async (t) => {
  const f = await deviceFixture(t),
    signed = await f.login();
  age(f.store, signed.hash);
  const rotated = await f.request("/api/session", { cookie: signed.cookie });
  const account = f.store.get("person-account", f.identity, P);
  f.store.put(
    "person-account",
    f.identity,
    P,
    { ...account, recoveryPhone: "+15005550999" },
    account.version,
  );
  assert.equal(
    (await f.request("/api/host", { cookie: rotated.cookie })).status,
    401,
  );
  assert.equal(
    (await f.request("/api/host", { cookie: signed.cookie })).status,
    401,
  );
});

test("administrator revocation invalidates all durable tokens including rotation grace", async (t) => {
  const f = await deviceFixture(t),
    one = await f.login(),
    two = await f.login();
  age(f.store, one.hash);
  const rotated = await f.request("/api/session", { cookie: one.cookie });
  const result = await f.request("/api/admin/account", {
    method: "POST",
    cookie: f.admin,
    data: { id: "user:" + f.host.user, action: "revoke", password },
  });
  assert.equal(result.status, 200);
  for (const cookie of [one.cookie, rotated.cookie, two.cookie])
    assert.equal((await f.request("/api/session", { cookie })).body.role, null);
});
test("unexpired earlier SMS sessions upgrade in place; expired credentials are never resurrected", async (t) => {
  const f = await deviceFixture(t),
    one = await f.login();
  const proof = f.store.get("passwordless-session", one.hash, P);
  f.store.put(
    "passwordless-session",
    one.hash,
    P,
    { ...proof, persistent: false, deviceId: null },
    proof.version,
  );
  f.store.run(
    "UPDATE sessions SET expires=? WHERE token=?",
    Date.now() + 60000,
    one.hash,
  );
  const upgraded = await f.request("/api/session", { cookie: one.cookie });
  assert.equal(upgraded.body.role, "host");
  assert.ok(upgraded.cookie);
  assert.equal(
    f.store.session(upgraded.cookie.split("=")[1], origin).expires,
    DEVICE_SESSION_EXPIRY,
  );
  const two = await f.login();
  f.store.run(
    "UPDATE sessions SET expires=? WHERE token=?",
    Date.now() - 1,
    two.hash,
  );
  assert.equal(
    (await f.request("/api/session", { cookie: two.cookie })).body.role,
    null,
  );
  assert.equal(f.messages.length, 2);
});

test("corrupt or wrong-origin rotation receipts fail closed without invalidating the current device", async (t) => {
  const f = await deviceFixture(t),
    signed = await f.login();
  age(f.store, signed.hash);
  const rotated = await f.request("/api/session", { cookie: signed.cookie });
  const receipt = f.store.get("session-rotation", signed.hash, P);
  f.store.put(
    "session-rotation",
    receipt.id,
    P,
    { ...receipt, box: "invalid" },
    receipt.version,
  );
  assert.equal(
    (await f.request("/api/session", { cookie: signed.cookie })).body.role,
    null,
  );
  assert.equal(
    (await f.request("/api/session", { cookie: rotated.cookie })).body.role,
    "host",
  );
});

test("pausing new SMS sign-in preserves existing device access and its sign-out controls", async (t) => {
  const f = await deviceFixture(t),
    signed = await f.login();
  f.runtimeEnv.PASSWORDLESS_ENABLED = "false";
  assert.equal(
    (await f.request("/api/session", { cookie: signed.cookie })).body.role,
    "host",
  );
  assert.equal(
    (
      await f.request("/api/passwordless/start", {
        method: "POST",
        cookie: signed.cookie,
        data: {},
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await f.request("/api/passwordless/sessions/revoke-all", {
        method: "POST",
        cookie: signed.cookie,
        data: {},
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.request("/api/session", { cookie: signed.cookie })).body.role,
    null,
  );
});

test("password changes revoke remembered credentials on every origin, including guest handoffs", async (t) => {
  const f = await deviceFixture(t),
    signed = await f.login();
  const proof = f.store.get("passwordless-session", signed.hash, P);
  const clone = f.store.newSession(
    {
      role: "host",
      user: f.host.user,
      household: f.host.household.id,
      passwordless: true,
    },
    "https://alpha.ilymmd.com",
  );
  const token = authHash(clone.token);
  // A destination handoff intentionally has no host authority or SQL user.
  f.store.run(
    "UPDATE sessions SET user=NULL,role='guest' WHERE token=?",
    token,
  );
  f.store.put("passwordless-session", token, P, persistentProof(proof));
  const changed = await f.request("/api/family/password", {
    method: "PUT",
    cookie: signed.cookie,
    data: { currentPassword: password, password: "Replacement-password-123!" },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(
    f.store.one("SELECT token FROM sessions WHERE token=?", token),
    undefined,
  );
  assert.equal(
    (await f.request("/api/session", { cookie: signed.cookie })).body.role,
    null,
  );
  assert.equal(f.messages.length, 1);
});

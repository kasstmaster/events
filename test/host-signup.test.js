import test from "node:test";
import { createHash } from "node:crypto";
import { persistentHostSession } from "../server/host-signup.js";
import assert from "node:assert/strict";
import { application, password } from "./helpers/application.js";
const env = { HOST_SIGNUP_INVITATIONS_ENABLED: "true" };

test("host signup is default-off; signup URL cannot replace independent email ownership", async (t) => {
  const off = await application(t);
  assert.equal(
    (
      await off.request("/api/admin/host-signup-invitations", {
        method: "POST",
        cookie: off.admin,
        data: { email: "new@example.test", password },
      })
    ).status,
    404,
  );
  const sent = [],
    f = await application(t, env, {
      hostVerificationSender: async (message) => sent.push(message),
    }),
    host = await f.host("Existing");
  const path = "/api/admin/host-signup-invitations",
    input = { email: "new@example.test", password };
  assert.equal(
    (
      await f.request(path, {
        method: "POST",
        cookie: host.cookie,
        data: input,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(path, {
        method: "POST",
        cookie: f.admin,
        data: { ...input, password: "wrong" },
      })
    ).status,
    403,
  );
  const issued = await f.request(path, {
    method: "POST",
    cookie: f.admin,
    data: input,
  });
  assert.equal(issued.status, 201);
  const invite = new URL(issued.body.url).hash.slice("#invite=".length);
  assert.equal(
    (
      await f.request("/api/register", {
        method: "POST",
        data: { email: input.email, password, name: "New Family" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/host-signup/complete", {
        method: "POST",
        data: { verification: invite },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/host-signup/email", {
        method: "POST",
        data: {
          invite,
          email: "wrong@example.test",
          password,
          name: "New Family",
        },
      })
    ).status,
    403,
  );
  const begin = await f.request("/api/host-signup/email", {
    method: "POST",
    data: { invite, email: input.email, password, name: "New Family" },
  });
  assert.equal(begin.status, 200);
  assert.deepEqual(begin.body, { ok: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].email, input.email);
  const verification = new URL(sent[0].url).hash.slice("#verify=".length);
  assert.equal(
    (
      await f.request("/api/host-signup/complete", {
        method: "POST",
        data: { verification },
      })
    ).status,
    403,
  );
  const done = await f.request("/api/host-signup/complete", {
    method: "POST",
    cookie: begin.cookie,
    data: { verification },
  });
  assert.equal(done.status, 201);
  assert.equal(
    (await f.request("/api/host", { cookie: done.cookie })).status,
    200,
  );
  assert.equal(
    (await f.request("/api/admin", { cookie: done.cookie })).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/host-signup/complete", {
        method: "POST",
        cookie: begin.cookie,
        data: { verification },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/login", {
        method: "POST",
        data: { email: input.email, password },
      })
    ).status,
    200,
  );
  const repeatLogin = await f.request("/api/login", {
    method: "POST",
    data: { email: input.email, password },
  });
  const repeatKey = createHash("sha256")
    .update(repeatLogin.cookie.split("=")[1])
    .digest("hex");
  assert.equal(
    f.store.get("passwordless-session", repeatKey, "platform").provider,
    "host-account",
  );
  const user = f.store.one("SELECT * FROM users WHERE email=?", input.email);
  f.store.run(
    "UPDATE users SET password=? WHERE id=?",
    "changed-security-stamp",
    user.id,
  );
  assert.equal(
    (await f.request("/api/host", { cookie: done.cookie })).status,
    401,
  );
  const audits = JSON.stringify(
    f.store.list("account-admin-audit", "platform"),
  );
  for (const secret of [invite, verification, password])
    assert.equal(audits.includes(secret), false);
});

test("missing mail transport fails closed without creating accounts or legacy approvals", async (t) => {
  const f = await application(t, env);
  const issued = await f.request("/api/admin/host-signup-invitations", {
    method: "POST",
    cookie: f.admin,
    data: { email: "new@example.test", password },
  });
  assert.equal(issued.status, 201);
  const invite = new URL(issued.body.url).hash.slice(8),
    data = { invite, email: "new@example.test", password, name: "New" };
  assert.equal(
    (await f.request("/api/host-signup/email", { method: "POST", data }))
      .status,
    503,
  );
  assert.equal(
    f.store.one("SELECT id FROM users WHERE email=?", data.email),
    undefined,
  );
  assert.equal(
    f.store.one("SELECT email FROM approvals WHERE email=?", data.email),
    undefined,
  );
});

test("expired signup invites cannot request email verification or create approvals", async (t) => {
  let sends = 0;
  const f = await application(t, env, {
    hostVerificationSender: async () => {
      sends++;
    },
  });
  const issued = await f.request("/api/admin/host-signup-invitations", {
    method: "POST",
    cookie: f.admin,
    data: { email: "expired@example.test", password },
  });
  const invite = new URL(issued.body.url).hash.slice(8),
    key = createHash("sha256").update(invite).digest("hex"),
    record = f.store.get("host-signup-invitation", key, "platform");
  f.store.put(
    "host-signup-invitation",
    key,
    "platform",
    { ...record, expires: Date.now() - 1 },
    record.version,
  );
  assert.equal(
    (
      await f.request("/api/host-signup/email", {
        method: "POST",
        data: { invite, email: record.email, name: "Expired", password },
      })
    ).status,
    403,
  );
  assert.equal(sends, 0);
  assert.equal(
    f.store.one("SELECT email FROM approvals WHERE email=?", record.email),
    undefined,
  );
});

test("native host devices persist independently, rotate and revoke without guest-account linking", async (t) => {
  const f = await application(t),
    host = await f.host("Alpha"),
    origin = "http://127.0.0.1:3000",
    account = { user: host.user, household: host.household.id, role: "host" };
  const a = persistentHostSession(f.store, account, origin),
    b = persistentHostSession(f.store, account, origin),
    cookie = (auth) => "events_session=" + auth.token;
  assert.equal(a.persistent, true);
  const key = createHash("sha256").update(a.token).digest("hex"),
    proof = f.store.get("passwordless-session", key, "platform");
  f.store.put(
    "passwordless-session",
    key,
    "platform",
    { ...proof, rotatedAt: Date.now() - 2 * 86400000 },
    proof.version,
  );
  const rotated = await f.request("/api/host", { cookie: cookie(a) });
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.cookie, cookie(a));
  assert.equal(
    (
      await f.request("/api/logout", {
        method: "POST",
        cookie: rotated.cookie,
        data: {},
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.request("/api/host", { cookie: cookie(a) })).status,
    401,
  );
  assert.equal(
    (await f.request("/api/host", { cookie: cookie(b) })).status,
    200,
  );
  assert.equal(
    (
      await f.request("/api/passwordless/sessions/revoke-all", {
        method: "POST",
        cookie: cookie(b),
        data: {},
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.request("/api/host", { cookie: cookie(b) })).status,
    401,
  );
  assert.equal(f.store.all("SELECT * FROM guest_identity_links").length, 0);
  assert.equal(f.store.list("guest", host.household.id).length, 0);
});

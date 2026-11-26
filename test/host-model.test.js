import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { application, password } from "./helpers/application.js";
import { publicEventReference } from "../server/public-invitations.js";
import { verifyGoogleHostToken } from "../server/google-host.js";
const mode = {
  HOST_ONLY_MODEL_ENABLED: "true",
  HOST_ONLY_MODEL_ACTIVATION_APPROVED: "true",
};
async function prepare(f) {
  const plan = await f.request("/api/admin/host-transition", {
    method: "POST",
    cookie: f.admin,
    data: { password },
  });
  assert.equal(plan.status, 200);
  const result = await f.request("/api/admin/host-transition", {
    method: "POST",
    cookie: f.admin,
    data: {
      password,
      operation: "prepare",
      fingerprint: plan.body.fingerprint,
      confirm: "PREPARE HOST-ONLY TRANSITION",
      approvedAdults: plan.body.households.flatMap((h) =>
        h.users.map((u) => u.id),
      ),
    },
  });
  assert.equal(result.status, 200);
  return result;
}
test("only a password-confirmed administrator can prepare before enabling host-only mode", async (t) => {
  const f = await application(t);
  const host = await f.host("Alpha");
  const path = "/api/admin/host-transition";
  for (const [cookie, candidatePassword] of [
    [host.cookie, password],
    [f.admin, "incorrect-password"],
  ]) {
    const result = await f.request(path, {
      method: "POST",
      cookie,
      data: { password: candidatePassword },
    });
    assert.equal(result.status, 403);
  }
  await prepare(f);
  const config = await f.request("/api/host-auth/config");
  assert.equal(config.body.enabled, false);
  assert.equal(
    (await f.request("/api/host", { cookie: host.cookie })).status,
    200,
  );
});
test("transition prepares historical invitations without inventing a household owner", async (t) => {
  const f = await application(t);
  const host = await f.host("Alpha");
  const guest = await f.guest(host);
  const event = await f.event(host, [guest]);
  f.store.run("DELETE FROM family_owners WHERE household=?", host.household.id);
  f.store.run("DELETE FROM users WHERE household=?", host.household.id);
  await prepare(f);
  assert.equal(f.store.household(host.household.id).name, "Alpha");
  assert.equal(f.store.list("host-family-roster", host.household.id).length, 0);
  assert.equal(f.store.list("guest", host.household.id).length, 1);
  assert.equal(f.store.list("event", host.household.id)[0].id, event.id);
});
test("replacement mode retires guest authorities and preserves independent recipients/history", async (t) => {
  const f = await application(t, mode),
    a = await f.host("Alpha"),
    b = await f.host("Beta");
  assert.equal(
    (await f.request("/api/host", { cookie: a.cookie })).status,
    503,
  );
  await prepare(f);
  const guest = await f.guest(a),
    duplicate = await f.guest(b),
    event = await f.event(a, [guest]);
  assert.notEqual(guest.inviteCode, duplicate.inviteCode);
  const legacy = f.store.newSession(
    { household: a.household.id, guest: guest.id, role: "guest" },
    "http://127.0.0.1:3000",
  );
  const cookie = "events_session=" + legacy.token;
  assert.equal((await f.request("/api/session", { cookie })).body.role, null);
  for (const path of [
    "/api/guest",
    "/api/personal/contacts",
    "/api/firebase/config",
    "/api/passwordless/start",
    "/api/host/guest-matches",
    "/api/central/approve",
  ])
    assert.equal(
      (await f.request(path, { method: "POST", cookie, data: {} })).status,
      410,
      path,
    );
  assert.equal((await f.guestLogin(a, guest)).status, 410);
  assert.equal(
    (await f.request("/api/host", { cookie: a.cookie })).body.receivedEvents
      .length,
    0,
  );
  assert.equal(f.store.list("guest", a.household.id).length, 1);
  assert.equal(f.store.list("guest", b.household.id).length, 1);
  const reference = publicEventReference(f.store, a.household.id, event.id);
  assert.equal(
    (await f.request(`/api/public/events/${reference}`, { cookie: b.cookie }))
      .status,
    200,
  );
  assert.deepEqual(
    (await f.request(`/api/public/events/${reference}`)).body.events[0].members,
    [],
  );
});
test("local family roster uses no guest accounts, batch children and stable RSVP identities", async (t) => {
  const f = await application(t, mode),
    h = await f.host("Alpha");
  await prepare(f);
  const before = await f.request("/api/personal", { cookie: h.cookie });
  const profile = before.body.profile,
    parent = profile.members.find((m) => m.owner);
  const saved = await f.request("/api/personal/family", {
    method: "PUT",
    cookie: h.cookie,
    version: profile.version,
    data: {
      ...profile,
      members: [
        ...profile.members,
        {
          first: "Riley",
          last: "Discard",
          phone: "+15005550123",
          parent: parent.id,
          suffix: "Jr",
          sharedAddress: "physical",
        },
        { first: "Sam", parent: parent.id, sharedAddress: "physical" },
      ],
    },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.profile.members.length, 3);
  assert.equal(saved.body.profile.members[1].last, "");
  assert.equal(saved.body.profile.members[1].phone, "");
  const event = await f.event(h, []),
    roster = await f.request(`/api/host/events/${event.id}/family-rsvp`, {
      cookie: h.cookie,
    });
  assert.equal(roster.body.members.length, 3);
  assert.equal(roster.body.members[0].id, parent.rsvpID);
  assert.equal(f.store.list("guest", h.household.id).length, 0);
  assert.equal(f.store.all("SELECT * FROM guest_identity_links").length, 0);
});
const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "synthetic",
  alg: "RS256",
  use: "sig",
};
const google = {
  HOST_SIGNUP_INVITATIONS_ENABLED: "true",
  HOST_GOOGLE_CLIENT_ID: "synthetic.apps.googleusercontent.com",
  HOST_GOOGLE_CLIENT_SECRET: "synthetic-test-only-secret",
};
function jwt(nonce, overrides = {}) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "synthetic" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "https://accounts.google.com",
      aud: google.HOST_GOOGLE_CLIENT_ID,
      sub: "synthetic-google-adult",
      nonce,
      email: "new@example.test",
      email_verified: true,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      ...overrides,
    }),
  ).toString("base64url");
  const data = header + "." + payload;
  return (
    data +
    "." +
    sign("RSA-SHA256", Buffer.from(data), privateKey).toString("base64url")
  );
}
test("Google uses actual OIDC signatures, invited verified email and a one-shot browser-bound PKCE exchange", async (t) => {
  let nonce = "",
    calls = [];
  const fetcher = async (url, options) => {
    calls.push(url);
    if (url.endsWith("/certs")) return Response.json({ keys: [jwk] });
    assert.equal(url, "https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(options.body);
    assert.equal(
      body.get("redirect_uri"),
      "http://127.0.0.1:3000/api/host-auth/google/callback",
    );
    assert.ok(body.get("code_verifier"));
    return Response.json({ id_token: jwt(nonce) });
  };
  const f = await application(t, google, { hostGoogleFetcher: fetcher });
  const issued = await f.request("/api/admin/host-signup-invitations", {
    method: "POST",
    cookie: f.admin,
    data: { email: "new@example.test", password },
  });
  const invite = new URL(issued.body.url).hash.slice(8);
  const start = await f.request("/api/host-auth/google/start", {
    method: "POST",
    data: {
      intent: "signup",
      invite,
      email: "new@example.test",
      name: "New Family",
    },
  });
  assert.equal(start.status, 200);
  const url = new URL(start.body.url);
  nonce = url.searchParams.get("nonce");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  const callback =
    f.url +
    "/api/host-auth/google/callback?state=" +
    url.searchParams.get("state") +
    "&code=synthetic-code";
  const missing = await fetch(callback, { redirect: "manual" });
  assert.equal(missing.headers.get("location"), "/signin#host=google-failed");
  const result = await fetch(callback, {
    redirect: "manual",
    headers: { Cookie: start.cookie },
  });
  assert.equal(result.headers.get("location"), "/signin#host=complete");
  assert.equal(
    f.store.one("SELECT role FROM users WHERE email=?", "new@example.test")
      .role,
    "host",
  );
  assert.equal(f.store.list("host-google-account", "platform").length, 1);
  const repeat = await fetch(callback, {
    redirect: "manual",
    headers: { Cookie: start.cookie },
  });
  assert.equal(repeat.headers.get("location"), "/signin#host=google-failed");
  assert.equal(calls.filter((s) => s.includes("/token")).length, 1);
  await assert.rejects(
    verifyGoogleHostToken(
      jwt(nonce, { email_verified: false }),
      google,
      nonce,
      { fetcher },
    ),
    /verification/,
  );
  await assert.rejects(
    verifyGoogleHostToken(
      jwt(nonce, { aud: "other.apps.googleusercontent.com" }),
      google,
      nonce,
      { fetcher },
    ),
    /verification/,
  );
  await assert.rejects(
    verifyGoogleHostToken(jwt("wrong"), google, nonce, { fetcher }),
    /verification/,
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { application, password } from "./helpers/application.js";
import { ensurePersonalProfile } from "../server/personal-accounts.js";
import {
  startPasswordless,
  runPasswordlessMessages,
  authHash,
} from "../server/passwordless.js";
import { platformAdministrator } from "../server/platform-access.js";
const origin = "https://gather.ilymmd.com";
const configured = {
  PASSWORDLESS_ENABLED: "true",
  PASSWORDLESS_ACTIVATION_APPROVED: "true",
  GATHER_UNIVERSAL_ENABLED: "true",
  GATHER_PWA_ENABLED: "true",
  AUTH_SMS_ENABLED: "true",
  SMS_ENABLED: "true",
  TWILIO_ACCOUNT_SID: "synthetic",
  TWILIO_AUTH_TOKEN: "synthetic",
  TWILIO_FROM: "+15005550006",
};
const nonce = () => randomBytes(32).toString("base64url");
async function fixture(t, env = configured) {
  const f = await application(t, env, {
      origin,
      householdHosts: new Set(["alpha.ilymmd.com", "beta.ilymmd.com"]),
    }),
    host = await f.host("Alpha");
  const { identity, profile } = ensurePersonalProfile(f.store, {
    role: "host",
    user: host.user,
    household: host.household.id,
  });
  f.store.put(
    "personal-household",
    profile.id,
    "platform",
    {
      ...profile,
      members: profile.members.map((p) => ({
        ...p,
        first: "Alex",
        last: "Example",
        phone: "+15005550123",
      })),
    },
    profile.version,
  );
  const account = f.store.get("person-account", identity, "platform");
  f.store.put(
    "person-account",
    identity,
    "platform",
    { ...account, recoveryPhone: "+15005550123", recoveryVerified: true },
    account.version,
  );
  const messages = [],
    fetcher = async (_url, options) => {
      messages.push(new URLSearchParams(options.body).get("Body"));
      return Response.json({ sid: "synthetic" });
    };
  const binding = nonce(),
    input = { first: "Alex", last: "Example", phone: "+15005550123" };
  const start = (value = input, extra = {}) =>
    startPasswordless(f.store, env, value, {
      origin,
      ip: "synthetic",
      binding,
      fetcher,
      ...extra,
    });
  const deliver = async () => {
    await runPasswordlessMessages(f.store, env, { fetcher });
    const value = messages.at(-1)?.match(/https:\/\/[^\s]+/)[0];
    return value ? new URL(value).hash.slice(1).split(".") : null;
  };
  const redeem = (
    [challenge, token],
    cookie = "__Host-gather_login=" + binding,
  ) =>
    f.request("/api/passwordless/redeem", {
      method: "POST",
      cookie,
      data: { challenge, token },
    });
  return {
    ...f,
    createHost: f.host,
    host,
    identity,
    env,
    messages,
    binding,
    input,
    start,
    deliver,
    redeem,
  };
}
test("passwordless remains disabled unless separately approved; legacy login remains available", async (t) => {
  const f = await fixture(t, {});
  assert.equal(
    (await f.request("/api/passwordless/config")).body.enabled,
    false,
  );
  assert.equal(
    (
      await f.request("/api/passwordless/start", {
        method: "POST",
        data: f.input,
      })
    ).status,
    404,
  );
  assert.equal(
    (await f.request("/api/host", { cookie: f.host.cookie })).status,
    200,
  );
  assert.equal((await f.request("/api/app/manifest")).status, 404);
});
test("SMS outbox stores no raw token; links bind to browser, expire, redeem exactly once and retain host identity", async (t) => {
  const f = await fixture(t);
  const response = await f.start();
  assert.equal(response.ok, true);
  assert.equal(f.messages.length, 0);
  const proof = await f.deliver();
  assert.ok(proof);
  assert.equal(
    JSON.stringify(f.store.list("passwordless-challenge", "platform")).includes(
      proof[1],
    ),
    false,
  );
  assert.equal(
    (await f.redeem(proof, "__Host-gather_login=" + nonce())).status,
    401,
  );
  const accepted = await f.redeem(proof);
  assert.equal(accepted.status, 200);
  const session = (await f.request("/api/session", { cookie: accepted.cookie }))
    .body;
  assert.equal(session.role, "host");
  assert.equal(session.passwordless, true);
  assert.equal(session.household.id, f.host.household.id);
  assert.equal((await f.redeem(proof)).status, 401);
  await f.start(f.input, { now: () => Date.now() + 61000 });
  const expired = await f.deliver();
  const row = f.store.get("passwordless-challenge", expired[0], "platform");
  f.store.put(
    "passwordless-challenge",
    row.id,
    "platform",
    { ...row, expires: Date.now() - 1 },
    row.version,
  );
  assert.equal((await f.redeem(expired)).status, 401);
});
test("missing, unverified and ambiguous matches get identical responses without sending; no accounts are claimed", async (t) => {
  const f = await fixture(t);
  const absent = await f.start({ ...f.input, first: "Unknown" });
  await f.deliver();
  assert.equal(f.messages.length, 0);
  const beta = await f.createHost("Beta"),
    { identity, profile } = ensurePersonalProfile(f.store, {
      role: "host",
      user: beta.user,
      household: beta.household.id,
    });
  f.store.put(
    "personal-household",
    profile.id,
    "platform",
    {
      ...profile,
      members: profile.members.map((p) => ({
        ...p,
        first: "Alex",
        last: "Example",
        phone: f.input.phone,
      })),
    },
    profile.version,
  );
  const acct = f.store.get("person-account", identity, "platform");
  f.store.put(
    "person-account",
    identity,
    "platform",
    { ...acct, recoveryPhone: f.input.phone, recoveryVerified: true },
    acct.version,
  );
  assert.deepEqual(await f.start(), absent);
  await f.deliver();
  assert.equal(f.messages.length, 0);
  assert.equal(f.store.all("SELECT id FROM users").length, 3);
});
test("STOP, disabled SMS, resend cooldown and changed verified phone fail closed without replaying messages", async (t) => {
  const f = await fixture(t);
  await f.start();
  await f.start();
  await f.deliver();
  assert.equal(f.messages.length, 1);
  const proof = new URL(f.messages[0].match(/https:\/\/[^\s]+/)[0]).hash
    .slice(1)
    .split(".");
  f.store.run("INSERT INTO sms_optouts VALUES(?,?)", f.input.phone, Date.now());
  assert.equal((await f.redeem(proof)).status, 401);
  f.store.run("DELETE FROM sms_optouts");
  const account = f.store.get("person-account", f.identity, "platform");
  f.store.put(
    "person-account",
    f.identity,
    "platform",
    { ...account, recoveryPhone: "+15005550124" },
    account.version,
  );
  assert.equal((await f.redeem(proof)).status, 401);
  const disabled = await fixture(t, {
    ...configured,
    AUTH_SMS_ENABLED: "false",
  });
  await disabled.start();
  await disabled.deliver();
  assert.equal(disabled.messages.length, 0);
});
test("SMS sessions never inherit platform administrator authority and may revoke other sessions", async (t) => {
  const f = await fixture(t);
  f.store.put("platform-access", f.host.user, "platform", {
    email: "alpha@example.test",
  });
  await f.start();
  const login = await f.redeem(await f.deliver());
  assert.equal(login.status, 200);
  assert.equal(
    (await f.request("/api/session", { cookie: login.cookie })).body
      .platformAdmin,
    false,
  );
  assert.equal(
    (await f.request("/api/admin", { cookie: login.cookie })).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/passwordless/sessions/revoke", {
        method: "POST",
        cookie: login.cookie,
        data: {},
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.request("/api/host", { cookie: f.host.cookie })).status,
    401,
  );
  assert.equal(
    (await f.request("/api/host", { cookie: login.cookie })).status,
    200,
  );
  assert.equal(
    (await f.request("/api/session", { cookie: login.cookie })).body
      .adminStepUpAvailable,
    true,
  );
  const strong = await f.request("/api/passwordless/admin/step-up", {
    method: "POST",
    cookie: login.cookie,
    data: { password },
  });
  assert.equal(strong.status, 200);
  assert.equal(
    (await f.request("/api/admin", { cookie: strong.cookie })).status,
    200,
  );
});
test("universal manifest uses Gather branding; household entry requires an active registered label", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/api/app/manifest")).body.name, "Gather");
  assert.equal(
    (await f.request("/api/passwordless/entry?label=alpha")).body.household.id,
    f.host.household.id,
  );
  assert.equal(
    (await f.request("/api/passwordless/entry?label=gather")).status,
    404,
  );
  assert.equal(
    (await f.request("/api/passwordless/entry?label=unknown")).status,
    404,
  );
});
test("QR enclosures use non-authenticating stable references, protect lookup and reject foreign/stale batches", async (t) => {
  const f = await fixture(t),
    guest = await f.guest(f.host),
    event = await f.event(f.host, [guest]);
  const path = "/api/host/events/" + event.id + "/rsvp-cards";
  const result = await f.request(path, {
    method: "POST",
    cookie: f.host.cookie,
    version: event.version,
    data: { guestIds: [guest.id] },
  });
  assert.equal(result.status, 200);
  const card = result.body.cards[0];
  assert.match(card.svg, /Scan to RSVP/);
  assert.match(
    card.url,
    /^https:\/\/gather\.ilymmd\.com\/invite\/[A-Za-z0-9_-]{43}$/,
  );
  assert.equal(card.svg.includes(guest.inviteCode), false);
  const repeat = await f.request(path, {
    method: "POST",
    cookie: f.host.cookie,
    version: event.version,
    data: { guestIds: [guest.id] },
  });
  assert.equal(repeat.body.cards[0].reference, card.reference);
  const resolve = "/api/invitations/" + card.reference + "/resolve";
  assert.deepEqual((await f.request(resolve)).body, {
    authenticated: false,
    entry: "alpha",
  });
  assert.equal(
    (await f.request(resolve, { cookie: f.host.cookie })).status,
    404,
  );
  assert.equal(
    (
      await f.request(path, {
        method: "POST",
        cookie: f.host.cookie,
        version: event.version + 1,
        data: { guestIds: [guest.id] },
      })
    ).status,
    409,
  );
});

test("cross-origin app handoff is target-browser-bound, single-use and source-session-bound", async (t) => {
  const f = await fixture(t);
  await f.start();
  const signed = await f.redeem(await f.deliver());
  const { createApp } = await import("../server/app.js"),
    { once } = await import("node:events");
  const targetOrigin = "https://alpha.ilymmd.com",
    server = createApp({
      store: f.store,
      origin: targetOrigin,
      canonicalOrigin: origin,
      env: configured,
      householdHostname: "alpha.ilymmd.com",
      householdHosts: new Set(["alpha.ilymmd.com"]),
      logger: { error() {} },
    });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const request = async (path, data, cookie) => {
    const response = await fetch(
      "http://127.0.0.1:" + server.address().port + path,
      {
        method: "POST",
        headers: {
          Origin: targetOrigin,
          "Content-Type": "application/json",
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: JSON.stringify(data),
      },
    );
    return {
      status: response.status,
      body: await response.json(),
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  };
  assert.equal(
    (
      await request("/api/passwordless/handoff/prepare", {
        source: "https://evil.example",
      })
    ).status,
    400,
  );
  const prepared = await request("/api/passwordless/handoff/prepare", {
    source: origin,
  });
  assert.equal(prepared.status, 200);
  const id = new URL(prepared.body.url).hash.split("=")[1];
  const auth = await f.request("/api/passwordless/handoff/authorize", {
    method: "POST",
    cookie: signed.cookie,
    data: { request: id },
  });
  assert.equal(auth.status, 200);
  const proof = new URL(auth.body.url).hash
    .slice("#transfer=".length)
    .split(".");
  assert.equal(
    (
      await request("/api/passwordless/handoff/redeem", {
        request: proof[0],
        token: proof[1],
      })
    ).status,
    401,
  );
  const accepted = await request(
    "/api/passwordless/handoff/redeem",
    { request: proof[0], token: proof[1] },
    prepared.cookie,
  );
  assert.equal(accepted.status, 200);
  assert.ok(accepted.cookie.startsWith("__Host-events_session="));
  assert.equal(
    (
      await request(
        "/api/passwordless/handoff/redeem",
        { request: proof[0], token: proof[1] },
        prepared.cookie,
      )
    ).status,
    401,
  );
  assert.equal(
    JSON.stringify(f.store.list("auth-handoff", "platform")).includes(proof[1]),
    false,
  );
});
test("QR references resolve only after invitation authorization and adapt to an approved guest-to-host upgrade", async (t) => {
  const f = await fixture(t),
    guest = await f.guest(f.host),
    event = await f.event(f.host, [guest]);
  const generated = await f.request(
    "/api/host/events/" + event.id + "/rsvp-cards",
    {
      method: "POST",
      cookie: f.host.cookie,
      version: event.version,
      data: { guestIds: [guest.id] },
    },
  );
  const reference = generated.body.cards[0].reference,
    endpoint = "/api/invitations/" + reference + "/resolve";
  const signed = await f.guestLogin(f.host, guest);
  assert.equal(
    (await f.request(endpoint, { cookie: signed.cookie })).body.destination,
    origin + "/alpha",
  );
  const identity = f.store.one(
    "SELECT identity FROM guest_identity_links WHERE household=? AND guest=?",
    f.host.household.id,
    guest.id,
  ).identity;
  const beta = await f.createHost("Beta"),
    account = f.store.get("person-account", identity, "platform");
  f.store.put(
    "person-account",
    identity,
    "platform",
    { ...account, hostUser: beta.user, hostHousehold: beta.household.id },
    account?.version,
  );
  const view = (await f.request(endpoint, { cookie: signed.cookie })).body;
  assert.equal(view.destination, "https://alpha.ilymmd.com/");
  assert.equal(view.invitationKey, event.id + ":" + guest.id);
  const uninvited = await f.request(
    "/api/host/events/" + event.id + "/uninvite-guests",
    {
      method: "POST",
      cookie: f.host.cookie,
      version: event.version,
      data: { guestIds: [guest.id] },
    },
  );
  assert.equal(uninvited.status, 200);
  assert.equal(
    (await f.request(endpoint, { cookie: signed.cookie })).status,
    404,
  );
});
test("administrator enrollment requires current administrator authentication and independent verification", async (t) => {
  const f = await fixture(t);
  const data = {
    subject: "user:" + f.host.user,
    phone: f.input.phone,
    version: 0,
    password,
    verifiedOutOfBand: true,
    consented: true,
  };
  assert.equal(
    (
      await f.request("/api/admin/passwordless/enroll", {
        method: "POST",
        cookie: f.host.cookie,
        data,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/admin/passwordless/enroll", {
        method: "POST",
        cookie: f.admin,
        data: { ...data, verifiedOutOfBand: false },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request("/api/admin/passwordless/enroll", {
        method: "POST",
        cookie: f.admin,
        data,
      })
    ).status,
    200,
  );
  assert.equal(
    f.store
      .list("account-admin-audit", "platform")
      .some((row) => row.action === "passwordless-enrollment"),
    true,
  );
});

test("legacy standalone child accounts cannot bypass central membership and Allow Sign-In", async (t) => {
  const f = await fixture(t);
  const childId = "synthetic-legacy-child";
  f.store.run(
    "INSERT INTO family_members(id,household,login,name,password,role) VALUES(?,?,?,?,?,?)",
    childId,
    f.host.household.id,
    "riley",
    "Riley",
    "",
    "kid",
  );
  f.store.put("central-user-info", childId, "platform", {
    first: "Riley",
    last: "",
    phone: "+15005550125",
  });
  f.store.put("passwordless-contact", "user:" + childId, "platform", {
    phone: "+15005550125",
    verified: true,
  });
  const legacySession = f.store.newSession(
    { user: childId, household: f.host.household.id, role: "family" },
    origin,
  );
  const legacyCookie = "__Host-events_session=" + legacySession.token;
  assert.equal(
    (await f.request("/api/session", { cookie: legacyCookie })).body.role,
    null,
  );
  assert.equal(
    (await f.request("/api/family", { cookie: legacyCookie })).status,
    403,
  );
  await f.start({ first: "Riley", last: "", phone: "+15005550125" });
  await f.deliver();
  assert.equal(f.messages.length, 0);
});

test("transactional authentication can be approved without enabling optional RSVP, reminder or e-vite SMS", async (t) => {
  const f = await fixture(t, { ...configured, SMS_ENABLED: "false" });
  await f.start();
  assert.ok(await f.deliver());
  assert.equal(f.messages.length, 1);
  assert.equal(f.store.list("rsvp-notification", "platform").length, 0);
});

test("legacy retirement requires separate approval and a successful migration; administrator recovery remains", async (t) => {
  const f = await fixture(t, {
    ...configured,
    PASSWORDLESS_RETIRE_LEGACY_APPROVED: "true",
  });
  await f.start();
  const signed = await f.redeem(await f.deliver());
  assert.equal(signed.status, 200);
  assert.equal(
    (
      await f.request("/api/login", {
        method: "POST",
        data: { email: "alpha@example.test", password },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/login", {
        method: "POST",
        data: { email: "admin@example.test", password },
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.request("/api/host", { cookie: f.host.cookie })).status,
    200,
  );
  assert.equal(f.store.list("passwordless-activation", "platform").length, 1);
});

test("system administrators use the shared SMS sign-in without gaining administration until a separate strong step-up", async (t) => {
  const f = await fixture(t),
    admin = f.store.one("SELECT id FROM users WHERE role='admin'");
  f.store.put("central-user-info", admin.id, "platform", {
    first: "Admin",
    last: "Owner",
    phone: "+15005550129",
  });
  const enrolled = await f.request("/api/admin/passwordless/enroll", {
    method: "POST",
    cookie: f.admin,
    data: {
      subject: "user:" + admin.id,
      phone: "+15005550129",
      version: 0,
      password,
      verifiedOutOfBand: true,
      consented: true,
    },
  });
  assert.equal(enrolled.status, 200);
  await f.start({ first: "Admin", last: "Owner", phone: "+15005550129" });
  const signed = await f.redeem(await f.deliver());
  assert.equal(signed.status, 200);
  assert.equal(
    (await f.request("/api/session", { cookie: signed.cookie })).body.role,
    "admin-pending",
  );
  assert.equal(
    (await f.request("/api/admin", { cookie: signed.cookie })).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/passwordless/admin/step-up", {
        method: "POST",
        cookie: signed.cookie,
        data: { password: "wrong" },
      })
    ).status,
    403,
  );
  const strong = await f.request("/api/passwordless/admin/step-up", {
    method: "POST",
    cookie: signed.cookie,
    data: { password },
  });
  assert.equal(strong.status, 200);
  assert.equal(
    (await f.request("/api/admin", { cookie: strong.cookie })).status,
    200,
  );
  assert.equal(
    (await f.request("/api/session", { cookie: signed.cookie })).body.role,
    null,
  );
});

test("a child's printed RSVP reference requires an invited authorized adult, never a child sign-in", async (t) => {
  const f = await fixture(t),
    adult = await f.guest(f.host),
    child = await f.guest(f.host, {
      first: "Child",
      last: "",
      parent: adult.id,
    }),
    event = await f.event(f.host, [adult, child]);
  const generated = await f.request(
    "/api/host/events/" + event.id + "/rsvp-cards",
    {
      method: "POST",
      cookie: f.host.cookie,
      version: event.version,
      data: { guestIds: [child.id] },
    },
  );
  assert.equal(generated.status, 200);
  const signed = await f.guestLogin(f.host, adult),
    endpoint =
      "/api/invitations/" + generated.body.cards[0].reference + "/resolve";
  assert.equal(
    (await f.request(endpoint, { cookie: signed.cookie })).status,
    200,
  );
  await f.request("/api/host/events/" + event.id + "/uninvite-guests", {
    method: "POST",
    cookie: f.host.cookie,
    version: event.version,
    data: { guestIds: [child.id] },
  });
  assert.equal(
    (await f.request(endpoint, { cookie: signed.cookie })).status,
    404,
  );
});

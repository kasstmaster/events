import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { application, password } from "./helpers/application.js";
import { identityFor } from "../server/guest-identities.js";
import {
  guestPrivateLink,
  startGuestVerification,
  completeGuestVerification,
} from "../server/guest-auth.js";
const env = {
  GUEST_LINK_ENCRYPTION_KEY: "a1".repeat(32),
  SMS_ENABLED: "true",
  TWILIO_ACCOUNT_SID: "synthetic",
  TWILIO_AUTH_TOKEN: "synthetic",
  TWILIO_FROM: "+15005550006",
};
const sha = (value) => createHash("sha256").update(value).digest("hex");
async function fixture(t, settings = {}) {
  const messages = [];
  const fetcher = async (_url, request) => {
    messages.push(Object.fromEntries(request.body));
    return new Response(JSON.stringify({ sid: "synthetic-message" }), {
      status: 201,
    });
  };
  const f = await application(
    t,
    { ...env, ...settings },
    { origin: "https://events.example.test", guestAuthFetcher: fetcher },
  );
  const host = await f.host("SecureGuest"),
    other = await f.host("OtherGuest"),
    guest = await f.guest(host, {
      phone: "+15005550199",
      addressDraft: { label: "Secure home", lines: "PO Box 1" },
    });
  const identity = identityFor(f.store, guest, host.household.id).id;
  const admin = async (action, extra = {}, version) =>
    f.request("/api/admin/guest-access", {
      method: "POST",
      cookie: f.admin,
      version,
      data: {
        household: host.household.id,
        guest: guest.id,
        password,
        action,
        ...extra,
      },
    });
  const link = (await admin("retrieve")).body;
  const data = {
    privateId: link.url?.split("#")[1],
    first: guest.first,
    last: guest.last,
    householdId: guest.inviteCode,
  };
  const enroll = () =>
    admin(
      "enroll",
      { phone: "+15005550123", verifiedOutOfBand: true, consented: true },
      0,
    );
  const start = () =>
    f.request("/api/guest-access/start", { method: "POST", data });
  const verify = (challenge, code) =>
    f.request("/api/guest-access/verify", {
      method: "POST",
      data: { challenge, code },
    });
  const code = () => messages.at(-1).Body.match(/code is (\d{6})/)[1];
  return {
    ...f,
    addGuest: f.guest,
    adminCookie: f.admin,
    host,
    other,
    guest,
    identity,
    admin,
    link,
    data,
    enroll,
    start,
    verify,
    code,
    messages,
    fetcher,
  };
}
test("private URLs are unique, encrypted, stable, administrator-only and never sufficient for authentication", async (t) => {
  const f = await fixture(t);
  assert.match(f.data.privateId, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await f.admin("retrieve")).body.url, f.link.url);
  const second = await f.addGuest(f.host, { first: "Other" });
  const otherIdentity = identityFor(f.store, second, f.host.household.id).id;
  assert.notEqual(
    guestPrivateLink(f.store, otherIdentity, env, "https://events.example.test")
      .url,
    f.link.url,
  );
  const stored = JSON.stringify(f.store.list("guest-private-link", "platform"));
  assert.ok(!stored.includes(f.data.privateId));
  assert.equal(
    f.store.get("guest-private-link", f.identity, "platform").tokenHash,
    sha(f.data.privateId),
  );
  for (const cookie of [undefined, f.host.cookie, f.other.cookie]) {
    assert.equal(
      (
        await f.request("/api/admin/guest-access", {
          method: "POST",
          cookie,
          data: {
            action: "retrieve",
            household: f.host.household.id,
            guest: f.guest.id,
            password,
          },
        })
      ).status,
      cookie ? 403 : 401,
    );
    assert.equal(
      (await f.request("/api/guest-access/self", { cookie })).status,
      403,
    );
  }
  assert.equal((await f.request("/api/session")).body.role, null);
  assert.equal((await f.start()).status, 403); // Host contact phone is unverified.
  assert.equal(f.messages.length, 0);
  assert.equal(
    (
      await f.admin(
        "enroll",
        { phone: "+15005550123", verifiedOutOfBand: false, consented: true },
        0,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.admin(
        "enroll",
        { phone: "+15005550123", verifiedOutOfBand: true, consented: true },
        3,
      )
    ).status,
    409,
  );
  for (const op of ["login", "recognize", "claim-code"])
    assert.equal(
      (
        await f.request(
          `/api/public/households/${f.host.household.slug}/${op}`,
          {
            method: "POST",
            data: { ...f.data, inviteCode: f.guest.inviteCode },
          },
        )
      ).status,
      401,
    );
  assert.equal(
    (
      await f.request("/api/sign-in", {
        method: "POST",
        data: { account: "Casey Example", secret: f.guest.inviteCode },
      })
    ).status,
    401,
  );
  assert.equal(
    (await f.admin("retrieve", { password: "wrong-password" })).status,
    403,
  );
  for (const path of ["/api/host", "/api/host/cards"]) {
    const r = await f.request(path, { cookie: f.host.cookie });
    assert.ok(!JSON.stringify(r.body).includes(f.data.privateId));
  }
});
test("first activation requires SMS proof, uses a secure session, preserves identity/history and supports returning guests", async (t) => {
  const f = await fixture(t);
  const event = await f.event(f.host, [f.guest]);
  const before = f.store.list("guest", f.host.household.id).length;
  assert.equal((await f.enroll()).status, 200);
  assert.equal(
    (
      await f.request("/api/guest-access/start", {
        method: "POST",
        data: { ...f.data, phone: "+15005550999", privateId: "x".repeat(43) },
      })
    ).status,
    401,
  );
  const start = await f.start();
  assert.equal(start.status, 200);
  assert.equal(f.messages.length, 1);
  assert.equal(f.messages[0].To, "+15005550123");
  assert.doesNotMatch(JSON.stringify(start.body), /1500555|phone|code is/);
  assert.equal(start.body.expiresIn, 600);
  const saved = f.store.get(
    "guest-auth-challenge",
    sha(start.body.challenge),
    "platform",
  );
  assert.equal(saved.expires > Date.now() + 590000, true);
  assert.ok(!JSON.stringify(saved).includes(f.code()));
  assert.equal((await f.verify(start.body.challenge, "000000")).status, 401);
  const login = await f.verify(start.body.challenge, f.code());
  assert.equal(login.status, 200);
  assert.match(
    login.headers.get("set-cookie"),
    /events_session=.*HttpOnly.*SameSite=Strict.*Secure/,
  );
  assert.equal((await f.verify(start.body.challenge, f.code())).status, 401);
  const view = await f.request("/api/guest", { cookie: login.cookie });
  assert.equal(view.status, 200);
  assert.equal(view.body.events[0].id, event.id);
  assert.equal(f.store.list("guest", f.host.household.id).length, before);
  assert.equal(f.store.list("guest-auth-activation", "platform").length, 1);
  assert.equal(
    (await f.request("/api/personal", { cookie: login.cookie })).body.account
      .needsUsername,
    false,
  );
  const self = await f.request("/api/guest-access/self", {
    cookie: login.cookie,
  });
  assert.equal(self.body.url, f.link.url);
  await f.request("/api/guest", { cookie: login.cookie });
  await f.request("/guest", { cookie: login.cookie });
  assert.equal(f.messages.length, 1);
  assert.equal(
    (
      await f.request("/api/guest-access/start", {
        method: "POST",
        headers: { Origin: "https://wrong.example.test" },
        data: f.data,
      })
    ).status,
    403,
  );
  f.store.run("UPDATE sessions SET expires=0 WHERE role='guest'");
  assert.equal(
    (await f.request("/api/guest", { cookie: login.cookie })).status,
    401,
  );
});
test("OTP cooldown, five-guess limit, expiry, replacement, address moves and revocation fail closed", async (t) => {
  const f = await fixture(t);
  await f.enroll();
  const a = await f.start();
  assert.equal((await f.start()).status, 429);
  for (let n = 0; n < 5; n++)
    assert.equal((await f.verify(a.body.challenge, "000000")).status, 401);
  assert.equal((await f.verify(a.body.challenge, f.code())).status, 401);
  const later = Date.now() + 61000;
  const b = await startGuestVerification(f.store, env, f.data, {
    ip: "isolated",
    fetcher: f.fetcher,
    now: () => later,
  });
  const bcode = f.code();
  assert.throws(
    () =>
      completeGuestVerification(
        f.store,
        env,
        { challenge: b.challenge, code: bcode },
        () => assert.fail("expired"),
        { now: () => later + 600000 },
      ),
    /invalid or expired/,
  );
  const c = await startGuestVerification(f.store, env, f.data, {
    ip: "isolated",
    fetcher: f.fetcher,
    now: () => later + 61000,
  });
  assert.throws(
    () =>
      completeGuestVerification(
        f.store,
        env,
        { challenge: b.challenge, code: bcode },
        () => assert.fail("superseded"),
      ),
    /invalid or expired/,
  );
  const old = f.store.get("guest", f.guest.id, f.host.household.id);
  assert.equal(
    (
      await f.request(`/api/host/guests/${old.id}`, {
        method: "PUT",
        cookie: f.host.cookie,
        version: old.version,
        data: {
          ...old,
          addressDraft: { label: "New residence", lines: "PO Box 999" },
        },
      })
    ).status,
    200,
  );
  assert.equal((await f.verify(c.challenge, f.code())).status, 401);
});
test("guests can revoke other devices; only administrators can reset links, which revokes all devices", async (t) => {
  const f = await fixture(t);
  await f.enroll();
  const a = await f.start(),
    first = await f.verify(a.body.challenge, f.code());
  const b = await startGuestVerification(f.store, env, f.data, {
      ip: "isolated",
      fetcher: f.fetcher,
      now: () => Date.now() + 61000,
    }),
    second = await f.verify(b.challenge, f.code());
  assert.equal(second.status, 200);
  assert.equal(
    (
      await f.request("/api/guest-access/self", {
        method: "POST",
        cookie: second.cookie,
        data: {},
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.request("/api/guest", { cookie: first.cookie })).status,
    401,
  );
  assert.equal(
    (await f.request("/api/guest", { cookie: second.cookie })).status,
    200,
  );
  assert.equal(
    (
      await f.request("/api/admin/guest-access", {
        method: "POST",
        cookie: second.cookie,
        data: {
          action: "reset",
          household: f.host.household.id,
          guest: f.guest.id,
          password,
        },
      })
    ).status,
    403,
  );
  const reset = await f.admin(
    "reset",
    { confirm: "Casey Example" },
    f.link.version,
  );
  assert.equal(reset.status, 200);
  assert.notEqual(reset.body.url, f.link.url);
  assert.equal(
    (await f.request("/api/guest", { cookie: second.cookie })).status,
    401,
  );
  assert.equal((await f.start()).status, 401);
});
test("host link delivery hides the URL, uses verified contacts only and never exposes other households", async (t) => {
  const f = await fixture(t);
  await f.enroll();
  const route = `/api/host/guests/${f.guest.id}/sign-in-link`;
  assert.equal(
    (
      await f.request(route, {
        method: "POST",
        cookie: f.other.cookie,
        data: {},
      })
    ).status,
    404,
  );
  const sent = await f.request(route, {
    method: "POST",
    cookie: f.host.cookie,
    data: { phone: "+15005550999" },
  });
  assert.equal(sent.status, 200);
  assert.deepEqual(sent.body, { status: "accepted" });
  assert.equal(f.messages[0].To, "+15005550123");
  assert.ok(f.messages[0].Body.includes(f.link.url));
  assert.ok(!JSON.stringify(sent).includes(f.data.privateId));
  assert.equal(
    (
      await f.request(route, {
        method: "POST",
        cookie: f.host.cookie,
        data: {},
      })
    ).status,
    429,
  );
});
test("missing credentials, disabled SMS and opt-out never enqueue verification; valid legacy sessions survive", async (t) => {
  const f = await fixture(t, { SMS_ENABLED: "false" });
  await f.enroll();
  assert.equal((await f.start()).status, 503);
  assert.equal(f.messages.length, 0);
  assert.equal(f.store.list("guest-auth-challenge", "platform").length, 0);
  assert.equal(f.store.list("guest-auth-send", "platform").length, 0);
  const legacy = f.store.newSession(
    {
      role: "guest",
      guest: f.guest.id,
      household: f.host.household.id,
      identity: f.identity,
    },
    "https://events.example.test",
  );
  const cookie = "events_session=" + legacy.token;
  assert.equal((await f.request("/api/guest", { cookie })).status, 200);
  assert.equal(
    (await f.request("/api/guest-access/self", { cookie })).body.url,
    f.link.url,
  );
  assert.equal(f.messages.length, 0);
  await assert.rejects(
    startGuestVerification(f.store, {}, f.data),
    /not configured/,
  );
});
test(
  "actual Cloudflare Worker and Durable Object enforce SMS proof and private link isolation",
  { timeout: 30000 },
  async (t) => {
    const {
      domainRuntime,
      seedDomains,
      password: adminPassword,
      canonical,
    } = await import("./helpers/domain-runtime.js");
    const f = await domainRuntime({ guestAuth: true });
    t.after(() => f.runtime.dispose());
    const {
      admin,
      hosts: [host, other],
    } = await seedDomains(f);
    const guest = (
      await f.request("/api/host/guests", {
        method: "POST",
        cookie: host.cookie,
        data: { first: "Casey", last: "Example" },
      })
    ).body;
    const access = {
      household: host.id,
      guest: guest.id,
      password: adminPassword,
    };
    const link = await f.request("/api/admin/guest-access", {
      method: "POST",
      cookie: admin.cookie,
      data: { ...access, action: "retrieve" },
    });
    assert.equal(link.status, 200);
    assert.equal(
      (
        await f.request("/api/admin/guest-access", {
          method: "POST",
          cookie: other.cookie,
          data: { ...access, action: "retrieve" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request("/api/admin/guest-access", {
          method: "POST",
          cookie: admin.cookie,
          version: 0,
          data: {
            ...access,
            action: "enroll",
            phone: "+15005550123",
            verifiedOutOfBand: true,
            consented: true,
          },
        })
      ).status,
      200,
    );
    const data = {
      privateId: link.body.url.split("#")[1],
      first: guest.first,
      last: guest.last,
      householdId: guest.inviteCode,
    };
    const start = await f.request("/api/guest-access/start", {
      method: "POST",
      data,
    });
    assert.equal(start.status, 200);
    assert.equal(f.messages.length, 1);
    const code = f.messages[0].Body.match(/code is (\d{6})/)[1];
    const login = await f.request("/api/guest-access/verify", {
      method: "POST",
      data: { challenge: start.body.challenge, code },
    });
    assert.equal(login.status, 200);
    assert.match(
      login.headers.get("set-cookie"),
      /HttpOnly.*SameSite=Strict.*Secure/,
    );
    assert.equal(
      (
        await f.request("/api/guest-access/verify", {
          method: "POST",
          data: { challenge: start.body.challenge, code },
        })
      ).status,
      401,
    );
    assert.equal(
      (await f.request("/api/guest-access/self", { cookie: login.cookie })).body
        .url,
      link.body.url,
    );
    assert.equal((await f.request("/guest")).status, 200);
    assert.equal((await f.request("/guest-access-ui.js")).status, 200);
    assert.equal(new URL(link.body.url).origin, canonical);
  },
);

test("private page and code are bound to one person; verified legacy recovery phones work without usernames", async (t) => {
  const f = await fixture(t),
    second = await f.addGuest(f.host, {
      first: "Casey",
      last: "Example",
      suffix: "Jr.",
      address: f.guest.address,
    });
  const otherIdentity = identityFor(f.store, second, f.host.household.id).id;
  const secondLink = guestPrivateLink(
    f.store,
    otherIdentity,
    env,
    "https://events.example.test",
  );
  f.store.put("person-account", f.identity, "platform", {
    recoveryPhone: "+15005550123",
    recoveryVerified: true,
  });
  const own = await f.start();
  assert.equal(own.status, 200);
  const ownCode = f.code();
  const secondStart = await f.request("/api/guest-access/start", {
    method: "POST",
    data: { ...f.data, privateId: secondLink.url.split("#")[1] },
  });
  assert.equal(secondStart.status, 403); // Same name/code is not verified phone ownership for this identity.
  const enrolled = await f.request("/api/admin/guest-access", {
    method: "POST",
    cookie: f.adminCookie,
    version: 0,
    data: {
      household: f.host.household.id,
      guest: second.id,
      password,
      action: "enroll",
      phone: "+15005550456",
      verifiedOutOfBand: true,
      consented: true,
    },
  });
  assert.equal(enrolled.status, 200);
  const started = await f.request("/api/guest-access/start", {
    method: "POST",
    data: { ...f.data, privateId: secondLink.url.split("#")[1] },
  });
  assert.equal(started.status, 200);
  const wrong = await f.verify(
    started.body.challenge,
    ownCode === f.code() ? "000000" : ownCode,
  );
  // Random codes may coincide; explicitly use a distinct wrong code when necessary.
  assert.equal(wrong.status, 401);
  const login = await f.verify(own.body.challenge, ownCode);
  assert.equal(login.status, 200);
  const settings = await f.request(
    "/api/guest-access/self?identity=" + otherIdentity,
    { cookie: login.cookie },
  );
  assert.equal(settings.body.url, f.link.url);
  assert.notEqual(settings.body.url, secondLink.url);
  assert.equal(
    (
      await f.request("/api/admin/guest-access", {
        method: "POST",
        cookie: login.cookie,
        data: {
          household: f.host.household.id,
          guest: second.id,
          password,
          action: "retrieve",
        },
      })
    ).status,
    403,
  );
});
test("unverified visitor phones, opt-out and failed/redirected deliveries cannot activate an account", async (t) => {
  const f = await fixture(t);
  await f.enroll();
  f.store.run(
    "INSERT INTO sms_optouts(phone,created) VALUES(?,?)",
    "+15005550123",
    new Date().toISOString(),
  );
  assert.equal((await f.start()).status, 403);
  assert.equal(f.messages.length, 0);
  f.store.run("DELETE FROM sms_optouts");
  let count = 0;
  await assert.rejects(
    startGuestVerification(f.store, env, f.data, {
      ip: "isolated",
      fetcher: async (_url, request) => {
        count++;
        assert.equal(request.redirect, "manual");
        return new Response(null, {
          status: 302,
          headers: { Location: "https://untrusted.example/" },
        });
      },
    }),
    /could not be sent/,
  );
  assert.equal(count, 1);
  const challenge = f.store.list("guest-auth-challenge", "platform")[0];
  assert.equal(challenge.state, "failed");
  assert.equal(challenge.codeHash, "");
  assert.equal(f.store.list("guest-auth-activation", "platform").length, 0);
  const family = await f.member(f.host, "administrator", "AssignedAdult");
  assert.equal(
    (
      await f.request(`/api/host/guests/${f.guest.id}/sign-in-link`, {
        method: "POST",
        cookie: family.cookie,
        data: {},
      })
    ).status,
    403,
  );
});

test("an identity cannot exceed five SMS challenges per hour or verify after a contact changes", async (t) => {
  const f = await fixture(t);
  await f.enroll();
  let latest;
  for (let i = 0; i < 5; i++)
    latest = await startGuestVerification(f.store, env, f.data, {
      ip: "isolated-rate",
      fetcher: f.fetcher,
      now: () => Date.now() + i * 61000,
    });
  assert.equal(f.messages.length, 5);
  await assert.rejects(
    startGuestVerification(f.store, env, f.data, {
      ip: "isolated-rate",
      fetcher: f.fetcher,
      now: () => Date.now() + 6 * 61000,
    }),
    (error) => error.status === 429,
  );
  assert.equal(f.messages.length, 5);
  const contact = f.store.get("guest-auth-contact", f.identity, "platform");
  const changed = await f.admin(
    "enroll",
    { phone: "+15005550789", verifiedOutOfBand: true, consented: true },
    contact.version,
  );
  assert.equal(changed.status, 200);
  assert.equal((await f.verify(latest.challenge, f.code())).status, 401);
});

test("optional host registration cannot attach another guest using a legacy username and address code", async (t) => {
  const f = await fixture(t);
  await f.enroll();
  f.store.put("person-account", f.identity, "platform", {
    username: "legacy.private.name",
  });
  const email = "attached@example.test";
  f.store.run("INSERT INTO approvals VALUES(?,?)", email, "synthetic");
  const registration = {
    email,
    password,
    name: "Attached family",
    existingUsername: "legacy.private.name",
    existingHouseholdId: f.guest.inviteCode,
  };
  const denied = await f.request("/api/register", {
    method: "POST",
    data: registration,
  });
  assert.equal(denied.status, 403);
  assert.equal(
    f.store.one("SELECT id FROM users WHERE email=?", email),
    undefined,
  );
  assert.ok(f.store.one("SELECT email FROM approvals WHERE email=?", email));
  const start = await f.start(),
    login = await f.verify(start.body.challenge, f.code());
  assert.equal(login.status, 200);
  const linked = await f.request("/api/register", {
    method: "POST",
    cookie: login.cookie,
    data: { email, password, name: "Attached family", attachGuest: true },
  });
  assert.equal(linked.status, 201);
  const hostUser = f.store.one("SELECT id FROM users WHERE email=?", email);
  assert.equal(
    f.store.get(
      "host-person",
      hostUser.id,
      f.store.one("SELECT household FROM users WHERE id=?", hostUser.id)
        .household,
    ).identity,
    f.identity,
  );
  assert.equal(f.store.list("guest", f.host.household.id).length, 1);
});

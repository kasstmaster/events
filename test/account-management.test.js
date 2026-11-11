import test from "node:test";
import assert from "node:assert/strict";
import { application, password } from "./helpers/application.js";
import { accessFor } from "../server/guest-access.js";
import {
  verifiedGuestContact,
  startGuestVerification,
  completeGuestVerification,
} from "../server/guest-auth.js";
const KEY = "ab".repeat(32);
async function enrolled(f, host, name = "casey.private") {
  const adult = await f.guest(host, {
    first: "Casey",
    last: "Account",
    phone: "+15550000111",
    addressDraft: {
      label: "Account family",
      lines: "12 Original St",
      notes: "private host note",
    },
  });
  const login = await f.guestLogin(host, adult);
  const own = (await f.request("/api/personal", { cookie: login.cookie })).body;
  const enrollment = await f.request("/api/personal/account", {
    method: "PUT",
    cookie: login.cookie,
    version: own.account.version,
    data: { username: name, recoveryPhone: "+15550000111" },
  });
  assert.equal(enrollment.status, 200);
  return {
    adult,
    login,
    identity: f.store.one(
      "SELECT identity FROM guest_identity_links WHERE household=? AND guest=?",
      host.household.id,
      adult.id,
    ).identity,
  };
}
async function query(f) {
  const result = await f.request("/api/admin/accounts", {
    method: "POST",
    cookie: f.admin,
    data: { password },
  });
  assert.equal(result.status, 200);
  return result.body.accounts;
}
async function action(f, data, cookie = f.admin) {
  return f.request("/api/admin/account", {
    method: "POST",
    cookie,
    data: { password, ...data },
  });
}
test("system admin only: central registry, audit, phone changes and private disclosure reject hosts, family admins and guests", async (t) => {
  const f = await application(t, { GUEST_LINK_ENCRYPTION_KEY: KEY }),
    host = await f.host("PermissionHost"),
    family = await f.member(host, "administrator", "FamilyManager");
  const { login } = await enrolled(f, host);
  for (const cookie of [host.cookie, family.cookie, login.cookie]) {
    const r = await f.request("/api/admin/accounts", {
      method: "POST",
      cookie,
      data: { password },
    });
    assert.ok([401, 403].includes(r.status));
    const a = await action(
      f,
      { id: "person:unknown", action: "reveal" },
      cookie,
    );
    assert.equal(a.status, 403);
  }
  const bad = await f.request("/api/admin/accounts", {
    method: "POST",
    cookie: f.admin,
    data: { password: "wrong-password" },
  });
  assert.equal(bad.status, 403);
  const records = await query(f);
  assert.ok(records.some((r) => r.type === "guest"));
  assert.ok(records.some((r) => r.type === "family"));
  assert.doesNotMatch(
    JSON.stringify(records),
    /encryptedToken|tokenHash|privateId|private host note/,
  );
});
test("editing local contacts never mutates registered information or verified authentication contact", async (t) => {
  const f = await application(t),
    host = await f.host("LocalOnly");
  const { adult, login, identity } = await enrolled(f, host);
  const account = f.store.get("person-account", identity, "platform"),
    profile = f.store.get(
      "personal-household",
      f.store.get("personal-member", identity, "platform").profile,
      "platform",
    );
  const local = await f.request("/api/host/guests/" + adult.id, {
    method: "PUT",
    cookie: host.cookie,
    version: adult.version,
    data: { ...adult, phone: "+15550000999" },
  });
  assert.equal(local.status, 200);
  assert.deepEqual(
    f.store.get("person-account", identity, "platform"),
    account,
  );
  assert.deepEqual(
    f.store.get("personal-household", profile.id, "platform"),
    profile,
  );
  const forbidden = await f.request("/api/host/guests/" + adult.id, {
    method: "PUT",
    cookie: host.cookie,
    version: local.body.version,
    data: { ...local.body, recoveryPhone: "+15550000999" },
  });
  assert.equal(forbidden.status, 403);
  assert.equal(
    (
      await f.request("/api/host/guests/" + adult.id + "/sign-in-link", {
        method: "POST",
        cookie: host.cookie,
        data: {},
      })
    ).status,
    503,
  );
  assert.equal(f.store.list("guest-auth-challenge", "platform").length, 0);
  assert.equal(
    (await f.request("/api/personal", { cookie: login.cookie })).status,
    200,
  );
});
test("administrator phone/address updates preserve identity/history and synchronize approved contacts without overwriting notes", async (t) => {
  const f = await application(t, { GUEST_LINK_ENCRYPTION_KEY: KEY }),
    host = await f.host("PrimaryContact"),
    other = await f.host("ApprovedContact");
  const { adult, login, identity } = await enrolled(f, host);
  let personal = (await f.request("/api/personal", { cookie: login.cookie }))
    .body;
  const shared = await f.request("/api/personal/family", {
    method: "PUT",
    cookie: login.cookie,
    version: personal.profile.version,
    data: { ...personal.profile, sharing: "everyone" },
  });
  assert.equal(shared.status, 200);
  const second = await f.guest(other, {
    first: adult.first,
    last: adult.last,
    phone: adult.phone,
    addressDraft: {
      label: "Other local address",
      lines: "12 Original St",
      notes: "other private note",
    },
  });
  const event = await f.event(host, [adult]);
  const response = f.store.put(
    "response",
    "preserved-rsvp",
    host.household.id,
    {
      event: event.id,
      guest: adult.id,
      attendance: { [adult.id]: "yes" },
      claims: {},
    },
  );
  const code = adult.inviteCode;
  let record = (await query(f)).find((r) => r.id === "person:" + identity);
  const rejected = await action(f, {
    id: record.id,
    action: "update",
    version: record.version,
    accountVersion: record.accountVersion,
    phone: "+15550000222",
  });
  assert.equal(rejected.status, 400);
  const updated = await action(f, {
    id: record.id,
    action: "update",
    version: record.version,
    accountVersion: record.accountVersion,
    phone: "+15550000222",
    verifiedOutOfBand: true,
    consented: true,
  });
  assert.equal(updated.status, 200);
  assert.equal(verifiedGuestContact(f.store, identity).phone, "+15550000222");
  assert.equal(
    (await f.request("/api/personal", { cookie: login.cookie })).status,
    403,
  );
  assert.equal(
    f.store.get("guest", adult.id, host.household.id).phone,
    "+15550000222",
  );
  assert.equal(
    f.store.get("guest", second.id, other.household.id).phone,
    "+15550000222",
  );
  const address = await action(f, {
    id: record.id,
    action: "update",
    version: updated.body.version,
    accountVersion: updated.body.accountVersion,
    address: {
      street: "44 Updated Ave",
      city: "Example",
      state: "CA",
      zip: "90210",
    },
  });
  assert.equal(address.status, 200);
  assert.match(
    f.store.get("address", adult.address, host.household.id).lines,
    /44 Updated Ave/,
  );
  assert.match(
    f.store.get("address", second.address, other.household.id).lines,
    /44 Updated Ave/,
  );
  assert.equal(
    f.store.get("address", adult.address, host.household.id).notes,
    "private host note",
  );
  assert.equal(
    f.store.get("address", second.address, other.household.id).notes,
    "other private note",
  );
  assert.deepEqual(
    f.store.get("response", response.id, host.household.id),
    response,
  );
  assert.deepEqual(f.store.get("event", event.id, host.household.id).invited, [
    adult.id,
  ]);
  assert.equal(
    accessFor(
      f.store,
      f.store.get("guest", adult.id, host.household.id),
      host.household.id,
    ).code,
    code,
  );

  const audits = f.store.list("account-admin-audit", "platform");
  assert.ok(audits.some((a) => a.fields.includes("phone")));
  assert.ok(audits.some((a) => a.fields.includes("address")));
  assert.doesNotMatch(JSON.stringify(audits), /15550000222|44 Updated/);
});
test("private URL reset invalidates old links and sessions, preserves account data, and updated verified phone receives only mocked security delivery", async (t) => {
  const f = await application(t, { GUEST_LINK_ENCRYPTION_KEY: KEY }),
    host = await f.host("PrivateReset");
  const { adult, login, identity } = await enrolled(f, host);
  const central = (await query(f)).find((r) => r.id === "person:" + identity);
  const phone = await action(f, {
    id: central.id,
    action: "update",
    version: central.version,
    accountVersion: central.accountVersion,
    phone: "+15550000333",
    verifiedOutOfBand: true,
    consented: true,
  });
  assert.equal(phone.status, 200);
  const old = await action(f, { id: central.id, action: "reveal" });
  assert.equal(old.status, 200);
  assert.equal(old.body.privateId.length, 43);
  const bad = await action(f, {
    id: central.id,
    action: "reset",
    linkVersion: old.body.version - 1,
    confirm: central.id,
  });
  assert.equal(bad.status, 409);
  const reset = await action(f, {
    id: central.id,
    action: "reset",
    linkVersion: old.body.version,
    confirm: central.id,
  });
  assert.equal(reset.status, 200);
  assert.notEqual(reset.body.privateId, old.body.privateId);
  const fakeEnv = {
    GUEST_LINK_ENCRYPTION_KEY: KEY,
    SMS_ENABLED: "true",
    TWILIO_ACCOUNT_SID: "synthetic",
    TWILIO_AUTH_TOKEN: "synthetic",
    TWILIO_FROM: "+15005550006",
  };
  let sent = 0,
    code;
  const fakeSMS = async (url, options) => {
    sent++;
    assert.equal(options.body.get("To"), "+15550000333");
    code = options.body.get("Body").match(/code is (\d{6})/)[1];
    return Response.json({ sid: "SMsynthetic" });
  };
  const proof = {
    first: adult.first,
    last: adult.last,
    householdId: adult.inviteCode,
  };
  await assert.rejects(
    startGuestVerification(
      f.store,
      fakeEnv,
      { ...proof, privateId: old.body.privateId },
      { fetcher: fakeSMS },
    ),
    /authorize/,
  );
  assert.equal(sent, 0);
  const challenge = await startGuestVerification(
    f.store,
    fakeEnv,
    { ...proof, privateId: reset.body.privateId },
    { fetcher: fakeSMS },
  );
  assert.equal(sent, 1);
  const established = completeGuestVerification(
    f.store,
    fakeEnv,
    { challenge: challenge.challenge, code },
    (account) => f.store.newSession(account, "http://127.0.0.1:3000"),
  );
  assert.ok(f.store.session(established.token, "http://127.0.0.1:3000"));
  assert.equal(
    (
      await f.request("/api/sign-in", {
        method: "POST",
        data: { account: "casey.private", secret: adult.inviteCode },
      })
    ).status,
    401,
  );
  const revoked = await action(f, { id: central.id, action: "revoke" });
  assert.equal(revoked.status, 200);
  assert.equal(
    f.store.session(established.token, "http://127.0.0.1:3000"),
    null,
  );
  assert.ok(f.store.get("person-account", identity, "platform"));
  assert.equal(
    (await f.request("/api/personal", { cookie: login.cookie })).status,
    403,
  );
  const stored = f.store.get("guest-private-link", identity, "platform");
  assert.ok(!JSON.stringify(stored).includes(reset.body.privateId));
  assert.doesNotMatch(
    JSON.stringify(f.store.list("account-admin-audit", "platform")),
    new RegExp(old.body.privateId + "|" + reset.body.privateId + "|" + code),
  );
});
test("family users can update only their own central information; family administrator cannot manage other accounts", async (t) => {
  const f = await application(t),
    host = await f.host("FamilyAccounts"),
    member = await f.member(host, "administrator", "AssignedAdult");
  const self = await f.request("/api/account/self", { cookie: member.cookie });
  assert.equal(self.status, 200);
  const update = await f.request("/api/account/self", {
    method: "PUT",
    cookie: member.cookie,
    version: self.body.version,
    data: {
      id: "user:" + host.user,
      first: "Updated assigned adult",
      last: "Example",
      phone: "+15550000444",
      physical: { lines: "55 Family St" },
    },
  });
  assert.equal(update.status, 200);
  assert.equal(update.body.id, self.body.id);
  assert.notEqual(update.body.id, "user:" + host.user);
  assert.equal(
    (
      await action(
        f,
        { id: "user:" + host.user, action: "revoke" },
        member.cookie,
      )
    ).status,
    403,
  );
  assert.equal(f.store.get("central-user-info", host.user, "platform"), null);
});

test("registered adults cannot edit each other's central phone; assigned-family password resets require the system administrator", async (t) => {
  const f = await application(t),
    host = await f.host("AdultBoundaries");
  const adult = await f.guest(host, {
    first: "First",
    last: "Adult",
    addressDraft: { label: "Shared family", lines: "88 Same St" },
  });
  const second = await f.guest(host, {
    first: "Second",
    last: "Adult",
    address: adult.address,
  });
  const firstLogin = await f.guestLogin(host, adult),
    first = (await f.request("/api/personal", { cookie: firstLogin.cookie }))
      .body;
  const secondLogin = await f.guestLogin(host, second),
    secondInfo = (
      await f.request("/api/personal", { cookie: secondLogin.cookie })
    ).body;
  assert.equal(
    (
      await f.request("/api/personal/account", {
        method: "PUT",
        cookie: secondLogin.cookie,
        version: secondInfo.account.version,
        data: { username: "second.adult", recoveryPhone: "+15550000111" },
      })
    ).status,
    200,
  );
  const profile = (
    await f.request("/api/personal", { cookie: firstLogin.cookie })
  ).body.profile;
  const edited = {
    ...profile,
    members: profile.members.map((m) =>
      m.id === secondInfo.self ? { ...m, phone: "+15550000555" } : m,
    ),
  };
  assert.equal(
    (
      await f.request("/api/personal/family", {
        method: "PUT",
        cookie: firstLogin.cookie,
        version: profile.version,
        data: edited,
      })
    ).status,
    403,
  );
  const family = await f.member(host, "member", "OwnPassword");
  assert.equal(
    (
      await f.request("/api/family/members/" + family.id, {
        method: "PUT",
        cookie: host.cookie,
        version: family.version,
        data: { password: "New-synthetic-password" },
      })
    ).status,
    403,
  );
  const reset = await action(f, {
    id: "user:" + family.id,
    action: "reset-password",
    newPassword: "New-synthetic-password",
    authVersion: family.version,
  });
  assert.equal(reset.status, 200);
  assert.equal(
    (await f.request("/api/account/self", { cookie: family.cookie })).status,
    401,
  );
});

test("a local address move cannot revoke a registered person's sessions in another household", async (t) => {
  const f = await application(t),
    host = await f.host("LocalMove"),
    other = await f.host("OtherSession");
  const { adult, login, identity } = await enrolled(f, host, "move.registered");
  const personal = (await f.request("/api/personal", { cookie: login.cookie }))
    .body;
  assert.equal(
    (
      await f.request("/api/personal/family", {
        method: "PUT",
        cookie: login.cookie,
        version: personal.profile.version,
        data: { ...personal.profile, sharing: "everyone" },
      })
    ).status,
    200,
  );
  const second = await f.guest(other, {
    first: adult.first,
    last: adult.last,
    phone: adult.phone,
  });
  const signin = await f.request("/api/sign-in", {
    method: "POST",
    data: { account: "move.registered", secret: second.inviteCode },
  });
  assert.equal(signin.status, 200);
  const account = f.store.get("person-account", identity, "platform");
  const moved = await f.request("/api/host/guests/" + adult.id, {
    method: "PUT",
    cookie: host.cookie,
    version: f.store.get("guest", adult.id, host.household.id).version,
    data: {
      ...adult,
      addressDraft: { label: "Local updated address", lines: "99 Local Rd" },
    },
  });
  assert.equal(moved.status, 200);
  assert.equal(
    (await f.request("/api/personal", { cookie: signin.cookie })).status,
    200,
  );
  assert.deepEqual(
    f.store.get("person-account", identity, "platform"),
    account,
  );
});

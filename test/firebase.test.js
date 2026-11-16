import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { firebaseFixture, firebaseFetcher, token } from "./helpers/firebase.js";
import { verifyFirebaseToken } from "../server/firebase-auth.js";
import { authHash } from "../server/passwordless.js";
import { referenceFor } from "../server/rsvp-cards.js";
import { DEVICE_ROTATION_MS } from "../server/device-sessions.js";
const P = "platform";
test("Firebase verification requires exact project, phone provider, RSA signature and recent authentication", async (t) => {
  const f = await firebaseFixture(t);
  assert.equal(
    (
      await verifyFirebaseToken(token(f.env), f.env, {
        fetcher: firebaseFetcher,
      })
    ).phone,
    "+15005550121",
  );
  for (const changes of [
    { aud: "other-project" },
    { iss: "https://attacker.invalid" },
    { exp: 0 },
    { auth_time: Math.floor(Date.now() / 1000) - 301 },
    { firebase: { sign_in_provider: "custom" } },
    { phone_number: "555" },
  ])
    await assert.rejects(
      verifyFirebaseToken(token(f.env, changes), f.env, {
        fetcher: firebaseFetcher,
      }),
      (e) => e.status === 401,
    );
  await assert.rejects(
    verifyFirebaseToken(token(f.env).slice(0, -8) + "corrupt!", f.env, {
      fetcher: firebaseFetcher,
    }),
  );
});
test("Firebase creates only persistent origin-bound Gather sessions, rotates and revokes immediately", async (t) => {
  const f = await firebaseFixture(t),
    a = await f.start(),
    signed = await f.finish(a);
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  const session = await f.request("/api/session", { cookie: signed.cookie });
  assert.equal(session.body.role, "host");
  const raw = signed.cookie.split("=")[1],
    proof = f.store.get("passwordless-session", authHash(raw), P);
  assert.equal(proof.provider, "firebase");
  assert.equal(proof.persistent, true);
  f.store.put(
    "passwordless-session",
    proof.id,
    P,
    { ...proof, rotatedAt: Date.now() - DEVICE_ROTATION_MS - 1 },
    proof.version,
  );
  const rotated = await f.request("/api/session", { cookie: signed.cookie });
  assert.ok(rotated.cookie);
  assert.notEqual(rotated.cookie, signed.cookie);
  const mapping = f.store.get("firebase-account", proof.mapping, P);
  f.store.put(
    "firebase-account",
    mapping.id,
    P,
    { ...mapping, revoked: true },
    mapping.version,
  );
  assert.equal(
    (await f.request("/api/session", { cookie: rotated.cookie })).status,
    401,
  );
  assert.equal(
    (await f.finish(await f.start(), { uid: "second-device" })).status,
    401,
  );
});
test("one-shot browser binding, replay rejection and generic account failures", async (t) => {
  const f = await firebaseFixture(t),
    a = await f.start(),
    idToken = token(f.env);
  assert.equal(
    (
      await f.request("/api/firebase/verify", {
        method: "POST",
        data: { reference: a.body.reference, idToken },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.request("/api/firebase/verify", {
        method: "POST",
        cookie: a.cookie,
        data: { reference: a.body.reference, idToken },
        headers: { Origin: "https://unrelated.invalid" },
      })
    ).status,
    403,
  );
  assert.equal((await f.finish(a)).status, 200);
  assert.equal((await f.finish(a)).status, 401);
  const other = await f.start();
  assert.equal(
    (await f.finish(other, { uid: "different-firebase-account" })).status,
    401,
  );
  const unknown = await f.start({ first: "Unknown" });
  assert.equal((await f.finish(unknown, { uid: "unknown" })).status, 401);
  assert.equal(f.store.list("firebase-account", P).length, 1);
});
test("duplicates and unverified associations fail closed without claiming central accounts", async (t) => {
  const f = await firebaseFixture(t),
    p = f.store.get("personal-household", f.profile.id, P);
  f.store.put(
    "personal-household",
    p.id,
    P,
    {
      ...p,
      members: [
        ...p.members,
        {
          id: "other",
          identity: "other",
          first: "Alex",
          last: "Example",
          phone: "+15005550121",
        },
      ],
    },
    p.version,
  );
  f.store.put("personal-member", "other", P, {
    profile: p.id,
    member: "other",
  });
  f.store.put("person-account", "other", P, {
    recoveryPhone: "+15005550121",
    recoveryVerified: true,
  });
  assert.equal((await f.finish(await f.start())).status, 401);
  assert.equal(f.store.list("firebase-account", P).length, 0);
});
test("authorized new invitees enroll independently; QR cannot claim an existing central account", async (t) => {
  const f = await firebaseFixture(t),
    guest = await f.guest(f.host, {
      first: "New",
      last: "Invitee",
      phone: "+15005550122",
    }),
    event = await f.event(f.host, [guest]);
  const reference = referenceFor(f.store, f.host.household.id, event, {
    id: guest.id,
    guests: [guest.id],
  });
  const signed = await f.finish(
    await f.start({
      first: "New",
      last: "Invitee",
      phone: "+15005550122",
      invitation: reference,
    }),
    { uid: "new-invitee", phone: "+15005550122" },
  );
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  assert.equal(
    (await f.request("/api/session", { cookie: signed.cookie })).body.role,
    "guest",
  );
  assert.equal(
    (await f.request("/api/host", { cookie: signed.cookie })).status,
    403,
  );
  const personal = (await f.request("/api/personal", { cookie: signed.cookie }))
    .body;
  assert.equal(personal.account.needsUsername, false);
  assert.equal(personal.account.householdId, guest.inviteCode);
  const oldAccount = f.store.list("firebase-account", P)[0];
  assert.equal(oldAccount.subject.startsWith("person:"), true);
  assert.equal(
    (
      await f.finish(
        await f.start({
          first: "New",
          last: "Invitee",
          phone: "+15005550122",
          invitation: reference,
        }),
        { uid: "impersonator", phone: "+15005550122" },
      )
    ).status,
    401,
  );
  assert.equal(f.store.list("firebase-account", P).length, 1);
});
test("public recovery is neutral; only password-confirmed system administrators see actual relationships", async (t) => {
  const f = await firebaseFixture(t),
    hint = {
      first: "Alex",
      last: "Example",
      householdId: f.profile.publicCode,
    };
  const matching = await f.request("/api/account-recovery", {
    method: "POST",
    data: hint,
  });
  const unknown = await f.request("/api/account-recovery", {
    method: "POST",
    data: { ...hint, first: "Unknown" },
  });
  assert.deepEqual(matching.body, unknown.body);
  const forbidden = await f.request("/api/admin/account-recovery", {
    method: "POST",
    cookie: f.host.cookie,
    data: { action: "list", password: f.password },
  });
  assert.equal(forbidden.status, 403);
  const noPassword = await f.request("/api/admin/account-recovery", {
    method: "POST",
    cookie: f.admin,
    data: { action: "list" },
  });
  assert.equal(noPassword.status, 403);
  const listed = await f.request("/api/admin/account-recovery", {
    method: "POST",
    cookie: f.admin,
    data: { action: "list", password: f.password },
  });
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.equal(listed.body.records.length, 2);
  assert.equal(listed.body.records.filter((r) => r.account).length, 1);
  assert.doesNotMatch(
    JSON.stringify(listed.body),
    /privateUrl|tokenHash|grantHash|codeHash|encryptedToken/,
  );
});
test("reviewed recovery revokes devices, requires a fresh verified replacement phone and preserves identity/history", async (t) => {
  const f = await firebaseFixture(t),
    signed = await f.finish(await f.start());
  assert.equal(signed.status, 200);
  await f.request("/api/account-recovery", {
    method: "POST",
    data: { first: "Alex", last: "Example", householdId: f.profile.publicCode },
  });
  const record = f.store.list("account-recovery", P)[0];
  const issued = await f.request("/api/admin/account-recovery", {
    method: "POST",
    cookie: f.admin,
    data: {
      id: record.id,
      version: record.version,
      action: "authorize",
      password: f.password,
      review: "Independent identity review completed.",
      phone: "+15005550129",
      verifiedIdentity: true,
    },
  });
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  assert.ok(issued.body.recoveryURL);
  assert.equal(
    (await f.request("/api/session", { cookie: signed.cookie })).body.role,
    null,
  );
  const recovery = new URL(issued.body.recoveryURL).hash.slice(
    "#recover=".length,
  );
  assert.equal(
    (await f.finish(await f.start(), { uid: "old-phone" })).status,
    401,
  );
  const replaced = await f.finish(
    await f.start({ phone: "+15005550129" }),
    { uid: "replacement-phone", phone: "+15005550129" },
    { recovery },
  );
  assert.equal(replaced.status, 200, JSON.stringify(replaced.body));
  assert.equal(
    (await f.request("/api/session", { cookie: replaced.cookie })).body.role,
    "host",
  );
  assert.equal(
    f.store.get("account-recovery", record.id, P).status,
    "completed",
  );
  assert.equal(
    f.store.get("personal-household", f.profile.id, P).members[0].identity,
    f.identity,
  );
  assert.equal(
    (
      await f.finish(
        await f.start({ phone: "+15005550129" }),
        { uid: "replacement-phone", phone: "+15005550129" },
        { recovery },
      )
    ).status,
    401,
  );
});
test("account-specific cooldowns and inactive Firebase gates do not send any provider messages", async (t) => {
  const f = await firebaseFixture(t),
    a = await f.start();
  assert.equal(a.status, 200);
  assert.equal(
    (
      await f.request("/api/firebase/start", {
        method: "POST",
        data: { first: "Alex", last: "Example", phone: "+15005550121" },
      })
    ).status,
    429,
  );
  assert.equal(
    (
      await f.request("/api/passwordless/start", {
        method: "POST",
        data: { first: "Alex", last: "Example", phone: "+15005550121" },
      })
    ).status,
    404,
  );
  for (const route of [
    "/api/username-recovery",
    "/api/host/events/synthetic/reminders",
    "/api/host/events/synthetic/evites",
    "/api/personal/phone/start",
  ])
    assert.equal(
      (
        await f.request(route, {
          method: "POST",
          cookie: f.host.cookie,
          data: {},
        })
      ).status,
      410,
    );
  assert.equal(f.store.all("SELECT * FROM reminder_deliveries").length, 0);
});

test("approved new household owners enroll their own Firebase phone without routine admin approval", async (t) => {
  const f = await firebaseFixture(t),
    newHost = await f.createHost("NewOwner");
  const a = await f.start({
    first: "New",
    last: "Owner",
    phone: "+15005550128",
  });
  const result = await f.request("/api/firebase/verify", {
    method: "POST",
    cookie: a.cookie + "; " + newHost.cookie,
    data: {
      reference: a.body.reference,
      idToken: token(f.env, { uid: "new-owner", phone: "+15005550128" }),
    },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const session = await f.request("/api/session", { cookie: result.cookie });
  assert.equal(session.body.role, "host");
  assert.equal(session.body.household.id, newHost.household.id);
});
test("recovery relationships use actual links and expose no private notes or unrelated guests", async (t) => {
  const f = await firebaseFixture(t),
    other = await f.createHost("KnownHost"),
    guest = await f.guest(other, {
      first: "Alex",
      last: "Example",
      phone: "+15005550121",
    });
  f.store.run(
    "UPDATE guest_identity_links SET identity=? WHERE household=? AND guest=?",
    f.identity,
    other.household.id,
    guest.id,
  );
  const record = f.store.get("guest", guest.id, other.household.id);
  f.store.put(
    "guest",
    guest.id,
    other.household.id,
    { ...record, notes: "PRIVATE NOTE NEVER EXPOSE" },
    record.version,
  );
  await f.guest(other, {
    first: "Unrelated",
    last: "Private",
    phone: "+15005550125",
  });
  await f.request("/api/account-recovery", {
    method: "POST",
    data: { first: "Alex", last: "Example", householdId: f.profile.publicCode },
  });
  const listed = await f.request("/api/admin/account-recovery", {
    method: "POST",
    cookie: f.admin,
    data: { action: "list", password: f.password },
  });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.records[0].contacts.length, 1);
  assert.equal(
    listed.body.records[0].contacts[0].household,
    other.household.name,
  );
  assert.doesNotMatch(
    JSON.stringify(listed.body),
    /PRIVATE NOTE NEVER EXPOSE|Unrelated|15005550125/,
  );
});

test("disabled Firebase users and revoked provider tokens fail closed before Gather authorization", async (t) => {
  const f = await firebaseFixture(t);
  for (const user of [
    {
      localId: "synthetic-phone-user",
      phoneNumber: "+15005550121",
      disabled: true,
    },
    {
      localId: "synthetic-phone-user",
      phoneNumber: "+15005550121",
      validSince: Math.floor(Date.now() / 1000) + 1,
    },
  ]) {
    const fetcher = async (url, options) =>
      url.includes("accounts:lookup")
        ? Response.json({ users: [user] })
        : firebaseFetcher(url, options);
    await assert.rejects(
      verifyFirebaseToken(token(f.env), f.env, { fetcher }),
      (e) => e.status === 401,
    );
  }
});

test("all-device sign-out rejects pre-revocation Firebase proofs while fresh SMS authentication can return", async (t) => {
  const f = await firebaseFixture(t),
    signed = await f.finish(await f.start());
  assert.equal(signed.status, 200);
  const old = Math.floor(Date.now() / 1000);
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
  assert.equal(
    (await f.finish(await f.start(), { auth_time: old, iat: old + 1 })).status,
    401,
  );
  assert.equal(
    (await f.finish(await f.start(), { auth_time: old + 2, iat: old + 2 }))
      .status,
    200,
  );
});
test("unmatched recovery requires an explicitly reviewed central identity, never a public automatic association", async (t) => {
  const f = await firebaseFixture(t);
  await f.request("/api/account-recovery", {
    method: "POST",
    data: { first: "Unknown", last: "Hint", householdId: f.profile.publicCode },
  });
  const request = f.store.list("account-recovery", P)[0];
  assert.equal(request.subject, null);
  const data = {
    id: request.id,
    version: request.version,
    action: "authorize",
    password: f.password,
    review: "Independent review identified correct account.",
    subject: "user:" + f.host.user,
    phone: "+15005550129",
  };
  assert.equal(
    (
      await f.request("/api/admin/account-recovery", {
        method: "POST",
        cookie: f.admin,
        data,
      })
    ).status,
    400,
  );
  const authorized = await f.request("/api/admin/account-recovery", {
    method: "POST",
    cookie: f.admin,
    data: { ...data, verifiedIdentity: true },
  });
  assert.equal(authorized.status, 200);
  assert.equal(
    f.store.get("account-recovery", request.id, P).subject,
    "user:" + f.host.user,
  );
});

test("reviewed recovery can retain the Firebase UID after a verified provider phone change", async (t) => {
  const f = await firebaseFixture(t);
  assert.equal((await f.finish(await f.start())).status, 200);
  await f.request("/api/account-recovery", {
    method: "POST",
    data: { first: "Alex", last: "Example", householdId: f.profile.publicCode },
  });
  const r = f.store.list("account-recovery", P)[0];
  const issued = await f.request("/api/admin/account-recovery", {
    method: "POST",
    cookie: f.admin,
    data: {
      id: r.id,
      version: r.version,
      action: "authorize",
      password: f.password,
      review: "Independently verified identity.",
      phone: "+15005550129",
      verifiedIdentity: true,
    },
  });
  const recovery = new URL(issued.body.recoveryURL).hash.slice(
    "#recover=".length,
  );
  const result = await f.finish(
    await f.start({ phone: "+15005550129" }),
    { phone: "+15005550129" },
    { recovery },
  );
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(f.store.list("firebase-account", P).length, 1);
});

test("restricted recovery queue pagination keeps older requests reachable", async (t) => {
  const f = await firebaseFixture(t);
  for (let i = 0; i < 51; i++)
    f.store.put("account-recovery", "synthetic-" + i, P, {
      first: "Synthetic",
      last: "Request",
      householdId: "0000",
      status: "pending",
      at: i,
      subject: null,
    });
  const first = await f.request("/api/admin/account-recovery", {
    method: "POST",
    cookie: f.admin,
    data: { action: "list", password: f.password },
  });
  assert.equal(first.body.records.length, 50);
  assert.equal(first.body.nextOffset, 50);
  const next = await f.request("/api/admin/account-recovery", {
    method: "POST",
    cookie: f.admin,
    data: { action: "list", password: f.password, offset: 50 },
  });
  assert.equal(next.body.records.length, 1);
  assert.equal(next.body.records[0].id, "synthetic-0");
  assert.equal(next.body.nextOffset, null);
});

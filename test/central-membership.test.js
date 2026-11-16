import { referenceFor, resolveRSVPReference } from "../server/rsvp-cards.js";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { application, password } from "./helpers/application.js";
import {
  ensurePersonalProfile,
  profileForIdentity,
} from "../server/personal-accounts.js";
import {
  startPasswordless,
  runPasswordlessMessages,
  subjectByKey,
} from "../server/passwordless.js";
const P = "platform",
  origin = "https://gather.ilymmd.com";
const env = {
  PASSWORDLESS_ENABLED: "true",
  PASSWORDLESS_ACTIVATION_APPROVED: "true",
  GATHER_UNIVERSAL_ENABLED: "true",
  AUTH_SMS_ENABLED: "true",
  SMS_ENABLED: "false",
  TWILIO_ACCOUNT_SID: "synthetic",
  TWILIO_AUTH_TOKEN: "synthetic",
  TWILIO_FROM: "+15005550006",
};
async function fixture(t) {
  const f = await application(t, env, {
      origin,
      householdHosts: new Set(["alpha.ilymmd.com"]),
    }),
    host = await f.host("Alpha");
  const ready = ensurePersonalProfile(f.store, {
    role: "host",
    user: host.user,
    household: host.household.id,
  });
  const profile = ready.profile,
    owner = profile.members.find((p) => p.identity === ready.identity);
  const account = f.store.get("person-account", ready.identity, P);
  f.store.put(
    "person-account",
    ready.identity,
    P,
    { ...account, recoveryPhone: "+15005550111", recoveryVerified: true },
    account.version,
  );
  const saved = await f.request("/api/personal/family", {
    method: "PUT",
    cookie: host.cookie,
    version: profile.version,
    data: {
      ...profile,
      members: [
        ...profile.members,
        {
          id: randomUUID(),
          first: "Pat",
          last: "Example",
          phone: "+15005550112",
          parent: "",
        },
        {
          id: randomUUID(),
          first: "Riley",
          last: "",
          phone: "",
          parent: owner.id,
        },
      ],
    },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const current = profileForIdentity(f.store, ready.identity),
    adult = current.members.find((p) => p.first === "Pat"),
    child = current.members.find((p) => p.first === "Riley");
  async function action(person, action, extra = {}, cookie = f.admin) {
    const current = profileForIdentity(f.store, person.identity),
      member = f.store.get(
        "household-member",
        person.identity,
        host.household.id,
      );
    return f.request("/api/admin/central-membership", {
      method: "POST",
      cookie,
      data: {
        identity: person.identity,
        household: host.household.id,
        profileVersion: current.version,
        version: member?.version || 0,
        password,
        action,
        reviewedIdentity: true,
        verifiedOutOfBand: true,
        consented: true,
        ...extra,
      },
    });
  }
  let requestNumber = 0;
  async function sign(person, phone, cookies = "") {
    const moment = Date.now() + 61000 * ++requestNumber;
    const binding = randomBytes(32).toString("base64url"),
      messages = [];
    await startPasswordless(
      f.store,
      env,
      { first: person.first, last: person.parent ? "" : person.last, phone },
      { origin, binding, ip: randomUUID(), cookies, now: () => moment },
    );
    await runPasswordlessMessages(f.store, env, {
      now: () => moment,
      fetcher: async (_url, options) => {
        messages.push(new URLSearchParams(options.body).get("Body"));
        return Response.json({ sid: "synthetic" });
      },
    });
    if (!messages.length) return { messages };
    const link = new URL(messages[0].match(/https:\/\/\S+/)[0]),
      [challenge, token] = link.hash.slice(1).split(".");
    const signed = await f.request("/api/passwordless/redeem", {
      method: "POST",
      cookie:
        "__Host-gather_login=" + binding + (cookies ? "; " + cookies : ""),
      data: { challenge, token },
    });
    return { ...signed, messages };
  }
  return {
    ...f,
    createHost: f.host,
    host,
    owner,
    ownerIdentity: ready.identity,
    adult,
    child,
    action,
    sign,
  };
}
test("verified approved central adults share host authority without separate family accounts; other hosts cannot approve", async (t) => {
  const f = await fixture(t);
  assert.equal(subjectByKey(f.store, "person:" + f.adult.identity), undefined);
  assert.equal(
    (
      await f.action(
        f.adult,
        "approve-adult",
        { phone: f.adult.phone },
        f.host.cookie,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.action(f.adult, "approve-adult", {
        phone: f.adult.phone,
        verifiedOutOfBand: false,
      })
    ).status,
    400,
  );
  assert.equal(
    (await f.action(f.adult, "approve-adult", { phone: f.adult.phone })).status,
    200,
  );
  assert.equal(
    f.store.one("SELECT id FROM family_members WHERE id=?", f.adult.identity),
    undefined,
  );
  const signed = await f.sign(f.adult, f.adult.phone);
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  const session = (await f.request("/api/session", { cookie: signed.cookie }))
    .body;
  assert.equal(session.role, "host");
  assert.equal(session.household.id, f.host.household.id);
  assert.equal(
    (await f.request("/api/host", { cookie: signed.cookie })).status,
    200,
  );
  const beta = await f.createHost("Beta");
  assert.equal(
    (
      await f.request("/api/host/events/not-owned", {
        method: "PUT",
        cookie: signed.cookie,
        version: 1,
        data: {},
      })
    ).status,
    404,
  );
  assert.notEqual(beta.household.id, session.household.id);
});
test("children default off; guardian-mediated login requires enrolled browser and revokes immediately when disabled", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.sign(f.child, "+15005550111")).messages.length, 0);
  const approved = await f.action(f.child, "approve-child", {
    phone: "",
    allowSignIn: true,
    guardian: f.ownerIdentity,
    guardianConsent: true,
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal((await f.sign(f.child, "+15005550111")).messages.length, 0);
  const enrolled = await f.action(f.child, "child-device");
  assert.equal(enrolled.status, 200, JSON.stringify(enrolled.body));
  const [reference, token] = new URL(enrolled.body.url).hash
    .split("=")[1]
    .split(".");
  const device = await f.request("/api/central/child-device", {
    method: "POST",
    data: { reference, token },
  });
  assert.equal(device.status, 200);
  assert.equal(
    (
      await f.request("/api/central/child-device", {
        method: "POST",
        data: { reference, token },
      })
    ).status,
    401,
  );
  const signed = await f.sign(f.child, "+15005550111", device.cookie);
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  assert.equal(
    (await f.request("/api/session", { cookie: signed.cookie })).body
      .householdRole,
    "kid",
  );
  assert.equal(
    (await f.request("/api/host", { cookie: signed.cookie })).status,
    403,
  );
  assert.equal(
    (await f.request("/api/personal", { cookie: signed.cookie })).status,
    403,
  );
  // Enrollment expires for new authentication, not an already authorized device.
  for (const record of f.store.list("child-device", "platform"))
    f.store.put(
      "child-device",
      record.id,
      "platform",
      { ...record, at: Date.now() - 31 * 86400000 },
      record.version,
    );
  const workspace = await f.request("/api/family", { cookie: signed.cookie });
  assert.equal(workspace.status, 200, JSON.stringify(workspace.body));
  assert.equal(workspace.body.records.length, 0);
  const member = f.store.get(
    "household-member",
    f.child.identity,
    f.host.household.id,
  );
  assert.equal(
    (
      await f.request("/api/central/family", {
        method: "POST",
        cookie: f.host.cookie,
        data: {
          member: f.child.id,
          version: member.version,
          allowSignIn: false,
        },
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.request("/api/session", { cookie: signed.cookie })).body.role,
    null,
  );
  assert.equal(
    (await f.sign(f.child, "+15005550111", device.cookie)).messages.length,
    0,
  );
});
test("adult release retains central identity, grants independent guest family and severs old authority", async (t) => {
  const f = await fixture(t);
  await f.action(f.adult, "approve-adult", { phone: f.adult.phone });
  const signed = await f.sign(f.adult, f.adult.phone);
  assert.equal(signed.status, 200);
  f.store.put("response", "unrelated-response", "other-house", {
    guest: "stable-guest",
    event: "stable-event",
    status: "yes",
    identity: f.adult.identity,
  });
  const before = f.store.get("response", "unrelated-response", "other-house");
  const beta = await f.createHost("Beta");
  const contact = await f.guest(beta, {
    first: f.adult.first,
    last: f.adult.last,
  });
  f.store.run(
    "UPDATE guest_identity_links SET identity=? WHERE household=? AND guest=?",
    f.adult.identity,
    beta.household.id,
    contact.id,
  );
  const invitation = await f.event(beta, [contact]);
  const reference = referenceFor(f.store, beta.household.id, invitation, {
    id: contact.id,
    guests: [contact.id],
  });
  const hosts = new Set(["alpha.ilymmd.com", "beta.ilymmd.com"]);
  assert.equal(
    resolveRSVPReference(
      f.store,
      reference,
      f.store.session(signed.cookie.split("=")[1], origin),
      hosts,
    ).destination,
    "https://beta.ilymmd.com/",
  );
  const result = await f.action(f.adult, "release");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.match(result.body.householdId, /^\d{4}$/);
  assert.equal(
    (await f.request("/api/host", { cookie: signed.cookie })).status,
    401,
  );
  const profile = profileForIdentity(f.store, f.adult.identity);
  assert.equal(profile.sourceHousehold, null);
  assert.equal(profile.members[0].id, f.adult.id);
  const former = profileForIdentity(f.store, f.ownerIdentity);
  const unchanged = await f.request("/api/personal/family", {
    method: "PUT",
    cookie: f.host.cookie,
    version: former.version,
    data: { ...former, members: former.members.filter((p) => !p.archived) },
  });
  assert.equal(unchanged.status, 200, JSON.stringify(unchanged.body));
  const retained = profileForIdentity(f.store, f.ownerIdentity);
  assert.equal(
    retained.members.find((p) => p.id === f.adult.id).archived,
    true,
  );
  const resurrect = await f.request("/api/personal/family", {
    method: "PUT",
    cookie: f.host.cookie,
    version: retained.version,
    data: { ...retained, members: retained.members },
  });
  assert.equal(resurrect.status, 400);
  assert.equal(profileForIdentity(f.store, f.adult.identity).id, profile.id);

  assert.deepEqual(
    f.store.get("response", "unrelated-response", "other-house"),
    before,
  );
  const guest = await f.sign(f.adult, f.adult.phone);
  assert.equal(guest.status, 200, JSON.stringify(guest.body));
  const session = (await f.request("/api/session", { cookie: guest.cookie }))
    .body;
  assert.equal(session.role, "guest");
  assert.equal(
    resolveRSVPReference(
      f.store,
      reference,
      f.store.session(guest.cookie.split("=")[1], origin),
      hosts,
    ).destination,
    "https://gather.ilymmd.com/beta",
  );
  const personal = await f.request("/api/personal", { cookie: guest.cookie });
  assert.equal(personal.status, 200, JSON.stringify(personal.body));
  assert.equal(personal.body.account.householdId, result.body.householdId);
  assert.equal(
    (await f.request("/api/family", { cookie: guest.cookie })).status,
    403,
  );
  assert.equal((await f.action(f.owner, "release")).status, 400);
});
test("adulthood transition preserves identity, requires explicit review and never silently grants host", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.action(f.child, "adulthood", {
        verifiedAge: false,
        remainHousehold: true,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.action(f.child, "adulthood", {
        verifiedAge: true,
        remainHousehold: true,
        last: "Example",
      })
    ).status,
    200,
  );
  const member = f.store.get(
    "household-member",
    f.child.identity,
    f.host.household.id,
  );
  assert.equal(member.status, "pending");
  assert.equal(member.allowSignIn, false);
  const profile = profileForIdentity(f.store, f.child.identity);
  assert.equal(
    profile.members.find((p) => p.identity === f.child.identity).id,
    f.child.id,
  );
  assert.equal(
    (await f.sign({ ...f.child, parent: "", last: "Example" }, "+15005550111"))
      .messages.length,
    0,
  );
  assert.equal(
    (
      await f.action({ ...f.child, parent: "" }, "approve-adult", {
        phone: "+15005550113",
      })
    ).status,
    200,
  );
  const signed = await f.sign(
    { ...f.child, parent: "", last: "Example" },
    "+15005550113",
  );
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
});
test("child's own independently verified phone works without guardian device; duplicate name and phone is rejected", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.action(f.child, "approve-child", {
        phone: "+15005550114",
        allowSignIn: true,
      })
    ).status,
    200,
  );
  const signed = await f.sign(f.child, "+15005550114");
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  const p = profileForIdentity(f.store, f.ownerIdentity),
    duplicate = { ...f.child, id: randomUUID(), identity: randomUUID() };
  f.store.put(
    "personal-household",
    p.id,
    P,
    { ...p, members: [...p.members, duplicate] },
    p.version,
  );
  f.store.put("personal-member", duplicate.identity, P, {
    profile: p.id,
    member: duplicate.id,
  });
  assert.equal(
    (
      await f.action(duplicate, "approve-child", {
        phone: "+15005550114",
        allowSignIn: true,
      })
    ).status,
    200,
  );
  assert.equal((await f.sign(f.child, "+15005550114")).messages.length, 0);
});

test("reviewed adulthood release allocates a distinct permanent guest household without creating a host", async (t) => {
  const f = await fixture(t),
    before = f.store.one("SELECT count(*) AS n FROM users WHERE role='host'").n;
  const result = await f.action(f.child, "adulthood", {
    verifiedAge: true,
    remainHousehold: false,
    last: "Example",
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const profile = profileForIdentity(f.store, f.child.identity);
  assert.equal(profile.sourceHousehold, null);
  assert.match(profile.publicCode, /^\d{4}$/);
  assert.equal(profile.members[0].identity, f.child.identity);
  assert.equal(profile.members[0].id, f.child.id);
  assert.equal(profile.members[0].parent, "");
  assert.equal(
    f.store.one("SELECT count(*) AS n FROM users WHERE role='host'").n,
    before,
  );
  assert.equal(
    (await f.sign({ ...f.child, parent: "", last: "Example" }, "+15005550111"))
      .messages.length,
    0,
    "adult must enroll their own verified delivery path",
  );
  assert.equal(
    f.store.get("household-member", f.child.identity, f.host.household.id)
      .status,
    "released",
  );
});

test("restricted roster review requires fresh administrator authentication and host edits cannot change approved adult information", async (t) => {
  const f = await fixture(t);
  const list = (cookie, pw) =>
    f.request("/api/admin/central-membership", {
      method: "POST",
      cookie,
      data: { action: "list", household: f.host.household.id, password: pw },
    });
  assert.equal((await list(f.host.cookie, password)).status, 403);
  assert.equal((await list(f.admin, "wrong-password")).status, 403);
  const view = await list(f.admin, password);
  assert.equal(view.status, 200);
  assert.equal(view.body.people.length, 3);
  await f.action(f.adult, "approve-adult", { phone: f.adult.phone });
  const profile = profileForIdentity(f.store, f.ownerIdentity);
  const edit = await f.request("/api/personal/family", {
    method: "PUT",
    cookie: f.host.cookie,
    version: profile.version,
    data: {
      ...profile,
      members: profile.members.map((p) =>
        p.id === f.adult.id ? { ...p, phone: "+15005550999" } : p,
      ),
    },
  });
  assert.equal(edit.status, 403);
  const changed = await f.action(f.adult, "release", { profileVersion: 0 });
  assert.equal(changed.status, 409);
  assert.equal(profileForIdentity(f.store, f.adult.identity).id, profile.id);
});

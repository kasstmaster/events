import test from "node:test";
import assert from "node:assert/strict";
import { application, password } from "./helpers/application.js";
import { ensurePersonalProfile } from "../server/personal-accounts.js";
const path = (event) => `/api/host/events/${event.id}/family-rsvp`;
const save = (f, host, event, version, attendance, claims = {}) =>
  f.request(path(event), {
    method: "PUT",
    cookie: host.cookie,
    data: { version, attendance, claims },
  });

test("host family is automatically projected, optional and counted only when attending; versions and tenant boundaries hold", async (t) => {
  const f = await application(t),
    a = await f.host("Alpha"),
    b = await f.host("Beta");
  const adult = await f.member(a, "member", "Jordan"),
    child = await f.member(a, "kid", "Riley");
  const guest = await f.guest(a),
    other = await f.guest(a, { first: "Taylor" }),
    event = await f.event(a, [guest, other]);
  const login = await f.guestLogin(a, guest);
  const get = await f.request(path(event), { cookie: a.cookie });
  assert.equal(get.status, 200);
  assert.equal(get.body.members.length, 3);
  assert.deepEqual(
    get.body.members.map((m) => !!m.parent),
    [false, false, true],
  );
  assert.deepEqual(get.body.totals, {
    invited: 2,
    attending: 0,
    declined: 0,
    noResponse: 2,
  });
  assert.equal(f.store.list("guest", a.household.id).length, 2);
  assert.equal(f.store.list("response", a.household.id).length, 0);
  assert.equal(
    (await f.request(path(event), { cookie: b.cookie })).status,
    404,
  );
  assert.equal(
    (await f.request(path(event), { cookie: adult.cookie })).status,
    403,
  );
  assert.equal(
    (await f.request(path(event), { cookie: login.cookie })).status,
    403,
  );
  assert.equal(
    (await save(f, a, event, 0, { "family-foreign": "yes" })).status,
    400,
  );
  assert.equal(
    (await save(f, a, event, 0, { ["family-" + child.id]: "yes" })).status,
    400,
  );
  assert.equal(f.store.list("response", a.household.id).length, 0);
  const attendance = Object.fromEntries(
    get.body.members.map((m) => [m.id, "yes"]),
  );
  let result = await save(f, a, event, 0, attendance);
  assert.equal(result.status, 200);
  assert.deepEqual(f.store.get("event", event.id, a.household.id), event);
  assert.deepEqual(result.body.totals, {
    invited: 2,
    attending: 3,
    declined: 0,
    noResponse: 2,
  });
  assert.equal((await save(f, a, event, 0, attendance)).status, 409);
  result = await save(f, a, event, result.body.response.version, {
    ["family-" + adult.id]: "no",
    ["family-" + child.id]: "",
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.totals, {
    invited: 2,
    attending: 2,
    declined: 0,
    noResponse: 2,
  });
  const guestSaved = await f.request(`/api/guest/events/${event.id}/rsvp`, {
    method: "PUT",
    cookie: login.cookie,
    data: { version: 0, attendance: { [guest.id]: "yes" }, claims: {} },
  });
  assert.equal(guestSaved.status, 200);
  assert.deepEqual(guestSaved.body.totals, { attending: 3, invited: 2 });
  assert.ok(!JSON.stringify(guestSaved.body).includes("family-" + a.user));
  assert.ok(!JSON.stringify(guestSaved.body).includes("Riley"));
  assert.equal(
    (
      await f.request(`/api/guest/events/${event.id}/rsvp`, {
        method: "PUT",
        cookie: login.cookie,
        data: {
          version: guestSaved.body.response.version,
          hostFamily: true,
          attendance: { ["family-" + a.user]: "yes" },
          claims: {},
        },
      })
    ).status,
    400,
  );
  const edited = await f.request("/api/host/events/" + event.id, {
    method: "PUT",
    cookie: a.cookie,
    version: event.version,
    data: { ...event, title: "Edited without rewriting invitations" },
  });
  assert.equal(edited.status, 200);
  assert.deepEqual(edited.body.invited, event.invited);
  const dashboard = (
    await f.request("/api/host/events/" + event.id + "/dashboard", {
      cookie: a.cookie,
    })
  ).body;
  assert.equal(dashboard.hostFamily.length, 3);
  assert.deepEqual(dashboard.totals, {
    invited: 2,
    attending: 3,
    declined: 0,
    noResponse: 1,
  });
  const removal = await f.request("/api/host/events/" + event.id, {
    method: "PUT",
    cookie: a.cookie,
    version: edited.body.version,
    data: { ...edited.body, invited: [other.id] },
  });
  assert.equal(removal.status, 409);
  const currentFamily = (await f.request(path(event), { cookie: a.cookie }))
    .body;
  const declinedFamily = await save(
    f,
    a,
    event,
    currentFamily.response.version,
    Object.fromEntries(
      currentFamily.members.map((member) => [member.id, "no"]),
    ),
  );
  assert.equal(declinedFamily.status, 200);
  assert.deepEqual(declinedFamily.body.totals, {
    invited: 2,
    attending: 1,
    declined: 0,
    noResponse: 1,
  });
  const another = await f.event(a, []);
  assert.deepEqual(
    (await f.request(path(another), { cookie: a.cookie })).body.totals,
    { invited: 0, attending: 0, declined: 0, noResponse: 0 },
  );
});

test("host family uses the shared transactional menu limits, preserves deadlines and guest responses, and releases its own claims", async (t) => {
  const f = await application(t),
    host = await f.host("Capacity"),
    guest = await f.guest(host);
  const event = await f.event(host, [guest], {
    menu: [{ id: "salad", name: "Salad", kind: "potluck", quantity: 1 }],
  });
  const login = await f.guestLogin(host, guest);
  const mine = (await f.request(path(event), { cookie: host.cookie })).body
    .members[0];
  let family = await save(
    f,
    host,
    event,
    0,
    { [mine.id]: "yes" },
    { salad: 1 },
  );
  assert.equal(family.status, 200);
  assert.equal(
    (
      await f.request("/api/host/events/" + event.id, {
        method: "PUT",
        cookie: host.cookie,
        version: event.version,
        data: { ...event, menu: [] },
      })
    ).status,
    409,
  );
  const data = {
    version: 0,
    attendance: { [guest.id]: "yes" },
    claims: { salad: 1 },
  };
  assert.equal(
    (
      await f.request(`/api/guest/events/${event.id}/rsvp`, {
        method: "PUT",
        cookie: login.cookie,
        data,
      })
    ).status,
    409,
  );
  assert.equal(f.store.list("response", host.household.id).length, 1);
  family = await save(f, host, event, family.body.response.version, {
    [mine.id]: "no",
  });
  assert.equal(family.status, 200);
  assert.deepEqual(family.body.response.claims, {});
  assert.equal(family.body.totals.declined, 0);
  const saved = await f.request(`/api/guest/events/${event.id}/rsvp`, {
    method: "PUT",
    cookie: login.cookie,
    data,
  });
  assert.equal(saved.status, 200);
  const before = f.store.get(
    "response",
    `${event.id}:${guest.id}`,
    host.household.id,
  );
  const closed = f.store.put(
    "event",
    event.id,
    host.household.id,
    { ...event, deadline: "2000-01-01" },
    event.version,
  );
  assert.equal(
    (
      await f.request(`/api/guest/events/${event.id}/rsvp`, {
        method: "PUT",
        cookie: login.cookie,
        data: { ...data, version: saved.body.response.version },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await save(f, host, closed, family.body.response.version, {
        [mine.id]: "yes",
      })
    ).status,
    200,
  );
  assert.deepEqual(
    f.store.get("response", `${event.id}:${guest.id}`, host.household.id),
    before,
  );
  assert.equal(
    f.store.get("event", event.id, host.household.id).deadline,
    "2000-01-01",
  );
});

test("central host-family names and dependents are projected without guest creation; inactive family members leave attendance without deleting history", async (t) => {
  const f = await application(t),
    host = await f.host("Profiles");
  const { profile } = ensurePersonalProfile(f.store, {
    role: "host",
    user: host.user,
    household: host.household.id,
  });
  const primary = profile.members[0];
  f.store.put(
    "personal-household",
    profile.id,
    "platform",
    {
      ...profile,
      members: [
        { ...primary, first: "Alex", last: "Example" },
        {
          id: "central-child",
          identity: "synthetic-child",
          first: "Sam",
          last: "",
          parent: primary.id,
        },
      ],
    },
    profile.version,
  );
  const child = await f.member(host, "kid", "Robin"),
    event = await f.event(host, []);
  const roster = (await f.request(path(event), { cookie: host.cookie })).body;
  assert.ok(roster.members.some((m) => m.first === "Alex"));
  assert.ok(
    roster.members.some(
      (m) =>
        m.id === "person-central-child" && m.parent === "family-" + host.user,
    ),
  );
  let result = await save(
    f,
    host,
    event,
    0,
    Object.fromEntries(roster.members.map((m) => [m.id, "yes"])),
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.totals.attending, 3);
  const before = f.store.get(
    "response",
    `${event.id}:host-family`,
    host.household.id,
  );
  f.store.run("UPDATE family_members SET disabled=1 WHERE id=?", child.id);
  result = await f.request(path(event), { cookie: host.cookie });
  assert.equal(result.body.totals.attending, 2);
  assert.deepEqual(
    f.store.get("response", `${event.id}:host-family`, host.household.id),
    before,
  );
  assert.equal(f.store.list("guest", host.household.id).length, 0);
});

test("roster-only family members can receive optional sign-ins without duplicate RSVP people or lost history", async (t) => {
  const f = await application(t),
    host = await f.host("Roster"),
    other = await f.host("Other");
  await f.request("/api/family", { cookie: host.cookie });
  const original = (await f.request("/api/personal", { cookie: host.cookie }))
    .body;
  const before = f.store.all(
    "SELECT id FROM family_members WHERE household=?",
    host.household.id,
  ).length;
  const saved = await f.request("/api/personal/family", {
    method: "PUT",
    cookie: host.cookie,
    version: original.profile.version,
    data: {
      ...original.profile,
      members: [
        ...original.profile.members,
        {
          first: "Child",
          last: "",
          phone: "",
          suffix: "",
          parent: original.self,
        },
      ],
    },
  });
  assert.equal(saved.status, 200);
  const person = saved.body.profile.members.find((p) => p.first === "Child");
  assert.equal(
    f.store.all(
      "SELECT id FROM family_members WHERE household=?",
      host.household.id,
    ).length,
    before,
  );
  const event = await f.event(host, []);
  const roster = (await f.request(path(event), { cookie: host.cookie })).body;
  assert.equal(roster.members.length, 2);
  const participant = roster.members.find((p) => p.first === "Child");
  assert.equal(
    (
      await save(f, host, event, 0, {
        [participant.id]: "yes",
        [roster.members.find((p) => !p.parent).id]: "yes",
      })
    ).status,
    200,
  );
  const payload = {
    name: "Spoofed",
    login: "child.access",
    password,
    role: "kid",
    profileMember: person.id,
    profileVersion: saved.body.profile.version,
  };
  assert.equal(
    (
      await f.request("/api/family/members", {
        method: "POST",
        cookie: host.cookie,
        data: { ...payload, role: "administrator" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request("/api/family/members", {
        method: "POST",
        cookie: other.cookie,
        data: {
          ...payload,
          profileVersion: (
            await f.request("/api/personal", { cookie: other.cookie })
          ).body.profile.version,
        },
      })
    ).status,
    400,
  );
  const created = await f.request("/api/family/members", {
    method: "POST",
    cookie: host.cookie,
    data: payload,
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.name, "Child");
  assert.equal(created.body.profileMember, person.id);
  assert.equal(
    (
      await f.request("/api/family/members", {
        method: "POST",
        cookie: host.cookie,
        data: { ...payload, login: "duplicate" },
      })
    ).status,
    409,
  );
  const after = (await f.request(path(event), { cookie: host.cookie })).body;
  assert.deepEqual(after.members, roster.members);
  assert.equal(after.totals.attending, 2);
  const login = await f.request(
    `/api/public/households/${host.household.slug}/members/login`,
    { method: "POST", data: { login: payload.login, password } },
  );
  assert.equal(login.status, 200);
  const archived = await f.request("/api/personal/family", {
    method: "PUT",
    cookie: host.cookie,
    version: saved.body.profile.version,
    data: {
      ...saved.body.profile,
      members: saved.body.profile.members.filter((p) => p.id !== person.id),
    },
  });
  assert.equal(archived.status, 200);
  assert.equal(
    (await f.request("/api/family", { cookie: login.cookie })).status,
    403,
  );
  const final = (await f.request(path(event), { cookie: host.cookie })).body;
  assert.equal(final.members.length, 1);
  assert.equal(final.totals.attending, 1);
  assert.equal(final.response.attendance[participant.id], "yes");
});

import test from "node:test";
import assert from "node:assert/strict";
import { application } from "./helpers/application.js";

test("invite codes are required; identical names remain separate and codes survive edits", async (t) => {
  const f = await application(t),
    a = await f.host("Alpha"),
    g = await f.guest(a),
    other = await f.guest(a),
    event = await f.event(a, [g]);
  assert.equal((await f.guestLogin(a, g, { inviteCode: "" })).status, 401);
  assert.equal((await f.guestLogin(a, g, { inviteCode: "wrong" })).status, 401);
  const login = await f.guestLogin(a, g);
  assert.equal(login.status, 200);
  const view = await f.request("/api/guest", { cookie: login.cookie });
  assert.equal(view.body.events.length, 1);
  assert.equal(view.body.events[0].id, event.id);
  const wrong = await f.guestLogin(a, other);
  assert.equal(
    (await f.request("/api/guest", { cookie: wrong.cookie })).body.events
      .length,
    0,
  );
  const edited = await f.request("/api/host/guests/" + g.id, {
    method: "PUT",
    cookie: a.cookie,
    version: g.version,
    data: { ...g, first: "Changed" },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.inviteCode, g.inviteCode);
  assert.equal((await f.guestLogin(a, edited.body)).status, 200);
});
test("matching exposes minimal evidence, requires guest approval and then spans explicit invitations only", async (t) => {
  const f = await application(t),
    a = await f.host("Alpha"),
    b = await f.host("Beta"),
    c = await f.host("Gamma"),
    g = await f.guest(a),
    eventA = await f.event(a, [g]);
  const matches = await f.request("/api/host/guest-matches", {
    method: "POST",
    cookie: b.cookie,
    data: { first: g.first, last: g.last },
  });
  assert.equal(matches.status, 200);
  assert.deepEqual(Object.keys(matches.body[0]).sort(), [
    "household",
    "name",
    "ticket",
  ]);
  const second = await f.guest(b, { matchTicket: matches.body[0].ticket }),
    eventB = await f.event(b, [second]),
    stranger = await f.guest(c),
    eventC = await f.event(c, [stranger]);
  const login = await f.guestLogin(b, g);
  assert.equal(login.status, 200);
  assert.equal(
    (await f.request("/api/guest", { cookie: login.cookie })).body.events
      .length,
    1,
  );
  const requests = await f.request("/api/guest/link-requests", {
    cookie: login.cookie,
  });
  assert.equal(requests.body.length, 1);
  assert.equal(
    (
      await f.request("/api/guest/link-requests", {
        method: "POST",
        cookie: login.cookie,
        data: { id: requests.body[0].id, approve: true },
      })
    ).status,
    200,
  );
  const view = (await f.request("/api/guest", { cookie: login.cookie })).body;
  assert.deepEqual(
    new Set(view.events.map((e) => e.id)),
    new Set([eventA.id, eventB.id]),
  );
  assert.deepEqual(
    new Set(view.events.map((e) => e.invitingHousehold.name)),
    new Set(["Alpha", "Beta"]),
  );
  assert.equal(JSON.stringify(view).includes("inviteCode"), false);
  assert.equal(
    (
      await f.request("/api/guest/events/" + eventC.id + "/rsvp", {
        method: "PUT",
        cookie: login.cookie,
        data: { version: 0, attendance: { [stranger.id]: "yes" }, claims: {} },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await f.request("/api/guest/events/" + eventB.id + "/rsvp", {
        method: "PUT",
        cookie: login.cookie,
        data: {
          guestEntry: second.id,
          version: 0,
          attendance: { [second.id]: "yes" },
          claims: {},
        },
      })
    ).status,
    200,
  );
  const book = (await f.request("/api/host", { cookie: b.cookie })).body;
  assert.equal(book.guests[0].inviteCode, "");
  const unlink = await f.request("/api/host/guests/" + second.id + "/unlink", {
    method: "POST",
    cookie: b.cookie,
    version: book.guests.find((g) => g.id === second.id).version,
    data: { confirm: "Casey Example" },
  });
  assert.equal(unlink.status, 200);
  assert.notEqual(unlink.body.inviteCode, g.inviteCode);
  assert.equal(unlink.body.inviteCode, second.inviteCode);
  assert.equal(
    (await f.request("/api/guest", { cookie: login.cookie })).status,
    401,
  );
  const again = await f.guestLogin(a, g);
  assert.deepEqual(
    (await f.request("/api/guest", { cookie: again.cookie })).body.events.map(
      (e) => e.id,
    ),
    [eventA.id],
  );
  assert.equal(f.store.list("response", b.household.id).length, 1);
});
test("suffix recognition requires the correct code and supports names with and without suffixes", async (t) => {
  const f = await application(t),
    a = await f.host("Alpha"),
    jr = await f.guest(a, { suffix: "Jr." }),
    none = await f.guest(a);
  const path = "/api/public/households/" + a.household.slug + "/recognize";
  assert.equal(
    (
      await f.request(path, {
        method: "POST",
        data: { first: jr.first, last: jr.last, inviteCode: "wrong" },
      })
    ).body.suffixRequired,
    false,
  );
  assert.equal(
    (
      await f.request(path, {
        method: "POST",
        data: { first: jr.first, last: jr.last, inviteCode: jr.inviteCode },
      })
    ).body.suffixRequired,
    true,
  );
  assert.equal((await f.guestLogin(a, jr, { suffix: "" })).status, 401);
  assert.equal((await f.guestLogin(a, jr, { suffix: "JR" })).status, 200);
  assert.equal((await f.guestLogin(a, none)).status, 200);
});
test("expired deadlines close all RSVP edits and custom items are scoped, opt-in and reusable", async (t) => {
  const f = await application(t),
    a = await f.host("Alpha"),
    g = await f.guest(a),
    e = await f.event(a, [g], {
      customItemsEnabled: true,
      saveCustomItems: true,
    }),
    login = await f.guestLogin(a, g);
  const response = await f.request("/api/guest/events/" + e.id + "/rsvp", {
    method: "PUT",
    cookie: login.cookie,
    data: {
      version: 0,
      attendance: { [g.id]: "yes" },
      claims: {},
      customItems: [{ name: "Family dessert", quantity: 2 }],
    },
  });
  assert.equal(response.status, 200);
  assert.equal(
    f.store.list("menu-saved", a.household.id)[0].name,
    "Family dessert",
  );
  const before = f.store.get("event", e.id, a.household.id);
  f.store.put(
    "event",
    e.id,
    a.household.id,
    { ...before, deadline: "2000-01-01" },
    before.version,
  );
  assert.equal(
    (
      await f.request("/api/guest/events/" + e.id + "/rsvp", {
        method: "PUT",
        cookie: login.cookie,
        data: {
          version: 1,
          attendance: { [g.id]: "no" },
          claims: {},
          customItems: [],
        },
      })
    ).status,
    409,
  );
  assert.equal(
    f.store.list("response", a.household.id)[0].attendance[g.id],
    "yes",
  );
});

test("a permanent code can reconnect a relationship after host removal without changing identity or other records", async (t) => {
  const f = await application(t),
    a = await f.host("Alpha"),
    b = await f.host("Beta"),
    original = await f.guest(a),
    second = await f.guest(b);
  const before = f.store.one(
    "SELECT identity FROM guest_identity_links WHERE household=? AND guest=?",
    a.household.id,
    original.id,
  ).identity;
  f.store.run(
    "DELETE FROM guest_identity_links WHERE household=?",
    a.household.id,
  );
  f.store.remove("guest", original.id, a.household.id, original.version);
  assert.equal(
    (
      await f.request(
        "/api/public/households/" + b.household.slug + "/claim-code",
        {
          method: "POST",
          data: {
            first: second.first,
            last: second.last,
            suffix: second.suffix,
            inviteCode: second.inviteCode,
            permanentCode: original.inviteCode,
          },
        },
      )
    ).status,
    200,
  );
  assert.equal(
    f.store.one(
      "SELECT identity FROM guest_identity_links WHERE household=? AND guest=?",
      b.household.id,
      second.id,
    ).identity,
    before,
  );
  assert.equal(
    (await f.guestLogin(b, second, { inviteCode: original.inviteCode })).status,
    200,
  );
});

test("similar names and normalized addresses produce suggestions without copying private contact fields or merging", async (t) => {
  const f = await application(t),
    a = await f.host("Alpha"),
    b = await f.host("Beta");
  const addressA = (
    await f.request("/api/host/addresses", {
      method: "POST",
      cookie: a.cookie,
      data: {
        label: "Source",
        lines: "123 Maple Street, Apartment 4",
        phone: "+15550000001",
      },
    })
  ).body;
  const addressB = (
    await f.request("/api/host/addresses", {
      method: "POST",
      cookie: b.cookie,
      data: { label: "Local", lines: "123 maple st #4" },
    })
  ).body;
  const g = await f.guest(a, {
    first: "José",
    last: "Smith",
    suffix: "Jr.",
    address: addressA.id,
    phone: "+15550000002",
    notes: "Private source notes",
  });
  const matches = await f.request("/api/host/guest-matches", {
    method: "POST",
    cookie: b.cookie,
    data: { first: "Jose.", last: "Smyth", suffix: "JR", address: addressB.id },
  });
  assert.equal(matches.status, 200);
  assert.ok(matches.body.some((m) => m.household === "Alpha"));
  for (const secret of ["123 Maple", "+15550000002", "Private source notes"])
    assert.equal(JSON.stringify(matches.body).includes(secret), false);
  const separate = await f.guest(b, {
    first: "Jose",
    last: "Smyth",
    suffix: "JR",
    address: addressB.id,
    phone: "+15550000003",
  });
  assert.notEqual(separate.inviteCode, g.inviteCode);
  assert.equal(
    f.store.get("guest", g.id, a.household.id).phone,
    "+15550000002",
  );
});

test("shared child links require the designated adult first and children never sign in independently", async (t) => {
  const f = await application(t),
    a = await f.host("Alpha"),
    b = await f.host("Beta"),
    adult = await f.guest(a),
    child = await f.guest(a, { first: "Robin", parent: adult.id });
  const match = async (person) =>
    (
      await f.request("/api/host/guest-matches", {
        method: "POST",
        cookie: b.cookie,
        data: { first: person.first, last: person.last, suffix: person.suffix },
      })
    ).body.find((m) => m.household === "Alpha");
  const otherAdult = await f.guest(b, {
    matchTicket: (await match(adult)).ticket,
  });
  const otherChild = await f.guest(b, {
    first: "Robin",
    parent: otherAdult.id,
    matchTicket: (await match(child)).ticket,
  });
  await f.event(b, [otherAdult, otherChild]);
  const login = await f.guestLogin(a, adult);
  const requests = (
      await f.request("/api/guest/link-requests", { cookie: login.cookie })
    ).body,
    childRequest = requests.find((r) => r.name.startsWith("Robin")),
    adultRequest = requests.find((r) => r.name.startsWith("Casey"));
  assert.equal(
    (
      await f.request("/api/guest/link-requests", {
        method: "POST",
        cookie: login.cookie,
        data: { id: childRequest.id, approve: true },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/guest/link-requests", {
        method: "POST",
        cookie: login.cookie,
        data: { id: adultRequest.id, approve: true },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request("/api/guest/link-requests", {
        method: "POST",
        cookie: login.cookie,
        data: { id: childRequest.id, approve: true },
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.request("/api/guest", { cookie: login.cookie })).body.events[0]
      .members.length,
    2,
  );
  assert.equal((await f.guestLogin(a, child)).status, 401);
});

test("deleting the source host retains shared identity, permanent code and the other host’s invitations", async (t) => {
  const { deletionSummary, requestDeletion, finalizeDeletion } =
    await import("../server/account-deletion.js");
  const f = await application(t),
    a = await f.host("Alpha"),
    b = await f.host("Beta"),
    g = await f.guest(a);
  const ticket = (
      await f.request("/api/host/guest-matches", {
        method: "POST",
        cookie: b.cookie,
        data: g,
      })
    ).body[0].ticket,
    second = await f.guest(b, { matchTicket: ticket });
  const event = await f.event(b, [second]);
  const login = await f.guestLogin(b, g),
    pending = (
      await f.request("/api/guest/link-requests", { cookie: login.cookie })
    ).body[0];
  await f.request("/api/guest/link-requests", {
    method: "POST",
    cookie: login.cookie,
    data: { id: pending.id, approve: true },
  });
  const summary = deletionSummary(f.store, a.user);
  requestDeletion(f.store, a.user, {
    confirmEmail: summary.email,
    confirmDomain: summary.domain,
    confirmRevision: summary.revision,
    householdVersion: f.store.household(a.household.id).version,
  });
  finalizeDeletion(
    f.store,
    f.store.one(
      "SELECT * FROM household_deletions WHERE household=?",
      a.household.id,
    ),
  );
  const after = await f.guestLogin(b, { ...second, inviteCode: g.inviteCode });
  assert.equal(after.status, 200);
  assert.deepEqual(
    (await f.request("/api/guest", { cookie: after.cookie })).body.events.map(
      (e) => e.id,
    ),
    [event.id],
  );
});

test("shared invitations authenticate across actual gateway domains while keeping entry branding and origin-bound cookies", async (t) => {
  const { domainRuntime, seedDomains, alphaOrigin, betaOrigin } =
    await import("./helpers/domain-runtime.js");
  const f = await domainRuntime();
  t.after(() => f.runtime.dispose());
  const { hosts } = await seedDomains(f);
  const [a, b] = hosts;
  const g = (
    await f.request("/api/host/guests", {
      method: "POST",
      cookie: a.cookie,
      data: {
        first: "Casey",
        last: "Example",
        phone: "+15550000001",
        notes: "Private Alpha",
      },
    })
  ).body;
  const ticket = (
    await f.request("/api/host/guest-matches", {
      method: "POST",
      cookie: b.cookie,
      data: { first: "Casey", last: "Example" },
    })
  ).body.find((m) => m.household === a.name).ticket;
  const other = (
    await f.request("/api/host/guests", {
      method: "POST",
      cookie: b.cookie,
      data: {
        first: "Casey",
        last: "Example",
        phone: "+15550000002",
        matchTicket: ticket,
      },
    })
  ).body;
  for (const [host, guest] of [
    [a, g],
    [b, other],
  ])
    assert.equal(
      (
        await f.request("/api/host/events", {
          method: "POST",
          cookie: host.cookie,
          data: { title: "Shared invitation", invited: [guest.id], menu: [] },
        })
      ).status,
      201,
    );
  const login = await f.request("/api/public/households/" + b.slug + "/login", {
    origin: betaOrigin,
    method: "POST",
    data: { first: "Casey", last: "Example", inviteCode: g.inviteCode },
  });
  assert.equal(login.status, 200);
  assert.match(
    login.headers.get("set-cookie"),
    /__Host-events_session=.*Secure/,
  );
  const pending = (
    await f.request("/api/guest/link-requests", {
      origin: betaOrigin,
      cookie: login.cookie,
    })
  ).body[0];
  assert.equal(
    (
      await f.request("/api/guest/link-requests", {
        origin: betaOrigin,
        method: "POST",
        cookie: login.cookie,
        data: { id: pending.id, approve: true },
      })
    ).status,
    200,
  );
  const view = (
    await f.request("/api/guest", { origin: betaOrigin, cookie: login.cookie })
  ).body;
  assert.equal(view.household.name, b.name);
  assert.equal(view.events.length, 2);
  assert.equal(JSON.stringify(view).includes("Private Alpha"), false);
  assert.equal(JSON.stringify(view).includes("+15550000001"), false);
  assert.equal(
    (
      await f.request("/api/guest", {
        origin: alphaOrigin,
        cookie: login.cookie,
      })
    ).status,
    401,
  );
});

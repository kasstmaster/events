import test from "node:test";
import assert from "node:assert/strict";
import { application } from "./helpers/application.js";
import {
  recipientHouseholdID,
  publicEventReference,
} from "../server/public-invitations.js";
const env = { PUBLIC_INVITATIONS_ENABLED: "true" };

test("public invitation is default-off and does not disclose contacts", async (t) => {
  const f = await application(t),
    host = await f.host("Alpha"),
    guest = await f.guest(host),
    event = await f.event(host, [guest]);
  const reference = publicEventReference(f.store, host.household.id, event.id);
  assert.equal(
    (await f.request(`/api/public/events/${reference}`)).status,
    404,
  );
});

test("anonymous scoped RSVP preserves history, children and independent host books", async (t) => {
  const f = await application(t, env),
    a = await f.host("Alpha"),
    b = await f.host("Beta");
  const guest = await f.guest(a),
    child = await f.guest(a, { first: "Child", parent: guest.id }),
    unrelated = await f.guest(a, { first: "Other" });
  const duplicate = await f.guest(b),
    event = await f.event(a, [guest, child, unrelated]),
    otherEvent = await f.event(b, [duplicate]);
  const prepare = await f.request(
    `/api/host/events/${event.id}/public-invitation`,
    { method: "POST", cookie: a.cookie, data: { version: event.version } },
  );
  assert.equal(prepare.status, 200);
  const reference = prepare.body.reference,
    path = `/api/public/events/${reference}`,
    code = prepare.body.recipients.find(
      (r) => r.guest === guest.id,
    ).householdID;
  assert.equal(
    code,
    recipientHouseholdID(f.store, a.household.id, guest.id).code,
  );
  assert.notEqual(
    code,
    recipientHouseholdID(f.store, b.household.id, duplicate.id).code,
  );
  const view = await f.request(path);
  assert.equal(view.status, 200);
  assert.equal(view.cookie, undefined);
  assert.deepEqual(view.body.events[0].members, []);
  for (const field of ["invited", "notes", "reminders"])
    assert.equal(Object.hasOwn(view.body.events[0], field), false);
  assert.equal(JSON.stringify(view.body).includes(guest.first), false);
  assert.equal(
    (
      await f.request(`/api/host/events/${event.id}/public-invitation`, {
        method: "POST",
        cookie: b.cookie,
        data: { version: event.version },
      })
    ).status,
    404,
  );
  const access = await f.request(path + "/access", {
    method: "POST",
    data: { householdID: code },
  });
  assert.equal(access.status, 200);
  assert.equal(access.cookie, undefined);
  assert.deepEqual(
    access.body.event.members.map((p) => p.id),
    [guest.id, child.id],
  );
  const data = {
    grant: access.body.grant,
    version: 0,
    partyVersions: access.body.event.partyVersions,
    attendance: { [guest.id]: "yes", [child.id]: "no" },
    claims: {},
  };
  assert.equal(
    (await f.request(path + "/rsvp", { method: "PUT", data })).status,
    200,
  );
  assert.equal(f.store.totals(event, a.household.id).attending, 1);
  assert.equal(
    (await f.request(path + "/rsvp", { method: "PUT", data })).status,
    409,
  );
  const foreign = publicEventReference(f.store, b.household.id, otherEvent.id);
  assert.equal(
    (
      await f.request(`/api/public/events/${foreign}/rsvp`, {
        method: "PUT",
        data,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await f.request(`/api/public/events/${foreign}/access`, {
        method: "POST",
        data: { householdID: code },
      })
    ).status,
    404,
  );
  const before = f.store.get(
    "response",
    `${event.id}:${guest.id}`,
    a.household.id,
  );
  f.store.put(
    "event",
    event.id,
    a.household.id,
    { ...event, invited: [unrelated.id] },
    event.version,
  );
  assert.equal(
    (
      await f.request(path + "/rsvp", {
        method: "PUT",
        data: { ...data, version: 1 },
      })
    ).status,
    404,
  );
  assert.deepEqual(
    f.store.get("response", `${event.id}:${guest.id}`, a.household.id),
    before,
  );
});

test("uniform invalid ID failures are rate limited and never grant host rights", async (t) => {
  const f = await application(t, env),
    host = await f.host("Alpha"),
    guest = await f.guest(host),
    event = await f.event(host, [guest]);
  const reference = publicEventReference(f.store, host.household.id, event.id),
    path = `/api/public/events/${reference}/access`;
  for (let i = 0; i < 8; i++)
    assert.equal(
      (
        await f.request(path, {
          method: "POST",
          data: { householdID: i ? "A".repeat(32) : "1234" },
        })
      ).status,
      404,
    );
  assert.equal(
    (
      await f.request(path, {
        method: "POST",
        data: { householdID: "B".repeat(32) },
      })
    ).status,
    429,
  );
  const code = recipientHouseholdID(f.store, host.household.id, guest.id).code;
  assert.equal(
    (await f.request("/api/host", { cookie: `session=${code}` })).status,
    401,
  );
});

test("public QR enclosures include all invited household people and direct event links without authenticating", async (t) => {
  const f = await application(t, env, {
      householdHosts: new Set(["alpha.ilymmd.com"]),
    }),
    host = await f.host("Alpha"),
    adult = await f.guest(host),
    child = await f.guest(host, { first: "Riley", parent: adult.id }),
    event = await f.event(host, [adult, child]);
  const cards = await f.request(`/api/host/events/${event.id}/rsvp-cards`, {
    method: "POST",
    cookie: host.cookie,
    version: event.version,
    data: { guestIds: [adult.id] },
  });
  assert.equal(cards.status, 200);
  assert.equal(cards.body.cards.length, 1);
  const card = cards.body.cards[0];
  assert.match(
    card.url,
    /^https:\/\/gather\.ilymmd\.com\/event\/[A-Za-z0-9_-]{43}$/,
  );
  assert.deepEqual(card.guestIds.sort(), [adult.id, child.id].sort());
  assert.match(card.svg, /Riley/);
  assert.match(card.svg, /Household ID:/);
  assert.equal(card.publicInvitation, true);
  assert.equal(
    (
      await f.request(
        new URL(card.url).pathname.replace("/event/", "/api/public/events/"),
      )
    ).status,
    200,
  );
});

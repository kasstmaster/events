import test from "node:test";
import assert from "node:assert/strict";
import { application } from "./helpers/application.js";
test("bulk contact invitations are additive, atomic and versioned without rewriting content, credentials or responses", async (t) => {
  const f = await application(t),
    host = await f.host("Alpha"),
    existing = await f.guest(host),
    adult = await f.guest(host, { first: "New", last: "Adult" }),
    child = await f.guest(host, {
      first: "New",
      last: "Child",
      parent: adult.id,
    });
  const event = await f.event(host, [existing], {
    title: "Keep this content",
    notes: "Private notes",
    design: { titleColor: "#123456" },
    menu: [{ id: "salad", name: "Salad", kind: "potluck", quantity: 4 }],
  });
  const response = f.store.put(
    "response",
    "existing-response",
    host.household.id,
    {
      event: event.id,
      guest: existing.id,
      attendance: { [existing.id]: "yes" },
      claims: { salad: 1 },
      customItems: [],
    },
  );
  const newGuestSession = await f.guestLogin(host, adult);
  assert.equal(
    (await f.request("/api/guest", { cookie: newGuestSession.cookie })).body
      .events.length,
    0,
  );
  const credentials = f.store.all(
    "SELECT * FROM guest_access_links WHERE household=?",
    host.household.id,
  );
  const path = "/api/host/events/" + event.id + "/invite-guests";
  assert.equal(
    (
      await f.request(path, {
        cookie: host.cookie,
        method: "POST",
        data: { guestIds: [child.id] },
        version: event.version,
      })
    ).status,
    400,
  );
  assert.deepEqual(f.store.get("event", event.id, host.household.id), event);
  const result = await f.request(path, {
    cookie: host.cookie,
    method: "POST",
    data: { guestIds: [adult.id, child.id, existing.id] },
    version: event.version,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.added, 2);
  const saved = f.store.get("event", event.id, host.household.id);
  assert.deepEqual(saved.invited, [existing.id, adult.id, child.id]);
  const { invited, version, ...unchanged } = saved,
    { invited: oldInvited, version: oldVersion, ...before } = event;
  assert.deepEqual(unchanged, before);
  assert.equal(version, oldVersion + 1);
  assert.deepEqual(
    f.store.get("response", response.id, host.household.id),
    response,
  );
  assert.deepEqual(
    f.store.all(
      "SELECT * FROM guest_access_links WHERE household=?",
      host.household.id,
    ),
    credentials,
  );
  assert.equal(
    (
      await f.request(path, {
        cookie: host.cookie,
        method: "POST",
        data: { guestIds: [adult.id] },
        version: event.version,
      })
    ).status,
    409,
  );
  const repeat = await f.request(path, {
    cookie: host.cookie,
    method: "POST",
    data: { guestIds: [adult.id] },
    version: saved.version,
  });
  assert.equal(repeat.status, 200);
  assert.equal(repeat.body.added, 0);
  assert.equal(repeat.body.version, saved.version);
  assert.equal(f.store.list("response", host.household.id).length, 1);
  assert.ok(
    (
      await f.request("/api/guest", { cookie: newGuestSession.cookie })
    ).body.events.some((e) => e.id === event.id),
  );
});
test("bulk invitation permissions and ownership cannot be bypassed by IDs, missing versions or mixed-tenant selections", async (t) => {
  const f = await application(t),
    a = await f.host("Alpha"),
    b = await f.host("Beta"),
    mine = await f.guest(a),
    foreign = await f.guest(b),
    event = await f.event(a, []),
    other = await f.event(b, []),
    member = await f.member(a, "member", "Regular"),
    kid = await f.member(a, "kid", "Child");
  const path = "/api/host/events/" + event.id + "/invite-guests";
  const guestCookie = (await f.guestLogin(a, mine)).cookie;
  for (const cookie of [
    f.admin,
    member.cookie,
    kid.cookie,
    b.cookie,
    guestCookie,
  ])
    assert.ok(
      [403, 404].includes(
        (
          await f.request(path, {
            cookie,
            method: "POST",
            version: event.version,
            data: { guestIds: [mine.id] },
          })
        ).status,
      ),
    );
  assert.equal(
    (
      await f.request("/api/host/events/" + other.id + "/invite-guests", {
        cookie: a.cookie,
        method: "POST",
        version: other.version,
        data: { guestIds: [mine.id] },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await f.request(path, {
        cookie: a.cookie,
        method: "POST",
        version: event.version,
        data: { guestIds: [mine.id, foreign.id] },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(path, {
        cookie: a.cookie,
        method: "POST",
        data: { guestIds: [mine.id] },
      })
    ).status,
    428,
  );
  for (const guestIds of [[], [mine.id, mine.id], ["missing"], null])
    assert.equal(
      (
        await f.request(path, {
          cookie: a.cookie,
          method: "POST",
          version: event.version,
          data: { guestIds },
        })
      ).status,
      400,
    );
  assert.deepEqual(f.store.get("event", event.id, a.household.id).invited, []);
});

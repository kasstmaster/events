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

test("uninviting selected contacts is atomic, versioned and preserves responses, content and credentials", async (t) => {
  const f = await application(t),
    host = await f.host("Alpha"),
    other = await f.host("Beta"),
    keep = await f.guest(host, { first: "Keep" }),
    adult = await f.guest(host, { first: "Remove" }),
    child = await f.guest(host, { first: "Child", parent: adult.id }),
    foreign = await f.guest(other);
  const event = await f.event(host, [keep, adult, child], {
      notes: "Keep notes",
      description: "Keep description",
      menu: [{ id: "salad", name: "Salad", kind: "potluck", quantity: 3 }],
    }),
    sibling = await f.event(host, [adult, child]);
  const response = f.store.put(
    "response",
    "protected-response",
    host.household.id,
    {
      event: event.id,
      guest: keep.id,
      attendance: { [keep.id]: "yes" },
      claims: { salad: 1 },
      customItems: [],
    },
  );
  const credentials = f.store.all(
    "SELECT * FROM guest_access_links WHERE household=?",
    host.household.id,
  );
  const path = "/api/host/events/" + event.id + "/uninvite-guests";
  const remove = (ids, version, cookie = host.cookie) =>
    f.request(path, {
      method: "POST",
      cookie,
      version,
      data: { guestIds: ids },
    });
  assert.equal((await remove([adult.id], event.version)).status, 400);
  assert.equal((await remove([foreign.id], event.version)).status, 400);
  assert.equal((await remove([child.id], undefined)).status, 428);
  assert.equal(
    (await remove([child.id], event.version, other.cookie)).status,
    404,
  );
  assert.equal((await remove([child.id], event.version, f.admin)).status, 403);
  assert.deepEqual(f.store.get("event", event.id, host.household.id), event);
  const first = await remove([child.id], event.version);
  assert.equal(first.status, 200);
  assert.equal(first.body.removed, 1);
  const saved = f.store.get("event", event.id, host.household.id);
  assert.deepEqual(saved.invited, [keep.id, adult.id]);
  assert.equal((await remove([keep.id, adult.id], saved.version)).status, 409);
  assert.deepEqual(f.store.get("event", event.id, host.household.id), saved);
  const last = await remove([adult.id], saved.version);
  assert.equal(last.status, 200);
  assert.equal(last.body.removed, 1);
  const final = f.store.get("event", event.id, host.household.id);
  assert.deepEqual(final.invited, [keep.id]);
  const {
    version: oldVersion,
    invited: oldInvited,
    ...originalContent
  } = event;
  const { version: newVersion, invited: newInvited, ...finalContent } = final;
  assert.deepEqual(finalContent, originalContent);
  assert.deepEqual(
    f.store.get("event", sibling.id, host.household.id),
    sibling,
  );
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
  const noop = await remove([adult.id], final.version);
  assert.equal(noop.body.removed, 0);
  assert.equal(noop.body.version, final.version);
  assert.equal((await remove([keep.id], event.version)).status, 409);
});

test("uninviting cannot remove a child with a saved attendance answer or bypass host permissions", async (t) => {
  const f = await application(t),
    host = await f.host("Alpha"),
    adult = await f.guest(host),
    child = await f.guest(host, { first: "Child", parent: adult.id }),
    event = await f.event(host, [adult, child]);
  f.store.put("response", "party-response", host.household.id, {
    event: event.id,
    guest: adult.id,
    attendance: { [adult.id]: "yes", [child.id]: "yes" },
    claims: {},
    customItems: [],
  });
  const path = "/api/host/events/" + event.id + "/uninvite-guests";
  assert.equal(
    (
      await f.request(path, {
        method: "POST",
        cookie: host.cookie,
        version: event.version,
        data: { guestIds: [child.id] },
      })
    ).status,
    409,
  );
  const login = await f.guestLogin(host, adult);
  assert.equal(
    (
      await f.request(path, {
        method: "POST",
        cookie: login.cookie,
        version: event.version,
        data: { guestIds: [adult.id, child.id] },
      })
    ).status,
    403,
  );
  assert.deepEqual(f.store.get("event", event.id, host.household.id), event);
});

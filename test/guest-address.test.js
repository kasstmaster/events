import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Store } from "../server/node-store.js";
import { accessFor } from "../server/guest-access.js";
import { application } from "./helpers/application.js";
const address = async (f, host, label) => {
  const r = await f.request("/api/host/addresses", {
    cookie: host.cookie,
    method: "POST",
    data: { label, lines: label + " Example Lane" },
  });
  assert.equal(r.status, 201);
  return r.body;
};
const update = async (f, host, guest, input) => {
  const r = await f.request("/api/host/guests/" + guest.id, {
    cookie: host.cookie,
    method: "PUT",
    version: guest.version,
    data: { ...guest, ...input },
  });
  assert.equal(r.status, 200);
  return r.body;
};
test("four-digit codes include leading zeroes, are unique per address, never reuse reserved codes and fail closed on exhaustion", () => {
  const store = new Store();
  try {
    store.transaction(() => {
      for (let i = 0; i < 10000; i++) {
        if (i === 7) continue;
        const code = String(i).padStart(4, "0");
        store.run(
          "INSERT INTO records VALUES('guest-access-code',?,'platform',1,?)",
          code,
          JSON.stringify({ code, household: "reserved", address: code }),
        );
      }
    });
    const g = { id: "g", address: "a" },
      code = accessFor(store, g, "example");
    assert.equal(code.code, "0007");
    assert.equal(
      accessFor(store, { id: "second", address: "a" }, "example").code,
      "0007",
    );
    assert.throws(
      () => accessFor(store, { id: "third", address: "b" }, "example"),
      /reserved/,
    );
  } finally {
    store.db.close();
  }
});
test("moving guests changes their address code and revokes old access without changing identity, responses or the remaining residents’ code", async (t) => {
  const f = await application(t),
    host = await f.host("Alpha"),
    a = await address(f, host, "First"),
    b = await address(f, host, "Second");
  const first = await f.guest(host, { address: a.id }),
    other = await f.guest(host, { first: "Jordan", address: a.id }),
    destination = await f.guest(host, { first: "Taylor", address: b.id });
  assert.match(first.inviteCode, /^\d{4}$/);
  assert.equal(first.inviteCode, other.inviteCode);
  assert.notEqual(first.inviteCode, destination.inviteCode);
  const event = await f.event(host, [first, other, destination]);
  const login = await f.guestLogin(host, first);
  await f.request(`/api/guest/events/${event.id}/rsvp`, {
    cookie: login.cookie,
    method: "PUT",
    data: { version: 0, attendance: { [first.id]: "yes" }, claims: {} },
  });
  const before = f.store.one(
    "SELECT identity FROM guest_identity_links WHERE guest=?",
    first.id,
  ).identity;
  const moved = await update(f, host, first, { address: b.id });
  assert.equal(moved.inviteCode, destination.inviteCode);
  assert.equal((await f.guestLogin(host, first)).status, 401);
  assert.equal(
    (await f.request("/api/guest", { cookie: login.cookie })).status,
    401,
  );
  assert.equal((await f.guestLogin(host, moved)).status, 200);
  assert.equal((await f.guestLogin(host, other)).status, 200);
  assert.equal(
    f.store.one(
      "SELECT identity FROM guest_identity_links WHERE guest=?",
      first.id,
    ).identity,
    before,
  );
  assert.equal(
    f.store.get("response", event.id + ":" + first.id, host.household.id)
      .attendance[first.id],
    "yes",
  );
});
test("identical names at one address fail closed while distinct suffixes share the address code", async (t) => {
  const f = await application(t),
    host = await f.host("Alpha"),
    a = await address(f, host, "First"),
    first = await f.guest(host, { address: a.id }),
    duplicate = await f.guest(host, { address: a.id });
  assert.equal(first.inviteCode, duplicate.inviteCode);
  assert.equal((await f.guestLogin(host, first)).status, 401);
  assert.equal(
    (
      await f.request(
        `/api/public/households/${host.household.slug}/claim-code`,
        {
          method: "POST",
          data: {
            first: first.first,
            last: first.last,
            inviteCode: first.inviteCode,
            permanentCode: first.inviteCode,
          },
        },
      )
    ).status,
    401,
  );
  const changed = await update(f, host, duplicate, { suffix: "Jr." });
  assert.equal(changed.inviteCode, first.inviteCode);
  assert.equal((await f.guestLogin(host, first)).status, 200);
  assert.equal((await f.guestLogin(host, changed)).status, 200);
});
test("adults RSVP for their invited address group, skipping preserves answers and claims, and stale group writes roll back atomically", async (t) => {
  const f = await application(t),
    host = await f.host("Alpha"),
    a = await address(f, host, "First"),
    b = await address(f, host, "Second");
  const first = await f.guest(host, { address: a.id }),
    second = await f.guest(host, { first: "Jordan", address: a.id }),
    third = await f.guest(host, { first: "Taylor", address: a.id }),
    child = await f.guest(host, {
      first: "Robin",
      parent: second.id,
      address: a.id,
    }),
    outside = await f.guest(host, { first: "Outside", address: b.id });
  const event = await f.event(host, [first, second, third, child, outside], {
    menu: [{ id: "salad", name: "Salad", kind: "potluck", quantity: 10 }],
  });
  const login = await f.guestLogin(host, first),
    other = await f.guestLogin(host, second);
  const send = (cookie, data) =>
    f.request(`/api/guest/events/${event.id}/rsvp`, {
      cookie,
      method: "PUT",
      data,
    });
  assert.equal(
    (
      await send(other.cookie, {
        version: 0,
        attendance: { [second.id]: "yes", [child.id]: "yes" },
        claims: { salad: 2 },
      })
    ).status,
    200,
  );
  const view = (await f.request("/api/guest", { cookie: login.cookie })).body
    .events[0];
  assert.equal(view.members.length, 4);
  assert.equal(
    view.members.some((m) => m.id === outside.id),
    false,
  );
  const secondBefore = f.store.get(
    "response",
    event.id + ":" + second.id,
    host.household.id,
  );
  assert.equal(
    (
      await send(login.cookie, {
        version: 0,
        partyVersions: view.partyVersions,
        attendance: {
          [first.id]: "yes",
          [second.id]: "",
          [third.id]: "",
          [child.id]: "",
        },
        claims: {},
      })
    ).status,
    200,
  );
  assert.deepEqual(
    f.store.get("response", event.id + ":" + second.id, host.household.id),
    secondBefore,
  );
  assert.equal(
    f.store.get("response", event.id + ":" + third.id, host.household.id),
    null,
  );
  assert.equal(
    (
      await send(login.cookie, {
        version: 1,
        partyVersions: { [third.id]: 0 },
        attendance: { [first.id]: "", [third.id]: "yes" },
        claims: {},
      })
    ).status,
    200,
  );
  const current = f.store.get(
    "response",
    event.id + ":" + first.id,
    host.household.id,
  );
  assert.equal(current.version, 1);
  assert.equal(
    (
      await send(login.cookie, {
        version: 1,
        partyVersions: { [third.id]: 0 },
        attendance: { [first.id]: "no", [third.id]: "no" },
        claims: {},
      })
    ).status,
    409,
  );
  assert.deepEqual(
    f.store.get("response", event.id + ":" + first.id, host.household.id),
    current,
  );
  assert.equal(
    (
      await send(login.cookie, {
        version: 1,
        attendance: { [outside.id]: "yes" },
        claims: {},
      })
    ).status,
    400,
  );
});
test("legacy individual credentials keep working at the original address but stop working after a move", async (t) => {
  const f = await application(t),
    host = await f.host("Alpha"),
    a = await address(f, host, "First"),
    b = await address(f, host, "Second"),
    g = await f.guest(host, { address: a.id });
  const key = f.store.one(
      "SELECT identity FROM guest_identity_links WHERE guest=?",
      g.id,
    ).identity,
    identity = f.store.get("guest-identity", key, "platform"),
    legacy = "synthetic-legacy-code-for-testing";
  f.store.put(
    "guest-identity",
    key,
    "platform",
    {
      ...identity,
      code: legacy,
      codeHash: createHash("sha256").update(legacy).digest("hex"),
    },
    identity.version,
  );
  f.store.run("DELETE FROM guest_access_links WHERE guest=?", g.id);
  assert.equal(
    (await f.guestLogin(host, { ...g, inviteCode: legacy })).status,
    200,
  );
  const updated = await update(f, host, g, { address: b.id });
  assert.match(updated.inviteCode, /^\d{4}$/);
  assert.equal(
    (await f.guestLogin(host, { ...g, inviteCode: legacy })).status,
    401,
  );
  assert.equal((await f.guestLogin(host, updated)).status, 200);
});

test("invitation code is an optional recipient variable and never enters ordinary cards or shared templates as a value", async (t) => {
  const { newCard, renderCard } = await import("../public/card-system.js");
  const f = await application(t),
    host = await f.host("Alpha"),
    other = await f.host("Beta"),
    a = await address(f, host, "First"),
    guest = await f.guest(host, { address: a.id });
  const card = newCard("Private invitation");
  const ordinary = await f.request("/api/host/cards", {
    cookie: host.cookie,
    method: "POST",
    data: { ...card, recipient: guest.id },
  });
  assert.equal(ordinary.status, 201);
  assert.equal(ordinary.body.context.recipient.inviteCode, undefined);
  card.elements.push({
    ...card.elements[0],
    id: "code",
    field: "recipient.inviteCode",
    fallback: "",
    y: 320,
  });
  const template = await f.request("/api/admin/templates", {
    cookie: f.admin,
    method: "POST",
    data: card,
  });
  assert.equal(template.status, 201);
  assert.equal(template.body.context, undefined);
  const saved = await f.request("/api/host/cards", {
    cookie: host.cookie,
    method: "POST",
    data: { ...card, recipient: guest.id },
  });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.context.recipient.inviteCode, guest.inviteCode);
  assert.ok(
    renderCard(saved.body, saved.body.context).includes(
      ">" + guest.inviteCode + "</tspan>",
    ),
  );
  assert.equal(
    (
      await f.request("/api/host/cards/" + saved.body.id, {
        cookie: other.cookie,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await f.request("/api/host/cards", {
        cookie: other.cookie,
        method: "POST",
        data: { ...card, recipient: guest.id },
      })
    ).status,
    404,
  );
});

test("inline address creation/edit and guest assignment commit together and reject stale or cross-household edits", async (t) => {
  const f = await application(t),
    host = await f.host("Alpha"),
    other = await f.host("Beta");
  const created = await f.request("/api/host/guests", {
    cookie: host.cookie,
    method: "POST",
    data: {
      first: "Casey",
      last: "Example",
      addressDraft: { label: "Our home", lines: "123 Example Street" },
    },
  });
  assert.equal(created.status, 201);
  const guest = created.body,
    original = f.store.get("address", guest.address, host.household.id);
  assert.equal(original.lines, "123 Example Street");
  const failed = await f.request("/api/host/guests/" + guest.id, {
    cookie: host.cookie,
    method: "PUT",
    version: 0,
    data: {
      ...guest,
      addressDraft: { label: "Another home", lines: "456 New Lane" },
    },
  });
  assert.equal(failed.status, 409);
  assert.equal(f.store.list("address", host.household.id).length, 1);
  const updated = await update(f, host, guest, {
    addressDraft: {
      id: original.id,
      version: original.version,
      label: "Renamed home",
      lines: "123 Example Street, Unit 2",
    },
  });
  assert.equal(updated.address, original.id);
  assert.equal(updated.inviteCode, guest.inviteCode);
  const stale = await f.request("/api/host/guests/" + updated.id, {
    cookie: host.cookie,
    method: "PUT",
    version: updated.version,
    data: {
      ...updated,
      addressDraft: { ...original, lines: "Stale overwrite" },
    },
  });
  assert.equal(stale.status, 409);
  assert.equal(
    f.store.get("address", original.id, host.household.id).lines,
    "123 Example Street, Unit 2",
  );
  const forbidden = await f.request("/api/host/guests", {
    cookie: other.cookie,
    method: "POST",
    data: { first: "Other", last: "Guest", addressDraft: { ...original } },
  });
  assert.equal(forbidden.status, 404);
  assert.equal(f.store.list("guest", other.household.id).length, 0);
});

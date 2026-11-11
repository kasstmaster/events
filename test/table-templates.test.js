import test from "node:test";
import assert from "node:assert/strict";
import { application } from "./helpers/application.js";
const menu = [{ id: "item", name: "Salad", kind: "potluck", quantity: 3 }];
test("table templates share event menu validation, tenant scoping and optimistic versions", async (t) => {
  const f = await application(t),
    host = await f.host("Alpha"),
    other = await f.host("Beta");
  const created = await f.request("/api/host/table-templates", {
    method: "POST",
    cookie: host.cookie,
    data: { name: "Dinner", menu },
  });
  assert.equal(created.status, 201);
  const template = created.body;
  assert.equal(
    (await f.request("/api/host/table-templates", { cookie: host.cookie }))
      .body[0].id,
    template.id,
  );
  assert.deepEqual(
    (await f.request("/api/host/table-templates", { cookie: other.cookie }))
      .body,
    [],
  );
  for (const cookie of [
    f.admin,
    (await f.member(host, "member", "Avery")).cookie,
  ])
    assert.equal(
      (await f.request("/api/host/table-templates", { cookie })).status,
      403,
    );
  assert.equal(
    (
      await f.request("/api/host/table-templates/" + template.id, {
        method: "PUT",
        cookie: other.cookie,
        version: template.version,
        data: { name: "Foreign", menu },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await f.request("/api/host/table-templates/" + template.id, {
        method: "PUT",
        cookie: host.cookie,
        version: 0,
        data: { name: "Stale", menu },
      })
    ).status,
    409,
  );
  const updated = await f.request("/api/host/table-templates/" + template.id, {
    method: "PUT",
    cookie: host.cookie,
    version: template.version,
    data: { name: "Updated", menu: [{ ...menu[0], quantity: 5 }] },
  });
  assert.equal(updated.status, 200);
  assert.equal(
    (
      await f.request("/api/host/table-templates", {
        method: "POST",
        cookie: host.cookie,
        data: { name: "Invalid", menu: [{ ...menu[0], quantity: 0 }] },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request("/api/host/table-templates/" + template.id, {
        method: "DELETE",
        cookie: host.cookie,
        version: template.version,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.request("/api/host/table-templates/" + template.id, {
        method: "DELETE",
        cookie: host.cookie,
        version: updated.body.version,
      })
    ).status,
    200,
  );
});
test("saving, applying snapshots and deleting templates cannot rewrite an event or its guest claims", async (t) => {
  const f = await application(t),
    host = await f.host("Alpha"),
    guest = await f.guest(host),
    event = await f.event(host, [guest], { menu });
  const response = f.store.saveResponse(
    event,
    { household: host.household.id, guest: guest.id },
    {
      version: 0,
      attendance: { [guest.id]: "yes" },
      claims: { item: 1 },
      customItems: [],
    },
  ).response;
  const template = (
    await f.request("/api/host/table-templates", {
      method: "POST",
      cookie: host.cookie,
      data: { name: "Snapshot", menu },
    })
  ).body;
  assert.deepEqual(f.store.get("event", event.id, host.household.id), event);
  await f.request("/api/host/table-templates/" + template.id, {
    method: "DELETE",
    cookie: host.cookie,
    version: template.version,
  });
  assert.deepEqual(
    f.store.get("response", response.id, host.household.id),
    response,
  );
  assert.deepEqual(f.store.get("event", event.id, host.household.id), event);
});

import test from "node:test";
import assert from "node:assert/strict";
import { application, password } from "./helpers/application.js";
test("a password-confirmed administrator can grant separate platform tools without changing host identity or household data", async (t) => {
  const f = await application(t),
    host = await f.host("Alpha"),
    other = await f.host("Beta"),
    guest = await f.guest(host),
    event = await f.event(host, [guest]);
  const before = (await f.request("/api/host", { cookie: host.cookie })).body;
  const path = "/api/admin/platform-access/" + host.user;
  assert.equal(
    (
      await f.request(path, {
        method: "POST",
        cookie: other.cookie,
        data: { password, confirmEmail: "alpha@example.test" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(path, {
        method: "POST",
        cookie: f.admin,
        data: { password: "wrong", confirmEmail: "alpha@example.test" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(path, {
        method: "POST",
        cookie: f.admin,
        data: { password, confirmEmail: "beta@example.test" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(path, {
        method: "POST",
        cookie: f.admin,
        data: { password, confirmEmail: "alpha@example.test" },
      })
    ).status,
    200,
  );
  const session = (await f.request("/api/session", { cookie: host.cookie }))
    .body;
  assert.equal(session.role, "host");
  assert.equal(session.platformAdmin, true);
  assert.equal(
    (await f.request("/api/session", { cookie: other.cookie })).body
      .platformAdmin,
    false,
  );
  assert.deepEqual(
    (await f.request("/api/host", { cookie: host.cookie })).body,
    before,
  );
  assert.equal(
    (await f.request("/api/admin/defaults", { cookie: host.cookie })).status,
    200,
  );
  assert.equal(
    (await f.request("/api/admin", { cookie: other.cookie })).status,
    403,
  );
  assert.equal(
    f.store.one("SELECT role FROM users WHERE id=?", host.user).role,
    "host",
  );
  assert.deepEqual(f.store.get("event", event.id, host.household.id), event);
});
test("retiring an old administrator requires the promoted host's fresh verified sign-in and password, revokes old sessions and keeps setup closed", async (t) => {
  const f = await application(t),
    host = await f.host("Alpha");
  await f.request("/api/admin/platform-access/" + host.user, {
    method: "POST",
    cookie: f.admin,
    data: { password, confirmEmail: "alpha@example.test" },
  });
  const retire = (cookie, data = {}) =>
    f.request("/api/admin/retire-legacy", {
      method: "POST",
      cookie,
      data: { confirmEmail: "admin@example.test", password, ...data },
    });
  assert.equal((await retire(f.admin)).status, 403);
  assert.equal((await retire(host.cookie)).status, 403);
  const fresh = (
    await f.request("/api/login", {
      method: "POST",
      data: { email: "alpha@example.test", password },
    })
  ).cookie;
  assert.equal((await retire(fresh, { password: "wrong" })).status, 403);
  assert.equal(
    (await retire(fresh, { confirmEmail: "alpha@example.test" })).status,
    400,
  );
  assert.equal((await retire(fresh)).status, 200);
  assert.equal(
    (await f.request("/api/admin", { cookie: f.admin })).status,
    401,
  );
  assert.equal((await f.request("/api/admin", { cookie: fresh })).status, 200);
  assert.equal((await f.request("/api/host", { cookie: fresh })).status, 200);
  assert.deepEqual((await f.request("/api/setup")).body, {
    required: false,
    enabled: false,
  });
  assert.equal(
    (
      await f.request("/api/login", {
        method: "POST",
        data: { email: "admin@example.test", password },
      })
    ).status,
    401,
  );
});
test("host guest preview is scoped, read-only and excludes notes, contact data and invitation credentials", async (t) => {
  const f = await application(t),
    host = await f.host("Alpha"),
    other = await f.host("Beta"),
    guest = await f.guest(host, {
      notes: "private-note",
      phone: "+15551234567",
    }),
    event = await f.event(host, [guest], { notes: "private-event-note" });
  const before = f.store.all(
    "SELECT kind,id,version,body FROM records ORDER BY kind,id",
  );
  const preview = await f.request("/api/host/preview", {
    method: "POST",
    cookie: host.cookie,
    data: { household: host.household.id, event: event.id },
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.preview, true);
  assert.doesNotMatch(
    JSON.stringify(preview.body),
    /private-note|private-event-note|15551234567|inviteCode|smsConsent/,
  );
  assert.equal(
    (
      await f.request("/api/host/preview", {
        method: "POST",
        cookie: host.cookie,
        data: { household: other.household.id },
      })
    ).status,
    404,
  );
  const guestCookie = (await f.guestLogin(host, guest)).cookie;
  assert.equal(
    (
      await f.request("/api/host/preview", {
        method: "POST",
        cookie: guestCookie,
        data: {},
      })
    ).status,
    403,
  );
  assert.deepEqual(
    f.store.all("SELECT kind,id,version,body FROM records ORDER BY kind,id"),
    before,
  );
  assert.equal(f.store.list("response", host.household.id).length, 0);
});

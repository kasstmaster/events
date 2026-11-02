import test from "node:test";
import assert from "node:assert/strict";
import { application, password } from "./helpers/application.js";
import { categoryDesign, resolveUI } from "../public/ui-system.js";
import { design } from "../server/model.js";
test("legacy appearance maps deterministically before inheritance and category keys cover every legacy role", () => {
  const migrated = categoryDesign({
    textColor: "#112233",
    toolbarColor: "#445566",
    container: "#abcdef",
    toolbarBackground: "#123456",
    eyebrowFont: "Verdana",
  });
  assert.equal(migrated.toolbarColor, "#112233");
  assert.equal(migrated.inputColor, "#112233");
  assert.equal(migrated.buttonText, "#112233");
  assert.equal(migrated.toolbarBackground, "#abcdef");
  assert.equal(migrated.textFont, "Verdana");
  assert.equal(categoryDesign({ buttonColor: "#112233" }).container, "#112233");
  assert.equal(categoryDesign({ buttonText: "#445566" }).textColor, "#445566");
  const d = resolveUI(
    { design: { textColor: "#112233", container: "#abcdef" } },
    { design: { toolbarColor: "#445566", inputBackground: "#654321" } },
  ).design;
  assert.equal(d.textColor, "#445566");
  assert.equal(d.notesColor, d.textColor);
  assert.equal(d.container, "#654321");
  assert.equal(
    design({
      titleStyle: "italic",
      textStyle: "bold",
      borderWidth: 3,
      borderStyle: "dashed",
    }).titleStyle,
    "italic",
  );
  for (const bad of [
    { textStyle: "url(x)" },
    { borderWidth: 7 },
    { borderStyle: "javascript" },
    { textColor: "red" },
  ])
    assert.throws(() => design(bad));
});
test("category default and household saves preserve tenant overrides, event independence and unrelated data", async (t) => {
  const f = await application(t),
    h = await f.host("Alpha"),
    other = await f.host("Beta");
  const event = await f.event(h, [], {
    title: "Keep content",
    design: { descriptionColor: "#456789" },
  });
  const guest = await f.guest(h, { first: "Keep", last: "Guest" });
  const current = (await f.request("/api/host", { cookie: h.cookie })).body;
  const updated = await f.request("/api/host/household", {
    cookie: h.cookie,
    method: "PUT",
    version: current.household.version,
    data: {
      name: current.household.name,
      design: { textColor: "#123456", container: "#eeeeee" },
    },
  });
  assert.equal(updated.status, 200);
  const before = (await f.request("/api/host", { cookie: h.cookie })).body;
  const defaults = await f.request("/api/admin/defaults", { cookie: f.admin });
  assert.equal(
    (
      await f.request("/api/admin/defaults", {
        cookie: f.admin,
        method: "PUT",
        version: defaults.body.version,
        data: {
          design: { textColor: "#abcdef", titleStyle: "bold" },
          copy: {},
          layouts: {},
        },
      })
    ).status,
    200,
  );
  const after = (await f.request("/api/host", { cookie: h.cookie })).body;
  assert.deepEqual(after.ui.design, before.ui.design);
  assert.deepEqual(after.events[0].ui.design, before.events[0].ui.design);
  assert.equal(after.events[0].title, "Keep content");
  assert.ok(after.guests.some((g) => g.id === guest.id));
  assert.equal(
    (
      await f.request("/api/admin/defaults", {
        cookie: other.cookie,
        method: "PUT",
        version: 0,
        data: { design: { textColor: "#123456" } },
      })
    ).status,
    403,
  );
});
test("administrator password changes require the current password, reject other roles and revoke existing sessions", async (t) => {
  const f = await application(t),
    h = await f.host("Alpha");
  assert.equal(
    (
      await f.request("/api/admin/password", {
        cookie: h.cookie,
        method: "PUT",
        data: {
          currentPassword: password,
          password: "New-synthetic-admin-password",
        },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/admin/password", {
        cookie: f.admin,
        method: "PUT",
        data: {
          currentPassword: "incorrect",
          password: "New-synthetic-admin-password",
        },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/admin/password", {
        cookie: f.admin,
        method: "PUT",
        data: {
          currentPassword: password,
          password: "New-synthetic-admin-password",
        },
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.request("/api/admin", { cookie: f.admin })).status,
    401,
  );
});

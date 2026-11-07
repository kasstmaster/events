import test from "node:test";
import assert from "node:assert/strict";
import { application, password } from "./helpers/application.js";
import {
  appearancePreset,
  categoryDesign,
  resolveUI,
} from "../public/ui-system.js";
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

test("container images validate independently from page background and inherit without changing explicit overrides", () => {
  const image = "data:image/png;base64,aGVsbG8=";
  assert.equal(
    design({ containerImage: image, containerImageOpacity: 0 })
      .containerImageOpacity,
    0,
  );
  for (const bad of [
    { containerImage: "https://example.test/tracker.png" },
    { containerImageOpacity: -1 },
    { containerImageOpacity: 101 },
    { containerImageOpacity: 0.5 },
  ])
    assert.throws(() => design(bad));
  const result = resolveUI(
    { design: { containerImage: image, containerImageOpacity: 25 } },
    { design: { containerImage: "", containerImageOpacity: 80 } },
  ).design;
  assert.equal(result.containerImage, "");
  assert.equal(result.containerImageOpacity, 80);
});

test("light preset uses platform defaults and dark preset is valid appearance data", () => {
  const light = appearancePreset("light", {
    background: "#abcdef",
    containerImage: "",
    textFont: "Verdana",
  });
  assert.equal(light.background, "#abcdef");
  assert.equal(light.textFont, "Verdana");
  const dark = appearancePreset("dark", light);
  assert.equal(dark.background, "#151719");
  assert.equal(dark.textFont, "Verdana");
  assert.deepEqual(design(dark), dark);
});

test("independent toolbar and button roles validate and preserve legacy surface appearance", () => {
  const legacy = categoryDesign({
    container: "#abcdef",
    opacity: 35,
    borderColor: "#123456",
    borderWidth: 2,
    borderStyle: "dashed",
    textColor: "#654321",
    textFont: "Verdana",
    textSize: 18,
    textStyle: "bold",
  });
  assert.equal(legacy.toolbarSurface, "#abcdef");
  assert.equal(legacy.buttonSurface, "#abcdef");
  assert.equal(legacy.toolbarLabelColor, "#654321");
  const saved = design({
    ...legacy,
    toolbarSurface: "#112233",
    buttonSurface: "#445566",
    toolbarBorderWidth: 3,
    buttonOpacity: 0,
  });
  assert.equal(saved.container, "#abcdef");
  assert.equal(saved.toolbarSurface, "#112233");
  assert.equal(saved.buttonSurface, "#445566");
  const layered = resolveUI(
    { design: saved },
    {
      design: {
        container: "#ffffff",
        toolbarSurface: saved.toolbarSurface,
        buttonSurface: saved.buttonSurface,
      },
    },
  ).design;
  assert.equal(layered.toolbarSurface, saved.toolbarSurface);
  assert.equal(layered.buttonSurface, saved.buttonSurface);
  for (const bad of [
    { buttonOpacity: 101 },
    { toolbarBorderWidth: 7 },
    { buttonLabelStyle: "url(x)" },
    { toolbarSurface: "red" },
  ])
    assert.throws(() => design(bad));
});

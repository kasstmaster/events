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

test("container background opacity accepts zero and retains bounded integer validation", () => {
  assert.equal(design({ opacity: 0 }).opacity, 0);
  assert.equal(design({ opacity: 100 }).opacity, 100);
  for (const value of [-1, 101, 0.5, "0"])
    assert.throws(() => design({ opacity: value }));
});

test("shared page modes cascade to default events while preserving custom events, content and responses atomically", async (t) => {
  const f = await application(t),
    host = await f.host("Modes"),
    other = await f.host("OtherModes"),
    guest = await f.guest(host);
  const normal = await f.event(host, [guest]),
    legacy = await f.event(host, [guest]),
    custom = await f.event(host, [guest], {
      design: { titleColor: "#123abc" },
    }),
    sameCustom = await f.event(host, [guest], {
      design: appearancePreset("light"),
      appearanceMode: "custom",
    }),
    outside = await f.event(other, []);
  const { appearanceMode, ...old } = legacy;
  f.store.put(
    "event",
    legacy.id,
    host.household.id,
    { ...old, design: appearancePreset("light") },
    legacy.version,
  );
  const response = f.store.put(
    "response",
    "keep-mode-response",
    host.household.id,
    {
      event: normal.id,
      guest: guest.id,
      attendance: { [guest.id]: "yes" },
      claims: {},
    },
  );
  const read = async () =>
    (await f.request("/api/host", { cookie: host.cookie })).body;
  const before = await read(),
    beforeCustom = before.events.find((e) => e.id === custom.id).ui.design,
    beforeSame = before.events.find((e) => e.id === sameCustom.id).ui.design;
  const apply = async (
    mode,
    design,
    extra = {},
    version = f.store.household(host.household.id).version,
  ) =>
    f.request("/api/host/household", {
      cookie: host.cookie,
      method: "PUT",
      version,
      data: {
        ...f.store.household(host.household.id),
        design,
        appearanceMode: mode,
        applyAppearanceMode: true,
        ...extra,
      },
    });
  assert.equal((await apply("dark", appearancePreset("dark"))).status, 200);
  let data = await read();
  for (const id of [normal.id, legacy.id]) {
    const e = data.events.find((e) => e.id === id);
    assert.equal(e.ui.design.background, "#151719");
    assert.equal(e.appearanceMode, "inherit");
    assert.deepEqual(e.design, {});
    assert.deepEqual(e.invited, [guest.id]);
  }
  assert.deepEqual(
    data.events.find((e) => e.id === custom.id).ui.design,
    beforeCustom,
  );
  assert.deepEqual(
    data.events.find((e) => e.id === sameCustom.id).ui.design,
    beforeSame,
  );
  assert.equal(
    (await apply("custom", { background: "#334455", textColor: "#ccddee" }))
      .status,
    200,
  );
  data = await read();
  assert.equal(
    data.events.find((e) => e.id === normal.id).ui.design.background,
    "#334455",
  );
  assert.equal(
    data.events.find((e) => e.id === normal.id).ui.design.textColor,
    "#ccddee",
  );
  assert.deepEqual(
    data.events.find((e) => e.id === custom.id).ui.design,
    beforeCustom,
  );
  assert.deepEqual(
    f.store.get("event", outside.id, other.household.id),
    outside,
  );
  assert.deepEqual(
    f.store.get("response", response.id, host.household.id),
    response,
  );
  const records = f.store.list("event", host.household.id);
  assert.equal(
    (
      await apply(
        "light",
        appearancePreset("light"),
        {},
        before.household.version,
      )
    ).status,
    409,
  );
  assert.deepEqual(f.store.list("event", host.household.id), records);
  const returnDefault = (
    event,
    version = event.version,
    cookie = host.cookie,
  ) =>
    f.request("/api/host/events/" + event.id, {
      cookie,
      method: "PUT",
      version,
      data: { ...event, design: {}, appearanceMode: "inherit" },
    });
  assert.equal((await returnDefault(outside)).status, 404);
  const current = f.store.get("event", custom.id, host.household.id);
  assert.equal((await returnDefault(current, current.version - 1)).status, 409);
  assert.equal((await returnDefault(current)).status, 200);
  data = await read();
  assert.equal(
    data.events.find((e) => e.id === custom.id).appearanceMode,
    "inherit",
  );
  assert.equal(
    data.events.find((e) => e.id === custom.id).ui.design.background,
    "#334455",
  );
  assert.equal((await apply("dark", appearancePreset("dark"))).status, 200);
  data = await read();
  assert.equal(
    data.events.find((e) => e.id === custom.id).ui.design.background,
    "#151719",
  );
  assert.deepEqual(
    data.events.find((e) => e.id === sameCustom.id).ui.design,
    beforeSame,
  );
  assert.equal((await apply("invalid", {})).status, 400);
});

test("event layout presets are versioned, tenant-scoped and preserve content, responses and appearance", async (t) => {
  const f = await application(t),
    host = await f.host("LayoutAlpha"),
    other = await f.host("LayoutBeta");
  const guest = await f.guest(host),
    event = await f.event(host, [guest], {
      date: "2089-06-12",
      time: "Two o'clock in the afternoon",
      address: "123 Example Lane\nExample Town",
      deadline: "2089-06-01",
      design: { descriptionColor: "#123456" },
    });
  const sibling = await f.event(host, [], { title: "Untouched sibling" });
  const cookie = (await f.guestLogin(host, guest)).cookie;
  assert.equal(
    (
      await f.request(`/api/guest/events/${event.id}/rsvp`, {
        cookie,
        method: "PUT",
        data: { version: 0, attendance: { [guest.id]: "yes" }, claims: {} },
      })
    ).status,
    200,
  );
  const responses = structuredClone(
    f.store.list("response", host.household.id),
  );
  const household = structuredClone(f.store.household(host.household.id));
  const beforeSibling = structuredClone(
    f.store.get("event", sibling.id, host.household.id),
  );
  const write = (
    record,
    changes = {},
    user = host.cookie,
    version = record.version,
  ) =>
    f.request(`/api/host/events/${event.id}`, {
      cookie: user,
      method: "PUT",
      version,
      data: { ...record, ...changes },
    });
  assert.equal(event.informationLayout, "default");
  assert.equal(event.containerLayout, "separate");
  for (const changes of [
    { informationLayout: "invalid" },
    { containerLayout: "invalid" },
  ])
    assert.equal((await write(event, changes)).status, 400);
  assert.equal(
    (await write(event, { informationLayout: "invitation" }, other.cookie))
      .status,
    404,
  );
  for (const user of [cookie, f.admin])
    assert.equal(
      (await write(event, { containerLayout: "single" }, user)).status,
      403,
    );
  assert.equal(
    (
      await write(event, {
        informationLayout: "invitation",
        containerLayout: "single",
      })
    ).status,
    200,
  );
  const selected = f.store.get("event", event.id, host.household.id);
  assert.equal(selected.informationLayout, "invitation");
  assert.equal(selected.containerLayout, "single");
  for (const field of [
    "title",
    "description",
    "date",
    "time",
    "address",
    "deadline",
    "menu",
    "invited",
    "design",
  ])
    assert.deepEqual(selected[field], event[field]);
  const projection = (
    await f.request("/api/guest", { cookie })
  ).body.events.find((e) => e.id === event.id);
  assert.equal(projection.informationLayout, "invitation");
  assert.equal(projection.containerLayout, "single");
  assert.equal(Object.hasOwn(projection, "notes"), false);
  assert.equal(
    (await write(event, { informationLayout: "default" })).status,
    409,
  );
  const { informationLayout, containerLayout, ...ordinaryEdit } = selected;
  assert.equal(
    (await write(ordinaryEdit, { description: "Edited content, same layouts" }))
      .status,
    200,
  );
  const edited = f.store.get("event", event.id, host.household.id);
  assert.equal(edited.informationLayout, "invitation");
  assert.equal(edited.containerLayout, "single");
  assert.deepEqual(f.store.list("response", host.household.id), responses);
  assert.deepEqual(f.store.household(host.household.id), household);
  assert.deepEqual(
    f.store.get("event", sibling.id, host.household.id),
    beforeSibling,
  );
  assert.equal(
    (
      await write(edited, {
        informationLayout: "default",
        containerLayout: "separate",
      })
    ).status,
    200,
  );
});

test("Information stores bounded formatted runs and renders only escaped text and safe links", async () => {
  const { informationInput, informationLink, renderInformation } =
    await import("../public/event-information.js");
  assert.deepEqual(informationInput([{ text: " \n " }]), []);
  assert.equal(
    informationLink("host@example.test"),
    "mailto:host@example.test",
  );
  const markup = renderInformation([
    {
      text: '<img src=x onerror="alert(1)">',
      bold: true,
      italic: true,
      underline: true,
      href: "https://example.test/help",
    },
  ]);
  assert.match(markup, /&lt;img/);
  assert.doesNotMatch(markup, /<img|<script|onclick=/);
  assert.match(markup, /<strong>/);
  assert.match(markup, /rel="noopener noreferrer"/);
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,test",
    "file:///tmp/test",
    "//example.test",
    "mailto:test@example.test?body=hi",
    "https://user:pass@example.test",
  ])
    assert.throws(() => informationInput([{ text: "Link", href: value }]));
  for (const value of [
    [{ text: "x", onclick: "alert(1)" }],
    [{ text: "x", bold: "yes" }],
    [{ text: "x".repeat(10001) }],
    Array.from({ length: 501 }, () => ({ text: "x" })),
  ])
    assert.throws(() => informationInput(value));
});

test("optional Information is versioned, host-owned, preserved when omitted and safe for guest projection", async (t) => {
  const f = await application(t),
    host = await f.host("InformationAlpha"),
    other = await f.host("InformationBeta"),
    guest = await f.guest(host),
    event = await f.event(host, [guest]);
  const sibling = await f.event(host, []),
    cookie = (await f.guestLogin(host, guest)).cookie;
  const write = (record, changes, user = host.cookie) =>
    f.request(`/api/host/events/${event.id}`, {
      cookie: user,
      method: "PUT",
      version: record.version,
      data: { ...record, ...changes },
    });
  const information = [
    { text: "Bring a jacket. ", bold: true },
    { text: "Liar’s Dice", popup: "Roll five dice. Keep your dice hidden." },
    {
      text: "Email the host",
      italic: true,
      underline: true,
      href: "mailto:host@example.test",
    },
  ];
  assert.equal((await write(event, { information }, other.cookie)).status, 404);
  assert.equal((await write(event, { information }, cookie)).status, 403);
  assert.equal(
    (
      await write(event, {
        information: [{ text: "bad", href: "javascript:alert(1)" }],
      })
    ).status,
    400,
  );
  const responses = structuredClone(
    f.store.list("response", host.household.id),
  );
  assert.equal((await write(event, { information })).status, 200);
  assert.equal((await write(event, { information: [] })).status, 409);
  const current = f.store.get("event", event.id, host.household.id);
  assert.deepEqual(
    (await f.request("/api/guest", { cookie })).body.events.find(
      (e) => e.id === event.id,
    ).information,
    information,
  );
  const { information: omitted, ...ordinary } = current;
  assert.equal(
    (await write(ordinary, { description: "Unrelated edit" })).status,
    200,
  );
  const retained = f.store.get("event", event.id, host.household.id);
  assert.deepEqual(retained.information, information);
  assert.deepEqual(f.store.list("response", host.household.id), responses);
  assert.deepEqual(
    f.store.get("event", sibling.id, host.household.id),
    sibling,
  );
  assert.equal(
    (await write(retained, { information: [{ text: " \n " }] })).status,
    200,
  );
  assert.deepEqual(
    f.store.get("event", event.id, host.household.id).information,
    [],
  );
});

test("Information pop-ups are bounded plain text, escaped, and cannot conflict with links", async () => {
  const { informationInput, renderInformation } =
    await import("../public/event-information.js");
  const value = [
    {
      text: "Liar's Dice",
      bold: true,
      popup: 'Roll five dice.\n<script>alert("x")</script>',
    },
  ];
  assert.deepEqual(informationInput(value), value);
  const rendered = renderInformation(value);
  assert.match(rendered, /role="button"/);
  assert.match(rendered, /aria-haspopup="dialog"/);
  assert.match(rendered, /&lt;script&gt;/);
  assert.doesNotMatch(rendered, /<script|onclick=/);
  for (const popup of [null, {}, " ", "x".repeat(3001), "bad\u0000text"])
    assert.throws(() => informationInput([{ text: "Game", popup }]));
  assert.throws(() =>
    informationInput([
      { text: "Game", popup: "Rules", href: "https://example.test" },
    ]),
  );
  assert.throws(() =>
    informationInput(
      Array.from({ length: 20 }, () => ({
        text: "Game",
        popup: "x".repeat(3000),
      })),
    ),
  );
});

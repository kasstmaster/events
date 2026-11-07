// Synthetic loopback data only. Native sharing/clipboard are mocked at the browser boundary.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { Store } from "../server/node-store.js";
import { createApp } from "../server/app.js";
const origin = "http://127.0.0.1:3181",
  password = "Navigation-test-only-passphrase",
  store = new Store();
let phase = "setup";
const stage = (s) => {
  phase = s;
  console.log("Toolbar browser: " + s);
};
const watchdog = setTimeout(() => {
  console.error("Toolbar browser exceeded 150 seconds during " + phase);
  process.exit(1);
}, 150000);
watchdog.unref();
await store.createAdmin("admin@example.test", password);
for (const name of ["Alpha", "Beta"])
  store.run(
    "INSERT INTO approvals VALUES(?,?)",
    name.toLowerCase() + "@example.test",
    "synthetic",
  );
const host = await store.register({
    name: "Alpha",
    email: "alpha@example.test",
    password,
  }),
  other = await store.register({
    name: "Beta",
    email: "beta@example.test",
    password,
  });
const household = store.household(host.household);
store.put(
  "household",
  household.id,
  household.id,
  {
    ...household,
    design: {
      toolbarBackground: "#e0efe7",
      toolbarColor: "#134b37",
      borderColor: "#506070",
      container: "#fff9ef",
      statusBackground: "#e8dfcc",
    },
  },
  household.version,
);
const server = createApp({ store, origin });
server.listen(3181, "127.0.0.1");
await once(server, "listening");
async function api(
  cookie,
  path,
  data,
  method = data ? "POST" : "GET",
  version,
) {
  const r = await fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(data ? { "Content-Type": "application/json" } : {}),
      ...(version !== undefined ? { "If-Match": String(version) } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  return {
    status: r.status,
    body: await r.json(),
    cookie: r.headers.get("set-cookie")?.split(";")[0],
  };
}
const owner = (
  await api(null, "/api/login", { email: "alpha@example.test", password })
).cookie;
await api(owner, "/api/family");
const kid = (
  await api(owner, "/api/family/members", {
    name: "Child",
    login: "child",
    role: "kid",
    password,
  })
).body;
const regular = (
  await api(owner, "/api/family/members", {
    name: "Regular",
    login: "regular",
    role: "member",
    password,
  })
).body;
const childCookie = (
  await api(null, `/api/public/households/${household.slug}/members/login`, {
    login: "child",
    password,
  })
).cookie;
const regularCookie = (
  await api(null, `/api/public/households/${household.slug}/members/login`, {
    login: "regular",
    password,
  })
).cookie;
const create = async (type, title, extra = {}) => {
  const r = await api(owner, "/api/family/records", { type, title, ...extra });
  assert.equal(r.status, 201);
  return r.body;
};
const folder = await create("folder", "Shared folder", {
    section: "lists",
    childAccess: [kid.id],
  }),
  list = await create("list", "Groceries", {
    folder: folder.id,
    childAccess: [kid.id],
    categories: ["Produce"],
  });
for (const [title, position] of [
  ["Zucchini", 100],
  ["Apples", 200],
]) {
  const item = (
    await api(owner, "/api/family/items", {
      list: list.id,
      title,
      category: "Produce",
    })
  ).body;
  store.put(
    "family-item",
    item.id,
    host.household,
    { ...item, position },
    item.version,
  );
}
const secret = await create("record", "Private appliance", {
  notes: "Private document notes",
  model: "Model 42",
});
const task = await create("task", "Homework", {
  assignees: [kid.id],
  dueLocal: "2089-06-12T16:00",
  timezone: "UTC",
  linkedRecord: secret.id,
});
await create("chore", "Water plants", {
  assignees: [host.user, kid.id],
  repeat: "weekly",
  dueLocal: "2089-06-12T16:00",
  timezone: "UTC",
});
store.put("family-record", "legacy-retained", host.household, {
  type: "recipe",
  title: "Old recipe must stay private",
});
const guest = (
  await api(owner, "/api/host/guests", { first: "Casey", last: "Example" })
).body;
const e1 = (
  await api(owner, "/api/host/events", {
    title: "Dinner One",
    description: "Keep this event design.",
    address: "123 Example Lane",
    date: "2089-06-12",
    deadline: "2089-06-01",
    invited: [guest.id],
    menu: [{ id: "salad", name: "Salad", kind: "potluck", quantity: 3 }],
  })
).body;
const e2 = (
  await api(owner, "/api/host/events", {
    title: "Dinner Two",
    description: "No potluck here.",
    invited: [guest.id],
    menu: [],
  })
).body;
const guestCookie = (
  await api(null, `/api/public/households/${household.slug}/login`, {
    first: guest.first,
    last: guest.last,
    inviteCode: guest.inviteCode,
  })
).cookie;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
const errors = [],
  requests = [];
async function page(cookie, width = 390) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    isMobile: width < 600,
    hasTouch: width < 600,
  });
  await context.addCookies([
    { name: "events_session", value: cookie.split("=")[1], url: origin },
  ]);
  await context.route("**/*", (r) =>
    r
      .request()
      .url()
      .startsWith(origin + "/")
      ? r.continue()
      : r.abort(),
  );
  const p = await context.newPage();
  p.setDefaultTimeout(10000);
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("request", (r) => {
    if (r.url().startsWith(origin + "/api/"))
      requests.push(new URL(r.url()).pathname);
  });
  await p.goto(origin);
  return p;
}
async function click(p, name) {
  const { clickNavigation } = await import("./helpers/navigation.js");
  await clickNavigation(p, name);
}
async function option(p, name) {
  await p
    .getByLabel(
      ["Sort alphabetically", "Manual ordering"].includes(name)
        ? "Sort"
        : "Sorting and options",
      { exact: true },
    )
    .click();
  await p
    .getByRole(
      ["Sort alphabetically", "Manual ordering"].includes(name)
        ? "menuitemradio"
        : "menuitem",
      { name, exact: true },
    )
    .click();
}
async function footer(p, names) {
  await p.locator(".toolbar .nav-control").first().waitFor();
  assert.deepEqual(
    await p
      .locator(".toolbar .nav-control")
      .evaluateAll((es) =>
        es
          .filter(
            (e) =>
              ![
                "settings",
                "share-details",
                "family-mine",
                "contacts-invite",
                "contacts-uninvite",
                "contacts-anylist-sync",
                "contacts-select-event",
                "contacts-invite-cancel",
              ].includes(e.dataset.action) &&
              !e.dataset.action.endsWith("search") &&
              e.dataset.icon !== "plus",
          )
          .map((e) => e.getAttribute("aria-label")),
      ),
    names.filter(
      (name) =>
        ![
          "Family",
          "Contacts",
          "Edit House",
          "Edit Event",
          "Share",
          "Settings",
        ].includes(name),
    ),
  );
}
async function editValue(p, category, action, label, value) {
  await p
    .getByLabel("Appearance categories", { exact: true })
    .getByRole("button", { name: category, exact: true })
    .click();
  await p
    .getByLabel("Appearance actions", { exact: true })
    .getByRole("button", { name: action, exact: true })
    .click();
  const input = p.getByLabel(label, { exact: true });
  if (await input.evaluate((el) => el.tagName === "SELECT"))
    await input.selectOption(value);
  else await input.fill(value);
}
async function home(p) {
  await p.locator(".toolbar [data-action=home]").click();
  await p.locator(".hero h1").waitFor();
}
async function geometry(p) {
  await p.waitForFunction(
    () =>
      parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          "--top-height",
        ),
      ) > 0,
  );
  assert.ok(
    await p.evaluate(() => {
      const top = document.querySelector(".top-shell").getBoundingClientRect(),
        footer = document.querySelector(".toolbar").getBoundingClientRect();
      return (
        top.top === 0 &&
        Math.abs(footer.bottom - innerHeight) < 2 &&
        document.documentElement.scrollWidth <= innerWidth + 1
      );
    }),
  );
}
try {
  await mkdir("test-results", { recursive: true });
  const p = await page(owner);
  await p.getByRole("heading", { name: "Alpha", exact: true }).waitFor();
  stage("shared fixed chrome and landing-page Home");
  await footer(p, [
    "Home",
    "Family",
    "Contacts",
    "Edit House",
    "Share",
    "Settings",
  ]);
  await geometry(p);
  await click(p, "Family");
  await click(p, "Lists");
  await click(p, "Shared folder");
  await click(p, "Groceries");
  await home(p);
  await click(p, "Contacts");
  await home(p);
  await click(p, "Settings");
  await p.getByRole("button", { name: "Sign Out", exact: true }).waitFor();
  await home(p);
  stage("household live appearance draft, category mapping, Cancel and Save");
  const before = store.household(host.household).design;
  await click(p, "Edit House");
  assert.equal(await p.locator("#editor[open]").count(), 0);
  assert.deepEqual(
    await p.locator(".appearance-categories button").allTextContents(),
    [
      "Background",
      "Titles",
      "Description",
      "Text",
      "Containers",
      "Toolbars",
      "Buttons",
    ],
  );
  await editValue(p, "Background", "Color", "Background color", "#ddeeff");
  assert.equal(
    await p
      .locator("body")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgb(221, 238, 255)",
  );
  p.once("dialog", (d) => d.dismiss());
  await p.locator(".toolbar [data-action=home]").click();
  assert.equal(await p.locator(".appearance-categories").count(), 1);
  await editValue(p, "Text", "Color", "Text color", "#123456");
  assert.equal(
    await p
      .locator(".hero .eyebrow")
      .first()
      .evaluate((el) => getComputedStyle(el).color),
    "rgb(18, 52, 86)",
  );
  assert.deepEqual(store.household(host.household).design, before);
  await click(p, "Cancel");
  assert.deepEqual(store.household(host.household).design, before);
  await click(p, "Edit House");
  await editValue(p, "Text", "Color", "Text color", "#123456");
  await editValue(
    p,
    "Containers",
    "Background",
    "Containers background",
    "#e1e2e3",
  );
  await editValue(p, "Titles", "Font", "Titles font", "Verdana");
  await editValue(p, "Titles", "Style", "Titles style", "italic");
  await editValue(
    p,
    "Containers",
    "Border",
    "Containers border color",
    "#112233",
  );
  assert.equal(
    await p
      .locator("[data-home-card=contacts]")
      .evaluate((el) => getComputedStyle(el).borderTopColor),
    "rgb(17, 34, 51)",
  );
  await p
    .getByLabel("Appearance categories", { exact: true })
    .getByRole("button", { name: "Background", exact: true })
    .click();
  await p
    .getByLabel("Appearance actions", { exact: true })
    .getByRole("button", { name: "Image", exact: true })
    .click();
  await p
    .getByLabel("Background image (up to 2 MB)", { exact: true })
    .setInputFiles({
      name: "sample.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        "base64",
      ),
    });
  await p.waitForFunction(() =>
    getComputedStyle(document.body).backgroundImage.includes("data:image/png"),
  );
  await p
    .getByRole("button", { name: "Remove background image", exact: true })
    .click();

  await p
    .getByLabel("Appearance categories", { exact: true })
    .getByRole("button", { name: "Containers", exact: true })
    .click();
  await p
    .getByLabel("Appearance actions", { exact: true })
    .getByRole("button", { name: "Image", exact: true })
    .click();
  await p
    .getByLabel("Containers image (up to 2 MB)", { exact: true })
    .setInputFiles({
      name: "container.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        "base64",
      ),
    });
  await p.waitForFunction(() =>
    getComputedStyle(
      document.querySelector("[data-home-card=contacts]"),
      "::before",
    ).backgroundImage.includes("data:image/png"),
  );
  await p.getByLabel("Container image opacity (%)", { exact: true }).fill("25");
  assert.equal(
    await p
      .locator("[data-home-card=contacts]")
      .evaluate((el) => getComputedStyle(el, "::before").opacity),
    "0.25",
  );
  assert.equal(
    await p
      .locator(".top-shell")
      .evaluate((el) => getComputedStyle(el, "::before").backgroundImage),
    "none",
    "Editing toolbars stay solid",
  );
  await editValue(
    p,
    "Toolbars",
    "Background",
    "Toolbars background",
    "#dde0e3",
  );
  await editValue(p, "Buttons", "Background", "Buttons background", "#eef0f2");
  await p.getByLabel("Buttons opacity (%)", { exact: true }).fill("100");
  assert.equal(
    await p
      .locator(".top-shell")
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgb(221, 224, 227)",
  );
  assert.deepEqual(
    await p
      .getByRole("button", { name: "Open Contacts", exact: true })
      .evaluate((el) => {
        const canvas = document.createElement("canvas"),
          ctx = canvas.getContext("2d");
        ctx.fillStyle = getComputedStyle(el).backgroundColor;
        ctx.fillRect(0, 0, 1, 1);
        return [...ctx.getImageData(0, 0, 1, 1).data];
      }),
    [238, 240, 242, 255],
  );
  assert.equal(
    await p
      .locator(".toolbar button")
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgba(0, 0, 0, 0)",
  );
  assert.equal(
    await p
      .locator(".toolbar button")
      .first()
      .evaluate((el) => getComputedStyle(el).borderTopWidth),
    "0px",
  );
  await p.getByText("Formatting options", { exact: true }).click();
  const options = p.locator(".appearance-options");
  assert.ok(
    await options.evaluate((el) => {
      const a = el.querySelector('[data-id="copy"]').getBoundingClientRect(),
        b = el
          .querySelector('[data-action="appearance-reset"]')
          .getBoundingClientRect();
      return b.top >= a.bottom;
    }),
  );
  assert.equal(
    await options
      .locator("button")
      .first()
      .evaluate((el) => getComputedStyle(el).backgroundColor),
    "rgba(0, 0, 0, 0)",
  );
  await p.getByText("Formatting options", { exact: true }).click();
  await geometry(p);
  await click(p, "Save");
  await p.getByText("Appearance saved.", { exact: true }).waitFor();
  await p.reload();
  await p.getByRole("heading", { name: "Alpha", exact: true }).waitFor();
  assert.equal(store.household(host.household).design.textColor, "#123456");
  assert.equal(
    store.household(host.household).design.containerImageOpacity,
    25,
  );
  assert.match(
    store.household(host.household).design.containerImage,
    /^data:image\/png/,
  );
  assert.equal(
    store.get("event", e1.id, host.household).design.containerImage || "",
    "",
    "Household image save preserves existing event appearance",
  );
  assert.equal(
    await p
      .locator(".hero h1")
      .evaluate((el) => getComputedStyle(el).fontStyle),
    "italic",
  );
  await click(p, "Edit House");
  await editValue(p, "Containers", "Background", "Container opacity (%)", "0");
  assert.equal(
    await p
      .getByLabel("Container opacity (%)", { exact: true })
      .getAttribute("min"),
    "0",
  );
  assert.deepEqual(
    await p.locator("[data-home-card=contacts]").evaluate((el) => {
      const canvas = document.createElement("canvas"),
        ctx = canvas.getContext("2d");
      ctx.fillStyle = getComputedStyle(el).backgroundColor;
      ctx.fillRect(0, 0, 1, 1);
      return [
        ctx.getImageData(0, 0, 1, 1).data[3],
        getComputedStyle(el).opacity,
      ];
    }),
    [0, "1"],
    "Only the container background becomes transparent; its contents remain opaque",
  );
  await editValue(p, "Containers", "Background", "Container opacity (%)", "35");
  assert.equal(
    await p
      .locator("body")
      .evaluate((el) => el.classList.contains("editing-active")),
    true,
  );
  for (const selector of [".top-shell", ".toolbar"])
    assert.match(
      await p
        .locator(selector)
        .evaluate((el) => getComputedStyle(el).backgroundColor),
      /^rgb\(/,
      "Editing toolbars have an opaque background",
    );
  await click(p, "Cancel");
  stage("inline contacts: unsaved creation, address groups and scoped edits");
  await click(p, "Contacts");
  await p.getByRole("heading", { name: "Contacts", exact: true }).waitFor();
  const count = store.list("guest", host.household).length;
  await p.getByLabel("Create", { exact: true }).click();
  await p.getByRole("menuitem", { name: "Add Guest", exact: true }).click();
  await p.locator(".inline-contact form").waitFor();
  assert.equal(await p.locator("#editor[open]").count(), 0);
  assert.equal(store.list("guest", host.household).length, count);
  await p
    .locator(".inline-contact")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  assert.equal(await p.locator(".inline-contact").count(), 0);
  await p.getByLabel("Create", { exact: true }).click();
  await p.getByRole("menuitem", { name: "Add Guest", exact: true }).click();
  await p.getByLabel("First name", { exact: true }).fill("New");
  await p.getByLabel("Last name", { exact: true }).fill("Contact");
  await p.getByRole("button", { name: "Save", exact: true }).click();
  await p.getByText("Guest saved.", { exact: true }).waitFor();
  assert.equal(store.list("guest", host.household).length, count + 1);
  await click(p, "Casey Example");
  assert.equal(
    await p.getByLabel("Private guest notes", { exact: true }).count(),
    0,
  );
  await p
    .getByLabel("Phone number (international)", { exact: true })
    .fill("+15559990000");
  await p
    .locator(".inline-contact")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  assert.notEqual(
    store.get("guest", guest.id, host.household).notes,
    "Draft only",
  );
  const a = (
    await api(owner, "/api/host/addresses", { label: "Zulu", lines: "1 Z St" })
  ).body;
  const b = (
    await api(owner, "/api/host/addresses", {
      label: "Alpha address",
      lines: "1 A St",
    })
  ).body;
  await api(owner, "/api/host/guests", {
    first: "Adam",
    last: "Zulu",
    address: a.id,
  });
  await api(owner, "/api/host/guests", {
    first: "Zoe",
    last: "Alpha",
    address: b.id,
  });
  await p.reload();
  await click(p, "Contacts");
  await p.getByRole("heading", { name: "Contacts", exact: true }).waitFor();
  assert.equal(await p.locator('[data-action^="contacts-sort-"]').count(), 0);
  await p.waitForFunction(
    () =>
      document.querySelector("[data-address-title]")?.textContent ===
      "Alpha address",
  );
  assert.deepEqual(await p.locator("[data-address-title]").allTextContents(), [
    "Alpha address",
    "No shared address",
    "Zulu",
  ]);
  const addressHeading = p.locator("[data-address-group]").filter({
    has: p.locator("[data-address-title]", { hasText: "Alpha address" }),
  });
  assert.match(await addressHeading.textContent(), /Guest ID · \d{4}/);
  assert.equal(
    await p.locator("[data-address-group] .address-guest-id").count(),
    2,
  );
  await home(p);
  const card = p.locator("article.card").filter({
    has: p.getByRole("heading", { name: "Dinner One", exact: true }),
  });
  await card.getByRole("button", { name: "View Event", exact: true }).click();
  await footer(p, [
    "Home",
    "Family",
    "Contacts",
    "Edit Event",
    "Share Invitation",
    "Settings",
  ]);
  assert.equal(await p.locator(".top-shell [data-action=print]").count(), 1);
  stage("event appearance independence and description coverage");
  await click(p, "Edit Event");
  await editValue(p, "Description", "Color", "Description color", "#554433");
  assert.equal(
    await p
      .locator(".event-meta b")
      .first()
      .evaluate((el) => getComputedStyle(el).color),
    "rgb(85, 68, 51)",
  );
  await click(p, "Save");
  await p.getByText("Appearance saved.", { exact: true }).waitFor();
  assert.equal(
    store.get("event", e1.id, host.household).design.descriptionColor,
    "#554433",
  );
  assert.notEqual(
    store.household(host.household).design.descriptionColor,
    "#554433",
  );
  for (const width of [390, 1440]) {
    await p.setViewportSize({ width, height: 900 });
    await geometry(p);
    await p.screenshot({
      path: `test-results/toolbars-event-${width}.png`,
      fullPage: true,
    });
  }
  stage(
    "administrator dedicated management, default draft and existing overrides",
  );
  const adminCookie = (
    await api(null, "/api/login", { email: "admin@example.test", password })
  ).cookie;
  const admin = await page(adminCookie, 390);
  await admin.getByRole("heading", { name: /Open the door/ }).waitFor();
  await footer(admin, [
    "Home",
    "Approvals",
    "Hosts",
    "Defaults",
    "Templates",
    "Settings",
  ]);
  await click(admin, "Approvals");
  await admin
    .getByLabel("Email address", { exact: true })
    .fill("approved@example.test");
  await click(admin, "Approve host");
  await admin.getByText("approved@example.test", { exact: true }).waitFor();
  await click(admin, "Hosts");
  await admin
    .getByRole("button", { name: "Recover owner sign-in", exact: true })
    .first()
    .click();
  assert.ok(await admin.locator("#editor.inline-management[open]").count());
  await admin.getByRole("button", { name: "Cancel", exact: true }).click();
  await click(admin, "Defaults");
  await admin.getByLabel("Example page", { exact: true }).waitFor();
  const existing = structuredClone(store.household(host.household).design);
  await editValue(admin, "Text", "Color", "Text color", "#778899");
  await click(admin, "Cancel");
  assert.equal(store.get("ui", "defaults", "platform"), null);
  await click(admin, "Defaults");
  await admin.getByLabel("Example page", { exact: true }).waitFor();
  await editValue(admin, "Text", "Color", "Text color", "#778899");
  for (const width of [390, 1440]) {
    await admin.setViewportSize({ width, height: 900 });
    await geometry(admin);
    await admin.screenshot({
      path: `test-results/toolbars-default-editor-${width}.png`,
      fullPage: true,
    });
  }
  await admin.setViewportSize({ width: 390, height: 900 });
  const frame = admin.frameLocator("#page-example-frame");
  const eyebrow = frame.locator(
    "[data-layout=introText] [data-layout-item=eyebrow]",
  );
  await eyebrow.dblclick();
  await eyebrow.fill("Shared welcome");
  await eyebrow.press("Tab");
  await click(admin, "Save");
  await admin.getByText("Page settings saved.", { exact: true }).waitFor();
  assert.equal(
    store.get("ui", "defaults", "platform").design.textColor,
    "#778899",
  );
  assert.equal(
    store.household(host.household).design.textColor,
    existing.textColor,
  );
  assert.equal(
    store.get("event", e1.id, host.household).design.descriptionColor,
    "#554433",
  );
  await click(admin, "Templates");
  await admin.getByText("Shared card templates", { exact: true }).waitFor();
  assert.equal(
    await admin.locator("#editor.inline-management[open]").count(),
    1,
  );
  await admin.getByLabel("Create", { exact: true }).click();
  await admin
    .getByRole("menuitem", { name: "Create shared template", exact: true })
    .click();
  await admin
    .getByRole("heading", { name: "Edit shared template", exact: true })
    .waitFor();
  await click(admin, "Close editor");
  await admin.getByText("Shared card templates", { exact: true }).waitFor();
  await admin.getByLabel("Create", { exact: true }).click();
  await admin
    .getByRole("menuitem", { name: "Create shared template", exact: true })
    .click();
  await admin
    .getByRole("heading", { name: "Edit shared template", exact: true })
    .waitFor();
  await admin.setViewportSize({ width: 1440, height: 900 });
  await admin.getByLabel("Selected item", { exact: true }).selectOption("2");
  await admin
    .getByText("Example QR — replaced with the household link when used.", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await admin.locator("#card-canvas [data-qr-modules]").count(),
    1,
  );
  await admin.getByLabel("QR color", { exact: true }).fill("#125577");
  await admin.getByLabel("Transparent QR background", { exact: true }).check();
  await click(admin, "Add text above QR");
  await admin
    .locator("#card-fields fieldset:not([hidden]) [name=fieldText]")
    .fill("Scan to see the invitation");
  await admin
    .getByRole("button", { name: "Save shared template", exact: true })
    .click();
  await admin.getByText("Shared card templates", { exact: true }).waitFor();
  assert.equal(store.list("template", "platform").length, 1);
  const qrTemplate = store.list("template", "platform")[0];
  assert.equal(
    qrTemplate.elements.find((e) => e.field === "qr").qrColor,
    "#125577",
  );
  assert.equal(
    qrTemplate.elements.find((e) => e.field === "qr").qrTransparent,
    true,
  );
  assert.ok(
    qrTemplate.elements.some((e) => e.text === "Scan to see the invitation"),
  );
  await click(admin, "Settings");
  await admin.getByRole("button", { name: "Sign Out", exact: true }).waitFor();
  for (const width of [390, 1440]) {
    await admin.setViewportSize({ width, height: 900 });
    await geometry(admin);
    await admin.screenshot({
      path: `test-results/toolbars-admin-${width}.png`,
      fullPage: true,
    });
  }
  const child = await page(childCookie);
  await click(child, "Settings");
  assert.equal(
    await child
      .getByRole("button", { name: "Family Members", exact: true })
      .count(),
    0,
  );
  stage(
    "promoted host keeps normal pages and receives Home-only administrator tools",
  );
  await click(admin, "Hosts");
  await admin
    .locator("li")
    .filter({ hasText: "alpha@example.test" })
    .getByRole("button", { name: "Make administrator", exact: true })
    .click();
  await admin
    .getByLabel("Confirm host email", { exact: true })
    .fill("alpha@example.test");
  await admin
    .getByLabel("Your administrator password", { exact: true })
    .fill(password);
  await admin.getByRole("button", { name: "Save", exact: true }).click();
  await admin
    .getByText("Administrator tools enabled", { exact: true })
    .waitFor();
  const promotedCookie = (
    await api(null, "/api/login", { email: "alpha@example.test", password })
  ).cookie;
  const promoted = await page(promotedCookie, 390);
  await promoted
    .getByRole("toolbar", { name: "Administrator tools", exact: true })
    .waitFor();
  assert.deepEqual(
    await promoted.locator(".admin-home-actions button").allTextContents(),
    ["Approvals", "Hosts", "Defaults", "Templates"],
  );
  await footer(promoted, [
    "Home",
    "Family",
    "Contacts",
    "Edit House",
    "Share",
    "Settings",
  ]);
  for (const width of [390, 1440]) {
    await promoted.setViewportSize({ width, height: 900 });
    await geometry(promoted);
    await promoted.screenshot({
      path: `test-results/promoted-host-home-${width}.png`,
      fullPage: true,
    });
  }
  await click(promoted, "Approvals");
  await promoted
    .getByRole("heading", { name: "Approved emails", exact: true })
    .waitFor();
  await footer(promoted, [
    "Home",
    "Family",
    "Contacts",
    "Edit House",
    "Share",
    "Settings",
  ]);
  await home(promoted);
  await click(promoted, "Defaults");
  await promoted.getByLabel("Example page", { exact: true }).waitFor();
  await promoted
    .getByLabel("Example page", { exact: true })
    .selectOption("hostHome");
  await promoted
    .frameLocator("#page-example-frame")
    .locator("[data-home-card=contacts]")
    .waitFor();
  assert.equal(
    await promoted
      .frameLocator("#page-example-frame")
      .locator("[data-home-card]")
      .count(),
    3,
  );
  await click(promoted, "Cancel");
  await promoted
    .getByRole("toolbar", { name: "Administrator tools", exact: true })
    .waitFor();
  await click(promoted, "Templates");
  await promoted.getByText("Shared card templates", { exact: true }).waitFor();
  await click(promoted, "Close editor");
  await promoted
    .getByRole("toolbar", { name: "Administrator tools", exact: true })
    .waitFor();
  await option(promoted, "Preview guest experience");
  await promoted
    .getByLabel("Event (optional)", { exact: true })
    .selectOption(e1.id);
  await promoted.getByRole("button", { name: "Preview", exact: true }).click();
  await promoted
    .getByRole("button", { name: "Exit read-only preview", exact: true })
    .waitFor();
  const responseCount = store.list("response", host.household).length;
  await promoted.locator("main [data-action=rsvp]").click();
  assert.equal(store.list("response", host.household).length, responseCount);
  await click(promoted, "Exit read-only preview");
  await promoted
    .getByRole("toolbar", { name: "Administrator tools", exact: true })
    .waitFor();
  await promoted
    .locator("article.card")
    .filter({
      has: promoted.getByRole("heading", { name: "Dinner One", exact: true }),
    })
    .getByRole("button", { name: "View Event", exact: true })
    .click();
  await promoted.locator(".event-hero").waitFor();
  assert.equal(await promoted.locator(".admin-home-actions").count(), 0);
  const g = await page(guestCookie);
  await g.getByRole("heading", { name: "Alpha", exact: true }).waitFor();
  await g
    .getByRole("button", { name: "View Event", exact: true })
    .first()
    .click();
  assert.equal(
    await g.getByRole("button", { name: "Edit Event", exact: true }).count(),
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: fixed shared chrome, landing Home, inline contacts/groups, seven-category live drafts, Save/Cancel, event independence, administrator defaults and role permissions.",
  );
} catch (error) {
  console.error("Toolbar browser failed during " + phase, error);
  throw error;
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  store.db.close();
  clearTimeout(watchdog);
}

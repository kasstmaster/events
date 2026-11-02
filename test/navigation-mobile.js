// Synthetic loopback data only. Native sharing/clipboard are mocked at the browser boundary.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { Store } from "../server/node-store.js";
import { createApp } from "../server/app.js";
const origin = "http://127.0.0.1:3179",
  password = "Navigation-test-only-passphrase",
  store = new Store();
let phase = "setup";
const stage = (s) => {
  phase = s;
  console.log("Navigation browser: " + s);
};
const watchdog = setTimeout(() => {
  console.error("Navigation browser exceeded 150 seconds during " + phase);
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
server.listen(3179, "127.0.0.1");
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
  await p.getByRole("button", { name, exact: true }).click();
}
async function option(p, name) {
  await p.locator('summary[aria-label="Sorting and options"]').click();
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
      .evaluateAll((es) => es.map((e) => e.getAttribute("aria-label"))),
    names,
  );
}
try {
  await mkdir("test-results", { recursive: true });
  stage("host home, per-event actions and native share");
  const p = await page(owner, 1440);
  await footer(p, ["Home", "Contacts", "Edit House", "Share", "Sign Out"]);
  await p.getByRole("heading", { name: "Alpha", exact: true }).waitFor();
  assert.equal(
    await p
      .locator(
        ".hero [data-action=new-event],.hero [data-action=addresses],.hero [data-action=household]",
      )
      .count(),
    0,
  );
  await p.locator("summary[aria-label=Create]").click();
  assert.deepEqual(await p.getByRole("menuitem").allTextContents(), [
    "Create Event",
    "Cards & Templates",
  ]);
  await p.locator("summary[aria-label=Create]").click();
  for (const [event, title] of [
    [e1, "Dinner One"],
    [e2, "Dinner Two"],
  ]) {
    const card = p
      .locator("article.card")
      .filter({ has: p.getByRole("heading", { name: title, exact: true }) });
    assert.deepEqual(await card.getByRole("button").allTextContents(), [
      "View Event",
      "RSVPs",
      "Text Reminders",
      "Cards",
      "Preview Invitation",
    ]);
    await card.getByRole("button", { name: "RSVPs", exact: true }).click();
    await p.getByRole("dialog").getByText(title, { exact: true }).waitFor();
    assert.ok(requests.includes(`/api/host/events/${event.id}/dashboard`));
    await click(p, "Close editor");
    await card
      .getByRole("button", { name: "Text Reminders", exact: true })
      .click();
    await p.getByRole("dialog").waitFor();
    await p
      .getByRole("dialog")
      .getByText("Delivery status", { exact: true })
      .waitFor();
    assert.ok(requests.includes(`/api/host/events/${event.id}/reminders`));
    await click(p, "Close editor");
    await card.getByRole("button", { name: "Cards", exact: true }).click();
    await click(p, "Create card / template");
    await p
      .getByRole("heading", { name: "Edit your card", exact: true })
      .waitFor();
    assert.equal(await p.locator('[name="cardEvent"]').inputValue(), event.id);
    await click(p, "Close editor");
    await card
      .getByRole("button", { name: "Preview Invitation", exact: true })
      .click();
    await p
      .getByRole("heading", { name: "Edit your card", exact: true })
      .waitFor();
    assert.equal(await p.locator('[name="cardEvent"]').inputValue(), event.id);
    await click(p, "Close editor");
  }
  await p.evaluate(() => {
    Object.defineProperty(navigator, "share", {
      configurable: true,
      writable: true,
      value: async (data) => {
        window.sharedUrl = data.url;
      },
    });
  });
  await click(p, "Share");
  await p.waitForFunction(() => !!window.sharedUrl);
  assert.equal(
    await p.evaluate(() => window.sharedUrl),
    origin + "/h/" + household.slug,
  );
  await p.evaluate(() => {
    navigator.share = async () => {
      throw new DOMException("Cancelled", "AbortError");
    };
  });
  await click(p, "Share");
  assert.doesNotMatch(
    await p.locator("#notice").innerText(),
    /error|cancelled/i,
  );
  await p.evaluate(() => {
    navigator.share = undefined;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value) => {
          window.copiedUrl = value;
        },
      },
    });
  });
  await click(p, "Share");
  await p.getByText("Link copied.", { exact: true }).waitFor();
  assert.equal(
    await p.evaluate(() => window.copiedUrl),
    origin + "/h/" + household.slug,
  );
  stage("shared Contacts rows, search, menus and formatting");
  await click(p, "Contacts");
  await p.getByRole("heading", { name: "Contacts", exact: true }).waitFor();
  await footer(p, ["Home", "Contacts", "Edit House", "Share", "Sign Out"]);
  assert.equal(await p.locator(".browse-row").count(), 1);
  await click(p, "Search");
  await p.getByRole("searchbox").fill("absent");
  await p
    .getByText("No matching contacts. Use the plus menu to add someone.", {
      exact: true,
    })
    .waitFor();
  await p.getByRole("searchbox").fill("Casey");
  await p.getByRole("button", { name: "Casey Example", exact: true }).waitFor();
  assert.equal(
    await p.locator(".app-topbar").evaluate((el) => getComputedStyle(el).color),
    "rgb(19, 75, 55)",
  );
  stage(
    "four workspace sections, nested lists, sorting, completion and separate edit",
  );
  await click(p, "Home");
  await click(p, "Family Workspace");
  await p
    .getByRole("heading", { name: "Family Workspace", exact: true })
    .waitFor();
  await footer(p, ["Home", "Settings", "Sign Out"]);
  assert.deepEqual(
    await p
      .locator(".browse-rows > .browse-row .browse-open")
      .allTextContents(),
    ["Lists", "Tasks", "Records", "Chores"],
  );
  await click(p, "Lists");
  await click(p, "Shared folder");
  await click(p, "Groceries");
  await p.getByText("2 of 2 items remaining", { exact: true }).waitFor();
  assert.deepEqual(await p.locator(".family-item-title").allTextContents(), [
    "Zucchini",
    "Apples",
  ]);
  await option(p, "Sort alphabetically");
  await p
    .locator(".family-item-title")
    .first()
    .filter({ hasText: "Apples" })
    .waitFor();
  assert.deepEqual(await p.locator(".family-item-title").allTextContents(), [
    "Apples",
    "Zucchini",
  ]);
  await option(p, "Manual ordering");
  await p
    .locator(".family-item-title")
    .first()
    .filter({ hasText: "Zucchini" })
    .waitFor();
  assert.deepEqual(await p.locator(".family-item-title").allTextContents(), [
    "Zucchini",
    "Apples",
  ]);
  const first = store
    .list("family-item", host.household)
    .find((i) => i.title === "Zucchini");
  await p
    .locator(`[data-family-item="${first.id}"] [data-action=family-item-edit]`)
    .click();
  await p.getByRole("dialog").getByLabel("Item", { exact: true }).waitFor();
  assert.equal(
    store.get("family-item", first.id, host.household).completed,
    false,
  );
  await click(p, "Cancel");
  await p.getByText("Zucchini", { exact: true }).dblclick();
  await p.waitForFunction(() => {
    const input = document.querySelector('[aria-label="Complete Zucchini"]');
    return (
      input?.checked &&
      !input.disabled &&
      document.querySelector("#family-save-status")?.textContent === "Saved"
    );
  });
  await option(p, "Hide Completed");
  await p
    .locator(".family-item-title")
    .getByText("Zucchini", { exact: true })
    .waitFor({ state: "hidden" });
  await option(p, "Show All");
  await click(p, "Search");
  await p.getByRole("searchbox").fill("Private appliance");
  await click(p, "Private appliance");
  await p.getByText("Model 42", { exact: true }).waitFor();
  await click(p, "Home");
  await click(p, "Tasks");
  await click(p, "Homework");
  await p
    .getByRole("checkbox", { name: "Complete this occurrence", exact: true })
    .count();
  await click(p, "Home");
  await click(p, "Chores");
  await click(p, "Water plants");
  await p
    .getByText(/weekly/)
    .first()
    .waitFor();
  await click(p, "Home");
  await click(p, "Settings");
  await p
    .getByRole("button", { name: "Family Members", exact: true })
    .waitFor();
  await p
    .getByRole("button", { name: "Change Password", exact: true })
    .waitFor();
  await click(p, "Home");
  for (const width of [390, 1440]) {
    await p.setViewportSize({ width, height: 900 });
    await p.locator(".browse-row").last().scrollIntoViewIfNeeded();
    assert.ok(
      await p.evaluate(() => {
        const last = [...document.querySelectorAll(".browse-row")]
          .at(-1)
          .getBoundingClientRect();
        return (
          last.bottom <=
          document.querySelector(".toolbar").getBoundingClientRect().top
        );
      }),
    );
    await p.screenshot({
      path: `test-results/navigation-workspace-${width}.png`,
      fullPage: true,
    });
  }
  await p.setViewportSize({ width: 390, height: 900 });
  stage("child and regular-member restrictions including global search");
  const child = await page(childCookie);
  await click(child, "Tasks");
  await child.getByRole("button", { name: "Homework", exact: true }).waitFor();
  await click(child, "Search");
  await child.getByRole("searchbox").fill("Private");
  await child
    .getByText("Nothing here yet. Use the plus menu to get started.", {
      exact: true,
    })
    .waitFor();
  assert.doesNotMatch(
    await child.locator("main").innerText(),
    /Private appliance|Old recipe/,
  );
  await click(child, "Home");
  await click(child, "Settings");
  assert.equal(
    await child
      .getByRole("button", { name: "Family Members", exact: true })
      .count(),
    0,
  );
  const regularPage = await page(regularCookie);
  await click(regularPage, "Settings");
  assert.equal(
    await regularPage
      .getByRole("button", { name: "Family Members", exact: true })
      .count(),
    0,
  );
  assert.equal(
    (
      await api(regularCookie, "/api/family/members", {
        name: "Bad",
        login: "bad",
        role: "administrator",
        password,
      })
    ).status,
    403,
  );
  stage("event-only toolbar changes preserve public content and guest RSVP");
  await click(p, "Settings");
  await click(p, "Back to household home");
  const second = p.locator("article.card").filter({
    has: p.getByRole("heading", { name: "Dinner Two", exact: true }),
  });
  await second.getByRole("button", { name: "View Event", exact: true }).click();
  await footer(p, ["Home", "Edit Event", "Print"]);
  assert.equal(await p.locator(".event-summary").count(), 1);
  assert.equal(
    await p
      .locator(
        "main [data-action=invitation],main [data-action=reminders],main [data-action=cards]",
      )
      .count(),
    0,
  );
  await p
    .locator(".event-hero")
    .getByRole("heading", { name: "Dinner Two", exact: true })
    .waitFor();
  const g = await page(guestCookie);
  await g.getByRole("heading", { name: "Alpha", exact: true }).waitFor();
  const guestCard = (title) =>
    g
      .locator("article.card")
      .filter({ has: g.getByRole("heading", { name: title, exact: true }) });
  await guestCard("Dinner Two")
    .getByRole("button", { name: "View Event", exact: true })
    .click();
  await footer(g, ["Home", "Print"]);
  assert.equal(await g.locator(".event-summary").count(), 0);
  assert.equal(
    await g.getByRole("button", { name: "Edit Event", exact: true }).count(),
    0,
  );
  await click(g, "Home");
  await guestCard("Dinner One")
    .getByRole("button", { name: "View Event", exact: true })
    .click();
  await g.locator(".event-summary").waitFor();
  assert.doesNotMatch(
    await g.locator(".event-summary").innerText(),
    /Invited|No response/,
  );
  await g.getByText("Where", { exact: true }).waitFor();
  await g.locator("main [data-action=rsvp]").click();
  await g.getByLabel("Casey Example", { exact: true }).selectOption("yes");
  await g.getByLabel("Quantity for Salad").fill("1");
  await g
    .getByRole("dialog")
    .getByRole("button", { name: "RSVP", exact: true })
    .click();
  await g.getByRole("dialog").waitFor({ state: "hidden" });
  await g.getByText("Salad × 1", { exact: true }).waitFor();
  for (const [name, page, width] of [
    ["owner", p, 1440],
    ["child", child, 390],
    ["guest", g, 390],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await page.screenshot({
      path: `test-results/navigation-${name}.png`,
      fullPage: true,
    });
  }
  assert.deepEqual(errors, []);
  assert.equal(
    store.get("family-record", "legacy-retained", host.household).type,
    "recipe",
  );
  console.log(
    "PASS: shared browsing, four sections, Settings, roles, search/sort, per-event controls, native share and guest potluck/RSVP.",
  );
} catch (error) {
  console.error("Navigation browser failed during " + phase, error);
  throw error;
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  store.db.close();
  clearTimeout(watchdog);
}

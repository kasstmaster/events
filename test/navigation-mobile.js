import { enrollGuest } from "./helpers/guest-account.js";
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
    logo: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
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
const server = createApp({
  store,
  origin,
  env: { MEYER_HOST_EMAIL: "alpha@example.test" },
});
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
    time: "18:30",
    uploadURL: "https://example.test/upload",
    notes: "Host-only event notes",
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
    date: "2089-06-10",
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
await enrollGuest(origin, guestCookie, "navigation.casey");
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
  if (
    [
      "Edit House",
      "Edit Event",
      "Light Mode",
      "Dark Mode",
      "Default Mode",
      "Custom Colors Mode",
    ].includes(name)
  ) {
    await click(p, name);
    return;
  }
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
  await p.locator(".toolbar button.nav-control").first().waitFor();
  assert.deepEqual(
    await p
      .locator(".toolbar button.nav-control")
      .evaluateAll((es) =>
        es
          .filter(
            (e) =>
              ![
                "settings",
                "share-details",
                "family-mine",
                "contacts-select",
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
try {
  await mkdir("test-results", { recursive: true });
  stage("host home, per-event actions and native share");
  const p = await page(owner, 1440);
  await p.locator("[data-home-card]").first().waitFor();
  assert.equal(await p.locator("[data-home-card] h2").count(), 0);
  assert.ok(
    await p.locator("[data-home-card] > p").evaluateAll((els) => {
      const signature = (el) => {
        const s = getComputedStyle(el);
        return [
          s.color,
          s.fontFamily,
          s.fontSize,
          s.fontWeight,
          s.fontStyle,
        ].join("|");
      };
      return els.every((el) => signature(el) === signature(els[0]));
    }),
  );
  for (const name of [
    "Address Book",
    "Open Cards & Invites",
    "Open Family Workspace",
  ])
    assert.equal(await p.getByRole("button", { name, exact: true }).count(), 1);
  assert.equal(await p.locator("[data-action=preview-guest]").count(), 0);
  assert.deepEqual(
    await p
      .locator("[data-home-card]")
      .evaluateAll((els) => els.map((el) => el.dataset.homeCard)),
    ["contacts", "cards", "family"],
  );
  assert.ok(
    await p.locator(".home-workspace-cards").evaluate((el) => {
      const a = el
          .querySelector('[data-home-card="contacts"]')
          .getBoundingClientRect(),
        b = el
          .querySelector('[data-home-card="cards"]')
          .getBoundingClientRect();
      return Math.abs(a.top - b.top) < 2 && b.left > a.left;
    }),
  );
  assert.equal(
    await p
      .locator(".home-events")
      .evaluate(
        (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
      ),
    2,
  );
  await p.setViewportSize({ width: 390, height: 900 });
  assert.ok(
    await p
      .locator(".home-workspace-cards")
      .evaluate(
        (el) =>
          Math.abs(
            el.children[0].getBoundingClientRect().top -
              el.children[1].getBoundingClientRect().top,
          ) < 2,
      ),
    "Contacts and Cards stay paired on phones",
  );
  assert.equal(
    await p
      .locator(".home-events")
      .evaluate(
        (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
      ),
    1,
  );
  await p.setViewportSize({ width: 1440, height: 900 });

  assert.equal(
    await p
      .locator(
        ".toolbar [data-action=family-workspace],.toolbar [data-action=addresses],.toolbar [data-action=household],.toolbar [data-action=share]",
      )
      .count(),
    0,
  );
  await option(p, "Edit House");
  await click(p, "Cancel");

  await footer(p, [
    "Home",
    "Family",
    "Contacts",
    "Edit House",
    "Share",
    "Settings",
  ]);
  await p.getByRole("heading", { name: "Alpha", exact: true }).waitFor();
  assert.equal(
    await p
      .locator(
        ".hero [data-action=new-event],.hero [data-action=addresses],.hero [data-action=household]",
      )
      .count(),
    0,
  );
  await p.getByRole("button", { name: "Create", exact: true }).click();
  await p
    .getByRole("heading", { name: "A new reason to gather", exact: true })
    .waitFor();
  await click(p, "Cancel");
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
      "Reminders",
      "Invitation Cards",
    ]);
    await card.getByRole("button", { name: "RSVPs", exact: true }).click();
    await p.getByRole("dialog").getByText(title, { exact: true }).waitFor();
    assert.ok(requests.includes(`/api/host/events/${event.id}/dashboard`));
    await click(p, "Close editor");
    await card.getByRole("button", { name: "Reminders", exact: true }).click();
    await p.getByRole("dialog").waitFor();
    await p
      .getByRole("dialog")
      .getByText("Delivery status", { exact: true })
      .waitFor();
    assert.ok(requests.includes(`/api/host/events/${event.id}/reminders`));
    await click(p, "Close editor");
    await card
      .getByRole("button", { name: "Invitation Cards", exact: true })
      .click();
    await click(p, "Create card / template");
    await p.locator("#card-editor-form").waitFor();
    assert.equal(await p.locator('[name="cardEvent"]').inputValue(), event.id);
    await click(p, "Close");
    await click(p, "Home");
    await card
      .getByRole("button", { name: "Invitation Cards", exact: true })
      .click();
    await p
      .getByRole("button", { name: "Edit invitation", exact: true })
      .click();
    await p.locator("#card-preview-canvas > svg").waitFor();
    await click(p, "Edit");
    await p.locator("#card-editor-form").waitFor();
    assert.equal(await p.locator('[name="cardEvent"]').inputValue(), event.id);
    await click(p, "Close");
    await click(p, "Close");
    await click(p, "Home");
  }
  assert.equal(
    await p.getByRole("heading", { name: "Your events", exact: true }).count(),
    1,
  );
  assert.equal(await p.locator(".home-events .eyebrow").count(), 0);
  assert.equal(await p.locator(".home-events img.family-logo").count(), 2);
  for (const width of [320, 390, 1440]) {
    await p.setViewportSize({ width, height: 900 });
    assert.equal(
      await p
        .locator(".home-events")
        .evaluate(
          (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
        ),
      width < 760 ? 1 : 2,
    );
    const cards = await p.evaluate(() =>
      [...document.querySelectorAll(".host-event-choice")].map((choice) => {
        const box = (el) => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        };
        return {
          heading: box(choice.querySelector(".event-choice-heading")),
          overview: box(choice.querySelector(".event-overview")),
          viewEvent: box(choice.querySelector('[data-action="open-event"]')),
          actions: box(choice.querySelector(".event-home-actions")),
          buttons: [
            ...choice.querySelectorAll(".event-home-actions button"),
          ].map(box),
        };
      }),
    );
    for (const { heading, overview, viewEvent, actions, buttons } of cards) {
      if (width < 760) {
        assert.ok(
          Math.abs(viewEvent.width - actions.width) < 1,
          "View Event matches the stacked actions on phones",
        );
        assert.ok(Math.abs(viewEvent.x - actions.x) < 1);
      } else {
        assert.ok(
          viewEvent.width < overview.width,
          "Desktop View Event retains its natural width",
        );
      }
      assert.ok(heading.y + heading.height <= overview.y + 1);
      assert.ok(heading.y + heading.height <= actions.y + 1);
      assert.ok(
        heading.width >=
          (width < 760
            ? Math.max(overview.width, actions.width)
            : overview.width + actions.width),
      );

      assert.ok(
        width < 760
          ? overview.y + overview.height <= actions.y + 1
          : overview.x + overview.width <= actions.x + 1,
        "Event actions fit within each invitation card",
      );
      let bottom = 0;
      for (const box of buttons) {
        assert.ok(box.y >= bottom);
        assert.ok(Math.abs(box.x - actions.x) < 1);
        bottom = box.y + box.height;
      }
    }
    assert.ok(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    assert.doesNotMatch(
      await p.locator("#main").innerText(),
      /Updated .*syncs automatically|A familiar table\. A new memory\. Make room for your next gathering\./,
    );
    await p.screenshot({
      path: `test-results/event-chooser-${width}.png`,
      fullPage: true,
    });
  }
  stage("background refresh retains the reader's scroll position");
  await p.setViewportSize({ width: 390, height: 600 });
  await p.evaluate(() => {
    window.pageRefreshes = 0;
    window.refreshObserver = new MutationObserver(() => window.pageRefreshes++);
    window.refreshObserver.observe(document.querySelector("#app"), {
      childList: true,
    });
    window.scrollTo(0, 300);
    window.readingPosition = scrollY;
  });
  assert.ok(await p.evaluate(() => window.readingPosition > 100));
  const eventBeforeRefresh = store.get("event", e1.id, household.id);
  store.put(
    "event",
    e1.id,
    household.id,
    { ...eventBeforeRefresh, description: "Background update after scrolling" },
    eventBeforeRefresh.version,
  );
  await p
    .getByText("Background update after scrolling", { exact: true })
    .waitFor();
  await p.waitForFunction(() => window.pageRefreshes >= 1);
  const refreshCount = await p.evaluate(() => window.pageRefreshes);
  await p.waitForTimeout(3500);
  assert.equal(
    await p.evaluate(() => window.pageRefreshes),
    refreshCount,
    "Unchanged polls must preserve the rendered buttons",
  );
  assert.ok(
    await p.evaluate(() => Math.abs(scrollY - window.readingPosition) < 3),
    "Background refresh must preserve scrolling while adopting new content",
  );
  await p.evaluate(() => window.refreshObserver.disconnect());
  const openEventButton = p
    .locator("article.card")
    .filter({
      has: p.getByRole("heading", { name: "Dinner One", exact: true }),
    })
    .getByRole("button", { name: "View Event", exact: true });
  await openEventButton.scrollIntoViewIfNeeded();
  const heldButton = await openEventButton.elementHandle();
  const heldBox = await openEventButton.boundingBox();
  await p.mouse.move(
    heldBox.x + heldBox.width / 2,
    heldBox.y + heldBox.height / 2,
  );
  await p.mouse.down();
  const pendingRefreshEvent = store.get("event", e2.id, household.id);
  store.put(
    "event",
    e2.id,
    household.id,
    { ...pendingRefreshEvent },
    pendingRefreshEvent.version,
  );
  await p.waitForTimeout(3500);
  assert.equal(
    await heldButton.evaluate((el) => el.isConnected),
    true,
    "A poll must not replace the control during a click",
  );
  await p.mouse.up();
  await p
    .locator(".event-hero h1")
    .getByText("Dinner One", { exact: true })
    .waitFor();
  await click(p, "Home");
  await p.setViewportSize({ width: 1440, height: 900 });
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
  let preferenceReads = 0;
  await p.route("**/api/family/preferences", async (route) => {
    preferenceReads++;
    await route.continue();
  });
  await click(p, "Contacts");
  await p.getByRole("heading", { name: "Address Book", exact: true }).waitFor();
  assert.equal(
    preferenceReads,
    0,
    "Contacts renders without loading sort preferences",
  );
  await p.unroute("**/api/family/preferences");
  assert.equal(
    await p
      .locator(
        '#top-navigation [data-action="contacts-search"],#top-navigation button[aria-label="Create"]',
      )
      .count(),
    2,
  );
  await p.locator('#top-navigation [data-action="contacts-search"]').waitFor();
  await p.locator('#top-navigation button[aria-label="Create"]').waitFor();
  assert.equal(
    await p
      .locator(
        '.toolbar [data-action="contacts-search"],.toolbar button[aria-label="Create"]',
      )
      .count(),
    0,
  );
  const titleCenter = await p
    .locator(".top-shell .browse-heading")
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return Math.abs(r.left + r.width / 2 - innerWidth / 2);
    });
  assert.ok(titleCenter < 2, "Page title stays centered in the viewport");
  await p.getByRole("heading", { name: "Address Book", exact: true }).waitFor();
  assert.equal(
    await p.getByRole("button", { name: "Sync AnyList", exact: true }).count(),
    1,
  );
  assert.equal(
    await p
      .getByRole("button", { name: "Check sync status", exact: true })
      .count(),
    0,
  );
  let manualStatusReads = 0;
  const syncId = "synthetic-live-sync-job";
  await p.route("**/api/host/integrations/anylist", async (route) => {
    if (route.request().method() !== "POST") {
      manualStatusReads++;
      return route.continue();
    }
    assert.equal(route.request().postDataJSON().mode, "both");
    store.put("anylist-job", syncId, host.household, {
      state: "running",
      started: Date.now(),
      expires: Date.now() + 60000,
    });
    await route.fulfill({
      status: 202,
      json: { id: syncId, state: "running" },
    });
  });
  await click(p, "Sync AnyList");
  await p
    .getByRole("button", { name: "Pull from AnyList", exact: true })
    .waitFor();
  await click(p, "Sync both");
  await p.getByRole("button", { name: "Syncing…", exact: true }).waitFor();
  assert.equal(
    await p.getByRole("button", { name: "Syncing…", exact: true }).isDisabled(),
    true,
  );
  const currentGuest = store.get("guest", guest.id, host.household);
  await api(
    owner,
    "/api/host/guests/" + guest.id,
    { ...currentGuest, phone: "+15551230000" },
    "PUT",
    currentGuest.version,
  );
  const syncJob = store.get("anylist-job", syncId, host.household);
  store.put(
    "anylist-job",
    syncId,
    host.household,
    { ...syncJob, state: "complete", updated: 1 },
    syncJob.version,
  );
  await p.getByText(/15551230000/).waitFor();
  await p.getByText("Contacts synced.", { exact: true }).waitFor();
  assert.equal(
    await p
      .getByRole("button", { name: "Sync AnyList", exact: true })
      .isDisabled(),
    false,
  );
  assert.equal(manualStatusReads, 0);
  await p.unroute("**/api/host/integrations/anylist");
  const padding = await p
    .locator(".browse-open")
    .first()
    .evaluate((el) => {
      const s = getComputedStyle(el);
      return [s.paddingTop, s.paddingBottom, s.paddingLeft, s.paddingRight];
    });
  assert.deepEqual(padding, ["8px", "8px", "8px", "8px"]);

  await footer(p, [
    "Home",
    "Family",
    "Contacts",
    "Edit House",
    "Share",
    "Settings",
  ]);
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
    "sticky contact invitations, multiple selection and additive event choice",
  );
  const inviteAdult = (
    await api(owner, "/api/host/guests", { first: "Jordan", last: "New" })
  ).body;
  const inviteChild = (
    await api(owner, "/api/host/guests", {
      first: "Riley",
      last: "New",
      parent: inviteAdult.id,
    })
  ).body;
  store.put(
    "guest",
    inviteChild.id,
    host.household,
    { ...store.get("guest", inviteChild.id, host.household), position: -2048 },
    inviteChild.version,
  );
  for (let i = 0; i < 20; i++)
    await api(owner, "/api/host/guests", {
      first: "Extra " + String(i).padStart(2, "0"),
      last: "Contact",
    });
  await p.reload();
  await click(p, "Contacts");
  await p.getByRole("heading", { name: "Address Book", exact: true }).waitFor();
  const rowKinds = await p
    .locator(".browse-row[data-contact-kind]")
    .evaluateAll((rows) => rows.map((row) => row.dataset.contactKind));
  assert.ok(rowKinds.indexOf("child") > 0);
  assert.ok(
    rowKinds.slice(rowKinds.indexOf("child")).every((kind) => kind === "child"),
  );
  const childIcon = await p
    .getByRole("button", { name: "Riley", exact: true })
    .locator("xpath=ancestor::li[1]")
    .locator(".browse-row-icon path")
    .getAttribute("d");
  const adultIcon = await p
    .getByRole("button", { name: "Jordan New", exact: true })
    .locator("xpath=ancestor::li[1]")
    .locator(".browse-row-icon path")
    .getAttribute("d");
  assert.notEqual(childIcon, adultIcon);
  assert.equal(await p.locator("[data-contact-invite]").count(), 0);
  assert.equal(
    await p
      .locator(
        '#top-navigation [data-action="contacts-invite"],#top-navigation [data-action="contacts-uninvite"]',
      )
      .count(),
    0,
  );
  await click(p, "Select Contacts");
  assert.equal(
    await p
      .locator(
        '#top-navigation [data-action="contacts-invite"],#top-navigation [data-action="contacts-uninvite"]',
      )
      .count(),
    2,
  );
  assert.equal(
    await p.getByRole("button", { name: "Uninvite", exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await p.getByRole("button", { name: "Casey Example", exact: true }).count(),
    1,
  );
  assert.ok(
    await p.getByRole("button", { name: "Invite", exact: true }).isDisabled(),
  );
  await p.getByLabel("Select Riley", { exact: true }).check();
  assert.equal(
    await p.getByLabel("Select Jordan New", { exact: true }).isChecked(),
    false,
  );
  await click(p, "Invite");
  await p.locator(".contacts-event-picker").waitFor();
  assert.equal(
    await p.getByLabel("Select Jordan New", { exact: true }).isChecked(),
    true,
  );
  assert.equal(
    await p
      .getByRole("button", { name: "Select Contacts", exact: true })
      .count(),
    0,
  );
  const versionBeforeChoice = store.get("event", e2.id, host.household).version;
  await click(p, "Uninvite");
  await p.waitForFunction(
    (id) =>
      document.querySelector(`[data-contact-invite="${id}"]`)?.checked ===
      false,
    inviteAdult.id,
  );
  assert.equal(
    await p.getByLabel("Select Riley", { exact: true }).isChecked(),
    true,
  );
  await click(p, "Invite");
  await p.waitForFunction(
    (id) =>
      document.querySelector(`[data-contact-invite="${id}"]`)?.checked === true,
    inviteAdult.id,
  );
  assert.equal(
    store.get("event", e2.id, host.household).version,
    versionBeforeChoice,
  );
  for (const width of [390, 1440]) {
    await p.setViewportSize({ width, height: 900 });
    await p.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight),
    );
    assert.ok(
      await p
        .locator('#top-navigation [data-action="contacts-invite"]')
        .evaluate((el) => {
          const r = el.getBoundingClientRect();
          return r.top >= 0 && r.bottom <= innerHeight;
        }),
    );
    assert.ok(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await p.screenshot({
      path: `test-results/contact-invitations-${width}.png`,
      fullPage: true,
    });
  }
  await p.locator(".contacts-event-picker").waitFor();
  await p
    .locator(".contacts-event-picker")
    .getByRole("button", { name: "Dinner Two", exact: true })
    .click();
  await p
    .getByText("Guests invited. No messages were sent.", { exact: true })
    .waitFor();
  const invited = store.get("event", e2.id, host.household).invited;
  assert.ok(
    invited.includes(guest.id) &&
      invited.includes(inviteAdult.id) &&
      invited.includes(inviteChild.id),
  );
  assert.equal(
    store.get("event", e1.id, host.household).invited.includes(inviteAdult.id),
    false,
  );
  stage("confirmed uninviting from one chosen event");
  await click(p, "Select Contacts");
  await p.getByLabel("Select Jordan New", { exact: true }).check();
  assert.equal(
    await p.getByLabel("Select Riley", { exact: true }).isChecked(),
    false,
  );
  await click(p, "Uninvite");
  await p.locator(".contacts-event-picker").waitFor();
  assert.equal(
    await p.getByLabel("Select Riley", { exact: true }).isChecked(),
    true,
  );
  const beforeUninvite = store.get("event", e2.id, host.household);
  p.once("dialog", (dialog) => dialog.dismiss());
  await p
    .locator(".contacts-event-picker")
    .getByRole("button", { name: "Dinner Two", exact: true })
    .click();
  assert.deepEqual(store.get("event", e2.id, host.household), beforeUninvite);
  p.once("dialog", (dialog) => dialog.accept());
  await p
    .locator(".contacts-event-picker")
    .getByRole("button", { name: "Dinner Two", exact: true })
    .click();
  await p
    .getByText("Guests uninvited. No messages were sent.", { exact: true })
    .waitFor();
  const afterUninvite = store.get("event", e2.id, host.household);
  assert.deepEqual(afterUninvite.invited, [guest.id]);
  assert.deepEqual(store.get("event", e1.id, host.household).invited, [
    guest.id,
  ]);
  assert.ok(store.get("guest", inviteAdult.id, host.household));
  assert.ok(store.get("guest", inviteChild.id, host.household));
  const unchanged = store.get("event", e2.id, host.household).version;
  await click(p, "Select Contacts");
  await p.getByLabel("Select Casey Example", { exact: true }).check();
  await p
    .locator(".toolbar")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  assert.equal(store.get("event", e2.id, host.household).version, unchanged);
  stage(
    "four workspace sections, nested lists, sorting, completion and separate edit",
  );
  await click(p, "Family");
  await click(p, "Family");
  await p
    .getByRole("heading", { name: "Family Workspace", exact: true })
    .waitFor();
  await footer(p, [
    "Home",
    "Family",
    "Contacts",
    "Edit House",
    "Share",
    "Settings",
  ]);
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
      document.querySelector("#family-save-status")?.textContent === ""
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
  assert.doesNotMatch(
    await p.locator("#main").innerText(),
    /Private document notes/,
  );
  await click(p, "Edit");
  assert.equal(await p.getByLabel("Notes", { exact: true }).count(), 0);
  await click(p, "Save");
  await p.locator("#editor[open]").waitFor({ state: "hidden" });
  await p.getByText("Model 42", { exact: true }).waitFor();
  assert.equal(
    store.get("family-record", secret.id, host.household).notes,
    "Private document notes",
  );
  await click(p, "Family");
  await click(p, "Tasks");
  await click(p, "Homework");
  await p
    .getByRole("checkbox", { name: "Complete this occurrence", exact: true })
    .count();
  await click(p, "Family");
  await click(p, "Chores");
  await click(p, "Water plants");
  await p
    .getByText(/weekly/)
    .first()
    .waitFor();
  await click(p, "Family");
  await click(p, "Settings");
  await p
    .getByRole("button", { name: "Family Members", exact: true })
    .waitFor();
  await p
    .getByRole("button", { name: "Change Password", exact: true })
    .waitFor();
  await click(p, "Family");
  for (const width of [390, 1440]) {
    await p.setViewportSize({ width, height: 900 });
    // Polling replaces rows; scroll the current DOM atomically rather than
    // retaining an element while Playwright waits for its layout to stabilize.
    await p.evaluate(() =>
      [...document.querySelectorAll(".browse-row")]
        .at(-1)
        ?.scrollIntoView({ block: "end" }),
    );
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
  await click(p, "Home");
  const second = p.locator("article.card").filter({
    has: p.getByRole("heading", { name: "Dinner Two", exact: true }),
  });
  await second.getByRole("button", { name: "View Event", exact: true }).click();
  await footer(p, [
    "Home",
    "Invite",
    "Print",
    "Family",
    "Contacts",
    "Edit Event",
    "Settings",
  ]);
  assert.equal(await p.locator(".event-summary").count(), 1);
  assert.equal(await p.locator('.toolbar [data-action="share"]').count(), 0);
  assert.equal(
    await p
      .getByRole("button", { name: "Share Invitation", exact: true })
      .count(),
    1,
  );
  for (const width of [320, 390, 1440]) {
    await p.setViewportSize({ width, height: 900 });
    // Viewport resize and the shared ResizeObserver finish on the next browser frame.
    await p.waitForFunction(() => {
      const summary = document.querySelector(".event-summary");
      return (
        summary.scrollWidth <= summary.clientWidth + 1 &&
        [...summary.querySelectorAll(".totals span")].every(
          (el) => el.scrollWidth <= el.clientWidth + 1,
        )
      );
    });
    assert.ok(
      await p
        .locator(".event-summary")
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      "Every count fits without a summary scrollbar",
    );
    assert.ok(
      await p
        .locator(".event-summary .totals span")
        .evaluateAll((es) =>
          es.every((el) => el.scrollWidth <= el.clientWidth + 1),
        ),
      "Summary words fit without clipping",
    );
    assert.ok(
      await p
        .locator(".rsvp-stack")
        .evaluate(
          (el) =>
            Math.abs(
              el.getBoundingClientRect().width -
                el.parentElement.getBoundingClientRect().width,
            ) < 3,
        ),
      "RSVP spans the event containers",
    );
    assert.equal(
      await p
        .locator(
          '#top-navigation .browse-menu:has(summary[aria-label="Sorting and options"])',
        )
        .count(),
      0,
      "Ordinary event pages have no redundant menu",
    );
    assert.equal(await p.locator('[data-action="event-details"]').count(), 0);
    await p.locator('.toolbar [data-action="settings"]').waitFor();
    const aligned = await p.locator(".top-primary").evaluate((el) => {
      const nodes = [
        el.querySelector(".brand"),
        el.querySelector(".event-summary"),
      ];
      const centers = nodes.map((node) => {
        const r = node.getBoundingClientRect();
        return r.y + r.height / 2;
      });
      return Math.max(...centers) - Math.min(...centers) < 3;
    });
    assert.ok(aligned, "Gather and counts share one toolbar row");
    assert.ok(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await p.screenshot({
      path: `test-results/event-summary-row-${width}.png`,
      fullPage: true,
    });
  }
  await p.setViewportSize({ width: 390, height: 900 });

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
  await g
    .getByRole("heading", { name: `${guest.first} ${guest.last}`, exact: true })
    .waitFor();
  assert.equal(
    await g
      .getByRole("heading", { name: "You’re invited to gather", exact: true })
      .count(),
    1,
  );
  assert.equal(
    await g.getByRole("heading", { name: "Your events", exact: true }).count(),
    0,
  );
  assert.equal(
    await g
      .locator(".home-events")
      .evaluate(
        (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
      ),
    1,
  );
  assert.deepEqual(await g.locator("article.card h2").allTextContents(), [
    "Dinner Two",
    "Dinner One",
  ]);
  assert.equal(await g.locator(".home-events img.family-logo").count(), 2);
  const guestCard = (title) =>
    g
      .locator("article.card")
      .filter({ has: g.getByRole("heading", { name: title, exact: true }) });
  await guestCard("Dinner Two")
    .getByRole("button", { name: "View Event", exact: true })
    .click();
  await g.locator(".event-hero").waitFor();
  assert.equal(
    await g
      .locator(
        '[data-event-section="menus"], [data-event-section="additional-information"]',
      )
      .count(),
    0,
  );
  assert.equal(
    await p.locator("#main").innerHTML(),
    await g.locator("#main").innerHTML(),
    "Host and unanswered guest event bodies use identical markup",
  );
  assert.doesNotMatch(
    await p.locator("#main").innerText(),
    /invites you|Choose an administrator-provided template/,
  );
  await click(p, "RSVP");
  await p
    .getByRole("heading", { name: "Choose an invited guest", exact: true })
    .waitFor();
  assert.equal(store.list("response", host.household).length, 0);
  await click(p, "Close editor");
  await p.locator("[data-event-edit=description]").dblclick();
  assert.equal(
    await p.getByLabel("Description", { exact: true }).inputValue(),
    "No potluck here.",
  );
  await click(p, "Cancel");
  await click(p, "Edit Event");
  assert.equal(await p.locator(".appearance-categories button").count(), 7);
  await click(p, "Cancel");
  await click(p, "Settings");
  await p.getByText("Table templates", { exact: true }).waitFor();
  assert.ok(
    await p.locator("form[data-form=event]").evaluate((form) => {
      const sections = [
        ...form.querySelectorAll(
          ":scope > .dialog-body > fieldset,:scope > fieldset",
        ),
      ].map((el) => el.querySelector("legend")?.textContent);
      return (
        sections.indexOf("Potluck & drinks") >= 0 &&
        sections.indexOf("Potluck & drinks") < sections.indexOf("Guests")
      );
    }),
    "Potluck and drinks precede the invited-guest selector",
  );

  await p
    .getByLabel("Table template name", { exact: true })
    .fill("Reusable dinner");
  await p
    .getByRole("button", { name: "Save Table Template", exact: true })
    .click();
  await p.getByText("Table template saved.", { exact: true }).waitFor();
  assert.equal(store.list("table-template", host.household).length, 1);
  p.once("dialog", (d) => d.dismiss());
  await p
    .getByRole("button", { name: "Delete Table Template", exact: true })
    .click();
  assert.equal(store.list("table-template", host.household).length, 1);
  p.once("dialog", (d) => d.accept());
  await p.getByRole("button", { name: "Back", exact: true }).click();
  await click(p, "Home");
  await p
    .locator("article.card")
    .filter({
      has: p.getByRole("heading", { name: "Dinner Two", exact: true }),
    })
    .getByRole("button", { name: "Invitation Cards", exact: true })
    .click();
  await p.getByRole("button", { name: "Edit invitation", exact: true }).click();
  await p.locator("#card-preview-canvas > svg").waitFor();
  await click(p, "Close");
  await click(p, "Home");
  await p.getByRole("heading", { name: "Dinner Two", exact: true }).waitFor();
  await click(p, "Home");
  await p
    .locator("article.card")
    .filter({
      has: p.getByRole("heading", { name: "Dinner One", exact: true }),
    })
    .getByRole("button", { name: "View Event", exact: true })
    .click();
  for (const name of [
    "description",
    "date",
    "time",
    "deadline",
    "eventAddress",
  ]) {
    await p.locator(`#main [data-event-edit="${name}"]`).dblclick();
    assert.equal(await p.locator("form[data-form=event]").count(), 1);
    assert.equal(await p.evaluate(() => document.activeElement.name), name);
    await click(p, "Cancel");
  }
  await p.locator('#main [data-menu-item="salad"]').dblclick();
  await p.getByText("Table templates", { exact: true }).waitFor();
  await click(p, "Cancel");
  await click(p, "Edit Event");
  await p.locator('[data-event-edit="uploadURL"]').dblclick();
  assert.equal(
    await p
      .getByLabel("Photo / video upload link (optional)", { exact: true })
      .inputValue(),
    "https://example.test/upload",
  );
  await click(p, "Cancel");
  await p.locator("#main").getByText("When", { exact: true }).dblclick();
  assert.equal(
    await p.locator("#editor[open]").count(),
    0,
    "Host cannot edit shared interface wording",
  );
  await footer(g, ["Home", "Print", "Settings"]);
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
  stage("private address notes and manual host RSVP");
  const notesGuest = store.get("guest", guest.id, host.household);
  const moved = await api(
    owner,
    `/api/host/guests/${guest.id}`,
    {
      ...notesGuest,
      addressDraft: {
        label: "Example home",
        lines: "PO Box 12, Sample City CA 90210",
      },
    },
    "PUT",
    notesGuest.version,
  );
  assert.equal(moved.status, 200);
  await p.reload();
  await click(p, "Contacts");
  await p.locator("main [data-action=address-notes]").click();
  await p
    .getByLabel("Only you can see these notes", { exact: true })
    .fill("Private household detail");
  await p
    .getByRole("dialog")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await p.getByRole("dialog").waitFor({ state: "hidden" });
  await p
    .locator(".household-private-notes small")
    .getByText("Private household detail", { exact: true })
    .waitFor();
  assert.ok(
    await p
      .locator(".household-private-notes small")
      .evaluate(
        (el) =>
          parseFloat(getComputedStyle(el).fontSize) <
          parseFloat(getComputedStyle(el.parentElement).fontSize),
      ),
  );
  await click(p, "Home");
  await p
    .locator("article.card")
    .filter({
      has: p.getByRole("heading", { name: "Dinner Two", exact: true }),
    })
    .getByRole("button", { name: "RSVPs", exact: true })
    .click();
  await p
    .getByRole("dialog")
    .getByText("Private household detail", { exact: true })
    .waitFor();
  await p.getByRole("button", { name: "RSVP", exact: true }).click();
  await p
    .getByRole("heading", { name: "Record guest RSVP", exact: true })
    .waitFor();
  await p.getByLabel("Casey Example", { exact: true }).selectOption("yes");
  await p
    .getByRole("dialog")
    .getByRole("button", { name: "RSVP", exact: true })
    .click();
  await p.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(
    store.list("response", host.household).find((r) => r.event === e2.id)
      .attendance[guest.id],
    "yes",
  );
  stage(
    "event Settings offers Default and Custom, independently from household mode choices",
  );
  await click(p, "Home");
  await p
    .locator("article.card")
    .filter({
      has: p.getByRole("heading", { name: "Dinner One", exact: true }),
    })
    .getByRole("button", { name: "View Event", exact: true })
    .click();
  await click(p, "Settings");
  assert.deepEqual(
    await p.locator(".page-appearance-settings .mode-option").allTextContents(),
    ["Default Mode", "Custom Colors Mode", "Layout"],
  );
  assert.equal(await p.locator(".inline-household-details").count(), 0);
  const eventSettings = p.locator(".inline-event-details");
  await eventSettings.getByLabel("Event title", { exact: true }).waitFor();
  assert.equal(
    await eventSettings.getByLabel("Event title", { exact: true }).inputValue(),
    "Dinner One",
  );
  await eventSettings
    .getByLabel("Description", { exact: true })
    .fill("Inline event Settings description");
  await p
    .locator("#top-navigation")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await p.getByText("Event saved.", { exact: true }).waitFor();
  await p.waitForFunction(
    () =>
      document.querySelector(".inline-event-details")?.dataset.saving !==
      "true",
  );
  assert.equal(
    (await api(owner, "/api/host")).body.events.find((e) => e.id === e1.id)
      .description,
    "Inline event Settings description",
  );

  const layoutBefore = store.get("event", e1.id, host.household);
  await click(p, "Layout");
  const layoutEditor = p.locator(".event-layout-editor");
  await layoutEditor.waitFor();
  const informationOptions = layoutEditor.getByRole("radiogroup", {
    name: "Event information layout",
    exact: true,
  });
  const containerOptions = layoutEditor.getByRole("radiogroup", {
    name: "Event container layout",
    exact: true,
  });
  assert.equal(await informationOptions.getByRole("radio").count(), 2);
  assert.equal(await containerOptions.getByRole("radio").count(), 2);
  await informationOptions
    .getByRole("radio", { name: /Invitation style/ })
    .click();
  await containerOptions.getByRole("radio", { name: /One container/ }).click();
  await layoutEditor
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  assert.deepEqual(store.get("event", e1.id, host.household), layoutBefore);
  await click(p, "Layout");
  await informationOptions
    .getByRole("radio", { name: /Invitation style/ })
    .click();
  await containerOptions.getByRole("radio", { name: /One container/ }).click();
  await layoutEditor
    .getByRole("button", { name: "Save Layout", exact: true })
    .click();
  await p.getByText("Layout saved.", { exact: true }).waitFor();
  await p.getByRole("button", { name: "Back", exact: true }).click();
  await p.locator("[data-event-shell] .event-information-invitation").waitFor();
  assert.equal(
    await p.locator("[data-event-shell] > [data-event-section]").count(),
    2,
  );
  assert.equal(await p.locator("#main > [data-event-section]").count(), 0);
  assert.equal(
    await p
      .locator(".invitation-address")
      .evaluate((el) => getComputedStyle(el).fontStyle),
    "italic",
  );
  assert.match(
    await p
      .locator(".invitation-time")
      .evaluate((el) => getComputedStyle(el).fontFamily),
    /Georgia/,
  );
  assert.equal(
    await p
      .locator(".invitation-date")
      .evaluate((el) => getComputedStyle(el).textTransform),
    "uppercase",
  );
  assert.match(
    await p.locator(".invitation-rsvp").innerText(),
    /Kindly RSVP by Jun\. 1/,
  );
  for (const width of [390, 1440]) {
    await p.setViewportSize({ width, height: 900 });
    assert.ok(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await p.screenshot({
      path: `test-results/event-layout-${width}.png`,
      fullPage: true,
    });
  }
  const hostInformation = await p
    .locator(".event-information-invitation")
    .innerHTML();
  const currentLayoutGuest = (await api(owner, "/api/host")).body.guests.find(
    (g) => g.id === guest.id,
  );
  const layoutGuestCookie = (
    await api(null, "/api/sign-in", {
      account: "navigation.casey",
      secret: currentLayoutGuest.inviteCode,
    })
  ).cookie;
  const layoutGuest = await page(layoutGuestCookie);
  await layoutGuest
    .locator("article.card")
    .filter({
      has: layoutGuest.getByRole("heading", {
        name: "Dinner One",
        exact: true,
      }),
    })
    .getByRole("button", { name: "View Event", exact: true })
    .click();
  await layoutGuest
    .locator("[data-event-shell] .event-information-invitation")
    .waitFor();
  assert.equal(
    await layoutGuest.locator(".event-information-invitation").innerHTML(),
    hostInformation,
  );
  assert.equal(
    await layoutGuest.locator('[data-action="event-layout-open"]').count(),
    0,
  );
  await click(p, "Settings");
  await click(p, "Layout");
  await informationOptions.getByRole("radio", { name: /^Default/ }).click();
  await containerOptions
    .getByRole("radio", { name: /Separate containers/ })
    .click();
  await layoutEditor
    .getByRole("button", { name: "Save Layout", exact: true })
    .click();
  await p.waitForFunction(
    () => !document.querySelector(".event-layout-editor"),
  );

  assert.ok(
    await p
      .locator(".page-appearance-settings .mode-option")
      .evaluateAll((els) => {
        const styles = (el) => {
          const s = getComputedStyle(el);
          return [
            s.fontFamily,
            s.fontSize,
            s.fontWeight,
            s.fontStyle,
            s.color,
          ].join("|");
        };
        const standard = document.querySelector(
          ".browse-row .browse-open:not(.mode-option)",
        );
        return (
          !!standard &&
          els.every(
            (el) =>
              styles(el) === styles(standard) &&
              !el.querySelector("svg") &&
              !!el.closest(".browse-row").querySelector(".browse-row-icon svg"),
          )
        );
      }),
  );
  await option(p, "Default Mode");
  const defaultView = (await api(owner, "/api/host")).body;
  assert.deepEqual(
    defaultView.events.find((e) => e.id === e1.id).ui.design,
    defaultView.ui.design,
  );
  await option(p, "Custom Colors Mode");
  await p.getByLabel("Appearance categories", { exact: true }).waitFor();
  await p
    .getByLabel("Appearance categories", { exact: true })
    .getByRole("button", { name: "Text", exact: true })
    .click();
  await p
    .getByLabel("Appearance actions", { exact: true })
    .getByRole("button", { name: "Font", exact: true })
    .click();
  await p.getByLabel("Text font", { exact: true }).selectOption("Verdana");
  await p.waitForFunction(() =>
    [...document.querySelectorAll(".event-summary .totals span")].every(
      (el) => el.scrollWidth <= el.clientWidth + 1,
    ),
  );

  await click(p, "Cancel");
  stage(
    "optional Information, selected-text formatting, email links and empty sections",
  );
  await click(p, "Settings");
  const richField = p.locator("[data-information-editor]"),
    richInput = richField.getByRole("textbox", {
      name: "Information text",
      exact: true,
    });
  await richInput.fill("Bring a jacket. Email the host");
  async function selectInformation(text) {
    await richInput.evaluate((el, text) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode,
          start = node.textContent.indexOf(text);
        if (start < 0) continue;
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + text.length);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        return;
      }
      throw Error("Selection text is missing");
    }, text);
  }
  for (const label of ["Bold", "Italic", "Underline"]) {
    await selectInformation("Bring a jacket.");
    await richField.getByRole("button", { name: label, exact: true }).click();
  }
  await selectInformation("Email the host");
  await richField
    .getByRole("button", { name: "Add link", exact: true })
    .click();
  await richField
    .getByLabel("Link URL or email", { exact: true })
    .fill("javascript:alert(1)");
  await richField
    .getByRole("button", { name: "Apply link", exact: true })
    .click();
  await richField
    .getByText("Enter a valid website URL or email address.", { exact: true })
    .waitFor();
  await richField
    .getByLabel("Link URL or email", { exact: true })
    .fill("host@example.test");
  await richField
    .getByRole("button", { name: "Apply link", exact: true })
    .click();
  await p
    .locator("#top-navigation")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await p.getByText("Event saved.", { exact: true }).waitFor();
  await p.waitForFunction(
    () =>
      document.querySelector(".inline-event-details")?.dataset.saving !==
      "true",
  );
  await p.getByRole("button", { name: "Back", exact: true }).click();
  const extra = p.locator('[data-event-section="additional-information"]');
  await extra.waitFor();
  assert.equal(await extra.locator("strong").innerText(), "Bring a jacket.");
  assert.equal(
    await extra
      .getByRole("link", { name: "Email the host" })
      .getAttribute("href"),
    "mailto:host@example.test",
  );
  assert.equal(
    await extra.evaluate((el) => el.nextElementSibling?.dataset.eventSection),
    "menus",
  );
  const beforeInformation = await extra.innerHTML();
  await layoutGuest.reload();
  await layoutGuest
    .locator("article.card")
    .filter({
      has: layoutGuest.getByRole("heading", {
        name: "Dinner One",
        exact: true,
      }),
    })
    .getByRole("button", { name: "View Event", exact: true })
    .click();
  await layoutGuest
    .locator('[data-event-section="additional-information"]')
    .waitFor();
  assert.equal(
    await layoutGuest
      .locator('[data-event-section="additional-information"]')
      .innerHTML(),
    beforeInformation,
  );
  await extra.locator("strong").dblclick();
  await p
    .getByRole("dialog")
    .getByRole("textbox", { name: "Information text", exact: true })
    .waitFor();
  await click(p, "Cancel");
  await click(p, "Settings");
  await richInput.fill(" ");
  await p
    .locator("#top-navigation")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await p.getByText("Event saved.", { exact: true }).waitFor();
  await p.waitForFunction(
    () =>
      document.querySelector(".inline-event-details")?.dataset.saving !==
      "true",
  );
  await p.getByRole("button", { name: "Back", exact: true }).click();
  await p.locator(".event-hero").waitFor();
  assert.equal(await extra.count(), 0);
  assert.equal(await p.locator('[data-event-section="menus"]').count(), 1);
  stage(
    "Back follows visited pages, including Contacts and cross-section workspace navigation",
  );
  await click(p, "Contacts");
  await p.getByRole("button", { name: "Back", exact: true }).click();
  await p.locator("[data-home-card=contacts]").waitFor();
  await click(p, "Family Workspace");
  await p.getByRole("button", { name: "Lists", exact: true }).click();
  await p.getByRole("button", { name: "Shared folder", exact: true }).click();
  await p.getByRole("button", { name: "Groceries", exact: true }).click();
  await p.getByRole("button", { name: "Back", exact: true }).click();
  await p
    .getByRole("heading", { name: "Shared folder", exact: true })
    .waitFor();
  await p.getByRole("button", { name: "Back", exact: true }).click();
  await p.getByRole("heading", { name: "Lists", exact: true }).waitFor();
  await click(p, "Home");
  await click(p, "Family Workspace");
  await p.getByRole("button", { name: "Tasks", exact: true }).click();
  await p.getByRole("button", { name: "Homework", exact: true }).click();
  await p
    .getByRole("button", { name: "View linked home record", exact: true })
    .click();
  await p
    .getByRole("heading", { name: "Private appliance", exact: true })
    .waitFor();
  await p.getByRole("button", { name: "Back", exact: true }).click();
  await p.getByRole("heading", { name: "Homework", exact: true }).waitFor();
  await click(p, "Settings");
  await p.getByRole("heading", { name: "Settings", exact: true }).waitFor();
  await p.getByRole("button", { name: "Back", exact: true }).click();
  await p.getByRole("heading", { name: "Homework", exact: true }).waitFor();
  stage(
    "household page modes share one scope and preserve custom event appearance",
  );
  const customEvent = store.get("event", e1.id, host.household);
  assert.equal(
    (
      await api(
        owner,
        "/api/host/events/" + e1.id,
        { ...customEvent, appearanceMode: "custom" },
        "PUT",
        customEvent.version,
      )
    ).status,
    200,
  );
  const eventThemes = (await api(owner, "/api/host")).body.events.map((e) => [
    e.id,
    e.ui.design,
  ]);
  await click(p, "Home");
  const offered = async () => {
    assert.equal(
      await p
        .locator(
          '#top-navigation .browse-menu:has(summary[aria-label="Sorting and options"])',
        )
        .count(),
      0,
      "Pages with no unique options omit the three-dot menu",
    );
    assert.equal(await p.locator("#top-navigation .mode-option").count(), 0);
    await p.locator('.toolbar [data-action="share-details"]').waitFor();
    assert.equal(await p.locator('.toolbar [data-action="share"]').count(), 0);
    assert.equal(
      await p.locator('.toolbar [data-action="share-details"]').innerText(),
      "Share Invitation",
    );
    await p.locator('.toolbar [data-action="settings"]').waitFor();
    await click(p, "Settings");
    assert.deepEqual(
      await p
        .locator(".page-appearance-settings .mode-option")
        .allTextContents(),
      ["Light Mode", "Dark Mode", "Custom Colors Mode"],
    );
    assert.equal(
      await p
        .locator(".page-appearance-settings.panel,.settings-details.panel")
        .count(),
      0,
    );
    const modeRow = p.locator(".page-appearance-settings");
    assert.equal(await modeRow.locator("button svg").count(), 0);
    assert.equal(await modeRow.locator(".browse-row-icon svg").count(), 3);
    assert.equal(
      await modeRow.evaluate(
        (el) =>
          el.previousElementSibling.querySelector(
            "[data-action=family-members]",
          ) !== null,
      ),
      true,
    );
    const originalWidth = p.viewportSize().width;
    for (const width of [390, 1440]) {
      await p.setViewportSize({ width, height: 900 });
      assert.equal(
        await modeRow
          .locator(".settings-mode-row")
          .evaluate(
            (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
          ),
        3,
      );
      assert.ok(
        await modeRow.evaluate((el) => el.scrollWidth <= el.clientWidth),
      );
      await p.screenshot({
        path: `test-results/settings-mode-row-${width}.png`,
        fullPage: true,
      });
    }
    await p.setViewportSize({ width: originalWidth, height: 900 });
    assert.ok(
      await p
        .locator(".inline-household-details")
        .evaluate(
          (form) =>
            form.getBoundingClientRect().bottom <
            document
              .querySelector('[data-action="logout"]')
              .getBoundingClientRect().top,
        ),
    );
    await p.getByRole("button", { name: "Back", exact: true }).click();
  };
  await offered();
  await click(p, "Settings");
  const nameField = p.getByLabel("Family household name", { exact: true });
  const savedName = await nameField.inputValue();
  assert.equal(await nameField.getAttribute("readonly"), "");
  const detailsName = p.getByLabel("Household IANA timezone", { exact: true });
  await detailsName.fill("America/New_York");
  const unchangedDetailsVersion = await p
    .locator(".inline-household-details")
    .getAttribute("data-version");
  const remoteHousehold = store.get(
    "household",
    host.household,
    host.household,
  );
  store.put(
    "household",
    host.household,
    host.household,
    { ...remoteHousehold, timezone: "America/Los_Angeles" },
    remoteHousehold.version,
  );
  await p.waitForTimeout(3500);
  assert.equal(await detailsName.inputValue(), "America/New_York");
  assert.equal(
    await p.locator(".inline-household-details").getAttribute("data-version"),
    unchangedDetailsVersion,
  );
  const dismissedDetails = new Promise((resolve) =>
    p.once("dialog", async (d) => {
      await d.dismiss();
      resolve();
    }),
  );
  await p.locator(".toolbar [data-action=home]").click();
  await dismissedDetails;
  assert.equal(await detailsName.inputValue(), "America/New_York");
  const discardedDetails = new Promise((resolve) =>
    p.once("dialog", async (d) => {
      await d.accept();
      resolve();
    }),
  );
  await p.getByRole("button", { name: "Back", exact: true }).click();
  await discardedDetails;
  await p.locator(".hero h1").waitFor();
  await p.waitForTimeout(3500);
  await click(p, "Settings");
  await p
    .locator("#top-navigation")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await p.getByText("Details saved.", { exact: true }).waitFor();
  assert.equal((await api(owner, "/api/host")).body.household.name, savedName);
  await p.getByRole("button", { name: "Back", exact: true }).click();
  await option(p, "Dark Mode");
  await p.waitForFunction(
    () => getComputedStyle(document.body).backgroundColor === "rgb(21, 23, 25)",
  );
  await click(p, "Contacts");
  await offered();
  await option(p, "Light Mode");
  await p.waitForFunction(
    () => getComputedStyle(document.body).backgroundColor !== "rgb(21, 23, 25)",
  );
  await option(p, "Custom Colors Mode");
  await p.getByLabel("Appearance categories", { exact: true }).waitFor();
  await click(p, "Cancel");
  await click(p, "Family Workspace");
  await offered();
  await click(p, "Settings");
  assert.equal(
    await p.locator(".page-appearance-settings .mode-option").count(),
    3,
  );
  await p.getByRole("button", { name: "Back", exact: true }).click();
  await click(p, "Home");
  await p
    .getByRole("button", { name: "Open Cards & Invites", exact: true })
    .click();
  await p
    .getByRole("button", { name: "Create card / template", exact: true })
    .click();
  await p.locator("#card-editor-form").waitFor();
  await offered();
  if (await p.getByRole("button", { name: "Tools", exact: true }).count())
    await click(p, "Tools");
  await p
    .getByRole("toolbar", { name: "Card categories", exact: true })
    .getByRole("button", { name: "Card", exact: true })
    .click();
  await p
    .getByRole("toolbar", { name: "Card actions", exact: true })
    .getByRole("button", { name: "Name", exact: true })
    .click();
  await p.getByLabel("Card name", { exact: true }).fill("Unsaved card draft");
  await option(p, "Dark Mode");
  assert.equal(
    await p.getByLabel("Card name", { exact: true }).inputValue(),
    "Unsaved card draft",
  );
  p.once("dialog", (d) => d.accept());
  await click(p, "Close");
  const themedEvents = (await api(owner, "/api/host")).body.events;
  assert.deepEqual(
    themedEvents.find((e) => e.id === e1.id).ui.design,
    eventThemes.find(([id]) => id === e1.id)[1],
  );
  assert.equal(
    themedEvents.find((e) => e.id === e2.id).ui.design.background,
    "#151719",
  );
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

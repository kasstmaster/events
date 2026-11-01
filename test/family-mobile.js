// Synthetic loopback-only families and guest codes. No real accounts, messages or documents.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { Store } from "../server/node-store.js";
import { createApp } from "../server/app.js";
let phase = "startup";
const stage = (name) => {
  phase = name;
  console.log("Family browser check: " + name);
};
const watchdog = setTimeout(() => {
  console.error("Family browser check exceeded 150 seconds during " + phase);
  process.exit(1);
}, 150000);
watchdog.unref();
const store = new Store(),
  origin = "http://127.0.0.1:3167",
  password = "Synthetic-family-browser-passphrase";
await store.createAdmin("admin@example.test", password);
store.run("INSERT INTO approvals VALUES(?,?)", "owner@example.test", "test");
const host = await store.register({
  name: "Alpha",
  email: "owner@example.test",
  password,
});
const server = createApp({
  store,
  origin,
  env: {
    recipeTransport: async () =>
      new Response(
        '<script type="application/ld+json">' +
          JSON.stringify({
            "@type": "Recipe",
            name: "Imported soup",
            recipeIngredient: ["Water", "Vegetables"],
            recipeInstructions: [{ text: "Simmer gently." }],
          }) +
          "</script>",
        { headers: { "content-type": "text/html" } },
      ),
  },
});
server.listen(3167, "127.0.0.1");
await once(server, "listening");
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ||
    (existsSync("/usr/bin/chromium")
      ? "/usr/bin/chromium"
      : chromium.executablePath()),
  args: ["--no-sandbox"],
});
const errors = [],
  external = [];
async function device(width = 390) {
  const context = await browser.newContext({
    viewport: { width, height: 950 },
    isMobile: width < 600,
    hasTouch: width < 600,
    acceptDownloads: true,
  });
  await context.route("**/*", (route) => {
    if (
      !route
        .request()
        .url()
        .startsWith(origin + "/")
    ) {
      external.push("blocked");
      return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (e) => errors.push(e.message));
  return { context, page };
}
const dialog = (page) => page.getByRole("dialog");
async function click(page, name) {
  const scope = (await page.locator("#editor[open]").count())
    ? dialog(page)
    : name === "RSVP"
      ? page.locator("#main")
      : page;
  await scope.getByRole("button", { name, exact: true }).click();
}
async function save(page) {
  await click(page, "Save");
  await dialog(page).waitFor({ state: "hidden" });
}
const api = async (cookie, path, data, method = "POST", version) => {
  const r = await fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      Cookie: cookie,
      ...(version !== undefined ? { "If-Match": String(version) } : {}),
    },
    body: JSON.stringify(data),
  });
  const body = await r.json();
  assert.ok(r.ok, body.error);
  return body;
};
try {
  await mkdir("test-results", { recursive: true });
  stage("owner workspace and individual family accounts");
  const owner = await device(1440);
  await owner.page.goto(origin);
  await owner.page
    .getByLabel("Email address", { exact: true })
    .fill("owner@example.test");
  await owner.page.getByLabel("Password", { exact: true }).fill(password);
  await click(owner.page, "Sign in");
  await click(owner.page, "Family workspace");
  await owner.page
    .getByRole("heading", { name: "Your household tools", exact: true })
    .waitFor();
  assert.equal(store.list("family-record", host.household).length, 0);
  await click(owner.page, "Family members");
  await click(owner.page, "Create family member");
  await owner.page.getByLabel("Name", { exact: true }).fill("Child");
  await owner.page
    .getByLabel("Sign-in name · no email required", { exact: true })
    .fill("child");
  await owner.page
    .getByLabel("Household role", { exact: true })
    .selectOption("kid");
  await owner.page
    .getByLabel("Password · at least 12 characters", { exact: true })
    .fill(password);
  await save(owner.page);
  const child = store.one(
    "SELECT id FROM family_members WHERE household=? AND login='child'",
    host.household,
  );
  stage("shared lists, child access and independent device updates");
  await click(owner.page, "Create list");
  await owner.page.getByLabel("Title", { exact: true }).fill("Groceries");
  await owner.page
    .getByLabel("Categories · one per line, in manual order", { exact: true })
    .fill("Produce\nOther");
  await owner.page.getByLabel("Child", { exact: true }).check();
  await save(owner.page);
  await owner.page.getByLabel("New item", { exact: true }).fill("Apples");
  await owner.page
    .getByLabel("Category", { exact: true })
    .selectOption("Produce");
  await click(owner.page, "Add item");
  await owner.page
    .locator(".family-item-title")
    .getByText("Apples", { exact: true })
    .waitFor();
  const household = store.household(host.household),
    kid = await device();
  await kid.page.goto(origin + "/h/" + household.slug);
  await click(kid.page, "Family member sign-in");
  await kid.page.getByLabel("Sign-in name", { exact: true }).fill("child");
  await kid.page.getByLabel("Password", { exact: true }).fill(password);
  await click(kid.page, "Sign in");
  await click(kid.page, "Open");
  assert.equal(
    await kid.page.getByRole("button", { name: "Delete", exact: true }).count(),
    0,
  );
  await kid.page.getByLabel("New item", { exact: true }).fill("Bread");
  await click(kid.page, "Add item");
  await owner.page
    .locator(".family-item-title")
    .getByText("Bread", { exact: true })
    .waitFor();
  await kid.page
    .locator(".family-item-title")
    .getByText("Bread", { exact: true })
    .dblclick();
  await owner.page.getByLabel("Complete Bread", { exact: true }).waitFor();
  await owner.page.waitForFunction(
    () => document.querySelector('[aria-label="Complete Bread"]').checked,
  );
  assert.equal(
    store.list("family-item", host.household).find((i) => i.title === "Bread")
      .version,
    2,
  );
  await click(kid.page, "Hide Completed");
  await kid.page
    .getByRole("button", { name: "Show All", exact: true })
    .waitFor();
  assert.equal(
    await kid.page
      .locator(".family-item-title")
      .getByText("Bread", { exact: true })
      .count(),
    0,
  );
  await click(kid.page, "Show All");
  await kid.page
    .locator(".family-item-title")
    .getByText("Bread", { exact: true })
    .waitFor();
  await click(owner.page, "Sort alphabetically within categories");
  await owner.page
    .getByRole("button", { name: "Return to manual ordering", exact: true })
    .waitFor();
  assert.equal(
    await owner.page
      .getByRole("button", { name: "Move up", exact: true })
      .count(),
    0,
  );
  await click(owner.page, "Return to manual ordering");
  await owner.page.screenshot({
    path: "test-results/family-lists-desktop.png",
    fullPage: true,
  });
  await kid.page.screenshot({
    path: "test-results/family-lists-phone.png",
    fullPage: true,
  });
  stage("failed saves preserve drafts and reconnect safely");
  await kid.context.route("**/api/family/items", (route) =>
    route.abort("failed"),
  );
  await kid.page.getByLabel("New item", { exact: true }).fill("Reconnect item");
  await click(kid.page, "Add item");
  await kid.page.locator(".form-error").filter({ hasText: /./ }).waitFor();
  assert.equal(
    await kid.page.getByLabel("New item", { exact: true }).inputValue(),
    "Reconnect item",
  );
  assert.equal(
    store
      .list("family-item", host.household)
      .some((i) => i.title === "Reconnect item"),
    false,
  );
  await kid.context.unroute("**/api/family/items");
  await click(kid.page, "Add item");
  await kid.page
    .locator(".family-item-title")
    .getByText("Reconnect item", { exact: true })
    .waitFor();
  await owner.page
    .locator(".family-item-title")
    .getByText("Reconnect item", { exact: true })
    .waitFor();
  await kid.context.route("**/api/setup", (route) => route.abort("failed"));
  await kid.page
    .locator("#sync-status")
    .filter({ hasText: "Connection paused" })
    .waitFor();
  await kid.context.unroute("**/api/setup");
  await kid.page.evaluate(() => window.dispatchEvent(new Event("online")));
  await kid.page.waitForFunction(
    () =>
      !document
        .querySelector("#sync-status")
        .textContent.includes("Connection paused"),
  );
  stage("reviewed recipe import and private home documents");
  await click(owner.page, "All household tools");
  await click(owner.page, "Import recipe URL");
  await owner.page
    .getByLabel("Public recipe URL", { exact: true })
    .fill("https://recipes.example.com/soup");
  await click(owner.page, "Save");
  await owner.page.getByLabel("Ingredients", { exact: true }).waitFor();
  assert.equal(
    await owner.page.getByLabel("Ingredients", { exact: true }).inputValue(),
    "Water\nVegetables",
  );
  await owner.page.getByLabel("Title", { exact: true }).fill("Our soup");
  await owner.page
    .getByLabel("Categories · one per line", { exact: true })
    .fill("Dinner");
  await save(owner.page);
  await click(owner.page, "All household tools");
  await click(owner.page, "Create home record");
  await owner.page.getByLabel("Title", { exact: true }).fill("Private washer");
  await owner.page
    .getByLabel("Model number", { exact: true })
    .fill("Synthetic model");
  await owner.page
    .getByLabel("Notes", { exact: true })
    .fill("Owner warranty notes");
  await save(owner.page);
  await click(owner.page, "Manage documents");
  await owner.page.getByLabel("Document", { exact: true }).setInputFiles({
    name: "manual.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Synthetic private manual"),
  });
  await click(owner.page, "Upload document");
  await dialog(owner.page).getByText("manual.txt", { exact: false }).waitFor();
  const download = owner.page.waitForEvent("download");
  await dialog(owner.page)
    .getByRole("link", { name: "Download", exact: true })
    .click();
  assert.equal((await download).suggestedFilename(), "manual.txt");
  await click(owner.page, "Close editor");
  stage("assigned chore access without linked private record access");
  await click(owner.page, "Create linked maintenance chore");
  await owner.page.getByLabel("Title", { exact: true }).fill("Check washer");
  await owner.page
    .getByRole("group", { name: "Assigned family members", exact: true })
    .getByLabel("Child", { exact: true })
    .check();
  await owner.page
    .getByLabel("First due date / time · optional", { exact: true })
    .fill("2026-11-01T10:00");
  await owner.page
    .getByLabel("IANA timezone", { exact: true })
    .fill("America/Los_Angeles");
  await owner.page.getByLabel("Repeat", { exact: true }).selectOption("daily");
  await save(owner.page);
  await click(kid.page, "All household tools");
  await kid.page
    .getByRole("heading", { name: "Check washer", exact: true })
    .first()
    .waitFor();
  assert.equal(
    await kid.page
      .getByRole("heading", { name: "Private washer", exact: true })
      .count(),
    0,
  );
  await click(kid.page, "My Tasks");
  await kid.page
    .getByRole("checkbox", { name: "Complete this occurrence", exact: true })
    .first()
    .check();
  await kid.page.screenshot({
    path: "test-results/family-tasks-phone.png",
    fullPage: true,
  });
  stage(
    "guest invite code, suffix recognition, custom RSVP and separate images",
  );
  await click(owner.page, "Home");
  const cookie = (await owner.context.cookies())
    .map((c) => c.name + "=" + c.value)
    .join(";");
  const adult = await api(cookie, "/api/host/guests", {
    first: "Casey",
    last: "Example",
    suffix: "Jr.",
  });
  const childGuest = await api(cookie, "/api/host/guests", {
    first: "Robin",
    last: "Example",
    parent: adult.id,
  });
  const artwork =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
  const logo =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXxkAAAAASUVORK5CYII=";
  const current = store.household(host.household);
  await api(
    cookie,
    "/api/host/household",
    { ...current, logo },
    "PUT",
    current.version,
  );
  const event = await api(cookie, "/api/host/events", {
    title: "Shared supper",
    invited: [adult.id, childGuest.id],
    menu: [{ id: "juice", name: "Juice", kind: "drink", quantity: 2 }],
    customItemsEnabled: true,
    saveCustomItems: true,
    deadline: "2089-11-06",
    icon: artwork,
  });
  await api(cookie, "/api/host/events", {
    title: "Closed supper",
    invited: [adult.id],
    menu: [],
    deadline: "2000-01-01",
  });
  await click(owner.page, "Address book");
  await click(owner.page, "＋ Add adult or child");
  await owner.page.getByLabel("First name", { exact: true }).fill("Casey");
  await owner.page.getByLabel("Last name", { exact: true }).fill("Example");
  await owner.page.getByLabel("Suffix (optional)", { exact: true }).fill("Jr.");
  await owner.page
    .getByRole("button", { name: "Create Separate Guest", exact: true })
    .waitFor();
  await click(owner.page, "Create Separate Guest");
  await save(owner.page);
  const guest = await device();
  await guest.page.goto(origin + "/h/" + household.slug);
  assert.equal(
    await guest.page
      .getByLabel("Suffix, if applicable", { exact: true })
      .isVisible(),
    false,
  );
  await guest.page.getByLabel("First name", { exact: true }).fill("Casey");
  await guest.page.getByLabel("Last name", { exact: true }).fill("Example");
  await guest.page
    .getByLabel("Invite Code", { exact: true })
    .fill(adult.inviteCode);
  await guest.page
    .getByLabel("Suffix, if applicable", { exact: true })
    .waitFor();
  await guest.page
    .getByLabel("Suffix, if applicable", { exact: true })
    .fill("Jr.");
  await click(guest.page, "See my invitations");
  const card = guest.page.locator("article.card").filter({
    has: guest.page.getByRole("heading", {
      name: "Shared supper",
      exact: true,
    }),
  });
  assert.equal(await card.locator("img").getAttribute("src"), logo);
  await card.getByRole("button", { name: "View event", exact: true }).click();
  assert.equal(
    await guest.page
      .getByRole("heading", { name: "At the table", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await guest.page.locator(".event-icon").getAttribute("src"),
    artwork,
  );
  await click(guest.page, "RSVP");
  assert.equal(
    await dialog(guest.page)
      .getByText("Children attend with their designated adult.", {
        exact: false,
      })
      .count(),
    0,
  );
  await guest.page
    .getByLabel("Casey Example Jr.", { exact: true })
    .selectOption("yes");
  await guest.page
    .getByLabel("Robin Example · child", { exact: true })
    .selectOption("yes");
  await guest.page
    .getByLabel("Custom items · one per line", { exact: true })
    .fill("Homemade bread");
  await click(guest.page, "RSVP");
  await dialog(guest.page).waitFor({ state: "hidden" });
  assert.equal(
    store.list("menu-saved", host.household)[0].name,
    "Homemade bread",
  );
  await click(guest.page, "Home");
  await guest.page
    .locator("article.card")
    .filter({
      has: guest.page.getByRole("heading", {
        name: "Closed supper",
        exact: true,
      }),
    })
    .getByRole("button", { name: "View event", exact: true })
    .click();
  await click(guest.page, "RSVP");
  await guest.page
    .getByText("The RSVP deadline has passed. Responses are closed.", {
      exact: true,
    })
    .waitFor();
  assert.equal(await dialog(guest.page).isVisible(), false);
  for (const p of [owner.page, kid.page, guest.page])
    assert.ok(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(
    "PASS: family accounts, scoped children, live list collaboration, safe completion gestures, sorting, recipe review, authenticated files, chore assignments, guest codes/suffixes, images, custom items and deadline lock.",
  );
} catch (error) {
  console.error("Family browser check failed during " + phase, error);
  throw error;
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  store.db.close();
  clearTimeout(watchdog);
}

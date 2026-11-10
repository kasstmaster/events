import { setAppearance, saveAppearance } from "./helpers/appearance.js";
import { clickNavigation } from "./helpers/navigation.js";
// Isolated synthetic records, no production or messaging requests.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { Store } from "../server/node-store.js";
import { createApp } from "../server/app.js";
let phase = "startup";
const stage = (name) => {
  phase = name;
  console.log(`Shared editor browser check: ${name}`);
};
// Locator deadlines do not cover a blocked native dialog or browser shutdown.
// Fail the process with its current stage before CI's whole-job deadline.
const watchdog = setTimeout(() => {
  console.error(
    `Shared editor browser check exceeded 150 seconds during: ${phase}`,
  );
  process.exit(1);
}, 150000);
watchdog.unref();
const store = new Store(),
  password = "Synthetic-editor-password",
  origin = "http://127.0.0.1:3159";
await store.createAdmin("admin@example.test", password);
store.run(
  "INSERT INTO approvals VALUES(?,?)",
  "host@example.test",
  "synthetic",
);
const host = await store.register({
  email: "host@example.test",
  password,
  name: "Alpha",
});
const server = createApp({ store, origin });
server.listen(3159, "127.0.0.1");
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
async function device(width) {
  const context = await browser.newContext({
    viewport: { width, height: 950 },
    isMobile: width < 600,
    hasTouch: width < 600,
    acceptDownloads: true,
  });
  // Playwright runs this in every new frame, including the print iframe.
  // Test our print document/call, not the platform's native print dialog.
  await context.addInitScript(() => {
    window.__printCalls = 0;
    window.print = () => {
      window.__printCalls++;
    };
  });
  await context.route("**/*", (route) => {
    if (
      !route
        .request()
        .url()
        .startsWith(origin + "/")
    ) {
      external.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    errors.push(error.message);
    console.error("Page error:", error.message);
  });
  page.setDefaultTimeout(10000);
  return { context, page };
}
const click = clickNavigation;
const dialog = (page) => page.locator("#editor[open], form[data-form=guest]");
async function login(page, email) {
  await page.goto(origin);
  await page.getByLabel("Name, email or username", { exact: true }).fill(email);
  await page
    .getByLabel("Password or Household ID", { exact: true })
    .fill(password);
  await click(page, "Sign in");
}
try {
  await mkdir("test-results", { recursive: true });
  stage("administrator defaults and layout");
  const admin = await device(1440);
  await login(admin.page, "admin@example.test");
  assert.equal(
    await admin.page.locator("[data-action=scoped-editor]").count(),
    0,
  );
  await click(admin.page, "Edit global defaults");
  assert.equal(
    await admin.page.locator("#visual-inspector:visible").count(),
    0,
  );
  const example = admin.page.frameLocator("#page-example-frame");
  await example.locator("h1").dblclick();
  await setAppearance(admin.page, "Titles", "Color", "Titles color", "#334455");
  const aboveTitle = example.locator(
    "[data-layout=introText] > [data-layout-item=eyebrow]",
  );
  await aboveTitle.dblclick();
  await aboveTitle.press("Escape");
  stage("dragging the shared introduction");
  await click(admin.page, "Move down");
  stage("capturing the default introduction");
  await admin.page.screenshot({
    path: "test-results/features-visual-defaults.png",
    fullPage: true,
  });
  await admin.page
    .getByLabel("Example page", { exact: true })
    .selectOption("event");
  await example.getByText("Where", { exact: true }).waitFor();
  await example.getByText("123 Example Lane", { exact: false }).waitFor();
  const eventMetaStructure = await example
    .locator(".event-meta")
    .evaluate((el) =>
      el.outerHTML.replace(/ data-[^= ]+="[^"]*"| tabindex="[^"]*"/g, ""),
    );
  assert.ok(eventMetaStructure.includes("Where"));
  assert.equal(await example.locator("[data-action=rsvp]").count(), 1);
  await example
    .locator('.toolbar [data-action="settings"]')
    .waitFor({ state: "attached" });
  // Actual page components, scoped controls and all conditional sample sections.
  const requests = [];
  const observe = (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/"))
      requests.push(request.method() + " " + new URL(request.url()).pathname);
  };
  admin.page.on("request", observe);
  const views = [
    "personalFamily",
    "personalAccount",
    "personalSetup",
    "personalContacts",
    "guestHome",
    "guestEvent",
    "guestEventUnanswered",
    "login",
    "guestLoginSuffix",
    "hostLogin",
    "registration",
    "familyLogin",
    "familyHome",
    "familyKidHome",
    "familyList",
    "familyKidList",
    "familyRecord",
    "familyChore",
    "familyTasks",
    "familyKidTasks",
    "admin",
    "adminApprovals",
    "adminHosts",
    "adminSettings",
    "hostSettings",
    "guestSettings",
    "familySettings",
    "eventInformation",
    "eventInvitation",
    "eventSingleContainer",
    "eventSettings",
    "eventButtons",
    "toolbar",
    "homeButtons",
    "introText",
  ];
  for (const view of views) {
    stage("default example: " + view);
    await admin.page
      .getByLabel("Example page", { exact: true })
      .selectOption(view);
    await example.locator("main").waitFor();
    if (view === "personalFamily") {
      await example
        .getByLabel("Who receives updates", { exact: true })
        .waitFor();
      assert.equal(
        await example
          .locator('[data-layout="personalFamily"] > [data-layout-item]')
          .count(),
        4,
      );
    }
    if (view === "personalSetup")
      await example.getByLabel("Username", { exact: true }).waitFor();
    if (view === "personalContacts")
      await example
        .getByRole("button", { name: "Block", exact: true })
        .waitFor();
    if (view.startsWith("guestEvent")) {
      await example.getByText("Where", { exact: true }).waitFor();
      assert.equal(
        await example.locator("[data-event-section=menus]").count(),
        1,
      );
      assert.equal(
        await example.locator("[data-action=event-details]").count(),
        0,
      );
      await example.locator(".rsvp-stack .registry-buttons").waitFor();
      await example
        .getByRole("link", { name: "Upload Photos & Videos", exact: true })
        .waitFor();
    }
    if (view === "eventInvitation") {
      await example.locator(".event-information-invitation").waitFor();
      assert.equal(
        await example.locator('[data-default-copy="Kindly RSVP by"]').count(),
        1,
      );
      assert.equal(
        await example.locator(".invitation-address[data-host-content]").count(),
        1,
      );
    }
    if (view === "eventSingleContainer")
      await example.locator("[data-event-shell] .event-icon").waitFor();
    if (view === "eventSettings") {
      await example.locator(".event-layout-editor").waitFor();
      assert.equal(await example.getByRole("radio").count(), 4);
    }
    if (view === "login") {
      await example
        .getByLabel("Password or Household ID", { exact: true })
        .waitFor();
      assert.equal(await example.locator("#unified-suffix").isVisible(), false);
    }
    if (view === "guestLoginSuffix")
      assert.equal(await example.locator("#unified-suffix").isVisible(), true);
    if (view === "familyKidList")
      assert.equal(
        await example
          .getByRole("button", { name: "Delete", exact: true })
          .count(),
        0,
      );
  }
  assert.deepEqual(
    requests,
    [],
    "Rendering examples must never read tenant data or submit synthetic records",
  );
  admin.page.off("request", observe);
  await admin.page
    .getByLabel("Example page", { exact: true })
    .selectOption("guestEvent");
  await example.getByText("Where", { exact: true }).dblclick();
  await example.getByText("Where", { exact: true }).fill("Meet us at");
  await example.getByText("Meet us at", { exact: true }).press("Enter");
  await example.getByText("Meet us at", { exact: true }).waitFor();
  await admin.page
    .getByLabel("Example screen size", { exact: true })
    .selectOption("1440");
  assert.equal(await example.locator("body").evaluate(() => innerWidth), 1440);
  await admin.page.screenshot({
    path: "test-results/features-guest-defaults-desktop.png",
    fullPage: true,
  });
  await admin.page
    .getByLabel("Example screen size", { exact: true })
    .selectOption("390");
  await admin.page
    .getByLabel("Example page", { exact: true })
    .selectOption("event");
  await example
    .locator('.toolbar [data-action="settings"]')
    .waitFor({ state: "attached" });
  await admin.page
    .frameLocator("#page-example-frame")
    .locator('[data-default-copy="When"]')
    .dblclick();
  await admin.page
    .getByLabel("Selected wording", { exact: true })
    .fill("Gathering time");
  await admin.page
    .frameLocator("#page-example-frame")
    .locator("[data-layout=event] > [data-layout-item=menus]")
    .dblclick({ position: { x: 5, y: 5 } });
  await click(admin.page, "Move up");
  await saveAppearance(admin.page);
  await dialog(admin.page).waitFor({ state: "hidden" });
  assert.equal(
    store.get("ui", "defaults", "platform").copy.When,
    "Gathering time",
  );
  assert.deepEqual(store.get("ui", "defaults", "platform").layouts.introText, [
    "title",
    "eyebrow",
    "description",
  ]);
  stage("host navigation, contacts and event editor");
  const h = await device(390);
  await login(h.page, "host@example.test");
  await h.page.getByRole("heading", { name: "Alpha", exact: true }).waitFor();
  assert.deepEqual(
    await h.page
      .locator(".toolbar [data-action]")
      .evaluateAll((els) => els.map((el) => el.dataset.action)),
    ["home", "share-details", "settings"],
  );
  assert.equal(await h.page.locator("header [data-action=logout]").count(), 0);
  assert.equal(
    await h.page.locator(".toolbar [data-action=settings] svg").count(),
    1,
  );
  assert.equal(
    await h.page
      .locator(".toolbar .nav-control")
      .first()
      .evaluate((el) => getComputedStyle(el).borderTopStyle),
    "none",
  );
  assert.equal(
    await h.page
      .locator(".hero h1")
      .evaluate((el) => getComputedStyle(el).color),
    "rgb(41, 77, 66)",
  );
  assert.deepEqual(
    await h.page
      .locator(".hero")
      .evaluate((el) => [...el.children].slice(0, 2).map((el) => el.tagName)),
    ["H1", "P"],
  );
  stage("shared household formatting and confirmed reset");
  assert.equal(
    await h.page.locator("[data-action=host-ui],[data-action=guests]").count(),
    0,
  );
  await click(h.page, "Edit House");
  await setAppearance(h.page, "Text", "Color", "Text color", "#456789");
  await setAppearance(
    h.page,
    "Containers",
    "Background",
    "Containers background",
    "#eeeeee",
  );
  await setAppearance(
    h.page,
    "Containers",
    "Border",
    "Containers border color",
    "#123456",
  );
  await h.page.getByText("Formatting options", { exact: true }).click();
  h.page.once("dialog", (d) => d.dismiss());
  await click(h.page, "Reset to Defaults");
  assert.equal(
    await h.page
      .getByLabel("Containers border color", { exact: true })
      .inputValue(),
    "#123456",
  );
  await setAppearance(h.page, "Toolbars", "Color", "Toolbars color", "#456789");
  await saveAppearance(h.page);
  for (const selector of [
    ".hero .eyebrow",
    ".home-workspace-cards p",
    ".toolbar .nav-control",
  ])
    assert.equal(
      await h.page
        .locator(selector)
        .first()
        .evaluate((el) => getComputedStyle(el).color),
      "rgb(69, 103, 137)",
    );
  await click(h.page, "Edit House");
  await h.page.getByText("Formatting options", { exact: true }).click();
  h.page.once("dialog", (d) => d.accept());
  await click(h.page, "Reset to Defaults");
  await click(h.page, "Cancel");
  assert.equal(await h.page.getByLabel("Notes", { exact: true }).count(), 0);
  await click(h.page, "Contacts");
  await click(h.page, "＋ Add adult or child");
  await h.page.getByLabel("First name", { exact: true }).fill("Casey");
  await h.page.getByLabel("Last name", { exact: true }).fill("Example");
  await h.page
    .getByLabel("Phone number (international)", { exact: true })
    .fill("+15551234567");
  await h.page
    .getByLabel("Shared address (optional)", { exact: true })
    .fill("PO Box 12, Sample City, CA 90210");
  assert.equal(
    await h.page.locator("[name=addressSearch]").getAttribute("aria-invalid"),
    "true",
  );
  assert.equal(await h.page.getByText("Not found", { exact: true }).count(), 1);
  assert.equal(
    await h.page
      .locator("[name=addressSearch]")
      .evaluate((el) => getComputedStyle(el).borderTopColor),
    "rgb(180, 35, 24)",
  );
  await h.page.screenshot({
    path: "test-results/address-search-not-found-phone.png",
  });
  await click(h.page, "Create new address");
  assert.equal(
    await h.page.getByLabel("Street / PO Box", { exact: true }).inputValue(),
    "PO Box 12",
  );
  assert.equal(
    await h.page.getByLabel("City", { exact: true }).inputValue(),
    "Sample City",
  );
  assert.equal(
    await h.page.getByLabel("State", { exact: true }).inputValue(),
    "CA",
  );
  assert.equal(
    await h.page.getByLabel("Zip Code", { exact: true }).inputValue(),
    "90210",
  );
  await h.page
    .getByLabel("Address title", { exact: true })
    .fill("Example home");
  await h.page
    .getByLabel("Street / PO Box", { exact: true })
    .fill("123 Sample Avenue");
  assert.equal(await h.page.locator("[name=smsConsent]").count(), 0);
  await dialog(h.page)
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await dialog(h.page).waitFor({ state: "hidden" });
  stage("inline address search, selection and editing");
  await click(h.page, "Contacts");
  assert.equal(
    await h.page
      .getByRole("button", { name: "＋ Add address", exact: true })
      .count(),
    0,
  );
  await click(h.page, "＋ Add adult or child");
  await h.page.getByLabel("First name", { exact: true }).fill("Jordan");
  await h.page.getByLabel("Last name", { exact: true }).fill("Other");
  await h.page
    .getByLabel("Shared address (optional)", { exact: true })
    .fill("Sample Ave");
  await h.page.getByRole("option", { name: /Example home/ }).click();
  await click(h.page, "Edit this address");
  await h.page
    .getByLabel("Street / PO Box", { exact: true })
    .fill("123 Sample Avenue, Unit 2");
  await click(h.page, "Save");
  await dialog(h.page).waitFor({ state: "hidden" });
  assert.equal(store.list("address", host.household).length, 1);
  assert.equal(
    store.list("address", host.household)[0].lines,
    "123 Sample Avenue, Unit 2\nSample City, CA 90210",
  );
  const localCodes = store.all(
    "SELECT credential FROM guest_access_links WHERE household=?",
    host.household,
  );
  assert.equal(localCodes[0].credential, localCodes[1].credential);
  await click(h.page, "Create event");
  await h.page
    .getByLabel("Event title", { exact: true })
    .fill("Shared celebration");
  await h.page
    .getByLabel("Description", { exact: true })
    .fill("A lovely afternoon");
  await h.page.getByLabel("Date", { exact: true }).fill("2028-06-12");
  await h.page.getByLabel("RSVP deadline", { exact: true }).fill("2028-06-01");
  await h.page
    .getByLabel("Event address", { exact: true })
    .fill("A synthetic address");
  await h.page
    .getByLabel("Photo / video upload link (optional)", { exact: true })
    .fill("https://example.test/upload");
  assert.equal(
    await h.page.getByLabel("Private event notes", { exact: true }).count(),
    0,
  );
  const { selectEventGuest } = await import("./helpers/navigation.js");
  await selectEventGuest(h.page, "Casey Example");
  await selectEventGuest(h.page, "Jordan Other");
  await dialog(h.page)
    .getByRole("button", { name: "Create event", exact: true })
    .click();
  await dialog(h.page).waitFor({ state: "hidden" });
  await click(h.page, "Edit Event");
  await setAppearance(h.page, "Titles", "Color", "Titles color", "#773322");
  await saveAppearance(h.page);

  assert.equal(
    await h.page
      .getByRole("button", { name: "Edit event appearance", exact: true })
      .count(),
    0,
  );
  stage("event formatting copy and delete confirmation");
  assert.equal(
    await h.page
      .locator(".event-summary .totals")
      .evaluate((el) => getComputedStyle(el).color),
    "rgb(69, 103, 137)",
  );
  assert.equal(await h.page.locator("[data-action=delete-event]").count(), 0);
  await click(h.page, "Edit event");
  await h.page.getByText("Formatting options", { exact: true }).click();
  await click(h.page, "Copy Formatting");
  await h.page
    .getByLabel("Copy formatting from", { exact: true })
    .selectOption("0");
  await h.page.locator("[data-action=appearance-copy]").click();
  await click(h.page, "Cancel");
  await click(h.page, "Settings");
  h.page.once("dialog", (d) => d.dismiss());
  await click(h.page, "Delete event");
  assert.equal(await h.page.locator(".inline-event-details").isVisible(), true);
  assert.equal(store.list("event", host.household).length, 1);
  h.page.once("dialog", (d) => d.accept());
  await h.page.getByRole("button", { name: "Back", exact: true }).click();
  await h.page.getByText("Gathering time", { exact: true }).waitFor();
  await h.page.screenshot({
    path: "test-results/features-host-mobile.png",
    fullPage: true,
  });
  stage("reminder scheduling and recipient preview");
  await click(h.page, "Text reminders");
  await h.page
    .getByText("Messaging is not enabled.", { exact: false })
    .waitFor();
  await click(h.page, "Add reminder");
  await h.page
    .getByLabel("Send at (selected time zone)", { exact: true })
    .fill("2028-05-25T12:00");
  await h.page
    .getByLabel("Schedule time zone", { exact: true })
    .fill("America/Los_Angeles");
  await click(h.page, "Preview recipients");
  await h.page
    .locator("#reminder-preview")
    .getByText("No eligible recipients.", { exact: true })
    .waitFor();
  await dialog(h.page)
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await dialog(h.page).waitFor({ state: "hidden" });
  // Dedicated full-page card workflows, QR exports and private templates are
  // covered in cards-mobile.js using the shared three-level toolbar.
  const event = store.list("event", host.household)[0];
  stage("read-only administrator preview");
  await click(admin.page, "Preview guest experience");
  await admin.page
    .getByLabel("Household", { exact: true })
    .selectOption(host.household);
  await admin.page
    .getByLabel("Event (optional)", { exact: true })
    .selectOption(event.id);
  await dialog(admin.page)
    .getByRole("button", { name: "Preview", exact: true })
    .click();
  await dialog(admin.page).waitFor({ state: "hidden" });
  await admin.page
    .getByRole("link", { name: "Upload Photos & Videos", exact: true })
    .waitFor();
  assert.doesNotMatch(
    await admin.page.locator("main").innerText(),
    /Private household note|Private event note/,
  );
  await click(admin.page, "RSVP");
  assert.equal(await admin.page.locator("#editor").isVisible(), false);
  assert.equal(store.list("response", host.household).length, 0);
  await click(admin.page, "Exit read-only preview");
  stage("guest privacy and conditional uploads");
  const guest = await device(390),
    household = store.household(host.household);
  await guest.page.goto(origin + "/h/" + household.slug);
  await guest.page
    .getByLabel("Name, email or username", { exact: true })
    .fill("Casey Example");
  const guestRecord = store.list("guest", host.household)[0];
  await guest.page
    .getByLabel("Password or Household ID", { exact: true })
    .fill(
      store.get(
        "guest-access-code",
        store.one(
          "SELECT credential FROM guest_access_links WHERE guest=? AND household=?",
          guestRecord.id,
          host.household,
        ).credential,
        "platform",
      ).code,
    );
  await click(guest.page, "Sign in");
  await guest.page
    .getByLabel("Username", { exact: true })
    .fill("casey-editor-example");
  await guest.page
    .getByLabel("Recovery phone number", { exact: true })
    .fill("+15005550123");
  await guest.page
    .locator('form[data-form="personal-account"]')
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await guest.page
    .getByText("Household information saved.", { exact: true })
    .waitFor();
  await click(guest.page, "Home");
  await click(guest.page, "View Event");
  assert.ok(await guest.page.locator(".event-deadline").isVisible());
  assert.equal(
    await guest.page
      .getByRole("link", { name: "Upload Photos & Videos", exact: true })
      .getAttribute("href"),
    "https://example.test/upload",
  );
  assert.equal(
    await guest.page.locator("h1").evaluate((el) => getComputedStyle(el).color),
    "rgb(119, 51, 34)",
  );
  assert.doesNotMatch(
    await guest.page.locator("main").innerText(),
    /Private household note|Private event note/,
  );
  stage("shared-address RSVP preserves skipped people");
  await click(guest.page, "RSVP");
  await guest.page
    .getByLabel("Casey Example", { exact: true })
    .selectOption("yes");
  await guest.page.getByLabel("Jordan Other", { exact: true }).selectOption("");
  await click(guest.page, "RSVP");
  await dialog(guest.page).waitFor({ state: "hidden" });
  assert.equal(
    store.one(
      "SELECT status FROM reminder_deliveries WHERE reminder='rsvp-confirmation'",
    ).status,
    "disabled",
  );
  const jordan = store
    .list("guest", host.household)
    .find((g) => g.first === "Jordan");
  assert.equal(
    store.get("response", event.id + ":" + jordan.id, host.household),
    null,
  );
  const caseyResponse = store.get(
    "response",
    event.id + ":" + guestRecord.id,
    host.household,
  );
  await click(guest.page, "RSVP");
  await guest.page
    .getByLabel("Casey Example", { exact: true })
    .selectOption("");
  await guest.page
    .getByLabel("Jordan Other", { exact: true })
    .selectOption("yes");
  await click(guest.page, "RSVP");
  await dialog(guest.page).waitFor({ state: "hidden" });
  assert.deepEqual(
    store.get("response", event.id + ":" + guestRecord.id, host.household),
    caseyResponse,
  );
  assert.equal(
    store.get("response", event.id + ":" + jordan.id, host.household)
      .attendance[jordan.id],
    "yes",
  );
  await guest.page.screenshot({
    path: "test-results/features-guest-mobile.png",
    fullPage: true,
  });
  await admin.page.screenshot({
    path: "test-results/features-admin-desktop.png",
    fullPage: true,
  });
  assert.ok(
    await guest.page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  );
  stage("phone and desktop screenshots");
  for (const [name, page, width] of [
    ["admin-mobile", admin.page, 390],
    ["guest-desktop", guest.page, 1440],
    ["host-desktop", h.page, 1440],
  ]) {
    await page.setViewportSize({ width, height: 950 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      `${name} fits its viewport`,
    );
    await page.screenshot({
      path: `test-results/features-${name}.png`,
      fullPage: true,
    });
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(
    "PASS: global wording/role/layout editing, phone navigation, combined event editor, notes privacy, upload link, consent/reminder preview, unified guest sign-in and read-only guest preview.",
  );
} catch (error) {
  console.error(`Shared editor browser check failed during: ${phase}`, error);
  throw error;
} finally {
  stage("browser and server cleanup");
  await browser.close();
  await new Promise((r) => server.close(r));
  store.db.close();
  clearTimeout(watchdog);
}

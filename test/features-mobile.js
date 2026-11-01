// Isolated synthetic records, no production or messaging requests.
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
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
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(10000);
  return { context, page };
}
const click = (page, name) =>
  page.getByRole("button", { name, exact: true }).click();
const dialog = (page) => page.getByRole("dialog");
async function login(page, email) {
  await page.goto(origin);
  await page.getByLabel("Email address", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await click(page, "Sign in");
}
try {
  await mkdir("test-results", { recursive: true });
  stage("administrator defaults and layout");
  const admin = await device(1440);
  await login(admin.page, "admin@example.test");
  await click(admin.page, "Edit global defaults");
  await admin.page.getByLabel("Title color", { exact: true }).fill("#334455");
  await admin.page
    .locator("summary")
    .filter({ hasText: /^Page wording$/ })
    .click();
  await admin.page.locator('[name="copy:When"]').fill("Gathering time");
  await admin.page
    .locator("summary")
    .filter({ hasText: /^Container and button layout$/ })
    .click();
  const menu = admin.page.locator(
    "[data-layout=event] [data-layout-item=menus]",
  );
  await menu.getByRole("button", { name: "Move up", exact: true }).click();
  await dialog(admin.page)
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await dialog(admin.page).waitFor({ state: "hidden" });
  assert.equal(
    store.get("ui", "defaults", "platform").copy.When,
    "Gathering time",
  );
  stage("host navigation, contacts and event editor");
  const h = await device(390);
  await login(h.page, "host@example.test");
  await h.page.getByRole("heading", { name: "Alpha", exact: true }).waitFor();
  assert.equal(
    await h.page
      .locator(
        ".toolbar [data-action=new-event],.toolbar [data-action=household]",
      )
      .count(),
    0,
  );
  assert.equal(await h.page.locator("header [data-action=logout]").count(), 0);
  assert.equal(
    await h.page.locator(".toolbar [data-action=logout] svg").count(),
    1,
  );
  assert.equal(
    await h.page
      .locator(".toolbar .nav-control")
      .first()
      .evaluate((el) => getComputedStyle(el).borderTopStyle),
    "none",
  );
  await h.page
    .getByLabel("Notes", { exact: true })
    .fill("Private household note");
  await click(h.page, "Save private notes");
  await click(h.page, "Guest list");
  await click(h.page, "＋ Add adult or child");
  await h.page.getByLabel("First name", { exact: true }).fill("Casey");
  await h.page.getByLabel("Last name", { exact: true }).fill("Example");
  await h.page
    .getByLabel("Phone number (international)", { exact: true })
    .fill("+15551234567");
  await h.page.getByRole("checkbox", { name: /consented/ }).check();
  await dialog(h.page)
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await dialog(h.page).waitFor({ state: "hidden" });
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
  await h.page
    .getByLabel("Private event notes", { exact: true })
    .fill("Private event note");
  await h.page.getByLabel("Casey Example", { exact: true }).check();
  await h.page.getByText("Event appearance", { exact: true }).click();
  const imageY = await h.page
      .getByLabel("Background image (optional, up to 2 MB)", { exact: true })
      .evaluate((el) => el.getBoundingClientRect().top),
    colorY = await h.page
      .getByLabel("Background color", { exact: true })
      .evaluate((el) => el.getBoundingClientRect().top);
  assert.ok(imageY < colorY);
  await h.page.getByLabel("Title color", { exact: true }).fill("#773322");
  await dialog(h.page)
    .getByRole("button", { name: "Create event", exact: true })
    .click();
  await dialog(h.page).waitFor({ state: "hidden" });
  assert.equal(
    await h.page
      .getByRole("button", { name: "Edit event appearance", exact: true })
      .count(),
    0,
  );
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
    .getByText("Casey Example · +15551234567", { exact: true })
    .waitFor();
  await dialog(h.page)
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await dialog(h.page).waitFor({ state: "hidden" });
  stage("card editor and SVG/PNG downloads");
  await click(h.page, "Cards");
  await click(h.page, "Create card / template");
  await h.page
    .getByLabel("Card name", { exact: true })
    .fill("Thank you, friends");
  await h.page
    .getByLabel("Card type", { exact: true })
    .selectOption("thank-you");
  await h.page
    .getByLabel("Recipient", { exact: true })
    .selectOption({ label: "Casey Example" });
  await h.page.getByLabel("Include QR code", { exact: true }).uncheck();
  await h.page.screenshot({
    path: "test-results/features-card-mobile.png",
    fullPage: true,
  });
  const canvas = h.page.locator("#card-canvas");
  assert.doesNotMatch(await canvas.innerHTML(), /data:image\/svg\+xml/);
  const pending = h.page.waitForEvent("download");
  await click(h.page, "Download SVG");
  const download = await pending;
  const path = await download.path();
  const svg = await readFile(path, "utf8");
  assert.match(svg, /Shared celebration/);
  assert.doesNotMatch(svg, /data:image\/svg\+xml/);
  const pngPending = h.page.waitForEvent("download");
  await click(h.page, "Download PNG");
  const png = await pngPending;
  assert.ok((await readFile(await png.path())).length > 100);
  stage("quantity printing without a native dialog");
  await h.page.getByLabel("Print quantity", { exact: true }).fill("2");
  await click(h.page, "Print cards");
  assert.equal(
    await h.page
      .locator("iframe.print-frame")
      .contentFrame()
      .locator(".copy")
      .count(),
    2,
  );
  assert.equal(
    await h.page
      .locator("iframe.print-frame")
      .contentFrame()
      .locator("body")
      .evaluate(() => window.__printCalls),
    1,
    "the real print action invokes the frame's print API exactly once",
  );
  await dialog(h.page)
    .getByRole("button", { name: "Save card", exact: true })
    .click();
  await dialog(h.page).waitFor({ state: "hidden" });
  const event = store.list("event", host.household)[0];
  assert.equal(event.notes, "Private event note");
  assert.equal(
    store.list("card", host.household)[0].context.recipient.name,
    "Casey Example",
  );
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
  await click(admin.page, "Save my RSVP");
  assert.equal(await admin.page.locator("#editor").isVisible(), false);
  assert.equal(store.list("response", host.household).length, 0);
  await click(admin.page, "Exit read-only preview");
  stage("guest privacy and conditional uploads");
  const guest = await device(390),
    household = store.household(host.household);
  await guest.page.goto(origin + "/h/" + household.slug);
  await guest.page.getByLabel("First name", { exact: true }).fill("Casey");
  await guest.page.getByLabel("Last name", { exact: true }).fill("Example");
  await click(guest.page, "See my invitations");
  await click(guest.page, "View event");
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
    "PASS: global wording/role/layout editing, phone navigation, combined event editor, notes privacy, upload link, consent/reminder preview, card SVG/PNG/quantity export, and read-only guest preview.",
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

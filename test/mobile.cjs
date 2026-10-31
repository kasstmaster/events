// Synthetic data only. Starts its own memory database; never contacts a live integration.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { existsSync, mkdirSync } = require("node:fs");
(async () => {
  const { Store } = await import("../server/model.js"),
    { createApp } = await import("../server/app.js");
  const store = new Store(),
    origin = "http://127.0.0.1:3147",
    password = "Mobile-synthetic-password";
  await store.createAdmin("admin@example.test", password);
  const server = createApp({ store, origin });
  server.listen(3147, "127.0.0.1");
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
  async function device(width = 390, height = 844) {
    const context = await browser.newContext({
      viewport: { width, height },
      isMobile: width < 600,
      hasTouch: width < 600,
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
    page.on("pageerror", (e) => errors.push(e.message));
    page.setDefaultTimeout(10000);
    return { context, page };
  }
  async function click(page, label) {
    await page
      .getByRole("button", {
        name: label === "✕" ? "Close editor" : label,
        exact: true,
      })
      .click();
  }
  async function register(page, email, name) {
    await page.goto(origin);
    await click(page, "Create your account");
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByLabel("Family household name").fill(name);
    await click(page, "Create account");
    await page.getByRole("heading", { name, exact: true }).waitFor();
  }
  async function login(page, email) {
    await page.goto(origin);
    await page.getByLabel("Email address").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await click(page, "Sign in");
  }
  const dialog = (page) => page.getByRole("dialog");
  const noOverflow = async (page) =>
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      "page must fit mobile viewport",
    );
  try {
    const admin = await device();
    await login(admin.page, "admin@example.test");
    await admin.page
      .getByRole("heading", { name: "Approved emails", exact: true })
      .waitFor();
    for (const email of ["alpha@example.test", "beta@example.test"]) {
      await admin.page.getByLabel("Email address").fill(email);
      await click(admin.page, "Approve host");
      await admin.page.getByText(email, { exact: true }).waitFor();
    }
    const alpha = await device(),
      beta = await device(768, 1024);
    await register(alpha.page, "alpha@example.test", "The Alpha Family");
    await register(beta.page, "beta@example.test", "The Beta Family");
    await click(alpha.page, "Guest list");
    await click(alpha.page, "＋ Add adult or child");
    await alpha.page.getByLabel("First name", { exact: true }).fill("Casey");
    await alpha.page.getByLabel("Last name", { exact: true }).fill("Example");
    await dialog(alpha.page)
      .getByRole("button", { name: "Save", exact: true })
      .click();
    await dialog(alpha.page).waitFor({ state: "hidden" });
    await click(alpha.page, "Guest list");
    await click(alpha.page, "＋ Add adult or child");
    await alpha.page.getByLabel("First name", { exact: true }).fill("Robin");
    await alpha.page.getByLabel("Last name", { exact: true }).fill("Example");
    await alpha.page
      .getByLabel("Adult or child")
      .selectOption({ label: "Child of Casey Example" });
    await dialog(alpha.page)
      .getByRole("button", { name: "Save", exact: true })
      .click();
    await dialog(alpha.page).waitFor({ state: "hidden" });
    await click(alpha.page, "✎ Household");
    await alpha.page
      .getByLabel("Background color", { exact: true })
      .fill("#e6edf7");
    await alpha.page.getByLabel("Title color", { exact: true }).fill("#314c78");
    await dialog(alpha.page)
      .getByRole("button", { name: "Save", exact: true })
      .click();
    await dialog(alpha.page).waitFor({ state: "hidden" });
    await alpha.page
      .getByRole("button", { name: "Create event", exact: true })
      .click();
    await alpha.page.getByLabel("Event title").fill("Summer around the table");
    await alpha.page.getByLabel("Description").fill("A picnic for our people.");
    await alpha.page.getByLabel("Date", { exact: true }).fill("2028-06-12");
    await alpha.page
      .getByLabel("Time · numbers or words")
      .fill("Two O’Clock in the Afternoon");
    await alpha.page.getByLabel("RSVP deadline").fill("2028-06-01");
    await alpha.page.getByLabel("Event address").fill("The garden");
    await alpha.page.getByLabel("Casey Example", { exact: true }).check();
    await alpha.page
      .getByLabel("Robin Example (child)", { exact: true })
      .check();
    await click(alpha.page, "＋ Add item");
    await alpha.page.getByLabel("Item name").fill("Lemonade");
    await alpha.page.getByLabel("Menu", { exact: true }).selectOption("drink");
    await alpha.page.getByLabel("Needed", { exact: true }).fill("3");
    await click(alpha.page, "＋ Add registry");
    await alpha.page.getByLabel("Registry title").fill("Amazon Registry");
    await alpha.page
      .getByLabel("Registry URL")
      .fill("https://example.test/amazon");
    await click(alpha.page, "＋ Add registry");
    await alpha.page
      .getByLabel("Registry title")
      .nth(1)
      .fill("Wedding Registry");
    await alpha.page
      .getByLabel("Registry URL")
      .nth(1)
      .fill("https://example.test/wedding");
    await alpha.page
      .getByRole("button", { name: "Move registry up", exact: true })
      .nth(1)
      .click();
    assert.equal(
      await alpha.page.getByLabel("Registry title").first().inputValue(),
      "Wedding Registry",
    );
    await dialog(alpha.page)
      .getByRole("button", { name: "Create event", exact: true })
      .click();
    await dialog(alpha.page).waitFor({ state: "hidden" });
    await alpha.page
      .getByRole("heading", { name: "Summer around the table", exact: true })
      .waitFor();
    await noOverflow(alpha.page);
    await alpha.page
      .getByRole("button", { name: "Edit event appearance", exact: true })
      .click();
    await alpha.page
      .getByLabel("Background color", { exact: true })
      .fill("#fff1eb");
    await alpha.page.getByLabel("Title color", { exact: true }).fill("#8f3829");
    await dialog(alpha.page)
      .getByRole("button", { name: "Save", exact: true })
      .click();
    await dialog(alpha.page).waitFor({ state: "hidden" });
    await click(alpha.page, "⌂ Home");
    await click(alpha.page, "Share household link");
    const link = await alpha.page.locator(".share-link").textContent();
    assert.ok(link.startsWith(origin + "/h/"));
    await alpha.page.locator(".qr").waitFor();
    await click(alpha.page, "✕");
    const guest = await device(),
      secondDevice = await device(1440, 1000);
    await guest.page.goto(link);
    await guest.page
      .getByRole("heading", { name: "The Alpha Family", exact: true })
      .waitFor();
    assert.equal(
      await guest.page.evaluate(
        () => getComputedStyle(document.body).backgroundColor,
      ),
      "rgb(230, 237, 247)",
    );
    await guest.page.getByLabel("First name", { exact: true }).fill("Casey");
    await guest.page.getByLabel("Last name", { exact: true }).fill("Example");
    await click(guest.page, "See my invitations");
    await guest.page
      .getByRole("heading", { name: "Summer around the table", exact: true })
      .waitFor();
    await click(guest.page, "View event");
    assert.equal(
      await guest.page.evaluate(
        () => getComputedStyle(document.body).backgroundColor,
      ),
      "rgb(255, 241, 235)",
    );
    assert.deepEqual(
      await guest.page.locator(".registry-button").allTextContents(),
      ["Wedding Registry", "Amazon Registry"],
    );
    const order = await guest.page.evaluate(() => {
      const r = document.querySelector("[data-action=rsvp]"),
        b = document.querySelector(".registry-buttons");
      return b.previousElementSibling === r;
    });
    assert.ok(order, "registries are directly below RSVP");
    mkdirSync("test-results", { recursive: true });
    await guest.page.screenshot({
      path: "test-results/guest-mobile.png",
      fullPage: true,
    });
    const registry = guest.page.locator(".registry-button").first();
    assert.equal(
      await registry.getAttribute("href"),
      "https://example.test/wedding",
    );
    assert.equal(
      await registry.evaluate((el) => getComputedStyle(el).color),
      "rgb(143, 56, 41)",
    );
    assert.ok((await registry.boundingBox()).height >= 44);
    await noOverflow(guest.page);
    await click(guest.page, "Save my RSVP");
    await guest.page
      .getByLabel("Casey Example", { exact: true })
      .selectOption("yes");
    await guest.page
      .getByLabel("Robin Example · child", { exact: true })
      .selectOption("yes");
    await guest.page.getByLabel("Quantity for Lemonade").fill("2");
    await dialog(guest.page)
      .getByRole("button", { name: "Save my RSVP", exact: true })
      .click();
    await dialog(guest.page).waitFor({ state: "hidden" });
    await guest.page.getByText("Lemonade × 2", { exact: true }).waitFor();
    await secondDevice.page.goto(link);
    await secondDevice.page
      .getByLabel("First name", { exact: true })
      .fill("Casey");
    await secondDevice.page
      .getByLabel("Last name", { exact: true })
      .fill("Example");
    await click(secondDevice.page, "See my invitations");
    await click(secondDevice.page, "View event");
    await secondDevice.page
      .getByText("Lemonade × 2", { exact: true })
      .waitFor();
    await click(alpha.page, "View event");
    await click(alpha.page, "RSVPs");
    await dialog(alpha.page)
      .getByText("2 attending", { exact: true })
      .waitFor();
    await dialog(alpha.page)
      .getByText("2 / 3 · 1 remaining", { exact: true })
      .waitFor();
    await click(alpha.page, "✕");
    await click(alpha.page, "Edit event");
    await alpha.page
      .getByLabel("Registry title")
      .first()
      .fill("Our wedding wishes");
    await alpha.page
      .getByRole("button", { name: "Move registry down", exact: true })
      .first()
      .click();
    await dialog(alpha.page)
      .getByRole("button", { name: "Save event", exact: true })
      .click();
    await dialog(alpha.page).waitFor({ state: "hidden" });
    // The second browser session refreshes itself through the normal polling path.
    await secondDevice.page
      .getByRole("link", { name: "Our wedding wishes", exact: true })
      .waitFor({ timeout: 15000 });
    assert.deepEqual(
      await secondDevice.page.locator(".registry-button").allTextContents(),
      ["Amazon Registry", "Our wedding wishes"],
    );
    await click(alpha.page, "Edit event");
    await alpha.page
      .getByRole("button", { name: "Remove registry", exact: true })
      .first()
      .click();
    await alpha.page
      .getByRole("button", { name: "Remove registry", exact: true })
      .first()
      .click();
    await dialog(alpha.page)
      .getByRole("button", { name: "Save event", exact: true })
      .click();
    await dialog(alpha.page).waitFor({ state: "hidden" });
    await guest.page.reload();
    await guest.page
      .getByRole("heading", { name: "The Alpha Family", exact: true })
      .waitFor();
    await click(guest.page, "View event");
    assert.equal(await guest.page.locator(".registry-buttons").count(), 0);
    await guest.page.getByText("Lemonade × 2", { exact: true }).waitFor();
    assert.equal(await beta.page.locator(".card").count(), 0);
    assert.equal(
      await beta.page
        .getByRole("heading", { name: "The Beta Family", exact: true })
        .count(),
      1,
    );
    await noOverflow(beta.page);
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    console.log(
      "PASS: mobile host approval/registration, guest+child setup, event+menu+registry editing, household/event appearance isolation, guest RSVP, host totals, automatic multi-device registry sync, tablet/desktop layouts, and no external requests.",
    );
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
    store.db.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

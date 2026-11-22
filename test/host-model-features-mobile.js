// Synthetic isolated data only; network denied outside loopback.
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { Store } from "../server/node-store.js";
import { createApp } from "../server/app.js";
import {
  isolateAddressBook,
  addressBookCheckpoint,
} from "../server/recipient-isolation.js";
import { ensureHostRoster } from "../server/host-roster.js";
import { publicEventReference } from "../server/public-invitations.js";
const origin = "http://127.0.0.1:3246",
  password = "Synthetic-native-feature-password",
  store = new Store();
await store.createAdmin("admin@example.test", password);
store.run(
  "INSERT INTO approvals VALUES(?,?)",
  "host@example.test",
  "synthetic",
);
const host = await store.register({
  email: "host@example.test",
  password,
  name: "Synthetic Household",
});
isolateAddressBook(
  store,
  host.household,
  addressBookCheckpoint(store, host.household).fingerprint,
  "synthetic",
);
ensureHostRoster(store, host.household);
const guest = store.put("guest", "test-recipient", host.household, {
  first: "Casey",
  last: "Example",
  suffix: "",
  address: "",
});
const event = store.put("event", "test-event", host.household, {
  title: "Synthetic event",
  description: "Unchanged shared renderer",
  date: "2027-02-01",
  time: "Two o'clock",
  deadline: "",
  address: "Synthetic venue",
  invited: [guest.id],
  menu: [],
  registries: [],
  information: [],
  design: {},
});
const reference = publicEventReference(store, host.household, event.id);
const server = createApp({
  store,
  origin,
  env: {
    HOST_ONLY_MODEL_ENABLED: "true",
    HOST_ONLY_MODEL_ACTIVATION_APPROVED: "true",
  },
});
server.listen(3246, "127.0.0.1");
await once(server, "listening");
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ||
    (existsSync("/usr/bin/chromium")
      ? "/usr/bin/chromium"
      : chromium.executablePath()),
  args: ["--no-sandbox"],
});
try {
  for (const width of [390, 768, 1366]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
    });
    await context.route("**/*", (r) =>
      new URL(r.request().url()).origin === origin ? r.continue() : r.abort(),
    );
    const page = await context.newPage(),
      errors = [];
    page.setDefaultTimeout(12000);
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (d) => d.accept());
    await page.goto(origin);
    await page.locator('form[data-form="host-login"]').waitFor();
    await page.locator('[name="email"]').fill("host@example.test");
    await page.locator('[name="password"]').fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.locator('[data-action="open-event"]').first().click();
    await page.locator('.toolbar [data-action="settings"]').click();
    await page
      .locator('[data-action="event-settings-section"][data-id="photos"]')
      .click();
    assert.equal(
      await page
        .locator('.inline-event-details [data-action="invite-guests"]')
        .count(),
      0,
    );
    assert.equal(await page.locator('[data-action="delete-event"]').count(), 1);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.locator('[data-action="event-pages-manage"]').click();
    await page.locator('[data-action="event-page-new"]').click();
    const form = page.locator('form[data-form="event-page"]');
    await form.locator('[name="title"]').fill("Public details " + width);
    await form
      .locator("[data-information-input]")
      .fill("Public instructions " + width);
    await form.getByRole("button", { name: "Save page", exact: true }).click();
    await page.locator('[data-action="event-page-new"]').click();
    await form.locator('[name="title"]').fill("Private instructions " + width);
    await form.locator('[name="audience"]').selectOption("members");
    await form.locator(`[name="members"][value="${guest.id}"]`).check();
    await form
      .locator("[data-information-input]")
      .fill("Individual instructions " + width);
    await page.locator('[data-action="event-page-save"]').click();
    await page
      .locator('form[data-form="event-page-grant"] [name="guest"]')
      .selectOption(guest.id);
    await page
      .getByRole("button", { name: "Create private member link", exact: true })
      .click();
    const link = await page.locator('[name="privatePageURL"]').inputValue();
    const visitor = await browser.newContext({
      viewport: { width, height: 1000 },
    });
    await visitor.route("**/*", (r) =>
      new URL(r.request().url()).origin === origin ? r.continue() : r.abort(),
    );
    const q = await visitor.newPage();
    q.setDefaultTimeout(12000);
    q.on("pageerror", (e) => errors.push(e.message));
    await q.goto(origin + "/event/" + reference);
    await q
      .getByRole("button", { name: "Public details " + width, exact: true })
      .waitFor();
    assert.equal(
      await q
        .getByRole("button", {
          name: "Private instructions " + width,
          exact: true,
        })
        .count(),
      0,
    );
    await q.goto(link);
    await q
      .getByRole("button", {
        name: "Private instructions " + width,
        exact: true,
      })
      .click();
    await q
      .getByText("Individual instructions " + width, { exact: true })
      .waitFor();
    assert.equal(new URL(q.url()).hash, "");
    assert.equal(
      (await visitor.cookies()).some((c) => c.name.includes("session")),
      false,
    );
    await page.locator('[data-action="event-page-revoke"]').last().click();
    await q.reload();
    await q.getByRole("heading", { name: event.title, exact: true }).waitFor();
    assert.equal(
      await q
        .getByRole("button", {
          name: "Private instructions " + width,
          exact: true,
        })
        .count(),
      0,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.deepEqual(errors, []);
    await page.goto(origin);
    await page
      .locator('[data-home-card="contacts"] [data-action="addresses"]')
      .first()
      .click();
    await page
      .locator('[data-action="edit-guest"][data-id="' + guest.id + '"]')
      .first()
      .click();
    await page.locator('[data-action="recipient-children"]').click();
    await page
      .locator('[name="childFirst"]')
      .first()
      .fill("Riley " + width);
    await page.locator('[name="childSuffix"]').first().fill("Jr.");
    assert.equal(
      await page
        .locator('form[data-form="contact-children"] [name="last"]')
        .count(),
      0,
    );
    await page
      .getByRole("button", { name: "Save children", exact: true })
      .click();
    await page
      .getByText("Riley " + width + " Jr.", { exact: true })
      .first()
      .waitFor();
    await visitor.close();
    await context.close();
    console.log(
      `Native full-page editor, public/private grants and revocation passed: ${width}px`,
    );
  }
  const adminContext = await browser.newContext({
    viewport: { width: 390, height: 1000 },
  });
  await adminContext.route("**/*", (r) =>
    new URL(r.request().url()).origin === origin ? r.continue() : r.abort(),
  );
  const adminPage = await adminContext.newPage();
  adminPage.setDefaultTimeout(12000);
  await adminPage.goto(origin);
  await adminPage.locator('[name="email"]').fill("admin@example.test");
  await adminPage.locator('[name="password"]').fill(password);
  await adminPage.getByRole("button", { name: "Sign in", exact: true }).click();
  await adminPage.locator('[data-action="admin-hosts"]').first().click();
  const directory = adminPage.locator('form[data-form="host-admin-directory"]');
  await directory.locator('[name="password"]').fill(password);
  await directory.locator("button").click();
  await adminPage.locator('[data-action="host-admin-edit"]').first().click();
  await adminPage.locator('form[data-form="host-admin-identity"]').waitFor();
  assert.equal(await adminPage.locator("dialog[open]").count(), 0);
  assert.equal(
    await adminPage.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await adminContext.close();
  console.log(
    "Password-confirmed host administration uses full-page existing controls on mobile",
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  store.db.close();
}

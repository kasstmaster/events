// Synthetic loopback only. No provider, production data, or outbound messages.
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { Store } from "../server/node-store.js";
import { createApp } from "../server/app.js";
import {
  publicEventReference,
  recipientHouseholdID,
} from "../server/public-invitations.js";
const origin = "http://127.0.0.1:3228",
  store = new Store();
await store.createAdmin(
  "admin@example.test",
  "Synthetic-browser-only-password",
);
store.run(
  "INSERT INTO approvals VALUES(?,?)",
  "host@example.test",
  "synthetic",
);
const host = await store.register({
  email: "host@example.test",
  password: "Synthetic-browser-only-password",
  name: "Synthetic Host",
});
const guest = store.put("guest", "synthetic-adult", host.household, {
  first: "Casey",
  last: "Example",
  suffix: "",
  address: "",
});
const event = store.put("event", "synthetic-event", host.household, {
  title: "Synthetic gathering",
  description: "Approved shared layout",
  date: "2027-01-12",
  time: "14:00",
  address: "Synthetic venue",
  deadline: "",
  invited: [guest.id],
  menu: [],
  registries: [],
  information: [],
  notes: "Never public",
  design: {},
});
const reference = publicEventReference(store, host.household, event.id),
  code = recipientHouseholdID(store, host.household, guest.id).code;
const server = createApp({
  store,
  origin,
  env: { PUBLIC_INVITATIONS_ENABLED: "true" },
});
server.listen(3228, "127.0.0.1");
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
      viewport: { width, height: 900 },
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${origin}/event/${reference}`);
    await page
      .getByRole("heading", { name: event.title, exact: true })
      .waitFor();
    assert.equal(await page.locator("form[data-form=login]").count(), 0);
    assert.equal(
      await page.getByText("Never public", { exact: true }).count(),
      0,
    );
    await page.locator('[data-action="rsvp"]').click();
    await page.locator('[name="householdID"]').fill(code);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.locator('form[data-form="rsvp"]').waitFor();
    assert.equal(await page.locator("dialog[open]").count(), 0);
    await page.locator(`[name="attendance:${guest.id}"]`).selectOption("yes");
    await page
      .locator('form[data-form="rsvp"] button')
      .filter({ hasText: /^RSVP$/ })
      .click();
    await page
      .getByRole("heading", { name: event.title, exact: true })
      .waitFor();
    assert.equal(await page.locator('form[data-form="rsvp"]').count(), 0);
    await page.reload();
    await page
      .getByRole("heading", { name: event.title, exact: true })
      .waitFor();
    assert.equal(
      (await context.cookies()).some((c) => c.name.includes("session")),
      false,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`Public no-login RSVP browser passed: ${width}px`);
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  store.db.close();
}

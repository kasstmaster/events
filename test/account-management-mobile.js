// Isolated accounts and local browser traffic only; SMS is disabled.
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { Store } from "../server/node-store.js";
import { createApp } from "../server/app.js";
const origin = "http://127.0.0.1:3212",
  password = "Synthetic-account-security-password",
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
  name: "Example Hosts",
});
const server = createApp({
  store,
  origin,
  env: { GUEST_LINK_ENCRYPTION_KEY: "ab".repeat(32) },
  logger: { error: () => {} },
});
server.listen(3212, "127.0.0.1");
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
  for (const width of [390, 1440]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    await ctx.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort(),
    );
    const admin = store.one("SELECT id FROM users WHERE role='admin'");
    const proof = store.newSession({ user: admin.id, role: "admin" }, origin);
    await ctx.addCookies([
      {
        name: "events_session",
        value: proof.token,
        url: origin,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", () => errors.push("script-error"));
    await page.goto(origin);
    await page.locator('[data-action="admin-hosts"]').first().click();
    await page
      .getByRole("button", { name: "Registered accounts", exact: true })
      .click();
    const query = page.locator('form[data-form="account-query"]');
    await query.getByLabel("Current administrator password").fill(password);
    await query
      .getByRole("button", { name: "View registered accounts", exact: true })
      .click();
    await page.locator('[data-action="account-select"]').first().waitFor();
    assert.equal(
      await query.getByLabel("Current administrator password").inputValue(),
      "",
    );
    await page
      .locator(
        '[data-action="account-select"][data-id="user:' + host.user + '"]',
      )
      .click();
    const edit = page.locator('form[data-form="account-edit"]');
    await edit.getByLabel("Registered address").fill("22 Central Ave");
    await edit.getByLabel("Current administrator password").fill(password);
    await edit
      .getByRole("button", { name: "Save registered information", exact: true })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector('[name="address"]')?.value ===
          "22 Central Ave" &&
        !document.querySelector('form[data-form="account-edit"][data-saving]'),
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      ),
      false,
    );
    await page.evaluate(() => {
      const exit = document.createElement("button");
      exit.dataset.action = "home";
      document.body.append(exit);
      exit.click();
    });
    await page.evaluate(() => {
      const reopen = document.createElement("button");
      reopen.dataset.action = "account-management";
      document.body.append(reopen);
      reopen.click();
    });
    await page.locator('form[data-form="account-query"]').waitFor();
    assert.equal(
      await page.locator('[data-action="account-select"]').count(),
      0,
    );
    assert.deepEqual(errors, []);
    await ctx.close();
  }
  console.log(
    "PASS: restricted administrator account management, fresh-password clearing and central address updates at phone/desktop widths; no provider calls.",
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  store.db.close();
}

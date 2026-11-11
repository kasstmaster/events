// Private authentication browser regression. Isolated SQLite and mock SMS only.
import assert from "node:assert/strict";
import { once } from "node:events";
import { chromium } from "playwright";
import { Store } from "../server/node-store.js";
import { createApp } from "../server/app.js";
import { identityFor } from "../server/guest-identities.js";
import { guestPrivateLink, enrollGuestContact } from "../server/guest-auth.js";
const origin = "http://127.0.0.1:3147",
  password = "Synthetic-private-browser-password";
const env = {
  GUEST_LINK_ENCRYPTION_KEY: "b2".repeat(32),
  SMS_ENABLED: "true",
  TWILIO_ACCOUNT_SID: "synthetic",
  TWILIO_AUTH_TOKEN: "synthetic",
  TWILIO_FROM: "+15005550006",
};
const store = new Store(),
  messages = [],
  errors = [],
  external = [];
await store.createAdmin("admin@example.test", password);
store.run(
  "INSERT INTO approvals VALUES(?,?)",
  "host@example.test",
  "synthetic",
);
const host = await store.register({
  email: "host@example.test",
  password,
  name: "Example Family",
});
// Use the real host API to add the fixture below.
const server = createApp({
  store,
  origin,
  env,
  guestAuthFetcher: async (_url, req) => {
    messages.push(Object.fromEntries(req.body));
    return Response.json({ sid: "synthetic-sid" }, { status: 201 });
  },
  logger: { error: () => errors.push("server error") },
});
server.listen(3147, "127.0.0.1");
await once(server, "listening");
const hostSession = store.newSession({ ...host, role: "host" }, origin);
async function api(path, data, cookie) {
  const r = await fetch(origin + path, {
    method: data ? "POST" : "GET",
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(data ? { "Content-Type": "application/json" } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  assert.ok(r.ok, `Fixture request status ${r.status}`);
  return r.json();
}
const guest = await api(
  "/api/host/guests",
  { first: "Casey", last: "Example" },
  "events_session=" + hostSession.token,
);
const identity = identityFor(store, guest, host.household).id;
enrollGuestContact(store, identity, "+15005550123", {
  administrator: store.one("SELECT id FROM users WHERE role='admin'").id,
  verifiedOutOfBand: true,
  consented: true,
  version: 0,
});
const link = guestPrivateLink(store, identity, env, origin).url;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
try {
  for (const width of [390, 1440]) {
    console.log(`Private guest sign-in browser: ${width}px`);
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      hasTouch: width < 600,
      isMobile: width < 600,
    });
    await context.route("**/*", (route) => {
      if (
        !route
          .request()
          .url()
          .startsWith(origin + "/")
      ) {
        external.push("unexpected external request");
        return route.abort();
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(link);
    await page.locator('form[data-form="guest-access-start"]').waitFor();
    assert.equal(
      await page.locator('form[data-form="guest-access-start"] input').count(),
      3,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Forgot username?", exact: true })
        .count(),
      0,
    );
    assert.equal(await page.getByLabel("Username", { exact: true }).count(), 0);
    await page.getByLabel("First Name", { exact: true }).fill("Casey");
    await page.getByLabel("Last Name", { exact: true }).fill("Example");
    await page
      .getByLabel("Household ID", { exact: true })
      .fill(guest.inviteCode);
    // Expire only the synthetic cooldown between independent viewport checks.
    if (width === 1440) {
      const old = store.get("guest-auth-send", identity + ":code", "platform");
      store.put("guest-auth-send", old.id, "platform", { at: 0 }, old.version);
    }
    await page.getByRole("button", { name: "Sign In", exact: true }).click();
    await page.getByLabel("Verification code", { exact: true }).waitFor();
    assert.doesNotMatch(await page.locator("main").innerText(), /15005550123/);
    assert.equal(await page.locator(".home-invitations,.empty").count(), 0);
    await page.getByLabel("Verification code", { exact: true }).fill("000000");
    await page
      .getByRole("button", { name: "Verify and sign in", exact: true })
      .click();
    await page
      .locator(".form-error")
      .getByText(/invalid or expired/)
      .waitFor();
    const code = messages.at(-1).Body.match(/code is (\d{6})/)[1];
    await page.getByLabel("Verification code", { exact: true }).fill(code);
    await page
      .getByRole("button", { name: "Verify and sign in", exact: true })
      .click();
    await page
      .getByRole("heading", {
        name: "Nothing on the calendar yet.",
        exact: true,
      })
      .waitFor();
    assert.equal(await page.locator(".empty .sprig").count(), 0);
    assert.equal(new URL(page.url()).hash, "");
    const count = messages.length;
    await page.reload();
    await page.locator(".empty").waitFor();
    assert.equal(messages.length, count);
    await page.locator('.toolbar [data-action="settings"]').click();
    await page
      .getByRole("button", { name: "Private sign-in", exact: true })
      .click();
    assert.equal(
      await page
        .getByLabel("Your private sign-in link", { exact: true })
        .inputValue(),
      link,
    );
    await page
      .getByRole("button", { name: "Sign out other devices", exact: true })
      .waitFor();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    assert.equal(store.list("guest", host.household).length, 1);
    await context.close();
  }
  for (const role of ["host", "admin"]) {
    console.log(`Private guest access browser: ${role} controls`);
    const context = await browser.newContext({
        viewport: { width: 390, height: 900 },
      }),
      page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on("pageerror", (e) => errors.push(e.message));
    await context.route("**/*", (route) =>
      route
        .request()
        .url()
        .startsWith(origin + "/")
        ? route.continue()
        : route.abort(),
    );
    await page.goto(origin);
    await page
      .getByLabel("Email address", { exact: true })
      .fill(role + "@example.test");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    if (role === "host") {
      await page.locator('[data-action="addresses"]').first().click();
      const row = page
        .locator("li.browse-row")
        .filter({ has: page.getByText("Casey Example", { exact: true }) });
      await row.locator('[data-action="edit-guest"]').first().click();
      await page.locator('[data-action="guest-send-private-link"]').click();
      await page
        .getByText(
          "Sign-in link submitted for delivery to the guest’s verified contact. Delivery is not confirmed.",
          { exact: true },
        )
        .waitFor();
      assert.ok(!(await page.content()).includes(link));
      assert.equal(messages.at(-1).To, "+15005550123");
      assert.ok(messages.at(-1).Body.includes(link));
    } else {
      await page.locator('[data-action="admin-hosts"]').click();
      await page.locator('[data-action="admin-guest-access"]').click();
      const form = page.locator('form[data-form="guest-access-admin"]');
      await form.locator('[name="accessAction"]').selectOption("retrieve");
      await form
        .getByLabel("Current administrator password", { exact: true })
        .fill(password);
      await form.getByRole("button", { name: "Continue", exact: true }).click();
      assert.equal(
        await form
          .getByLabel("Private guest sign-in link · administrator only", {
            exact: true,
          })
          .inputValue(),
        link,
      );
      assert.equal(
        await form
          .getByLabel("Current administrator password", { exact: true })
          .inputValue(),
        "",
      );
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 1,
          ),
        );
      }
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(
    "Private guest browser passed: names/Household ID only, SMS proof, remembered sessions, Settings privacy and empty-calendar decoration on phone/desktop.",
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  store.db.close();
}

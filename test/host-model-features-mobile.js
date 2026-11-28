// Synthetic isolated data only; network denied outside loopback.
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
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
const household = store.household(host.household);
store.put(
  "household",
  host.household,
  host.household,
  {
    ...household,
    logo:
      "data:image/png;base64," +
      readFileSync(
        new URL("../public/gather-192.png", import.meta.url),
      ).toString("base64"),
  },
  household.version,
);
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
store.put("event", "archived-event", host.household, {
  ...event,
  title: "Archived gathering",
  date: "2000-01-01",
  invited: [],
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
    const archive = page.locator(".archived-events");
    await archive.locator("summary").waitFor();
    const titleStyle = (el) => {
      const style = getComputedStyle(el);
      return [
        style.fontFamily,
        style.fontSize,
        style.fontStyle,
        style.fontWeight,
        style.color,
        style.letterSpacing,
        style.textTransform,
      ];
    };
    assert.deepEqual(
      await archive.locator("summary").evaluate(titleStyle),
      await page.locator(".hero .eyebrow").evaluate(titleStyle),
    );
    assert.equal(
      await archive.evaluate((el) => el.classList.contains("panel")),
      false,
    );
    await archive.locator("summary").click();
    await archive
      .locator("article.card")
      .getByRole("heading", { name: "Archived gathering" })
      .waitFor();
    await archive.locator("summary").click();

    if (width !== 768) {
      await page.setViewportSize({ width, height: 600 });
      await page.locator('.toolbar [data-action="settings"]').click();
      const details = page.locator("#main .settings-details");
      const labels = [
        "Household Details",
        "Notifications Settings",
        "Change Password",
        "Family Members",
        "Sign Out",
        "Sign Out of Other Devices",
      ];
      assert.deepEqual(
        await page
          .locator("#main .browse-open")
          .allTextContents()
          .then((items) => items.filter((item) => labels.includes(item))),
        labels,
      );
      const signOut = await page
        .locator(".settings-signout > li")
        .evaluateAll((rows) =>
          rows.map((row) => ({ top: row.offsetTop, left: row.offsetLeft })),
        );
      assert.equal(signOut[0].top, signOut[1].top);
      assert.ok(signOut[0].left < signOut[1].left);
      for (const label of labels.slice(0, 4)) {
        await page.getByRole("button", { name: label, exact: true }).click();
        await details
          .getByRole("heading", { name: label, exact: true })
          .waitFor();
        assert.equal(
          await details.evaluate((node) => node === document.activeElement),
          true,
        );
        assert.ok(await page.evaluate(() => scrollY > 0), label);
        assert.equal(await page.locator("dialog[open]").count(), 0);
        if (label === "Household Details") {
          const logo = details.getByRole("img", {
            name: "Current family logo",
          });
          assert.match(
            await logo.getAttribute("src"),
            /^\/api\/display-media\/host\//,
          );
          await logo.evaluate((img) => img.decode());
          assert.equal(await logo.evaluate((img) => img.naturalWidth), 192);
          const logoBox = await logo.boundingBox();
          const removeBox = await details
            .getByText("Remove family logo", { exact: true })
            .boundingBox();
          assert.equal(logoBox.width, 100);
          assert.ok(logoBox.x + logoBox.width <= removeBox.x);
          assert.ok(
            Math.abs(
              logoBox.y +
                logoBox.height / 2 -
                (removeBox.y + removeBox.height / 2),
            ) < 2,
          );
          if (width === 1366) {
            await details.locator("[name=removeLogo]").check();
            await page.locator('[data-action="save-settings"]').click();
            await details
              .getByText("No family logo has been saved.", { exact: true })
              .waitFor();
            assert.equal(await details.locator("[name=removeLogo]").count(), 0);
            await details.locator("[name=familyLogo]").setInputFiles({
              name: "household-logo.png",
              mimeType: "image/png",
              buffer: readFileSync(
                new URL("../public/gather-192.png", import.meta.url),
              ),
            });
            await page.locator('[data-action="save-settings"]').click();
            await logo.waitFor();
            await logo.evaluate((img) => img.decode());
            await details.locator("[name=removeLogo]").waitFor();
          }
        }
        if (label === "Notifications Settings") {
          const start = String(width === 390 ? 9 : 10);
          await details.locator("[name=quietStart]").fill(start);
          await details
            .getByRole("button", { name: "Save", exact: true })
            .click();
          await page
            .getByText("Saved to your household.", { exact: true })
            .waitFor();
          assert.equal(
            await details.locator("[name=quietStart]").inputValue(),
            start,
          );
        }
        if (label === "Change Password")
          assert.match(
            await page
              .getByRole("button", { name: label, exact: true })
              .first()
              .locator("xpath=../preceding-sibling::span")
              .innerHTML(),
            /M5 10h14v11/,
          );
      }
      await details
        .getByRole("button", { name: "Add adult", exact: true })
        .click();
      await details.locator('form[data-form="personal-family"]').waitFor();
      await details
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await details
        .getByRole("button", { name: "Add adult", exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: "Household Details", exact: true })
        .click();
      await details.locator('form[data-form="household"]').waitFor();
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await page.setViewportSize({ width, height: 1000 });
    }
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

  store.put("platform-access", host.user, "platform", {
    email: "host@example.test",
  });
  const promoted = await browser.newPage({
    viewport: { width: 390, height: 600 },
  });
  await promoted.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.abort(),
  );
  await promoted.goto(origin);
  await promoted.locator('[name="email"]').fill("host@example.test");
  await promoted.locator('[name="password"]').fill(password);
  await promoted.getByRole("button", { name: "Sign in", exact: true }).click();
  await promoted.locator('.toolbar [data-action="settings"]').click();
  const adminTools = promoted.getByRole("button", {
    name: "Administrator Tools",
    exact: true,
  });
  await adminTools.click();
  await promoted
    .locator(".settings-details")
    .getByRole("button", { name: "Hosts", exact: true })
    .waitFor();
  assert.equal(await promoted.locator("dialog[open]").count(), 0);
  assert.ok(await promoted.evaluate(() => scrollY > 0));
  await promoted.close();
  console.log(
    "Password-confirmed host administration uses full-page existing controls on mobile",
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  store.db.close();
}

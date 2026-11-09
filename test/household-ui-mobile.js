import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
// Synthetic loopback fixtures only; no provider calls or live accounts.
import assert from "node:assert/strict";
import { once } from "node:events";
import { chromium } from "playwright";
import { Store } from "../server/node-store.js";
import { createApp } from "../server/app.js";
const store = new Store(),
  origin = "http://127.0.0.1:3194",
  password = "Synthetic-household-ui-passphrase";
await store.createAdmin("admin@example.test", password);
store.run(
  "INSERT INTO approvals VALUES(?,?)",
  "host@example.test",
  "synthetic",
);
const host = await store.register({
  email: "host@example.test",
  name: "Sample",
  password,
});
const server = createApp({ store, origin });
server.listen(3194, "127.0.0.1");
await once(server, "listening");
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ||
    (existsSync("/usr/bin/chromium")
      ? "/usr/bin/chromium"
      : chromium.executablePath()),
  args: ["--no-sandbox"],
});
async function api(path, data, cookie, method = "POST") {
  const r = await fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  assert.ok(r.ok, `Fixture operation ${path}: ${r.status}`);
  return {
    body: await r.json(),
    cookie: r.headers.get("set-cookie")?.split(";")[0],
  };
}
try {
  await mkdir("test-results", { recursive: true });
  const login = await api("/api/login", {
    email: "host@example.test",
    password,
  });
  const adult = (
    await api(
      "/api/host/guests",
      {
        first: "Casey",
        last: "Example",
        addressDraft: { label: "Alpha household", lines: "PO Box 12" },
      },
      login.cookie,
    )
  ).body;
  const child = (
    await api(
      "/api/host/guests",
      { first: "Riley", last: "", parent: adult.id, address: adult.address },
      login.cookie,
    )
  ).body;
  const createdEvent = await api(
    "/api/host/events",
    {
      title: "  Indented gathering",
      description: "   Text is here",
      invited: [adult.id, child.id],
      menu: [],
      registries: [],
    },
    login.cookie,
  );
  store.put("response", "synthetic-response", host.household, {
    event: createdEvent.body.id,
    guest: adult.id,
    attendance: { [adult.id]: "yes", [child.id]: "no" },
    claims: {},
    customItems: [],
  });
  for (const width of [390, 1280]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
    });
    const errors = [];
    await context.route("**/*", (route) =>
      route
        .request()
        .url()
        .startsWith(origin + "/")
        ? route.continue()
        : route.abort(),
    );
    await context.addCookies([
      {
        name: login.cookie.split("=")[0],
        value: login.cookie.split("=")[1],
        url: origin,
      },
    ]);
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.setDefaultTimeout(8000);
    await page.goto(origin);
    await page.getByRole("button", { name: "View Event", exact: true }).click();
    await page.getByRole("button", { name: "Invite", exact: true }).click();
    await page.locator("[data-contact-invite]").first().waitFor();
    assert.equal(await page.locator("[data-contact-invite]").count(), 2);
    assert.deepEqual(
      await page
        .locator("[data-contact-kind]")
        .evaluateAll((rows) => rows.map((row) => row.dataset.contactKind)),
      ["adult", "child"],
    );
    await page.locator('.toolbar [data-action="home"]').click();
    await page.getByRole("button", { name: "View Event", exact: true }).click();
    assert.equal(
      await page
        .locator('#main [data-event-section="personal"]')
        .evaluate((el) => el.parentElement.firstElementChild === el),
      true,
    );
    await page.locator('.toolbar [data-action="home"]').click();
    await page.getByRole("button", { name: "RSVPs", exact: true }).click();
    await page.locator(".rsvp-totals").waitFor();
    assert.equal(await page.locator(".rsvp-household").count(), 1);
    assert.equal(await page.locator(".rsvp-household .rsvp-person").count(), 2);
    assert.match(
      await page.locator(".rsvp-household").innerText(),
      /Casey Example[\s\S]*Attending[\s\S]*Riley[\s\S]*Not attending/,
    );
    assert.match(
      await page.locator(".rsvp-totals").innerText(),
      /1 Adults & 1 Children\s+Invited/,
    );
    assert.equal(
      await page.locator(".rsvp-person button").first().innerText(),
      "RSVP",
    );
    await page.screenshot({
      path: `test-results/household-rsvp-${width}.png`,
      fullPage: true,
    });
    await page.locator('#editor [data-action="close"]').click();
    await page.getByRole("button", { name: "View Event", exact: true }).click();
    await page.locator('.toolbar [data-action="settings"]').click();
    await page.locator(".inline-event-details").waitFor();
    const title = page.getByLabel("Event title", { exact: true });
    await title.fill("   Text is here");
    assert.equal(
      await title.evaluate((el) => getComputedStyle(el).color),
      "rgb(17, 17, 17)",
    );
    assert.equal(
      await page
        .locator('.inline-event-details [type="checkbox"][name="invited"]')
        .count(),
      0,
    );
    await page
      .getByRole("button", { name: "Invite guests", exact: true })
      .click();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    assert.equal(
      await page.getByLabel("Event title", { exact: true }).inputValue(),
      "   Text is here",
    );
    await page
      .getByRole("button", { name: "Invite guests", exact: true })
      .click();
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.locator('.toolbar [data-action="home"]').click();
    assert.equal(
      await page.locator('[data-action="event-invite-apply"]').count(),
      1,
    );
    await page.locator('[data-action="event-invite-apply"]').click();
    assert.equal(
      await page.getByLabel("Event title", { exact: true }).inputValue(),
      "   Text is here",
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Delete event", exact: true })
        .isVisible(),
      true,
    );
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(
    "Household UI: phone and desktop grouping, Invite, totals, Plans, editable contrast and draft preservation passed.",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  store.db.close();
}

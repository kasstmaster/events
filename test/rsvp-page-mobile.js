// Isolated loopback fixtures only; no live accounts, providers or messages.
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { Store } from "../server/node-store.js";
import { createApp } from "../server/app.js";
import { enrollGuest } from "./helpers/guest-account.js";
const store = new Store(),
  origin = "http://127.0.0.1:3213",
  password = "Synthetic-rsvp-family-password";
await store.createAdmin("admin@example.test", password);
store.run(
  "INSERT INTO approvals VALUES(?,?)",
  "rsvp@example.test",
  "synthetic",
);
const host = await store.register({
  name: "RSVP Family",
  email: "rsvp@example.test",
  password,
});
const server = createApp({ store, origin });
server.listen(3213, "127.0.0.1");
await once(server, "listening");
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ||
    (existsSync("/usr/bin/chromium")
      ? "/usr/bin/chromium"
      : chromium.executablePath()),
  args: ["--no-sandbox"],
});
async function api(path, data, cookie, method = data ? "POST" : "GET") {
  const response = await fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(data ? { "Content-Type": "application/json" } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  const body = await response.json();
  assert.ok(response.ok, `${path}: ${response.status} ${body.error || ""}`);
  return { body, cookie: response.headers.get("set-cookie")?.split(";")[0] };
}
async function device(cookie, width) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
  });
  await context.route("**/*", (r) =>
    new URL(r.request().url()).origin === origin ? r.continue() : r.abort(),
  );
  await context.addCookies([
    { name: cookie.split("=")[0], value: cookie.split("=")[1], url: origin },
  ]);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(origin);
  return { page, context };
}
try {
  const owner = (
    await api("/api/login", { email: "rsvp@example.test", password })
  ).cookie;
  await api(
    "/api/family/members",
    { name: "Host Child", login: "rsvp.child", password, role: "kid" },
    owner,
  );
  const adult = (
    await api("/api/host/guests", { first: "Casey", last: "Example" }, owner)
  ).body;
  const child = (
    await api(
      "/api/host/guests",
      { first: "Riley", last: "", parent: adult.id },
      owner,
    )
  ).body;
  const event = (
    await api(
      "/api/host/events",
      {
        title: "Shared RSVP Event",
        description: "Synthetic",
        invited: [adult.id, child.id],
        menu: [{ id: "salad", name: "Salad", kind: "potluck", quantity: 2 }],
        registries: [],
        deadline: "2028-06-01",
      },
      owner,
    )
  ).body;
  const guest = (
    await api(
      `/api/public/households/${store.household(host.household).slug}/login`,
      { first: adult.first, last: adult.last, inviteCode: adult.inviteCode },
    )
  ).cookie;
  await enrollGuest(origin, guest, "rsvp.casey");
  for (const width of [390, 768, 1440]) {
    const h = await device(owner, width),
      p = h.page,
      errors = [];
    p.on("pageerror", () => errors.push("script-error"));
    await p.getByRole("button", { name: "RSVPs", exact: true }).click();
    await p.locator(".host-family").waitFor();
    assert.equal(await p.locator(".host-family .rsvp-person").count(), 2);
    await p
      .getByRole("button", { name: "RSVP for your family", exact: true })
      .click();
    const form = p.locator('main form[data-form="rsvp"]');
    await form.waitFor();
    assert.equal(await p.locator("#editor[open]").count(), 0);
    const roster = (
      await api(`/api/host/events/${event.id}/family-rsvp`, undefined, owner)
    ).body;
    for (const member of roster.members)
      await form
        .locator(`[name="attendance:${member.id}"]`)
        .selectOption("yes");
    await form.getByLabel("Quantity for Salad").fill("1");
    assert.equal(
      await p.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      ),
      false,
    );
    if (width === 390) {
      await p.route(
        origin + `/api/host/events/${event.id}/family-rsvp`,
        (route) =>
          route.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({
              error:
                "Your RSVP changed on another device. Reload before saving.",
            }),
          }),
        { times: 1 },
      );
      await form.getByRole("button", { name: "RSVP", exact: true }).click();
      await form
        .locator(".form-error")
        .getByText("Your RSVP changed on another device.", { exact: false })
        .waitFor();
      assert.equal(
        await form
          .locator(`[name="attendance:${roster.members[0].id}"]`)
          .inputValue(),
        "yes",
      );
      assert.equal(store.list("response", host.household).length, 0);
    }
    await form.getByRole("button", { name: "RSVP", exact: true }).click();
    await p.locator(".event-hero").waitFor();
    await p
      .getByText("Your RSVP is saved. Thank you!", { exact: true })
      .waitFor();
    assert.equal(await p.locator('form[data-form="rsvp"]').count(), 0);
    assert.equal(store.totals(event, host.household).invited, 2);
    await p.locator('.toolbar [data-action="home"]').click();
    await p.getByRole("button", { name: "RSVPs", exact: true }).click();
    await p.getByText("Your family: Salad × 1", { exact: true }).waitFor();
    const g = await device(guest, width),
      q = g.page;
    q.on("pageerror", () => errors.push("script-error"));
    await q.getByRole("button", { name: "View Event", exact: true }).click();
    assert.match(
      await q.locator("header .event-summary").innerText(),
      /Attending[\s\S]*2\s+Invited/,
    );
    await q.locator('main [data-action="rsvp"]').click();
    const guestForm = q.locator('main form[data-form="rsvp"]');
    await guestForm.waitFor();
    assert.equal(await q.locator("#editor[open]").count(), 0);
    await guestForm
      .getByLabel("Casey Example", { exact: true })
      .selectOption("yes");
    await guestForm
      .getByLabel("Riley · child", { exact: true })
      .selectOption("yes");
    await guestForm.getByLabel("Quantity for Salad").fill("1");
    assert.equal(
      await q.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      ),
      false,
    );
    await guestForm.getByRole("button", { name: "RSVP", exact: true }).click();
    await q.locator(".event-hero").waitFor();
    await q
      .getByText("Your RSVP is saved. Thank you!", { exact: true })
      .waitFor();
    assert.equal(await q.locator('form[data-form="rsvp"]').count(), 0);
    assert.match(
      await q.locator("header .event-summary").innerText(),
      /4\s+Attending[\s\S]*2\s+Invited/,
    );
    await q.locator('main [data-action="rsvp"]').click();
    await q.locator('form[data-form="rsvp"]').waitFor();
    await q.getByRole("button", { name: "Cancel", exact: true }).click();
    await q.locator(".event-hero").waitFor();
    assert.deepEqual(errors, []);
    await h.context.close();
    await g.context.close();
  }
  console.log(
    "PASS: full-page guest/host-family RSVP, event return, private roster, counts and no overflow at phone/tablet/desktop widths.",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  store.db.close();
}

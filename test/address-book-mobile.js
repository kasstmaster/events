// All fixtures and traffic are isolated loopback; no delivery or live accounts.
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { Store } from "../server/node-store.js";
import { createApp } from "../server/app.js";
import { enrollGuest } from "./helpers/guest-account.js";
const store = new Store(),
  origin = "http://127.0.0.1:3214",
  password = "Synthetic-address-book-password";
await store.createAdmin("admin@example.test", password);
store.run(
  "INSERT INTO approvals VALUES(?,?)",
  "host@example.test",
  "synthetic",
);
const host = await store.register({
  name: "Book Family",
  email: "host@example.test",
  password,
});
const server = createApp({ store, origin });
server.listen(3214, "127.0.0.1");
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
  const r = await fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(data ? { "Content-Type": "application/json" } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  const body = await r.json();
  assert.ok(r.ok, `${path}: ${r.status} ${body.error || ""}`);
  return { body, cookie: r.headers.get("set-cookie")?.split(";")[0] };
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
    await api("/api/login", { email: "host@example.test", password })
  ).cookie;
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
  const keep = (
    await api("/api/host/guests", { first: "Taylor", last: "Keep" }, owner)
  ).body;
  const events = [];
  for (const title of [
    "First Gathering",
    "Second Gathering",
    "Other Gathering",
  ])
    events.push(
      (
        await api(
          "/api/host/events",
          {
            title,
            invited: [adult.id, child.id, keep.id],
            menu: [
              { id: "salad", name: "Salad", kind: "potluck", quantity: 3 },
            ],
            registries: [],
          },
          owner,
        )
      ).body,
    );
  const guest = (
    await api(
      `/api/public/households/${store.household(host.household).slug}/login`,
      { first: adult.first, last: adult.last, inviteCode: adult.inviteCode },
    )
  ).cookie;
  await enrollGuest(origin, guest, "book.casey");
  for (const width of [390, 768, 1440]) {
    await api(
      "/api/host/events/invitations",
      {
        action: "invite",
        guestIds: [adult.id, child.id],
        events: events.slice(0, 2).map((e) => {
          const current = store.get("event", e.id, host.household);
          return { id: e.id, version: current.version };
        }),
      },
      owner,
    );
    for (const [index, event] of events.entries())
      store.put(
        "response",
        `${event.id}:${adult.id}`,
        host.household,
        {
          event: event.id,
          guest: adult.id,
          attendance: {
            [adult.id]: index === 1 ? "no" : "yes",
            [child.id]: index === 1 ? "no" : "yes",
          },
          claims: index === 1 ? {} : { salad: 1 },
          customItems: [],
        },
        store.get("response", `${event.id}:${adult.id}`, host.household)
          ?.version,
      );
    const siblingBefore = store.get(
      "response",
      `${events[2].id}:${adult.id}`,
      host.household,
    );
    const { page: p, context } = await device(owner, width),
      errors = [];
    p.on("pageerror", () => errors.push("script-error"));
    await p.getByRole("button", { name: "Address Book", exact: true }).click();
    assert.equal(await p.locator("[data-contact-invite]").count(), 3);
    assert.equal(
      await p
        .getByRole("button", { name: "Select Contacts", exact: true })
        .count(),
      0,
    );
    for (const name of ["Invite", "Uninvite"])
      assert.ok(
        await p
          .locator(".toolbar")
          .getByRole("button", { name, exact: true })
          .isDisabled(),
      );
    await p.getByLabel("Select Casey Example", { exact: true }).check();
    await p
      .locator(".toolbar")
      .getByRole("button", { name: "Uninvite", exact: true })
      .click();
    await p.locator(".contacts-event-picker").waitFor();
    assert.equal(
      await p
        .getByRole("heading", { name: "Address Book", exact: true })
        .count(),
      0,
    );
    assert.ok(await p.getByLabel("Select Riley", { exact: true }).isChecked());
    await p.locator(".contacts-event-picker > summary").click();
    for (const name of ["First Gathering", "Second Gathering"])
      await p.getByLabel("Event " + name, { exact: true }).check();
    const confirm = p
      .locator("#top-navigation")
      .getByRole("button", { name: "Confirm", exact: true });
    assert.ok(await confirm.isEnabled());
    p.once("dialog", (d) => d.dismiss());
    await confirm.click();
    assert.ok(
      store
        .get("event", events[0].id, host.household)
        .invited.includes(adult.id),
    );
    if (width === 390) {
      const changed = store.get("event", events[1].id, host.household);
      store.put(
        "event",
        changed.id,
        host.household,
        { ...changed, title: changed.title },
        changed.version,
      );
      p.once("dialog", (d) => d.accept());
      await confirm.click();
      await p
        .getByRole("alert")
        .getByText("Event changed.", { exact: false })
        .waitFor();
      assert.ok(
        store
          .get("event", events[0].id, host.household)
          .invited.includes(adult.id),
      );
      assert.ok(
        store.get("response", `${events[0].id}:${adult.id}`, host.household),
      );
      assert.ok(
        await p.getByLabel("Select Casey Example", { exact: true }).isChecked(),
      );
    }
    p.once("dialog", (d) => d.accept());
    await confirm.click();
    await p
      .getByText("Guests uninvited. No messages were sent.", { exact: true })
      .waitFor();
    for (const event of events.slice(0, 2)) {
      assert.deepEqual(store.get("event", event.id, host.household).invited, [
        keep.id,
      ]);
      assert.equal(
        store.get("response", `${event.id}:${adult.id}`, host.household)
          .uninvited,
        true,
      );
    }
    assert.deepEqual(
      store.get("response", `${events[2].id}:${adult.id}`, host.household),
      siblingBefore,
    );
    assert.equal(await p.locator("[data-contact-invite]").count(), 3);
    await p.getByLabel("Select Riley", { exact: true }).check();
    await p
      .locator(".toolbar")
      .getByRole("button", { name: "Invite", exact: true })
      .click();
    await p.locator(".contacts-event-picker > summary").click();
    for (const name of ["First Gathering", "Second Gathering"])
      await p.getByLabel("Event " + name, { exact: true }).check();
    await p
      .locator("#top-navigation")
      .getByRole("button", { name: "Confirm", exact: true })
      .click();
    await p
      .getByText("Guests invited. No messages were sent.", { exact: true })
      .waitFor();
    assert.equal(await p.locator(".contacts-event-picker").count(), 0);
    for (const event of events.slice(0, 2)) {
      assert.equal(
        store.get("event", event.id, host.household).invited.length,
        3,
      );
      assert.equal(
        store.get("response", `${event.id}:${adult.id}`, host.household)
          .uninvited,
        true,
      );
    }
    const overflowing = await p.evaluate(() =>
      [...document.querySelectorAll("body *")]
        .filter((el) => el.getBoundingClientRect().right > innerWidth + 1)
        .map((el) => ({
          tag: el.tagName,
          class: el.className,
          left: el.getBoundingClientRect().left,
          right: el.getBoundingClientRect().right,
        }))
        .slice(0, 12),
    );
    assert.equal(
      await p.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      ),
      false,
      JSON.stringify({ width, overflowing }),
    );
    assert.deepEqual(errors, []);
    await context.close();
  }
  const { page: q, context } = await device(guest, 390);
  await q.locator('[data-home-card="contacts"]').waitFor();
  assert.doesNotMatch(
    await q
      .locator("article.card")
      .filter({
        has: q.getByRole("heading", { name: "First Gathering", exact: true }),
      })
      .innerText(),
    /RSVP saved/,
  );
  assert.equal(
    await q
      .getByRole("button", { name: "Review shared guest links", exact: true })
      .count(),
    0,
  );
  await q.getByRole("button", { name: "Address Book", exact: true }).click();
  await q
    .locator('[data-layout="personalContacts"] [data-address-book-description]')
    .waitFor();
  assert.equal(
    await q.getByRole("button", { name: "Invite", exact: true }).count(),
    0,
  );
  await context.close();
  console.log(
    "PASS: persistent Address Book selection, fixed invitation controls, multi-event invite/uninvite, response removal and guest permissions at phone/tablet/desktop widths.",
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  store.db.close();
}

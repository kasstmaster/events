// Synthetic UI/provider integration. Queueing is intercepted locally; sending is mocked.
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { Store } from "../server/node-store.js";
import { createApp } from "../server/app.js";
import { newCard } from "../public/card-system.js";
import { eviteStatus, prepareEvites, runEvites } from "../server/evites.js";
const store = new Store(),
  origin = "http://127.0.0.1:3199",
  password = "Synthetic-evite-browser-password",
  enabled = {
    SMS_ENABLED: "true",
    TWILIO_ACCOUNT_SID: "synthetic",
    TWILIO_AUTH_TOKEN: "synthetic",
    TWILIO_FROM: "+15005550006",
  };
await store.createAdmin("admin@example.test", password);
store.run(
  "INSERT INTO approvals VALUES(?,?)",
  "evites@example.test",
  "synthetic",
);
const host = await store.register({
  name: "Evite Examples",
  email: "evites@example.test",
  password,
});
const server = createApp({ store, origin });
server.listen(3199, "127.0.0.1");
await once(server, "listening");
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ||
    (existsSync("/usr/bin/chromium")
      ? "/usr/bin/chromium"
      : chromium.executablePath()),
  args: ["--no-sandbox"],
});
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
  assert.ok(r.ok, `Synthetic evite fixture ${path}: ${r.status}`);
  return {
    body: await r.json(),
    cookie: r.headers.get("set-cookie")?.split(";")[0],
  };
}
const click = (p, name) => p.getByRole("button", { name, exact: true }).click();
try {
  const owner = (
    await api("/api/login", { email: "evites@example.test", password })
  ).cookie;
  const a = (
      await api(
        "/api/host/guests",
        { first: "Casey", last: "Example", phone: "+15005550111" },
        owner,
      )
    ).body,
    b = (
      await api(
        "/api/host/guests",
        { first: "Jordan", last: "Example", phone: "+15005550112" },
        owner,
      )
    ).body,
    missing = (
      await api(
        "/api/host/guests",
        { first: "Missing", last: "Example" },
        owner,
      )
    ).body;
  const event = (
    await api(
      "/api/host/events",
      {
        title: "Personal invitation",
        date: "2089-06-12",
        invited: [a.id, b.id, missing.id],
        menu: [],
      },
      owner,
    )
  ).body;
  const card = newCard("Personalized e-vite");
  card.elements[0].field = "recipient.name";
  card.elements.push({
    ...card.elements[1],
    id: "household-code",
    field: "recipient.inviteCode",
    y: 350,
  });
  await api("/api/host/cards", { ...card, event: event.id }, owner);
  let delivered = 0;
  for (const width of [390, 1440]) {
    if (width === 1440) {
      const old = store.get("guest", missing.id, host.household);
      store.put(
        "guest",
        old.id,
        host.household,
        { ...old, phone: "+15005550113" },
        old.version,
      );
    }
    const context = await browser.newContext({
      viewport: { width, height: 950 },
      acceptDownloads: true,
    });
    await context.addCookies([
      { name: owner.split("=")[0], value: owner.split("=")[1], url: origin },
    ]);
    await context.route("**/*", (r) =>
      r
        .request()
        .url()
        .startsWith(origin + "/")
        ? r.continue()
        : r.abort(),
    );
    const p = await context.newPage();
    p.setDefaultTimeout(15000);
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.addInitScript(() =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.__copied = text;
          },
        },
      }),
    );
    let queuedImages;
    await p.route("**/api/host/events/*/evites", async (route) => {
      const req = route.request();
      if (req.method() === "POST") {
        const input = req.postDataJSON();
        input.version = Number(req.headers()["if-match"]);
        queuedImages = input.images;
        const status = prepareEvites(
          store,
          enabled,
          host.household,
          event,
          input,
          origin,
        );
        return route.fulfill({ json: status });
      }
      return route.fulfill({
        json: eviteStatus(store, host.household, event, enabled),
      });
    });
    await p.goto(origin);
    await click(p, "Open Cards & Invites");
    await p
      .locator("li")
      .filter({ hasText: "Personalized e-vite" })
      .getByRole("button", { name: "Open", exact: true })
      .click();
    await click(p, "Text E-vites");
    await p
      .getByRole("heading", { name: "Missing phone numbers", exact: true })
      .waitFor();
    if (width === 390) {
      await click(p, "Copy list");
      assert.match(await p.evaluate(() => window.__copied), /Missing Example/);
      const pending = p.waitForEvent("download");
      await click(p, "Download list");
      assert.match(
        await readFile(await (await pending).path(), "utf8"),
        /Missing Example/,
      );
      p.once("dialog", (d) => d.accept());
      await click(p, "Send E-vites");
      await p
        .locator("li")
        .filter({ hasText: /Casey Example.*Queued/ })
        .waitFor();
      assert.deepEqual(
        new Set(Object.keys(queuedImages)),
        new Set([a.id, b.id]),
      );
      assert.notEqual(queuedImages[a.id], queuedImages[b.id]);
    } else {
      assert.equal(
        await p
          .getByRole("button", {
            name: "Send to newly added phone numbers",
            exact: true,
          })
          .isEnabled(),
        true,
      );
      p.once("dialog", (d) => d.accept());
      await click(p, "Send to newly added phone numbers");
      await p
        .locator("li")
        .filter({ hasText: /Missing Example.*Queued/ })
        .waitFor();
      assert.deepEqual(Object.keys(queuedImages), [missing.id]);
    }
    await runEvites(store, enabled, {
      fetcher: async () =>
        Response.json(
          { sid: "synthetic-delivery-" + ++delivered },
          { status: 201 },
        ),
    });
    await p
      .locator("li")
      .filter({ hasText: /Casey Example.*Accepted by provider/ })
      .waitFor();
    assert.ok(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    assert.deepEqual(errors, []);
    await context.close();
  }
  assert.equal(delivered, 3);
  assert.equal(store.list("response", host.household).length, 0);
  assert.deepEqual(store.get("event", event.id, host.household), event);
  console.log(
    "E-vite browser passed: personalized PNGs, missing-phone copy/download, live receipts, eligible resend and unchanged invitations/RSVPs at phone/desktop widths; mocked sending only.",
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  store.db.close();
}

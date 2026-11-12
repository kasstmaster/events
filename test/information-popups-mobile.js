import { enrollGuest } from "./helpers/guest-account.js";
// Synthetic loopback fixtures only. Instructions are plain text; guest viewing performs no writes.
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { Store } from "../server/node-store.js";
import { createApp } from "../server/app.js";
const store = new Store(),
  origin = "http://127.0.0.1:3196",
  password = "Synthetic-popup-test-passphrase";
await store.createAdmin("admin@example.test", password);
store.run(
  "INSERT INTO approvals VALUES(?,?)",
  "popup@example.test",
  "synthetic",
);
const host = await store.register({
  name: "Popup Example",
  email: "popup@example.test",
  password,
});
const server = createApp({ store, origin });
server.listen(3196, "127.0.0.1");
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
  assert.ok(r.ok, `Fixture ${path}: ${r.status}`);
  return {
    body: await r.json(),
    cookie: r.headers.get("set-cookie")?.split(";")[0],
  };
}
async function page(cookie, width) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
  });
  await context.addCookies([
    { name: cookie.split("=")[0], value: cookie.split("=")[1], url: origin },
  ]);
  await context.route("**/*", (r) =>
    r
      .request()
      .url()
      .startsWith(origin + "/")
      ? r.continue()
      : r.abort(),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(origin);
  return { context, page };
}
async function highlight(page) {
  await page.locator("[data-information-input]").evaluate((el) => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode,
        start = node.textContent.indexOf("Liar's Dice");
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + 11);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    throw Error("Game text missing");
  });
}
try {
  const owner = (
    await api("/api/login", { email: "popup@example.test", password })
  ).cookie;
  const guest = (
    await api("/api/host/guests", { first: "Casey", last: "Example" }, owner)
  ).body;
  const event = (
    await api(
      "/api/host/events",
      {
        title: "Game night",
        description: "Synthetic",
        invited: [guest.id],
        menu: [],
        registries: [],
        information: [{ text: "Liar's Dice" }],
      },
      owner,
    )
  ).body;
  const signed = (
    await api(
      `/api/public/households/${store.household(host.household).slug}/login`,
      { first: guest.first, last: guest.last, inviteCode: guest.inviteCode },
    )
  ).cookie;
  await enrollGuest(origin, signed, "popup.casey");
  const instructions =
    'Roll five dice.\nKeep them hidden. <img src=x onerror="alert(1)">';
  for (const width of [390, 1280]) {
    const hostView = await page(owner, width),
      p = hostView.page,
      errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.getByRole("button", { name: "View Event", exact: true }).click();
    // Keep the first Settings read pending to exercise slow CI/network timing.
    let releaseSettings;
    const settingsGate = new Promise((resolve) => {
      releaseSettings = resolve;
    });
    await p.route(
      origin + "/api/family",
      async (route) => {
        await settingsGate;
        await route.continue();
      },
      { times: 1 },
    );
    const settingsRequest = p.waitForRequest(origin + "/api/family");
    await p.locator('.toolbar [data-action="settings"]').click();
    const tools = p.getByRole("toolbar", {
      name: "Information formatting",
      exact: true,
    });
    try {
      await settingsRequest;
      assert.equal(
        await tools.count(),
        0,
        "Settings remains pending until its data arrives",
      );
    } finally {
      releaseSettings();
    }
    // allTextContents() takes an immediate snapshot; unlike click(), it does
    // not wait for an asynchronously rendered toolbar or its buttons.
    await tools
      .getByRole("button", { name: "Pop-up text", exact: true })
      .waitFor({ state: "visible" });
    await tools
      .getByRole("button", { name: "Add link", exact: true })
      .waitFor({ state: "visible" });
    const actions = await tools.locator("button").allTextContents();
    assert.ok(actions.includes("Pop-up text"), "Pop-up text action exists");
    assert.ok(actions.includes("Add link"), "Add link action exists");
    assert.equal(
      actions.indexOf("Pop-up text") + 1,
      actions.indexOf("Add link"),
    );
    await tools
      .getByRole("button", { name: "Pop-up text", exact: true })
      .click();
    await p
      .getByText("Highlight the words that should open the pop-up first.", {
        exact: true,
      })
      .waitFor();
    assert.equal(
      await p
        .locator(".information-error")
        .evaluate((el) => getComputedStyle(el).backgroundColor),
      "rgba(0, 0, 0, 0)",
    );
    await highlight(p);
    await tools
      .getByRole("button", { name: "Pop-up text", exact: true })
      .click();
    await p
      .getByRole("textbox", { name: "Pop-up text", exact: true })
      .fill(instructions);
    await p.getByRole("button", { name: "Apply pop-up", exact: true }).click();
    await p.locator('#top-navigation [data-action="save-settings"]').click();
    await p.getByText("Event saved.", { exact: true }).waitFor();
    const saved = store.get("event", event.id, host.household);
    assert.equal(
      saved.information.find((run) => run.popup)?.popup,
      instructions,
    );
    const guestView = await page(signed, width),
      g = guestView.page;
    g.on("pageerror", (e) => errors.push(e.message));
    await g
      .getByRole("heading", { name: "Casey Example", exact: true })
      .waitFor();
    assert.equal(
      await g.evaluate(() => getComputedStyle(document.body).backgroundColor),
      "rgb(21, 23, 25)",
    );
    const home = await api("/api/guest", undefined, signed);
    assert.equal(
      await g
        .locator("article.card")
        .evaluate((el) => el.style.getPropertyValue("--bg")),
      home.body.events[0].invitingHousehold.ui.design.background,
    );
    await g.getByRole("button", { name: "View Event", exact: true }).click();
    const trigger = g.getByRole("button", { name: "Liar's Dice", exact: true });
    await trigger.click();
    const dialog = g.getByRole("dialog");
    await dialog
      .getByRole("heading", { name: "Liar's Dice", exact: true })
      .waitFor();
    assert.equal(
      await dialog.locator(".information-popup-content").innerText(),
      instructions,
    );
    assert.equal(await dialog.locator("img").count(), 0);
    await dialog
      .getByRole("button", { name: "Close editor", exact: true })
      .click();
    await trigger.focus();
    await trigger.press("Enter");
    await dialog.waitFor();
    await dialog
      .getByRole("button", { name: "Close editor", exact: true })
      .click();
    assert.equal(store.list("response", host.household).length, 0);
    assert.deepEqual(errors, []);
    await p.getByRole("button", { name: "Back", exact: true }).click();
    await p.locator('.toolbar [data-action="settings"]').click();
    await highlight(p);
    await tools
      .getByRole("button", { name: "Pop-up text", exact: true })
      .click();
    assert.equal(
      await p
        .getByRole("textbox", { name: "Pop-up text", exact: true })
        .inputValue(),
      instructions,
    );
    await p.getByRole("button", { name: "Remove pop-up", exact: true }).click();
    await p.locator('#top-navigation [data-action="save-settings"]').click();
    await p.getByText("Event saved.", { exact: true }).waitFor();
    assert.ok(
      store
        .get("event", event.id, host.household)
        .information.every((run) => !run.popup),
    );
    await hostView.context.close();
    await guestView.context.close();
  }
  console.log(
    "Information pop-ups: mobile/desktop selected-text creation, ordering, persistence, keyboard activation, escaping, removal and guest read-only behavior passed.",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  store.db.close();
}

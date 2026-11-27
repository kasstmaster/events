// Pixel-for-pixel comparison with approved main assets; synthetic local data only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { Store } from "../server/node-store.js";
import { createApp } from "../server/app.js";
const approved = "9cf6eb19be051ff3193384b947d02e918714ce90",
  store = new Store();
await store.createAdmin("admin@example.test", "Synthetic-design-only-password");
store.run(
  "INSERT INTO approvals VALUES(?,?)",
  "host@example.test",
  "synthetic",
);
const host = await store.register({
  email: "host@example.test",
  password: "Synthetic-design-only-password",
  name: "Design Fixture",
});
const event = store.put("event", "design-event", host.household, {
  title: "Unchanged approved event",
  description: "Same layout and typography",
  date: "2027-01-12",
  time: "Two O'Clock",
  address: "Synthetic venue",
  deadline: "",
  invited: [],
  menu: [],
  registries: [],
  information: [],
  design: {},
});
const baselineAssets = new Map();
const servers = [3230, 3231].map((port, index) => {
  const origin = `http://127.0.0.1:${port}`;
  const server = createApp({
    store,
    origin,
    readAsset: index
      ? (file) => readFile(new URL(`../public/${file}`, import.meta.url))
      : async (file) => {
          if (!baselineAssets.has(file))
            baselineAssets.set(
              file,
              execFileSync("git", ["show", `${approved}:public/${file}`]),
            );
          return baselineAssets.get(file);
        },
  });
  server.listen(port, "127.0.0.1");
  return { server, origin, port };
});
await Promise.all(servers.map(({ server }) => once(server, "listening")));
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ||
    (existsSync("/usr/bin/chromium")
      ? "/usr/bin/chromium"
      : chromium.executablePath()),
  args: ["--no-sandbox"],
});
try {
  for (const width of [390, 1366]) {
    const pairs = [];
    for (const { origin } of servers) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        reducedMotion: "reduce",
      });
      const auth = store.newSession(
        { user: host.user, household: host.household, role: "host" },
        origin,
      );
      await context.addCookies([
        { name: "events_session", value: auth.token, url: origin },
      ]);
      const page = await context.newPage();
      await page.goto(origin);
      await page.locator('[data-action="open-event"]').first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      pairs.push({ context, page });
    }
    async function compare(label) {
      const screenshots = await Promise.all(
        pairs.map(async ({ page }) => {
          await page.evaluate(() => document.fonts.ready);
          return page.screenshot({
            fullPage: true,
            animations: "disabled",
            caret: "hide",
          });
        }),
      );
      assert.equal(
        createHash("sha256").update(screenshots[0]).digest("hex"),
        createHash("sha256").update(screenshots[1]).digest("hex"),
        `${label} approved screenshot at ${width}px`,
      );
    }
    // The Home section heading and archived-event placement are intentionally
    // different in this release. Preserve the established hero treatment and
    // compare the otherwise unchanged Event and Address Book pixel-for-pixel.
    for (const { page } of pairs) {
      await page.locator(".hero .eyebrow").waitFor();
    }
    const heroScreenshots = await Promise.all(
      pairs.map(({ page }) =>
        page.locator(".hero").screenshot({ animations: "disabled" }),
      ),
    );
    assert.equal(
      createHash("sha256").update(heroScreenshots[0]).digest("hex"),
      createHash("sha256").update(heroScreenshots[1]).digest("hex"),
      "Home hero appearance remains unchanged",
    );
    const updatedHome = pairs[1].page;
    await updatedHome
      .locator(".home-invitations > .eyebrow")
      .getByText("Your events", { exact: true })
      .waitFor();
    for (const { page } of pairs)
      await page
        .locator(`[data-action="open-event"][data-id="${event.id}"]`)
        .first()
        .click();
    await compare("Event");
    for (const { page } of pairs)
      await page.locator('[data-action="home"]').first().click();
    for (const { page } of pairs)
      await page.locator('[data-action="addresses"]').first().click();
    await compare("Address Book");
    for (const { context } of pairs) await context.close();
    console.log(
      `Approved main pixel comparison passed: Home, Event, Address Book at ${width}px`,
    );
  }
} finally {
  await browser.close();
  await Promise.all(
    servers.map(
      ({ server }) => new Promise((resolve) => server.close(resolve)),
    ),
  );
  store.db.close();
}

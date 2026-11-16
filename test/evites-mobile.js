// Outbound e-vites are retired; manual card export is covered by cards-mobile.js.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { application } from "./helpers/application.js";
await test(
  "retired outbound actions are absent without changing event content",
  { timeout: 45000 },
  async (t) => {
    const f = await application(t),
      host = await f.host("Manual"),
      event = await f.event(host, [], { title: "Manual invitation gathering" });
    const browser = await chromium.launch({
      headless: true,
      executablePath:
        process.env.CHROMIUM_PATH ||
        (existsSync("/usr/bin/chromium")
          ? "/usr/bin/chromium"
          : chromium.executablePath()),
      args: ["--no-sandbox"],
    });
    t.after(() => browser.close());
    const context = await browser.newContext();
    t.after(() => context.close());
    await context.addCookies([
      { name: "events_session", value: host.cookie.split("=")[1], url: f.url },
    ]);
    const page = await context.newPage();
    await page.goto(f.url);
    await page.getByText(event.title, { exact: true }).waitFor();
    assert.equal(
      await page
        .locator(
          '[data-action="event-action-reminders"],[data-action="evites-open"],[data-action="send-private-link"]',
        )
        .count(),
      0,
    );
    assert.ok(
      await page
        .getByRole("button", { name: "Invitation Cards", exact: true })
        .count(),
    );
    assert.deepEqual(f.store.get("event", event.id, host.household.id), event);
    console.log(
      "PASS: optional outbound controls removed; manual invitation/card entry and event content preserved.",
    );
  },
);

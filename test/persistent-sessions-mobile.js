// Real Chromium profile restarts; virtual HTTPS stays inside isolated loopback fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { deviceFixture, origin, env } from "./helpers/passwordless-device.js";
import { runPasswordlessMessages, authHash } from "../server/passwordless.js";
import { clickNavigation } from "./helpers/navigation.js";
await test(
  "remembered SMS device survives actual browser profile restart and simulated months; Sign Out remains revoked",
  { timeout: 90000 },
  async (t) => {
    let context, directory;
    const errors = [];
    const nativeNow = Date.now;
    t.after(async () => {
      Date.now = nativeNow;
      if (context) await context.close();
      if (directory) await rm(directory, { recursive: true, force: true });
    });
    const f = await deviceFixture(t);
    await f.event(f.host, [], { title: "Remembered event" });
    directory = await mkdtemp(join(tmpdir(), "gather-device-browser-"));
    async function open(width = 390) {
      context = await chromium.launchPersistentContext(directory, {
        headless: true,
        executablePath:
          process.env.CHROMIUM_PATH ||
          (existsSync("/usr/bin/chromium")
            ? "/usr/bin/chromium"
            : chromium.executablePath()),
        args: ["--no-sandbox"],
        viewport: { width, height: 900 },
        serviceWorkers: "block",
      });
      await context.route("**/*", async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        if (url.origin !== origin) return route.abort();
        const response = await fetch(f.url + url.pathname + url.search, {
          method: request.method(),
          headers: await request.allHeaders(),
          body: request.postDataBuffer() || undefined,
          redirect: "manual",
        });
        await route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: Buffer.from(await response.arrayBuffer()),
        });
      });
      const page = context.pages()[0] || (await context.newPage());
      page.setDefaultTimeout(15000);
      page.on("pageerror", () => errors.push("browser-error"));
      await page.goto(origin);
      return page;
    }
    let page = await open();
    await page.getByLabel("First Name", { exact: true }).fill("Alex");
    await page.getByLabel("Last Name", { exact: true }).fill("Example");
    await page.getByLabel("Phone Number", { exact: true }).fill("+15005550121");
    await page
      .getByRole("button", { name: "Send Sign-In Link", exact: true })
      .click();
    await page
      .getByRole("status")
      .filter({ hasText: "If these details" })
      .waitFor();
    let link,
      sends = 0;
    await runPasswordlessMessages(f.store, env, {
      fetcher: async (_url, options) => {
        sends++;
        link = new URLSearchParams(options.body)
          .get("Body")
          .match(/https:\/\/\S+/)[0];
        return Response.json({ sid: "synthetic" });
      },
    });
    assert.equal(sends, 1);
    await page.goto(link);
    await page
      .getByRole("heading", { name: "Remembered event", exact: true })
      .waitFor();
    const cookie = (await context.cookies()).find(
      (c) => c.name === "__Host-events_session",
    );
    assert.ok(cookie);
    assert.equal(cookie.httpOnly, true);
    assert.equal(cookie.secure, true);
    assert.equal(cookie.sameSite, "Strict");
    assert.ok(cookie.expires > nativeNow() / 1000 + 180 * 86400);
    const device = f.store.get(
      "passwordless-session",
      authHash(cookie.value),
      "platform",
    ).deviceId;
    await context.close();
    context = null;
    Date.now = () => nativeNow() + 120 * 86400000;
    page = await open(768);
    await page
      .getByRole("heading", { name: "Remembered event", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Send Sign-In Link", exact: true })
        .count(),
      0,
    );
    const renewed = (await context.cookies()).find(
      (c) => c.name === "__Host-events_session",
    );
    assert.notEqual(renewed.value, cookie.value);
    assert.equal(
      f.store.get("passwordless-session", authHash(renewed.value), "platform")
        .deviceId,
      device,
    );
    assert.equal(sends, 1);
    await context.close();
    context = null;
    page = await open(1440);
    await page
      .getByRole("heading", { name: "Remembered event", exact: true })
      .waitFor();
    await clickNavigation(page, "Settings");
    await page
      .getByRole("button", { name: "Sign out all devices", exact: true })
      .waitFor();
    await page.getByRole("button", { name: "Sign Out", exact: true }).click();
    await page
      .getByRole("button", { name: "Send Sign-In Link", exact: true })
      .waitFor();
    await context.close();
    context = null;
    page = await open();
    await page
      .getByRole("button", { name: "Send Sign-In Link", exact: true })
      .waitFor();
    assert.equal(sends, 1);
    assert.deepEqual(errors, []);
    console.log(
      "PASS: persistent HttpOnly cookie, real profile restarts, simulated 120-day return, safe rotation, phone/tablet/desktop and permanent device sign-out. SMS mocked only.",
    );
  },
);

// Virtual HTTPS origins proxy only to isolated loopback servers. SMS is mocked.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { clickNavigation } from "./helpers/navigation.js";
import { application } from "./helpers/application.js";
import { ensurePersonalProfile } from "../server/personal-accounts.js";
import { identityFor } from "../server/guest-identities.js";
import { runPasswordlessMessages, authHash } from "../server/passwordless.js";
import { newCard } from "../public/card-system.js";
const origin = "https://gather.ilymmd.com";
const env = {
  PASSWORDLESS_ENABLED: "true",
  PASSWORDLESS_ACTIVATION_APPROVED: "true",
  GATHER_UNIVERSAL_ENABLED: "true",
  GATHER_PWA_ENABLED: "true",
  AUTH_SMS_ENABLED: "true",
  SMS_ENABLED: "true",
  TWILIO_ACCOUNT_SID: "synthetic",
  TWILIO_AUTH_TOKEN: "synthetic",
  TWILIO_FROM: "+15005550006",
};
await test(
  "passwordless phone/tablet/desktop flow, household appearance, universal invitations and QR enclosure exports",
  { timeout: 150000 },
  async (t) => {
    const f = await application(t, env, {
        origin,
        householdHosts: new Set(["alpha.ilymmd.com", "beta.ilymmd.com"]),
      }),
      alpha = await f.host("Alpha"),
      beta = await f.host("Beta"),
      guest = await f.guest(alpha),
      other = await f.guest(beta);
    const identity = identityFor(f.store, guest, alpha.household.id).id;
    f.store.run(
      "UPDATE guest_identity_links SET identity=? WHERE household=? AND guest=?",
      identity,
      beta.household.id,
      other.id,
    );
    const proof = f.store.newSession(
      {
        role: "guest",
        household: alpha.household.id,
        guest: guest.id,
        identity,
      },
      origin,
    );
    const { profile } = ensurePersonalProfile(f.store, {
      role: "guest",
      household: alpha.household.id,
      guest: guest.id,
      token: authHash(proof.token),
    });
    const account = f.store.get("person-account", identity, "platform");
    f.store.put(
      "person-account",
      identity,
      "platform",
      { ...account, recoveryPhone: "+15005550123", recoveryVerified: true },
      account?.version,
    );
    const own = ensurePersonalProfile(f.store, {
      role: "host",
      user: alpha.user,
      household: alpha.household.id,
    });
    f.store.put(
      "personal-household",
      own.profile.id,
      "platform",
      {
        ...own.profile,
        members: own.profile.members.map((p) => ({
          ...p,
          first: "Alex",
          last: "Host",
        })),
      },
      own.profile.version,
    );
    const hostGuest = await f.guest(beta, { first: "Alex", last: "Host" });
    f.store.run(
      "UPDATE guest_identity_links SET identity=? WHERE household=? AND guest=?",
      own.identity,
      beta.household.id,
      hostGuest.id,
    );
    const first = await f.event(alpha, [guest], { title: "Alpha celebration" });
    await f.event(beta, [other, hostGuest], { title: "Beta celebration" });
    for (const [host, color] of [
      [alpha, "#dceaf7"],
      [beta, "#eeddaa"],
    ]) {
      const house = f.store.household(host.household.id);
      f.store.put(
        "household",
        house.id,
        house.id,
        { ...house, design: { ...house.design, background: color } },
        house.version,
      );
    }
    const browser = await chromium.launch({
      executablePath:
        process.env.CHROMIUM_PATH ||
        (existsSync("/usr/bin/chromium")
          ? "/usr/bin/chromium"
          : chromium.executablePath()),
      args: ["--no-sandbox"],
    });
    t.after(() => browser.close());
    const context = await browser.newContext({
      viewport: { width: 390, height: 900 },
      serviceWorkers: "block",
      acceptDownloads: true,
    });
    await context.addInitScript(() => {
      window.__printCalls = 0;
      window.print = () => window.__printCalls++;
    });
    const errors = [];
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
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on("pageerror", () => errors.push("browser-error"));
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(origin + "/alpha");
      await page
        .getByRole("button", { name: "Send Sign-In Link", exact: true })
        .waitFor();
      assert.equal(
        await page.evaluate(
          () => getComputedStyle(document.body).backgroundColor,
        ),
        "rgb(220, 234, 247)",
      );
      assert.equal(
        await page
          .getByLabel("Password or Household ID", { exact: true })
          .count(),
        0,
      );
      assert.equal(await page.locator('link[rel="manifest"]').count(), 1);
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
    }
    await page.goto(origin + "/beta");
    await page
      .getByRole("button", { name: "Send Sign-In Link", exact: true })
      .waitFor();
    assert.equal(
      await page.evaluate(
        () => getComputedStyle(document.body).backgroundColor,
      ),
      "rgb(238, 221, 170)",
    );
    await page.goto(origin);
    await page.getByLabel("First Name", { exact: true }).fill("Casey");
    await page.getByLabel("Last Name", { exact: true }).fill("Example");
    await page.getByLabel("Phone Number", { exact: true }).fill("+15005550123");
    await page
      .getByRole("button", { name: "Send Sign-In Link", exact: true })
      .click();
    await page
      .getByRole("status")
      .filter({ hasText: "If these details" })
      .waitFor();
    let link;
    await runPasswordlessMessages(f.store, env, {
      fetcher: async (_url, options) => {
        link = new URLSearchParams(options.body)
          .get("Body")
          .match(/https:\/\/[^\s]+/)[0];
        return Response.json({ sid: "synthetic" });
      },
    });
    assert.ok(link);
    await page.goto(link);
    await page
      .getByRole("button", { name: "View Event", exact: true })
      .first()
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "View Event", exact: true })
        .count(),
      2,
    );
    assert.equal(new URL(page.url()).hash, "");
    assert.equal(
      await page
        .getByRole("heading", { name: "Alpha celebration", exact: true })
        .count(),
      1,
    );
    assert.equal(
      await page
        .getByRole("heading", { name: "Beta celebration", exact: true })
        .count(),
      1,
    );
    const apiView = await page.evaluate(
      async () => await (await fetch("/api/guest")).json(),
    );
    assert.equal(apiView.household.name, "Gather");
    assert.equal(apiView.events.length, 2);
    const stranger = await browser.newContext({ serviceWorkers: "block" });
    await stranger.route("**/*", async (route) => {
      const request = route.request(),
        url = new URL(request.url());
      if (url.origin !== origin) return route.abort();
      const response = await fetch(f.url + url.pathname + url.search, {
        method: request.method(),
        headers: await request.allHeaders(),
        body: request.postDataBuffer() || undefined,
      });
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()),
      });
    });
    const outsider = await stranger.newPage();
    await outsider.goto(link);
    await outsider
      .getByRole("button", { name: "Send Sign-In Link", exact: true })
      .waitFor();
    assert.equal(
      await outsider
        .getByRole("button", { name: "View Event", exact: true })
        .count(),
      0,
    );
    await stranger.close();
    // Existing authorized host session, no extra sign-in or production fixtures.
    const [cookieName, cookieValue] = alpha.cookie.split("=");
    await context.clearCookies();
    await context.addCookies([
      {
        name: cookieName,
        value: cookieValue,
        url: origin,
        secure: true,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    const card = await f.request("/api/host/cards", {
      method: "POST",
      cookie: alpha.cookie,
      data: {
        ...newCard("Enclosure example"),
        event: first.id,
        recipient: guest.id,
      },
    });
    assert.equal(card.status, 201);
    await page.goto(origin);
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await clickNavigation(page, "Settings");
      await clickNavigation(page, "Family Members");
      await page
        .getByRole("heading", { name: "Family", exact: true })
        .waitFor();
      assert.equal(
        await page.locator('form[data-form="personal-family"]').count(),
        0,
      );
      assert.equal(
        await page
          .getByRole("button", { name: "Create sign-in account", exact: true })
          .count(),
        0,
      );
      await page
        .getByRole("button", { name: "Edit", exact: true })
        .first()
        .click();
      await page.getByLabel("First name", { exact: true }).waitFor();
      await clickNavigation(page, "Cancel");
      assert.equal(
        await page.locator('form[data-form="personal-family"]').count(),
        0,
      );
      await clickNavigation(page, "Home");
    }
    await page
      .locator("article.card")
      .filter({ hasText: "Beta celebration" })
      .getByRole("button", { name: "View Event", exact: true })
      .click();
    await page
      .locator(".event-hero h1")
      .getByText("Beta celebration", { exact: true })
      .waitFor();
    assert.equal(
      await page.locator('.toolbar [data-action="invite-guests"]').count(),
      0,
    );
    await page.getByRole("button", { name: "RSVP", exact: true }).click();
    await page
      .locator('form[data-form="rsvp"] select')
      .first()
      .selectOption("yes");
    await page
      .locator('form[data-form="rsvp"]')
      .getByRole("button", { name: "RSVP", exact: true })
      .click();
    await page
      .locator(".event-hero h1")
      .getByText("Beta celebration", { exact: true })
      .waitFor();
    await page.locator('.toolbar [data-action="home"]').click();
    await page
      .getByRole("button", { name: "Open Cards & Invites", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Open", exact: true })
      .first()
      .click();
    await page.getByRole("button", { name: "RSVP cards", exact: true }).click();
    await page
      .getByRole("button", { name: "Generate RSVP cards", exact: true })
      .click();
    await page.locator(".rsvp-enclosure-preview > svg").waitFor();
    assert.equal(
      await page
        .locator(".rsvp-enclosure-preview")
        .getByText("Scan to RSVP", { exact: true })
        .count(),
      1,
    );
    const download = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download SVG", exact: true })
      .click();
    assert.match((await download).suggestedFilename(), /\.svg$/);
    const pngDownload = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download PNG", exact: true })
      .click();
    assert.match((await pngDownload).suggestedFilename(), /\.png$/);
    await page.getByLabel("Copies per recipient", { exact: true }).fill("2");
    await page
      .getByRole("button", {
        name: "Print invitations and RSVP cards",
        exact: true,
      })
      .click();
    const print = page.frameLocator("iframe.print-frame");
    await print.locator(".enclosure > svg").first().waitFor();
    assert.equal(await print.locator(".invitation > svg").count(), 2);
    assert.equal(
      await print.locator("body").evaluate(() => window.__printCalls),
      1,
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: passwordless virtual-HTTPS sign-in, browser binding, household appearance isolation, universal cross-host invitations, PWA metadata and separate QR cards at phone/tablet/desktop sizes. No real SMS.",
    );
  },
);

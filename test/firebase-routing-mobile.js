// Virtual HTTPS origins and isolated SQLite. No real Firebase, SMS or DNS.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { routingFixture, centralOrigin } from "./helpers/firebase-routing.js";
import { token } from "./helpers/firebase.js";
import { referenceFor } from "../server/rsvp-cards.js";
import { clickNavigation } from "./helpers/navigation.js";
await test(
  "central Firebase login preserves branding, host/guest QR authority, device sessions and standalone-browser fallback",
  { timeout: 120000 },
  async (t) => {
    const f = await routingFixture(t);
    const a = await f.event(f.host, [], { title: "Alpha owned gathering" });
    const invited = await f.guest(f.betaHost, {
      first: "Alex",
      last: "Example",
      phone: "+15005550121",
    });
    f.store.run(
      "UPDATE guest_identity_links SET identity=? WHERE household=? AND guest=?",
      f.identity,
      f.betaHost.household.id,
      invited.id,
    );
    const betaEvent = await f.event(f.betaHost, [invited], {
      title: "Beta invited gathering",
    });
    const invitation = referenceFor(
      f.store,
      f.betaHost.household.id,
      betaEvent,
      { id: invited.id, guests: [invited.id] },
    );
    const newGuest = await f.guest(f.betaHost, {
      first: "New",
      last: "Guest",
      phone: "+15005550122",
    });
    const guestEvent = await f.event(f.betaHost, [newGuest], {
      title: "New guest gathering",
    });
    const guestInvitation = referenceFor(
      f.store,
      f.betaHost.household.id,
      guestEvent,
      { id: newGuest.id, guests: [newGuest.id] },
    );
    const house = f.store.household(f.betaHost.household.id);
    f.store.put(
      "household",
      house.id,
      house.id,
      {
        ...house,
        appearanceMode: "custom",
        design: { ...house.design, background: "#eeddaa" },
      },
      house.version,
    );
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
    let sms = 0,
      sdkOrigins = [],
      currentToken = token(f.env),
      blockedRedeem = false;
    const errors = [];
    async function makeContext(standalone = false) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 900 },
        serviceWorkers: "block",
      });
      t.after(() => context.close());
      if (standalone)
        await context.addInitScript(() => {
          const original = window.matchMedia.bind(window);
          window.matchMedia = (query) =>
            query === "(display-mode: standalone)"
              ? {
                  matches: true,
                  media: query,
                  addEventListener() {},
                  removeEventListener() {},
                }
              : original(query);
        });
      await context.route("**/*", async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        if (
          url.hostname === "www.gstatic.com" &&
          url.pathname.endsWith("/firebase-app.js")
        ) {
          sdkOrigins.push(new URL(request.frame().url()).origin);
          return route.fulfill({
            contentType: "text/javascript",
            headers: { "Access-Control-Allow-Origin": "*" },
            body: "export const getApps=()=>[];export const initializeApp=x=>x;",
          });
        }
        if (
          url.hostname === "www.gstatic.com" &&
          url.pathname.endsWith("/firebase-auth.js")
        )
          return route.fulfill({
            contentType: "text/javascript",
            headers: { "Access-Control-Allow-Origin": "*" },
            body: `export const getAuth=()=>({});export const inMemoryPersistence={};export const setPersistence=async()=>{};export class RecaptchaVerifier{clear(){}};export const signOut=async()=>{};export async function signInWithPhoneNumber(){await fetch('/synthetic-code-request',{method:'POST'});return {confirm:async code=>{if(code!=='123456')throw Error('invalid');return {user:{getIdToken:async()=>${JSON.stringify(currentToken)}}};}};}`,
          });
        if (url.pathname === "/synthetic-code-request") {
          assert.equal(url.origin, centralOrigin);
          sms++;
          return route.fulfill({ status: 200, body: "ok" });
        }
        const site = f.sites.get(url.origin);
        if (!site) throw Error("Unexpected external navigation");
        if (
          blockedRedeem &&
          url.origin !== centralOrigin &&
          url.pathname === "/api/passwordless/handoff/redeem"
        )
          return route.fulfill({
            status: 401,
            contentType: "application/json",
            body: JSON.stringify({
              error: "App handoff expired. Continue in your browser.",
            }),
          });
        const response = await fetch(site.url + url.pathname + url.search, {
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
      return context;
    }
    async function sign(
      page,
      first = "Alex",
      last = "Example",
      phone = "+15005550121",
    ) {
      await page.getByLabel("First Name", { exact: true }).fill(first);
      await page.getByLabel("Last Name", { exact: true }).fill(last);
      await page.getByLabel("Phone Number", { exact: true }).fill(phone);
      await page
        .getByRole("button", { name: "Send verification code", exact: true })
        .click();
      await page
        .getByLabel("Verification code", { exact: true })
        .fill("123456");
      await page
        .getByRole("button", { name: "Verify and sign in", exact: true })
        .click();
    }
    const context = await makeContext(),
      page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(f.alpha.origin);
    await page.waitForURL((url) => url.origin === centralOrigin);
    await page.getByLabel("First Name", { exact: true }).waitFor();
    assert.equal(new URL(page.url()).hash, "");
    await page.getByText("Alpha", { exact: true }).first().waitFor();
    await sign(page);
    await page.waitForURL((url) => url.origin === f.alpha.origin);
    await page.getByText(a.title, { exact: true }).waitFor();
    assert.equal(sms, 1);
    for (const width of [768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.reload();
      await page.getByText(a.title, { exact: true }).waitFor();
      assert.equal(new URL(page.url()).origin, f.alpha.origin);
    }
    assert.equal(sms, 1);
    // A different household reuses the valid central session, without a second SMS.
    await page.goto(f.beta.origin + "/invite/" + invitation);
    await page.getByRole("button", { name: "RSVP", exact: true }).waitFor();
    assert.equal(new URL(page.url()).origin, f.beta.origin);
    assert.equal(sms, 1);
    const response = await page.evaluate(async () =>
      (await fetch("/api/session")).json(),
    );
    assert.equal(response.role, "guest");
    // Per-device sign-out also revokes the central handoff source session.
    await clickNavigation(page, "Settings");
    await page.getByRole("button", { name: "Sign Out", exact: true }).click();
    await page.getByLabel("First Name", { exact: true }).waitFor();
    assert.equal(new URL(page.url()).origin, centralOrigin);
    // A new invited guest uses the same central code flow and stays on branded Gather.
    await context.clearCookies();
    currentToken = token(f.env, { uid: "new-guest", phone: "+15005550122" });
    await page.goto(centralOrigin + "/invite/" + guestInvitation);
    await page.getByText("Beta", { exact: true }).first().waitFor();
    await sign(page, "New", "Guest", "+15005550122");
    await page.getByRole("button", { name: "RSVP", exact: true }).waitFor();
    assert.equal(new URL(page.url()).origin, centralOrigin);
    assert.equal(sms, 2);
    // A separate installed-app storage container never inherits the browser's cookies.
    // A failed cross-container handoff remains visible rather than auto-looping/SMS.
    const pwa = await makeContext(true),
      app = await pwa.newPage();
    app.on("pageerror", (e) => errors.push(e.message));
    currentToken = token(f.env, {
      uid: "synthetic-phone-user",
      iat: Math.floor(Date.now() / 1000) + 1,
    });
    blockedRedeem = true;
    f.store.run("DELETE FROM limits WHERE key LIKE 'firebase-start-%'");
    await app.goto(f.alpha.origin);
    await app.waitForURL((url) => url.origin === centralOrigin);
    await sign(app);
    await app
      .getByText("This installed app could not finish sign-in.", {
        exact: false,
      })
      .waitFor();
    assert.equal(new URL(app.url()).origin, f.alpha.origin);
    assert.equal(sms, 3);
    await app
      .getByRole("link", {
        name: "Continue sign-in in your browser",
        exact: true,
      })
      .waitFor();
    assert.deepEqual([...new Set(sdkOrigins)], [centralOrigin]);
    assert.deepEqual(errors, []);
    console.log(
      "PASS: central-only mocked Firebase at phone/tablet/desktop sizes; household branding, host/guest QR handoff, session reuse, sign-out, isolated standalone storage and safe no-loop fallback. Native installed PWA behavior remains unverified.",
    );
  },
);

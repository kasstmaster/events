// Virtual HTTPS and signed synthetic Firebase claims. No Google/Twilio network or SMS.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { firebaseFixture, token } from "./helpers/firebase.js";
import { clickNavigation } from "./helpers/navigation.js";
const origin = "https://gather.ilymmd.com";
await test(
  "Firebase code sign-in, persistent Gather cookie, recovery form and restricted queue at phone/tablet/desktop widths",
  { timeout: 90000 },
  async (t) => {
    const f = await firebaseFixture(t);
    await f.event(f.host, [], { title: "Firebase synthetic gathering" });
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
    let smsRequests = 0;
    const errors = [];
    const context = await browser.newContext({
      viewport: { width: 390, height: 900 },
    });
    t.after(() => context.close());
    const idToken = token(f.env);
    await context.route("**/*", async (route) => {
      const req = route.request(),
        url = new URL(req.url());
      if (
        url.hostname === "www.gstatic.com" &&
        url.pathname.endsWith("/firebase-app.js")
      )
        return route.fulfill({
          contentType: "text/javascript",
          headers: { "Access-Control-Allow-Origin": "*" },
          body: "export const getApps=()=>[];export const initializeApp=x=>x;",
        });
      if (
        url.hostname === "www.gstatic.com" &&
        url.pathname.endsWith("/firebase-auth.js")
      )
        return route.fulfill({
          contentType: "text/javascript",
          headers: { "Access-Control-Allow-Origin": "*" },
          body: `export const getAuth=()=>({});export const inMemoryPersistence={};export const setPersistence=async()=>{};export class RecaptchaVerifier{clear(){}};export const signOut=async()=>{};export async function signInWithPhoneNumber(){await fetch('/synthetic-code-request',{method:'POST'});return {confirm:async code=>{if(code!=='123456')throw Error('invalid');return {user:{getIdToken:async()=>${JSON.stringify(idToken)}}};}};}`,
        });
      if (url.origin !== origin)
        throw Error("Unexpected external browser request");
      if (url.pathname === "/synthetic-code-request") {
        smsRequests++;
        return route.fulfill({ status: 200, body: "ok" });
      }
      const response = await fetch(f.url + url.pathname + url.search, {
        method: req.method(),
        headers: await req.allHeaders(),
        body: req.postDataBuffer() || undefined,
        redirect: "manual",
      });
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()),
      });
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin);
    await page.getByLabel("First Name", { exact: true }).fill("Alex");
    await page.getByLabel("Last Name", { exact: true }).fill("Example");
    await page.getByLabel("Phone Number", { exact: true }).fill("+15005550121");
    await page
      .getByRole("button", { name: "Send verification code", exact: true })
      .click();
    await page.getByLabel("Verification code", { exact: true }).fill("000000");
    await page
      .getByRole("button", { name: "Verify and sign in", exact: true })
      .click();
    await page
      .locator(".form-error")
      .filter({ hasText: "Verification could not be completed" })
      .waitFor();
    await page.getByLabel("Verification code", { exact: true }).fill("123456");
    await page
      .getByRole("button", { name: "Verify and sign in", exact: true })
      .click();
    await page
      .getByText("Firebase synthetic gathering", { exact: true })
      .waitFor();
    const cookie = (await context.cookies()).find(
      (c) => c.name === "__Host-events_session",
    );
    assert.ok(
      cookie?.httpOnly && cookie?.secure && cookie.sameSite === "Strict",
    );
    assert.ok(cookie.expires > Date.now() / 1000 + 180 * 86400);
    for (const width of [768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.reload();
      await page
        .getByText("Firebase synthetic gathering", { exact: true })
        .waitFor();
    }
    assert.equal(smsRequests, 1);
    await clickNavigation(page, "Settings");
    await page
      .getByRole("button", { name: "Sign out all devices", exact: true })
      .waitFor();
    await context.clearCookies();
    await page.goto(origin);
    await page
      .getByRole("button", { name: "Recover Account", exact: true })
      .click();
    await page.getByLabel("First Name", { exact: true }).fill("Alex");
    await page.getByLabel("Last Name", { exact: true }).fill("Example");
    await page
      .getByLabel("Household ID", { exact: true })
      .fill(f.profile.publicCode);
    await page
      .getByRole("button", { name: "Submit recovery request", exact: true })
      .click();
    await page
      .getByRole("status")
      .filter({ hasText: "Your request has been received" })
      .waitFor();
    const adminValue = f.admin.split("=")[1];
    await context.addCookies([
      {
        name: "__Host-events_session",
        value: adminValue,
        url: origin,
        secure: true,
        httpOnly: true,
        sameSite: "Strict",
      },
    ]);
    await page.goto(origin);
    await page.getByRole("button", { name: "Hosts", exact: true }).click();
    await page
      .getByRole("button", { name: "Account Recovery", exact: true })
      .click();
    await page
      .getByLabel("Current administrator password", { exact: true })
      .fill(f.password);
    await page
      .getByRole("button", { name: "Review recovery requests", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Alex Example", exact: true })
      .waitFor();
    for (const width of [390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth + 1,
        ),
        false,
      );
    }
    assert.deepEqual(errors, []);
    console.log(
      "PASS: mocked Firebase code verification, server binding, persistent cookie, no repeat SMS, recovery form, restricted admin queue and responsive layout. Native Safari/PWA and live Firebase remain unverified.",
    );
  },
);

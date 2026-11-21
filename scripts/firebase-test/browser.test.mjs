// Offline regression of the exact harness. All Google SDK/provider traffic is mocked.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { chromium } from "playwright";
import { validateConfig, NetworkPolicy, PROJECT, CENTRAL } from "./policy.mjs";
import { isolatedFixture } from "./fixture.mjs";
import { attachBrowser, checks, showEvent, openHousehold } from "./browser.mjs";
import { token, firebaseFetcher } from "../../test/helpers/firebase.js";
for (const scenario of ["guest", "host"]) {
  await test(
    `${scenario} isolated harness uses official test mode, blocks other numbers and survives profile restart before revocation/cleanup`,
    { timeout: 90000 },
    async () => {
      const config = validateConfig({
        projectId: PROJECT,
        authDomain: PROJECT + ".firebaseapp.com",
        apiKey: "AIza" + "x".repeat(35),
        fictionalPhoneNumbers: ["+15005550121"],
        acknowledgeFirebaseFictionalNumbers: true,
        acknowledgeProviderTestUserRecord: true,
      });
      const policy = new NetworkPolicy(config),
        backend = policy.backendFetch.bind(policy);
      policy.backendFetch = (url, options) =>
        backend(url, options, firebaseFetcher);
      const fixture = await isolatedFixture(config, { policy, scenario });
      let context;
      const blocked = [];
      let network = 0;
      const idToken = token(
        { FIREBASE_PROJECT_ID: PROJECT },
        { uid: "fictional-test-uid", phone: config.fictionalPhoneNumbers[0] },
      );
      const offlineSdk = async (request) => {
        const url = new URL(request.url());
        if (url.pathname.endsWith("/firebase-app.js"))
          return {
            contentType: "text/javascript",
            headers: { "Access-Control-Allow-Origin": "*" },
            body: "export const getApps=()=>[];export const initializeApp=(options)=>({options});",
          };
        if (url.pathname.endsWith("/firebase-auth.js"))
          return {
            contentType: "text/javascript",
            headers: { "Access-Control-Allow-Origin": "*" },
            body: `
   export const getAuth=app=>({app,settings:{}});export const inMemoryPersistence={};export const setPersistence=async()=>{};export const signOut=async()=>{};
   export class RecaptchaVerifier {constructor(auth){this.auth=auth;this.type='recaptcha';}clear(){}async verify(){return this.auth.settings.appVerificationDisabledForTesting?'a'.repeat(50):'live-recaptcha-proof';}}
   export async function signInWithPhoneNumber(auth,phone,verifier){
    if(!auth.settings.appVerificationDisabledForTesting)throw Error('Real-send mode must not be used');
    const value=await verifier.verify();
    const sent=await fetch('https://identitytoolkit.googleapis.com/v1/accounts:sendVerificationCode?key='+auth.app.options.apiKey,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phoneNumber:phone,recaptchaToken:value,clientType:"CLIENT_TYPE_WEB",captchaResponse:"NO_RECAPTCHA",recaptchaVersion:"RECAPTCHA_ENTERPRISE"})});
    const {sessionInfo}=await sent.json();
    return {confirm:async code=>{
     const result=await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPhoneNumber?key='+auth.app.options.apiKey,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionInfo,code})});
     const data=await result.json();if(!data.idToken)throw Error('Invalid code');
     return {user:{getIdToken:async()=>{const r=await fetch('https://securetoken.googleapis.com/v1/token?key='+auth.app.options.apiKey,{method:'POST',body:new URLSearchParams({grant_type:'refresh_token',refresh_token:data.refreshToken})});return (await r.json()).id_token;}}};
    }};
   }`,
          };
        return null;
      };
      const transport = async (_route, request) => {
        network++;
        const url = new URL(request.url());
        let value;
        if (url.pathname.endsWith(":sendVerificationCode"))
          value = { sessionInfo: "synthetic-phone-session" };
        else if (url.pathname.endsWith(":signInWithPhoneNumber")) {
          const body = JSON.parse(request.postData());
          value =
            body.code === "123456"
              ? { idToken, refreshToken: "synthetic-refresh" }
              : { error: { message: "INVALID_CODE" } };
        } else if (url.hostname === "securetoken.googleapis.com")
          value = { id_token: idToken, refresh_token: "synthetic-refresh" };
        else throw Error("Unexpected test transport");
        return {
          status: () => 200,
          body: async () => Buffer.from(JSON.stringify(value)),
          headers: () => ({
            "content-type": "application/json",
            "access-control-allow-origin": "*",
          }),
        };
      };
      const launch = async () =>
        chromium.launchPersistentContext(fixture.profile, {
          headless: true,
          executablePath:
            process.env.CHROMIUM_PATH ||
            (existsSync("/usr/bin/chromium")
              ? "/usr/bin/chromium"
              : chromium.executablePath()),
          viewport: { width: 390, height: 900 },
          serviceWorkers: "block",
          args: ["--no-sandbox"],
        });
      try {
        context = await launch();
        let control = await attachBrowser(context, fixture, {
            offlineSdk,
            transport,
            report: (code) => blocked.push(code),
          }),
          page = context.pages()[0];
        await page.goto(CENTRAL + "/__harness/recaptcha");
        await page.getByRole("button", { name: "Check reCAPTCHA" }).click();
        await control.captchaCompleted;
        assert.equal(policy.sends, 0);
        await page.goto(fixture.entry);
        await page
          .getByLabel("First Name", { exact: true })
          .fill(fixture.actor.first);
        await page
          .getByLabel("Last Name", { exact: true })
          .fill(fixture.actor.last);
        await page
          .getByLabel("Phone Number", { exact: true })
          .fill("+15005550122");
        await page
          .getByRole("button", { name: "Send verification code", exact: true })
          .click();
        await page
          .locator(".form-error")
          .filter({ hasText: "Isolated test request blocked" })
          .waitFor();
        assert.equal(network, 0);
        await page
          .getByLabel("Phone Number", { exact: true })
          .fill(config.fictionalPhoneNumbers[0]);
        await page
          .getByRole("button", { name: "Send verification code", exact: true })
          .click();
        await page
          .getByLabel("Verification code", { exact: true })
          .fill("123456");
        await page
          .getByRole("button", { name: "Verify and sign in", exact: true })
          .click();
        await showEvent(page);
        const result = await checks(page, fixture);
        assert.equal(result.sendCount, 1);
        assert.equal(network, 3);
        await page.reload();
        await showEvent(page);
        await context.close();
        context = await launch();
        await attachBrowser(context, fixture, {
          offlineSdk,
          transport,
          report: (code) => blocked.push(code),
        });
        page = context.pages()[0];
        await openHousehold(
          page,
          fixture.records[0],
          scenario === "host" ? "host" : "guest",
        );
        assert.equal(policy.sends, 1);
        const old = await context.cookies();
        await page.evaluate(() =>
          fetch("/api/logout", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          }),
        );
        for (const [origin, site] of fixture.sites) {
          const value = old.find(
            (c) =>
              c.name === "__Host-events_session" &&
              c.domain === new URL(origin).hostname,
          );
          if (!value) continue;
          const r = await fetch(site.url + "/api/session", {
            headers: {
              Origin: origin,
              Cookie: "__Host-events_session=" + value.value,
            },
          });
          assert.ok(!(await r.json()).role);
        }
        await page.reload();
        await page.getByLabel("First Name", { exact: true }).waitFor();
        assert.equal(policy.sends, 1);
        assert.deepEqual(blocked, []);
      } finally {
        await context?.close();
        await fixture.close();
      }
      await assert.rejects(access(fixture.directory));
      console.log(
        "PASS: offline provider-policy, fictional-only SDK shim, temporary two-household identity, real profile restart, revocation and cleanup; no live Google request.",
      );
    },
  );
}

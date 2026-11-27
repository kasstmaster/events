// Only synthetic local fixtures. No production pages, users, or providers.
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { createApp } from "../server/app.js";
import { chromium } from "playwright";
import { application, password } from "./helpers/application.js";
import {
  addressBookCheckpoint,
  isolateAddressBook,
} from "../server/recipient-isolation.js";
import { publicEventReference } from "../server/public-invitations.js";
const mode = {
  HOST_ONLY_MODEL_ENABLED: "true",
  HOST_ONLY_MODEL_ACTIVATION_APPROVED: "true",
};
test(
  "startup validates Firebase once, keeps navigation in-document, and renders before private hydration",
  { timeout: 60000 },
  async (t) => {
    const appOrigin = "https://gather.ilymmd.com",
      project = "synthetic-startup",
      uid = "startup-host",
      email = "startup@example.test",
      { privateKey, publicKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
      }),
      jwk = { ...publicKey.export({ format: "jwk" }), kid: "startup-fixture" };
    const seconds = Math.floor(Date.now() / 1000);
    const encoded = (value) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const claims = encoded({
      aud: project,
      iss: "https://securetoken.google.com/" + project,
      sub: uid,
      email,
      email_verified: true,
      iat: seconds,
      exp: seconds + 3600,
      auth_time: seconds,
      firebase: { sign_in_provider: "password" },
    });
    const signed = encoded({ alg: "RS256", kid: jwk.kid }) + "." + claims;
    const token =
      signed +
      "." +
      sign("RSA-SHA256", Buffer.from(signed), privateKey).toString("base64url");
    let lookups = 0,
      disabled = false;
    const f = await application(
      t,
      {
        ...mode,
        HOST_FIREBASE_ENABLED: "true",
        HOST_FIREBASE_ACTIVATION_APPROVED: "true",
        FIREBASE_PROJECT_ID: project,
        FIREBASE_API_KEY: "AIza" + "a".repeat(35),
        FIREBASE_AUTH_DOMAIN: project + ".firebaseapp.com",
        HOST_FIREBASE_ADMIN_CLIENT_EMAIL:
          "startup@synthetic-startup.iam.gserviceaccount.com",
        HOST_FIREBASE_ADMIN_PRIVATE_KEY: privateKey.export({
          type: "pkcs8",
          format: "pem",
        }),
      },
      {
        origin: appOrigin,
        firebaseFetcher: async (url) => {
          if (url.includes("/jwk/")) return Response.json({ keys: [jwk] });
          if (url === "https://oauth2.googleapis.com/token")
            return Response.json({
              access_token: "fixture",
              token_type: "Bearer",
              expires_in: 3600,
            });
          assert.match(url, /accounts:lookup/);
          if (url.includes("/projects/")) lookups++;
          await delay(120);
          return Response.json({
            users: [{ localId: uid, email, emailVerified: true, disabled }],
          });
        },
      },
    );
    const host = await f.host("Startup");
    isolateAddressBook(
      f.store,
      host.household.id,
      addressBookCheckpoint(f.store, host.household.id).fingerprint,
      "synthetic",
    );
    const connected = await f.request("/api/host-auth/firebase", {
      method: "POST",
      data: { intent: "connect", idToken: token, currentPassword: password },
    });
    assert.equal(connected.status, 200);
    for (let index = 0; index < 250; index++) {
      f.store.put("guest", "startup-contact-" + index, host.household.id, {
        first: "Synthetic",
        last: "Contact " + index,
        parent: "",
        address: "",
      });
    }
    const title = 'Fixture </script><img id="unescaped-event">';
    const event = await f.event({ ...host, cookie: connected.cookie }, [], {
      title,
      date: "2030-05-07",
    });
    // The first response includes readable, escaped host content without
    // waiting for JavaScript. Anonymous documents never contain private events.
    const firstDocument = await f.request("/", { cookie: connected.cookie });
    assert.equal(firstDocument.status, 200);
    assert.match(firstDocument.body, /Your gathering place/);
    assert.ok(
      firstDocument.body.includes(
        'Fixture &lt;/script&gt;&lt;img id=&quot;unescaped-event&quot;&gt;',
      ),
    );
    assert.doesNotMatch(firstDocument.body, /<img id="unescaped-event">/);
    assert.doesNotMatch(firstDocument.body, /Getting things ready/);
    assert.equal(firstDocument.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(firstDocument.body, /data-gather-home/);
    const embeddedPayload = (document) => {
      const [, payload] = document.split(
        '<script id="gather-public-event" type="application/json">',
      );
      return payload?.split("</script>")[0];
    };
    const signedInBootstrap = JSON.parse(embeddedPayload(firstDocument.body));
    assert.equal(signedInBootstrap.session.role, "host");
    assert.equal(signedInBootstrap.host.events[0].id, event.id);
    assert.equal(signedInBootstrap.host.guests, undefined);
    const anonymousDocument = await f.request("/");
    assert.equal(anonymousDocument.status, 200);
    assert.match(anonymousDocument.body, /Welcome to Gather/);
    assert.doesNotMatch(anonymousDocument.body, /Fixture/);
    const anonymousBootstrap = JSON.parse(
      embeddedPayload(anonymousDocument.body),
    );
    assert.equal(anonymousBootstrap.session.role, null);
    assert.equal(anonymousBootstrap.host, undefined);
    const reference = publicEventReference(
      f.store,
      host.household.id,
      event.id,
    );
    const legacy = "a".repeat(43);
    f.store.put("rsvp-reference", legacy, "platform", {
      household: host.household.id,
      event: event.id,
    });
    const requested = [],
      measurements = {},
      backendPaths = {};
    const browser = await chromium.launch({
      executablePath:
        process.env.CHROMIUM_PATH ||
        (existsSync("/usr/bin/chromium")
          ? "/usr/bin/chromium"
          : chromium.executablePath()),
      args: ["--no-sandbox"],
    });
    try {
      const context = await browser.newContext({
        serviceWorkers: "block",
        viewport: { width: 390, height: 844 },
      });
      await context.route("**/*", async (route) => {
        const { origin, pathname } = new URL(route.request().url());
        if (origin === "https://www.gstatic.com") {
          await delay(80);
          const body = pathname.endsWith("/firebase-app.js")
            ? "export const getApps = () => []; export const initializeApp = () => ({});"
            : `const auth = { currentUser: { emailVerified: true, getIdToken: async (force) => {
                if (force) { await new Promise(r => setTimeout(r, 120)); window.sdkExtraReads++; }
                return ${JSON.stringify(token)};
              } } };
              window.sdkExtraReads = 0;
              export const getAuth = () => auth;
              export const inMemoryPersistence = {};
              export const setPersistence = async () => {};
              export const signInWithEmailAndPassword = async () => new Promise(r => setTimeout(r, 120));
              export const reload = async () => { await new Promise(r => setTimeout(r, 120)); window.sdkExtraReads++; };
              export const signOut = async () => {};`;
          return route.fulfill({
            contentType: "text/javascript",
            body,
            headers: { "Access-Control-Allow-Origin": "*" },
          });
        }
        if (origin !== appOrigin) return route.abort();
        if (pathname.startsWith("/api/")) {
          await delay(pathname.endsWith("/pages") ? 700 : 75);
        }
        const request = route.request(),
          headers = await request.allHeaders();
        const response = await fetch(
          f.url + request.url().slice(appOrigin.length),
          {
            method: request.method(),
            headers,
            body: request.postDataBuffer() || undefined,
            redirect: "manual",
          },
        );
        return route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: Buffer.from(await response.arrayBuffer()),
        });
      });
      await context.addInitScript(() => {
        const selectors = {
          login: 'form[data-form="host-login"]',
          home: '[data-action="open-event"]',
          event: '[data-action="rsvp"]',
          denied: "#notice",
        };
        window.startupTrace = { entries: {}, loading: 0, start: 0 };
        let wasLoading = false;
        new MutationObserver(() => {
          const trace = window.startupTrace;
          const loading = Boolean(
            document.querySelector("#app > #main > p:only-child"),
          );
          if (loading && !wasLoading) trace.loading++;
          wasLoading = loading;
          for (const [key, selector] of Object.entries(selectors)) {
            const element = document.querySelector(selector);
            if (
              element &&
              (key !== "denied" ||
                element.textContent.includes(
                  "Private page access is unavailable",
                ))
            )
              trace.entries[key] ??= performance.now() - trace.start;
          }
        }).observe(document, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      const errors = [];
      let documents = 0;
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        const { origin, pathname } = new URL(request.url());
        if (
          request.isNavigationRequest() &&
          request.frame() === page.mainFrame()
        )
          documents++;
        if (origin === appOrigin) requested.push(pathname);
      });
      const measure = async (
        label,
        target,
        action,
        { sameDocument = false, settled } = {},
      ) => {
        requested.length = 0;
        documents = lookups = 0;
        if (sameDocument)
          await page.evaluate(() => {
            window.startupTrace = {
              entries: {},
              loading: 0,
              start: performance.now(),
            };
          });
        await action();
        try {
          await page.waitForFunction(
            (key) => window.startupTrace.entries[key] !== undefined,
            target,
          );
        } catch (error) {
          const message = await page.locator("#main").innerText();
          throw new Error(label + ": " + message + " " + requested.join(", "), {
            cause: error,
          });
        }
        const trace = await page.evaluate(() => window.startupTrace);
        await settled?.();
        const paths = requested.filter(
          (route) =>
            route.startsWith("/api/") &&
            route !== "/api/app/manifest" &&
            route !== "/api/app/icon",
        );
        backendPaths[label] = paths;
        measurements[label] = {
          ms: Math.round(trace.entries[target]),
          api: paths.length,
          lookups,
          loading: trace.loading,
          documents,
        };
      };
      await measure("cold signed out", "login", () => page.goto(appOrigin));
      assert.deepEqual(
        backendPaths["cold signed out"].filter((p) =>
          p.startsWith("/api/startup"),
        ),
        [],
      );
      const coldScripts = requested
        .filter((path) => path.endsWith(".js"))
        .sort();
      await page.locator('[name="email"]').fill(email);
      await page.locator('[name="password"]').fill(password);
      await measure(
        "Firebase sign-in",
        "home",
        () =>
          page.getByRole("button", { name: "Sign in", exact: true }).click(),
        { sameDocument: true },
      );
      const sdkExtraReads = await page.evaluate(() => window.sdkExtraReads);
      await measure("signed-in refresh", "home", () => page.reload());
      assert.deepEqual(
        backendPaths["signed-in refresh"].filter((p) =>
          p.startsWith("/api/startup"),
        ),
        [],
      );
      await page.locator('[data-action="open-event"]').first().click();
      await measure(
        "Home",
        "home",
        () => page.locator('button[data-action="home"]').first().click(),
        { sameDocument: true },
      );
      const slim = await f.request("/api/startup?view=home", {
        cookie: connected.cookie,
      });
      assert.equal(
        f.store.list("invitation-household", host.household.id).length,
        0,
      );
      const full = await f.request("/api/startup", {
        cookie: connected.cookie,
      });
      assert.equal(slim.body.host.guests, undefined);
      assert.equal(full.body.host.guests.length, 250);
      const slimBytes = Buffer.byteLength(JSON.stringify(slim.body));
      const fullBytes = Buffer.byteLength(JSON.stringify(full.body));
      assert.ok(slimBytes < fullBytes);
      t.diagnostic(
        `Host startup JSON with 250 synthetic contacts: ${fullBytes} → ${slimBytes} bytes`,
      );
      assert.equal((await f.request("/api/host/workspace")).status, 401);
      requested.length = 0;
      for (let visit = 0; visit < 2; visit++) {
        await page.locator('[data-action="addresses"]:visible').first().click();
        await page.locator(".address-book-shell").waitFor();
        await page
          .locator('button[data-action="home"]:visible')
          .first()
          .click();
        await page.locator('[data-action="open-event"]').first().waitFor();
      }
      assert.deepEqual(
        requested.filter((path) => path.startsWith("/api/")),
        ["/api/host/workspace"],
      );
      assert.equal(
        requested.includes("/editor-tools.js"),
        false,
        "regular Home and Address Book navigation must not download card editing code",
      );
      await page.evaluate(() => {
        window.originalHomeHero = document.querySelector("#main > .hero");
      });
      await f.event({ ...host, cookie: connected.cookie }, [], {
        title: "Synthetic background update",
        date: "2030-05-08",
      });
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await page
        .getByText("Synthetic background update", { exact: true })
        .waitFor();
      assert.equal(
        await page.evaluate(
          () =>
            document.querySelector("#main > .hero") === window.originalHomeHero,
        ),
        true,
        "event-only background updates preserve the original Home hero node",
      );
      await page.locator('[data-action="cards"]:visible').first().click();
      await page.locator('[data-action="new-card"]:visible').first().waitFor();
      assert.ok(
        requested.includes("/editor-tools.js"),
        "card editing code must load only on first Cards & Invites visit",
      );
      await page.locator('button[data-action="home"]:visible').first().click();
      await page.locator('[data-action="open-event"]').first().waitFor();
      await page.locator('.toolbar [data-action="settings"]').click();
      await measure(
        "sign-out",
        "login",
        () => page.locator('[data-action="logout"]').click(),
        { sameDocument: true },
      );
      const publicPath = "/api/public/events/" + reference;
      await measure("direct public event", "event", () =>
        page.goto(appOrigin + "/event/" + reference),
      );
      await measure("legacy invitation", "event", () =>
        page.goto(appOrigin + "/invite/" + legacy),
      );
      assert.equal(new URL(page.url()).pathname, "/event/" + reference);
      await measure(
        "public event with private grant",
        "event",
        () =>
          page.goto(
            appOrigin +
              "/event/" +
              reference +
              "?fixture=1#private=" +
              "a".repeat(43),
          ),
        {
          settled: () =>
            page.waitForFunction(
              () => window.startupTrace.entries.denied !== undefined,
            ),
        },
      );
      const grantTrace = await page.evaluate(() => window.startupTrace.entries);
      t.diagnostic(JSON.stringify(measurements));
      assert.deepEqual(errors, []);
      assert.deepEqual(coldScripts, ["/app.js", "/auth-bootstrap.js"]);
      assert.deepEqual(backendPaths, {
        "cold signed out": ["/api/startup"],
        "Firebase sign-in": [
          "/api/host-auth/login",
          "/api/host-auth/firebase",
          "/api/startup",
        ],
        "signed-in refresh": ["/api/startup"],
        Home: [],
        "sign-out": ["/api/logout"],
        "direct public event": [],
        "legacy invitation": [],
        "public event with private grant": [publicPath + "/pages"],
      });
      assert.equal(sdkExtraReads, 0);
      assert.ok(grantTrace.event < grantTrace.denied);
      for (const [label, result] of Object.entries(measurements)) {
        const sameDocument = ["Firebase sign-in", "Home", "sign-out"].includes(
          label,
        );
        assert.equal(result.documents, sameDocument ? 0 : 1, label);
        const initialInvitation = /event|invitation/.test(label);
        assert.equal(
          result.loading,
          initialInvitation ? 0 : result.documents,
          label,
        );
      }
      assert.equal(measurements["Firebase sign-in"].lookups, 1);
      assert.equal(measurements["signed-in refresh"].lookups, 1);
      assert.equal(measurements.Home.lookups, 0);
      assert.equal(measurements["sign-out"].lookups, 1);
      // Hold the entry modules so the test can distinguish HTML rendering
      // and preload behavior from a quickly downloaded application.
      const slowPage = await context.newPage();
      const { promise: modulesReady, resolve: releaseModules } =
        Promise.withResolvers();
      await slowPage.route(/\/(?:app|auth-bootstrap)\.js$/, async (route) => {
        await modulesReady;
        await route.fallback();
      });
      try {
        await slowPage.goto(appOrigin + "/event/" + reference, {
          waitUntil: "commit",
        });
        await slowPage
          .getByRole("heading", { name: title, exact: true })
          .waitFor();
        await slowPage.getByText("May 7, 2030", { exact: true }).waitFor();
        assert.equal(await slowPage.locator("#unescaped-event").count(), 0);
        assert.equal(await slowPage.locator('[data-action="rsvp"]').count(), 0);
        const preload = slowPage.waitForRequest(
          (request) => new URL(request.url()).pathname === "/api/startup",
        );
        await slowPage.goto(appOrigin, { waitUntil: "commit" });
        await preload;
      } finally {
        releaseModules();
      }
      await slowPage.locator('form[data-form="host-login"]').waitFor();
      await slowPage.close();
      // A revoked account must not get a private snapshot through the combined endpoint.
      disabled = true;
      const revoked = await f.request("/api/startup", {
        cookie: connected.cookie,
      });
      assert.equal(revoked.status, 200);
      assert.equal(revoked.body.session.role, null);
      assert.equal(revoked.body.host, undefined);
      await page.goto(appOrigin);
      await page.locator('form[data-form="host-login"]').waitFor();
    } finally {
      await browser.close();
    }
  },
);

test(
  "cross-domain host transfers load the complete application only after browser-bound redemption",
  { timeout: 60000 },
  async (t) => {
    const central = "https://gather.ilymmd.com",
      alpha = "https://alpha.ilymmd.com",
      hosts = new Set(["alpha.ilymmd.com"]);
    const f = await application(t, mode, {
        origin: central,
        householdHosts: hosts,
      }),
      host = await f.host("Alpha");
    isolateAddressBook(
      f.store,
      host.household.id,
      addressBookCheckpoint(f.store, host.household.id).fingerprint,
      "synthetic",
    );
    await f.event(host, []);
    const server = createApp({
      store: f.store,
      origin: alpha,
      canonicalOrigin: central,
      householdHostname: "alpha.ilymmd.com",
      householdHosts: hosts,
      env: mode,
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise((r) => server.close(r)));
    const sites = new Map([
      [central, f.url],
      [alpha, "http://127.0.0.1:" + server.address().port],
    ]);
    const browser = await chromium.launch({
      executablePath:
        process.env.CHROMIUM_PATH ||
        (existsSync("/usr/bin/chromium")
          ? "/usr/bin/chromium"
          : chromium.executablePath()),
      args: ["--no-sandbox"],
    });
    try {
      const c = await browser.newContext({ serviceWorkers: "block" });
      await c.addCookies([
        {
          name: host.cookie.split("=")[0],
          value: host.cookie.split("=")[1],
          url: central,
          secure: true,
          httpOnly: true,
        },
      ]);
      const apps = [],
        startup = [],
        documents = [],
        calls = [],
        errors = [];
      await c.route("**/*", async (route) => {
        const request = route.request(),
          url = new URL(request.url()),
          target = sites.get(url.origin);
        if (!target) return route.abort();
        if (url.pathname === "/app.js") apps.push(url.origin);
        if (url.pathname === "/api/startup") startup.push(url.origin);
        if (url.pathname.startsWith("/api/host-auth/handoff/"))
          calls.push(url.pathname);
        const headers = await request.allHeaders();
        delete headers.host;
        const response = await fetch(target + url.pathname + url.search, {
          method: request.method(),
          headers,
          body: request.postDataBuffer() || undefined,
          redirect: "manual",
        });
        await route.fulfill({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: Buffer.from(await response.arrayBuffer()),
        });
      });
      const p = await c.newPage();
      p.setDefaultTimeout(10000);
      p.on("pageerror", (e) => errors.push(e.message));
      p.on("request", (r) => {
        if (r.isNavigationRequest() && r.frame() === p.mainFrame())
          documents.push(new URL(r.url()).origin);
      });
      await p.goto(
        alpha + "/signin#host-transfer-start=" + encodeURIComponent(central),
      );
      await p.locator('[data-action="open-event"]').first().waitFor();
      assert.equal(p.url(), alpha + "/");
      assert.deepEqual(documents, [alpha, central, alpha]);
      assert.deepEqual(apps, [alpha]);
      assert.deepEqual(startup, [alpha]);
      assert.deepEqual(calls, [
        "/api/host-auth/handoff/prepare",
        "/api/host-auth/handoff/authorize",
        "/api/host-auth/handoff/redeem",
      ]);
      assert.equal(
        f.store.list("auth-handoff", "platform").at(-1).state,
        "consumed",
      );
      await p.reload();
      await p.locator('[data-action="open-event"]').first().waitFor();
      assert.equal(calls.length, 3);
      assert.deepEqual(startup, [alpha, alpha]);
      assert.deepEqual(errors, []);
      apps.length = 0;
      const callback = await c.newPage();
      callback.setDefaultTimeout(10000);
      await callback.goto(central + "/signin#host=complete");
      await callback.locator('[data-action="open-event"]').first().waitFor();
      assert.equal(callback.url(), alpha + "/");
      assert.deepEqual(apps, [alpha]);
      assert.equal(calls.length, 6);
      const sourceCookie = (await c.cookies(central)).find(
        (cookie) => cookie.name === "__Host-events_session",
      );
      const revoked = await f.request("/api/logout", {
        method: "POST",
        cookie: sourceCookie.name + "=" + sourceCookie.value,
        data: {},
      });
      assert.equal(revoked.status, 200);
      apps.length = 0;
      const expired = await c.newPage();
      expired.setDefaultTimeout(10000);
      await expired.goto(
        alpha + "/signin#host-transfer-start=" + encodeURIComponent(central),
      );
      await expired.locator('form[data-form="host-login"]').waitFor();
      assert.equal(expired.url(), central + "/signin");
      assert.deepEqual(apps, [central]);
      assert.equal(calls.length, 8);
      await c.close();
    } finally {
      await browser.close();
    }
  },
);

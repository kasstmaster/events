// Only synthetic local fixtures. No production pages, users, or providers.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { createApp } from "../server/app.js";
import { chromium } from "playwright";
import { application } from "./helpers/application.js";
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
  "cold startup downloads one application and does not serialize Home reads or gate public events on setup",
  { timeout: 60000 },
  async (t) => {
    const f = await application(t, mode),
      host = await f.host("Startup");
    isolateAddressBook(
      f.store,
      host.household.id,
      addressBookCheckpoint(f.store, host.household.id).fingerprint,
      "synthetic",
    );
    const event = await f.event(host, []),
      reference = publicEventReference(f.store, host.household.id, event.id);
    const browser = await chromium.launch({
      executablePath:
        process.env.CHROMIUM_PATH ||
        (existsSync("/usr/bin/chromium")
          ? "/usr/bin/chromium"
          : chromium.executablePath()),
      args: ["--no-sandbox"],
    });
    try {
      // The complete shared application is one compiled request. Authentication
      // fragment capture remains a single separately shared module instance.
      const c = await browser.newContext(),
        requested = [];
      await c.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== f.url) return route.abort();
        requested.push(url.pathname);
        return route.continue();
      });
      const p = await c.newPage();
      p.setDefaultTimeout(10000);
      let documents = 0;
      p.on("request", (r) => {
        if (r.isNavigationRequest() && r.frame() === p.mainFrame()) documents++;
      });
      await p.goto(f.url);
      await p.locator('form[data-form="host-login"]').waitFor();
      assert.equal(documents, 1);
      assert.deepEqual(
        requested.filter((path) => path.endsWith(".js")).sort(),
        ["/app.js", "/auth-bootstrap.js"],
      );
      assert.equal(requested.includes("/api/host-auth/config"), false);
      await c.close();
      // Config is slow, but independent ordinary Home reads must start immediately.
      const d = await browser.newContext(),
        reads = new Set();
      let allReadsReady;
      const allReads = new Promise((r) => (allReadsReady = r));
      await d.route("**/*", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (
          ["/api/public/context", "/api/interface", "/api/session"].includes(
            path,
          )
        ) {
          reads.add(path);
          if (reads.size === 3) allReadsReady();
        }
        if (path === "/api/passwordless/config")
          await Promise.race([
            allReads,
            new Promise((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    Error(
                      "Home startup is waiting on configuration before independent reads",
                    ),
                  ),
                4000,
              ),
            ),
          ]);
        return route.continue();
      });
      const q = await d.newPage();
      await q.goto(f.url);
      await q.locator('form[data-form="host-login"]').waitFor();
      assert.equal(reads.size, 3);
      await d.close();
      // Both ordinary host and system administrator still use their existing session.
      for (const [cookie, selector] of [
        [host.cookie, '[data-action="open-event"]'],
        [f.admin, '[data-action="admin-hosts"]'],
      ]) {
        const context = await browser.newContext();
        await context.addCookies([
          {
            name: cookie.split("=")[0],
            value: cookie.split("=")[1],
            url: f.url,
          },
        ]);
        const page = await context.newPage();
        let count = 0;
        page.on("request", (r) => {
          if (r.isNavigationRequest() && r.frame() === page.mainFrame())
            count++;
        });
        await page.goto(f.url);
        await page.locator(selector).first().waitFor();
        assert.equal(count, 1);
        await context.close();
      }
      // A direct /event/ page does not need any setup/config/session API or document redirect.
      const visitor = await browser.newContext(),
        api = [];
      await visitor.route("**/*", (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path.startsWith("/api/")) api.push(path);
        if (path === "/api/setup") return route.abort();
        return route.continue();
      });
      const page = await visitor.newPage();
      let count = 0;
      page.on("request", (r) => {
        if (r.isNavigationRequest() && r.frame() === page.mainFrame()) count++;
      });
      await page.goto(f.url + "/event/" + reference);
      await page.locator('[data-action="rsvp"]').waitFor();
      assert.deepEqual(api, ["/api/public/events/" + reference]);
      assert.equal(count, 1);
      assert.equal(
        await page.locator('form[data-form="host-login"]').count(),
        0,
      );
      await visitor.close();
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
        documents = [],
        calls = [],
        errors = [];
      await c.route("**/*", async (route) => {
        const request = route.request(),
          url = new URL(request.url()),
          target = sites.get(url.origin);
        if (!target) return route.abort();
        if (url.pathname === "/app.js") apps.push(url.origin);
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

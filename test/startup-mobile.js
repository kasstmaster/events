// Only synthetic local fixtures. No production pages, users, or providers.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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
  "cold startup preloads dependencies and does not serialize Home reads or gate public events on setup",
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
      // Hold the entry module: its deep dependencies must already be requested by
      // the HTML parser instead of waiting on several generations of module imports.
      const c = await browser.newContext();
      let dependencyReady;
      const dependency = new Promise((r) => (dependencyReady = r));
      const requested = [];
      await c.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== f.url) return route.abort();
        requested.push(url.pathname);
        if (url.pathname === "/ui-copy.js") dependencyReady();
        if (url.pathname === "/app.js")
          await Promise.race([
            dependency,
            new Promise((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    Error(
                      "Dependency waterfall: entry module blocked deeper preload",
                    ),
                  ),
                4000,
              ),
            ),
          ]);
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

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { parse as parseConfig } from "jsonc-parser";

test(
  "Cloudflare Workers and SQLite Durable Object preserve shared application guarantees",
  { timeout: 180000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "events-cloudflare-"));
    const socket = createServer();
    socket.listen(0, "127.0.0.1");
    await once(socket, "listening");
    const port = socket.address().port;
    await new Promise((r) => socket.close(r));
    const origin = `http://127.0.0.1:${port}`,
      password = "Synthetic-cloudflare-password",
      setupToken = "synthetic-setup-token-0123456789-abcdefgh";
    const config = parseConfig(
      await (
        await import("node:fs/promises")
      ).readFile("wrangler.jsonc", "utf8"),
    );
    config.main = resolve("cloudflare/worker.js");
    config.assets.directory = resolve("public");
    config.send_metrics = false;
    await writeFile(join(dir, "wrangler.json"), JSON.stringify(config));
    await writeFile(
      join(dir, ".dev.vars"),
      `ADMIN_SETUP_TOKEN=${setupToken}\n`,
      { mode: 0o600 },
    );
    let child;
    async function stop() {
      if (child && child.exitCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
      child = null;
    }
    t.after(async () => {
      await stop();
      await rm(dir, { recursive: true, force: true });
    });
    async function start() {
      child = spawn(
        process.execPath,
        [
          "node_modules/wrangler/bin/wrangler.js",
          "dev",
          "--local",
          "--config",
          join(dir, "wrangler.json"),
          "--persist-to",
          join(dir, "state"),
          "--ip",
          "127.0.0.1",
          "--port",
          String(port),
        ],
        {
          env: {
            ...process.env,
            WRANGLER_SEND_METRICS: "false",
            NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require ${resolve("test/helpers/loopback-only.cjs")}`,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      // Do not print the runtime's environment/binding dump.
      child.stdout.resume();
      child.stderr.resume();
      for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null)
          throw new Error("Local Cloudflare runtime exited unexpectedly.");
        try {
          const response = await fetch(origin + "/api/setup");
          if (response.ok) return;
        } catch {}
        await delay(250);
      }
      throw new Error("Local Cloudflare runtime did not become ready.");
    }
    async function request(
      path,
      {
        method = "GET",
        data,
        cookie,
        version,
        requestOrigin = origin,
        extraHeaders = {},
      } = {},
    ) {
      const response = await fetch(origin + path, {
        method,
        headers: {
          Origin: requestOrigin,
          ...(data ? { "Content-Type": "application/json" } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(version !== undefined ? { "If-Match": String(version) } : {}),
          ...extraHeaders,
        },
        body: data ? JSON.stringify(data) : undefined,
      });
      return {
        status: response.status,
        body: response.headers.get("content-type")?.includes("application/json")
          ? await response.json()
          : await response.text(),
        cookie: response.headers.get("set-cookie")?.split(";")[0],
        headers: response.headers,
      };
    }
    await start();
    assert.deepEqual((await request("/api/setup")).body, {
      required: true,
      enabled: true,
    });
    assert.equal((await request("/api/session")).status, 503);
    assert.equal((await request("/setup")).status, 200);
    assert.equal(
      (
        await request("/api/setup", {
          method: "POST",
          requestOrigin: "https://untrusted.test",
          data: { token: setupToken },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request("/api/setup", {
          method: "POST",
          data: {
            token: "wrong",
            email: "admin@example.test",
            password,
            confirmPassword: password,
          },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request("/api/setup", {
          method: "POST",
          data: {
            token: setupToken,
            email: "admin@example.test",
            password,
            confirmPassword: "mismatch",
          },
        })
      ).status,
      400,
    );
    const { chromium: setupChromium } = await import("playwright");
    const { existsSync: setupExists } = await import("node:fs");
    const setupBrowser = await setupChromium.launch({
      executablePath:
        process.env.CHROMIUM_PATH ||
        (setupExists("/usr/bin/chromium")
          ? "/usr/bin/chromium"
          : setupChromium.executablePath()),
      args: ["--no-sandbox"],
    });
    try {
      const page = await setupBrowser.newPage({
        viewport: { width: 390, height: 844 },
      });
      await page.route("**/*", (route) =>
        route
          .request()
          .url()
          .startsWith(origin + "/")
          ? route.continue()
          : route.abort(),
      );
      await page.goto(origin + "/setup");
      await page.getByLabel("Setup token", { exact: true }).fill(setupToken);
      await page
        .getByLabel("Administrator email", { exact: true })
        .fill("admin@example.test");
      await page
        .getByLabel("Choose administrator password", { exact: true })
        .fill(password);
      await page.getByLabel("Confirm password", { exact: true }).fill(password);
      await page
        .getByRole("button", { name: "Create administrator", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "Approved emails", exact: true })
        .waitFor();
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
      assert.equal(
        await page.evaluate(() => localStorage.length + sessionStorage.length),
        0,
      );
    } finally {
      await setupBrowser.close();
    }
    assert.deepEqual((await request("/api/setup")).body, {
      required: false,
      enabled: false,
    });
    assert.equal(
      (
        await request("/api/setup", {
          method: "POST",
          data: {
            token: setupToken,
            email: "replacement@example.test",
            password,
            confirmPassword: password,
          },
        })
      ).status,
      410,
    );
    const admin = (
      await request("/api/login", {
        method: "POST",
        data: { email: "admin@example.test", password },
      })
    ).cookie;
    assert.ok(
      admin,
      "browser-created administrator must authenticate using the shared scrypt implementation",
    );
    assert.match((await request("/")).body, /Gather/);
    assert.match((await request("/app.js")).body, /registry/);
    const hosts = [];
    for (const name of ["Alpha", "Beta"]) {
      assert.equal(
        (
          await request("/api/admin/approvals", {
            method: "POST",
            cookie: admin,
            data: { email: name + "@example.test" },
          })
        ).status,
        201,
      );
      const registered = await request("/api/register", {
        method: "POST",
        data: {
          email: name + "@example.test",
          password,
          name: "The " + name + " Family",
        },
      });
      assert.equal(registered.status, 201);
      hosts.push({
        cookie: registered.cookie,
        ...(await request("/api/host", { cookie: registered.cookie })).body,
      });
    }
    const [host, other] = hosts;
    const first = (
      await request("/api/host/guests", {
        method: "POST",
        cookie: host.cookie,
        data: { first: "Casey", last: "Example" },
      })
    ).body;
    const second = (
      await request("/api/host/guests", {
        method: "POST",
        cookie: host.cookie,
        data: { first: "Jordan", last: "Example" },
      })
    ).body;
    const childGuest = (
      await request("/api/host/guests", {
        method: "POST",
        cookie: host.cookie,
        data: { first: "Robin", last: "Example", parent: first.id },
      })
    ).body;
    // Larger than Cloudflare's SQLite row limit once base64-encoded: storage must chunk it.
    const largeImage =
      "data:image/png;base64," + Buffer.alloc(1_700_000, 42).toString("base64");
    const created = await request("/api/host/events", {
      method: "POST",
      cookie: host.cookie,
      data: {
        title: "Cloudflare supper",
        description: "Synthetic event",
        date: "2028-06-12",
        deadline: "2028-06-01",
        time: "Two O’Clock",
        icon: largeImage,
        design: { background: "#112233" },
        invited: [first.id, second.id, childGuest.id],
        menu: [{ id: "juice", name: "Juice", kind: "drink", quantity: 1 }],
        registries: [
          {
            id: "registry",
            title: "Our registry",
            url: "https://example.test/registry",
          },
        ],
      },
    });
    assert.equal(created.status, 201);
    const event = created.body;
    assert.equal(event.icon, largeImage);
    assert.equal(
      (
        await request(`/api/host/events/${event.id}/dashboard`, {
          cookie: other.cookie,
        })
      ).status,
      404,
    );
    assert.equal(
      (await request("/api/host", { cookie: other.cookie })).body.events.length,
      0,
    );
    assert.equal(
      (
        await request("/api/host/household", {
          method: "PUT",
          cookie: host.cookie,
          version: 1,
          requestOrigin: "https://untrusted.test",
          data: { name: "Forged", design: {} },
        })
      ).status,
      403,
    );
    const guests = [];
    for (const person of [first, second]) {
      const login = await request(
        `/api/public/households/${host.household.slug}/login`,
        {
          method: "POST",
          data: {
            first: person.first,
            last: person.last,
            inviteCode: person.inviteCode,
          },
        },
      );
      assert.equal(login.status, 200);
      guests.push(login.cookie);
    }
    const guestView = (await request("/api/guest", { cookie: guests[0] })).body;
    assert.equal(guestView.events[0].members.length, 2);
    assert.equal(guestView.events[0].invited, undefined);
    assert.equal(JSON.stringify(guestView).includes("Jordan"), false);
    assert.equal(guestView.events[0].registries[0].title, "Our registry");
    const results = await Promise.all(
      [first, second].map((person, index) =>
        request(`/api/guest/events/${event.id}/rsvp`, {
          method: "PUT",
          cookie: guests[index],
          data: {
            version: 0,
            attendance: {
              [person.id]: "yes",
              ...(index === 0 ? { [childGuest.id]: "yes" } : {}),
            },
            claims: { juice: 1 },
          },
        }),
      ),
    );
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
    const winner = results.findIndex((result) => result.status === 200),
      person = [first, second][winner];
    assert.equal(
      (
        await request(`/api/guest/events/${event.id}/rsvp`, {
          method: "PUT",
          cookie: guests[winner],
          data: { version: 0, attendance: { [person.id]: "yes" }, claims: {} },
        })
      ).status,
      409,
    );
    // Attempt to replace chunked content with a stale version must preserve all original bytes.
    assert.equal(
      (
        await request(`/api/host/events/${event.id}`, {
          method: "PUT",
          cookie: host.cookie,
          version: 0,
          data: { ...event, icon: "" },
        })
      ).status,
      409,
    );
    assert.equal(
      (await request("/api/host", { cookie: host.cookie })).body.events[0].icon,
      largeImage,
    );
    await stop();
    await start();
    const persisted = (await request("/api/guest", { cookie: guests[winner] }))
      .body.events[0];
    assert.equal(persisted.icon, largeImage);
    assert.equal(persisted.response.claims.juice, 1);
    assert.equal(persisted.registries[0].title, "Our registry");
    const { chromium } = await import("playwright");
    const { existsSync } = await import("node:fs");
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
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      await context.addCookies([
        {
          name: "events_session",
          value: guests[0].slice("events_session=".length),
          url: origin,
        },
      ]);
      const page = await context.newPage(),
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await context.route("**/*", (route) =>
        route
          .request()
          .url()
          .startsWith(origin + "/")
          ? route.continue()
          : route.abort(),
      );
      await page.goto(origin + "/h/" + host.household.slug);
      await page
        .getByRole("button", { name: "View event", exact: true })
        .click();
      await page
        .getByRole("link", { name: "Our registry", exact: true })
        .waitFor();
      await page
        .locator("#main")
        .getByRole("button", {
          name: "RSVP",
          exact: true,
        })
        .click();
      await page
        .getByLabel("Casey Example", { exact: true })
        .selectOption("yes");
      await page
        .getByLabel("Robin Example · child", { exact: true })
        .selectOption("yes");
      await page.getByLabel("Quantity for Juice").fill("0");
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "RSVP", exact: true })
        .click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await page
        .getByText("Robin Example: Attending", { exact: true })
        .waitFor();
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
    // Exercise additive membership, fine-grained ACL and chunked private files in actual durable SQLite.
    const kid = await request("/api/family/members", {
      method: "POST",
      cookie: host.cookie,
      data: { name: "Family child", login: "child", role: "kid", password },
    });
    assert.equal(kid.status, 201);
    const kidLogin = await request(
      `/api/public/households/${host.household.slug}/members/login`,
      { method: "POST", data: { login: "child", password } },
    );
    assert.equal(kidLogin.status, 200);
    assert.equal(
      (await request("/api/host", { cookie: kidLogin.cookie })).status,
      403,
    );
    const list = await request("/api/family/records", {
      method: "POST",
      cookie: host.cookie,
      data: {
        type: "list",
        title: "Private groceries",
        childAccess: [kid.body.id],
      },
    });
    assert.equal(list.status, 201);
    const additions = await Promise.all(
      [host.cookie, kidLogin.cookie].map((cookie, i) =>
        request("/api/family/items", {
          method: "POST",
          cookie,
          data: { list: list.body.id, title: "Item " + i },
        }),
      ),
    );
    assert.deepEqual(
      additions.map((r) => r.status),
      [201, 201],
    );
    const item = additions[1].body;
    assert.equal(
      (
        await request(`/api/family/items/${item.id}`, {
          method: "PUT",
          cookie: kidLogin.cookie,
          version: item.version,
          data: { completed: true },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(`/api/family/items/${item.id}`, {
          method: "PUT",
          cookie: host.cookie,
          version: item.version,
          data: { completed: false },
        })
      ).status,
      409,
    );
    const home = await request("/api/family/records", {
      method: "POST",
      cookie: host.cookie,
      data: { type: "record", title: "Warranty", childAccess: [kid.body.id] },
    });
    assert.equal(home.status, 201);
    const contents = "Private warranty\n".repeat(90000);
    const document = await request("/api/family/files", {
      method: "POST",
      cookie: host.cookie,
      data: {
        record: home.body.id,
        name: "warranty.txt",
        mime: "text/plain",
        base64: Buffer.from(contents).toString("base64"),
      },
    });
    assert.equal(document.status, 201);
    await stop();
    await start();
    assert.equal(
      (
        await request(`/api/family/files/${document.body.id}`, {
          cookie: kidLogin.cookie,
        })
      ).body,
      contents,
    );
    assert.equal(
      (
        await request(`/api/family/files/${document.body.id}`, {
          cookie: other.cookie,
        })
      ).status,
      404,
    );
    assert.equal(
      (await request("/api/family", { cookie: kidLogin.cookie })).body.items
        .length,
      2,
    );
    assert.equal(
      (
        await request(`/api/family/records/${home.body.id}`, {
          method: "PUT",
          cookie: host.cookie,
          version: home.body.version,
          data: { ...home.body, childAccess: [] },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request(`/api/family/files/${document.body.id}`, {
          cookie: kidLogin.cookie,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await request("/api/family", { cookie: kidLogin.cookie })
      ).body.records.some((r) => r.id === home.body.id),
      false,
    );
    // The edge discards caller-supplied IP headers rather than letting them bypass limits.
    const loginPath = `/api/public/households/${host.household.slug}/login`;
    for (let index = 0; index < 10; index++)
      assert.equal(
        (
          await request(loginPath, {
            method: "POST",
            data: { first: "Absent", last: "Person" },
            extraHeaders: { "x-events-client-ip": "forged-" + index },
          })
        ).status,
        401,
      );
    assert.equal(
      (
        await request(loginPath, {
          method: "POST",
          data: { first: "Absent", last: "Person" },
          extraHeaders: { "x-events-client-ip": "another-forgery" },
        })
      ).status,
      429,
    );
  },
);

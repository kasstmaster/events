// Local synthetic fixtures and mock ownership email only; no live providers.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { Store } from "../server/node-store.js";
import { createApp } from "../server/app.js";
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "synthetic-browser",
  alg: "RS256",
  use: "sig",
};
let googleNonce = "";
const googleClient = "synthetic-browser.apps.googleusercontent.com";
function googleToken() {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: jwk.kid }),
  ).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      iss: "https://accounts.google.com",
      aud: googleClient,
      sub: "synthetic-browser-host",
      email: "google-browser@example.test",
      email_verified: true,
      nonce: googleNonce,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
    }),
  ).toString("base64url");
  const bytes = header + "." + claims;
  return (
    bytes +
    "." +
    sign("RSA-SHA256", Buffer.from(bytes), privateKey).toString("base64url")
  );
}
const origin = "http://127.0.0.1:3244",
  password = "Synthetic-host-browser-passphrase",
  store = new Store(),
  sent = [];
await store.createAdmin("admin@example.test", password);
const server = createApp({
  store,
  origin,
  env: {
    HOST_GOOGLE_CLIENT_ID: googleClient,
    HOST_GOOGLE_CLIENT_SECRET: "synthetic-browser-provider-secret",
    HOST_ONLY_MODEL_ENABLED: "true",
    HOST_ONLY_MODEL_ACTIVATION_APPROVED: "true",
  },
  hostVerificationSender: async (message) => sent.push(message),
  hostGoogleFetcher: async (url, options) => {
    if (url === "https://www.googleapis.com/oauth2/v3/certs")
      return Response.json({ keys: [jwk] });
    assert.equal(url, "https://oauth2.googleapis.com/token");
    assert.ok(new URLSearchParams(options.body).get("code_verifier"));
    return Response.json({ id_token: googleToken() });
  },
});
server.listen(3244, "127.0.0.1");
await once(server, "listening");
async function api(path, data, cookie) {
  const r = await fetch(origin + path, {
    method: data ? "POST" : "GET",
    headers: {
      Origin: origin,
      ...(data ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  const body = await r.json();
  assert.ok(r.ok, `${path}: ${body.error || r.status}`);
  return { body, cookie: r.headers.get("set-cookie")?.split(";")[0] };
}
const admin = (
  await api("/api/host-auth/login", { email: "admin@example.test", password })
).cookie;
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ||
    (existsSync("/usr/bin/chromium")
      ? "/usr/bin/chromium"
      : chromium.executablePath()),
  args: ["--no-sandbox"],
});
try {
  for (const width of [390, 768, 1366]) {
    const email = `synthetic-${width}@example.test`,
      invite = (
        await api(
          "/api/admin/host-signup-invitations",
          { email, password },
          admin,
        )
      ).body.url;
    const context = await browser.newContext({
        viewport: { width, height: 900 },
      }),
      page = await context.newPage(),
      errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(invite);
    await page.locator('form[data-form="host-signup"]').waitFor();
    assert.equal(new URL(page.url()).hash, "");
    assert.equal(await page.locator('[name="email"]').inputValue(), email);
    await page.locator('[name="name"]').fill("Synthetic Family " + width);
    await page.locator('[name="password"]').fill(password);
    await page
      .getByRole("button", {
        name: "Verify email and create account",
        exact: true,
      })
      .click();
    await page.getByText(/Check your email/).waitFor();
    assert.equal(
      store.one("SELECT id FROM users WHERE email=?", email),
      undefined,
    );
    await page.goto(sent.at(-1).url);
    await page
      .getByRole("button", { name: "Verify and continue", exact: true })
      .click();
    await page.locator('[data-action="new-event"]').first().waitFor();
    assert.equal(
      await page
        .getByText("Your invitations, all in one place.", { exact: true })
        .count(),
      0,
    );
    await page.reload();
    await page.locator('[data-action="new-event"]').first().waitFor();
    assert.equal(
      (await context.cookies()).some(
        (c) =>
          c.name === "events_session" &&
          c.httpOnly &&
          c.expires > Date.now() / 1000 + 300 * 86400,
      ),
      true,
    );
    // Sign out via the same existing menu/toolbar action, without altering page styling.
    await page.evaluate(async () => {
      await fetch("/api/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    });
    await page.goto(origin);
    await page.locator('form[data-form="host-login"]').waitFor();
    await page.waitForFunction(
      async () =>
        !(await navigator.serviceWorker.getRegistrations()).some((r) =>
          (r.active || r.waiting || r.installing)?.scriptURL.endsWith(
            "/gather-sw.js",
          ),
        ),
    );
    await page.locator('[name="email"]').fill(email);
    await page.locator('[name="password"]').fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.locator('[data-action="new-event"]').first().waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      `Native host email ownership, persistent sign-in and guest retirement passed: ${width}px`,
    );
  }
  const invited = (
    await api(
      "/api/admin/host-signup-invitations",
      { email: "google-browser@example.test", password },
      admin,
    )
  ).body.url;
  const context = await browser.newContext({
    viewport: { width: 390, height: 900 },
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    assert.equal(
      url.origin,
      "https://accounts.google.com",
      "Unexpected synthetic navigation: " + url.origin + url.pathname,
    );
    googleNonce = url.searchParams.get("nonce");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    const callback =
      origin +
      "/api/host-auth/google/callback?code=synthetic-browser-code&state=" +
      encodeURIComponent(url.searchParams.get("state"));
    return route.fulfill({
      status: 302,
      headers: { location: callback },
      body: "",
    });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  await page.goto(invited);
  await page.locator('[name="name"]').fill("Synthetic Google Household");
  await page
    .getByRole("button", { name: "Sign up with Google", exact: true })
    .click();
  await page.locator('[data-action="new-event"]').first().waitFor();
  assert.equal(
    store.one(
      "SELECT role FROM users WHERE email=?",
      "google-browser@example.test",
    ).role,
    "host",
  );
  await page.reload();
  await page.locator('[data-action="new-event"]').first().waitFor();
  await context.close();
  console.log(
    "Google browser registration uses real signed identity verification with synthetic provider transport",
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  store.db.close();
}

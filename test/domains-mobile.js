// Browser requests are fulfilled by the isolated gateway + real Worker/DO runtime.
// No live DNS lookup, external request, production account or RSVP is created.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import {
  domainRuntime,
  seedDomains,
  canonical,
  alphaOrigin,
  betaOrigin,
  password,
} from "./helpers/domain-runtime.js";
import {
  cloudflareRouting,
  waitForActive,
} from "./helpers/cloudflare-routing.js";
const control = cloudflareRouting();
const f = await domainRuntime({
  automatic: true,
  cloudflareFetch: control.fetcher,
});
let browser;
try {
  const { hosts } = await seedDomains(f);
  for (const host of hosts) await waitForActive(f, host);
  const fixtures = [];
  for (const [i, origin] of [alphaOrigin, betaOrigin].entries()) {
    const host = hosts[i],
      background = i ? "#ddeeff" : "#f5e6da";
    const updated = await f.request("/api/host/household", {
      method: "PUT",
      cookie: host.cookie,
      version: host.version,
      data: {
        name: host.name,
        design: { background, titleColor: i ? "#123456" : "#654321" },
        subdomain: host.subdomain,
      },
    });
    assert.equal(updated.status, 200);
    const guest = await f.request("/api/host/guests", {
      method: "POST",
      cookie: host.cookie,
      data: {
        first: "Casey",
        last: "Synthetic",
        suffix: "",
        parent: "",
        address: "",
      },
    });
    const event = await f.request("/api/host/events", {
      method: "POST",
      cookie: host.cookie,
      data: {
        title: `Synthetic gathering ${i + 1}`,
        description: "Synthetic invitation",
        date: "",
        time: "",
        address: "",
        deadline: "",
        design: { background: "#102030" },
        invited: [guest.body.id],
        menu: [],
      },
    });
    assert.equal(event.status, 201);
    fixtures.push({
      host,
      origin,
      background,
      event: event.body,
      inviteCode: guest.body.inviteCode,
    });
  }
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || chromium.executablePath(),
    args: ["--no-sandbox"],
  });
  const errors = [];
  async function device(width) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      isMobile: width < 600,
      hasTouch: width < 600,
    });
    await context.route("**/*", async (route) => {
      const req = route.request();
      const origin = new URL(req.url()).origin;
      if (
        ![
          canonical,
          alphaOrigin,
          betaOrigin,
          "https://dubois.ilymmd.com",
        ].includes(origin)
      )
        throw new Error("External browser request blocked");
      const response = await f.dispatch(req.url(), {
        method: req.method(),
        headers: await req.allHeaders(),
        body: req.postDataBuffer() || undefined,
      });
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: Buffer.from(await response.arrayBuffer()),
      });
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    page.setDefaultTimeout(10000);
    return { context, page };
  }
  await mkdir("test-results", { recursive: true });
  for (const width of [390, 1440])
    for (const fixture of fixtures) {
      const { context, page } = await device(width),
        { host, origin, background, event } = fixture;
      await page.goto(origin);
      await page
        .getByRole("heading", { name: host.name, exact: true })
        .waitFor();
      assert.equal(
        await page.evaluate(() =>
          document.documentElement.style.getPropertyValue("--bg"),
        ),
        background,
      );
      await page
        .getByRole("button", { name: "Host Login", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "Host Login", exact: true })
        .waitFor();
      assert.equal(
        await page.evaluate(() =>
          document.documentElement.style.getPropertyValue("--bg"),
        ),
        background,
      );
      await page
        .getByRole("button", { name: "Back to guest sign-in", exact: true })
        .click();
      await page.getByLabel("First name", { exact: true }).fill("Casey");
      await page.getByLabel("Last name", { exact: true }).fill("Synthetic");
      await page
        .getByLabel("Invite Code", { exact: true })
        .fill(fixture.inviteCode);
      await page
        .getByRole("button", { name: "See my invitations", exact: true })
        .click();
      await page
        .getByRole("button", { name: "View event", exact: true })
        .click();
      await page
        .getByRole("heading", { name: event.title, exact: true })
        .waitFor();
      assert.equal(
        await page.evaluate(() =>
          document.documentElement.style.getPropertyValue("--bg"),
        ),
        "#102030",
      );
      await page
        .locator("#main")
        .getByRole("button", { name: "RSVP", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog
        .getByLabel("Casey Synthetic", { exact: true })
        .selectOption("yes");
      await dialog.getByRole("button", { name: "RSVP", exact: true }).click();
      await page
        .getByText("Your RSVP is saved. Thank you!", { exact: true })
        .waitFor();
      const cookies = await context.cookies(origin);
      const session = cookies.find((c) => c.name === "__Host-events_session");
      assert.ok(
        session &&
          session.secure &&
          session.httpOnly &&
          session.path === "/" &&
          session.domain === new URL(origin).hostname,
      );
      assert.equal(
        (
          await context.cookies(
            origin === alphaOrigin ? betaOrigin : alphaOrigin,
          )
        ).length,
        0,
      );
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
      await page.screenshot({
        path: `test-results/${host.subdomain}-${width}.png`,
        fullPage: true,
      });
      await page.goto(origin === alphaOrigin ? betaOrigin : alphaOrigin);
      await page
        .getByRole("button", { name: "See my invitations", exact: true })
        .waitFor();
      await context.close();
    }
  // Phone registration derives a non-editable address; later settings cannot rename it.
  await seedRegistrationAdmin();
  const { context, page } = await device(390);
  await page.goto(canonical);
  await page
    .getByRole("button", { name: "Create your account", exact: true })
    .click();
  assert.equal(await page.locator('input[name="subdomain"]').count(), 0);
  await page
    .getByLabel("Family household name", { exact: true })
    .fill("a".repeat(63));
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );

  await page
    .getByLabel("Family household name", { exact: true })
    .fill("Dubois");
  assert.equal(
    await page
      .getByLabel("Household web address", { exact: true })
      .textContent(),
    "dubois.ilymmd.com",
  );
  await page
    .getByText("dubois.ilymmd.com is available", { exact: false })
    .waitFor();
  await page
    .getByLabel("Family household name", { exact: true })
    .fill("TheMeyers");
  await page
    .getByText("That household address is unavailable", { exact: false })
    .waitFor();
  assert.equal(
    await page
      .getByLabel("Household web address", { exact: true })
      .textContent(),
    "themeyers.ilymmd.com",
  );
  await page
    .getByLabel("Family household name", { exact: true })
    .fill("Dubois");
  await page
    .getByLabel("Email address", { exact: true })
    .fill("new@example.test");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await page.getByRole("heading", { name: "Dubois", exact: true }).waitFor();
  const session = await f.request("/api/login", {
    method: "POST",
    data: { email: "new@example.test", password },
  });
  const host = await f.request("/api/host", { cookie: session.cookie });
  assert.equal(host.body.household.subdomain, "dubois");
  const active = await waitForActive(f, {
    ...host.body.household,
    cookie: session.cookie,
  });
  assert.equal(active.shareUrl, "https://dubois.ilymmd.com/");
  await page
    .getByRole("button", { name: "Edit household", exact: true })
    .click();
  assert.equal(
    await page.getByLabel("Household web address", { exact: true }).count(),
    0,
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await page.getByText("Appearance saved.", { exact: true }).waitFor();
  await page.goto("https://dubois.ilymmd.com/");
  await page.getByRole("heading", { name: "Dubois", exact: true }).waitFor();
  assert.equal(new URL(page.url()).hostname, "dubois.ilymmd.com");
  await context.close();
  assert.deepEqual(errors, []);
  console.log(
    "Two household hostnames passed phone (390px) and desktop (1440px): branding, guest sign-in, RSVP, assets, Secure host-only cookies and household isolation; automatic registration and immutable addresses passed.",
  );
  async function seedRegistrationAdmin() {
    const admin = await f.request("/api/login", {
      method: "POST",
      data: { email: "admin@example.test", password },
    });
    await f.request("/api/admin/approvals", {
      method: "POST",
      cookie: admin.cookie,
      data: { email: "new@example.test" },
    });
    return { admin };
  }
} finally {
  await browser?.close();
  await f.runtime.dispose();
}

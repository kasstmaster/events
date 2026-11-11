import { identityFor } from "../server/guest-identities.js";
import { existingGuestBrowser } from "./helpers/guest-session.js";
// Synthetic households only, no provider or non-loopback traffic.
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import { Store } from "../server/node-store.js";
import { createApp } from "../server/app.js";
import { completeGuestSetup } from "./helpers/guest-account.js";
const store = new Store(),
  origin = "http://127.0.0.1:3198",
  password = "Synthetic-personal-browser-password";
await store.createAdmin("admin@example.test", password);
const hosts = [];
for (const name of ["Alpha", "Beta"]) {
  store.run(
    "INSERT INTO approvals VALUES(?,?)",
    name.toLowerCase() + "@example.test",
    "synthetic",
  );
  hosts.push(
    await store.register({
      name,
      email: name.toLowerCase() + "@example.test",
      password,
    }),
  );
}
const server = createApp({
  store,
  origin,
  env: { GUEST_LINK_ENCRYPTION_KEY: "a1".repeat(32) },
});
server.listen(3198, "127.0.0.1");
await once(server, "listening");
const browser = await chromium.launch({
  executablePath:
    process.env.CHROMIUM_PATH ||
    (existsSync("/usr/bin/chromium")
      ? "/usr/bin/chromium"
      : chromium.executablePath()),
  args: ["--no-sandbox"],
});
async function api(
  path,
  data,
  cookie,
  method = data ? "POST" : "GET",
  version,
) {
  const r = await fetch(origin + path, {
    method,
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(data ? { "Content-Type": "application/json" } : {}),
      ...(version !== undefined ? { "If-Match": String(version) } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  assert.ok(r.ok, `Synthetic personal fixture ${path}: ${r.status}`);
  return {
    body: await r.json(),
    cookie: r.headers.get("set-cookie")?.split(";")[0],
  };
}
async function device(width) {
  const context = await browser.newContext({
    viewport: { width, height: 950 },
  });
  await context.route("**/*", (r) =>
    r
      .request()
      .url()
      .startsWith(origin + "/")
      ? r.continue()
      : r.abort(),
  );
  const p = await context.newPage(),
    errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.setDefaultTimeout(10000);
  return { context, p, errors };
}
const click = (p, name) => p.getByRole("button", { name, exact: true }).click();
try {
  await mkdir("test-results", { recursive: true });
  const alpha = (
      await api("/api/login", { email: "alpha@example.test", password })
    ).cookie,
    beta = (await api("/api/login", { email: "beta@example.test", password }))
      .cookie;
  const adult = (
    await api(
      "/api/host/guests",
      {
        first: "Casey",
        last: "Example",
        phone: "+15005550123",
        addressDraft: {
          label: "Example household",
          lines: "1 Old Street",
          notes: "PRIVATE SOURCE NOTE",
        },
      },
      alpha,
    )
  ).body;
  await api(
    "/api/host/guests",
    { first: "Riley", parent: adult.id, address: adult.address },
    alpha,
  );
  const eventA = (
    await api(
      "/api/host/events",
      {
        title: "Alpha invitation",
        date: "2089-07-20",
        invited: [adult.id],
        menu: [],
      },
      alpha,
    )
  ).body;
  const guest = await device(390),
    p = guest.p;
  console.log(
    "Personal browser: remembered private sign-in and independent home",
  );
  await existingGuestBrowser(
    p,
    store,
    store.household(hosts[0].household),
    adult,
    origin,
  );
  // This suite models an already activated registered guest; fresh activation is tested through SMS separately.
  const existingIdentity = identityFor(store, adult, hosts[0].household).id;
  store.put("guest-auth-activation", existingIdentity, "platform", {
    activatedAt: Date.now(),
  });

  await p
    .getByRole("heading", { name: "Casey Example", exact: true })
    .waitFor();
  assert.equal(
    await p.evaluate(() => getComputedStyle(document.body).backgroundColor),
    "rgb(21, 23, 25)",
  );
  await click(p, "Family information");
  const form = p.locator('form[data-form="personal-family"]');
  await form.locator('[name="physicalStreet"]').fill("9 Physical Street");
  await form.locator('[name="physicalCity"]').fill("Sample");
  await form.locator('[name="physicalState"]').fill("CA");
  await form.locator('[name="physicalZip"]').fill("90210");
  await form.locator('[name="mailingStreet"]').fill("PO Box 77");
  await form.locator('[name="mailingCity"]').fill("Sample");
  await form.locator('[name="mailingState"]').fill("CA");
  await form.locator('[name="mailingZip"]').fill("90210");
  const adultRow = form
    .locator("[data-personal-member]")
    .filter({ has: p.locator("legend", { hasText: /^Adult$/ }) })
    .first();
  await adultRow.locator('[name="profilePhone"]').fill("+15005550124");
  const childRow = form
    .locator("[data-personal-member]")
    .filter({ has: p.locator("legend", { hasText: /^Child$/ }) });
  assert.equal(
    await childRow.getByLabel("Last name", { exact: true }).isVisible(),
    false,
  );
  await form.locator('[name="profileRecipient"]').check();
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await p.getByText("Household information saved.", { exact: true }).waitFor();
  assert.match(
    store.get("address", adult.address, hosts[0].household).lines,
    /PO Box 77/,
  );
  assert.equal(
    store.get("address", adult.address, hosts[0].household).notes,
    "PRIVATE SOURCE NOTE",
  );
  assert.equal(
    store.get("guest", adult.id, hosts[0].household).phone,
    "+15005550124",
  );
  console.log(
    "Personal browser: exact registered contact association and cross-household invitations",
  );
  const linked = (
    await api(
      "/api/host/guests",
      {
        first: "Casey",
        last: "Example",
        phone: "+15005550124",
        addressDraft: {
          label: "Example household",
          lines: "PO Box 77\nSample, CA 90210",
        },
      },
      beta,
    )
  ).body;
  const eventB = (
    await api(
      "/api/host/events",
      {
        title: "Beta invitation",
        date: "2089-06-10",
        invited: [linked.id],
        menu: [],
      },
      beta,
    )
  ).body;
  await p.reload();
  await click(p, "Home");
  assert.deepEqual(await p.locator("article.card h2").allTextContents(), [
    "Beta invitation",
    "Alpha invitation",
  ]);
  await p
    .locator("article.card")
    .filter({ hasText: "Beta invitation" })
    .getByRole("button", { name: "View Event", exact: true })
    .click();
  await click(p, "RSVP");
  assert.equal(await p.getByLabel("Riley · child", { exact: true }).count(), 0);
  await click(p, "Close editor");
  await click(p, "Home");
  await click(p, "Family information");
  await form.locator('[name="profilePhone"]').first().fill("+15005550125");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await p.getByText("Household information saved.", { exact: true }).waitFor();
  assert.equal(
    store.get("guest", adult.id, hosts[0].household).phone,
    "+15005550125",
  );
  assert.equal(
    store.get("guest", linked.id, hosts[1].household).phone,
    "+15005550124",
  );
  await click(p, "Home");
  await click(p, "Address Book");
  const betaRow = p
    .locator("li.browse-row")
    .filter({ has: p.getByText("Beta", { exact: true }) });
  await betaRow.getByRole("button", { name: "Block", exact: true }).click();
  await betaRow.getByRole("button", { name: "Unblock", exact: true }).waitFor();
  await click(p, "Home");
  assert.deepEqual(await p.locator("article.card h2").allTextContents(), [
    "Alpha invitation",
  ]);
  await click(p, "Address Book");
  await p
    .locator("li.browse-row")
    .filter({ has: p.getByText("Beta", { exact: true }) })
    .getByRole("button", { name: "Unblock", exact: true })
    .click();
  await click(p, "Home");
  await click(p, "Private sign-in");
  await p.getByLabel("Your private sign-in link", { exact: true }).waitFor();
  assert.equal(await p.getByLabel("Username", { exact: true }).count(), 0);
  await click(p, "Home");
  for (const width of [390, 1440]) {
    await p.setViewportSize({ width, height: 950 });
    assert.ok(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await p.screenshot({
      path: `test-results/personal-home-${width}.png`,
      fullPage: true,
    });
  }
  const projection = (await api("/api/host", undefined, alpha)).body;
  assert.doesNotMatch(
    JSON.stringify(projection.guests),
    /casey.changed|15005550199/,
  );
  assert.equal(store.list("response", hosts[0].household).length, 0);
  assert.equal(store.list("response", hosts[1].household).length, 0);
  assert.equal(store.list("phone-verification", "platform").length, 0);
  assert.deepEqual(guest.errors, []);
  await guest.context.close();
  const suffixAdult = (
    await api(
      "/api/host/guests",
      {
        first: "Morgan",
        last: "Example",
        addressDraft: { label: "Suffix household", lines: "PO Box 55" },
      },
      alpha,
    )
  ).body;
  await api(
    "/api/host/guests",
    {
      first: "Morgan",
      last: "Example",
      suffix: "Jr.",
      address: suffixAdult.address,
    },
    alpha,
  );
  const suffixDevice = await device(390);
  await existingGuestBrowser(
    suffixDevice.p,
    store,
    store.household(hosts[0].household),
    suffixAdult,
    origin,
  );
  assert.equal(
    await suffixDevice.p.getByLabel("Suffix", { exact: true }).count(),
    0,
  );
  assert.deepEqual(suffixDevice.errors, []);
  await suffixDevice.context.close();
  console.log(
    "Personal browser passed: private sessions, family sharing, address/phone propagation, cross-host invitations, RSVP scope, block/unblock and own private-link Settings.",
  );
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
  store.db.close();
}

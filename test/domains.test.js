import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/node-store.js";
import {
  normalizeLabel,
  suggestLabel,
  householdLink,
  configuredHosts,
} from "../server/household-domains.js";
import {
  forwardRequest,
  verifyRequest,
} from "../cloudflare/gateway-protocol.js";
import {
  domainRuntime,
  seedDomains,
  canonical,
  alphaOrigin,
  betaOrigin,
  password,
  secret,
} from "./helpers/domain-runtime.js";

test("single-label normalization, reserved sites and exact allowlists", () => {
  assert.equal(normalizeLabel("  TheRaudmans  "), "theraudmans");
  for (const invalid of [
    "",
    "ab",
    "a".repeat(64),
    "a.b",
    "-start",
    "end-",
    "under_score",
    "école",
    "xn--fake",
    "THEMEYERS",
    "www",
    "plex",
    "bridge",
    "books",
    "discover",
    "setup",
    "events",
  ])
    assert.equal(normalizeLabel(invalid), null, invalid);
  assert.equal(normalizeLabel("a".repeat(63)), "a".repeat(63));
  assert.throws(() => configuredHosts("*.ilymmd.com"));
  assert.throws(() => configuredHosts("themeyers.ilymmd.com"));
  const household = { subdomain: "theraudmans", slug: "stable" };
  assert.equal(householdLink(household, canonical), canonical + "/h/stable");
  assert.equal(
    householdLink(
      household,
      canonical,
      configuredHosts("theraudmans.ilymmd.com"),
    ),
    alphaOrigin + "/",
  );
});

test("whole-name suggestions normalize consistently without added words", () => {
  for (const [name, expected] of [
    ["Dubois", "dubois"],
    [" Raudman ", "raudman"],
    ["Élodie O’Neil", "elodie-oneil"],
    ["THE Family", "the-family"],
    [" A__B & C ", "a-b-c"],
    ["中文", ""],
    ["a".repeat(70), "a".repeat(63)],
  ])
    assert.equal(suggestLabel(name), expected);
});

test("registration derives exact names atomically and rejects collisions, reserved names and overrides", async () => {
  const store = new Store();
  try {
    for (const address of ["one", "two", "reserved", "short"])
      store.run(
        "INSERT INTO approvals VALUES(?,?)",
        `${address}@example.test`,
        "synthetic",
      );
    const results = await Promise.allSettled(
      ["one", "two"].map((address) =>
        store.register({
          email: `${address}@example.test`,
          password,
          name: "Dubois",
        }),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      results.find((r) => r.status === "rejected").reason.status,
      409,
    );
    assert.equal(
      store.household(
        results.find((r) => r.status === "fulfilled").value.household,
      ).subdomain,
      "dubois",
    );
    for (const [address, name] of [
      ["reserved", "TheMeyers"],
      ["short", "Li"],
    ])
      await assert.rejects(
        store.register({ email: `${address}@example.test`, password, name }),
        { status: 400 },
      );
    await assert.rejects(
      store.register({
        email: "short@example.test",
        password,
        name: "Valid",
        subdomain: "arbitrary",
      }),
      { status: 400 },
    );
    assert.equal(store.one("SELECT count(*) AS n FROM approvals").n, 3);
  } finally {
    store.db.close();
  }
});

test("atomic registration, competing case-insensitive claims, rollback and permanent retirement", async () => {
  const store = new Store();
  try {
    for (const email of ["a@example.test", "b@example.test", "c@example.test"])
      store.run("INSERT INTO approvals VALUES(?,?)", email, "synthetic");
    const race = await Promise.allSettled(
      ["a@example.test", "b@example.test"].map((email) =>
        store.register({
          email,
          password,
          name: "RaceName",
          subdomain: "RaceName",
        }),
      ),
    );
    assert.equal(race.filter((x) => x.status === "fulfilled").length, 1);
    assert.equal(race.find((x) => x.status === "rejected").reason.status, 409);
    const account = race.find((x) => x.status === "fulfilled").value;
    const h = store.household(account.household);
    assert.equal(h.subdomain, "racename");
    assert.throws(
      () =>
        store.updateHousehold(
          h.id,
          { name: h.name, design: {}, subdomain: "newname" },
          0,
        ),
      { status: 403 },
    );
    assert.equal(store.domainAvailable("newname"), true);
    assert.equal(store.domainAvailable("racename", h.id), true);
    assert.throws(
      () =>
        store.updateHousehold(
          h.id,
          { name: h.name, design: {}, subdomain: "newname" },
          h.version,
        ),
      { status: 403 },
    );
    const updated = store.updateHousehold(
      h.id,
      { name: "New display name", design: {} },
      h.version,
    );
    assert.equal(updated.subdomain, "racename");
    assert.equal(updated.slug, h.slug);
    // Synthetic historical retirement: hosts have no rename endpoint anymore.
    store.run(
      "UPDATE household_domains SET retired=1 WHERE label=?",
      "racename",
    );
    assert.throws(() => store.hostnameHousehold("racename"), { status: 404 });
    assert.equal(store.domainAvailable("racename", h.id), false);
    await assert.rejects(
      store.register({
        email: "c@example.test",
        password,
        name: "RaceName",
        subdomain: "racename",
      }),
      { status: 409 },
    );
    assert.equal(
      store.one("SELECT email FROM approvals WHERE email=?", "c@example.test")
        .email,
      "c@example.test",
    );
    await assert.rejects(
      store.register({
        email: "unapproved@example.test",
        password,
        name: "Unapproved",
        subdomain: "unclaimed",
      }),
      { status: 403 },
    );
    assert.equal(store.domainAvailable("unclaimed"), true);
  } finally {
    store.db.close();
  }
});

test("gateway authenticates body, path, origin, cookies and hostname; never trusts client forwarding", async () => {
  const env = {
    EVENTS_ORIGIN: canonical,
    HOUSEHOLD_HOSTS: "theraudmans.ilymmd.com",
    EVENTS_GATEWAY_SECRET: secret,
  };
  const forwarded = await forwardRequest(
    new Request(alphaOrigin + "/api/login", {
      method: "POST",
      headers: {
        Origin: alphaOrigin,
        "Content-Type": "application/json",
        "x-events-hostname": "evil.ilymmd.com",
        "CF-Connecting-IP": "192.0.2.3",
      },
      body: '{"test":true}',
    }),
    env,
  );
  assert.equal(await verifyRequest(forwarded, env), "theraudmans.ilymmd.com");
  assert.equal(forwarded.headers.get("x-events-client-ip"), "192.0.2.3");
  for (const [key, value] of [
    ["origin", betaOrigin],
    ["cookie", "events_session=stolen"],
    ["x-events-hostname", "thedubois.ilymmd.com"],
    ["x-events-time", "1000000000000"],
  ]) {
    const altered = new Request(forwarded.clone());
    altered.headers.set(key, value);
    assert.equal(await verifyRequest(altered, env), null);
  }
  assert.equal(
    await verifyRequest(
      new Request(canonical + "/different", forwarded.clone()),
      env,
    ),
    null,
  );
  assert.equal(
    await verifyRequest(
      new Request(forwarded.url, {
        method: "POST",
        headers: forwarded.headers,
        body: '{"test":false}',
      }),
      env,
    ),
    null,
  );
  for (const host of ["themeyers", "unclaimed", "evil"])
    assert.equal(
      await forwardRequest(new Request(`https://${host}.ilymmd.com/`), env),
      null,
    );
  await assert.rejects(
    forwardRequest(new Request(alphaOrigin), {
      ...env,
      EVENTS_ORIGIN: "https://attacker.test",
    }),
  );
});

test(
  "two-household gateway + actual Worker/Durable Object: assets, auth, RSVP, CSRF, origins, retirement",
  { timeout: 120000 },
  async (t) => {
    const f = await domainRuntime();
    t.after(() => f.runtime.dispose());
    const {
        admin,
        hosts: [alpha, beta],
      } = await seedDomains(f),
      { request } = f;
    assert.equal(alpha.shareUrl, alphaOrigin + "/");
    assert.equal((await request("/", { origin: alphaOrigin })).status, 200);
    for (const path of ["/app.js", "/style.css"])
      assert.equal((await request(path, { origin: alphaOrigin })).status, 200);
    assert.equal(
      (await request("/api/public/context", { origin: alphaOrigin })).body
        .household.name,
      alpha.name,
    );
    assert.equal(
      (await request("/api/public/context", { origin: betaOrigin })).body
        .household.name,
      beta.name,
    );
    assert.equal(
      (await request(`/h/${beta.slug}`, { origin: alphaOrigin })).status,
      404,
    );
    assert.equal(
      (
        await request(`/api/public/households/${beta.slug}`, {
          origin: alphaOrigin,
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await request("/api/session", {
          origin: alphaOrigin,
          cookie: alpha.cookie,
        })
      ).body.role,
      null,
    );
    assert.equal(
      (await request("/api/setup", { origin: alphaOrigin })).body.enabled,
      false,
    );
    const blockedSetup = await request("/api/setup", {
      origin: alphaOrigin,
      method: "POST",
      data: {},
    });
    assert.equal(blockedSetup.status, 404, JSON.stringify(blockedSetup.body));
    assert.equal(
      (
        await request("/api/register", {
          origin: alphaOrigin,
          method: "POST",
          data: {},
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await request("/api/login", {
          origin: alphaOrigin,
          method: "POST",
          data: { email: beta.email, password },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await request("/api/login", {
          origin: alphaOrigin,
          method: "POST",
          data: { email: "admin@example.test", password },
        })
      ).status,
      401,
    );
    for (const [host, origin] of [
      [alpha, alphaOrigin],
      [beta, betaOrigin],
    ]) {
      const login = await request("/api/login", {
        origin,
        method: "POST",
        data: { email: host.email, password },
      });
      assert.equal(login.status, 200);
      assert.match(
        login.headers.get("set-cookie"),
        /^__Host-events_session=.+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/,
      );
      assert.equal(
        (
          await request("/api/host", {
            origin: origin === alphaOrigin ? betaOrigin : alphaOrigin,
            cookie: login.cookie,
          })
        ).status,
        401,
      );
      const guest = await request("/api/host/guests", {
        origin,
        method: "POST",
        cookie: login.cookie,
        data: {
          first: "Casey",
          last: "Synthetic",
          suffix: "",
          parent: "",
          address: "",
        },
      });
      assert.equal(guest.status, 201);
      const event = await request("/api/host/events", {
        origin,
        method: "POST",
        cookie: login.cookie,
        data: {
          title: "Synthetic gathering",
          description: "",
          date: "",
          time: "",
          address: "",
          deadline: "",
          design: { background: "#112233" },
          invited: [guest.body.id],
          menu: [],
        },
      });
      assert.equal(event.status, 201);
      const guestLogin = await request(
        `/api/public/households/${host.slug}/login`,
        { origin, method: "POST", data: { first: "Casey", last: "Synthetic" } },
      );
      assert.equal(guestLogin.status, 200);
      const view = await request("/api/guest", {
        origin,
        cookie: guestLogin.cookie,
      });
      assert.equal(view.body.events.length, 1);
      assert.equal(view.body.household.id, host.id);
      assert.equal(
        (await request("/api/host", { origin, cookie: guestLogin.cookie }))
          .status,
        403,
      );
      const rsvp = await request(`/api/guest/events/${event.body.id}/rsvp`, {
        origin,
        cookie: guestLogin.cookie,
        method: "PUT",
        version: 0,
        data: {
          version: 0,
          attendance: { [guest.body.id]: "yes" },
          claims: {},
        },
      });
      assert.equal(rsvp.status, 200);
      for (const requestOrigin of [
        canonical,
        origin === alphaOrigin ? betaOrigin : alphaOrigin,
        "https://evil.test",
        null,
      ])
        assert.equal(
          (
            await request("/api/logout", {
              origin,
              cookie: guestLogin.cookie,
              method: "POST",
              requestOrigin,
              data: {},
            })
          ).status,
          403,
        );
      assert.equal((await request(`/h/${host.slug}`)).status, 200);
      assert.equal(
        (await request(`/api/public/households/${host.slug}`)).status,
        200,
      );
      const qr = await request("/api/host/qr", {
        origin,
        cookie: login.cookie,
      });
      assert.equal(qr.status, 200);
      assert.match(qr.body, /<svg/);
    }
    for (const origin of [
      "https://unknown.ilymmd.com",
      "https://unclaimed.ilymmd.com",
      "https://themeyers.ilymmd.com",
    ]) {
      const unavailable = await request("/", { origin });
      assert.equal(unavailable.status, 404);
      assert.doesNotMatch(
        unavailable.body,
        /Synthetic Raudman|Synthetic Dubois/,
      );
    }
    assert.equal(
      (
        await request("/api/session", {
          headers: { "x-events-verified-hostname": "theraudmans.ilymmd.com" },
          cookie: admin.cookie,
        })
      ).body.role,
      "admin",
    );
    assert.equal(
      (
        await request("/api/session", {
          headers: { "x-events-hostname": "theraudmans.ilymmd.com" },
        })
      ).status,
      403,
    );
    const forwarded = await forwardRequest(
      new Request(alphaOrigin + "/api/logout", {
        method: "POST",
        headers: { Origin: alphaOrigin },
      }),
      f.bindings,
    );
    const replay = () => f.app.fetch(forwarded.clone());
    assert.equal((await replay()).status, 200);
    assert.equal((await replay()).status, 403);
    const renamed = await request("/api/host/household", {
      method: "PUT",
      cookie: alpha.cookie,
      version: alpha.version,
      data: { name: alpha.name, design: {}, subdomain: "newraudmans" },
    });
    assert.equal(renamed.status, 403);
    assert.equal((await request("/", { origin: alphaOrigin })).status, 200);
    assert.equal(
      (await request(`/api/public/households/${alpha.slug}`)).status,
      200,
    );
  },
);

test("offline provisioning refuses reserved/existing hosts, catch-all routes and stale inventories", async () => {
  const { routingPlan } =
    await import("../scripts/prepare-household-routing.js");
  const inventory = {
    accountId: "e8cdf5b38fa02d2d1b7f30f2389888b7",
    zone: "ilymmd.com",
    checkedAt: new Date().toISOString(),
    complete: true,
    dnsNames: ["ilymmd.com", "www.ilymmd.com"],
    customDomains: ["themeyers.ilymmd.com"],
    routes: ["books.ilymmd.com/*", "ilymmd.com/themeyers/*"],
  };
  const plan = routingPlan(
    inventory,
    "theraudmans.ilymmd.com,thedubois.ilymmd.com",
    canonical,
    {},
  );
  assert.deepEqual(
    plan.gateway.routes.map((r) => r.pattern),
    ["theraudmans.ilymmd.com/*", "thedubois.ilymmd.com/*"],
  );
  assert.ok(
    plan.dnsAdditions.every(
      (r) => r.type === "AAAA" && r.content === "100::" && r.proxied,
    ),
  );
  assert.throws(() =>
    routingPlan(inventory, "themeyers.ilymmd.com", canonical, {}),
  );
  assert.throws(() =>
    routingPlan(
      { ...inventory, dnsNames: ["theraudmans.ilymmd.com"] },
      "theraudmans.ilymmd.com",
      canonical,
      {},
    ),
  );
  assert.throws(() =>
    routingPlan(
      { ...inventory, customDomains: ["theraudmans.ilymmd.com"] },
      "theraudmans.ilymmd.com",
      canonical,
      {},
    ),
  );
  for (const route of [
    "*.ilymmd.com/*",
    "*ilymmd.com/*",
    "https://theraudmans.ilymmd.com/*",
  ])
    assert.throws(() =>
      routingPlan(
        { ...inventory, routes: [route] },
        "theraudmans.ilymmd.com",
        canonical,
        {},
      ),
    );
  assert.throws(() =>
    routingPlan(
      { ...inventory, complete: false },
      "theraudmans.ilymmd.com",
      canonical,
      {},
    ),
  );
  assert.throws(() =>
    routingPlan(
      { ...inventory, checkedAt: "2020-01-01T00:00:00Z" },
      "theraudmans.ilymmd.com",
      canonical,
      {},
    ),
  );
});

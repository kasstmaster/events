import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, id, checkPassword, defaults } from "../server/model.js";
import { createApp } from "../server/app.js";
const origin = "http://127.0.0.1:3000";
const password = "Synthetic-only-password-2026";
async function fixture(t, { path } = {}) {
  const store = new Store(path),
    server = createApp({ store, origin, logger: { error: () => {} } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.db.close();
  });
  const request = async (
    path,
    { method = "GET", data, cookie, version, requestOrigin = origin } = {},
  ) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(requestOrigin ? { Origin: requestOrigin } : {}),
        ...(data ? { "Content-Type": "application/json" } : {}),
        ...(version !== undefined ? { "If-Match": String(version) } : {}),
      },
      body: data ? JSON.stringify(data) : undefined,
    });
    return {
      status: res.status,
      body: res.headers.get("content-type")?.includes("application/json")
        ? await res.json()
        : await res.text(),
      cookie: res.headers.get("set-cookie")?.split(";")[0],
      headers: res.headers,
    };
  };
  await store.createAdmin("admin@example.test", password);
  const admin = (
    await request("/api/login", {
      method: "POST",
      data: { email: "admin@example.test", password },
    })
  ).cookie;
  const host = async (name) => {
    await request("/api/admin/approvals", {
      method: "POST",
      cookie: admin,
      data: { email: `${name}@example.test` },
    });
    const result = await request("/api/register", {
      method: "POST",
      data: {
        email: `${name}@example.test`,
        password,
        name: `The ${name} Family`,
      },
    });
    assert.equal(result.status, 201);
    const data = (await request("/api/host", { cookie: result.cookie })).body;
    return { cookie: result.cookie, ...data };
  };
  const addGuest = async (host, first = "Casey", extra = {}) => {
    const result = await request("/api/host/guests", {
      method: "POST",
      cookie: host.cookie,
      data: {
        first,
        last: "Example",
        suffix: "",
        parent: "",
        address: "",
        ...extra,
      },
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body;
  };
  const addEvent = async (host, guests, extra = {}) => {
    const result = await request("/api/host/events", {
      method: "POST",
      cookie: host.cookie,
      data: {
        title: "Sunday supper",
        description: "Come together",
        date: "2028-06-12",
        time: "Two O’Clock",
        address: "A synthetic place",
        deadline: "2028-06-01",
        icon: "",
        design: {},
        template: "",
        invited: guests.map((g) => g.id),
        menu: [],
        registries: [],
        ...extra,
      },
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return result.body;
  };
  const guestLogin = async (host, guest) => {
    const result = await request(
      `/api/public/households/${host.household.slug}/login`,
      {
        method: "POST",
        data: { first: guest.first, last: guest.last, suffix: guest.suffix },
      },
    );
    assert.equal(result.status, 200);
    return result.cookie;
  };
  return { store, request, host, addGuest, addEvent, guestLogin, admin };
}
test("administrator approval, password hashing, role separation and CSRF", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.request("/api/register", {
        method: "POST",
        data: { email: "stranger@example.test", password, name: "Stranger" },
      })
    ).status,
    403,
  );
  const a = await f.host("Alpha");
  assert.equal(
    (await f.request("/api/admin", { cookie: a.cookie })).status,
    403,
  );
  assert.equal((await f.request("/api/admin")).status, 401);
  assert.equal((await f.request("/api/host", { cookie: f.admin })).status, 403);
  assert.equal(
    (
      await f.request("/api/host/household", {
        method: "PUT",
        cookie: a.cookie,
        version: 1,
        data: { name: "Forged", design: {} },
        requestOrigin: "https://evil.test",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/logout", {
        method: "POST",
        cookie: a.cookie,
        data: {},
        requestOrigin: null,
      })
    ).status,
    403,
  );
  const stored = f.store.one(
    "SELECT password FROM users WHERE email=?",
    "alpha@example.test",
  ).password;
  assert.notEqual(stored, password);
  assert.ok(await checkPassword(password, stored));
  assert.equal(
    (
      await f.request("/api/login", {
        method: "POST",
        data: { email: "alpha@example.test", password: "wrong" },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.request("/api/register", {
        method: "POST",
        data: { email: "alpha@example.test", password, name: "Again" },
      })
    ).status,
    403,
  );
  const login = await f.request("/api/login", {
    method: "POST",
    data: { email: "alpha@example.test", password },
  });
  assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  await f.request("/api/logout", {
    method: "POST",
    cookie: login.cookie,
    data: {},
  });
  assert.equal(
    (await f.request("/api/session", { cookie: login.cookie })).body.role,
    null,
  );
});
test("two hosts cannot read or mutate each other’s guests, addresses, events or settings", async (t) => {
  const f = await fixture(t),
    a = await f.host("Alpha"),
    b = await f.host("Beta");
  const guest = await f.addGuest(a),
    event = await f.addEvent(a, [guest]);
  const address = (
    await f.request("/api/host/addresses", {
      method: "POST",
      cookie: a.cookie,
      data: { label: "Private home", lines: "Private address" },
    })
  ).body;
  for (const [kind, item] of [
    ["guests", guest],
    ["addresses", address],
    ["events", event],
  ]) {
    assert.equal(
      (
        await f.request(`/api/host/${kind}/${item.id}`, {
          method: "DELETE",
          cookie: b.cookie,
          version: 1,
          data: {},
        })
      ).status,
      404,
    );
  }
  assert.equal(
    (
      await f.request(`/api/host/events/${event.id}/dashboard`, {
        cookie: b.cookie,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await f.request("/api/host/events", {
        method: "POST",
        cookie: b.cookie,
        data: { ...event, invited: [guest.id] },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request("/api/host/guests", {
        method: "POST",
        cookie: b.cookie,
        data: { ...guest, parent: guest.id },
      })
    ).status,
    400,
  );
  const view = (await f.request("/api/host", { cookie: b.cookie })).body;
  assert.equal(view.guests.length, 0);
  assert.equal(view.events.length, 0);
  assert.equal(view.addresses.length, 0);
  const publicPage = (
    await f.request("/api/public/households/" + a.household.slug)
  ).body;
  assert.equal(publicPage.name, "The Alpha Family");
  assert.equal(publicPage.guests, undefined);
});
test("adult login, suffixes, duplicate names and guest privacy fail safely", async (t) => {
  const f = await fixture(t),
    host = await f.host("Alpha");
  const adult = await f.addGuest(host, "Casey", { suffix: "Jr." }),
    child = await f.addGuest(host, "Kid", { parent: adult.id });
  const other = await f.addGuest(host, "Jordan"),
    event = await f.addEvent(host, [adult, child]);
  const hidden = await f.addEvent(host, [other], { title: "Uninvited event" }),
    cookie = await f.guestLogin(host, adult);
  const result = await f.request("/api/guest", { cookie });
  assert.equal(result.body.events.length, 1);
  const view = result.body.events[0];
  assert.equal(view.id, event.id);
  assert.equal(view.invited, undefined);
  assert.equal(view.members.length, 2);
  assert.equal(view.members[0].address, undefined);
  assert.equal(JSON.stringify(result.body).includes("Jordan"), false);
  assert.equal((await f.request("/api/host", { cookie })).status, 403);
  assert.equal(
    (
      await f.request(`/api/guest/events/${hidden.id}/rsvp`, {
        method: "PUT",
        cookie,
        data: {},
      })
    ).status,
    404,
  );
  const path = `/api/public/households/${host.household.slug}/login`;
  assert.equal(
    (
      await f.request(path, {
        method: "POST",
        data: { first: "Casey", last: "Example", suffix: "" },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.request(path, {
        method: "POST",
        data: { first: child.first, last: child.last, suffix: "" },
      })
    ).status,
    401,
  );
  await f.addGuest(host, "Casey", { suffix: "Jr." });
  const duplicate = await f.request(path, {
    method: "POST",
    data: { first: adult.first, last: adult.last, suffix: adult.suffix },
  });
  assert.equal(duplicate.status, 401);
  assert.equal(
    duplicate.body.error,
    "Unable to sign in with these details. Check with your host.",
  );
});
test("children, shared addresses, exact invitations and adult/child totals", async (t) => {
  const f = await fixture(t),
    h = await f.host("Alpha");
  const address = (
    await f.request("/api/host/addresses", {
      method: "POST",
      cookie: h.cookie,
      data: { label: "Example home", lines: "" },
    })
  ).body;
  const adult = await f.addGuest(h, "Casey", { address: address.id }),
    second = await f.addGuest(h, "Jordan", { address: address.id }),
    child = await f.addGuest(h, "Robin", {
      parent: adult.id,
      address: address.id,
    }),
    notInvited = await f.addGuest(h, "Taylor", { parent: adult.id });
  const event = await f.addEvent(h, [adult, second, child]);
  const cookie = await f.guestLogin(h, adult);
  assert.equal(
    (
      await f.request("/api/host/events", {
        method: "POST",
        cookie: h.cookie,
        data: { ...event, invited: [child.id] },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(`/api/guest/events/${event.id}/rsvp`, {
        method: "PUT",
        cookie,
        data: {
          version: 0,
          attendance: {
            [adult.id]: "yes",
            [child.id]: "yes",
            [notInvited.id]: "yes",
          },
          claims: {},
        },
      })
    ).status,
    400,
  );
  const result = await f.request(`/api/guest/events/${event.id}/rsvp`, {
    method: "PUT",
    cookie,
    data: {
      version: 0,
      attendance: { [adult.id]: "yes", [child.id]: "yes" },
      claims: {},
    },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.totals, {
    invited: 3,
    attending: 2,
    declined: 0,
    noResponse: 1,
  });
  const dash = (
    await f.request(`/api/host/events/${event.id}/dashboard`, {
      cookie: h.cookie,
    })
  ).body;
  assert.equal(dash.guests.length, 3);
  assert.equal(dash.responses[0].attendance[child.id], "yes");
});
test("quantity reservations are atomic, stale RSVP writes conflict, declines release claims", async (t) => {
  const f = await fixture(t),
    h = await f.host("Alpha"),
    a = await f.addGuest(h, "Casey"),
    b = await f.addGuest(h, "Jordan");
  const event = await f.addEvent(h, [a, b], {
    menu: [
      { id: "salad", name: "Salad", kind: "potluck", quantity: 2 },
      { id: "juice", name: "Juice", kind: "drink", quantity: 1 },
    ],
  });
  const ca = await f.guestLogin(h, a),
    cb = await f.guestLogin(h, b),
    path = `/api/guest/events/${event.id}/rsvp`;
  const results = await Promise.all(
    [
      [a, ca],
      [b, cb],
    ].map(([g, cookie]) =>
      f.request(path, {
        method: "PUT",
        cookie,
        data: {
          version: 0,
          attendance: { [g.id]: "yes" },
          claims: { salad: 2, juice: 1 },
        },
      }),
    ),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const winner = results[0].status === 200 ? a : b,
    wc = results[0].status === 200 ? ca : cb;
  assert.equal(
    (
      await f.request(path, {
        method: "PUT",
        cookie: wc,
        data: { version: 0, attendance: { [winner.id]: "no" }, claims: {} },
      })
    ).status,
    409,
  );
  const declined = await f.request(path, {
    method: "PUT",
    cookie: wc,
    data: {
      version: 1,
      attendance: { [winner.id]: "no" },
      claims: { salad: 2 },
    },
  });
  assert.equal(declined.status, 200);
  assert.deepEqual(declined.body.response.claims, {});
  assert.equal(declined.body.menu[0].claimed, 0);
  assert.equal(
    (
      await f.request(path, {
        method: "PUT",
        cookie: wc,
        data: {
          version: 2,
          attendance: { [winner.id]: "yes" },
          claims: { salad: -1 },
        },
      })
    ).status,
    400,
  );
});
test("deadline permits attendance changes and quantity reductions, and preserves existing over-capacity claims", async (t) => {
  const f = await fixture(t),
    h = await f.host("Alpha"),
    adult = await f.addGuest(h),
    child = await f.addGuest(h, "Robin", { parent: adult.id });
  let event = await f.addEvent(h, [adult, child], {
    menu: [{ id: "salad", name: "Salad", kind: "potluck", quantity: 3 }],
  });
  const cookie = await f.guestLogin(h, adult),
    path = `/api/guest/events/${event.id}/rsvp`;
  assert.equal(
    (
      await f.request(path, {
        method: "PUT",
        cookie,
        data: {
          version: 0,
          attendance: { [adult.id]: "yes", [child.id]: "yes" },
          claims: { salad: 3 },
        },
      })
    ).status,
    200,
  );
  event = (
    await f.request("/api/host/events/" + event.id, {
      method: "PUT",
      cookie: h.cookie,
      version: event.version,
      data: {
        ...event,
        deadline: "2020-01-01",
        menu: [{ ...event.menu[0], quantity: 1 }],
      },
    })
  ).body;
  assert.equal(
    (
      await f.request(path, {
        method: "PUT",
        cookie,
        data: {
          version: 1,
          attendance: { [adult.id]: "yes", [child.id]: "yes" },
          claims: { salad: 3 },
        },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request(path, {
        method: "PUT",
        cookie,
        data: {
          version: 2,
          attendance: { [adult.id]: "no", [child.id]: "yes" },
          claims: {},
        },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(path, {
        method: "PUT",
        cookie,
        data: {
          version: 2,
          attendance: { [adult.id]: "yes", [child.id]: "yes" },
          claims: { salad: 2 },
        },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request(path, {
        method: "PUT",
        cookie,
        data: {
          version: 3,
          attendance: { [adult.id]: "yes", [child.id]: "yes" },
          claims: { salad: 3 },
        },
      })
    ).status,
    409,
  );
});
test("household and event styles are independent, versioned and shared across browser sessions", async (t) => {
  const f = await fixture(t),
    a = await f.host("Alpha"),
    b = await f.host("Beta");
  const first = await f.addEvent(a, [], { design: { background: "#112233" } }),
    second = await f.addEvent(a, []);
  const design = { background: "#abcdef", titleFont: "Georgia", titleSize: 38 };
  assert.equal(
    (
      await f.request("/api/host/household", {
        method: "PUT",
        cookie: a.cookie,
        version: 1,
        data: { name: "Renamed family", design },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request("/api/host/household", {
        method: "PUT",
        cookie: a.cookie,
        version: 1,
        data: { name: "Stale", design: {} },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.request("/api/host/household", {
        method: "PUT",
        cookie: a.cookie,
        data: { name: "Missing version", design: {} },
      })
    ).status,
    428,
  );
  const secondDevice = (
    await f.request("/api/login", {
      method: "POST",
      data: { email: "alpha@example.test", password },
    })
  ).cookie;
  const view = (await f.request("/api/host", { cookie: secondDevice })).body;
  assert.equal(view.household.name, "Renamed family");
  assert.equal(view.household.design.background, "#abcdef");
  assert.equal(
    view.events.find((e) => e.id === first.id).design.background,
    "#112233",
  );
  assert.deepEqual(view.events.find((e) => e.id === second.id).design, {});
  assert.deepEqual(
    (await f.request("/api/host", { cookie: b.cookie })).body.household.design,
    {},
  );
  assert.equal(
    (await f.request("/api/public/households/" + a.household.slug)).body.name,
    "Renamed family",
  );
  assert.equal(
    (
      await f.request("/api/host/household", {
        method: "PUT",
        cookie: a.cookie,
        version: 2,
        data: { name: "No injection", design: { titleFont: "url(evil)" } },
      })
    ).status,
    400,
  );
  assert.equal(defaults.textSize, 17);
});
test("multiple optional registries retain event-specific order, validate links, and synchronize", async (t) => {
  const f = await fixture(t),
    h = await f.host("Alpha"),
    g = await f.addGuest(h);
  let event = await f.addEvent(h, [g], {
    registries: [
      { id: "amazon", title: "Amazon Registry", url: "https://example.test/a" },
      {
        id: "wedding",
        title: "Wedding Registry",
        url: "https://example.test/b",
      },
    ],
  });
  const other = await f.addEvent(h, [g]),
    cookie = await f.guestLogin(h, g);
  const changed = [
    { ...event.registries[1], title: "Our wish list" },
    event.registries[0],
  ];
  const saved = await f.request("/api/host/events/" + event.id, {
    method: "PUT",
    cookie: h.cookie,
    version: event.version,
    data: { ...event, registries: changed },
  });
  assert.equal(saved.status, 200);
  event = saved.body;
  let view = (await f.request("/api/guest", { cookie })).body;
  assert.deepEqual(
    view.events.find((e) => e.id === event.id).registries.map((r) => r.title),
    ["Our wish list", "Amazon Registry"],
  );
  assert.deepEqual(view.events.find((e) => e.id === other.id).registries, []);
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,bad",
    "https://user:password@example.test",
    "not-a-url",
  ])
    assert.equal(
      (
        await f.request("/api/host/events/" + event.id, {
          method: "PUT",
          cookie: h.cookie,
          version: event.version,
          data: { ...event, registries: [{ id: "bad", title: "Bad", url }] },
        })
      ).status,
      400,
    );
  const removed = await f.request("/api/host/events/" + event.id, {
    method: "PUT",
    cookie: h.cookie,
    version: event.version,
    data: { ...event, registries: [] },
  });
  assert.equal(removed.status, 200);
  view = (await f.request("/api/guest", { cookie })).body;
  assert.deepEqual(view.events.find((e) => e.id === event.id).registries, []);
});
test("QR links stay stable; templates are administrator managed; CSP and no-store protect responses", async (t) => {
  const f = await fixture(t),
    h = await f.host("Alpha");
  const qr = await f.request("/api/host/qr", { cookie: h.cookie });
  assert.equal(qr.status, 200);
  assert.match(qr.body, /<svg/);
  assert.equal(qr.headers.get("content-type"), "image/svg+xml");
  const data = {
    name: "Classic invitation",
    image: "data:image/png;base64,iVBORw0KGgo=",
  };
  assert.equal(
    (
      await f.request("/api/admin/templates", {
        method: "POST",
        cookie: h.cookie,
        data,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/admin/templates", {
        method: "POST",
        cookie: f.admin,
        data,
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await f.request("/api/admin/templates", {
        method: "POST",
        cookie: f.admin,
        data: { ...data, image: "data:image/svg+xml;base64,PHN2Zz4=" },
      })
    ).status,
    400,
  );
  await f.addEvent(h, []);
  assert.equal(
    (await f.request("/api/host/qr", { cookie: h.cookie })).body,
    qr.body,
  );
  const page = await f.request("/");
  assert.match(
    page.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  assert.equal(page.headers.get("cache-control"), "no-store");
});
test("database survives restart independently of browser state, and sessions expire", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "events-persist-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "store.sqlite"),
    store = new Store(path);
  await store.createAdmin("admin@example.test", password);
  store.run(
    "INSERT INTO approvals VALUES(?,?)",
    "host@example.test",
    new Date().toISOString(),
  );
  const host = await store.register({
    email: "host@example.test",
    password,
    name: "Persistent family",
  });
  const token = store.newSession(host),
    guestId = id();
  store.put("guest", guestId, host.household, {
    first: "Persisted",
    last: "Example",
    suffix: "",
    parent: "",
    address: "",
  });
  store.db.close();
  const reopened = new Store(path);
  assert.equal(reopened.household(host.household).name, "Persistent family");
  assert.equal(
    reopened.get("guest", guestId, host.household).first,
    "Persisted",
  );
  assert.equal(reopened.session(token.token).role, "host");
  reopened.run("UPDATE sessions SET expires=0");
  assert.equal(reopened.session(token.token), null);
  reopened.db.close();
});
test("persistent rate limits restrict repeated name and password attempts without enumerating guests", async (t) => {
  const f = await fixture(t),
    h = await f.host("Alpha"),
    path = `/api/public/households/${h.household.slug}/login`;
  for (let n = 0; n < 10; n++)
    assert.equal(
      (
        await f.request(path, {
          method: "POST",
          data: { first: "Unknown", last: "Person", suffix: "" },
        })
      ).status,
      401,
    );
  assert.equal(
    (
      await f.request(path, {
        method: "POST",
        data: { first: "Unknown", last: "Person", suffix: "" },
      })
    ).status,
    429,
  );
});

test("template updates are versioned and removal protects events using them", async (t) => {
  const f = await fixture(t),
    h = await f.host("Alpha");
  let template = (
    await f.request("/api/admin/templates", {
      method: "POST",
      cookie: f.admin,
      data: { name: "First artwork", image: "" },
    })
  ).body;
  assert.equal(
    (
      await f.request("/api/admin/templates/" + template.id, {
        method: "PUT",
        cookie: h.cookie,
        version: 1,
        data: { name: "Forbidden" },
      })
    ).status,
    403,
  );
  const changed = await f.request("/api/admin/templates/" + template.id, {
    method: "PUT",
    cookie: f.admin,
    version: 1,
    data: { name: "Renamed artwork" },
  });
  assert.equal(changed.status, 200);
  template = changed.body;
  const event = await f.addEvent(h, [], { template: template.id });
  assert.equal(
    (
      await f.request("/api/admin/templates/" + template.id, {
        method: "DELETE",
        cookie: f.admin,
        version: template.version,
        data: {},
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.request("/api/host/events/" + event.id, {
        method: "DELETE",
        cookie: h.cookie,
        version: event.version,
        data: {},
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request("/api/admin/templates/" + template.id, {
        method: "DELETE",
        cookie: f.admin,
        version: template.version,
        data: {},
      })
    ).status,
    200,
  );
});

test("guest/address lifecycle protects invitations and invalidates former adult sessions", async (t) => {
  const f = await fixture(t),
    h = await f.host("Alpha");
  let adult = await f.addGuest(h, "Casey"),
    other = await f.addGuest(h, "Jordan");
  const cookie = await f.guestLogin(h, adult);
  const address = (
    await f.request("/api/host/addresses", {
      method: "POST",
      cookie: h.cookie,
      data: { label: "Shared home", lines: "A synthetic address" },
    })
  ).body;
  adult = (
    await f.request("/api/host/guests/" + adult.id, {
      method: "PUT",
      cookie: h.cookie,
      version: adult.version,
      data: { ...adult, address: address.id },
    })
  ).body;
  assert.equal(
    (
      await f.request("/api/host/addresses/" + address.id, {
        method: "DELETE",
        cookie: h.cookie,
        version: address.version,
        data: {},
      })
    ).status,
    409,
  );
  const event = await f.addEvent(h, [adult]);
  assert.equal(
    (
      await f.request("/api/host/guests/" + adult.id, {
        method: "DELETE",
        cookie: h.cookie,
        version: adult.version,
        data: {},
      })
    ).status,
    409,
  );
  await f.request("/api/host/events/" + event.id, {
    method: "DELETE",
    cookie: h.cookie,
    version: event.version,
    data: {},
  });
  assert.equal(
    (
      await f.request("/api/host/guests/" + adult.id, {
        method: "PUT",
        cookie: h.cookie,
        version: adult.version,
        data: { ...adult, parent: other.id },
      })
    ).status,
    200,
  );
  assert.equal((await f.request("/api/guest", { cookie })).status, 401);
});

test("malformed menus, dates, styles and registry IDs fail validation without storing unsafe data", async (t) => {
  const f = await fixture(t),
    h = await f.host("Alpha"),
    event = await f.addEvent(h, []);
  for (const patch of [
    { menu: [null] },
    { date: "2028-02-31" },
    { registries: [null] },
    {
      registries: [
        { id: '"><script>', title: "Bad", url: "https://example.test" },
      ],
    },
    { design: { backgroundImage: "https://outside.test/tracking.png" } },
  ]) {
    const result = await f.request("/api/host/events/" + event.id, {
      method: "PUT",
      cookie: h.cookie,
      version: event.version,
      data: { ...event, ...patch },
    });
    assert.equal(result.status, 400, JSON.stringify(result.body));
  }
  assert.equal(
    (await f.request("/api/host", { cookie: h.cookie })).body.events[0].version,
    1,
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHmac } from "node:crypto";
import { Store } from "../server/node-store.js";
import { createApp } from "../server/app.js";
import { newCard, renderCard } from "../public/card-system.js";
import { effectiveUI } from "../server/features.js";
import {
  runReminders,
  verifyTwilio,
  processTwilio,
} from "../server/reminders.js";
import { runAccountCleanup } from "../cloudflare/account-cleanup.js";
const password = "Synthetic-features-password",
  origin = "http://127.0.0.1:3000";
async function fixture(t, env = {}) {
  const store = new Store(),
    server = createApp({ store, origin, env, logger: { error: () => {} } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((r) => server.close(r));
    store.db.close();
  });
  const request = async (
    path,
    { method = "GET", data, cookie, version } = {},
  ) => {
    const r = await fetch("http://127.0.0.1:" + server.address().port + path, {
      method,
      headers: {
        Origin: origin,
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { "Content-Type": "application/json" } : {}),
        ...(version !== undefined ? { "If-Match": String(version) } : {}),
      },
      body: data ? JSON.stringify(data) : undefined,
    });
    return {
      status: r.status,
      body: await r.json(),
      cookie: r.headers.get("set-cookie")?.split(";")[0],
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
      data: { email: name + "@example.test" },
    });
    const r = await request("/api/register", {
      method: "POST",
      data: { email: name + "@example.test", password, name },
    });
    assert.equal(r.status, 201);
    return {
      cookie: r.cookie,
      ...(await request("/api/host", { cookie: r.cookie })).body,
    };
  };
  const guest = async (h, name = "Casey", extra = {}) => {
    const r = await request("/api/host/guests", {
      method: "POST",
      cookie: h.cookie,
      data: { first: name, last: "Example", ...extra },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  const event = async (h, guests = [], extra = {}) => {
    const r = await request("/api/host/events", {
      method: "POST",
      cookie: h.cookie,
      data: {
        title: "Shared supper",
        description: "Join us",
        date: "2028-06-12",
        deadline: "2028-06-01",
        invited: guests.map((g) => g.id),
        menu: [],
        ...extra,
      },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  const guestLogin = async (h, g) =>
    (
      await request(`/api/public/households/${h.household.slug}/login`, {
        method: "POST",
        data: { first: g.first, last: g.last, suffix: g.suffix },
      })
    ).cookie;
  return {
    store,
    request,
    admin,
    host,
    guest,
    event,
    guestLogin,
    baseURL: "http://127.0.0.1:" + server.address().port,
  };
}

test("global positions and wording apply to all pages while existing tenant formatting is preserved", async (t) => {
  const f = await fixture(t),
    h = await f.host("Alpha"),
    g = await f.guest(h),
    event = await f.event(h, [g], { design: { titleColor: "#112233" } });
  const defaults = {
    copy: { When: "Gathering date" },
    design: {
      titleColor: "#445566",
      descriptionFont: "Georgia",
      buttonColor: "#773322",
    },
    layouts: { event: ["actions", "information", "personal", "menus"] },
  };
  assert.equal(
    (
      await f.request("/api/admin/defaults", {
        method: "PUT",
        cookie: h.cookie,
        version: 0,
        data: defaults,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/admin/defaults", {
        method: "PUT",
        cookie: f.admin,
        version: 0,
        data: defaults,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request("/api/admin/defaults", {
        method: "PUT",
        cookie: f.admin,
        version: 0,
        data: defaults,
      })
    ).status,
    409,
  );
  const cookie = await f.guestLogin(h, g),
    view = (await f.request("/api/guest", { cookie })).body;
  assert.equal(view.events[0].ui.design.titleColor, "#112233");
  assert.equal(view.events[0].ui.copy.When, "Gathering date");
  assert.equal(view.events[0].ui.design.descriptionFont, "system-ui");
  assert.deepEqual(view.events[0].ui.layouts.event, defaults.layouts.event);
  for (const path of [
    "/api/host/interface/event/" + event.id,
    "/api/host/events/" + event.id,
  ]) {
    assert.equal(
      (
        await f.request(path, {
          method: "PUT",
          cookie: h.cookie,
          version: event.version,
          data: {
            ...event,
            ui: {
              copy: { When: "Our date" },
              design: { textColor: "#223344" },
            },
          },
        })
      ).status,
      403,
    );
  }
  assert.equal(
    (
      await f.request("/api/host/household", {
        method: "PUT",
        cookie: h.cookie,
        version: 1,
        data: {
          name: "Alpha",
          design: {},
          ui: { layouts: { event: defaults.layouts.event } },
        },
      })
    ).status,
    403,
  );
  for (const method of ["GET", "PUT"]) {
    assert.equal(
      (
        await f.request("/api/admin/interface/event/" + event.id, {
          method,
          cookie: f.admin,
          version: event.version,
          data:
            method === "PUT"
              ? { ui: { design: { titleColor: "#ffffff" } } }
              : undefined,
        })
      ).status,
      403,
    );
  }
  assert.equal(
    (
      await f.request("/api/host/interface/event/" + event.id, {
        method: "PUT",
        cookie: h.cookie,
        version: event.version,
        data: {
          ui: {
            design: {
              textColor: "#223344",
              borderColor: "#abcdef",
              toolbarColor: "#123456",
              eyebrowColor: "#654321",
              notesColor: "#222222",
            },
          },
        },
      })
    ).status,
    200,
  );
  const formatted = effectiveUI(
    f.store,
    f.store.household(h.household.id),
    f.store.get("event", event.id, h.household.id),
  );
  assert.equal(formatted.copy.When, "Gathering date");
  assert.equal(formatted.design.borderColor, "#abcdef");
  assert.equal(formatted.design.textColor, "#223344");
  assert.notEqual(
    effectiveUI(f.store, f.store.household(h.household.id)).design.borderColor,
    "#abcdef",
  );
  const newHost = await f.host("Beta");
  assert.equal(
    effectiveUI(f.store, f.store.household(newHost.household.id)).design
      .descriptionFont,
    "Georgia",
  );
  const prior = f.store.household(h.household.id);
  assert.equal(
    (
      await f.request("/api/admin/defaults", {
        method: "PUT",
        cookie: f.admin,
        version: 1,
        data: {
          ...defaults,
          design: { ...defaults.design, textColor: "#999999" },
          copy: { When: "New shared wording" },
        },
      })
    ).status,
    200,
  );
  assert.equal(
    effectiveUI(f.store, f.store.household(h.household.id)).design.textColor,
    prior.design.textColor,
  );
  assert.equal(
    effectiveUI(
      f.store,
      f.store.household(h.household.id),
      f.store.get("event", event.id, h.household.id),
    ).design.textColor,
    "#223344",
  );
  assert.equal(
    effectiveUI(f.store, f.store.household(h.household.id)).copy.When,
    "New shared wording",
  );
  assert.equal(
    (
      await f.request("/api/admin/defaults", {
        method: "PUT",
        cookie: f.admin,
        version: 2,
        data: { ...defaults, layouts: { event: ["actions", "actions"] } },
      })
    ).status,
    400,
  );
});

test("private notes, consent/phones and external upload links stay in their authorized scopes", async (t) => {
  const f = await fixture(t),
    h = await f.host("Alpha"),
    other = await f.host("Beta");
  const g = await f.guest(h, "Casey", {
    phone: "+1 (555) 123-4567",
    smsConsent: true,
  });
  assert.equal(g.phone, "+15551234567");
  assert.equal(g.smsConsent, true);
  let e = await f.event(h, [g], {
    notes: "Private event plans",
    uploadURL: "https://example.test/upload",
  });
  assert.equal(
    (
      await f.request("/api/host/household", {
        method: "PUT",
        cookie: h.cookie,
        version: h.household.version,
        data: { ...h.household, notes: "Private household plans" },
      })
    ).status,
    200,
  );
  const guestCookie = await f.guestLogin(h, g),
    view = (await f.request("/api/guest", { cookie: guestCookie })).body;
  assert.equal(view.events[0].uploadURL, "https://example.test/upload");
  assert.doesNotMatch(
    JSON.stringify(view),
    /Private event plans|Private household plans|15551234567|smsConsent/,
  );
  assert.equal(
    (await f.request("/api/host", { cookie: other.cookie })).body.events.length,
    0,
  );
  assert.equal(
    (
      await f.request("/api/host/events/" + e.id, {
        method: "PUT",
        cookie: h.cookie,
        version: e.version,
        data: { ...e, uploadURL: "javascript:alert(1)" },
      })
    ).status,
    400,
  );
  e = (
    await f.request("/api/host/events/" + e.id, {
      method: "PUT",
      cookie: h.cookie,
      version: e.version,
      data: { ...e, uploadURL: "" },
    })
  ).body;
  assert.equal(e.uploadURL, "");
  const preview = (
    await f.request("/api/admin/preview", {
      method: "POST",
      cookie: f.admin,
      data: { household: h.household.id, event: e.id },
    })
  ).body;
  assert.equal(preview.preview, true);
  assert.doesNotMatch(
    JSON.stringify(preview),
    /Private event plans|Private household plans/,
  );
  assert.equal(f.store.list("response", h.household.id).length, 0);
  assert.equal(
    (
      await f.request("/api/admin/preview", {
        method: "POST",
        cookie: h.cookie,
        data: { household: other.household.id },
      })
    ).status,
    403,
  );
});

test("shared card editor data is tenant scoped, dynamic fields are escaped, source updates never overwrite saved cards", async (t) => {
  const f = await fixture(t),
    h = await f.host("Alpha"),
    b = await f.host("Beta"),
    g = await f.guest(h, "Casey"),
    e = await f.event(h, [g]);
  const original = newCard("Invitation");
  original.elements[0].field = "recipient.name";
  original.elements[0].fallback = "Dear friend";
  const template = (
    await f.request("/api/admin/templates", {
      method: "POST",
      cookie: f.admin,
      data: original,
    })
  ).body;
  const saved = (
    await f.request("/api/host/cards", {
      method: "POST",
      cookie: h.cookie,
      data: {
        ...template,
        event: e.id,
        recipient: g.id,
        sourceTemplate: template.id,
      },
    })
  ).body;
  assert.equal(saved.context.recipient.name, "Casey Example");
  assert.equal(saved.elements[0].font, "Georgia");
  assert.equal(
    (await f.request("/api/host/cards/" + saved.id, { cookie: b.cookie }))
      .status,
    404,
  );
  assert.equal(
    (
      await f.request("/api/host/cards", {
        method: "POST",
        cookie: h.cookie,
        data: { ...original, event: "unowned-id" },
      })
    ).status,
    404,
  );
  await f.request("/api/admin/templates/" + template.id, {
    method: "PUT",
    cookie: f.admin,
    version: template.version,
    data: {
      ...original,
      name: "New source",
      elements: [{ ...original.elements[0], color: "#ff0000" }],
    },
  });
  const unchanged = (
    await f.request("/api/host/cards/" + saved.id, { cookie: h.cookie })
  ).body;
  assert.equal(unchanged.name, "Invitation");
  assert.notEqual(unchanged.elements[0].color, "#ff0000");
  const privateTemplate = (
    await f.request("/api/host/private-templates", {
      method: "POST",
      cookie: h.cookie,
      data: original,
    })
  ).body;
  assert.equal(privateTemplate.name, "Invitation");
  assert.equal(
    (await f.request("/api/host/private-templates", { cookie: b.cookie })).body
      .length,
    0,
  );
  const svg = renderCard(
    original,
    { recipient: { name: "<script>alert(1)</script>" } },
    "data:image/svg+xml;base64,PHN2Zy8+",
  );
  assert.match(svg, /&lt;script&gt;/);
  assert.doesNotMatch(svg, /<script>/);
  assert.match(
    renderCard(original, {}, "data:image/svg+xml;base64,PHN2Zy8+"),
    /Dear friend/,
  );
  assert.match(svg, /data:image\/svg\+xml/);
  assert.doesNotMatch(
    renderCard(
      { ...original, includeQR: false },
      {},
      "data:image/svg+xml;base64,PHN2Zy8+",
    ),
    /data:image\/svg\+xml/,
  );
});

test("SMS reminders are opt-in, recheck RSVP eligibility, deduplicate dispatch and never claim unconfirmed delivery", async (t) => {
  const env = {
      SMS_ENABLED: "true",
      TWILIO_ACCOUNT_SID: "synthetic-sid",
      TWILIO_AUTH_TOKEN: "synthetic-secret",
      TWILIO_FROM: "+15550000000",
    },
    f = await fixture(t, env),
    h = await f.host("Alpha");
  const a = await f.guest(h, "Casey", {
      phone: "+15551234567",
      smsConsent: true,
    }),
    b = await f.guest(h, "Jordan", {
      phone: "+15557654321",
      smsConsent: false,
    }),
    child = await f.guest(h, "Robin", {
      phone: "+15550000001",
      smsConsent: true,
      parent: a.id,
    });
  const reminder = {
      id: "rsvp-1",
      kind: "rsvp",
      enabled: true,
      when: "2026-01-01T12:00:00Z",
      timezone: "America/Los_Angeles",
      message: "Please RSVP",
    },
    e = await f.event(h, [a, b, child], { reminders: [reminder] });
  let calls = 0;
  const fetcher = async (url, init) => {
    calls++;
    assert.match(String(init.body), /Reply\+STOP/);
    return Response.json({ sid: "synthetic-message-id" });
  };
  await runReminders(
    f.store,
    {},
    { fetcher, now: () => Date.parse("2026-10-31T12:00:00Z") },
  );
  assert.equal(calls, 0);
  await Promise.all([
    runReminders(f.store, env, { fetcher }),
    runReminders(f.store, env, { fetcher }),
  ]);
  assert.equal(calls, 1);
  assert.equal(
    f.store.one("SELECT status FROM reminder_deliveries").status,
    "accepted",
  );
  const params = new URLSearchParams({ From: a.phone, Body: "STOP" }),
    url = origin + "/api/messaging/twilio",
    signature = createHmac("sha1", env.TWILIO_AUTH_TOKEN)
      .update(
        url +
          [...params.keys()]
            .sort()
            .map((k) => k + params.get(k))
            .join(""),
      )
      .digest("base64");
  assert.ok(verifyTwilio(url, params, signature, env.TWILIO_AUTH_TOKEN));
  assert.equal(
    verifyTwilio(url, params, "forged", env.TWILIO_AUTH_TOKEN),
    false,
  );
  processTwilio(f.store, params);
  const updated = f.store.get("event", e.id, h.household.id);
  f.store.put(
    "event",
    e.id,
    h.household.id,
    { ...updated, reminders: [{ ...reminder, id: "rsvp-2" }] },
    updated.version,
  );
  await runReminders(f.store, env, { fetcher });
  assert.equal(calls, 1, "STOP must suppress future reminders");
  assert.equal(
    (
      await f.request(`/api/host/events/${e.id}/reminders`, {
        method: "POST",
        cookie: h.cookie,
        data: { reminders: [{ ...reminder, timezone: "not/a/timezone" }] },
      })
    ).status,
    400,
  );
});

test("host deletion requires admin confirmation, revokes sessions, retains unrelated households and refuses foreign routing resources", async (t) => {
  const f = await fixture(t),
    h = await f.host("Alpha"),
    other = await f.host("Beta"),
    g = await f.guest(h),
    event = await f.event(h, [g], { notes: "Private event" }),
    host = f.store.one("SELECT * FROM users WHERE email='alpha@example.test'");
  const path = "/api/admin/hosts/" + host.id + "/deletion";
  assert.equal((await f.request(path, { cookie: h.cookie })).status, 403);
  const summary = (await f.request(path, { cookie: f.admin })).body;
  assert.equal(summary.domain, "alpha.ilymmd.com");
  assert.equal(summary.counts.event, 1);
  assert.equal(
    (
      await f.request(path, {
        method: "POST",
        cookie: f.admin,
        data: {
          confirmEmail: "wrong@example.test",
          confirmDomain: summary.domain,
          householdVersion: h.household.version,
          confirmRevision: summary.revision,
        },
      })
    ).status,
    400,
  );
  const job = f.store.routingJob("alpha");
  f.store.routingReceipt("alpha", {
    dns_id: "owned-dns",
    route_id: "owned-route",
  });
  assert.equal(
    (
      await f.request(path, {
        method: "POST",
        cookie: f.admin,
        data: {
          confirmEmail: host.email,
          confirmDomain: summary.domain,
          householdVersion: h.household.version,
          confirmRevision: summary.revision,
        },
      })
    ).status,
    202,
  );
  assert.equal(
    (await f.request("/api/host", { cookie: h.cookie })).status,
    401,
  );
  assert.equal(
    (
      await f.request("/api/login", {
        method: "POST",
        data: { email: host.email, password },
      })
    ).status,
    401,
  );
  const writes = [];
  let conflict = true,
    dnsExists = true,
    routeExists = true;
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/workers/domains"))
      return Response.json({ success: true, result: [] });
    let value = path.includes("/dns_records/")
      ? dnsExists
        ? {
            id: "owned-dns",
            name: "alpha.ilymmd.com",
            type: "AAAA",
            content: "100::",
            proxied: true,
            comment: conflict ? "somebody-else" : `events-household:${job.id}`,
          }
        : null
      : routeExists
        ? {
            id: "owned-route",
            pattern: "alpha.ilymmd.com/*",
            script: "events-household-gateway",
          }
        : null;
    if (init.method === "DELETE") {
      writes.push(path);
      if (path.includes("/dns_records/")) dnsExists = false;
      else routeExists = false;
      return Response.json({ success: true, result: {} });
    }
    if (!value) return new Response("", { status: 404 });
    return Response.json({ success: true, result: value });
  };
  await runAccountCleanup(
    f.store,
    { HOUSEHOLD_DNS_TOKEN: "synthetic" },
    { fetcher, now: () => 1000 },
  );
  assert.equal(writes.length, 0);
  assert.equal(
    f.store.one("SELECT error FROM household_deletions").error,
    "cleanup_ownership_conflict",
  );
  assert.ok(f.store.household(h.household.id));
  conflict = false;
  await runAccountCleanup(
    f.store,
    { HOUSEHOLD_DNS_TOKEN: "synthetic" },
    { fetcher, now: () => 400000 },
  );
  assert.equal(writes.length, 2);
  assert.equal(f.store.household(h.household.id), null);
  assert.ok(f.store.household(other.household.id));
  assert.equal(
    f.store.one("SELECT retired FROM household_domains WHERE label='alpha'")
      .retired,
    1,
  );
  assert.equal(
    (await f.request("/api/host", { cookie: other.cookie })).status,
    200,
  );
  assert.equal(
    f.store.one("SELECT role FROM users WHERE role='admin'").role,
    "admin",
  );
});

test("reminder wall times respect IANA time zones and reject clock-change gaps or ambiguity", async () => {
  const { utcSchedule, localSchedule } =
    await import("../public/reminder-time.js");
  assert.equal(
    utcSchedule("2028-05-25T12:00", "America/Los_Angeles"),
    "2028-05-25T19:00:00.000Z",
  );
  assert.equal(
    localSchedule("2028-05-25T19:00:00.000Z", "America/Los_Angeles"),
    "2028-05-25T12:00",
  );
  assert.throws(
    () => utcSchedule("2026-03-08T02:30", "America/Los_Angeles"),
    /does not exist/,
  );
  assert.throws(
    () => utcSchedule("2026-11-01T01:30", "America/Los_Angeles"),
    /occurs twice/,
  );
});

test("upcoming reminders recheck attendance and cancelled/deleted events never dispatch", async (t) => {
  const { reminderRecipients } = await import("../server/reminders.js");
  const f = await fixture(t),
    h = await f.host("Alpha"),
    a = await f.guest(h, "Casey", { phone: "+15551234567", smsConsent: true }),
    b = await f.guest(h, "Jordan", { phone: "+15557654321", smsConsent: true });
  const schedule = {
      id: "upcoming",
      kind: "upcoming",
      enabled: true,
      when: "2026-01-01T12:00:00Z",
      timezone: "UTC",
      message: "See you soon",
    },
    event = await f.event(h, [a, b], { reminders: [schedule] });
  const cookie = await f.guestLogin(h, a);
  await f.request(`/api/guest/events/${event.id}/rsvp`, {
    method: "PUT",
    cookie,
    data: { version: 0, attendance: { [a.id]: "yes" }, claims: {} },
  });
  assert.deepEqual(
    reminderRecipients(f.store, h.household.id, event, schedule).map(
      (g) => g.id,
    ),
    [a.id],
  );
  await f.request(`/api/guest/events/${event.id}/rsvp`, {
    method: "PUT",
    cookie,
    data: { version: 1, attendance: { [a.id]: "no" }, claims: {} },
  });
  let calls = 0;
  const env = {
      SMS_ENABLED: "true",
      TWILIO_ACCOUNT_SID: "synthetic",
      TWILIO_AUTH_TOKEN: "synthetic",
      TWILIO_FROM: "+15550000000",
    },
    fetcher = async () => {
      calls++;
      return Response.json({ sid: "synthetic" });
    };
  await runReminders(f.store, env, { fetcher });
  assert.equal(calls, 0);
  await f.request("/api/host/events/" + event.id, {
    method: "DELETE",
    cookie: h.cookie,
    version: event.version,
    data: {},
  });
  await runReminders(f.store, env, { fetcher });
  assert.equal(calls, 0);
});

test("unconfirmed SMS outcomes are not retried and signed delivery receipts cannot regress a delivered message", async (t) => {
  const f = await fixture(t),
    h = await f.host("Alpha"),
    a = await f.guest(h, "Casey", { phone: "+15551234567", smsConsent: true });
  const event = await f.event(h, [a], {
    reminders: [
      {
        id: "uncertain",
        kind: "rsvp",
        enabled: true,
        when: "2026-01-01T12:00:00Z",
        timezone: "UTC",
        message: "Please RSVP",
      },
    ],
  });
  const env = {
    SMS_ENABLED: "true",
    TWILIO_ACCOUNT_SID: "synthetic",
    TWILIO_AUTH_TOKEN: "synthetic",
    TWILIO_FROM: "+15550000000",
  };
  let calls = 0;
  const fetcher = async () => {
    calls++;
    throw new Error("synthetic transport timeout");
  };
  await runReminders(f.store, env, { fetcher });
  await runReminders(f.store, env, { fetcher });
  assert.equal(calls, 1);
  assert.equal(
    f.store.one("SELECT status FROM reminder_deliveries").status,
    "unknown",
  );
  f.store.run("UPDATE reminder_deliveries SET status='sending',updated=0");
  await runReminders(f.store, {}, {});
  assert.equal(
    f.store.one("SELECT status FROM reminder_deliveries").status,
    "unknown",
  );
  f.store.run(
    "UPDATE reminder_deliveries SET status='accepted',provider_id='synthetic-receipt'",
  );
  processTwilio(
    f.store,
    new URLSearchParams({
      MessageSid: "synthetic-receipt",
      MessageStatus: "delivered",
    }),
  );
  processTwilio(
    f.store,
    new URLSearchParams({
      MessageSid: "synthetic-receipt",
      MessageStatus: "sent",
    }),
  );
  assert.equal(
    f.store.one("SELECT status FROM reminder_deliveries").status,
    "delivered",
  );
});

test("stale deletion confirmations cannot disable a household with newly changed data", async (t) => {
  const f = await fixture(t),
    h = await f.host("Alpha"),
    user = f.store.one("SELECT id FROM users WHERE email='alpha@example.test'");
  const path = "/api/admin/hosts/" + user.id + "/deletion",
    summary = (await f.request(path, { cookie: f.admin })).body;
  await f.guest(h);
  assert.equal(
    (
      await f.request(path, {
        method: "POST",
        cookie: f.admin,
        data: {
          confirmEmail: "alpha@example.test",
          confirmDomain: summary.domain,
          householdVersion: h.household.version,
          confirmRevision: summary.revision,
        },
      })
    ).status,
    409,
  );
  assert.equal(
    f.store.one("SELECT household FROM household_deletions"),
    undefined,
  );
  assert.equal(
    (await f.request("/api/host", { cookie: h.cookie })).status,
    200,
  );
});

test("edited copy stays text and never affects protocol values or user content", async () => {
  const { configureCopy, C, H, ui } = await import("../public/ui-runtime.js");
  configureCopy({
    copy: { When: "<img src=x onerror=alert(1)>", POST: "wrong-method" },
  });
  assert.equal(String(C("When")), "<img src=x onerror=alert(1)>");
  assert.match(ui`<p>${C("When")}</p>`, /&lt;img/);
  assert.doesNotMatch(ui`<p>${C("When")}</p>`, /<img/);
  assert.match(H("When"), /&lt;img/);
  assert.equal(String(C(C("When"))), String(C("When")));
  configureCopy({ copy: {} });
});

test("account cleanup pauses and checks every custom-domain inventory page before deleting receipts", async (t) => {
  const f = await fixture(t),
    h = await f.host("Alpha"),
    user = f.store.one("SELECT id FROM users WHERE email='alpha@example.test'");
  const path = `/api/admin/hosts/${user.id}/deletion`,
    summary = (await f.request(path, { cookie: f.admin })).body;
  f.store.routingReceipt("alpha", {
    dns_id: "owned-dns",
    route_id: "owned-route",
  });
  assert.equal(
    (
      await f.request(path, {
        method: "POST",
        cookie: f.admin,
        data: {
          confirmEmail: summary.email,
          confirmDomain: summary.domain,
          householdVersion: summary.householdVersion,
          confirmRevision: summary.revision,
        },
      })
    ).status,
    202,
  );
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, method: init.method });
    const page = new URL(url).searchParams.get("page");
    assert.ok(
      url.includes("/workers/domains"),
      "must discover conflict before looking up or deleting resources",
    );
    return Response.json({
      success: true,
      result: page === "2" ? [{ hostname: "alpha.ilymmd.com" }] : [],
      result_info: { total_pages: 2 },
    });
  };
  await runAccountCleanup(
    f.store,
    { ACCOUNT_CLEANUP_ENABLED: "false" },
    { fetcher, now: () => 1000 },
  );
  assert.equal(calls.length, 0);
  await runAccountCleanup(
    f.store,
    { HOUSEHOLD_DNS_TOKEN: "synthetic" },
    { fetcher, now: () => 1000 },
  );
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.method === "GET"));
  assert.equal(
    f.store.one("SELECT error FROM household_deletions").error,
    "cleanup_ownership_conflict",
  );
  assert.ok(f.store.household(h.household.id));
});

test("only a valid signed provider webhook can record an opt-out without a browser Origin", async (t) => {
  const token = "synthetic-provider-secret",
    f = await fixture(t, { TWILIO_AUTH_TOKEN: token });
  const path = "/api/messaging/twilio",
    params = new URLSearchParams({ From: "+15551234567", Body: "STOP" });
  const post = (signature) =>
    fetch(f.baseURL + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Twilio-Signature": signature,
      },
      body: params,
    });
  assert.equal((await post("forged")).status, 403);
  assert.equal(f.store.one("SELECT phone FROM sms_optouts"), undefined);
  const signature = createHmac("sha1", token)
    .update(
      origin +
        path +
        [...params.keys()]
          .sort()
          .map((k) => k + params.get(k))
          .join(""),
    )
    .digest("base64");
  const response = await post(signature);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "<Response/>");
  assert.equal(
    f.store.one("SELECT phone FROM sms_optouts").phone,
    "+15551234567",
  );
});

test("legacy scoped wording/layout can round-trip unchanged without blocking private notes", async (t) => {
  const f = await fixture(t),
    h = await f.host("Legacy");
  const current = f.store.household(h.household.id);
  const legacy = f.store.put(
    "household",
    current.id,
    current.id,
    {
      ...current,
      ui: {
        copy: { When: "Old scoped wording" },
        layouts: {
          eventButtons: [
            "edit-event",
            "invitation",
            "delete-event",
            "rsvp",
            "uploads",
          ],
        },
        design: {},
      },
    },
    current.version,
  );
  const result = await f.request("/api/host/household", {
    method: "PUT",
    cookie: h.cookie,
    version: legacy.version,
    data: { ...legacy, notes: "Still private" },
  });
  assert.equal(result.status, 200);
  assert.equal(f.store.household(current.id).notes, "Still private");
  assert.deepEqual(f.store.household(current.id).ui, legacy.ui);
  assert.equal(
    effectiveUI(f.store, f.store.household(current.id)).copy.When,
    undefined,
  );
  assert.equal(
    (
      await f.request("/api/host/household", {
        method: "PUT",
        cookie: h.cookie,
        version: result.body.version,
        data: {
          ...result.body,
          ui: { copy: { When: "Changed scoped wording" } },
        },
      })
    ).status,
    403,
  );
});

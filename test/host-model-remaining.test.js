import test from "node:test";
import assert from "node:assert/strict";
import { application, password } from "./helpers/application.js";
import {
  addressBookCheckpoint,
  isolateAddressBook,
} from "../server/recipient-isolation.js";
import { ensureHostRoster } from "../server/host-roster.js";
import { publicEventReference } from "../server/public-invitations.js";
const mode = {
  HOST_ONLY_MODEL_ENABLED: "true",
  HOST_ONLY_MODEL_ACTIVATION_APPROVED: "true",
};
async function fixture(t, options = {}) {
  const sent = [],
    f = await application(t, mode, {
      hostVerificationSender: async (m) => sent.push(m),
      householdHosts: new Set(["alpha.ilymmd.com", "beta.ilymmd.com"]),
      ...options,
    }),
    a = await f.host("Alpha"),
    b = await f.host("Beta");
  for (const h of [a, b]) {
    isolateAddressBook(
      f.store,
      h.household.id,
      addressBookCheckpoint(f.store, h.household.id).fingerprint,
      "synthetic-admin",
    );
    ensureHostRoster(f.store, h.household.id);
  }
  return { ...f, a, b, sent };
}
test("private wedding/member pages require independent grants, follow current roles and revoke immediately", async (t) => {
  const f = await fixture(t),
    adult = await f.guest(f.a),
    child = await f.guest(f.a, { first: "Riley", parent: adult.id }),
    other = await f.guest(f.a, { first: "Jordan" }),
    event = await f.event(f.a, [adult, child, other]),
    base = `/api/host/events/${event.id}`,
    reference = publicEventReference(f.store, f.a.household.id, event.id),
    publicBase = `/api/public/events/${reference}`;
  const create = async (title, audience, extra = {}) =>
    await f.request(base + "/pages", {
      method: "POST",
      cookie: f.a.cookie,
      data: {
        title,
        audience,
        content: [{ text: title + " secret content" }],
        ...extra,
      },
    });
  const ordinary = await create("Public details", "public"),
    individual = await create("Private Riley instructions", "members", {
      members: [child.id],
    }),
    role = await create("Private attendant timeline", "roles", {
      roles: ["Attendant"],
    });
  assert.equal(individual.status, 200);
  assert.equal(role.status, 200);
  const initial = await f.request(publicBase);
  assert.deepEqual(
    initial.body.events[0].extraPages.map((p) => p.id),
    [ordinary.body.page.id],
  );
  assert.equal(
    JSON.stringify(initial.body).includes(individual.body.page.title),
    false,
  );
  const access = await f.request(publicBase + "/access", {
    method: "POST",
    data: { householdID: adult.inviteCode },
  });
  assert.equal(access.status, 200);
  assert.equal(
    (
      await f.request(publicBase + "/pages/" + individual.body.page.id, {
        method: "POST",
        data: { grant: access.body.grant },
      })
    ).status,
    404,
  );
  const grant = (
    await f.request(base + "/page-grants", {
      method: "POST",
      cookie: f.a.cookie,
      data: { guest: child.id },
    })
  ).body.url.split("#private=")[1];
  let pages = await f.request(publicBase + "/pages", {
    method: "POST",
    data: { grant },
  });
  assert.deepEqual(
    pages.body.pages.map((p) => p.id),
    [ordinary.body.page.id, individual.body.page.id],
  );
  const assignment = await f.request(base + "/page-roles", {
    method: "POST",
    cookie: f.a.cookie,
    data: { guest: child.id, version: 0, roles: ["Attendant"] },
  });
  assert.equal(assignment.status, 200);
  assert.equal(
    (
      await f.request(publicBase + "/pages/" + role.body.page.id, {
        method: "POST",
        data: { grant },
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.request(base + "/pages", { cookie: f.b.cookie })).status,
    404,
  );
  const foreign = (
    await f.request(base + "/page-grants", {
      method: "POST",
      cookie: f.a.cookie,
      data: { guest: other.id },
    })
  ).body.url.split("#private=")[1];
  assert.equal(
    (
      await f.request(publicBase + "/pages/" + individual.body.page.id, {
        method: "POST",
        data: { grant: foreign },
      })
    ).status,
    404,
  );
  await f.request(base + "/page-roles", {
    method: "POST",
    cookie: f.a.cookie,
    data: { guest: child.id, version: assignment.body.version, roles: [] },
  });
  assert.equal(
    (
      await f.request(publicBase + "/pages/" + role.body.page.id, {
        method: "POST",
        data: { grant },
      })
    ).status,
    404,
  );
  const metadata = (
    await f.request(base + "/pages", { cookie: f.a.cookie })
  ).body.grants.find((g) => g.guest === child.id);
  assert.equal(
    (
      await f.request(base + "/page-grants", {
        method: "POST",
        cookie: f.a.cookie,
        data: { revoke: metadata.id, version: metadata.version, confirm: true },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request(publicBase + "/pages", {
        method: "POST",
        data: { grant },
      })
    ).status,
    404,
  );
  const updated = await f.request(base + "/pages/" + ordinary.body.page.id, {
    method: "PUT",
    cookie: f.a.cookie,
    version: ordinary.body.page.version,
    data: { title: "Updated public details", content: [{ text: "Updated" }] },
  });
  assert.equal(updated.status, 200);
  assert.equal(
    (
      await f.request(base + "/pages/" + ordinary.body.page.id, {
        method: "PUT",
        cookie: f.a.cookie,
        version: ordinary.body.page.version,
        data: { title: "Stale" },
      })
    ).status,
    409,
  );
  assert.equal(f.store.list("event-page-history", f.a.household.id).length, 1);
  assert.equal(
    JSON.stringify(
      f.store.list("private-page-grant", f.a.household.id),
    ).includes(grant),
    false,
  );
});
test("recipient ID rotation revokes prior access and children batch changes are tenant-scoped and atomic", async (t) => {
  const f = await fixture(t),
    adult = await f.guest(f.a, {
      addressDraft: { label: "Synthetic family", lines: "PO Box 12" },
    }),
    other = await f.guest(f.b),
    event = await f.event(f.a, [adult]),
    reference = publicEventReference(f.store, f.a.household.id, event.id),
    base = `/api/public/events/${reference}`;
  const access = await f.request(base + "/access", {
    method: "POST",
    data: { householdID: adult.inviteCode },
  });
  const inspect = await f.request("/api/host/recipient-access", {
    method: "POST",
    cookie: f.a.cookie,
    data: { guest: adult.id },
  });
  const rotated = await f.request("/api/host/recipient-access", {
    method: "POST",
    cookie: f.a.cookie,
    data: {
      guest: adult.id,
      version: inspect.body.version,
      operation: "rotate",
      confirm: true,
    },
  });
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.body.householdID, adult.inviteCode);
  assert.equal(
    (
      await f.request(base + "/access", {
        method: "POST",
        data: { householdID: adult.inviteCode },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await f.request(base + "/rsvp", {
        method: "PUT",
        data: {
          grant: access.body.grant,
          version: 0,
          attendance: { [adult.id]: "yes" },
          claims: {},
        },
      })
    ).status,
    404,
  );
  const saved = await f.request("/api/host/contact-children", {
    method: "POST",
    cookie: f.a.cookie,
    data: {
      address: adult.address,
      children: [{ first: "Riley", suffix: "Jr" }, { first: "Sam" }],
    },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.children.length, 2);
  assert.ok(
    saved.body.children.every(
      (p) => p.last === "" && p.phone === "" && p.parent === adult.id,
    ),
  );
  const child = saved.body.children[0];
  const failed = await f.request("/api/host/contact-children", {
    method: "POST",
    cookie: f.a.cookie,
    data: {
      address: adult.address,
      children: [
        { id: child.id, version: child.version, first: "Changed" },
        { id: other.id, version: other.version, first: "Foreign" },
      ],
    },
  });
  assert.equal(failed.status, 404);
  assert.equal(f.store.get("guest", child.id, f.a.household.id).first, "Riley");
});
test("new host membership needs explicit adult invitation and verified email, never child/name matching", async (t) => {
  const f = await fixture(t),
    roster = ensureHostRoster(f.store, f.a.household.id),
    owner = roster.members[0];
  const profile = await f.request("/api/personal/family", {
    method: "PUT",
    cookie: f.a.cookie,
    version: roster.version,
    data: {
      ...roster,
      members: [
        ...roster.members,
        { first: "Approved adult", last: "", parent: "" },
        { first: "Child", parent: owner.id },
      ],
    },
  });
  assert.equal(profile.status, 200);
  const adult = profile.body.profile.members.find(
      (m) => m.first === "Approved adult",
    ),
    child = profile.body.profile.members.find((m) => m.first === "Child");
  assert.equal(
    (
      await f.request("/api/admin/host-signup-invitations", {
        method: "POST",
        cookie: f.admin,
        data: {
          password,
          email: "child@example.test",
          household: f.a.household.id,
          approvedAdult: true,
          memberName: "Child",
          rosterMember: child.id,
        },
      })
    ).status,
    400,
  );
  const issued = await f.request("/api/admin/host-signup-invitations", {
    method: "POST",
    cookie: f.admin,
    data: {
      password,
      email: "adult@example.test",
      household: f.a.household.id,
      approvedAdult: true,
      memberName: "Approved adult",
      rosterMember: adult.id,
    },
  });
  assert.equal(issued.status, 201);
  const invite = new URL(issued.body.url).hash.slice(8),
    start = await f.request("/api/host-signup/email", {
      method: "POST",
      data: {
        invite,
        email: "adult@example.test",
        password,
        name: "Ignored household rename",
      },
    });
  assert.equal(start.status, 200);
  assert.equal(
    f.store.one("SELECT id FROM users WHERE email=?", "adult@example.test"),
    undefined,
  );
  const verification = new URL(f.sent.at(-1).url).hash.slice(8),
    finish = await f.request("/api/host-signup/complete", {
      method: "POST",
      cookie: start.cookie,
      data: { verification },
    });
  assert.equal(finish.status, 201);
  const account = f.store.one(
    "SELECT * FROM users WHERE email=?",
    "adult@example.test",
  );
  assert.equal(account.household, f.a.household.id);
  assert.equal(f.store.household(account.household).name, "Alpha");
  assert.equal(
    (await f.request("/api/host", { cookie: finish.cookie })).status,
    200,
  );
  assert.equal(
    (await f.request("/api/admin", { cookie: finish.cookie })).status,
    403,
  );
  assert.equal(
    ensureHostRoster(f.store, f.a.household.id).members.filter(
      (m) => m.id === adult.id,
    ).length,
    1,
  );
});
test("host recovery is email-and-browser verified, single use and immediately revokes existing devices", async (t) => {
  const f = await fixture(t),
    start = await f.request("/api/host-auth/recovery/start", {
      method: "POST",
      data: { email: "alpha@example.test" },
    });
  assert.equal(start.status, 200);
  const token = new URL(f.sent.at(-1).url).hash.slice(7),
    nextPassword = "New-synthetic-recovered-passphrase";
  assert.equal(
    (
      await f.request("/api/host-auth/recovery/complete", {
        method: "POST",
        data: { token, password: nextPassword },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/host-auth/recovery/complete", {
        method: "POST",
        cookie: start.cookie,
        data: { token, password: nextPassword },
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.request("/api/host", { cookie: f.a.cookie })).status,
    401,
  );
  assert.equal(
    (
      await f.request("/api/host-auth/recovery/complete", {
        method: "POST",
        cookie: start.cookie,
        data: { token, password: nextPassword },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/host-auth/login", {
        method: "POST",
        data: { email: "alpha@example.test", password: nextPassword },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request("/api/host-auth/recovery/start", {
        method: "POST",
        data: { email: "unknown@example.test" },
      })
    ).body.message,
    start.body.message,
  );
});

test("native host handoff is browser/origin bound, own-household only, persistent and revocable", async (t) => {
  const { createApp } = await import("../server/app.js"),
    { once } = await import("node:events");
  const source = "https://gather.ilymmd.com",
    f = await fixture(t, { origin: source });
  const servers = [];
  async function target(label) {
    const origin = `https://${label}.ilymmd.com`,
      server = createApp({
        store: f.store,
        origin,
        env: mode,
        householdHostname: `${label}.ilymmd.com`,
        householdHosts: new Set(["alpha.ilymmd.com", "beta.ilymmd.com"]),
      });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    return async (path, data, cookie) => {
      const response = await fetch(
        `http://127.0.0.1:${server.address().port}${path}`,
        {
          method: data ? "POST" : "GET",
          headers: {
            Origin: origin,
            ...(data ? { "Content-Type": "application/json" } : {}),
            ...(cookie ? { Cookie: cookie } : {}),
          },
          body: data ? JSON.stringify(data) : undefined,
        },
      );
      return {
        status: response.status,
        body: await response.json(),
        cookie: response.headers.get("set-cookie")?.split(";")[0],
      };
    };
  }
  try {
    const alpha = await target("alpha"),
      beta = await target("beta");
    assert.equal(
      (
        await alpha("/api/host-auth/handoff/prepare", {
          source: "https://evil.example",
        })
      ).status,
      400,
    );
    const prepared = await alpha("/api/host-auth/handoff/prepare", {
        source,
        next: "account",
      }),
      request = new URL(prepared.body.url).hash.slice(
        "#host-transfer-request=".length,
      );
    const authorized = await f.request("/api/host-auth/handoff/authorize", {
      method: "POST",
      cookie: f.a.cookie,
      data: { request },
    });
    assert.equal(authorized.status, 200);
    const values = new URLSearchParams(
        new URL(authorized.body.url).hash.slice(1),
      ),
      [reference, token] = values.get("host-transfer").split(".");
    assert.equal(
      (
        await alpha("/api/host-auth/handoff/redeem", {
          request: reference,
          token,
        })
      ).status,
      401,
    );
    const redeemed = await alpha(
      "/api/host-auth/handoff/redeem",
      { request: reference, token },
      prepared.cookie,
    );
    assert.equal(redeemed.status, 200);
    assert.equal(redeemed.body.next, "account");
    assert.equal(
      (await alpha("/api/session", null, redeemed.cookie)).body.role,
      "host",
    );
    assert.equal(
      (
        await alpha(
          "/api/host-auth/handoff/redeem",
          { request: reference, token },
          prepared.cookie,
        )
      ).status,
      401,
    );
    const foreign = await beta("/api/host-auth/handoff/prepare", { source }),
      foreignRequest = new URL(foreign.body.url).hash.slice(
        "#host-transfer-request=".length,
      );
    assert.equal(
      (
        await f.request("/api/host-auth/handoff/authorize", {
          method: "POST",
          cookie: f.a.cookie,
          data: { request: foreignRequest },
        })
      ).status,
      403,
    );
    await f.request("/api/logout", {
      method: "POST",
      cookie: f.a.cookie,
      data: {},
    });
    assert.equal(
      (await alpha("/api/session", null, redeemed.cookie)).body.role,
      null,
    );
  } finally {
    await Promise.all(
      servers.map((server) => new Promise((resolve) => server.close(resolve))),
    );
  }
});

test("wedding import rejects incomplete sources, is owner-reviewed/idempotent, preserves RSVPs and strips source accounts", async (t) => {
  const f = await fixture(t),
    guest = await f.guest(f.a),
    event = await f.event(f.a, [guest]);
  const payload = { password, household: f.a.household.id, event: event.id };
  assert.equal(
    (
      await f.request("/api/admin/wedding-import", {
        method: "POST",
        cookie: f.admin,
        data: { ...payload, source: { events: { wedding: {} } } },
      })
    ).status,
    400,
  );
  const source = {
    schema: 1,
    repository: "kasstmaster/themeyersgatherings",
    sourceCommit: "a".repeat(40),
    authoritative: true,
    event: {
      title: "Synthetic wedding export",
      date: "2027-04-17",
      time: "Two O'Clock",
    },
    pages: [
      {
        sourceID: "details",
        title: "Wedding details",
        content: [{ text: "Synthetic public details" }],
        audience: "public",
      },
    ],
    members: [
      {
        sourceID: "attendant",
        name: "Synthetic attendant",
        roles: ["Attendant"],
        responsibilities: [{ text: "Synthetic private responsibility" }],
        pages: [
          {
            sourceID: "own-page",
            title: "Individual page",
            content: [{ text: "Synthetic private content" }],
          },
        ],
        privateURL: "DO-NOT-IMPORT",
        phone: "DO-NOT-IMPORT",
      },
    ],
    accounts: [{ token: "DO-NOT-IMPORT" }],
    rsvps: [{ answer: "DO-NOT-IMPORT" }],
  };
  const memberMapping = { attendant: guest.id };
  const preview = await f.request("/api/admin/wedding-import", {
    method: "POST",
    cookie: f.admin,
    data: { ...payload, source, memberMapping },
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.pages.length, 3);
  const data = {
    ...payload,
    source,
    memberMapping,
    operation: "apply",
    reviewFingerprint: preview.body.reviewFingerprint,
    confirm: "IMPORT REVIEWED WEDDING CONTENT",
    confirmAuthoritativeSource: true,
  };
  assert.equal(
    (
      await f.request("/api/admin/wedding-import", {
        method: "POST",
        cookie: f.a.cookie,
        data,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/admin/wedding-import", {
        method: "POST",
        cookie: f.admin,
        data,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request("/api/admin/wedding-import", {
        method: "POST",
        cookie: f.admin,
        data,
      })
    ).body.alreadyApplied,
    true,
  );
  assert.equal(f.store.list("guest", f.a.household.id).length, 1);
  assert.equal(f.store.list("response", f.a.household.id).length, 0);
  assert.deepEqual(
    f.store.get("event", event.id, f.a.household.id).invited,
    event.invited,
  );
  assert.equal(
    f.store.get("event", event.id, f.a.household.id).time,
    "Two O'Clock",
  );
  assert.equal(f.store.list("event-page", f.a.household.id).length, 3);
  assert.equal(
    JSON.stringify(
      f.store.list("wedding-import-source", f.a.household.id),
    ).includes("DO-NOT-IMPORT"),
    false,
  );
  const page = f.store.list("event-page", f.a.household.id)[0];
  f.store.put(
    "event-page",
    page.id,
    f.a.household.id,
    { ...page, title: "Local edited page" },
    page.version,
  );
  assert.equal(
    (
      await f.request("/api/admin/wedding-import", {
        method: "POST",
        cookie: f.admin,
        data: {
          ...payload,
          source: { ...source, sourceCommit: "b".repeat(40) },
          memberMapping,
        },
      })
    ).status,
    409,
  );
});
test("large household cards include every invited name and +1 without clipping and keep one ordinary invitation", async (t) => {
  const f = await fixture(t),
    adult = await f.guest(f.a, {
      addressDraft: { label: "Synthetic large household", lines: "PO Box 12" },
    }),
    guests = [adult];
  for (let index = 0; index < 39; index++)
    guests.push(
      await f.guest(f.a, {
        first: "Synthetic child " + index,
        parent: adult.id,
        address: adult.address,
        suffix: "Jr",
      }),
    );
  guests.push(
    await f.guest(f.a, {
      first: "",
      last: "",
      plusOne: true,
      address: adult.address,
    }),
  );
  const event = await f.event(f.a, guests),
    { newCard } = await import("../public/card-system.js"),
    cardDraft = newCard("Synthetic invitation");
  const result = await f.request(`/api/host/events/${event.id}/rsvp-cards`, {
    method: "POST",
    cookie: f.a.cookie,
    version: event.version,
    data: { guestIds: [adult.id], cardDraft },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.cards.length, 3);
  assert.equal(result.body.cards.filter((c) => c.invitation).length, 1);
  assert.equal(result.body.cards.flatMap((c) => c.invitedNames).length, 41);
  assert.ok(
    result.body.cards
      .flatMap((c) => c.invitedNames)
      .some((name) => name.includes("+1")),
  );
  assert.ok(
    result.body.cards.every(
      (c) =>
        c.height >= 420 &&
        c.householdID === adult.inviteCode &&
        c.url.includes("/event/"),
    ),
  );
});
test("native administrator elevation expires independently of remembered host sessions", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.request(`/api/admin/platform-access/${f.a.user}`, {
        method: "POST",
        cookie: f.admin,
        data: { password, confirmEmail: "alpha@example.test" },
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.request("/api/admin", { cookie: f.a.cookie })).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/host-auth/admin/step-up", {
        method: "POST",
        cookie: f.a.cookie,
        data: { password: "wrong" },
      })
    ).status,
    403,
  );
  const elevated = await f.request("/api/host-auth/admin/step-up", {
    method: "POST",
    cookie: f.a.cookie,
    data: { password },
  });
  assert.equal(elevated.status, 200);
  assert.equal(
    (await f.request("/api/admin", { cookie: elevated.cookie })).status,
    200,
  );
  const { createHash } = await import("node:crypto"),
    key = createHash("sha256")
      .update(elevated.cookie.split("=")[1])
      .digest("hex"),
    proof = f.store.get("passwordless-session", key, "platform");
  f.store.put(
    "passwordless-session",
    key,
    "platform",
    { ...proof, adminUntil: Date.now() - 1 },
    proof.version,
  );
  assert.equal(
    (await f.request("/api/admin", { cookie: elevated.cookie })).status,
    403,
  );
  assert.equal(
    (await f.request("/api/host", { cookie: elevated.cookie })).status,
    200,
  );
});

test("host directory, recovery and revocation remain restricted to password-confirmed system administration", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.request("/api/admin/host-management", {
        method: "POST",
        cookie: f.a.cookie,
        data: { password },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/admin/host-management", {
        method: "POST",
        cookie: f.admin,
        data: { password: "incorrect" },
      })
    ).status,
    403,
  );
  const directory = await f.request("/api/admin/host-management", {
    method: "POST",
    cookie: f.admin,
    data: { password },
  });
  assert.equal(directory.status, 200);
  const selected = directory.body.hosts.find(
    (h) => h.user === f.a.user || h.id === f.a.user,
  );
  assert.ok(selected);
  assert.equal(JSON.stringify(directory.body).includes("password"), false);
  const recovered = await f.request("/api/admin/host-management", {
    method: "POST",
    cookie: f.admin,
    data: {
      password,
      operation: "recover",
      user: f.a.user,
      confirmEmail: selected.email,
      accountVersion: selected.accountVersion,
      newPassword: password + "-replacement",
      confirmPassword: password + "-replacement",
    },
  });
  assert.equal(recovered.status, 200);
  assert.equal(
    (await f.request("/api/host", { cookie: f.a.cookie })).status,
    401,
  );
  assert.equal(
    (await f.request("/api/host", { cookie: f.b.cookie })).status,
    200,
  );
});

test("account mail has fixed transport, bounded ownership-only links and no event notification path", async () => {
  const { hostMailSender } = await import("../server/host-mail.js");
  assert.equal(hostMailSender({}, "https://gather.ilymmd.com"), undefined);
  const sent = [],
    send = hostMailSender(
      {
        ...mode,
        HOST_EMAIL_ENABLED: "true",
        HOST_EMAIL_API_KEY: "synthetic-not-a-provider-key",
        HOST_EMAIL_FROM: "accounts@example.test",
      },
      "https://gather.ilymmd.com",
      async (url, options) => {
        sent.push({ url, options });
        return new Response("{}", { status: 200 });
      },
    );
  await send({
    email: "synthetic@example.test",
    url: "https://gather.ilymmd.com/host-signup#verify=synthetic",
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "https://api.resend.com/emails");
  assert.equal(sent[0].options.redirect, "error");
  await assert.rejects(
    send({
      email: "synthetic@example.test",
      url: "https://untrusted.test/host-signup#verify=synthetic",
    }),
  );
  await assert.rejects(
    send({
      email: "synthetic@example.test",
      url: "https://gather.ilymmd.com/event/example",
      purpose: "invitation",
    }),
  );
  assert.equal(sent.length, 1);
});

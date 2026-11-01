import test from "node:test";
import assert from "node:assert/strict";
import { application, password } from "./helpers/application.js";
import { importRecipe, publicRecipeURL } from "../server/recipe-import.js";
import { isPublicAddress } from "../server/node-recipe-transport.js";
import { runFamilyReminders } from "../server/family-tasks.js";

test("family roles never grant platform or cross-household administration", async (t) => {
  const f = await application(t),
    a = await f.host("Alpha"),
    b = await f.host("Beta"),
    admin = await f.member(a, "administrator", "Adult"),
    member = await f.member(a, "member", "Regular"),
    kid = await f.member(a, "kid", "Child");
  assert.equal(
    (await f.request("/api/admin", { cookie: admin.cookie })).status,
    403,
  );
  assert.equal(
    (await f.request("/api/host", { cookie: member.cookie })).status,
    403,
  );
  assert.equal(
    (await f.request("/api/host", { cookie: admin.cookie })).status,
    200,
  );
  assert.equal(
    (
      await f.request("/api/host/interface/household/" + b.household.id, {
        cookie: admin.cookie,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await f.request("/api/family/members", {
        method: "POST",
        cookie: admin.cookie,
        data: { name: "Bad", login: "bad", password, role: "administrator" },
      })
    ).status,
    403,
  );
  const account = (await f.request("/api/session", { cookie: kid.cookie }))
    .body;
  assert.equal(account.role, "family");
  const list = await f.record(a, "list");
  assert.equal(
    (await f.request("/api/family/records/" + list.id, { cookie: b.cookie }))
      .status,
    404,
  );
});
test("specific child access applies to folders, records, files, search and polling; revocation takes effect immediately", async (t) => {
  const f = await application(t),
    a = await f.host("Alpha"),
    kid = await f.member(a, "kid", "Child"),
    other = await f.member(a, "kid", "Sibling"),
    folder = await f.record(a, "folder", { childAccess: [kid.id] }),
    privateList = await f.record(a, "list", { folder: folder.id }),
    list = await f.record(a, "list", {
      folder: folder.id,
      childAccess: [kid.id],
    }),
    record = await f.record(a, "record", {
      childAccess: [kid.id],
      notes: "Private household document",
    });
  assert.equal(
    (
      await f.request("/api/family/records/" + privateList.id, {
        cookie: kid.cookie,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await f.request("/api/family/records/" + list.id, {
        cookie: other.cookie,
      })
    ).status,
    404,
  );
  const file = await f.request("/api/family/files", {
    method: "POST",
    cookie: a.cookie,
    data: {
      record: record.id,
      name: "manual.txt",
      mime: "text/plain",
      base64: Buffer.from("private manual").toString("base64"),
    },
  });
  assert.equal(file.status, 201);
  assert.equal(
    (
      await f.request("/api/family/files/" + file.body.id, {
        cookie: kid.cookie,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request("/api/family/files/" + file.body.id, {
        cookie: other.cookie,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await f.request("/api/family/records/" + record.id, {
        method: "PUT",
        cookie: a.cookie,
        version: record.version,
        data: { ...record, childAccess: [] },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request("/api/family/files/" + file.body.id, {
        cookie: kid.cookie,
      })
    ).status,
    404,
  );
  assert.equal(
    (await f.request("/api/family", { cookie: kid.cookie })).body.records.some(
      (r) => r.id === record.id,
    ),
    false,
  );
});
test("independent list item versions preserve competing additions, reject stale edits and restrict child actions", async (t) => {
  const f = await application(t),
    a = await f.host("Alpha"),
    kid = await f.member(a, "kid", "Child"),
    list = await f.record(a, "list", {
      categories: ["Produce", "Other"],
      childAccess: [kid.id],
    });
  const create = (title) =>
    f.request("/api/family/items", {
      method: "POST",
      cookie: kid.cookie,
      data: { list: list.id, title, category: "Produce" },
    });
  const [first, second] = await Promise.all([
    create("Apples"),
    create("Bananas"),
  ]);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const update = await f.request("/api/family/items/" + first.body.id, {
    method: "PUT",
    cookie: kid.cookie,
    version: 1,
    data: { completed: true },
  });
  assert.equal(update.status, 200);
  assert.equal(
    (
      await f.request("/api/family/items/" + first.body.id, {
        method: "PUT",
        cookie: kid.cookie,
        version: 1,
        data: { completed: false },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.request("/api/family/items/" + first.body.id, {
        method: "DELETE",
        cookie: kid.cookie,
        version: 2,
        data: {},
      })
    ).status,
    403,
  );
  const view = (await f.request("/api/family", { cookie: a.cookie })).body;
  assert.equal(view.items.length, 2);
  assert.equal(view.items.find((i) => i.id === first.body.id).completed, true);
  assert.equal(
    (
      await f.request("/api/family/preferences", {
        method: "PUT",
        cookie: kid.cookie,
        data: { hideCompleted: true, alphabetical: true },
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.request("/api/family", { cookie: kid.cookie })).body.preferences
      .hideCompleted,
    true,
  );
});
test("recipe import uses supported structured data, does not invent missing fields, and rejects unsafe targets and redirects", async () => {
  for (const url of [
    "http://example.com/",
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://example.local/",
    "https://user:pass@example.com/",
  ])
    assert.throws(() => publicRecipeURL(url));
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "192.168.1.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
  ])
    assert.equal(isPublicAddress(ip), false);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  const result = await importRecipe(
    "https://recipes.example.com/test",
    async () =>
      new Response(
        '<script type="application/ld+json">' +
          JSON.stringify({
            "@type": "Recipe",
            name: "Soup",
            recipeIngredient: ["Water", "Salt"],
            recipeInstructions: [{ "@type": "HowToStep", text: "Combine." }],
          }) +
          "</script>",
        { headers: { "content-type": "text/html" } },
      ),
  );
  assert.equal(result.title, "Soup");
  assert.equal(result.ingredients, "Water\nSalt");
  assert.equal(result.instructions, "Combine.");
  await assert.rejects(
    importRecipe(
      "https://recipes.example.com/",
      async () =>
        new Response("", {
          status: 302,
          headers: { location: "https://127.0.0.1/" },
        }),
    ),
  );
  await assert.rejects(
    importRecipe(
      "https://recipes.example.com/",
      async () =>
        new Response("<p>No data</p>", {
          headers: { "content-type": "text/html" },
        }),
    ),
    /manual entry/,
  );
});
test("task assignments, recurring occurrences and in-app reminders retain history and stop after completion or revocation", async (t) => {
  const f = await application(t),
    a = await f.host("Alpha"),
    kid = await f.member(a, "kid", "Child"),
    other = await f.member(a, "member", "Adult"),
    privateRecord = await f.record(a, "record", { notes: "Private warranty" }),
    chore = await f.record(a, "chore", {
      assignees: [kid.id],
      linkedRecord: privateRecord.id,
      dueLocal: "2026-10-31T10:00",
      timezone: "America/Los_Angeles",
      repeat: "daily",
      interval: 1,
      completionMode: "each",
      reminderMinutes: 0,
    });
  runFamilyReminders(f.store, Date.parse("2026-11-01T20:00:00Z"));
  const view = (await f.request("/api/family", { cookie: kid.cookie })).body;
  assert.equal(view.records.find((r) => r.id === chore.id).linkedRecord, "");
  assert.equal(
    view.records.some((r) => r.id === privateRecord.id),
    false,
  );
  assert.ok(view.occurrences.length >= 2);
  const before = f.store.list("family-notification", a.household.id).length;
  runFamilyReminders(f.store, Date.parse("2026-11-01T20:00:00Z"));
  assert.equal(
    f.store.list("family-notification", a.household.id).length,
    before,
  );
  const occurrence = view.occurrences[0];
  assert.equal(
    (
      await f.request(
        "/api/family/occurrences/" + encodeURIComponent(occurrence.id),
        {
          method: "PUT",
          cookie: kid.cookie,
          version: occurrence.version,
          data: { completed: true },
        },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request("/api/family", { cookie: kid.cookie })
    ).body.notifications.some((n) => n.occurrence === occurrence.id),
    false,
  );
  const latest = f.store.get("family-record", chore.id, a.household.id);
  assert.equal(
    (
      await f.request("/api/family/records/" + chore.id, {
        method: "PUT",
        cookie: a.cookie,
        version: latest.version,
        data: { ...latest, assignees: [other.id] },
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.request("/api/family", { cookie: kid.cookie })).body.records.some(
      (r) => r.id === chore.id,
    ),
    false,
  );
});
test("disabling members and password recovery revoke sessions while protecting ownership", async (t) => {
  const f = await application(t),
    a = await f.host("Alpha"),
    m = await f.member(a, "member", "Adult");
  assert.equal(
    (
      await f.request("/api/family/members/" + m.id, {
        method: "PUT",
        cookie: a.cookie,
        version: m.version,
        data: {
          name: m.name,
          role: "member",
          password: "Replacement-test-passphrase",
          disabled: true,
        },
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.request("/api/family", { cookie: m.cookie })).status,
    403,
  );
  const owner = (
    await f.request("/api/family", { cookie: a.cookie })
  ).body.members.find((m) => m.role === "owner");
  assert.equal(
    (
      await f.request("/api/family/members/" + owner.id, {
        method: "DELETE",
        cookie: a.cookie,
        version: owner.version,
        data: {},
      })
    ).status,
    403,
  );
});

test("ordinary member and kid sessions exclude host-private notes; task contribution never grants account controls", async (t) => {
  const f = await application(t),
    a = await f.host("Alpha"),
    adult = await f.member(a, "member", "Adult"),
    kid = await f.member(a, "kid", "Child");
  const current = f.store.household(a.household.id);
  f.store.put(
    "household",
    current.id,
    current.id,
    { ...current, notes: "Host-only household notes" },
    current.version,
  );
  for (const cookie of [adult.cookie, kid.cookie])
    assert.equal(
      JSON.stringify(
        (await f.request("/api/session", { cookie })).body,
      ).includes("Host-only household notes"),
      false,
    );
  const task = await f.record(adult, "chore", {
    assignees: [adult.id],
    completionMode: "each",
  });
  assert.equal(task.type, "chore");
  assert.equal(
    (
      await f.request("/api/family/records", {
        method: "POST",
        cookie: adult.cookie,
        data: {
          type: "chore",
          title: "Unapproved child task",
          assignees: [kid.id],
        },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/family/preferences", {
        method: "PUT",
        cookie: kid.cookie,
        data: { notifications: false },
      })
    ).status,
    403,
  );
});

test("ownership transfer preserves individual sign-ins and the new owner can remove the former owner", async (t) => {
  const f = await application(t),
    a = await f.host("Alpha"),
    next = await f.member(a, "administrator", "Successor");
  await f.request("/api/family", { cookie: a.cookie });
  assert.equal(
    (
      await f.request("/api/family/transfer-owner", {
        method: "POST",
        cookie: a.cookie,
        data: { member: next.id, password },
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.request("/api/host", { cookie: a.cookie })).status,
    401,
  );
  const old = (
    await f.request("/api/login", {
      method: "POST",
      data: { email: "alpha@example.test", password },
    })
  ).cookie;
  assert.equal(
    (await f.request("/api/session", { cookie: old })).body.role,
    "family",
  );
  assert.equal((await f.request("/api/host", { cookie: old })).status, 403);
  const login = await f.request(
    "/api/public/households/" + a.household.slug + "/members/login",
    { method: "POST", data: { login: "successor", password } },
  );
  assert.equal(login.status, 200);
  const view = (await f.request("/api/family", { cookie: login.cookie })).body,
    former = view.members.find((m) => m.login === "alpha@example.test");
  assert.equal(view.member.role, "owner");
  assert.equal(
    (
      await f.request("/api/family/members/" + former.id, {
        method: "DELETE",
        cookie: login.cookie,
        version: former.version,
        data: {},
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request("/api/login", {
        method: "POST",
        data: { email: "alpha@example.test", password },
      })
    ).status,
    401,
  );
});

test("recurrence preserves month-end anchors, skips ambiguous DST times and keeps shared completion occurrence-specific", async (t) => {
  const f = await application(t),
    a = await f.host("Alpha"),
    one = await f.member(a, "kid", "ChildOne"),
    two = await f.member(a, "kid", "ChildTwo");
  const monthly = await f.record(a, "chore", {
    assignees: [one.id],
    dueLocal: "2026-01-31T10:00",
    timezone: "UTC",
    repeat: "monthly",
    interval: 1,
    completionMode: "each",
  });
  const dst = await f.record(a, "chore", {
    assignees: [one.id, two.id],
    dueLocal: "2026-10-31T01:30",
    timezone: "America/Los_Angeles",
    repeat: "daily",
    interval: 1,
    completionMode: "shared",
  });
  runFamilyReminders(f.store, Date.parse("2026-11-03T20:00:00Z"));
  const months = f.store
    .list("family-occurrence", a.household.id)
    .filter((o) => o.chore === monthly.id)
    .map((o) => o.due.slice(0, 10));
  assert.ok(months.includes("2026-02-28"));
  assert.ok(months.includes("2026-03-31"));
  const occurrences = f.store
    .list("family-occurrence", a.household.id)
    .filter((o) => o.chore === dst.id);
  assert.equal(
    occurrences.some((o) => o.due.startsWith("2026-11-01")),
    false,
  );
  const first = occurrences[0];
  assert.equal(
    (
      await f.request(
        "/api/family/occurrences/" + encodeURIComponent(first.id),
        {
          method: "PUT",
          cookie: one.cookie,
          version: first.version,
          data: { completed: true },
        },
      )
    ).status,
    200,
  );
  assert.ok(
    f.store.get("family-occurrence", first.id, a.household.id).completed.shared,
  );
  assert.deepEqual(
    f.store.get("family-occurrence", occurrences[1].id, a.household.id)
      .completed,
    {},
  );
});

test("quiet hours defer in-app reminders, disabling preferences stops new ones and chunked files retain private metadata", async (t) => {
  const f = await application(t),
    a = await f.host("Alpha"),
    kid = await f.member(a, "kid", "Child"),
    record = await f.record(a, "record");
  const file = await f.request("/api/family/files", {
    method: "POST",
    cookie: a.cookie,
    data: {
      record: record.id,
      name: "large.txt",
      mime: "text/plain",
      base64: Buffer.alloc(300000, 65).toString("base64"),
    },
  });
  assert.equal(file.status, 201);
  assert.equal(
    (await f.request("/api/family", { cookie: a.cookie })).body.storage.used,
    300000,
  );
  assert.equal(
    (await f.request("/api/family/records/" + record.id, { cookie: a.cookie }))
      .body.files[0].name,
    "large.txt",
  );
  assert.equal(
    (
      await f.request("/api/family/files/" + file.body.id, {
        cookie: kid.cookie,
      })
    ).status,
    404,
  );
  const prefs = await f.request("/api/family/preferences", {
    method: "PUT",
    cookie: a.cookie,
    data: {
      member: kid.id,
      timezone: "UTC",
      quietStart: 9,
      quietEnd: 11,
      notifications: true,
    },
  });
  assert.equal(prefs.status, 200);
  const chore = await f.record(a, "chore", {
    assignees: [kid.id],
    dueLocal: "2090-01-01T10:00",
    timezone: "UTC",
    repeat: "daily",
    interval: 1,
    completionMode: "each",
    reminderMinutes: 0,
  });
  runFamilyReminders(f.store, Date.parse("2090-01-01T10:00:00Z"));
  assert.equal(f.store.list("family-notification", a.household.id).length, 0);
  runFamilyReminders(f.store, Date.parse("2090-01-01T11:00:00Z"));
  assert.equal(f.store.list("family-notification", a.household.id).length, 1);
  assert.equal(
    (
      await f.request("/api/family/preferences", {
        method: "PUT",
        cookie: a.cookie,
        version: prefs.body.version,
        data: {
          member: kid.id,
          timezone: "UTC",
          quietStart: 9,
          quietEnd: 11,
          notifications: false,
        },
      })
    ).status,
    200,
  );
  runFamilyReminders(f.store, Date.parse("2090-01-02T11:00:00Z"));
  assert.equal(f.store.list("family-notification", a.household.id).length, 1);
});

test("category deletion cannot hide saved items, and parent-folder moves cannot bypass child permissions", async (t) => {
  const f = await application(t),
    a = await f.host("Alpha"),
    adult = await f.member(a, "member", "Regular"),
    kid = await f.member(a, "kid", "Child"),
    folder = await f.record(a, "folder"),
    list = await f.record(a, "list", {
      categories: ["Keep"],
      folder: folder.id,
      childAccess: [kid.id],
    });
  await f.request("/api/family/items", {
    method: "POST",
    cookie: a.cookie,
    data: { list: list.id, title: "Preserved", category: "Keep" },
  });
  assert.equal(
    (
      await f.request("/api/family/records/" + list.id, {
        method: "PUT",
        cookie: a.cookie,
        version: list.version,
        data: { ...list, categories: [] },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.request("/api/family/records/" + list.id, {
        method: "PUT",
        cookie: adult.cookie,
        version: list.version,
        data: { ...list, folder: "" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.request("/api/family/records/" + list.id, { cookie: kid.cookie }))
      .status,
    404,
  );
});

test("platform-assisted owner recovery requires password confirmation and revokes the current owner’s sessions", async (t) => {
  const f = await application(t),
    a = await f.host("Alpha"),
    replacement = "Replacement-owner-passphrase";
  const path = "/api/admin/hosts/" + a.user + "/recover";
  assert.equal(
    (await f.request(path, { method: "POST", cookie: a.cookie, data: {} }))
      .status,
    403,
  );
  assert.equal(
    (
      await f.request(path, {
        method: "POST",
        cookie: f.admin,
        data: {
          confirmEmail: "alpha@example.test",
          adminPassword: "wrong",
          password: replacement,
          confirmPassword: replacement,
        },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(path, {
        method: "POST",
        cookie: f.admin,
        data: {
          confirmEmail: "alpha@example.test",
          adminPassword: password,
          password: replacement,
          confirmPassword: replacement,
        },
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.request("/api/host", { cookie: a.cookie })).status,
    401,
  );
  assert.equal(
    (
      await f.request("/api/login", {
        method: "POST",
        data: { email: "alpha@example.test", password: replacement },
      })
    ).status,
    200,
  );
});

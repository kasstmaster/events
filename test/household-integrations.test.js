import test from "node:test";
import assert from "node:assert/strict";
import { application } from "./helpers/application.js";
import {
  startAnyListSync,
  syncStatus,
} from "../server/household-integrations.js";
import { addressParts } from "../public/address-system.js";
import { convertAddressBook } from "../integrations/anylist/convert.js";

const configuration = () => ({
  MEYER_HOST_EMAIL: "alpha@example.test",
  GITHUB_TOKEN: "synthetic-actions-token",
  ANYLIST_IMPORT_SECRET: "synthetic-import-secret-for-isolated-tests-only",
});
const source = () => [
  {
    id: "category",
    label: "Example home",
    lines: "PO Box 12, Sample City, CA 90210",
    people: [
      { id: "adult", first: "Casey", last: "Example" },
      { id: "kid", first: "Riley", last: "Example", parentId: "adult" },
    ],
  },
];
async function start(f, env, host) {
  return startAnyListSync(
    f.store,
    env,
    host.household.id,
    async (url, init) => {
      assert.equal(
        url,
        "https://api.github.com/repos/kasstmaster/events/actions/workflows/sync-meyer-anylist.yml/dispatches",
      );
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "manual");
      assert.equal(JSON.parse(init.body).ref, "main");
      return new Response(null, { status: 204 });
    },
  );
}
const deliver = (f, env, job, addresses, extra = {}) =>
  f.request("/api/integrations/anylist/import", {
    method: "POST",
    headers: { "X-Events-Import-Secret": env.ANYLIST_IMPORT_SECRET },
    data: { syncId: job.id, addresses, ...extra },
  });

test("structured addresses preserve old mailing text, support prefilling and keep the address credential", async (t) => {
  const f = await application(t),
    host = await f.host("Alpha");
  const guest = await f.guest(host, {
    addressDraft: {
      label: "Home",
      street: "PO Box 12",
      city: "Sample City",
      state: "CA",
      zip: "90210",
    },
  });
  const saved = f.store.get("address", guest.address, host.household.id);
  assert.equal(saved.lines, "PO Box 12\nSample City, CA 90210");
  assert.deepEqual(
    addressParts({ lines: "123 Main St, Sample City, CA 90210-1234" }),
    {
      street: "123 Main St",
      city: "Sample City",
      state: "CA",
      zip: "90210-1234",
    },
  );
  assert.equal(
    addressParts({ lines: "An unfamiliar international mailing format" })
      .street,
    "An unfamiliar international mailing format",
  );
  const updated = await f.request("/api/host/guests/" + guest.id, {
    method: "PUT",
    cookie: host.cookie,
    version: guest.version,
    data: { ...guest, addressDraft: { ...saved, city: "New City" } },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.inviteCode, guest.inviteCode);
  const legacy = await f.request("/api/host/addresses/" + saved.id, {
    method: "PUT",
    cookie: host.cookie,
    version: saved.version + 1,
    data: {
      ...f.store.get("address", saved.id, host.household.id),
      lines: "456 Other Road",
    },
  });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.street, "456 Other Road");
  assert.equal(legacy.body.city, "");
});

test("AnyList is restricted to the configured verified host household, including direct API calls", async (t) => {
  const env = configuration(),
    f = await application(t, env),
    host = await f.host("Alpha"),
    other = await f.host("Beta");
  assert.equal(
    (await f.request("/api/host", { cookie: host.cookie })).body.integrations
      .anylist,
    true,
  );
  assert.deepEqual(
    (await f.request("/api/host", { cookie: other.cookie })).body.integrations,
    {},
  );
  for (const cookie of [
    other.cookie,
    f.admin,
    (await f.member(host, "member", "Avery")).cookie,
  ])
    assert.equal(
      (
        await f.request("/api/host/integrations/anylist", {
          method: "POST",
          cookie,
          data: {},
        })
      ).status,
      403,
    );
  const guest = await f.guest(host),
    login = await f.guestLogin(host, guest);
  assert.equal(
    (
      await f.request("/api/host/integrations/anylist", {
        cookie: login.cookie,
      })
    ).status,
    403,
  );
  const job = await start(f, env, host);
  assert.equal(
    (
      await f.request("/api/integrations/anylist/import", {
        method: "POST",
        cookie: host.cookie,
        data: { syncId: job.id, addresses: source() },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/integrations/anylist/import", {
        method: "POST",
        headers: {
          Origin: "https://wrong.example",
          "X-Events-Import-Secret": env.ANYLIST_IMPORT_SECRET,
        },
        data: { syncId: job.id, addresses: source() },
      })
    ).status,
    403,
  );
  env.MEYER_HOUSEHOLD_ID = other.household.id;
  assert.deepEqual(
    (await f.request("/api/host", { cookie: host.cookie })).body.integrations,
    {},
  );
  assert.equal((await deliver(f, env, job, source())).status, 403);
});

test("AnyList import is idempotent, keeps stable address/person IDs and preserves website data and existing credentials", async (t) => {
  const env = configuration(),
    f = await application(t, env),
    host = await f.host("Alpha"),
    other = await f.host("Beta");
  const original = await f.guest(host, {
    notes: "Website private note",
    phone: "+15551234567",
    addressDraft: { label: "Example home", lines: source()[0].lines },
  });
  const outside = await f.guest(other),
    event = await f.event(host, [original]);
  const response = f.store.put(
    "response",
    "saved-response",
    host.household.id,
    {
      event: event.id,
      guest: original.id,
      attendance: "yes",
      claims: {},
      privateMarker: "retain",
    },
  );
  const job = await start(f, env, host),
    imported = await deliver(f, env, job, source());
  assert.equal(imported.status, 200);
  assert.equal(imported.body.state, "complete");
  assert.equal(imported.body.added, 1);
  assert.deepEqual((await deliver(f, env, job, source())).body, imported.body);
  let data = (await f.request("/api/host", { cookie: host.cookie })).body;
  assert.equal(data.guests.length, 2);
  assert.equal(data.addresses.length, 1);
  const kid = data.guests.find((g) => g.parent);
  assert.equal(kid.parent, original.id);
  assert.equal(kid.inviteCode, original.inviteCode);
  const changed = source();
  changed[0].label = "Updated title";
  changed[0].lines = "45 New St, New City, CA 90001";
  changed[0].people[0].first = "Casey Updated";
  const next = await start(f, env, host);
  assert.equal((await deliver(f, env, next, changed)).body.state, "complete");
  data = (await f.request("/api/host", { cookie: host.cookie })).body;
  const adult = data.guests.find((g) => g.id === original.id);
  assert.equal(adult.first, "Casey Updated");
  assert.equal(adult.notes, original.notes);
  assert.equal(adult.phone, original.phone);
  assert.equal(adult.inviteCode, original.inviteCode);
  assert.equal(adult.address, original.address);
  assert.equal(data.addresses[0].city, "New City");
  assert.deepEqual(f.store.get("event", event.id, host.household.id), event);
  assert.deepEqual(
    f.store.get("response", response.id, host.household.id),
    response,
  );
  assert.equal(
    f.store.get("guest", outside.id, other.household.id).first,
    outside.first,
  );
  const emptyJob = await start(f, env, host);
  await deliver(f, env, emptyJob, []);
  assert.equal(f.store.list("guest", host.household.id).length, 2);
  const movedSource = source();
  movedSource[0].id = "new-category";
  movedSource[0].label = "Another home";
  movedSource[0].lines = "45 Another Road";
  const movedJob = await start(f, env, host);
  const movedResult = await deliver(f, env, movedJob, movedSource);
  assert.equal(movedResult.body.added, 0);
  assert.equal(movedResult.body.skipped, 2);
  assert.equal(
    f.store.list("guest", host.household.id).length,
    2,
    "A source address move must not duplicate people or silently move their credentials",
  );
});

test("contact changes during sync reject the whole import and malformed batches roll back", async (t) => {
  const env = configuration(),
    f = await application(t, env),
    host = await f.host("Alpha");
  const job = await start(f, env, host);
  await assert.rejects(start(f, env, host), /already running/);
  await f.guest(host, { first: "New" });
  assert.equal((await deliver(f, env, job, source())).body.state, "conflict");
  assert.equal(f.store.list("address", host.household.id).length, 0);
  const next = await start(f, env, host),
    bad = source();
  bad[0].people.push({ id: "broken", first: "", last: "Example" });
  assert.equal((await deliver(f, env, next, bad)).status, 400);
  assert.equal(f.store.list("address", host.household.id).length, 0);
  assert.equal(f.store.list("guest", host.household.id).length, 1);
  assert.equal(
    (await deliver(f, env, next, [], { failed: true })).body.state,
    "failed",
  );
  await assert.rejects(
    startAnyListSync(
      f.store,
      env,
      host.household.id,
      async () => new Response("private", { status: 401 }),
    ),
    /GitHub rejected contact sync/,
  );
  assert.equal(syncStatus(f.store, host.household.id).state, "failed");
});

test("distinct source records with identical names or address titles are skipped instead of merged", async (t) => {
  const env = configuration(),
    f = await application(t, env),
    host = await f.host("Alpha"),
    batch = source();
  batch[0].people.push({ ...batch[0].people[0], id: "different-person" });
  batch.push({ ...source()[0], id: "different-address" });
  const job = await start(f, env, host),
    result = await deliver(f, env, job, batch);
  assert.equal(result.body.state, "complete");
  assert.equal(result.body.skipped, 3);
  assert.equal(f.store.list("guest", host.household.id).length, 2);
  assert.equal(f.store.list("address", host.household.id).length, 1);
});

test("AnyList protobuf adapter reads categories and designated children without issuing writes", () => {
  const result = convertAddressBook(
    {
      shoppingListsResponse: {
        newLists: [
          {
            identifier: "book",
            items: [
              {
                identifier: "adult",
                name: "Casey Example Jr.",
                details: "Riley\nJordan Example",
                categoryAssignments: [
                  { categoryId: "c", categoryGroupId: "g" },
                ],
              },
            ],
          },
        ],
        listResponses: [
          {
            listId: "book",
            categoryGroupResponses: [
              {
                categoryGroup: {
                  identifier: "g",
                  categories: [
                    {
                      identifier: "c",
                      name: "Example - 123 Main St, Sample City, CA 90210",
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    },
    "book",
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].people.length, 3);
  assert.equal(result[0].people[0].suffix, "Jr.");
  assert.equal(result[0].people[1].parentId, "adult");
  assert.equal(result[0].people[1].last, "Example");
});

test("Gatherings variable names keep dispatch Events-only and retain legacy token compatibility", async (t) => {
  for (const legacy of [false, true]) {
    const env = configuration();
    if (legacy) {
      env.EVENTS_ACTIONS_TOKEN = env.GITHUB_TOKEN;
      delete env.GITHUB_TOKEN;
    } else {
      env.EVENTS_ACTIONS_TOKEN = "must-not-take-precedence";
      env.GITHUB_TOKEN = "  synthetic-actions-token\n";
    }
    env.GITHUB_WORKFLOW_REPOSITORY = "kasstmaster/events";
    env.GITHUB_WORKFLOW_BRANCH = "main";
    const f = await application(t, { env }),
      host = await f.host("Alpha");
    await startAnyListSync(
      f.store,
      env,
      host.household.id,
      async (url, init) => {
        assert.equal(
          new URL(url).pathname,
          "/repos/kasstmaster/events/actions/workflows/sync-meyer-anylist.yml/dispatches",
        );
        assert.ok(
          init.headers.Authorization === "Bearer synthetic-actions-token",
        );
        return new Response(null, { status: 204 });
      },
    );
  }
});

test("AnyList rejects copied Gatherings destinations and malformed credentials without transport or secret diagnostics", async (t) => {
  for (const override of [
    { GITHUB_WORKFLOW_REPOSITORY: "kasstmaster/themeyersgatherings" },
    { GITHUB_WORKFLOW_BRANCH: "other" },
    { GITHUB_TOKEN: "Bearer private-synthetic-value" },
    { GITHUB_TOKEN: '"private-synthetic-value"' },
  ]) {
    const env = { ...configuration(), ...override },
      f = await application(t, { env }),
      host = await f.host("Alpha");
    await assert.rejects(
      startAnyListSync(f.store, env, host.household.id, async () => {
        assert.fail("Invalid configuration must never dispatch");
      }),
      (error) => {
        assert.equal(error.status, 503);
        assert.ok(!error.message.includes("private-synthetic-value"));
        return true;
      },
    );
    assert.equal(syncStatus(f.store, host.household.id).state, "idle");
  }
});

test("AnyList dispatch failures use fixed actionable messages and never store provider bodies or transport errors", async (t) => {
  for (const status of [302, 401, 403, 404, 422, 429, 500, 0]) {
    const env = configuration(),
      f = await application(t, { env }),
      host = await f.host("Alpha");
    await assert.rejects(
      startAnyListSync(f.store, env, host.household.id, async () => {
        if (!status) throw new Error("private-provider-diagnostic");
        return new Response("private-provider-diagnostic", { status });
      }),
      (error) => {
        assert.equal(error.status, 503);
        assert.ok(!error.message.includes("private-provider-diagnostic"));
        assert.match(
          error.message,
          status === 401
            ? /rejected/
            : status === 403 || status === 404
              ? /Actions read\/write/
              : status === 422
                ? /sync_id/
                : /unavailable/,
        );
        return true;
      },
    );
    const jobs = f.store.list("anylist-job", host.household.id);
    assert.equal(jobs[0].dispatchStatus, status);
    assert.ok(!JSON.stringify(jobs).includes("private-provider-diagnostic"));
  }
});

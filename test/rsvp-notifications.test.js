import test from "node:test";
import assert from "node:assert/strict";
import { application } from "./helpers/application.js";
import { runReminders, processTwilio } from "../server/reminders.js";
const enabled = {
  SMS_ENABLED: "true",
  TWILIO_ACCOUNT_SID: "synthetic",
  TWILIO_AUTH_TOKEN: "synthetic",
  TWILIO_FROM: "+15550000000",
};
async function setup(t, env = enabled) {
  const f = await application(t, env),
    host = await f.host("Alpha"),
    adult = await f.guest(host, {
      phone: "+15551234567",
      addressDraft: { label: "Home", lines: "123 Main St" },
    }),
    other = await f.guest(host, {
      first: "Jordan",
      phone: "+15557654321",
      address: adult.address,
    }),
    child = await f.guest(host, {
      first: "Riley",
      parent: adult.id,
      address: adult.address,
    }),
    event = await f.event(host, [adult, other, child]),
    login = await f.guestLogin(host, adult);
  const rsvp = (data) =>
    f.request(`/api/guest/events/${event.id}/rsvp`, {
      method: "PUT",
      cookie: login.cookie,
      data: {
        version: 0,
        claims: {},
        attendance: { [adult.id]: "yes" },
        ...data,
      },
    });
  return { ...f, host, adult, other, child, event, rsvp };
}
test("RSVP queues one confirmation for the submitting adult without a host checkbox and shares STOP-aware one-shot transport", async (t) => {
  const f = await setup(t);
  const result = await f.rsvp({
    attendance: {
      [f.adult.id]: "yes",
      [f.other.id]: "no",
      [f.child.id]: "yes",
    },
    partyVersions: { [f.other.id]: 0 },
  });
  assert.equal(result.status, 200);
  const queued = f.store.all("SELECT * FROM reminder_deliveries");
  assert.equal(queued.length, 1);
  assert.equal(queued[0].guest, f.adult.id);
  assert.equal(queued[0].status, "queued");
  assert.equal(
    f.store.get("guest", f.adult.id, f.host.household.id).version,
    f.adult.version,
    "RSVP must not stale an open host contact editor",
  );
  let calls = 0;
  const fetcher = async (url, init) => {
    calls++;
    assert.equal(init.body.get("To"), f.adult.phone);
    assert.match(
      init.body.get("Body"),
      /Your RSVP.*saved\.[\s\S]*Reply STOP to opt out\./,
    );
    return Response.json({ sid: "synthetic-confirmation" });
  };
  await Promise.all([
    runReminders(f.store, enabled, { fetcher }),
    runReminders(f.store, enabled, { fetcher }),
  ]);
  assert.equal(calls, 1);
  assert.equal(
    f.store.one("SELECT status FROM reminder_deliveries").status,
    "accepted",
  );
  assert.equal((await f.rsvp({ version: 1 })).status, 200);
  await runReminders(f.store, enabled, { fetcher });
  assert.equal(calls, 1);
});
test("STOP, changed phone and disabled sending prevent confirmation; enabling later does not replay disabled submissions", async (t) => {
  const f = await setup(t, { ...enabled, SMS_ENABLED: "false" });
  let calls = 0;
  const fetcher = async () => {
    calls++;
    throw Error("Must not send.");
  };
  assert.equal((await f.rsvp()).status, 200);
  assert.equal(
    f.store.one("SELECT status FROM reminder_deliveries").status,
    "disabled",
  );
  await runReminders(f.store, enabled, { fetcher });
  assert.equal(calls, 0);
  const stopped = await setup(t);
  processTwilio(
    stopped.store,
    new URLSearchParams({ From: stopped.adult.phone, Body: "STOP" }),
  );
  assert.equal((await stopped.rsvp()).status, 200);
  await runReminders(stopped.store, enabled, { fetcher });
  assert.equal(calls, 0);
  assert.equal(
    stopped.store.one("SELECT status FROM reminder_deliveries").status,
    "cancelled",
  );
  const changed = await setup(t);
  await changed.rsvp();
  changed.store.put(
    "guest",
    changed.adult.id,
    changed.host.household.id,
    { ...changed.adult, phone: "+15551112222" },
    changed.adult.version,
  );
  await runReminders(changed.store, enabled, { fetcher });
  assert.equal(calls, 0);
  assert.equal(
    changed.store.one("SELECT status FROM reminder_deliveries").status,
    "cancelled",
  );
});
test("failed and blank RSVPs never queue texts; uncertain provider outcomes are never retried", async (t) => {
  const f = await setup(t);
  assert.equal((await f.rsvp({ version: 99 })).status, 409);
  assert.equal(f.store.all("SELECT * FROM reminder_deliveries").length, 0);
  assert.equal(
    (await f.rsvp({ attendance: { [f.adult.id]: "" } })).status,
    200,
  );
  assert.equal(f.store.all("SELECT * FROM reminder_deliveries").length, 0);
  assert.equal((await f.rsvp()).status, 200);
  let calls = 0;
  const fetcher = async () => {
    calls++;
    throw Error("Synthetic uncertain result");
  };
  await runReminders(f.store, enabled, { fetcher });
  await runReminders(f.store, enabled, { fetcher });
  assert.equal(calls, 1);
  assert.equal(
    f.store.one("SELECT status FROM reminder_deliveries").status,
    "unknown",
  );
});

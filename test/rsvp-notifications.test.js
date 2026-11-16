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
test("RSVP remains in-app only and never queues or dispatches optional texts", async (t) => {
  const f = await setup(t),
    result = await f.rsvp({
      attendance: { [f.adult.id]: "yes", [f.child.id]: "yes" },
    });
  assert.equal(result.status, 200);
  assert.equal(f.store.all("SELECT * FROM reminder_deliveries").length, 0);
  assert.equal(
    f.store.get("guest", f.adult.id, f.host.household.id).version,
    f.adult.version,
  );
  let calls = 0;
  await runReminders(f.store, enabled, {
    fetcher: async () => {
      calls++;
      throw Error("Unexpected SMS");
    },
  });
  assert.equal(calls, 0);
  assert.equal(
    f.store.get("response", f.event.id + ":" + f.adult.id, f.host.household.id)
      .attendance[f.adult.id],
    "yes",
  );
});

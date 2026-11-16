import test from "node:test";
import assert from "node:assert/strict";
import { application } from "./helpers/application.js";
import { processEviteStatus } from "../server/evites.js";
import { runReminders } from "../server/reminders.js";
test("retired e-vites preserve historical delivery receipts but cannot enqueue, serve media or send", async (t) => {
  const f = await application(t),
    host = await f.host("History"),
    event = await f.event(host, []);
  f.store.put("evite-delivery", "history", host.household.id, {
    providerId: "synthetic",
    status: "accepted",
    event: event.id,
  });
  for (const path of [
    `/api/host/events/${event.id}/evites`,
    `/api/public/evite-media/${"a".repeat(43)}`,
  ])
    assert.equal((await f.request(path, { cookie: host.cookie })).status, 410);
  let calls = 0;
  await runReminders(
    f.store,
    {
      SMS_ENABLED: "true",
      TWILIO_ACCOUNT_SID: "synthetic",
      TWILIO_AUTH_TOKEN: "synthetic",
      TWILIO_FROM: "+15005550006",
    },
    {
      fetcher: async () => {
        calls++;
        throw Error("Unexpected SMS");
      },
    },
  );
  assert.equal(calls, 0);
  processEviteStatus(
    f.store,
    new URLSearchParams({
      MessageSid: "synthetic",
      MessageStatus: "delivered",
    }),
  );
  processEviteStatus(
    f.store,
    new URLSearchParams({ MessageSid: "synthetic", MessageStatus: "sent" }),
  );
  assert.equal(
    f.store.get("evite-delivery", "history", host.household.id).status,
    "delivered",
  );
  assert.deepEqual(f.store.get("event", event.id, host.household.id), event);
});

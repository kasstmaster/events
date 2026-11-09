import test from "node:test";
import assert from "node:assert/strict";
import { application } from "./helpers/application.js";
import { prepareEvites, runEvites, eviteStatus } from "../server/evites.js";
const image =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4QAAAABJRU5ErkJggg==";
const enabled = {
  SMS_ENABLED: "true",
  TWILIO_ACCOUNT_SID: "ACsynthetic",
  TWILIO_AUTH_TOKEN: "synthetic-test-token",
  TWILIO_FROM: "+15550000000",
};
test("e-vites preserve invitations, deduplicate phones and only resend originally missing recipients", async (t) => {
  const f = await application(t),
    host = await f.host("EviteExample"),
    a = await f.guest(host, { phone: "+15550000001" }),
    b = await f.guest(host, { first: "Second", phone: "+15550000001" }),
    missing = await f.guest(host, { first: "Missing" });
  const event = await f.event(host, [a, b, missing]);
  assert.throws(
    () =>
      prepareEvites(
        f.store,
        {},
        host.household.id,
        event,
        { image, version: event.version },
        "https://example.test",
      ),
    { status: 503 },
  );
  assert.equal(f.store.list("evite-delivery", host.household.id).length, 0);
  const first = prepareEvites(
    f.store,
    enabled,
    host.household.id,
    event,
    { image, version: event.version },
    "https://example.test",
  );
  assert.equal(first.missing.length, 1);
  let calls = 0;
  const fetcher = async (url, options) => {
    calls++;
    assert.match(String(options.body), /MediaUrl/);
    return new Response(JSON.stringify({ sid: "SMsynthetic" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  };
  await runEvites(f.store, enabled, { fetcher });
  assert.equal(calls, 1);
  prepareEvites(
    f.store,
    enabled,
    host.household.id,
    event,
    { image, version: event.version },
    "https://example.test",
  );
  await runEvites(f.store, enabled, { fetcher });
  assert.equal(calls, 1);
  const old = f.store.get("guest", missing.id, host.household.id);
  f.store.put(
    "guest",
    old.id,
    host.household.id,
    { ...old, phone: "+15550000002" },
    old.version,
  );
  assert.equal(
    eviteStatus(f.store, host.household.id, event, enabled).resendEligible,
    1,
  );
  prepareEvites(
    f.store,
    enabled,
    host.household.id,
    event,
    { image, version: event.version, mode: "resend-missing" },
    "https://example.test",
  );
  await runEvites(f.store, enabled, { fetcher });
  assert.equal(calls, 2);
  assert.deepEqual(f.store.get("event", event.id, host.household.id), event);
  assert.equal(f.store.list("response", host.household.id).length, 0);
});
test("unknown e-vite sends are never retried and foreign hosts cannot access delivery reports", async (t) => {
  const f = await application(t),
    host = await f.host("Uncertain"),
    other = await f.host("Outside"),
    g = await f.guest(host, { phone: "+15550000003" }),
    event = await f.event(host, [g]);
  prepareEvites(
    f.store,
    enabled,
    host.household.id,
    event,
    { image, version: event.version },
    "https://example.test",
  );
  let calls = 0;
  await runEvites(f.store, enabled, {
    fetcher: async () => {
      calls++;
      throw Error("Synthetic timeout");
    },
  });
  prepareEvites(
    f.store,
    enabled,
    host.household.id,
    event,
    { image, version: event.version, mode: "resend-missing" },
    "https://example.test",
  );
  await runEvites(f.store, enabled, {
    fetcher: async () => {
      calls++;
      throw Error();
    },
  });
  assert.equal(calls, 1);
  assert.equal(
    eviteStatus(f.store, host.household.id, event, enabled).recipients[0]
      .status,
    "unknown",
  );
  assert.equal(
    (
      await f.request(`/api/host/events/${event.id}/evites`, {
        cookie: other.cookie,
      })
    ).status,
    404,
  );
});

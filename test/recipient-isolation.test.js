import test from "node:test";
import assert from "node:assert/strict";
import { application } from "./helpers/application.js";
import {
  addressBookCheckpoint,
  isolateAddressBook,
  isolatedAddressBook,
} from "../server/recipient-isolation.js";
import { guestRelations, matchingGuests } from "../server/guest-identities.js";
import { autoAssociateContact } from "../server/personal-accounts.js";

test("explicit Address Book preparation is additive, version-checked and removes shared invitation authority", async (t) => {
  const f = await application(t),
    a = await f.host("Alpha"),
    b = await f.host("Beta"),
    first = await f.guest(a),
    second = await f.guest(b);
  const shared = f.store.one(
    "SELECT identity FROM guest_identity_links WHERE household=? AND guest=?",
    a.household.id,
    first.id,
  ).identity;
  f.store.run(
    "UPDATE guest_identity_links SET identity=?,linked=1 WHERE household=? AND guest=?",
    shared,
    b.household.id,
    second.id,
  );
  const before = addressBookCheckpoint(f.store, a.household.id);
  assert.equal(isolatedAddressBook(f.store, a.household.id), false);
  assert.throws(
    () =>
      isolateAddressBook(f.store, a.household.id, "stale", "synthetic-admin"),
    /changed/,
  );
  assert.equal(isolatedAddressBook(f.store, a.household.id), false);
  const prepared = isolateAddressBook(
    f.store,
    a.household.id,
    before.fingerprint,
    "synthetic-admin",
  );
  assert.equal(prepared.prepared, true);
  assert.deepEqual(addressBookCheckpoint(f.store, a.household.id), before);
  assert.deepEqual(
    guestRelations(f.store, shared).map((r) => r.household),
    [b.household.id],
  );
  assert.deepEqual(matchingGuests(f.store, a.household.id, first), []);
  autoAssociateContact(f.store, first, a.household.id);
  assert.equal(f.store.get("managed-contact", first.id, a.household.id), null);
  const view = await f.request("/api/host", { cookie: a.cookie });
  assert.equal(view.status, 200);
  assert.deepEqual(view.body.receivedEvents, []);
  assert.equal(view.body.guests[0].linked, false);
  assert.match(
    view.body.guests[0].inviteCode,
    /^[A-F0-9]{4}(?:-[A-F0-9]{4}){7}$/,
  );
  const edited = await f.request(`/api/host/guests/${first.id}`, {
    method: "PUT",
    cookie: a.cookie,
    version: first.version,
    data: { ...first, first: "Local edit" },
  });
  assert.equal(edited.status, 200);
  assert.equal(
    f.store.get("guest", second.id, b.household.id).first,
    second.first,
  );
  assert.equal(
    f.store.one(
      "SELECT identity FROM guest_identity_links WHERE household=? AND guest=?",
      a.household.id,
      first.id,
    ).identity,
    shared,
  );
  assert.deepEqual(
    isolateAddressBook(
      f.store,
      a.household.id,
      before.fingerprint,
      "synthetic-admin",
    ),
    { alreadyPrepared: true },
  );
});

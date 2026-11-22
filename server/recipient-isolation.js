// Explicit additive cutover preparation. Historical links/records remain intact.
import { createHash } from "node:crypto";
import { fail } from "./model.js";
export const isolatedAddressBook = (store, household) =>
  (
    store.get("address-book-policy", "local:" + household, household) ||
    store.get("address-book-policy", "local", household)
  )?.mode === "host-owned";
export function addressBookCheckpoint(store, household) {
  if (!store.household(household)) fail(404, "Household not found.");
  const byID = (rows) =>
    rows.sort((a, b) =>
      String(a.id || a.guest).localeCompare(String(b.id || b.guest)),
    );
  const snapshot = {
    guests: byID(store.list("guest", household)),
    addresses: byID(store.list("address", household)),
    managed: byID(store.list("managed-contact", household)),
    links: byID(
      store.all(
        "SELECT * FROM guest_identity_links WHERE household=?",
        household,
      ),
    ),
  };
  return {
    snapshot,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(snapshot))
      .digest("hex"),
  };
}
export function isolateAddressBook(store, household, fingerprint, actor) {
  return store.transaction(() => {
    if (isolatedAddressBook(store, household)) return { alreadyPrepared: true };
    const checkpoint = addressBookCheckpoint(store, household);
    if (checkpoint.fingerprint !== fingerprint)
      fail(409, "Address Book changed. Prepare a new checkpoint.");
    store.put(
      "address-book-cutover-checkpoint",
      "initial:" + household,
      household,
      {
        ...checkpoint,
        actor,
        at: Date.now(),
      },
    );
    store.put("address-book-policy", "local:" + household, household, {
      mode: "host-owned",
      actor,
      at: Date.now(),
    });
    return { prepared: true, fingerprint: checkpoint.fingerprint };
  });
}

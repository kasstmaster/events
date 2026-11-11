import { randomInt, createHash } from "node:crypto";
import { fail, id } from "./model.js";
const hash = (value) => createHash("sha256").update(value).digest("hex");
function allocate(store) {
  const used = new Set(
    store
      .all(
        "SELECT json_extract(body,'$.code') AS code FROM records WHERE kind='guest-access-code'",
      )
      .map((r) => r.code),
  );
  const free = Array.from({ length: 10000 }, (_, i) =>
    String(i).padStart(4, "0"),
  ).filter((code) => !used.has(code));
  if (!free.length)
    fail(
      409,
      "All four-digit address codes are reserved. Contact the administrator.",
    );
  return free[randomInt(free.length)];
}
export function accessFor(store, guest, household, moved = false) {
  return store.transaction(() => {
    const previous = store.one(
      "SELECT * FROM guest_access_links WHERE household=? AND guest=?",
      household,
      guest.id,
    );
    const address = guest.address || "";
    if (previous && previous.address === address && !moved)
      return store.get("guest-access-code", previous.credential, "platform");
    let credential =
      address &&
      store
        .list("guest-access-code", "platform")
        .find((c) => c.household === household && c.address === address);
    if (!credential)
      credential = store.put("guest-access-code", id(), "platform", {
        household,
        address,
        code: allocate(store),
      });
    // Legacy individual credentials are aliases only until this entry changes address.
    const identity = store.one(
      "SELECT identity,linked FROM guest_identity_links WHERE household=? AND guest=?",
      household,
      guest.id,
    );
    const source =
      identity && store.get("guest-identity", identity.identity, "platform");
    const legacy =
      !previous && !moved && !identity?.linked && source?.creator === household
        ? source.codeHash || null
        : null;
    store.run(
      "INSERT INTO guest_access_links(household,guest,address,credential,legacy_hash) VALUES(?,?,?,?,?) ON CONFLICT(household,guest) DO UPDATE SET address=excluded.address,credential=excluded.credential,legacy_hash=NULL",
      household,
      guest.id,
      address,
      credential.id,
      legacy,
    );
    if ((previous || moved) && identity) {
      const account = store.get(
        "person-account",
        identity.identity,
        "platform",
      );
      if (
        account?.username ||
        account?.hostUser ||
        store.get("guest-auth-activation", identity.identity, "platform")
      ) {
        // A host can invalidate only this local party context, never another
        // household's registered account sessions/devices.
        store.run(
          "DELETE FROM sessions WHERE household=? AND guest=?",
          household,
          guest.id,
        );
      } else
        store.run(
          "DELETE FROM sessions WHERE token IN (SELECT token FROM guest_identity_sessions WHERE identity=?)",
          identity.identity,
        );
    }
    return credential;
  });
}
export function accessCandidates(store, code) {
  // An untouched legacy identity can be migrated without depending on a host opening Address book.
  const legacy = store.one(
    "SELECT id FROM records WHERE kind='guest-identity' AND json_extract(body,'$.codeHash')=?",
    hash(code),
  );
  if (legacy)
    for (const link of store.all(
      "SELECT household,guest FROM guest_identity_links WHERE identity=?",
      legacy.id,
    )) {
      const guest = store.get("guest", link.guest, link.household);
      if (guest) accessFor(store, guest, link.household);
    }
  const credential = store.one(
    "SELECT id FROM records WHERE kind='guest-access-code' AND json_extract(body,'$.code')=?",
    code,
  );
  return store
    .all(
      "SELECT household,guest,address FROM guest_access_links WHERE credential=? OR legacy_hash=?",
      credential?.id || "",
      hash(code),
    )
    .filter(
      (link) =>
        !store.one(
          "SELECT household FROM household_deletions WHERE household=?",
          link.household,
        ),
    )
    .map((link) => ({
      ...link,
      record: store.get("guest", link.guest, link.household),
    }))
    .filter(
      (link) => link.record && (link.record.address || "") === link.address,
    );
}

import { Buffer } from "node:buffer";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { fail, id, text, normalizeName } from "./model.js";
import { effectiveUI } from "./features.js";
const digest = (value) =>
  createHash("sha256").update(String(value)).digest("hex");
export const compareName = (value) =>
  normalizeName(
    String(value || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, " "),
  ).replace(/\s/g, "");
const addressKey = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(
      /\b(street|avenue|road|drive|lane|court|apartment|suite)\b/g,
      (v) =>
        ({
          street: "st",
          avenue: "ave",
          road: "rd",
          drive: "dr",
          lane: "ln",
          court: "ct",
          apartment: "apt",
          suite: "ste",
        })[v],
    )
    .replace(/[^a-z0-9]/g, "");
export function identityFor(store, guest, household) {
  let link = store.one(
    "SELECT identity FROM guest_identity_links WHERE household=? AND guest=?",
    household,
    guest.id,
  );
  if (!link)
    return store.transaction(() => {
      link = store.one(
        "SELECT identity FROM guest_identity_links WHERE household=? AND guest=?",
        household,
        guest.id,
      );
      if (link) return store.get("guest-identity", link.identity, "platform");
      const key = id(),
        code = randomBytes(24).toString("base64url");
      const identity = store.put("guest-identity", key, "platform", {
        code,
        codeHash: digest(code),
        creator: household,
        revision: 1,
      });
      store.run(
        "INSERT INTO guest_identity_links(household,guest,identity) VALUES(?,?,?)",
        household,
        guest.id,
        key,
      );
      return identity;
    });
  return store.get("guest-identity", link.identity, "platform");
}
export function guestContact(store, guest, household) {
  const identity = identityFor(store, guest, household);
  const linked = !!store.one(
    "SELECT linked FROM guest_identity_links WHERE household=? AND guest=?",
    household,
    guest.id,
  )?.linked;
  return {
    ...guest,
    inviteCode: !linked && identity.creator === household ? identity.code : "",
    linked,
  };
}
export function guestRelations(store, identity) {
  return store
    .all(
      "SELECT household,guest FROM guest_identity_links WHERE identity=?",
      identity,
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
    .filter((link) => link.record && !link.record.parent);
}
export function authenticateGuest(store, input) {
  const code = text(input.inviteCode || "", 100),
    row = store.one(
      "SELECT id,household FROM records WHERE kind='guest-identity' AND json_extract(body,'$.codeHash')=?",
      digest(code),
    );
  const identity = row && store.get("guest-identity", row.id, "platform");
  if (
    !identity ||
    !code ||
    !timingSafeEqual(
      Buffer.from(identity.codeHash, "hex"),
      Buffer.from(digest(code), "hex"),
    )
  )
    return null;
  const first = compareName(text(input.first, 80, true)),
    last = compareName(text(input.last, 80, true)),
    suffix = compareName(text(input.suffix || "", 30));
  const candidates = guestRelations(store, identity.id).filter(
    (link) =>
      compareName(link.record.first) === first &&
      compareName(link.record.last) === last,
  );
  return {
    identity,
    candidates,
    relation: candidates.find(
      (link) => compareName(link.record.suffix) === suffix,
    ),
    suffixRequired: candidates.some((link) => !!link.record.suffix),
  };
}
export function invitationView(store, session) {
  const proof = store.one(
    "SELECT identity FROM guest_identity_sessions WHERE token=?",
    session.token,
  );
  if (!proof) fail(401, "Please sign in using your invite code.");
  const relations = guestRelations(store, proof.identity);
  const events = relations.flatMap((link) =>
    store
      .list("event", link.household)
      .filter((event) => event.invited.includes(link.guest))
      .map((event) => ({
        ...store.guestEvent(event, {
          household: link.household,
          guest: link.guest,
        }),
        invitationKey: event.id + ":" + link.guest,
        guestEntry: link.guest,
        invitingHousehold: {
          name: store.household(link.household).name,
          slug: store.household(link.household).slug,
          logo: store.household(link.household).logo || "",
        },
        ui: effectiveUI(store, store.household(link.household), event),
      })),
  );
  return { relations, events, identity: proof.identity };
}
function rememberLink(store, household, guest) {
  const link = store.one(
    "SELECT identity,linked FROM guest_identity_links WHERE household=? AND guest=?",
    household,
    guest,
  );
  const position =
    (store.one(
      "SELECT max(position) AS position FROM guest_identity_history WHERE household=? AND guest=?",
      household,
      guest,
    )?.position || 0) + 1;
  store.run(
    "INSERT INTO guest_identity_history VALUES(?,?,?,?,?)",
    household,
    guest,
    position,
    link.identity,
    link.linked,
  );
}
function closeLinkRequests(store, household, guest) {
  for (const request of store
    .list("guest-link-request", "platform")
    .filter((r) => r.household === household && r.guest === guest))
    store.remove("guest-link-request", request.id, "platform", request.version);
}
export function invalidateIdentity(store, key) {
  store.run(
    "DELETE FROM sessions WHERE token IN (SELECT token FROM guest_identity_sessions WHERE identity=?)",
    key,
  );
  store.run("DELETE FROM guest_identity_sessions WHERE identity=?", key);
}
function distance(a, b, limit = 2) {
  a = Array.from(a);
  b = Array.from(b);
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = Array(b.length + 1).fill(limit + 1);
    row[0] = i;
    let best = limit + 1;
    for (
      let j = Math.max(1, i - limit);
      j <= Math.min(b.length, i + limit);
      j++
    ) {
      row[j] = Math.min(
        previous[j] + 1,
        row[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      best = Math.min(best, row[j]);
    }
    if (best > limit) return limit + 1;
    previous = row;
  }
  return previous[b.length];
}
export function matchingGuests(store, household, input) {
  const first = compareName(text(input.first, 80, true)),
    last = compareName(text(input.last, 80, true)),
    suffix = compareName(input.suffix);
  if (!first || !last)
    fail(400, "Choose valid guest names before checking matches.");
  for (const old of store
    .list("guest-match", household)
    .filter((m) => m.expires < Date.now()))
    store.remove("guest-match", old.id, household, old.version);
  const ownAddress = addressKey(
    input.address ? store.get("address", input.address, household)?.lines : "",
  );
  const current = input.existingId
    ? store.one(
        "SELECT identity FROM guest_identity_links WHERE household=? AND guest=?",
        household,
        input.existingId,
      )?.identity
    : null;
  const candidates = [];
  for (const row of store.all(
    "SELECT id,household FROM records WHERE kind='guest'",
  )) {
    if (
      store.one(
        "SELECT household FROM household_deletions WHERE household=?",
        row.household,
      ) ||
      (row.household === household && row.id === input.existingId)
    )
      continue;
    const known = store.one(
      "SELECT identity FROM guest_identity_links WHERE household=? AND guest=?",
      row.household,
      row.id,
    )?.identity;
    if (known && known === current) continue;
    const guest = store.get("guest", row.id, row.household),
      otherFirst = compareName(guest.first),
      otherLast = compareName(guest.last);
    const firstExact = otherFirst === first,
      lastExact = otherLast === last,
      firstNear = distance(first, otherFirst) <= 2,
      lastNear = distance(last, otherLast) <= 2;
    const address = addressKey(
      guest.address
        ? store.get("address", guest.address, row.household)?.lines
        : "",
    );
    const exactAddress = !!ownAddress && ownAddress === address,
      nearAddress =
        !!ownAddress && !!address && distance(ownAddress, address, 3) <= 3;
    if (
      !(firstExact && lastExact) &&
      !(firstNear && lastNear && first.length >= 3 && last.length >= 3) &&
      !(firstExact && nearAddress)
    )
      continue;
    candidates.push({
      guest,
      household: row.household,
      score:
        (firstExact ? 3 : firstNear ? 2 : 0) +
        (lastExact ? 3 : lastNear ? 2 : 0) +
        (compareName(guest.suffix) === suffix ? 1 : 0) +
        (exactAddress ? 4 : nearAddress ? 3 : 0),
    });
  }
  const results = [],
    seen = new Set();
  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    const identity = identityFor(store, candidate.guest, candidate.household);
    if (seen.has(identity.id)) continue;
    seen.add(identity.id);
    const ticket = id();
    store.put("guest-match", ticket, household, {
      identity: identity.id,
      first,
      last,
      suffix,
      expires: Date.now() + 900000,
    });
    results.push({
      ticket,
      name: [
        candidate.guest.first,
        candidate.guest.last,
        candidate.guest.suffix,
      ]
        .filter(Boolean)
        .join(" "),
      household: store.household(candidate.household).name,
    });
    if (results.length === 5) break;
  }
  return results;
}
export function requestGuestLink(store, household, guest, ticket) {
  const match = store.get("guest-match", ticket, household);
  if (
    !match ||
    match.expires < Date.now() ||
    compareName(guest.first) !== match.first ||
    compareName(guest.last) !== match.last ||
    compareName(guest.suffix) !== match.suffix
  )
    fail(409, "Review matching guests again.");
  const current = identityFor(store, guest, household);
  if (
    guest.parent &&
    store.one(
      "SELECT identity FROM guest_identity_links WHERE household=? AND guest=?",
      household,
      guest.parent,
    )?.identity === match.identity
  )
    fail(400, "A child and their designated adult need separate identities.");
  if (current.id === match.identity) return;
  store.put("guest-link-request", id(), "platform", {
    household,
    guest: guest.id,
    identity: match.identity,
    from: current.id,
    expires: Date.now() + 30 * 86400000,
  });
}
export async function identityAPI(ctx) {
  const {
    path,
    method,
    session,
    store,
    body,
    req,
    res,
    json,
    requireRole,
    version,
  } = ctx;
  if (path === "/api/host/guest-matches" && method === "POST") {
    requireRole("host");
    store.limit("guest-match:" + session.household, 60);
    json(res, matchingGuests(store, session.household, await body(req)));
    return true;
  }
  const unlink = path.match(/^\/api\/host\/guests\/([\w-]+)\/unlink$/);
  if (unlink && method === "POST") {
    requireRole("host");
    const guest = store.get("guest", unlink[1], session.household);
    if (!guest) fail(404, "Guest not found.");
    if (
      !store.one(
        "SELECT linked FROM guest_identity_links WHERE household=? AND guest=?",
        session.household,
        guest.id,
      )?.linked
    )
      fail(400, "This entry has no shared link to correct.");
    const input = await body(req);
    if (
      input.confirm !==
      [guest.first, guest.last, guest.suffix].filter(Boolean).join(" ")
    )
      fail(400, "Confirm the exact guest name.");
    store.transaction(() => {
      if (guest.version !== version(req)) fail(409, "Guest changed.");
      const previous = identityFor(store, guest, session.household);
      invalidateIdentity(store, previous.id);
      const history = store.one(
        "SELECT * FROM guest_identity_history WHERE household=? AND guest=? ORDER BY position DESC LIMIT 1",
        session.household,
        guest.id,
      );
      if (history) {
        store.run(
          "UPDATE guest_identity_links SET identity=?,linked=? WHERE household=? AND guest=?",
          history.identity,
          history.linked,
          session.household,
          guest.id,
        );
        store.run(
          "DELETE FROM guest_identity_history WHERE household=? AND guest=? AND position=?",
          session.household,
          guest.id,
          history.position,
        );
        invalidateIdentity(store, history.identity);
      } else {
        store.run(
          "DELETE FROM guest_identity_links WHERE household=? AND guest=?",
          session.household,
          guest.id,
        );
        identityFor(store, guest, session.household);
      }
      closeLinkRequests(store, session.household, guest.id);
      store.put("guest", guest.id, session.household, guest, guest.version);
    });
    json(
      res,
      guestContact(
        store,
        store.get("guest", guest.id, session.household),
        session.household,
      ),
    );
    return true;
  }
  if (path === "/api/guest/link-requests") {
    requireRole("guest");
    const proof = store.one(
      "SELECT identity FROM guest_identity_sessions WHERE token=?",
      session.token,
    );
    if (!proof) fail(401, "Please sign in.");
    const permitted = new Set([proof.identity]);
    for (const relation of guestRelations(store, proof.identity))
      for (const child of store
        .list("guest", relation.household)
        .filter((g) => g.parent === relation.guest))
        permitted.add(identityFor(store, child, relation.household).id);
    const pending = store
      .list("guest-link-request", "platform")
      .filter(
        (r) =>
          permitted.has(r.identity) &&
          r.expires > Date.now() &&
          !store.one(
            "SELECT household FROM household_deletions WHERE household=?",
            r.household,
          ),
      );
    if (method === "GET") {
      json(
        res,
        pending.map((r) => ({
          id: r.id,
          household: store.household(r.household)?.name,
          name: [
            store.get("guest", r.guest, r.household)?.first,
            store.get("guest", r.guest, r.household)?.last,
            store.get("guest", r.guest, r.household)?.suffix,
          ]
            .filter(Boolean)
            .join(" "),
        })),
      );
      return true;
    }
    if (method === "POST") {
      const input = await body(req),
        request = pending.find((r) => r.id === input.id);
      if (!request) fail(404, "Request not found.");
      store.transaction(() => {
        if (input.approve === true) {
          const guest = store.get("guest", request.guest, request.household);
          if (!guest) fail(404, "Guest no longer available.");
          const current = identityFor(store, guest, request.household);
          if (current.id !== request.from)
            fail(409, "The guest relationship changed.");
          if (
            guest.parent &&
            store.one(
              "SELECT identity FROM guest_identity_links WHERE household=? AND guest=?",
              request.household,
              guest.parent,
            )?.identity !== proof.identity
          )
            fail(403, "Link the designated adult before linking a child.");
          rememberLink(store, request.household, request.guest);
          store.run(
            "UPDATE guest_identity_links SET identity=?,linked=1 WHERE household=? AND guest=?",
            request.identity,
            request.household,
            request.guest,
          );
          store.put("guest", guest.id, request.household, guest, guest.version);
          invalidateIdentity(store, current.id);
        }
        store.remove(
          "guest-link-request",
          request.id,
          "platform",
          request.version,
        );
        if (input.approve === true)
          closeLinkRequests(store, request.household, request.guest);
      });
      json(res, { ok: true });
      return true;
    }
  }
  return false;
}

export function claimPermanentCode(store, input, household) {
  const newProof = authenticateGuest(store, input),
    old = store.one(
      "SELECT id FROM records WHERE kind='guest-identity' AND json_extract(body,'$.codeHash')=?",
      digest(text(input.permanentCode || "", 100)),
    );
  const relation = newProof?.candidates.find(
    (link) =>
      link.household === household &&
      compareName(link.record.suffix) === compareName(input.suffix),
  );
  if (!old || !relation) fail(401, "Unable to confirm both invite codes.");
  if (old.id === newProof.identity.id) return;
  store.transaction(() => {
    rememberLink(store, household, relation.guest);
    store.run(
      "UPDATE guest_identity_links SET identity=?,linked=1 WHERE household=? AND guest=?",
      old.id,
      household,
      relation.guest,
    );
    store.put(
      "guest",
      relation.guest,
      household,
      relation.record,
      relation.record.version,
    );
    invalidateIdentity(store, newProof.identity.id);
    invalidateIdentity(store, old.id);
    closeLinkRequests(store, household, relation.guest);
  });
}

export function guestBrandHousehold(store, session) {
  const entry = store.one(
    "SELECT entry_household FROM guest_identity_sessions WHERE token=?",
    session.token,
  )?.entry_household;
  if (
    entry &&
    store.household(entry) &&
    !store.one(
      "SELECT household FROM household_deletions WHERE household=?",
      entry,
    )
  )
    return store.household(entry);
  const household = store.household(session.household);
  if (!household) fail(401, "Please sign in again.");
  return household;
}

import { publicEventPages } from "./event-pages.js";
import { hostOnlyMode } from "./host-model.js";
import { isolatedAddressBook } from "./recipient-isolation.js";
// Additive, opt-in invitation capabilities. These are not user accounts or sessions.
import { randomBytes, createHash } from "node:crypto";
import { fail } from "./model.js";
import { addressEvent, saveAddressResponse } from "./address-rsvp.js";
import { effectiveUI } from "./features.js";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const unavailable = () => fail(404, "Invitation unavailable.");
export const publicInvitationsEnabled = (env) =>
  hostOnlyMode(env) || env.PUBLIC_INVITATIONS_ENABLED === "true";
export function groupFor(store, household, guest) {
  const person = store.get("guest", guest, household);
  if (!person) unavailable();
  const adult = person.parent
    ? store.get("guest", person.parent, household)
    : person;
  if (!adult || adult.parent) unavailable();
  return {
    key: adult.address ? `address:${adult.address}` : `adult:${adult.id}`,
    adult,
  };
}
// Stable per inviting host/address, never derived from a global identity or phone.
export function recipientHouseholdID(store, household, guest) {
  const { key } = groupFor(store, household, guest);
  return store.transaction(() => {
    const existing = store.get("invitation-household", key, household);
    if (existing) return existing;
    const code = randomBytes(16)
      .toString("hex")
      .toUpperCase()
      .match(/.{4}/g)
      .join("-");
    const record = store.put("invitation-household", key, household, {
      code,
      generation: 1,
    });
    store.put(
      "invitation-household-index",
      digest(code.replaceAll("-", "")),
      household,
      { group: key },
    );
    return record;
  });
}
export function publicEventReference(store, household, event) {
  if (!store.get("event", event, household)) unavailable();
  return store.transaction(() => {
    const existing = store.get("public-event-key", event, household);
    if (existing) return existing.reference;
    const reference = token();
    store.put("public-event", reference, "platform", { household, event });
    store.put("public-event-key", event, household, { reference });
    return reference;
  });
}
export function resolvePublicEvent(store, reference, selected) {
  const link = store.get("public-event", reference, "platform");
  if (!link || link.revoked || (selected && selected.id !== link.household))
    unavailable();
  const event = store.get("event", link.event, link.household);
  const household = store.household(link.household);
  if (!event || !household) unavailable();
  return { link, event, household };
}
// Allowlist: never spread event/contact/account records onto a public response.
export function publicEventView(store, event, household) {
  const fields = [
    "id",
    "version",
    "title",
    "description",
    "date",
    "time",
    "deadline",
    "location",
    "address",
    "icon",
    "information",
    "registries",
    "uploadURL",
    "viewURL",
    "containerLayout",
    "informationLayout",
    "customItemsEnabled",
  ];
  const result = Object.fromEntries(
    fields
      .filter((key) => Object.hasOwn(event, key))
      .map((key) => [key, event[key]]),
  );
  const totals = store.totals(event, household.id);
  return {
    ...result,
    extraPages: publicEventPages(store, event, household.id),
    totals: { invited: totals.invited, attending: totals.attending },
    menu: store.menuView(event, household.id),
    members: [],
    response: { version: 0, attendance: {}, claims: {} },
    ui: effectiveUI(store, household, event),
  };
}
function recipient(store, link, event, record) {
  const adult = store
    .list("guest", link.household)
    .find(
      (person) =>
        !person.parent &&
        event.invited.includes(person.id) &&
        groupFor(store, link.household, person.id).key === record.id,
    );
  if (!adult) unavailable();
  return { household: link.household, guest: adult.id };
}
function authorized(store, link, event, raw) {
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(raw))
    unavailable();
  const grant = store.get("invitation-rsvp-grant", digest(raw), link.household);
  if (!grant || grant.event !== event.id || grant.expires <= Date.now())
    unavailable();
  const record = store.get("invitation-household", grant.group, link.household);
  if (!record || record.generation !== grant.generation || record.revoked)
    unavailable();
  const subject = recipient(store, link, event, record);
  // Moving a person/address or uninviting them revokes previously issued access.
  if (subject.guest !== grant.guest) unavailable();
  return subject;
}
function partyView(store, event, household, subject) {
  const party = addressEvent(store, event, subject);
  return {
    ...publicEventView(store, event, household),
    members: party.members,
    response: party.response,
    partyAttendance: party.partyAttendance,
    partyVersions: party.partyVersions,
  };
}
function eventSnapshot(store, env, event, household) {
  return {
    hostOnly: hostOnlyMode(env),
    household: {
      name: household.name,
      slug: household.slug,
      logo: household.logo,
    },
    ui: effectiveUI(store, household),
    events: [publicEventView(store, event, household)],
  };
}
export function readPublicEvent(store, env, reference, selected, peer) {
  if (!publicInvitationsEnabled(env)) unavailable();
  store.limit(`public-invitation:${peer}`, 100, 60000);
  const { link, event, household } = resolvePublicEvent(
    store,
    reference,
    selected,
  );
  if (hostOnlyMode(env) && !isolatedAddressBook(store, link.household))
    unavailable();
  return eventSnapshot(store, env, event, household);
}
export function readLegacyInvitation(store, env, legacy, selected, peer) {
  if (!publicInvitationsEnabled(env)) unavailable();
  const ref = store.get("rsvp-reference", legacy, "platform");
  if (
    !ref ||
    (selected && selected.id !== ref.household) ||
    (hostOnlyMode(env) && !isolatedAddressBook(store, ref.household))
  )
    unavailable();
  const reference = publicEventReference(store, ref.household, ref.event);
  return {
    path: `/event/${reference}`,
    ...(peer !== undefined
      ? { event: readPublicEvent(store, env, reference, selected, peer) }
      : {}),
  };
}
export async function publicInvitationsAPI(ctx) {
  const {
    path,
    method,
    store,
    env,
    req,
    res,
    json,
    body,
    session,
    requireRole,
    selected,
  } = ctx;
  const legacy = path.match(
    /^\/api\/public\/invitations\/([A-Za-z0-9_-]{43})$/,
  );
  if (legacy) {
    if (!publicInvitationsEnabled(env) || method !== "GET") unavailable();
    json(
      res,
      readLegacyInvitation(
        store,
        env,
        legacy[1],
        selected,
        ctx.includeEvent ? req.socket.remoteAddress : undefined,
      ),
    );
    return true;
  }
  const host = path.match(
    /^\/api\/host\/events\/([A-Za-z0-9-]+)\/public-invitation$/,
  );
  const visitor = path.match(
    /^\/api\/public\/events\/([A-Za-z0-9_-]{43})(?:\/(access|rsvp))?$/,
  );
  if (!host && !visitor) return false;
  if (!publicInvitationsEnabled(env)) unavailable();
  if (host) {
    if (method !== "POST") fail(405, "Method not allowed.");
    requireRole("host");
    const event = store.get("event", host[1], session.household);
    if (!event) unavailable();
    const input = await body(req);
    if (input.version !== event.version)
      fail(409, "Event changed. Refresh before preparing invitations.");
    const result = store.transaction(() => {
      const reference = publicEventReference(
        store,
        session.household,
        event.id,
      );
      const recipients = store
        .list("guest", session.household)
        .filter((g) => !g.parent && event.invited.includes(g.id))
        .map((g) => ({
          guest: g.id,
          householdID: recipientHouseholdID(store, session.household, g.id)
            .code,
        }));
      return { reference, path: `/event/${reference}`, recipients };
    });
    json(res, result);
    return true;
  }
  if (!visitor[2] && method === "GET") {
    json(
      res,
      readPublicEvent(
        store,
        env,
        visitor[1],
        selected,
        req.socket.remoteAddress,
      ),
    );
    return true;
  }
  store.limit(`public-invitation:${req.socket.remoteAddress}`, 100, 60000);
  const { link, event, household } = resolvePublicEvent(
    store,
    visitor[1],
    selected,
  );
  if (hostOnlyMode(env) && !isolatedAddressBook(store, link.household))
    unavailable();
  if (visitor[2] === "access" && method === "POST") {
    store.limit(
      `recipient-lookup:${req.socket.remoteAddress}:${visitor[1]}`,
      8,
      60000,
    );
    const input = await body(req);
    const code =
      typeof input.householdID === "string" && input.householdID.length <= 64
        ? input.householdID
            .toUpperCase()
            .replaceAll("-", "")
            .replaceAll(" ", "")
        : "";
    if (!/^[A-F0-9]{32}$/.test(code)) unavailable();
    const index = store.get(
      "invitation-household-index",
      digest(code),
      link.household,
    );
    const record =
      index && store.get("invitation-household", index.group, link.household);
    if (!record || record.revoked) unavailable();
    const subject = recipient(store, link, event, record),
      grant = token();
    for (const expired of store
      .list("invitation-rsvp-grant", link.household)
      .filter((row) => row.expires <= Date.now()))
      store.remove(
        "invitation-rsvp-grant",
        expired.id,
        link.household,
        expired.version,
      );
    store.put("invitation-rsvp-grant", digest(grant), link.household, {
      event: event.id,
      group: record.id,
      generation: record.generation,
      guest: subject.guest,
      expires: Date.now() + 30 * 60000,
    });
    json(res, { grant, event: partyView(store, event, household, subject) });
    return true;
  }
  if (visitor[2] === "access" && method === "DELETE") {
    const { grant } = await body(req);
    if (typeof grant === "string" && /^[A-Za-z0-9_-]{43}$/.test(grant)) {
      const record = store.get(
        "invitation-rsvp-grant",
        digest(grant),
        link.household,
      );
      if (record?.event === event.id)
        store.remove(
          "invitation-rsvp-grant",
          record.id,
          link.household,
          record.version,
        );
    }
    json(res, { ok: true });
    return true;
  }
  if (visitor[2] === "rsvp" && method === "PUT") {
    const input = await body(req),
      subject = authorized(store, link, event, input.grant);
    saveAddressResponse(store, event, subject, input, {});
    json(res, {
      event: partyView(
        store,
        store.get("event", event.id, link.household),
        household,
        subject,
      ),
    });
    return true;
  }
  fail(405, "Method not allowed.");
}

import { hostOnlyMode } from "./host-model.js";
import { isolatedAddressBook } from "./recipient-isolation.js";
import { randomBytes, createHash } from "node:crypto";
import { fail, id, text, image } from "./model.js";
import { informationInput } from "../public/event-information.js";
import {
  publicInvitationsEnabled,
  resolvePublicEvent,
  publicEventReference,
} from "./public-invitations.js";
const hash = (value) => createHash("sha256").update(value).digest("hex"),
  unavailable = () => fail(404, "Page unavailable.");
export function eventPages(store, event, household) {
  return store
    .list("event-page", household)
    .filter((p) => p.event === event.id && !p.archived)
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}
export const pageMetadata = (page) => ({
  id: page.id,
  title: page.title,
  position: page.position,
});
export function publicEventPages(store, event, household) {
  return eventPages(store, event, household)
    .filter((p) => p.audience === "public")
    .map(pageMetadata);
}
export function eventPerson(store, event, household, key) {
  const guest = store.get("guest", key, household);
  if (guest && event.invited.includes(key)) return guest;
  return (
    store
      .get("host-family-roster", "family:" + household, household)
      ?.members.find((m) => m.rsvpID === key && !m.archived) || null
  );
}
function visiblePages(store, event, household, raw) {
  const all = eventPages(store, event, household);
  if (!raw) return all.filter((p) => p.audience === "public");
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(raw))
    unavailable();
  const grant = store.get("private-page-grant", hash(raw), household),
    guest = grant && eventPerson(store, event, household, grant.guest);
  if (
    !grant ||
    grant.revoked ||
    grant.event !== event.id ||
    grant.expires <= Date.now() ||
    !guest
  )
    unavailable();
  const roles =
    store.get("event-person-roles", event.id + ":" + grant.guest, household)
      ?.roles || [];
  return all.filter(
    (p) =>
      p.audience === "public" ||
      (p.audience === "members" && p.members.includes(grant.guest)) ||
      (p.audience === "roles" && p.roles.some((role) => roles.includes(role))),
  );
}
function strings(values, max = 40) {
  if (!Array.isArray(values) || values.length > max)
    fail(400, "Check page access selections.");
  return [...new Set(values.map((v) => text(v, 100, true)))];
}
export function pageInput(input, event, store, household, previous = {}) {
  const audience = input.audience || previous.audience || "public";
  if (!["public", "roles", "members"].includes(audience))
    fail(400, "Choose page visibility.");
  const roles = strings(input.roles || previous.roles || []),
    members = strings(input.members || previous.members || [], 200);
  if (members.some((key) => !eventPerson(store, event, household, key)))
    fail(400, "Choose invited members of this event.");
  let content;
  try {
    content = informationInput(input.content || previous.content || []);
  } catch {
    fail(400, "Check the page content.");
  }
  return {
    event: event.id,
    title: text(input.title ?? previous.title, 160, true),
    content,
    image: image(input.image ?? previous.image ?? ""),
    audience,
    roles,
    members,
    position: previous.position ?? Date.now(),
    archived: false,
  };
}
export async function eventPagesAPI(ctx) {
  const {
    path,
    method,
    req,
    res,
    store,
    env,
    session,
    requireRole,
    body,
    json,
    version,
    selected,
    origin,
  } = ctx;
  const host = path.match(
      /^\/api\/host\/events\/([A-Za-z0-9-]+)\/(pages|page-grants|page-roles)(?:\/([A-Za-z0-9-]+))?$/,
    ),
    visitor = path.match(
      /^\/api\/public\/events\/([A-Za-z0-9_-]{43})\/pages(?:\/([A-Za-z0-9-]+))?$/,
    );
  if (!host && !visitor) return false;
  if (!publicInvitationsEnabled(env)) unavailable();
  if (visitor) {
    if (method !== "POST") fail(405, "Method not allowed.");
    store.limit("private-pages:" + req.socket.remoteAddress, 60, 60000);
    const { event, link } = resolvePublicEvent(store, visitor[1], selected);
    if (hostOnlyMode(env) && !isolatedAddressBook(store, link.household))
      unavailable();
    const input = await body(req),
      pages = visiblePages(store, event, link.household, input.grant);
    if (!visitor[2]) json(res, { pages: pages.map(pageMetadata) });
    else {
      const page = pages.find((p) => p.id === visitor[2]);
      if (!page) unavailable();
      json(res, {
        page: {
          ...pageMetadata(page),
          content: page.content,
          image: page.image,
        },
      });
    }
    return true;
  }
  requireRole("host");
  const household = session.household,
    event = store.get("event", host[1], household);
  if (!event) unavailable();
  if (host[2] === "pages") {
    if (method === "GET") {
      json(res, {
        pages: eventPages(store, event, household),
        roles: store
          .list("event-person-roles", household)
          .filter((r) => r.event === event.id),
        grants: store
          .list("private-page-grant", household)
          .filter((g) => g.event === event.id)
          .map(({ id, guest, revoked, expires, version }) => ({
            id,
            guest,
            revoked: !!revoked,
            expires,
            version,
          })),
      });
      return true;
    }
    if (!["POST", "PUT", "DELETE"].includes(method))
      fail(405, "Method not allowed.");
    const input = await body(req),
      previous = host[3] && store.get("event-page", host[3], household);
    if (host[3] && (!previous || previous.event !== event.id)) unavailable();
    if (method !== "POST" && !previous) unavailable();
    if (method === "DELETE" && input.confirm !== true)
      fail(400, "Confirm archiving this page.");
    const next =
      method === "DELETE"
        ? { ...previous, archived: true }
        : pageInput(input, event, store, household, previous || {});
    const result = store.transaction(() => {
      if (previous && previous.version !== version(req))
        fail(409, "Page changed. Refresh first.");
      if (previous)
        store.put(
          "event-page-history",
          previous.id + ":" + previous.version,
          household,
          { page: previous, at: Date.now(), actor: session.user },
        );
      return store.put(
        "event-page",
        previous?.id || id(),
        household,
        next,
        previous ? previous.version : undefined,
      );
    });
    json(res, { page: result });
    return true;
  }
  if (method !== "POST") fail(405, "Method not allowed.");
  const input = await body(req);
  if (host[2] === "page-roles") {
    if (!eventPerson(store, event, household, input.guest)) unavailable();
    const key = event.id + ":" + input.guest,
      previous = store.get("event-person-roles", key, household);
    if ((previous?.version || 0) !== input.version)
      fail(409, "Member roles changed. Refresh first.");
    const record = store.put(
      "event-person-roles",
      key,
      household,
      { event: event.id, guest: input.guest, roles: strings(input.roles) },
      previous?.version,
    );
    json(res, record);
    return true;
  }
  if (input.revoke) {
    const grant = store.get("private-page-grant", input.revoke, household);
    if (!grant || grant.event !== event.id) unavailable();
    if (grant.version !== input.version)
      fail(409, "Access changed. Refresh first.");
    if (input.confirm !== true) fail(400, "Confirm revoking private access.");
    store.put(
      "private-page-grant",
      grant.id,
      household,
      { ...grant, revoked: true },
      grant.version,
    );
    json(res, { ok: true });
    return true;
  }
  if (!eventPerson(store, event, household, input.guest)) unavailable();
  const raw = randomBytes(32).toString("base64url");
  store.put("private-page-grant", hash(raw), household, {
    event: event.id,
    guest: input.guest,
    expires: Date.now() + 180 * 86400000,
    revoked: false,
  });
  const reference = publicEventReference(store, household, event.id);
  json(res, { url: origin + "/event/" + reference + "#private=" + raw });
  return true;
}

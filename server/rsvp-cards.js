import { centralPerson, membership } from "./central-membership.js";
import { Buffer } from "node:buffer";
import { cardInput } from "./features.js";
import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { fail } from "./model.js";
import { renderCard } from "../public/card-system.js";
import { identityFor, guestRelations } from "./guest-identities.js";
import { privateIdentity, personalAccount } from "./personal-accounts.js";
import { recipientBlocked } from "./personal-accounts.js";
import {
  universalEnabled,
  GATHER_ORIGIN,
  activeEntry,
  activeHouseholdLabel,
} from "./passwordless.js";
export function referenceFor(store, household, event, group) {
  const key = event.id + ":" + (group.address || group.id);
  const existing = store.get("rsvp-reference-key", key, household);
  if (existing) {
    const ref = store.get("rsvp-reference", existing.reference, "platform");
    store.put(
      "rsvp-reference",
      ref.id,
      "platform",
      { ...ref, guests: [...new Set([...ref.guests, ...group.guests])] },
      ref.version,
    );
    return existing.reference;
  }
  const reference = randomBytes(32).toString("base64url");
  store.put("rsvp-reference", reference, "platform", {
    household,
    event: event.id,
    guests: group.guests,
  });
  store.put("rsvp-reference-key", key, household, { reference });
  return reference;
}
export function resolveRSVPReference(store, reference, session, hosts) {
  if (!session) {
    const ref = store.get("rsvp-reference", reference, "platform");
    const house = ref && store.household(ref.household);
    return {
      authenticated: false,
      entry: activeHouseholdLabel(store, house, hosts),
    };
  }
  if (!["host", "guest"].includes(session.role))
    fail(404, "Invitation unavailable.");
  const identity = privateIdentity(store, session),
    ref = store.get("rsvp-reference", reference, "platform");
  if (!ref) fail(404, "Invitation unavailable.");
  const event = store.get("event", ref.event, ref.household),
    house = store.household(ref.household);
  if (!event || !activeHouseholdLabel(store, house, hosts))
    fail(404, "Invitation unavailable.");
  const relation = guestRelations(store, identity).find(
    (r) =>
      r.household === ref.household &&
      ref.guests.some((id) => {
        const target = store.get("guest", id, ref.household);
        return (
          target &&
          event.invited.includes(id) &&
          (id === r.guest ||
            target.parent === r.guest ||
            (target.address && target.address === r.record.address))
        );
      }) &&
      event.invited.includes(r.guest) &&
      !r.record.parent &&
      !recipientBlocked(store, ref.household, r.guest),
  );
  if (!relation) fail(404, "Invitation unavailable.");
  const central = centralPerson(store, identity),
    member =
      central?.profile.sourceHousehold &&
      membership(store, central.profile.sourceHousehold, identity);
  const account = personalAccount(store, identity),
    host =
      account?.hostUser &&
      store.one(
        "SELECT id FROM users WHERE id=? AND role='host'",
        account.hostUser,
      );
  const approvedHost =
    host ||
    (member?.status === "approved" &&
      member.role === "adult" &&
      !store.one(
        "SELECT household FROM household_deletions WHERE household=?",
        central.profile.sourceHousehold,
      ));
  return {
    authenticated: true,
    invitationKey: event.id + ":" + relation.guest,
    guestEntry: relation.guest,
    destination: approvedHost
      ? "https://" + activeHouseholdLabel(store, house, hosts) + ".ilymmd.com/"
      : GATHER_ORIGIN + "/" + activeHouseholdLabel(store, house, hosts),
  };
}
export async function rsvpCardsAPI(ctx) {
  const {
    path,
    method,
    req,
    res,
    store,
    session,
    body,
    json,
    env,
    version,
    requireRole,
    householdHosts,
  } = ctx;
  const match = path.match(
      /^\/api\/host\/events\/([A-Za-z0-9-]+)\/rsvp-cards$/,
    ),
    resolve = path.match(/^\/api\/invitations\/([A-Za-z0-9_-]{43})\/resolve$/);
  if (!match && !resolve) return false;
  if (!universalEnabled(env)) fail(404, "Page not found.");
  if (resolve && method === "GET") {
    store.limit("rsvp-reference:" + req.socket.remoteAddress, 100, 60000);
    json(res, resolveRSVPReference(store, resolve[1], session, householdHosts));
    return true;
  }
  if (!match || method !== "POST") fail(405, "Method not allowed.");
  requireRole("host");
  const input = await body(req),
    event = store.get("event", match[1], session.household),
    house = store.household(session.household);
  if (!event || !activeHouseholdLabel(store, house, householdHosts))
    fail(404, "An active household address is required.");
  if (event.version !== version(req))
    fail(409, "Event changed. Refresh before preparing cards.");
  if (
    !Array.isArray(input.guestIds) ||
    !input.guestIds.length ||
    input.guestIds.length > 200 ||
    new Set(input.guestIds).size !== input.guestIds.length ||
    input.guestIds.some((id) => !event.invited.includes(id))
  )
    fail(400, "Select invited recipients for this event.");
  const source = input.card
    ? store.get("card", input.card, session.household)
    : input.cardDraft
      ? {
          ...cardInput(input.cardDraft),
          event: event.id,
          context: { household: { name: house.name }, event },
        }
      : null;
  if (input.card && (!source || source.event !== event.id))
    fail(400, "Choose this event's invitation card.");
  const groups = new Map();
  for (const id of input.guestIds) {
    const guest = store.get("guest", id, session.household);
    if (!guest) fail(400, "Recipient unavailable.");
    const key = guest.address || guest.parent || guest.id;
    if (!groups.has(key))
      groups.set(key, {
        id: guest.parent || guest.id,
        address: guest.address,
        guests: [],
        people: [],
      });
    const group = groups.get(key);
    group.guests.push(id);
    group.people.push(guest);
  }
  if (
    (Buffer.byteLength(JSON.stringify(source || {})) + 10000) * groups.size >
    8_000_000
  )
    fail(413, "Choose a smaller recipient batch for this invitation artwork.");
  const entries = store.transaction(() =>
    [...groups.values()].map((group) => {
      const label =
        group.address &&
        store.get("address", group.address, session.household)?.label;
      const name =
        label ||
        group.people
          .map((p) =>
            [p.first, ...(p.parent ? [] : [p.last, p.suffix])]
              .filter(Boolean)
              .join(" "),
          )
          .join(" & ");
      const ref = referenceFor(store, session.household, event, group);
      return { reference: ref, name, guestIds: group.guests };
    }),
  );
  const cards = [];
  for (const recipient of entries) {
    const url = GATHER_ORIGIN + "/invite/" + recipient.reference;
    const qr = await QRCode.toDataURL(url, {
      errorCorrectionLevel: "M",
      margin: 4,
      width: 512,
    });
    const rgb = (source?.color || "#fffdf9")
      .slice(1)
      .match(/../g)
      .map((v) => parseInt(v, 16));
    const foreground =
      rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722 > 150
        ? "#172b24"
        : "#fffdf9";
    const card = {
      name: "RSVP · " + recipient.name,
      width: 600,
      height: 420,
      color: source?.color || "#fffdf9",
      includeQR: true,
      elements: [
        {
          field: "recipient.name",
          x: 300,
          y: 20,
          width: 550,
          height: 70,
          fontSize: 28,
          font:
            source?.elements.find((e) => e.field !== "qr")?.font || "Georgia",
          align: "center",
          color: foreground,
        },
        {
          field: "qr",
          x: 200,
          y: 95,
          width: 200,
          height: 200,
          qrColor: "#000000",
          qrTransparent: false,
        },
        {
          field: "text",
          text: "Scan to RSVP",
          x: 300,
          y: 330,
          width: 550,
          height: 60,
          fontSize: 27,
          font:
            source?.elements.find((e) => e.field !== "qr")?.font || "Georgia",
          align: "center",
          color: foreground,
        },
      ],
    };
    const context = {
      household: { name: house.name },
      event,
      recipient: { name: recipient.name },
    };
    cards.push({
      ...recipient,
      width: card.width,
      height: card.height,
      url,
      svg: renderCard(card, context, qr),
      invitation: source
        ? renderCard(
            {
              ...source,
              elements: source.elements.filter(
                (e) => !["recipient.inviteCode", "qr"].includes(e.field),
              ),
            },
            {
              ...source.context,
              recipient: {
                ...source.context?.recipient,
                name: recipient.name,
                inviteCode: "",
              },
            },
            "",
          )
        : "",
    });
  }
  json(res, { cards });
  return true;
}

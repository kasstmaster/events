import {
  groupFor,
  publicInvitationsEnabled,
  publicEventReference,
  recipientHouseholdID,
} from "./public-invitations.js";
import { resolveRSVPReference } from "./invitation-routing.js";
export { resolveRSVPReference } from "./invitation-routing.js";
import { Buffer } from "node:buffer";
import { cardInput } from "./features.js";
import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { fail } from "./model.js";
import { renderCard } from "../public/card-system.js";
import {
  universalEnabled,
  GATHER_ORIGIN,
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
  const publicMode = publicInvitationsEnabled(env);
  if (!publicMode && !universalEnabled(env)) fail(404, "Page not found.");
  if (resolve && publicMode)
    fail(404, "Use the event link on your invitation.");
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
  const selectedGroups = publicMode
    ? new Set(
        input.guestIds.map((id) => groupFor(store, session.household, id).key),
      )
    : null;
  const recipientIDs = publicMode
    ? event.invited.filter((id) =>
        selectedGroups.has(groupFor(store, session.household, id).key),
      )
    : input.guestIds;
  if (publicMode && recipientIDs.length > 200)
    fail(400, "Choose a smaller household batch.");
  for (const id of recipientIDs) {
    const guest = store.get("guest", id, session.household);
    if (!guest) fail(400, "Recipient unavailable.");
    const key = publicMode
      ? groupFor(store, session.household, guest.id).key
      : guest.address || guest.parent || guest.id;
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
      const ref = publicMode
        ? publicEventReference(store, session.household, event.id)
        : referenceFor(store, session.household, event, group);
      const primary = group.people.find((p) => !p.parent) || group.people[0];
      return {
        reference: ref,
        name,
        guestIds: group.guests,
        ...(publicMode
          ? {
              publicInvitation: true,
              householdID: recipientHouseholdID(
                store,
                session.household,
                primary.id,
              ).code,
              invitedNames: group.people.map((p) =>
                [p.first, ...(p.parent ? [] : [p.last]), p.suffix]
                  .filter(Boolean)
                  .join(" "),
              ),
            }
          : {}),
      };
    }),
  );
  const cards = [];
  for (const recipient of entries) {
    const url =
      GATHER_ORIGIN +
      (publicMode ? "/event/" : "/invite/") +
      recipient.reference;
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
          fontSize: publicMode ? 16 : 28,
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
          text: publicMode
            ? "Household ID: " + recipient.householdID
            : "Scan to RSVP",
          x: 300,
          y: 330,
          width: 550,
          height: 60,
          fontSize: publicMode ? 16 : 27,
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
      recipient: {
        name: publicMode ? recipient.invitedNames.join(" · ") : recipient.name,
      },
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

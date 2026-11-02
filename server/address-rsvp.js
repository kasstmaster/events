import { fail } from "./model.js";
export function addressAdults(store, event, session) {
  const guest = store.get("guest", session.guest, session.household);
  return store
    .list("guest", session.household)
    .filter(
      (g) =>
        !g.parent &&
        event.invited.includes(g.id) &&
        (g.id === guest.id || (guest.address && g.address === guest.address)),
    );
}
export function addressEvent(store, event, session) {
  const result = store.guestEvent(event, session);
  const parties = addressAdults(store, event, session).map((g) => ({
    guest: g.id,
    ...store.guestEvent(event, { ...session, guest: g.id }),
  }));
  result.members = parties.flatMap((p) => p.members);
  result.partyAttendance = Object.assign(
    {},
    ...parties.map((p) => p.response.attendance),
  );
  result.partyVersions = Object.fromEntries(
    parties.map((p) => [p.guest, p.response.version]),
  );
  return result;
}
export function saveAddressResponse(store, event, session, input) {
  return store.transaction(() => {
    const current = store.get("event", event.id, session.household);
    if (!current?.invited.includes(session.guest))
      fail(404, "Event not found.");
    if (
      !input.attendance ||
      typeof input.attendance !== "object" ||
      Array.isArray(input.attendance)
    )
      fail(400, "Invalid RSVP members.");
    const adults = addressAdults(store, current, session),
      parties = adults.map((g) => ({
        guest: g.id,
        ...store.guestEvent(current, { ...session, guest: g.id }),
      }));
    const allowed = new Set(parties.flatMap((p) => p.members.map((m) => m.id)));
    if (Object.keys(input.attendance).some((key) => !allowed.has(key)))
      fail(400, "Invalid RSVP members.");
    if (
      !input.claims ||
      typeof input.claims !== "object" ||
      Array.isArray(input.claims)
    )
      fail(400, "Invalid menu selections.");
    let result;
    for (const party of parties) {
      const own = party.guest === session.guest;
      const attendance = Object.fromEntries(
        party.members
          .filter(
            (m) =>
              input.attendance[m.id] !== undefined &&
              input.attendance[m.id] !== "",
          )
          .map((m) => [m.id, input.attendance[m.id]]),
      );
      const previous = party.response;
      const normalizedClaims = Object.fromEntries(
        Object.entries(input.claims).filter(([, n]) => n !== 0),
      );
      const sameClaims =
        JSON.stringify(normalizedClaims) === JSON.stringify(previous.claims);
      const sameCustom =
        JSON.stringify(input.customItems ?? previous.customItems ?? []) ===
        JSON.stringify(previous.customItems || []);
      if (
        !Object.keys(attendance).length &&
        (!own || (sameClaims && sameCustom))
      )
        continue;
      result = store.saveResponse(
        current,
        { ...session, guest: party.guest },
        {
          version: own ? input.version : input.partyVersions?.[party.guest],
          attendance,
          claims: own ? input.claims : previous.claims,
          customItems: own ? input.customItems : previous.customItems,
        },
        { partial: true },
      );
    }
    return result || { ok: true };
  });
}

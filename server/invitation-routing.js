import { centralPerson, membership } from "./central-membership.js";
import { fail } from "./model.js";
import { guestRelations } from "./guest-identities.js";
import {
  privateIdentity,
  personalAccount,
  recipientBlocked,
} from "./personal-accounts.js";
import { GATHER_ORIGIN, activeHouseholdLabel } from "./passwordless.js";
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

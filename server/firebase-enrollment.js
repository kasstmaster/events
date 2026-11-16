import { id, fail } from "./model.js";
import { identityFor, compareName } from "./guest-identities.js";
import {
  personalAccount,
  profileForIdentity,
  registeredMethod,
  recipientBlocked,
  ensurePersonalProfile,
} from "./personal-accounts.js";
import { accessFor } from "./guest-access.js";
import { subjects, subjectByKey, passwordlessContact } from "./passwordless.js";
import { recoveryEnrollment } from "./account-recovery.js";
const P = "platform";
export function firebaseEnroll(store, context) {
  if (context.input.recovery) return recoveryEnrollment(store, context);
  const { row, claim, subject, session } = context;
  if (subject && passwordlessContact(store, subject)) return subject;
  // Approved household registration already issued this owner a password-authenticated
  // session. It authorizes enrollment of only their own previously unverified profile.
  if (
    session?.role === "host" &&
    store.one(
      "SELECT id FROM users WHERE id=? AND household=? AND role='host'",
      session.user,
      session.household,
    )
  ) {
    const ready = ensurePersonalProfile(store, session),
      account = personalAccount(store, ready.identity);
    const old = store.get("guest-auth-contact", ready.identity, P);
    if (old?.verified || account?.recoveryVerified)
      fail(401, "Use Recover Account.");
    if (
      subjects(store).some(
        (s) => s.identity !== ready.identity && s.phone === claim.phone,
      )
    )
      fail(401, "Use Recover Account.");
    const p = ready.profile;
    store.put(
      "personal-household",
      p.id,
      P,
      {
        ...p,
        members: p.members.map((m) =>
          m.identity === ready.identity
            ? { ...m, first: row.first, last: row.last, phone: claim.phone }
            : m,
        ),
      },
      p.version,
    );
    store.put(
      "guest-auth-contact",
      ready.identity,
      P,
      {
        phone: claim.phone,
        verified: true,
        source: "firebase-owner-enrollment",
        verifiedAt: Date.now(),
      },
      old?.version,
    );
    return subjectByKey(store, "user:" + session.user);
  }
  const reference = store.get("rsvp-reference", row.invitation, P),
    event =
      reference && store.get("event", reference.event, reference.household);
  if (
    !event ||
    store.one(
      "SELECT household FROM household_deletions WHERE household=?",
      reference.household,
    )
  )
    return null;
  const matches = reference.guests
    .map((g) => store.get("guest", g, reference.household))
    .filter(
      (g) =>
        g &&
        !g.parent &&
        event.invited.includes(g.id) &&
        g.phone === claim.phone &&
        compareName(g.first) === compareName(row.first) &&
        compareName(g.last) === compareName(row.last) &&
        !recipientBlocked(store, reference.household, g.id),
    );
  if (matches.length !== 1) return null;
  const guest = matches[0],
    identity = identityFor(store, guest, reference.household).id;
  // QR + verified phone can enroll a new invited person, never claim an existing
  // registered profile, merge identities, copy another adult or grant host rights.
  if (
    personalAccount(store, identity) ||
    profileForIdentity(store, identity) ||
    registeredMethod(store, identity) ||
    subjects(store).some((s) => s.phone === claim.phone)
  )
    return null;
  const profile = id(),
    member = id();
  store.put("person-account", identity, P, {
    recoveryPhone: claim.phone,
    recoveryVerified: true,
    firebaseEnrolled: true,
  });
  store.put("personal-member", identity, P, { profile, member });
  store.put("personal-household", profile, P, {
    name: [row.last, "Household"].filter(Boolean).join(" "),
    publicCode: accessFor(store, guest, reference.household).code,
    sourceHousehold: reference.household,
    initialized: true,
    sharing: "selected",
    recipients: [],
    blocked: [],
    physical: {},
    mailing: {},
    mailingSame: false,
    members: [
      {
        id: member,
        identity,
        first: row.first,
        last: row.last,
        suffix: guest.suffix || "",
        phone: claim.phone,
        parent: "",
      },
    ],
  });
  store.put("managed-contact", guest.id, reference.household, {
    profile,
    member,
    address: guest.address || "",
  });
  return subjectByKey(store, "person:" + identity);
}

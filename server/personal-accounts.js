import { revokeGuestDevices } from "./guest-auth.js";
import { createHash, randomInt } from "node:crypto";
import { id, text, fail, normalizeName } from "./model.js";
import {
  identityFor,
  guestRelations,
  compareName,
  invitationsForIdentity,
} from "./guest-identities.js";
import { accessFor, accessCandidates } from "./guest-access.js";
import { saveAddressResponse } from "./address-rsvp.js";
import { addressInput } from "./addresses.js";
import { contactPhone } from "./features.js";
import { smsEnabled, sendText } from "./sms-provider.js";
const PLATFORM = "platform";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const normalizedAddress = (value) =>
  String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
const nameOf = (p) => [p.first, p.last, p.suffix].filter(Boolean).join(" ");
export function personalAccount(store, identity) {
  return store.get("person-account", identity, PLATFORM);
}
export function registeredMethod(store, identity) {
  const a = personalAccount(store, identity);
  return a?.hostUser
    ? "email"
    : store.get("guest-auth-activation", identity, PLATFORM)
      ? "private"
      : a?.username
        ? "username"
        : null;
}
export function privateIdentity(store, session) {
  if (session?.role === "guest") {
    const proof = store.one(
      "SELECT identity FROM guest_identity_sessions WHERE token=?",
      session.token,
    );
    if (!proof) fail(401, "Please sign in again.");
    return proof.identity;
  }
  if (session?.role !== "host") fail(403, "A household account is required.");
  let link = store.get("host-person", session.user, session.household);
  if (!link)
    store.transaction(() => {
      link = store.get("host-person", session.user, session.household);
      if (link) return;
      const identity = id();
      store.put("guest-identity", identity, PLATFORM, {
        creator: session.household,
        revision: 1,
      });
      link = store.put("host-person", session.user, session.household, {
        identity,
      });
      store.put("person-account", identity, PLATFORM, {
        hostUser: session.user,
        hostHousehold: session.household,
      });
    });
  return link.identity;
}
function membership(store, identity) {
  return store.get("personal-member", identity, PLATFORM);
}
export function profileForIdentity(store, identity) {
  const link = membership(store, identity);
  return link && store.get("personal-household", link.profile, PLATFORM);
}
export function ensurePersonalProfile(store, session) {
  const identity = privateIdentity(store, session),
    previous = profileForIdentity(store, identity);
  if (previous) return { identity, profile: previous };
  return store.transaction(() => {
    const existing = profileForIdentity(store, identity);
    if (existing) return { identity, profile: existing };
    const profileId = id();
    let people = [],
      name = "",
      mailing = {},
      publicCode = "";
    if (session.role === "guest") {
      const own = store.get("guest", session.guest, session.household);
      if (!own || own.parent)
        fail(403, "An adult household account is required.");
      const address =
        own.address && store.get("address", own.address, session.household);
      people = store
        .list("guest", session.household)
        .filter((g) =>
          address
            ? g.address === address.id
            : g.id === own.id || g.parent === own.id,
        );
      name =
        address?.label || [own.last, "Household"].filter(Boolean).join(" ");
      mailing = address
        ? Object.fromEntries(
            ["street", "city", "state", "zip", "lines"].map((key) => [
              key,
              address[key] || "",
            ]),
          )
        : {};
      publicCode = accessFor(store, own, session.household).code;
    } else {
      const household = store.household(session.household);
      name = household.name;
      const reserved = new Set(
        store.list("personal-household", PLATFORM).map((p) => p.publicCode),
      );
      if (reserved.size >= 10000)
        fail(409, "Household ID capacity has been reached.");
      do {
        publicCode = String(randomInt(0, 10000)).padStart(4, "0");
      } while (reserved.has(publicCode));
      const owner = store.one(
        "SELECT * FROM family_members WHERE id=? AND household=?",
        session.user,
        session.household,
      );
      const display = owner?.name || household.name;
      people = [
        { id: session.user, first: display, last: "", phone: "", parent: "" },
      ];
    }
    const personalIds = new Map(people.map((p) => [p.id, id()]));
    const members = people
      .map((p) => {
        const personIdentity =
          session.role === "host"
            ? identity
            : identityFor(store, p, session.household).id;
        const existingMember = membership(store, personIdentity);
        // A proven identity already managed by another household is never moved by an inviter.
        const parentIdentity = p.parent
          ? identityFor(
              store,
              people.find((adult) => adult.id === p.parent),
              session.household,
            ).id
          : null;
        const parentMembership =
          parentIdentity && membership(store, parentIdentity);
        if (
          existingMember ||
          (parentMembership && parentMembership.profile !== profileId)
        )
          return null;
        store.put("personal-member", personIdentity, PLATFORM, {
          profile: profileId,
          member: personalIds.get(p.id),
        });
        if (session.role === "guest")
          store.put("managed-contact", p.id, session.household, {
            profile: profileId,
            member: personalIds.get(p.id),
            address: p.address || "",
          });
        return {
          id: personalIds.get(p.id),
          identity: personIdentity,
          first: p.first,
          last: p.parent ? "" : p.last || "",
          suffix: p.parent ? "" : p.suffix || "",
          phone: p.parent ? "" : p.phone || "",
          parent: p.parent ? personalIds.get(p.parent) || "" : "",
        };
      })
      .filter(Boolean);
    const profile = store.put("personal-household", profileId, PLATFORM, {
      name,
      publicCode,
      sourceHousehold: session.household,
      initialized: true,
      sharing: "selected",
      recipients: [],
      blocked: [],
      physical: addressInput({ label: name, lines: "" }),
      mailing: addressInput({ ...mailing, label: name }),
      mailingSame: false,
      members,
    });
    return { identity, profile };
  });
}
export function accountProjection(store, session) {
  const { identity, profile } = ensurePersonalProfile(store, session),
    account = personalAccount(store, identity);
  const member = profile.members.find((p) => p.identity === identity);
  return {
    profile: {
      ...profile,
      members: profile.members.map(({ identity, ...p }) => p),
    },
    self: member?.id,
    person: {
      first: member?.first || "",
      last: member?.last || "",
      name: nameOf(member || {}),
    },
    account: {
      version: account?.version || 0,
      method: account?.hostUser ? "email" : "username",
      email: account?.hostUser
        ? store.one("SELECT email FROM users WHERE id=?", account.hostUser)
            ?.email || ""
        : "",
      username: account?.username || "",
      recoveryPhone: account?.recoveryPhone || "",
      recoveryVerified: account?.recoveryVerified === true,
      needsUsername:
        session.role === "guest" && !account?.username && !account?.hostUser,
      householdId:
        session.role === "guest"
          ? accessFor(
              store,
              store.get("guest", session.guest, session.household),
              session.household,
            ).code
          : profile.publicCode,
    },
    contacts: personalContacts(store, identity),
  };
}
function hostedHouseholds(store, profile) {
  return profile.members
    .map((p) => personalAccount(store, p.identity)?.hostHousehold)
    .filter(
      (h) =>
        h &&
        !store.one(
          "SELECT household FROM household_deletions WHERE household=?",
          h,
        ),
    );
}
function hostProfile(store, household) {
  if (
    store.one(
      "SELECT household FROM household_deletions WHERE household=?",
      household,
    )
  )
    return null;
  const owner = store.one(
    "SELECT id FROM users WHERE household=? AND role='host'",
    household,
  );
  const link = owner && store.get("host-person", owner.id, household);
  return link && profileForIdentity(store, link.identity);
}
function recipientKeys(store, key) {
  return [key, hostProfile(store, key)?.id].filter(Boolean);
}
function recipientHouseholds(store, profile) {
  const result = new Set();
  for (const member of profile.members)
    for (const relation of guestRelations(store, member.identity))
      result.add(relation.household);
  for (const edge of store
    .list("personal-contact", profile.id)
    .filter((e) => !e.removed)) {
    const other = store.get("personal-household", edge.profile, PLATFORM);
    if (other)
      for (const household of hostedHouseholds(store, other))
        result.add(household);
  }
  return result;
}
export function recipientBlocked(store, household, guest) {
  const link = store.one(
    "SELECT identity FROM guest_identity_links WHERE household=? AND guest=?",
    household,
    guest,
  );
  const managed = store.get("managed-contact", guest, household);
  const profile = managed
    ? store.get("personal-household", managed.profile, PLATFORM)
    : link && profileForIdentity(store, link.identity);
  return (
    !!profile &&
    recipientKeys(store, household).some((key) => profile.blocked.includes(key))
  );
}
export function personalContacts(store, identity) {
  const profile = profileForIdentity(store, identity);
  if (!profile) return [];
  const hosts = [...recipientHouseholds(store, profile)]
    .filter(
      (h) =>
        !recipientKeys(store, h).some(
          (key) => store.get("personal-contact", key, profile.id)?.removed,
        ),
    )
    .map((household) => ({
      id: household,
      kind: "host",
      name: store.household(household)?.name || "Household",
      blocked: recipientKeys(store, household).some((key) =>
        profile.blocked.includes(key),
      ),
      selected: recipientKeys(store, household).some((key) =>
        profile.recipients.includes(key),
      ),
    }));
  const edges = store.list("personal-contact", profile.id);
  for (const edge of edges) {
    const other = store.get("personal-household", edge.profile, PLATFORM);
    if (
      other &&
      !edge.removed &&
      !hostedHouseholds(store, other).some((h) =>
        hosts.some((contact) => contact.id === h),
      )
    )
      hosts.push({
        id: other.id,
        kind: "personal",
        name: other.name,
        blocked: profile.blocked.includes(other.id),
        selected: profile.recipients.includes(other.id),
      });
  }
  return hosts.map((contact) => {
    let other;
    if (contact.kind === "personal")
      other = store.get("personal-household", contact.id, PLATFORM);
    else {
      const owner = store.one(
        "SELECT id FROM users WHERE household=? AND role='host'",
        contact.id,
      );
      const link = owner && store.get("host-person", owner.id, contact.id);
      other = link && profileForIdentity(store, link.identity);
    }
    if (
      !other ||
      contact.blocked ||
      !approved(other, profile.id, store) ||
      hostedHouseholds(store, profile).some((h) =>
        recipientKeys(store, h).some((key) => other.blocked.includes(key)),
      )
    )
      return contact;
    const address = other.mailingSame ? other.physical : other.mailing;
    return {
      ...contact,
      address: address.lines,
      members: other.members
        .filter((p) => !p.archived)
        .toSorted((a, b) => Number(!!a.parent) - Number(!!b.parent))
        .map((p) => ({
          first: p.first,
          last: p.parent ? "" : p.last,
          suffix: p.parent ? "" : p.suffix,
          child: !!p.parent,
          phone: p.parent ? "" : p.phone,
        })),
    };
  });
}
function approved(profile, household, store) {
  const keys = recipientKeys(store, household);
  return (
    !keys.some((key) => profile.blocked.includes(key)) &&
    (profile.sharing === "everyone" ||
      keys.some((key) => profile.recipients.includes(key)))
  );
}
export function propagatePersonalProfile(store, profile) {
  const mailing = profile.mailingSame ? profile.physical : profile.mailing;
  for (const person of profile.members.filter((p) => !p.archived)) {
    for (const relation of guestRelationsIncludingChildren(
      store,
      person.identity,
    )) {
      if (!approved(profile, relation.household, store)) continue;
      const guest = relation.record;
      const next = {
        ...guest,
        first: person.first,
        ...(!guest.parent
          ? {
              last: person.last,
              suffix: person.suffix,
              phone: person.phone,
              ...(person.phone !== guest.phone
                ? { smsConsent: false, consentRecorded: null }
                : {}),
            }
          : {}),
      };
      if (JSON.stringify(next) !== JSON.stringify(guest))
        store.put("guest", guest.id, relation.household, next, guest.version);
      const managed = store.get(
        "managed-contact",
        guest.id,
        relation.household,
      );
      const address =
        guest.address &&
        store.get("address", guest.address, relation.household);
      if (
        address &&
        mailing.lines &&
        (!managed || managed.address === guest.address)
      ) {
        const fields = addressInput({ ...mailing, label: profile.name });
        if (
          ["label", "lines", "street", "city", "state", "zip"].some(
            (k) => address[k] !== fields[k],
          )
        )
          store.put(
            "address",
            address.id,
            relation.household,
            {
              ...address,
              ...fields,
              notes: address.notes || "",
              phone: address.phone || "",
            },
            address.version,
          );
      }
    }
  }
  // New family entries are added only to recipients with an established address relationship.
  for (const household of recipientHouseholds(store, profile)) {
    if (!approved(profile, household, store)) continue;
    const anchors = store
      .list("managed-contact", household)
      .filter((m) => m.profile === profile.id);
    let address = anchors
      .map((m) => store.get("guest", m.id, household))
      .find((g) => g?.address)?.address;
    if (
      !address &&
      !profile.members.some((p) =>
        guestRelationsIncludingChildren(store, p.identity).some(
          (r) => r.household === household,
        ),
      )
    ) {
      address = store.put("address", id(), household, {
        ...addressInput({ ...mailing, label: profile.name }),
        notes: "",
        phone: "",
      }).id;
    }
    if (!address) continue;
    const local = new Map(
      store
        .all(
          "SELECT identity,guest FROM guest_identity_links WHERE household=?",
          household,
        )
        .map((r) => [r.identity, r.guest]),
    );
    for (const p of profile.members
      .filter((p) => !p.archived)
      .sort((a, b) => Number(!!a.parent) - Number(!!b.parent))) {
      if (local.has(p.identity)) continue;
      const parent = p.parent
        ? local.get(profile.members.find((m) => m.id === p.parent)?.identity)
        : "";
      if (p.parent && !parent) continue;
      const key = id(),
        guest = store.put("guest", key, household, {
          first: p.first,
          last: p.parent ? "" : p.last,
          suffix: p.suffix || "",
          phone: p.parent ? "" : p.phone,
          parent: parent || "",
          address,
          notes: "",
          position: Date.now(),
          smsConsent: false,
        });
      store.run(
        "INSERT INTO guest_identity_links(household,guest,identity,linked) VALUES(?,?,?,1)",
        household,
        key,
        p.identity,
      );
      store.put("managed-contact", key, household, {
        profile: profile.id,
        member: p.id,
        address,
      });
      accessFor(store, guest, household);
      local.set(p.identity, key);
    }
  }
}
function guestRelationsIncludingChildren(store, identity) {
  return store
    .all(
      "SELECT household,guest FROM guest_identity_links WHERE identity=?",
      identity,
    )
    .filter(
      (r) =>
        !store.one(
          "SELECT household FROM household_deletions WHERE household=?",
          r.household,
        ),
    )
    .map((r) => ({ ...r, record: store.get("guest", r.guest, r.household) }))
    .filter(
      (r) =>
        r.record &&
        !store.one(
          "SELECT household FROM household_deletions WHERE household=?",
          r.household,
        ),
    );
}
export function autoAssociateContact(store, guest, household) {
  if (store.get("managed-contact", guest.id, household)) return;
  const address =
    guest.address && store.get("address", guest.address, household);
  const matches = [];
  for (const profile of store.list("personal-household", PLATFORM)) {
    if (
      recipientKeys(store, household).some((key) =>
        profile.blocked.includes(key),
      )
    )
      continue;
    const mailing = profile.mailingSame ? profile.physical : profile.mailing;
    for (const p of profile.members) {
      if (
        p.archived ||
        !!p.parent !== !!guest.parent ||
        compareName(nameOf(p)) !==
          compareName(
            nameOf({ ...guest, last: guest.parent ? "" : guest.last }),
          )
      )
        continue;
      if (
        !(
          (guest.phone && p.phone === guest.phone) ||
          (address?.lines &&
            normalizedAddress(address.lines) ===
              normalizedAddress(mailing.lines)) ||
          (address?.lines &&
            normalizedAddress(address.lines) ===
              normalizedAddress(profile.physical.lines))
        )
      )
        continue;
      if (p.parent) {
        const parentIdentity = profile.members.find(
          (member) => member.id === p.parent,
        )?.identity;
        const localParent = store.one(
          "SELECT identity FROM guest_identity_links WHERE household=? AND guest=?",
          household,
          guest.parent,
        );
        if (!parentIdentity || localParent?.identity !== parentIdentity)
          continue;
      }
      // Registered accounts require their private registered method; host-created codes cannot impersonate them.
      if (!p.parent && !registeredMethod(store, p.identity)) continue;
      matches.push({ profile, p });
    }
  }
  if (matches.length !== 1) return;
  const { profile, p } = matches[0];
  const prior = store.one(
    "SELECT identity FROM guest_identity_links WHERE household=? AND guest=?",
    household,
    guest.id,
  );
  if (
    prior &&
    prior.identity !== p.identity &&
    (personalAccount(store, prior.identity) ||
      profileForIdentity(store, prior.identity))
  )
    return;
  store.put("managed-contact", guest.id, household, {
    profile: profile.id,
    member: p.id,
    address: guest.address,
  });
  if (prior && prior.identity !== p.identity) {
    const position =
      (store.one(
        "SELECT max(position) AS value FROM guest_identity_history WHERE household=? AND guest=?",
        household,
        guest.id,
      )?.value || 0) + 1;
    const old = store.one(
      "SELECT identity,linked FROM guest_identity_links WHERE household=? AND guest=?",
      household,
      guest.id,
    );
    store.run(
      "INSERT INTO guest_identity_history VALUES(?,?,?,?,?)",
      household,
      guest.id,
      position,
      old.identity,
      old.linked,
    );
    store.run(
      "UPDATE guest_identity_links SET identity=?,linked=1 WHERE household=? AND guest=?",
      p.identity,
      household,
      guest.id,
    );
    store.run(
      "DELETE FROM sessions WHERE household=? AND guest=?",
      household,
      guest.id,
    );
  }
}
export function authenticateUsername(store, username, code) {
  const value = String(username || "")
    .trim()
    .toLowerCase();
  const row = store.one(
    "SELECT id FROM records WHERE kind='person-account' AND household='platform' AND json_extract(body,'$.usernameHash')=?",
    hash(value),
  );
  if (!row) return null;
  const account = personalAccount(store, row.id);
  if (store.get("guest-auth-activation", row.id, PLATFORM))
    fail(401, "Use your private sign-in link and verify your phone.");
  const relation = accessCandidates(store, String(code || "")).find(
    (r) =>
      !r.record.parent &&
      store.one(
        "SELECT identity FROM guest_identity_links WHERE household=? AND guest=?",
        r.household,
        r.guest,
      )?.identity === row.id &&
      !recipientBlocked(store, r.household, r.guest),
  );
  if (relation && account?.hostUser)
    fail(401, "Use your registered email and password.");
  return relation
    ? { identity: store.get("guest-identity", row.id, PLATFORM), relation }
    : null;
}
function revokeOtherSessions(store, identity, keep) {
  for (const row of store.all(
    "SELECT token FROM guest_identity_sessions WHERE identity=? AND token<>?",
    identity,
    keep || "",
  ))
    store.run("DELETE FROM sessions WHERE token=?", row.token);
  store.run(
    "DELETE FROM guest_identity_sessions WHERE token NOT IN (SELECT token FROM sessions)",
  );
}
function savePrivateAccount(store, session, input, expected) {
  const { identity } = ensurePersonalProfile(store, session),
    previous = personalAccount(store, identity);
  if (previous?.hostUser)
    fail(403, "Use your registered host email and password.");
  if ((previous?.version || 0) !== expected)
    fail(409, "Account changed. Refresh before trying again.");
  const username = text(input.username, 80, true).toLowerCase();
  if (!/^[a-z0-9_.-]{3,80}$/.test(username))
    fail(400, "Use a unique username with at least three characters.");
  const usernameHash = hash(username),
    existing = store.one(
      "SELECT id FROM records WHERE kind='person-account' AND household='platform' AND json_extract(body,'$.usernameHash')=?",
      usernameHash,
    );
  if (existing && existing.id !== identity)
    fail(409, "Choose another username.");
  const recoveryPhone = contactPhone(input.recoveryPhone);
  if (!recoveryPhone) fail(400, "Add a recovery phone number.");
  const next = store.put(
    "person-account",
    identity,
    PLATFORM,
    {
      ...previous,
      username,
      usernameHash,
      recoveryPhone,
      recoveryVerified:
        previous?.recoveryPhone === recoveryPhone &&
        previous.recoveryVerified === true,
    },
    previous?.version,
  );
  if (previous?.recoveryPhone !== recoveryPhone) {
    const contact = store.get("guest-auth-contact", identity, PLATFORM);
    if (contact)
      store.remove("guest-auth-contact", identity, PLATFORM, contact.version);
    revokeGuestDevices(store, identity, session.token);
    const pending = store.get("phone-verification", identity, PLATFORM);
    if (pending)
      store.put(
        "phone-verification",
        identity,
        PLATFORM,
        { ...pending, state: "cancelled", message: "", codeHash: "" },
        pending.version,
      );
  }
  revokeOtherSessions(store, identity, session.token);
  return next;
}
export function savePersonalProfile(store, session, input, expected) {
  return store.transaction(() => {
    const { identity, profile } = ensurePersonalProfile(store, session);
    if (profile.version !== expected)
      fail(409, "Family information changed. Refresh before trying again.");
    if (
      !["everyone", "selected"].includes(input.sharing) ||
      !Array.isArray(input.members) ||
      input.members.length > 200
    )
      fail(400, "Check household information.");
    const name = profile.name;
    const physical = addressInput({ ...input.physical, label: name }),
      mailing = addressInput({ ...input.mailing, label: name });
    const known = new Map(profile.members.map((m) => [m.id, m])),
      ids = new Set();
    const members = input.members.map((p) => {
      const key = p.id || id();
      if (ids.has(key)) fail(400, "Duplicate family member.");
      ids.add(key);
      const old = known.get(key);
      if (p.id && !old && !/^[a-f0-9-]{36}$/.test(p.id))
        fail(400, "Invalid family member.");
      if (
        old &&
        old.identity !== identity &&
        registeredMethod(store, old.identity) &&
        ["first", "last", "suffix", "phone", "parent"].some(
          (key) => String(p[key] || "") !== String(old[key] || ""),
        )
      )
        fail(
          403,
          "Another registered adult must update their own account information.",
        );
      let personIdentity = old?.identity;
      if (!personIdentity) {
        personIdentity = id();
        store.put("guest-identity", personIdentity, PLATFORM, {
          creator: profile.sourceHousehold,
          revision: 1,
        });
        store.put("personal-member", personIdentity, PLATFORM, {
          profile: profile.id,
          member: key,
        });
      }
      return {
        id: key,
        identity: personIdentity,
        first: text(p.first, 80, true),
        last: p.parent ? old?.last || "" : text(p.last || "", 80),
        suffix: p.parent ? "" : text(p.suffix || "", 30),
        phone: p.parent ? "" : contactPhone(p.phone || ""),
        parent: text(p.parent || "", 100),
      };
    });
    if (!members.some((m) => m.identity === identity && !m.parent))
      fail(400, "Keep your own adult family entry.");
    for (const p of members)
      if (p.parent && !members.some((a) => a.id === p.parent && !a.parent))
        fail(400, "Choose a designated adult.");
    // Omitted entries retain stable identities and existing relationships; removal is an explicit archive.
    for (const old of profile.members)
      if (!ids.has(old.id)) {
        if (old.identity !== identity && registeredMethod(store, old.identity))
          fail(
            403,
            "Another registered adult controls their own account information.",
          );
        members.push({ ...old, archived: true });
      }
    const allowed = new Set(
      personalContacts(store, identity).flatMap((c) =>
        recipientKeys(store, c.id),
      ),
    );
    const recipients = (input.recipients || []).map((v) => text(v, 100));
    if (recipients.length > 10000 || recipients.some((v) => !allowed.has(v)))
      fail(400, "Choose your contacts for information sharing.");
    const next = store.put(
      "personal-household",
      profile.id,
      PLATFORM,
      {
        ...profile,
        physical,
        mailing,
        mailingSame: input.mailingSame === true,
        members,
        sharing: input.sharing,
        recipients: [...new Set(recipients)],
      },
      profile.version,
    );
    propagatePersonalProfile(store, next);
    return accountProjection(store, session);
  });
}
export function startRecovery(store, env, phone, { now = Date.now } = {}) {
  phone = contactPhone(phone);
  store.limit("username-recovery:" + hash(phone), 3, 24 * 3600000);
  if (!smsEnabled(env))
    fail(503, "Username recovery texting is not configured.");
  const accounts = store
    .list("person-account", PLATFORM)
    .filter(
      (a) =>
        !a.hostUser &&
        a.recoveryPhone === phone &&
        a.recoveryVerified &&
        a.username,
    );
  if (accounts.length) {
    const previous = store.get("username-recovery", hash(phone), PLATFORM);
    store.put(
      "username-recovery",
      hash(phone),
      PLATFORM,
      {
        phone,
        accounts: accounts.map((a) => a.id),
        expires: now() + 10 * 60000,
        state: "queued",
        message:
          "Someone requested a Gather username reminder. Reply YES to receive it, or NO to cancel.",
      },
      previous?.version,
    );
  }
  return { ok: true };
}
export function processAccountReply(store, params) {
  const phone = String(params.get?.("From") || params.From || ""),
    action = String(params.get?.("Body") || params.Body || "")
      .trim()
      .toUpperCase();
  const record = store.get("username-recovery", hash(phone), PLATFORM);
  if (
    !record ||
    record.expires < Date.now() ||
    record.state !== "awaiting" ||
    !["YES", "NO"].includes(action)
  )
    return;
  if (action === "NO") {
    store.put(
      "username-recovery",
      record.id,
      PLATFORM,
      { ...record, state: "cancelled" },
      record.version,
    );
    return;
  }
  const names = record.accounts
    .map((key) => personalAccount(store, key))
    .filter(
      (a) => !a?.hostUser && a?.recoveryVerified && a.recoveryPhone === phone,
    )
    .map((a) => a.username);
  store.put(
    "username-recovery",
    record.id,
    PLATFORM,
    {
      ...record,
      state: names.length ? "username-queued" : "cancelled",
      message:
        "Your Gather username" +
        (names.length === 1 ? ": " : "s: ") +
        names.join(", "),
    },
    record.version,
  );
}
export async function runAccountMessages(store, env, { fetcher = fetch } = {}) {
  if (!smsEnabled(env)) return;
  for (const kind of ["username-recovery", "phone-verification"])
    for (const pending of store.list(kind, PLATFORM)) {
      if (
        !["queued", "username-queued"].includes(pending.state) ||
        pending.expires < Date.now()
      )
        continue;
      const claimed = store.transaction(() => {
        const record = store.get(kind, pending.id, PLATFORM);
        if (
          record.version !== pending.version ||
          store.one("SELECT phone FROM sms_optouts WHERE phone=?", record.phone)
        )
          return null;
        return store.put(
          kind,
          record.id,
          PLATFORM,
          { ...record, state: "sending" },
          record.version,
        );
      });
      if (!claimed) continue;
      const result = await sendText(
        env,
        claimed.phone,
        claimed.message,
        fetcher,
      );
      const current = store.get(kind, claimed.id, PLATFORM);
      if (
        !current ||
        current.version !== claimed.version ||
        current.state !== "sending"
      )
        continue;
      store.put(
        kind,
        current.id,
        PLATFORM,
        {
          ...current,
          state:
            result.status === "accepted" && pending.state === "queued"
              ? "awaiting"
              : result.status,
        },
        current.version,
      );
    }
}
export async function personalAPI({
  path,
  method,
  req,
  res,
  store,
  session,
  body,
  version,
  json,
  env,
}) {
  if (!path.startsWith("/api/personal")) return false;
  if (!["guest", "host"].includes(session?.role))
    fail(403, "A household account is required.");
  const { identity, profile } = ensurePersonalProfile(store, session);
  const rsvp = path.match(/^\/api\/personal\/events\/([a-zA-Z0-9-]+)\/rsvp$/);
  if (rsvp && method === "PUT") {
    const input = await body(req);
    const relation = invitationsForIdentity(store, identity).relations.find(
      (r) =>
        r.guest === input.guestEntry &&
        store.get("event", rsvp[1], r.household)?.invited.includes(r.guest),
    );
    if (!relation) fail(404, "Event not found.");
    json(
      res,
      saveAddressResponse(
        store,
        store.get("event", rsvp[1], relation.household),
        relation,
        input,
        env,
      ),
    );
    return true;
  }
  if (path === "/api/personal" && method === "GET") {
    json(res, accountProjection(store, session));
    return true;
  }
  if (path === "/api/personal/account" && method === "PUT") {
    savePrivateAccount(store, session, await body(req), version(req));
    json(res, accountProjection(store, session));
    return true;
  }
  if (path === "/api/personal/family" && method === "PUT") {
    json(
      res,
      savePersonalProfile(store, session, await body(req), version(req)),
    );
    return true;
  }
  if (path === "/api/personal/phone/start" && method === "POST") {
    if (!smsEnabled(env))
      fail(503, "Phone verification texting is not configured.");
    const account = personalAccount(store, identity);
    if (!account?.recoveryPhone)
      fail(400, "Save your recovery phone number first.");
    store.limit("verify-phone:" + identity, 3, 24 * 3600000);
    const code = String(randomInt(100000, 1000000)),
      previous = store.get("phone-verification", identity, PLATFORM);
    store.put(
      "phone-verification",
      identity,
      PLATFORM,
      {
        phone: account.recoveryPhone,
        codeHash: hash(code),
        expires: Date.now() + 10 * 60000,
        state: "queued",
        message: "Your Gather recovery phone verification code is " + code,
      },
      previous?.version,
    );
    json(res, { ok: true });
    return true;
  }
  if (path === "/api/personal/phone/verify" && method === "POST") {
    store.limit("verify-code:" + identity, 5, 10 * 60000);
    const input = await body(req),
      challenge = store.get("phone-verification", identity, PLATFORM),
      account = personalAccount(store, identity);
    if (
      !challenge ||
      challenge.state === "complete" ||
      challenge.expires < Date.now() ||
      challenge.phone !== account?.recoveryPhone ||
      challenge.codeHash !== hash(String(input.code || ""))
    )
      fail(400, "The verification code is invalid or expired.");
    store.put(
      "person-account",
      identity,
      PLATFORM,
      { ...account, recoveryVerified: true },
      account.version,
    );
    store.put(
      "phone-verification",
      identity,
      PLATFORM,
      { ...challenge, state: "complete", codeHash: "", message: "" },
      challenge.version,
    );
    json(res, { ok: true });
    return true;
  }
  const contact = path.match(/^\/api\/personal\/contacts\/([a-zA-Z0-9-]+)$/);
  if (contact && method === "PUT") {
    const input = await body(req),
      allowed = personalContacts(store, identity).some(
        (c) => c.id === contact[1],
      );
    if (!allowed) fail(404, "Contact not found.");
    const current = store.get("personal-household", profile.id, PLATFORM);
    if (current.version !== version(req))
      fail(409, "Contacts changed. Refresh first.");
    const blocked = new Set(current.blocked);
    if (input.blocked === true) blocked.add(contact[1]);
    else
      for (const key of recipientKeys(store, contact[1])) blocked.delete(key);
    store.put(
      "personal-household",
      profile.id,
      PLATFORM,
      { ...current, blocked: [...blocked] },
      current.version,
    );
    if (input.remove === true) {
      for (const key of recipientKeys(store, contact[1])) {
        const previous = store.get("personal-contact", key, profile.id);
        store.put(
          "personal-contact",
          key,
          profile.id,
          { profile: key, removed: true },
          previous?.version,
        );
      }
    }
    json(res, accountProjection(store, session));
    return true;
  }
  if (path === "/api/personal/contacts" && method === "POST") {
    store.limit("personal-contact-add:" + identity, 10, 3600000);
    const input = await body(req),
      name = compareName(text(input.name, 100, true)),
      code = text(input.householdId, 4, true);
    if (!/^\d{4}$/.test(code)) fail(400, "Enter the four-digit Household ID.");
    const matches = store
      .list("personal-household", PLATFORM)
      .filter(
        (p) =>
          p.id !== profile.id &&
          ((hostedHouseholds(store, p).length && p.publicCode === code) ||
            p.members.some((member) =>
              guestRelationsIncludingChildren(store, member.identity).some(
                (r) =>
                  !r.record.parent &&
                  accessFor(store, r.record, r.household).code === code,
              ),
            )) &&
          compareName(p.name) === name &&
          !p.blocked.includes(profile.id),
      );
    if (matches.length !== 1)
      fail(404, "No unique household matches these details.");
    const other = matches[0];
    store.transaction(() => {
      for (const [owner, target] of [
        [profile, other],
        [other, profile],
      ]) {
        const old = store.get("personal-contact", target.id, owner.id);
        store.put(
          "personal-contact",
          target.id,
          owner.id,
          { profile: target.id, removed: false },
          old?.version,
        );
      }
    });
    json(res, accountProjection(store, session));
    return true;
  }
  fail(404, "Page not found.");
}

export function renamePersonalHousehold(store, household, name) {
  const profile = hostProfile(store, household);
  if (!profile || profile.name === name) return;
  const next = store.put(
    "personal-household",
    profile.id,
    PLATFORM,
    { ...profile, name },
    profile.version,
  );
  propagatePersonalProfile(store, next);
}
export function initializeHostPersonal(store, host, input = {}) {
  if (!input.existingUsername && !input.existingHouseholdId) return;
  const proof = authenticateUsername(
    store,
    input.existingUsername,
    input.existingHouseholdId,
  );
  if (!proof)
    fail(
      400,
      "Use the existing username and Household ID to link your account.",
    );
  const account = personalAccount(store, proof.identity.id);
  const profile = profileForIdentity(store, proof.identity.id);
  if (
    profile &&
    hostedHouseholds(store, profile).some((h) => h !== host.household)
  )
    fail(
      409,
      "This household already has a host sign-in. Use its existing family accounts.",
    );
  if (account.hostUser && account.hostUser !== host.user)
    fail(409, "This account already has a host sign-in.");
  store.put("host-person", host.user, host.household, {
    identity: proof.identity.id,
  });
  store.put(
    "person-account",
    account.id,
    PLATFORM,
    { ...account, hostUser: host.user, hostHousehold: host.household },
    account.version,
  );
  renamePersonalHousehold(
    store,
    host.household,
    store.household(host.household).name,
  );
}

import { id, text, fail } from "./model.js";
import { addressInput } from "./addresses.js";
import { contactPhone } from "./features.js";
import { revokeUserSessions } from "./device-sessions.js";
export function ensureHostRoster(store, household) {
  const existing = store.get(
    "host-family-roster",
    "family:" + household,
    household,
  );
  if (existing) return existing;
  const owner =
    store.one("SELECT owner FROM family_owners WHERE household=?", household)
      ?.owner ||
    store.one(
      "SELECT id FROM users WHERE household=? AND role='host'",
      household,
    )?.id;
  if (!owner) fail(404, "Host household unavailable.");
  const profile = store
    .list("personal-household", "platform")
    .find((p) => p.sourceHousehold === household);
  const link = store.get("host-person", owner, household),
    keys = new Map();
  const members = (profile?.members || []).map((m) => {
    const rsvpID =
      m.identity === link?.identity ? "family-" + owner : "person-" + m.id;
    keys.set(m.id, rsvpID);
    return {
      id: m.id,
      rsvpID,
      first: m.first,
      last: m.parent ? "" : m.last || "",
      suffix: m.suffix || "",
      phone: m.parent ? "" : m.phone || "",
      parent: m.parent || "",
      archived: !!m.archived,
      sharedAddress: "physical",
      owner: m.identity === link?.identity,
    };
  });
  if (!members.some((m) => m.owner))
    members.unshift({
      id: owner,
      rsvpID: "family-" + owner,
      first: store.household(household).name,
      last: "",
      suffix: "",
      phone: "",
      parent: "",
      owner: true,
      sharedAddress: "physical",
    });
  for (const row of store.all(
    "SELECT id,name,role,disabled FROM family_members WHERE household=?",
    household,
  )) {
    if (
      row.id === owner ||
      store.get("family-profile-member", row.id, household)
    )
      continue;
    members.push({
      id: row.id,
      rsvpID: "family-" + row.id,
      first: row.name,
      last: "",
      suffix: "",
      phone: "",
      parent: row.role === "kid" ? members.find((m) => m.owner).id : "",
      sharedAddress: "physical",
      archived: !!row.disabled,
    });
  }
  return store.put("host-family-roster", "family:" + household, household, {
    sourceHousehold: household,
    name: store.household(household).name,
    physical: profile?.physical || {},
    mailing: profile?.mailing || {},
    mailingSame: profile?.mailingSame !== false,
    sharing: "selected",
    recipients: [],
    members,
    copiedFrom: profile?.id || null,
  });
}
export function hostRosterProjection(store, session) {
  const profile = ensureHostRoster(store, session.household),
    user = store.one("SELECT email FROM users WHERE id=?", session.user);
  return {
    profile,
    self: profile.members.find((m) => m.owner)?.id,
    person: {
      name: profile.members.find((m) => m.owner)?.first || profile.name,
    },
    account: {
      method: "email",
      email: user?.email || "",
      needsUsername: false,
      householdId: session.household,
    },
    contacts: [],
  };
}
export function saveHostRoster(store, session, input, version) {
  return store.transaction(() => {
    const current = ensureHostRoster(store, session.household);
    if (current.version !== version)
      fail(409, "Family information changed. Refresh first.");
    if (!Array.isArray(input.members) || input.members.length > 200)
      fail(400, "Check family members.");
    const known = new Map(current.members.map((m) => [m.id, m])),
      used = new Set();
    const members = input.members.map((value) => {
      const key = value.id || id(),
        old = known.get(key);
      if (
        used.has(key) ||
        (!old && !/^[a-f0-9-]{36}$/.test(key)) ||
        old?.archived
      )
        fail(400, "Check family members.");
      used.add(key);
      const parent = text(value.parent || "", 100),
        sharedAddress = text(
          value.sharedAddress || old?.sharedAddress || "physical",
          100,
        );
      if (
        !["physical", "mailing"].includes(sharedAddress) &&
        !store.get("address", sharedAddress, session.household)
      )
        fail(400, "Choose a shared household address.");
      return {
        ...(old || {}),
        id: key,
        rsvpID: old?.rsvpID || "person-" + key,
        first: text(value.first, 80, true),
        last: parent ? "" : text(value.last || "", 80),
        suffix: text(value.suffix || "", 30),
        phone: parent ? "" : contactPhone(value.phone || ""),
        parent,
        sharedAddress,
        archived: false,
      };
    });
    if (
      members.some(
        (m) =>
          m.parent &&
          !members.some(
            (adult) =>
              adult.id === m.parent && !adult.parent && adult.id !== m.id,
          ),
      )
    )
      fail(400, "Choose a current adult for the shared family address.");
    if (current.members.some((m) => m.owner && !used.has(m.id)))
      fail(400, "Keep the household owner's family entry.");
    const removed = current.members.filter(
      (m) => !used.has(m.id) && !m.archived,
    );
    for (const person of removed)
      for (const link of store
        .list("family-profile-member", session.household)
        .filter((link) => link.member === person.id)) {
        store.run(
          "UPDATE family_members SET disabled=1,version=version+1 WHERE id=? AND household=?",
          link.id,
          session.household,
        );
        revokeUserSessions(store, link.id);
      }
    store.put(
      "host-family-roster",
      "family:" + session.household,
      session.household,
      {
        ...current,
        physical: addressInput({
          ...(input.physical || current.physical),
          label: current.name,
        }),
        mailing: addressInput({
          ...(input.mailing || current.mailing),
          label: current.name,
        }),
        mailingSame: input.mailingSame !== false,
        members: [
          ...members,
          ...current.members
            .filter((m) => !used.has(m.id))
            .map((m) => ({ ...m, archived: true })),
        ],
      },
      current.version,
    );
    return hostRosterProjection(store, session);
  });
}

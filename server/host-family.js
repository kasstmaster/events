// Host-only RSVP participants. These are projections of existing family/account
// records, never guest invitations or additional sign-in accounts.
export function hostFamilyMembers(store, household) {
  const host = store.one(
    "SELECT id FROM users WHERE household=? AND role='host'",
    household,
  );
  if (!host) return [];
  const assigned = store.all(
    "SELECT id,name,role,disabled FROM family_members WHERE household=? ORDER BY rowid",
    household,
  );
  const link = store.get("host-person", host.id, household);
  const membership =
    link && store.get("personal-member", link.identity, "platform");
  const profile =
    membership &&
    store.get("personal-household", membership.profile, "platform");
  const people = new Map();
  for (const member of [
    { id: host.id, name: store.household(household).name, role: "member" },
    ...assigned,
  ]) {
    const rosterLink = store.get("family-profile-member", member.id, household);
    if (rosterLink && profile && rosterLink.profile === profile.id) continue;
    if (member.disabled) {
      people.delete(member.id);
      continue;
    }
    people.set(member.id, {
      id: "family-" + member.id,
      first: member.name,
      last: "",
      suffix: "",
      parent: member.role === "kid" ? "family-" + host.id : "",
      hostFamily: true,
    });
  }
  if (profile?.sourceHousehold === household) {
    const keys = new Map(
      profile.members.map((member) => [
        member.id,
        member.identity === link.identity
          ? "family-" + host.id
          : "person-" + member.id,
      ]),
    );
    for (const member of profile.members) {
      if (member.archived) continue;
      const person = {
        id: keys.get(member.id),
        first: member.first,
        last: member.last || "",
        suffix: member.suffix || "",
        parent: member.parent
          ? keys.get(member.parent) || "family-" + host.id
          : "",
        hostFamily: true,
      };
      if (member.identity === link.identity) {
        if (people.has(host.id)) people.set(host.id, person);
      } else people.set(person.id, person);
    }
  }
  return [...people.values()].sort(
    (a, b) => Number(!!a.parent) - Number(!!b.parent),
  );
}

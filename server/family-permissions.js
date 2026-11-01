import { fail, text } from "./model.js";
export function familyMember(store, session) {
  if (!session || !["host", "family"].includes(session.role))
    fail(403, "Family access is not available.");
  const original = store.one(
    "SELECT id,email FROM users WHERE household=? AND role='host'",
    session.household,
  );
  const owner =
    store.one(
      "SELECT owner FROM family_owners WHERE household=?",
      session.household,
    )?.owner || original?.id;
  const member = store.one(
    "SELECT id,name,role,disabled FROM family_members WHERE id=? AND household=?",
    session.user,
    session.household,
  );
  if (member?.disabled || (session.role === "family" && !member))
    fail(403, "This family account is unavailable.");
  return {
    id: session.user,
    household: session.household,
    name: member?.name || original?.email || "Owner",
    role: session.user === owner ? "owner" : member?.role || "member",
  };
}
export const manager = (member) =>
  ["owner", "administrator"].includes(member.role);
export function requireManager(member) {
  if (!manager(member))
    fail(403, "A household owner or administrator is required.");
}
export function canRead(store, member, record, seen = new Set()) {
  if (!record || (record.household && record.household !== member.household))
    return false;
  if (member.role !== "kid") return true;
  if (record.type === "chore" && record.assignees?.includes(member.id))
    return true;
  if (!record.childAccess?.includes(member.id)) return false;
  if (record.folder) {
    if (seen.has(record.id)) return false;
    seen.add(record.id);
    return canRead(
      store,
      member,
      store.get("family-record", record.folder, member.household),
      seen,
    );
  }
  return true;
}
export function accessInput(store, member, input, current = {}) {
  if (!manager(member)) {
    if (
      input.childAccess !== undefined &&
      JSON.stringify(input.childAccess) !==
        JSON.stringify(current.childAccess || [])
    )
      fail(403, "Only household administrators manage child access.");
    return current.childAccess || [];
  }
  const keys = input.childAccess ?? current.childAccess ?? [];
  if (
    !Array.isArray(keys) ||
    new Set(keys).size !== keys.length ||
    keys.some(
      (key) =>
        !store.one(
          "SELECT id FROM family_members WHERE id=? AND household=? AND role='kid' AND disabled=0",
          key,
          member.household,
        ),
    )
  )
    fail(400, "Choose specific active kid accounts.");
  return keys;
}
export function familyRecord(store, member, key) {
  const record = store.get("family-record", key, member.household);
  if (!canRead(store, member, record)) fail(404, "Record not found.");
  return record;
}
export function folderInput(store, member, key, recordId) {
  const folder = text(key || "", 100);
  if (!folder) return "";
  let current = familyRecord(store, member, folder),
    seen = new Set([recordId]);
  while (current) {
    if (current.type !== "folder" || seen.has(current.id))
      fail(400, "Choose a valid folder.");
    seen.add(current.id);
    current = current.folder
      ? store.get("family-record", current.folder, member.household)
      : null;
  }
  return folder;
}

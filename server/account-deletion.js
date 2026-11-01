import { createHash } from "node:crypto";
import { fail } from "./model.js";
import { cancelReminders } from "./reminders.js";
export function deletionSummary(store, userId) {
  const user = store.one(
    "SELECT id,email,household FROM users WHERE id=? AND role='host'",
    userId,
  );
  if (!user) fail(404, "Host account not found.");
  const household = store.household(user.household);
  return {
    revision: createHash("sha256")
      .update(
        JSON.stringify(
          store.all(
            "SELECT kind,id,version FROM records WHERE household=? ORDER BY kind,id",
            user.household,
          ),
        ),
      )
      .digest("hex"),
    userId: user.id,
    email: user.email,
    household: user.household,
    name: household?.name || "",
    domain: household?.subdomain ? household.subdomain + ".ilymmd.com" : "",
    counts: Object.fromEntries(
      ["guest", "address", "event", "card", "private-template"].map((kind) => [
        kind,
        store.list(kind, user.household).length,
      ]),
    ),
    scope:
      "Permanently removes this host, their household, contacts, events, responses, notes, cards and reminders. Only verified exclusively owned routing resources are removed. Shared infrastructure and all other households remain. Retired address reservations and global SMS opt-out suppressions are retained for safety.",
  };
}
export function requestDeletion(store, userId, input) {
  return store.transaction(() => {
    const summary = deletionSummary(store, userId);
    if (
      input.confirmEmail !== summary.email ||
      input.confirmDomain !== summary.domain
    )
      fail(400, "Confirm the exact host email and affected domain.");
    const household = store.household(summary.household);
    if (
      input.householdVersion !== household?.version ||
      input.confirmRevision !== summary.revision
    )
      fail(409, "The household changed. Review the deletion summary again.");
    store.run(
      "INSERT OR IGNORE INTO household_deletions(household,user,email,label,phase) VALUES(?,?,?,?, 'pending')",
      summary.household,
      userId,
      summary.email,
      household?.subdomain || "",
    );
    store.run(
      "DELETE FROM session_origins WHERE token IN (SELECT token FROM sessions WHERE household=?)",
      summary.household,
    );
    store.run("DELETE FROM sessions WHERE household=?", summary.household);
    cancelReminders(store, summary.household);
    store.run(
      "UPDATE household_domains SET retired=1 WHERE household=?",
      summary.household,
    );
    store.run(
      "UPDATE household_routing SET phase='deleting',next_attempt=0 WHERE household=?",
      summary.household,
    );
    return { status: "pending", ...summary };
  });
}
export function finalizeDeletion(store, job) {
  store.transaction(() => {
    store.run(
      "DELETE FROM users WHERE id=? AND household=? AND role='host'",
      job.user,
      job.household,
    );
    store.run("DELETE FROM approvals WHERE email=?", job.email);
    store.run("DELETE FROM record_chunks WHERE household=?", job.household);
    store.run("DELETE FROM records WHERE household=?", job.household);
    store.run(
      "DELETE FROM reminder_deliveries WHERE household=?",
      job.household,
    );
    store.run("DELETE FROM household_routing WHERE household=?", job.household);
    // Keep retired name reservations and a minimal deletion receipt. Never release an old public address.
    store.run(
      "UPDATE household_deletions SET phase='complete',email='',error=NULL WHERE household=?",
      job.household,
    );
  });
}

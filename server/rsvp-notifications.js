import { smsEnabled, sendText } from "./sms-provider.js";
const KIND = "rsvp-confirmation";
export function hasRSVPConsent(store, guest, household) {
  return (
    guest.smsConsent === true ||
    (!!guest.phone &&
      store.get("guest-rsvp-consent", guest.id, household)?.phone ===
        guest.phone)
  );
}
// Called inside the same transaction as a successful explicit answer by the signed-in adult.
export function recordRSVPNotification(store, env, event, session) {
  const guest = store.get("guest", session.guest, session.household);
  if (!guest || guest.parent) return;
  const consent = store.get("guest-rsvp-consent", guest.id, session.household);
  store.put(
    "guest-rsvp-consent",
    guest.id,
    session.household,
    { phone: guest.phone || "", recorded: Date.now(), source: "guest-rsvp" },
    consent?.version,
  );
  if (!guest.phone) return;
  const status = !smsEnabled(env)
    ? "disabled"
    : store.one("SELECT phone FROM sms_optouts WHERE phone=?", guest.phone)
      ? "cancelled"
      : "queued";
  store.run(
    "INSERT OR IGNORE INTO reminder_deliveries VALUES(?,?,?,?,?,?,?,?,?,?)",
    `${event.id}:${KIND}:${guest.id}`,
    session.household,
    event.id,
    KIND,
    guest.id,
    guest.phone,
    status,
    null,
    null,
    Date.now(),
  );
}
export async function runRSVPNotifications(
  store,
  env,
  { fetcher = fetch, now = Date.now } = {},
) {
  if (!smsEnabled(env)) return;
  for (const pending of store.all(
    "SELECT * FROM reminder_deliveries WHERE reminder=? AND status='queued'",
    KIND,
  )) {
    const claimed = store.transaction(() => {
      const row = store.one(
        "SELECT * FROM reminder_deliveries WHERE id=?",
        pending.id,
      );
      if (row?.status !== "queued") return null;
      const event = store.get("event", row.event, row.household),
        guest = store.get("guest", row.guest, row.household);
      const response = store
        .list("response", row.household)
        .find((r) => r.event === row.event && r.guest === row.guest);
      const eligible =
        event?.invited.includes(row.guest) &&
        guest &&
        !guest.parent &&
        guest.phone === row.phone &&
        hasRSVPConsent(store, guest, row.household) &&
        response?.attendance?.[guest.id] &&
        !store.one("SELECT phone FROM sms_optouts WHERE phone=?", row.phone) &&
        !store.one(
          "SELECT household FROM household_deletions WHERE household=?",
          row.household,
        ) &&
        now() - row.updated < 24 * 60 * 60 * 1000;
      store.run(
        "UPDATE reminder_deliveries SET status=?,updated=? WHERE id=?",
        eligible ? "sending" : "cancelled",
        now(),
        row.id,
      );
      return eligible ? { row, event } : null;
    });
    if (!claimed) continue;
    const result = await sendText(
      env,
      claimed.row.phone,
      `Your RSVP for ${claimed.event.title} has been saved.`,
      fetcher,
    );
    store.run(
      "UPDATE reminder_deliveries SET status=?,provider_id=?,error=?,updated=? WHERE id=?",
      result.status,
      result.providerId,
      result.error,
      now(),
      claimed.row.id,
    );
  }
}

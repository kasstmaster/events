import { utcSchedule } from "../public/reminder-time.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import { fail, text, id } from "./model.js";
export function reminderInput(input) {
  if (!Array.isArray(input) || input.length > 20)
    fail(400, "Use up to 20 reminders per event.");
  const ids = new Set();
  return input.map((r) => {
    const key = text(r.id || id(), 80, true);
    if (ids.has(key)) fail(400, "Duplicate reminder.");
    ids.add(key);
    if (
      !["rsvp", "upcoming"].includes(r.kind) ||
      typeof r.enabled !== "boolean"
    )
      fail(400, "Invalid reminder.");
    try {
      new Intl.DateTimeFormat("en", { timeZone: r.timezone }).format();
    } catch {
      fail(400, "Choose a valid time zone.");
    }
    let when = text(r.when, 40, true);
    if (r.localTime) {
      try {
        when = utcSchedule(r.localTime, r.timezone);
      } catch (error) {
        fail(400, error.message);
      }
    }
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d{3})?Z$/.test(when) ||
      Number.isNaN(Date.parse(when))
    )
      fail(400, "Choose a valid UTC schedule.");
    return {
      id: key,
      kind: r.kind,
      enabled: r.enabled,
      timezone: r.timezone,
      when,
      message: text(r.message, 1200, true),
    };
  });
}
export function reminderRecipients(store, household, event, reminder) {
  const responses = store
      .list("response", household)
      .filter((r) => r.event === event.id),
    attendance = Object.assign({}, ...responses.map((r) => r.attendance));
  return store
    .list("guest", household)
    .filter(
      (g) =>
        !g.parent &&
        event.invited.includes(g.id) &&
        g.phone &&
        g.smsConsent === true &&
        !store.one("SELECT phone FROM sms_optouts WHERE phone=?", g.phone) &&
        (reminder.kind === "rsvp"
          ? !attendance[g.id]
          : attendance[g.id] === "yes"),
    );
}
export function cancelReminders(store, household, event) {
  store.run(
    "UPDATE reminder_deliveries SET status='cancelled',updated=? WHERE household=? AND (? IS NULL OR event=?) AND status='queued'",
    Date.now(),
    household,
    event ?? null,
    event ?? null,
  );
}
export async function runReminders(
  store,
  env,
  { fetcher = fetch, now = Date.now } = {},
) {
  store.run(
    "UPDATE reminder_deliveries SET status='unknown',error='dispatch_interrupted',updated=? WHERE status='sending' AND updated<?",
    now(),
    now() - 15 * 60000,
  );
  // Disabled unless the operator deliberately enables a configured provider. Never fake delivery.
  if (
    env.SMS_ENABLED !== "true" ||
    !env.TWILIO_ACCOUNT_SID ||
    !env.TWILIO_AUTH_TOKEN ||
    !env.TWILIO_FROM
  )
    return;
  const households = store.all("SELECT household FROM users WHERE role='host'");
  for (const { household } of households) {
    if (
      store.one(
        "SELECT household FROM household_deletions WHERE household=?",
        household,
      )
    )
      continue;
    for (const event of store.list("event", household))
      for (const reminder of event.reminders || []) {
        if (
          !reminder.enabled ||
          Date.parse(reminder.when) > now() ||
          (event.date &&
            event.date < new Date(now()).toISOString().slice(0, 10))
        )
          continue;
        const candidates = reminderRecipients(
            store,
            household,
            event,
            reminder,
          ),
          seen = new Set();
        for (const guest of candidates) {
          if (seen.has(guest.phone)) continue;
          seen.add(guest.phone);
          const key = `${event.id}:${reminder.id}:${guest.phone}`;
          const claimed = store.transaction(() => {
            // Re-read all mutable eligibility immediately before claiming the one-shot delivery.
            const current = store.get("event", event.id, household),
              schedule = current?.reminders?.find((r) => r.id === reminder.id);
            if (
              !schedule?.enabled ||
              Date.parse(schedule.when) > now() ||
              store.one(
                "SELECT household FROM household_deletions WHERE household=?",
                household,
              ) ||
              !reminderRecipients(store, household, current, schedule).some(
                (g) => g.id === guest.id,
              )
            )
              return false;
            return !!store.run(
              "INSERT OR IGNORE INTO reminder_deliveries VALUES(?,?,?,?,?,?, 'sending',NULL,NULL,?)",
              key,
              household,
              event.id,
              reminder.id,
              guest.id,
              guest.phone,
              now(),
            ).changes;
          });
          if (!claimed) continue;
          let status = "unknown",
            providerId = null,
            error = "delivery_unconfirmed";
          try {
            const latest = store.get("event", event.id, household),
              schedule = latest?.reminders?.find((r) => r.id === reminder.id);
            if (
              !schedule?.enabled ||
              store.one(
                "SELECT household FROM household_deletions WHERE household=?",
                household,
              ) ||
              !reminderRecipients(store, household, latest, schedule).some(
                (g) => g.id === guest.id,
              )
            ) {
              status = "cancelled";
              error = null;
            } else {
              const body = new URLSearchParams({
                ...(env.SMS_WEBHOOK_URL
                  ? { StatusCallback: env.SMS_WEBHOOK_URL }
                  : {}),
                To: guest.phone,
                From: env.TWILIO_FROM,
                Body: schedule.message + "\nReply STOP to opt out.",
              });
              const response = await fetcher(
                `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID)}/Messages.json`,
                {
                  method: "POST",
                  redirect: "error",
                  signal: AbortSignal.timeout(10000),
                  headers: {
                    Authorization:
                      "Basic " +
                      Buffer.from(
                        env.TWILIO_ACCOUNT_SID + ":" + env.TWILIO_AUTH_TOKEN,
                      ).toString("base64"),
                    "Content-Type": "application/x-www-form-urlencoded",
                  },
                  body,
                },
              );
              if (response.ok) {
                const result = await response.json();
                if (typeof result.sid === "string") {
                  status = "accepted";
                  providerId = result.sid;
                  error = null;
                }
              } else {
                status = response.status >= 500 ? "unknown" : "failed";
                error =
                  response.status >= 500
                    ? "delivery_unconfirmed"
                    : "provider_rejected";
              }
            }
          } catch {
            /* Outcome may be ambiguous. Never automatically retry an uncertain send. */
          }
          store.run(
            "UPDATE reminder_deliveries SET status=?,provider_id=?,error=?,updated=? WHERE id=?",
            status,
            providerId,
            error,
            now(),
            key,
          );
        }
      }
  }
}
export function verifyTwilio(url, params, signature, token) {
  if (!token || !signature) return false;
  const content =
    url +
    [...params.keys()]
      .sort()
      .map((key) => key + params.get(key))
      .join("");
  const expected = createHmac("sha1", token).update(content).digest("base64");
  const a = Buffer.from(expected),
    b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function processTwilio(store, params) {
  const from = params.get("From"),
    message = (params.get("Body") || "").trim().toUpperCase();
  if (
    from &&
    ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"].includes(
      message,
    )
  )
    store.run(
      "INSERT OR IGNORE INTO sms_optouts VALUES(?,?)",
      from,
      Date.now(),
    );
  const sid = params.get("MessageSid"),
    status = params.get("MessageStatus");
  if (sid && ["delivered", "undelivered", "failed", "sent"].includes(status))
    store.run(
      "UPDATE reminder_deliveries SET status=?,updated=? WHERE provider_id=? AND status NOT IN ('delivered','undelivered','failed')",
      status,
      Date.now(),
      sid,
    );
}

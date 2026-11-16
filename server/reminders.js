import { runPasswordlessMessages } from "./passwordless.js";
import { processEviteStatus } from "./evites.js";
import { createHmac, timingSafeEqual } from "node:crypto";
export function cancelReminders(store, household, event) {
  store.run(
    "UPDATE reminder_deliveries SET status='cancelled',updated=? WHERE household=? AND (? IS NULL OR event=?) AND status='queued'",
    Date.now(),
    household,
    event ?? null,
    event ?? null,
  );
}
// Outbound event/account messaging is retired. Historical delivery records remain.
export async function runReminders(
  store,
  env,
  { fetcher = fetch, now = Date.now } = {},
) {
  if (env.LEGACY_SMS_FALLBACK_APPROVED === "true")
    await runPasswordlessMessages(store, env, { fetcher, now });
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
  processEviteStatus(store, params);
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

export const smsEnabled = (env) =>
  env.SMS_ENABLED === "true" &&
  !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM);
// Shared one-shot transport for reminders and RSVP confirmations. No raw provider diagnostics.
export async function sendText(
  env,
  phone,
  message,
  fetcher = fetch,
  { mediaUrl } = {},
) {
  let status = "unknown",
    providerId = null,
    error = "delivery_unconfirmed";
  if (!smsEnabled(env))
    return { status: "disabled", providerId: null, error: null };
  try {
    const response = await fetcher(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID)}/Messages.json`,
      {
        method: "POST",
        // Workers supports manual/follow; reject redirects below without forwarding credentials.
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(
              env.TWILIO_ACCOUNT_SID + ":" + env.TWILIO_AUTH_TOKEN,
            ).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          ...(env.SMS_WEBHOOK_URL
            ? { StatusCallback: env.SMS_WEBHOOK_URL }
            : {}),
          ...(mediaUrl ? { MediaUrl: mediaUrl } : {}),
          To: phone,
          From: env.TWILIO_FROM,
          Body: message + "\nReply STOP to opt out.",
        }),
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
        response.status >= 500 ? "delivery_unconfirmed" : "provider_rejected";
    }
  } catch {
    /* An uncertain delivery is never retried automatically. */
  }
  return { status, providerId, error };
}

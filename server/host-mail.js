import { hostOnlyMode } from "./host-model.js";
import { email, fail } from "./model.js";
// Only account ownership verification/recovery. Never an event/invite/reminder transport.
export function hostMailSender(env, origin, fetcher = fetch) {
  if (!hostOnlyMode(env) || env.HOST_EMAIL_ENABLED !== "true") return undefined;
  if (!env.HOST_EMAIL_API_KEY || !env.HOST_EMAIL_FROM) return undefined;
  const from = email(env.HOST_EMAIL_FROM);
  return async ({ email: address, url, purpose = "verification" }) => {
    const link = new URL(url);
    if (
      link.origin !== origin ||
      !["/host-signup", "/host-recovery"].includes(link.pathname) ||
      !["verification", "recovery"].includes(purpose)
    )
      fail(503, "Account email is unavailable.");
    const response = await fetcher("https://api.resend.com/emails", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: {
        Authorization: "Bearer " + env.HOST_EMAIL_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [email(address)],
        subject:
          purpose === "recovery"
            ? "Reset your Gather host password"
            : "Verify your Gather host email",
        text: `Open this link in the browser where you requested it:\n\n${link.href}\n\nThis link expires in ten minutes. If you did not request it, ignore this email.`,
      }),
    });
    if (!response.ok) throw new Error("Account email is unavailable.");
    await response.body?.cancel();
  };
}

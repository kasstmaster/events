import { configuredHosts, hostnameLabel } from "../server/household-domains.js";
import { forwardRequest, unavailable } from "./gateway-protocol.js";

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      let forwardingEnv = env;
      if (
        !configuredHosts(env.HOUSEHOLD_HOSTS).has(url.hostname) &&
        env.HOUSEHOLD_ROUTING_ENABLED === "true"
      ) {
        if (
          url.protocol !== "https:" ||
          url.port ||
          !hostnameLabel(url.hostname)
        )
          return unavailable();
        // Ask the authoritative database using a signed, fixed-origin status read.
        // No cache: retirement/disable takes effect without a stale routing registry.
        forwardingEnv = { ...env, HOUSEHOLD_HOSTS: url.hostname };
        const statusHeaders = new Headers();
        if (request.headers.has("x-events-routing-probe"))
          statusHeaders.set(
            "x-events-routing-probe",
            request.headers.get("x-events-routing-probe"),
          );
        const statusRequest = await forwardRequest(
          new Request(`https://${url.hostname}/api/routing/status`, {
            headers: statusHeaders,
          }),
          forwardingEnv,
        );
        const status = await fetch(statusRequest, { redirect: "manual" });
        if (!status.ok) return unavailable();
        const result = await status.json();
        if (result.allowed !== true || result.hostname !== url.hostname)
          return unavailable();
      }
      const forwarded = await forwardRequest(request, forwardingEnv);
      if (!forwarded) return unavailable();
      const response = await fetch(forwarded, { redirect: "manual" });
      // The shared app emits no redirects. Fail closed if an upstream changes that:
      // do not follow a Location with cookies/HMAC or replace the household URL.
      if (response.status >= 300 && response.status < 400)
        return unavailable(502);
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-store");
      headers.delete("Access-Control-Allow-Origin");
      // Refuse Domain cookies or legacy canonical cookies on a household hostname.
      for (const cookie of response.headers.getSetCookie()) {
        if (
          !cookie.startsWith("__Host-events_session=") ||
          /;\s*domain=/i.test(cookie) ||
          !/;\s*secure(?:;|$)/i.test(cookie) ||
          !/;\s*path=\/(?:;|$)/i.test(cookie)
        )
          return unavailable(502);
      }
      return new Response(response.body, { status: response.status, headers });
    } catch {
      return unavailable(502);
    }
  },
};

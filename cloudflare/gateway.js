import { forwardRequest, unavailable } from "./gateway-protocol.js";

export default {
  async fetch(request, env) {
    try {
      const forwarded = await forwardRequest(request, env);
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

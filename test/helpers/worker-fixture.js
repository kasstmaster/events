// Isolated runtime harness only. Never imported by either production Worker.
import productionWorker from "../../cloudflare/worker.js";
export default {
  ...productionWorker,
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (
      url.pathname === "/__test/existing-guest-browser" &&
      url.hostname === "127.0.0.1" &&
      request.method === "POST"
    ) {
      const input = await request.json(),
        ns = env.EVENTS_DATABASE;
      return Response.json(
        await ns
          .get(ns.idFromName("events-platform-v1"))
          .existingGuestBrowser(input.household, input.guest, url.origin),
      );
    }
    return productionWorker.fetch(request, env, ctx);
  },
};
import { EventsDatabase as ProductionDatabase } from "../../cloudflare/worker.js";
import { identityFor } from "../../server/guest-identities.js";
export class EventsDatabase extends ProductionDatabase {
  existingGuestBrowser(household, guestId, origin, entryHousehold = household) {
    const guest = this.store.get("guest", guestId, household);
    if (!guest || guest.parent) throw Error("Invalid synthetic adult fixture");
    const identity = identityFor(this.store, guest, household).id;
    const result = this.store.newSession(
      { role: "guest", household, guest: guest.id, identity, entryHousehold },
      origin,
    );
    const cookie = `${origin.includes(".ilymmd.com") ? "__Host-events_session" : "events_session"}=${result.token}`;
    return {
      status: 200,
      cookie,
      body: { ok: true },
      setCookie:
        cookie +
        `; Path=/; HttpOnly; SameSite=Strict${origin.startsWith("https:") ? "; Secure" : ""}`,
    };
  }
}

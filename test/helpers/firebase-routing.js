import { once } from "node:events";
import { createApp } from "../../server/app.js";
import { firebaseFixture, firebaseFetcher, token } from "./firebase.js";
export const centralOrigin = "https://gather.ilymmd.com";
export const cookies = (...values) => values.filter(Boolean).join("; ");
export async function routingFixture(t) {
  const hosts = new Set(),
    f = await firebaseFixture(t, { householdHosts: hosts }),
    sites = new Map([
      [
        centralOrigin,
        { origin: centralOrigin, url: f.url, request: f.request },
      ],
    ]);
  async function site(host) {
    const origin = "https://" + host.household.subdomain + ".ilymmd.com";
    hosts.add(new URL(origin).hostname);
    if (sites.has(origin)) return sites.get(origin);
    const server = createApp({
      store: f.store,
      origin,
      env: f.env,
      householdHostname: new URL(origin).hostname,
      householdHosts: hosts,
      canonicalOrigin: centralOrigin,
      firebaseFetcher,
      logger: { error() {} },
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const url = "http://127.0.0.1:" + server.address().port;
    const request = async (
      path,
      { method = "GET", data, cookie, headers = {} } = {},
    ) => {
      const response = await fetch(url + path, {
        method,
        headers: {
          Origin: origin,
          ...(cookie ? { Cookie: cookie } : {}),
          ...(data ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        body: data ? JSON.stringify(data) : undefined,
      });
      return {
        status: response.status,
        body: response.headers.get("content-type")?.includes("application/json")
          ? await response.json()
          : await response.text(),
        cookie: response.headers.get("set-cookie")?.split(";")[0],
        headers: response.headers,
      };
    };
    const result = { origin, url, request };
    sites.set(origin, result);
    return result;
  }
  const alpha = await site(f.host),
    betaHost = await f.createHost("Beta"),
    beta = await site(betaHost);
  async function route(source, data = {}) {
    return source.request("/api/firebase/routing/start", {
      method: "POST",
      data,
    });
  }
  async function claim(reference, cookie) {
    return f.request("/api/firebase/routing/context", {
      method: "POST",
      data: { reference },
      cookie,
    });
  }
  async function sign(
    reference,
    {
      person = f.profile.members[0],
      phone = person.phone,
      uid = "synthetic-phone-user",
      ownerPassword,
      contextCookie,
    } = {},
  ) {
    const context = await claim(reference, contextCookie);
    f.store.run("DELETE FROM limits WHERE key LIKE 'firebase-start-%'");
    const started = await f.request("/api/firebase/start", {
      method: "POST",
      cookie: context.cookie,
      data: {
        first: person.first,
        last: person.last,
        phone,
        context: reference,
      },
    });
    const signed = await f.request("/api/firebase/verify", {
      method: "POST",
      cookie: cookies(context.cookie, started.cookie),
      data: {
        reference: started.body.reference,
        idToken: token(f.env, { uid, phone }),
        ...(ownerPassword ? { ownerPassword } : {}),
      },
    });
    return { ...signed, contextCookie: context.cookie, started };
  }
  async function complete(reference, signed) {
    return f.request("/api/firebase/routing/complete", {
      method: "POST",
      cookie: cookies(signed.cookie, signed.contextCookie),
      data: { reference },
    });
  }
  async function handoff(target, signed, invitation = "") {
    const prepared = await target.request("/api/passwordless/handoff/prepare", {
      method: "POST",
      data: { source: centralOrigin, invitation },
    });
    const request = new URL(prepared.body.url).hash.slice(
      "#transfer-request=".length,
    );
    const authorized = await f.request("/api/passwordless/handoff/authorize", {
      method: "POST",
      cookie: signed.cookie,
      data: { request },
    });
    if (authorized.status !== 200) return authorized;
    const [reference, secret] = new URL(authorized.body.url).hash
      .slice("#transfer=".length)
      .split(".");
    return target.request("/api/passwordless/handoff/redeem", {
      method: "POST",
      cookie: prepared.cookie,
      data: { request: reference, token: secret },
    });
  }
  return {
    ...f,
    hosts,
    sites,
    site,
    alpha,
    beta,
    betaHost,
    route,
    claim,
    sign,
    complete,
    handoff,
  };
}

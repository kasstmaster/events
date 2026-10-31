// Entire topology is synthetic and isolated. No network calls or real credentials.
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
export const canonical = "https://events.synthetic.workers.dev";
export const alphaOrigin = "https://theraudmans.ilymmd.com";
export const betaOrigin = "https://thedubois.ilymmd.com";
export const password = "Synthetic-domain-password-2026";
export const secret = "synthetic-gateway-key-not-a-real-secret-0123456789";
export async function domainRuntime({
  automatic = false,
  cloudflareFetch,
} = {}) {
  const bundle = async (entry) =>
    (
      await build({
        entryPoints: [entry],
        bundle: true,
        write: false,
        format: "esm",
        platform: "browser",
        target: "es2022",
        external: ["cloudflare:workers", "node:*"],
        logLevel: "silent",
      })
    ).outputFiles[0].text;
  const bindings = {
    APP_ORIGIN: canonical,
    EVENTS_ORIGIN: canonical,
    HOUSEHOLD_HOSTS:
      "theraudmans.ilymmd.com,thedubois.ilymmd.com,unknown.ilymmd.com",
    EVENTS_GATEWAY_SECRET: secret,
    ADMIN_SETUP_TOKEN: "synthetic-setup-token-0123456789-abcdefgh",
  };
  if (automatic) {
    bindings.HOUSEHOLD_ROUTING_ENABLED = "true";
    bindings.HOUSEHOLD_DNS_TOKEN = "synthetic-management-token";
    bindings.HOUSEHOLD_HOSTS = "";
  }
  const trace = [];
  let app;
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      log: new Log(LogLevel.ERROR),
      unsafeInspectDurableObjects: true,
      workers: [
        {
          name: "events",
          routes: ["events.synthetic.workers.dev/*"],
          modules: true,
          script: await bundle("cloudflare/worker.js"),
          compatibilityDate: "2026-10-30",
          compatibilityFlags: ["nodejs_compat"],
          bindings,
          durableObjects: {
            EVENTS_DATABASE: { className: "EventsDatabase", useSQLite: true },
          },
          ...(automatic
            ? {
                outboundService: async (req) => {
                  if (new URL(req.url).hostname === "api.cloudflare.com")
                    return cloudflareFetch(req);
                  if (!new URL(req.url).hostname.endsWith(".ilymmd.com"))
                    throw new Error("Unexpected provisioning destination");
                  const response = await runtime.dispatchFetch(req.url, {
                    method: req.method,
                    headers: req.headers,
                    body: req.body,
                    duplex: "half",
                  });
                  trace.push({
                    path: new URL(req.url).pathname,
                    status: response.status,
                  });
                  return response;
                },
              }
            : {}),
          serviceBindings: {
            ASSETS: async (req) => {
              const file = new URL(req.url).pathname.slice(1);
              if (
                ![
                  "index.html",
                  "style.css",
                  "app.js",
                  "household-address.js",
                ].includes(file)
              )
                return new Response("Missing", { status: 404 });
              return new Response(await readFile(resolve("public", file)));
            },
          },
        },
        {
          name: "gateway",
          routes: ["*.ilymmd.com/*"],
          modules: true,
          script: await bundle("cloudflare/gateway.js"),
          compatibilityDate: "2026-10-30",
          compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
          bindings,
          outboundService: async (req) => {
            if (new URL(req.url).origin !== canonical)
              throw new Error("Unexpected outbound request");
            return runtime.dispatchFetch(req.url, {
              method: req.method,
              headers: req.headers,
              body: req.body,
              duplex: "half",
            });
          },
        },
      ],
    }),
  );
  await runtime.ready;
  app = {
    fetch: (req) =>
      runtime.dispatchFetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        duplex: "half",
      }),
  };
  const gateway = null;
  const dispatch = (url, init = {}) => runtime.dispatchFetch(url, init);
  async function request(
    path,
    {
      origin = canonical,
      method = "GET",
      data,
      cookie,
      version,
      requestOrigin = origin,
      headers = {},
    } = {},
  ) {
    const response = await dispatch(origin + path, {
      method,
      headers: {
        ...(data ? { "Content-Type": "application/json" } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(version !== undefined ? { "If-Match": String(version) } : {}),
        ...(requestOrigin ? { Origin: requestOrigin } : {}),
        ...headers,
      },
      body: data ? JSON.stringify(data) : undefined,
    });
    return {
      status: response.status,
      headers: response.headers,
      cookie: response.headers.get("set-cookie")?.split(";")[0],
      body: response.headers.get("content-type")?.includes("application/json")
        ? await response.json()
        : await response.text(),
    };
  }
  return { runtime, app, gateway, dispatch, request, bindings, trace };
}
export async function seedDomains(f, { simpleNames = false } = {}) {
  const { request } = f;
  const admin = await request("/api/setup", {
    method: "POST",
    data: {
      token: f.bindings.ADMIN_SETUP_TOKEN,
      email: "admin@example.test",
      password,
      confirmPassword: password,
    },
  });
  if (admin.status !== 201)
    throw new Error(
      `Synthetic setup failed: ${admin.status} ${JSON.stringify(admin.body)}`,
    );
  const hosts = [];
  for (const [i, label, name] of simpleNames
    ? [
        [0, "raudman", "Raudman"],
        [1, "dubois", "Dubois"],
      ]
    : [
        [0, "theraudmans", "theraudmans"],
        [1, "thedubois", "thedubois"],
      ]) {
    const email = `host${i}@example.test`;
    await request("/api/admin/approvals", {
      method: "POST",
      cookie: admin.cookie,
      data: { email },
    });
    const account = await request("/api/register", {
      method: "POST",
      data: { email, password, name, subdomain: label },
    });
    if (account.status !== 201)
      throw new Error(`Synthetic registration failed: ${account.status}`);
    const host = await request("/api/host", { cookie: account.cookie });
    hosts.push({ email, cookie: account.cookie, ...host.body.household });
  }
  return { admin, hosts };
}

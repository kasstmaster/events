// Runs only from the existing EventsDatabase alarm. No public management endpoint.
import { hostnameLabel } from "../server/household-domains.js";
export const domainAccount = "e8cdf5b38fa02d2d1b7f30f2389888b7";
export const domainZone = "1ebdc745bcaf7f2c3c82e71b9e2744c1";
const gateway = "events-household-gateway";
export class RoutingError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const stop = (code) => {
  throw new RoutingError(code);
};
export function matchesHost(pattern, hostname) {
  const name = pattern.replace(/^https?:\/\//i, "").split("/")[0];
  return new RegExp(
    "^" +
      name
        .split("*")
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$",
    "i",
  ).test(hostname);
}
export async function provisionHousehold(
  job,
  { store, env, fetcher = fetch, now = Date.now },
) {
  const hostname = `${job.label}.ilymmd.com`;
  if (!hostnameLabel(hostname) || !store.routingClaim(job.label, job.household))
    stop("claim_invalid");
  if (env.HOUSEHOLD_ROUTING_ENABLED !== "true" || !env.HOUSEHOLD_DNS_TOKEN)
    stop("credentials_missing");
  // All API paths and destinations are fixed; a household cannot select account/zone/script.
  async function api(path, method = "GET", data) {
    const response = await fetcher(
      "https://api.cloudflare.com/client/v4" + path,
      {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
        headers: {
          Authorization: `Bearer ${env.HOUSEHOLD_DNS_TOKEN}`,
          "Content-Type": "application/json",
        },
        ...(data ? { body: JSON.stringify(data) } : {}),
      },
    );
    if (!response.ok)
      stop(
        response.status === 401 || response.status === 403
          ? "permission_denied"
          : "cloudflare_unavailable",
      );
    const payload = await response.json();
    if (payload.success !== true) stop("cloudflare_rejected");
    return payload;
  }
  async function list(path) {
    const records = [];
    for (let page = 1; page <= 100; page++) {
      const body = await api(
        path + (path.includes("?") ? "&" : "?") + `per_page=100&page=${page}`,
      );
      if (!Array.isArray(body.result)) stop("inventory_invalid");
      records.push(...body.result);
      const info = body.result_info;
      if (info?.total_pages !== undefined) {
        if (page >= info.total_pages) return records;
      } else if (body.result.length < 100) return records;
    }
    stop("inventory_incomplete");
  }
  const dnsPath = `/zones/${domainZone}/dns_records`;
  const routePath = `/zones/${domainZone}/workers/routes`;
  const marker = `events-household:${job.id}`;
  async function inventory() {
    const [records, routes, domains] = await Promise.all([
      list(dnsPath),
      list(routePath),
      list(`/accounts/${domainAccount}/workers/domains`),
    ]);
    if (domains.some((d) => matchesHost(d.hostname, hostname)))
      stop("custom_domain_conflict");
    if (
      records.some((r) => r.name.includes("*") && matchesHost(r.name, hostname))
    )
      stop("wildcard_dns_conflict");
    const exact = records.filter((r) => r.name.toLowerCase() === hostname);
    if (
      exact.length > 1 ||
      exact.some(
        (r) =>
          r.type !== "AAAA" ||
          r.content !== "100::" ||
          r.proxied !== true ||
          r.comment !== marker,
      )
    )
      stop("dns_conflict");
    const matching = routes.filter((r) => matchesHost(r.pattern, hostname));
    if (
      matching.some(
        (r) =>
          r.pattern !== hostname + "/*" ||
          r.script !== gateway ||
          !exact.length,
      )
    )
      stop("route_conflict");
    if (matching.length > 1) stop("route_conflict");
    return { dns: exact[0], route: matching[0] };
  }
  let existing = await inventory();
  if (!existing.dns) {
    const created = (
      await api(dnsPath, "POST", {
        type: "AAAA",
        name: hostname,
        content: "100::",
        proxied: true,
        ttl: 1,
        comment: marker,
      })
    ).result;
    store.routingReceipt(job.label, { dns_id: created.id });
  }
  // Recheck after each write. POST only; never PUT/PATCH/DELETE an existing resource.
  existing = await inventory();
  if (!existing.dns) stop("dns_not_visible");
  if (!existing.route) {
    const created = (
      await api(routePath, "POST", {
        pattern: hostname + "/*",
        script: gateway,
      })
    ).result;
    store.routingReceipt(job.label, { route_id: created.id });
  }
  existing = await inventory();
  if (!existing.dns || !existing.route) stop("route_not_visible");
  store.routingReceipt(job.label, {
    dns_id: existing.dns.id,
    route_id: existing.route.id,
  });
  store.routingPhase(job.label, "verifying");
  // Public HTTPS traverses DNS, TLS and the domain-account gateway. A secret probe
  // permits only these anonymous GETs before activation; no sessions/mutations.
  const paths = [
    "/api/routing/probe",
    "/",
    "/app.js",
    "/household-address.js",
    "/style.css",
    "/api/public/context",
  ];
  for (const path of paths) {
    const response = await fetcher(`https://${hostname}${path}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
      headers: {
        "x-events-routing-probe": job.probe,
        "Cache-Control": "no-cache",
      },
    });
    if (!response.ok || response.headers.has("set-cookie"))
      stop("verification_pending");
    if (path === "/api/routing/probe") {
      const proof = await response.json();
      if (proof.probe !== job.probe || proof.household !== job.household)
        stop("verification_mismatch");
    } else if (path === "/api/public/context") {
      const context = await response.json();
      if (context.household?.id !== job.household)
        stop("verification_mismatch");
    } else {
      const content = await response.text();
      if (
        path === "/"
          ? !content.includes("/app.js")
          : path === "/app.js"
            ? !content.includes("suggestLabel")
            : path === "/household-address.js"
              ? !content.includes("export function suggestLabel")
              : !content.includes("--")
      )
        stop("verification_mismatch");
    }
  }
  // Last conflict/claim check before activation. Retired/changed claims cannot activate.
  await inventory();
  store.activateRouting(job.label, job.household, now());
}
export async function runProvisioning(
  store,
  env,
  fetcher = fetch,
  now = Date.now,
) {
  if (env.HOUSEHOLD_ROUTING_ENABLED !== "true") return;
  const job = store.nextRoutingJob(now());
  if (!job) return;
  try {
    await provisionHousehold(job, { store, env, fetcher, now });
  } catch (error) {
    // Persist allowlisted codes only, never upstream errors/bodies/credentials.
    store.retryRouting(
      job.label,
      error instanceof RoutingError ? error.code : "verification_pending",
      now(),
    );
  }
}

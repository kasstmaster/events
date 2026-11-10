import {
  domainZone,
  domainAccount,
  matchesHost,
} from "./household-provisioner.js";
import { finalizeDeletion } from "../server/account-deletion.js";
// Validate every owned primary/alias resource before deleting any of them.
export async function runAccountCleanup(
  store,
  env,
  { fetcher = fetch, now = Date.now } = {},
) {
  if (env.ACCOUNT_CLEANUP_ENABLED === "false") return;
  const job = store.one(
    "SELECT * FROM household_deletions WHERE phase!='complete' AND next_attempt<=? ORDER BY next_attempt LIMIT 1",
    now(),
  );
  if (!job) return;
  const labels = [
    ...new Set(
      [
        job.label,
        ...store
          .all(
            "SELECT label FROM household_domains WHERE household=?",
            job.household,
          )
          .map((r) => r.label),
      ].filter(Boolean),
    ),
  ];
  const request = async (path, method = "GET", envelope = false) => {
    const response = await fetcher(
      "https://api.cloudflare.com/client/v4" + path,
      {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: { Authorization: "Bearer " + env.HOUSEHOLD_DNS_TOKEN },
      },
    );
    if (response.status === 404) return null;
    if (!response.ok) throw Error("cleanup_access_failed");
    const result = await response.json();
    if (result.success !== true) throw Error("cleanup_rejected");
    return envelope ? result : result.result;
  };
  const inventory = async (path) => {
    const records = [];
    for (let page = 1; page <= 100; page++) {
      const body = await request(
        path + (path.includes("?") ? "&" : "?") + `per_page=100&page=${page}`,
        "GET",
        true,
      );
      if (!body || !Array.isArray(body.result))
        throw Error("cleanup_manual_inventory_required");
      records.push(...body.result);
      const pages = body.result_info?.total_pages;
      if (pages !== undefined && (!Number.isInteger(pages) || pages < 1))
        throw Error("cleanup_manual_inventory_required");
      if (pages !== undefined ? page >= pages : body.result.length < 100)
        return records;
    }
    throw Error("cleanup_manual_inventory_required");
  };
  try {
    if (labels.length && !env.HOUSEHOLD_DNS_TOKEN)
      throw Error("cleanup_credentials_missing");
    const domains = labels.length
        ? await inventory(`/accounts/${domainAccount}/workers/domains`)
        : [],
      resources = [];
    for (const label of labels) {
      const hostname = label + ".ilymmd.com",
        receipt = store.routingJob(label);
      if (receipt && receipt.household !== job.household)
        throw Error("cleanup_ownership_conflict");
      if (domains.some((d) => matchesHost(d.hostname, hostname)))
        throw Error("cleanup_ownership_conflict");
      if (receipt && (receipt.dns_id || receipt.route_id)) {
        const dnsPath = receipt.dns_id
            ? `/zones/${domainZone}/dns_records/${encodeURIComponent(receipt.dns_id)}`
            : null,
          routePath = receipt.route_id
            ? `/zones/${domainZone}/workers/routes/${encodeURIComponent(receipt.route_id)}`
            : null;
        const dns = dnsPath ? await request(dnsPath) : null,
          route = routePath ? await request(routePath) : null;
        if (
          dns &&
          (dns.name !== hostname ||
            dns.type !== "AAAA" ||
            dns.content !== "100::" ||
            dns.proxied !== true ||
            dns.comment !== `events-household:${receipt.id}`)
        )
          throw Error("cleanup_ownership_conflict");
        if (
          route &&
          (route.pattern !== hostname + "/*" ||
            route.script !== "events-household-gateway" ||
            !receipt.dns_id)
        )
          throw Error("cleanup_ownership_conflict");
        resources.push({ dnsPath, routePath, dns: !!dns, route: !!route });
      } else {
        const dns = await inventory(
            `/zones/${domainZone}/dns_records?name=${encodeURIComponent(hostname)}`,
          ),
          routes = await inventory(`/zones/${domainZone}/workers/routes`);
        if (dns.length || routes.some((r) => r.pattern === hostname + "/*"))
          throw Error("cleanup_manual_inventory_required");
      }
    }
    for (const resource of resources) {
      if (resource.route) await request(resource.routePath, "DELETE");
      if (resource.dns) await request(resource.dnsPath, "DELETE");
    }
    for (const resource of resources)
      if (
        (resource.routePath && (await request(resource.routePath))) ||
        (resource.dnsPath && (await request(resource.dnsPath)))
      )
        throw Error("cleanup_not_verified");
    finalizeDeletion(store, job);
  } catch (error) {
    const allowed = [
      "cleanup_access_failed",
      "cleanup_rejected",
      "cleanup_credentials_missing",
      "cleanup_ownership_conflict",
      "cleanup_not_verified",
      "cleanup_manual_inventory_required",
    ];
    const code = allowed.includes(error.message)
      ? error.message
      : "cleanup_transport_unconfirmed";
    store.run(
      "UPDATE household_deletions SET attempts=attempts+1,next_attempt=?,error=? WHERE household=?",
      now() + 300000,
      code,
      job.household,
    );
  }
}

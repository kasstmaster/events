import {
  domainZone,
  domainAccount,
  matchesHost,
} from "./household-provisioner.js";
import { finalizeDeletion } from "../server/account-deletion.js";
// Receipt-based cleanup: never discover-and-adopt somebody else's DNS or route.
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
  const receipt = job.label ? store.routingJob(job.label) : null,
    hostname = job.label + ".ilymmd.com";
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
    if (!response.ok) throw new Error("cleanup_access_failed");
    const result = await response.json();
    if (result.success !== true) throw new Error("cleanup_rejected");
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
        throw new Error("cleanup_manual_inventory_required");
      records.push(...body.result);
      const pages = body.result_info?.total_pages;
      if (pages !== undefined && (!Number.isInteger(pages) || pages < 1))
        throw new Error("cleanup_manual_inventory_required");
      if (pages !== undefined ? page >= pages : body.result.length < 100)
        return records;
    }
    throw new Error("cleanup_manual_inventory_required");
  };
  try {
    if (job.label) {
      if (!env.HOUSEHOLD_DNS_TOKEN)
        throw new Error("cleanup_credentials_missing");
      const domains = await inventory(
        `/accounts/${domainAccount}/workers/domains`,
      );
      if (
        !Array.isArray(domains) ||
        domains.some((d) => matchesHost(d.hostname, hostname))
      )
        throw new Error("cleanup_ownership_conflict");
    }
    if (receipt && (receipt.dns_id || receipt.route_id)) {
      if (!env.HOUSEHOLD_DNS_TOKEN)
        throw new Error("cleanup_credentials_missing");
      const dnsPath = receipt.dns_id
        ? `/zones/${domainZone}/dns_records/${encodeURIComponent(receipt.dns_id)}`
        : null;
      const routePath = receipt.route_id
        ? `/zones/${domainZone}/workers/routes/${encodeURIComponent(receipt.route_id)}`
        : null;
      const dns = dnsPath ? await request(dnsPath) : null;
      if (
        dns &&
        (dns.name !== hostname ||
          dns.type !== "AAAA" ||
          dns.content !== "100::" ||
          dns.proxied !== true ||
          dns.comment !== `events-household:${receipt.id}`)
      )
        throw new Error("cleanup_ownership_conflict");
      const route = routePath ? await request(routePath) : null;
      if (
        route &&
        (route.pattern !== hostname + "/*" ||
          route.script !== "events-household-gateway" ||
          !receipt.dns_id)
      )
        throw new Error("cleanup_ownership_conflict");
      // Validate both resources before the first destructive operation. Delete only exact receipt IDs.
      if (route) await request(routePath, "DELETE");
      if (dns) await request(dnsPath, "DELETE");
      if (
        (routePath && (await request(routePath))) ||
        (dnsPath && (await request(dnsPath)))
      )
        throw new Error("cleanup_not_verified");
    } else if (job.label) {
      const dns = await inventory(
        `/zones/${domainZone}/dns_records?name=${encodeURIComponent(hostname)}`,
      );
      const routes = await inventory(`/zones/${domainZone}/workers/routes`);
      if (
        !Array.isArray(dns) ||
        dns.length ||
        routes.some((r) => r.pattern === hostname + "/*")
      )
        throw new Error("cleanup_manual_inventory_required");
      // No dedicated resources exist, so there is nothing to delete. Retired claims remain.
    }
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

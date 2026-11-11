// Offline preparation only. Never invokes a Cloudflare API, deploys, or edits DNS.
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parse } from "jsonc-parser";
import { configuredHosts } from "../server/household-domains.js";
import { upstreamOrigin } from "../cloudflare/gateway-protocol.js";
export function routingPlan(inventory, hosts, origin, template) {
  if (
    inventory.accountId !== "e8cdf5b38fa02d2d1b7f30f2389888b7" ||
    inventory.zone !== "ilymmd.com" ||
    inventory.complete !== true
  )
    throw new Error(
      "A complete inventory from the verified domain account is required.",
    );
  if (
    !Array.isArray(inventory.dnsNames) ||
    !Array.isArray(inventory.routes) ||
    !Array.isArray(inventory.customDomains)
  )
    throw new Error("Include all DNS names, Worker routes and custom domains.");
  const age = Date.now() - Date.parse(inventory.checkedAt);
  if (!Number.isFinite(age) || age < 0 || age > 3600000)
    throw new Error(
      "Recheck routing and DNS within the last hour before preparing a plan.",
    );
  const exact = [...configuredHosts(hosts)];
  if (!exact.length)
    throw new Error("Select at least one explicitly approved hostname.");
  for (const host of exact) {
    if (
      [...inventory.dnsNames, ...inventory.customDomains].some(
        (name) => name.toLowerCase() === host,
      )
    )
      throw new Error(
        "An existing DNS record or custom domain must never be overwritten.",
      );
    // Conservative: stop on any matching route, even if a more-specific route might win.
    for (const pattern of inventory.routes) {
      const hostPattern = pattern.replace(/^https?:\/\//, "").split("/")[0];
      const regex = new RegExp(
        "^" +
          hostPattern
            .split("*")
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join(".*") +
          "$",
        "i",
      );
      if (regex.test(host))
        throw new Error(
          "Existing Worker route matches a requested hostname. Stop for review.",
        );
    }
  }
  return {
    gateway: {
      ...template,
      routes: exact.map((host) => ({
        pattern: host + "/*",
        zone_name: "ilymmd.com",
      })),
      vars: {
        EVENTS_ORIGIN: upstreamOrigin(origin),
        HOUSEHOLD_HOSTS: exact.join(","),
      },
    },
    dnsAdditions: exact.map((name) => ({
      type: "AAAA",
      name,
      content: "100::",
      proxied: true,
      ttl: 1,
    })),
    applicationVars: {
      EVENTS_ORIGIN: origin,
      HOUSEHOLD_HOSTS: exact.join(","),
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [inventoryFile, hosts, origin, outputFile] = process.argv.slice(2);
  if (!outputFile)
    throw new Error(
      "Usage: node scripts/prepare-household-routing.js inventory.json exact-hosts origin plan.json",
    );
  const inventory = JSON.parse(await readFile(inventoryFile, "utf8"));
  const template = parse(
    await readFile(
      new URL("../wrangler.gateway.jsonc", import.meta.url),
      "utf8",
    ),
  );
  const plan = routingPlan(inventory, hosts, origin, template);
  // Exclusive create: no overwrite of an existing approved plan.
  await writeFile(outputFile, JSON.stringify(plan, null, 2) + "\n", {
    flag: "wx",
  });
  console.log(
    "Offline routing plan prepared. No Cloudflare or DNS changes were made.",
  );
}

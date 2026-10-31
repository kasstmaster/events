// Shared data validation, never a household-specific implementation.
export const domain = "ilymmd.com";
export const reservedLabels = new Set(
  (
    "admin api app assets auth billing cdn dashboard dev email events gather gateway " +
    "help host hosts login mail mx ns ns1 ns2 register setup staging static status " +
    "support test www themeyers themeyersgatherings thanksgiving curly-sun-ef0f " +
    "bridge plex books discover jellyseerr-iframe themeyers-site"
  ).split(/\s+/),
);
export function normalizeLabel(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^[\x00-\x7f]*$/.test(trimmed)) return null;
  const label = trimmed.toLowerCase();
  // ASCII only, 3–63 characters; no IDNA, punctuation rewriting or surname inference.
  return /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(label) &&
    !label.startsWith("xn--") &&
    !reservedLabels.has(label)
    ? label
    : null;
}
export function hostnameLabel(hostname) {
  if (typeof hostname !== "string" || !hostname.endsWith("." + domain))
    return null;
  const label = hostname.slice(0, -(domain.length + 1));
  return normalizeLabel(label) === label ? label : null;
}
export function configuredHosts(value = "") {
  const hosts = String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (hosts.some((host) => !hostnameLabel(host)))
    throw new Error(
      "HOUSEHOLD_HOSTS must contain exact permitted household hostnames.",
    );
  return new Set(hosts);
}
export function householdLink(household, origin, hosts = new Set()) {
  const hostname = household.subdomain && `${household.subdomain}.${domain}`;
  return hostname && hosts.has(hostname)
    ? `https://${hostname}/`
    : `${origin}/h/${household.slug}`;
}

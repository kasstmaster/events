// Shared, conservative parsing: keep unfamiliar mailing formats intact in street.
export function addressParts(address = {}) {
  if (
    ["street", "city", "state", "zip"].some((key) => address[key] !== undefined)
  )
    return Object.fromEntries(
      ["street", "city", "state", "zip"].map((key) => [
        key,
        String(address[key] || ""),
      ]),
    );
  const lines = String(address.lines || "").trim();
  const match = lines.match(
    /^([\s\S]+?)[,\n]+\s*([^,\n]+?)(?:[,\n]+|\s+)\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/,
  );
  return match
    ? {
        street: match[1].trim(),
        city: match[2].trim(),
        state: match[3].toUpperCase(),
        zip: match[4],
      }
    : { street: lines, city: "", state: "", zip: "" };
}
export function addressLines(parts) {
  return [
    parts.street,
    [parts.city, [parts.state, parts.zip].filter(Boolean).join(" ")]
      .filter(Boolean)
      .join(", "),
  ]
    .filter(Boolean)
    .join("\n");
}

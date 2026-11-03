import { addressParts, addressLines } from "../public/address-system.js";
import { text } from "./model.js";
import { contactPhone } from "./features.js";
export function addressInput(input, existing = {}) {
  const keys = ["street", "city", "state", "zip"];
  const legacyEdit =
    input.lines !== undefined &&
    input.lines !== existing.lines &&
    keys.every(
      (key) => input[key] === undefined || input[key] === existing[key],
    );
  const structured =
    !legacyEdit && keys.some((key) => input[key] !== undefined);
  const parts = addressParts(
    structured
      ? { ...addressParts(existing), ...input }
      : { lines: input.lines ?? existing.lines ?? "" },
  );
  for (const key of ["street", "city", "state", "zip"])
    parts[key] = text(
      parts[key],
      key === "street" ? 500 : key === "zip" ? 30 : 100,
    );
  return {
    ...existing,
    label: text(input.label ?? existing.label, 100, true),
    ...parts,
    lines: structured
      ? text(addressLines(parts), 500)
      : text(input.lines ?? existing.lines ?? "", 500),
    phone: contactPhone(input.phone ?? existing.phone ?? ""),
  };
}

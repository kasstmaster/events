import { createHash } from "node:crypto";
import { fail } from "./model.js";

export const mediaPath = "/api/display-media/";
const slots = {
  logo: ["logo"],
  icon: ["icon"],
  background: ["design", "backgroundImage"],
  container: ["design", "containerImage"],
  "ui-background": ["ui", "design", "backgroundImage"],
  "ui-container": ["ui", "design", "containerImage"],
};
const image = /^data:(image\/(?:png|jpeg|webp));base64,/;
const digest = (value) =>
  createHash("sha256").update(value).digest("base64url");

export function displayMedia(record, base) {
  if (!record) return record;
  const result = { ...record };
  for (const [slot, keys] of Object.entries(slots)) {
    const value = keys.reduce((source, key) => source?.[key], record);
    // Small icons are cheaper to inline than to request separately.
    if (typeof value !== "string" || value.length <= 2048 || !image.test(value))
      continue;
    let target = result;
    for (const key of keys.slice(0, -1)) {
      target[key] = { ...target[key] };
      target = target[key];
    }
    target[keys.at(-1)] = mediaPath + base + "/" + slot + "/" + digest(value);
  }
  return result;
}

// A legacy UI-layer image can be overridden by the record's direct design.
export function visibleDesignMedia(record, slot) {
  return (
    !slot?.startsWith("ui-") ||
    !Object.hasOwn(record?.design || {}, slots[slot]?.at(-1))
  );
}

export function sendDisplayMedia(req, res, record, slot, hash) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(hash || "")) fail(404, "Image not found.");
  const value = Object.hasOwn(slots, slot)
    ? slots[slot].reduce((source, key) => source?.[key], record)
    : undefined;
  const match = typeof value === "string" && value.match(image);
  if (!match || digest(value) !== hash) fail(404, "Image not found.");
  // Every revalidation passes the same admission checks as the first read.
  const etag = '"' + hash + '"';
  res.setHeader("Cache-Control", "private, no-cache");
  res.setHeader("ETag", etag);
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304);
    res.end(null);
    return;
  }
  res.writeHead(200, { "Content-Type": match[1] });
  res.end(Buffer.from(value.slice(match[0].length), "base64"));
}

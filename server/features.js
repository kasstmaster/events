import { fail, text, design, image, id } from "./model.js";
import { layouts, validLayout, resolveUI } from "../public/ui-system.js";
import {
  cardKinds,
  cardFields,
  cardFonts,
  newCard,
} from "../public/card-system.js";
export function uiConfig(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail(400, "Invalid interface settings.");
  const copy = {};
  if (
    input.copy &&
    (typeof input.copy !== "object" || Array.isArray(input.copy))
  )
    fail(400, "Invalid interface copy.");
  for (const [key, value] of Object.entries(input.copy || {})) {
    if (
      key.length > 1000 ||
      ["__proto__", "constructor", "prototype"].includes(key)
    )
      fail(400, "Invalid wording key.");
    copy[key] = text(value, 3000, true);
  }
  if (Object.keys(copy).length > 1000) fail(400, "Too many wording overrides.");
  const savedLayouts = {};
  for (const [key, value] of Object.entries(input.layouts || {})) {
    if (!validLayout(key, value)) fail(400, "Invalid layout order.");
    savedLayouts[key] = value;
  }
  return { copy, design: design(input.design), layouts: savedLayouts };
}
export function effectiveUI(store, household, event) {
  return resolveUI(
    store.get("ui", "defaults", "platform"),
    { design: household?.ui?.design },
    { design: household?.design },
    { design: event?.ui?.design },
    { design: event?.design },
  );
}
export function safeEvent(event) {
  const { notes, reminders, ...safe } = event;
  return safe;
}
export function webURL(value) {
  const raw = text(value ?? "", 2048);
  if (!raw) return "";
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail(400, "Enter a complete HTTP or HTTPS URL.");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  )
    fail(400, "Links must use HTTP or HTTPS without embedded credentials.");
  return parsed.href;
}
export function contactPhone(value = "") {
  const phone = text(value, 30).replace(/[\s().-]/g, "");
  if (phone && !/^\+[1-9]\d{7,14}$/.test(phone))
    fail(400, "Use an international phone number, such as +15551234567.");
  return phone;
}
export function cardInput(input) {
  const card = {
    name: text(input.name, 100, true),
    kind: input.kind || "invitation",
    width: input.width ?? 600,
    height: input.height ?? 800,
    color: input.color || "#fffdf9",
    background: image(input.background ?? input.image),
    includeQR: input.includeQR !== false,
    elements: input.elements ?? newCard().elements,
  };
  if (
    !cardKinds.includes(card.kind) ||
    !Number.isInteger(card.width) ||
    card.width < 300 ||
    card.width > 2400 ||
    !Number.isInteger(card.height) ||
    card.height < 300 ||
    card.height > 2400 ||
    !/^#[0-9a-f]{6}$/i.test(card.color) ||
    !Array.isArray(card.elements) ||
    card.elements.length > 80
  )
    fail(400, "Invalid card dimensions or elements.");
  const ids = new Set();
  card.elements = card.elements.map((e) => {
    if (
      !e ||
      typeof e !== "object" ||
      !cardFields.includes(e.field) ||
      !cardFonts.includes(e.font) ||
      !["left", "center", "right"].includes(e.align) ||
      !/^#[0-9a-f]{6}$/i.test(e.color)
    )
      fail(400, "Invalid card field or formatting.");
    const key = text(e.id || id(), 80, true);
    if (ids.has(key)) fail(400, "Duplicate card element.");
    ids.add(key);
    for (const k of ["x", "y", "width", "height", "fontSize"])
      if (!Number.isFinite(e[k]) || e[k] < 0 || e[k] > 2400)
        fail(400, "Invalid card position or size.");
    if (
      e.fontSize < 8 ||
      e.fontSize > 160 ||
      e.x > card.width ||
      e.y > card.height ||
      e.width < 10 ||
      e.height < 10
    )
      fail(400, "Card element is outside the canvas.");
    if (e.field === "qr" && (e.width < 100 || e.height < 100))
      fail(400, "Keep QR codes at least 100 units wide and high.");
    return {
      id: key,
      field: e.field,
      text: text(e.text ?? "", 3000),
      fallback: text(e.fallback ?? "", 500),
      x: e.x,
      y: e.y,
      width: e.width,
      height: e.height,
      font: e.font,
      fontSize: e.fontSize,
      color: e.color,
      bold: !!e.bold,
      align: e.align,
    };
  });
  return card;
}

// Hosts may format their own records; wording and layout are administrator defaults only.
export function hostUI(input = {}, existing = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail(400, "Invalid interface settings.");
  for (const key of ["copy", "layouts"]) {
    const value = input[key];
    if (value === undefined) continue;
    if (!value || typeof value !== "object" || Array.isArray(value))
      fail(400, "Invalid interface settings.");
    // Permit an unchanged legacy record to round-trip (for example a notes save),
    // without accepting new wording/layout or revalidating obsolete layout keys.
    if (
      Object.keys(value).length &&
      JSON.stringify(value) !== JSON.stringify(existing[key] || {})
    )
      fail(403, "Only the administrator may change page wording or layout.");
  }
  return { ...existing, design: design(input.design) };
}

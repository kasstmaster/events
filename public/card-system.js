export const cardKinds = ["invitation", "thank-you", "holiday"];
export const cardFields = [
  "text",
  "household.name",
  "event.title",
  "event.description",
  "event.date",
  "event.time",
  "event.address",
  "event.deadline",
  "recipient.name",
  "recipient.first",
  "recipient.last",
  "recipient.address",
  "qr",
];
export const cardFonts = [
  "Georgia",
  "system-ui",
  "Arial",
  "Verdana",
  "Times New Roman",
];
export const escapeCard = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function populateField(field, context) {
  if (field.field === "text") return field.text || "";
  const value = field.field
    .split(".")
    .reduce((data, key) => data?.[key], context);
  return value === undefined || value === null || value === ""
    ? field.fallback || ""
    : String(value);
}
// The same SVG is used for editor preview, download, native sharing and printing.
export function renderCard(card, context = {}, qr = "") {
  const background = card.background
    ? `<image href="${escapeCard(card.background)}" width="${card.width}" height="${card.height}" preserveAspectRatio="xMidYMid slice"/>`
    : "";
  const fields = card.elements
    .filter((e) => e.field !== "qr" || card.includeQR)
    .map((e) => {
      if (e.field === "qr")
        return qr
          ? `<svg x="${e.x}" y="${e.y}" width="${e.width}" height="${e.height}" viewBox="0 0 120 120"><rect width="120" height="120" fill="#fff"/><image href="${escapeCard(qr)}" x="6" y="6" width="108" height="108"/></svg>`
          : "";
      const words = cardTextLines(
        populateField(e, context),
        e.width,
        e.fontSize,
      );
      const left =
        e.align === "center"
          ? e.x - e.width / 2
          : e.align === "right"
            ? e.x - e.width
            : e.x;
      const clip = "field-" + card.elements.indexOf(e);
      return `<defs><clipPath id="${clip}"><rect x="${left}" y="${e.y}" width="${e.width}" height="${e.height}"/></clipPath></defs><text clip-path="url(#${clip})" x="${e.x}" y="${e.y + e.fontSize}" fill="${e.color}" font-family="${escapeCard(e.font)}" font-size="${e.fontSize}" font-weight="${e.bold ? "700" : "400"}" text-anchor="${e.align === "center" ? "middle" : e.align === "right" ? "end" : "start"}">${words.map((line, index) => `<tspan x="${e.x}" dy="${index ? "1.3em" : 0}">${escapeCard(line)}</tspan>`).join("")}</text>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${card.width}" height="${card.height}" viewBox="0 0 ${card.width} ${card.height}" role="img" aria-label="${escapeCard(card.name)}"><rect width="100%" height="100%" fill="${card.color}"/>${background}${fields}</svg>`;
}
export function newCard(name = "Untitled card") {
  return {
    name,
    kind: "invitation",
    width: 600,
    height: 800,
    color: "#fffdf9",
    background: "",
    includeQR: true,
    elements: [
      {
        id: "title",
        field: "event.title",
        text: "",
        fallback: "You’re invited",
        x: 300,
        y: 100,
        width: 450,
        height: 70,
        font: "Georgia",
        fontSize: 36,
        color: "#294d42",
        bold: false,
        align: "center",
      },
      {
        id: "details",
        field: "event.date",
        fallback: "Save the date",
        x: 300,
        y: 220,
        width: 450,
        height: 50,
        font: "Georgia",
        fontSize: 24,
        color: "#294d42",
        bold: false,
        align: "center",
      },
      {
        id: "qr",
        field: "qr",
        x: 210,
        y: 500,
        width: 180,
        height: 180,
        font: "Georgia",
        fontSize: 20,
        color: "#000000",
        bold: false,
        align: "left",
      },
    ],
  };
}

export function cardTextLines(text, width, fontSize) {
  const limit = Math.max(1, Math.floor(width / (fontSize * 0.55))),
    lines = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (let word of paragraph.split(/\s+/)) {
      if (!word) continue;
      const chars = [...word];
      while (chars.length > limit) {
        if (line) {
          lines.push(line);
          line = "";
        }
        lines.push(chars.splice(0, limit).join(""));
      }
      word = chars.join("");
      if (line.length + word.length + 1 > limit && line) {
        lines.push(line);
        line = "";
      }
      line += (line ? " " : "") + word;
    }
    lines.push(line);
  }
  return lines;
}

export const cardFieldLabels = {
  text: "Custom text",
  "household.name": "Household name",
  "event.title": "Event title",
  "event.description": "Event description",
  "event.date": "Event date",
  "event.time": "Event time",
  "event.address": "Event address",
  "event.deadline": "RSVP deadline",
  "recipient.name": "Recipient name",
  "recipient.first": "Recipient first name",
  "recipient.last": "Recipient last name",
  "recipient.address": "Recipient address",
  qr: "QR code",
};

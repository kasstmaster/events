// Shared schema: content, role formatting and layout remain independent data.
export const roleDefaults = {
  background: "#f3eee8",
  backgroundImage: "",
  container: "#fffdf9",
  opacity: 96,
  titleColor: "#294d42",
  titleFont: "Georgia",
  titleSize: 34,
  textColor: "#263c35",
  textFont: "system-ui",
  textSize: 17,
  descriptionColor: "#52675c",
  descriptionFont: "system-ui",
  descriptionSize: 17,
  buttonColor: "#294d42",
  buttonText: "#ffffff",
  buttonFont: "system-ui",
  buttonSize: 16,
};
export const layouts = {
  hostHome: ["intro", "actions", "notes", "events"],
  guestHome: ["intro", "events"],
  event: ["information", "actions", "menus", "personal"],
  login: ["intro", "form"],
  admin: ["intro", "defaults", "approvals", "templates", "hosts"],
  toolbar: ["home", "print", "rsvp", "dashboard", "logout"],
  eventButtons: ["edit-event", "invitation", "delete-event", "rsvp", "uploads"],
  homeButtons: [
    "household",
    "new-event",
    "guests",
    "addresses",
    "share",
    "cards",
  ],
};
export function resolveUI(...layers) {
  const result = {
    copy: {},
    design: { ...roleDefaults },
    layouts: { ...layouts },
  };
  for (const layer of layers) {
    if (!layer) continue;
    Object.assign(result.copy, layer.copy);
    Object.assign(result.design, layer.design);
    Object.assign(result.layouts, layer.layouts);
  }
  return result;
}
export function order(items, keys) {
  const map = new Map(items.map((item) => [item.id, item]));
  return [
    ...keys.filter((key) => map.has(key)),
    ...items.map((i) => i.id).filter((key) => !keys.includes(key)),
  ].map((key) => map.get(key));
}
export function validLayout(name, value) {
  return (
    name in layouts &&
    Array.isArray(value) &&
    value.length === layouts[name].length &&
    new Set(value).size === value.length &&
    value.every((key) => layouts[name].includes(key))
  );
}
export const layoutLabels = {
  intro: "Introduction",
  actions: "Actions",
  notes: "Private notes",
  events: "Events",
  information: "Event information",
  menus: "Menu",
  personal: "Your RSVP & items",
  form: "Sign-in form",
  defaults: "Design editor",
  approvals: "Approved emails",
  templates: "Card templates",
  hosts: "Host accounts",
  home: "Home",
  print: "Print",
  rsvp: "RSVP and registries",
  dashboard: "RSVP dashboard",
  logout: "Sign out",
  "edit-event": "Edit event",
  invitation: "Invitation preview",
  "delete-event": "Delete event",
  uploads: "Photo uploads",
  household: "Edit household",
  "new-event": "Create event",
  guests: "Guest list",
  addresses: "Address book",
  share: "Share household link",
  cards: "Cards",
};
export const viewLabels = {
  hostHome: "Host home",
  guestHome: "Guest home",
  event: "Event page",
  login: "Guest sign-in",
  admin: "Administrator home",
  toolbar: "Bottom toolbar",
  eventButtons: "Event action buttons",
  homeButtons: "Home action buttons",
};
export const fontOptions = [
  "Georgia",
  "system-ui",
  "Arial",
  "Verdana",
  "Times New Roman",
];
export function designControls(d, { field, select, label = (value) => value }) {
  const roles = [
    ["title", "Title"],
    ["description", "Description"],
    ["text", "Body text"],
    ["button", "Button"],
  ];
  return (
    field(
      label("Background image (optional, up to 2 MB)"),
      "backgroundUpload",
      "",
      "file",
      'accept="image/png,image/jpeg,image/webp"',
    ) +
    '<div class="form-grid">' +
    field(label("Background color"), "background", d.background, "color") +
    field(label("Container color"), "container", d.container, "color") +
    field(
      label("Container opacity (%)"),
      "opacity",
      d.opacity,
      "number",
      'min="35" max="100"',
    ) +
    roles
      .map(
        ([key, name]) =>
          field(
            label(name + " color"),
            key === "button" ? "buttonColor" : key + "Color",
            d[key === "button" ? "buttonColor" : key + "Color"],
            "color",
          ) +
          select(
            label(name + " font"),
            key + "Font",
            fontOptions.map((f) => [f, f]),
            d[key + "Font"],
          ) +
          field(
            label(name + " size"),
            key + "Size",
            d[key + "Size"],
            "number",
            `min="${key === "title" ? 22 : 14}" max="${key === "title" ? 64 : 28}"`,
          ),
      )
      .join("") +
    field(label("Button text color"), "buttonText", d.buttonText, "color") +
    "</div>"
  );
}

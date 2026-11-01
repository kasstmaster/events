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
  borderColor: "#d2dbd4",
  eyebrowColor: "#64786a",
  eyebrowFont: "system-ui",
  eyebrowSize: 14,
  statusColor: "#42594d",
  statusFont: "system-ui",
  statusSize: 14,
  statusBackground: "#edf2e9",
  toolbarColor: "#294d42",
  toolbarFont: "system-ui",
  toolbarSize: 14,
  toolbarBackground: "#fffdf9",
  inputColor: "#263c35",
  inputBackground: "#ffffff",
  linkColor: "#294d42",
  accentColor: "#b7784c",
  dangerColor: "#9a352b",
  dangerBackground: "#fff5f3",
  notesColor: "#263c35",
  notesFont: "system-ui",
  notesSize: 17,
  notesBackground: "#fffdf9",
};
export const layouts = {
  introText: ["eyebrow", "title", "description"],
  eventInformation: [
    "artwork",
    "eyebrow",
    "title",
    "description",
    "details",
    "deadline",
  ],
  hostHome: ["intro", "actions", "notes", "events"],
  guestHome: ["intro", "events"],
  event: ["information", "actions", "menus", "personal"],
  login: ["intro", "form"],
  admin: ["intro", "defaults", "approvals", "templates", "hosts"],
  toolbar: ["home", "print", "rsvp", "dashboard", "logout"],
  eventButtons: [
    "edit-event",
    "invitation",
    "reminders",
    "cards",
    "delete-event",
    "rsvp",
    "uploads",
  ],
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
    for (const [name, keys] of Object.entries(layer.layouts || {})) {
      if (!(name in layouts)) continue;
      result.layouts[name] = [
        ...keys.filter((key) => layouts[name].includes(key)),
        ...layouts[name].filter((key) => !keys.includes(key)),
      ];
    }
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
  eyebrow: "Text above title",
  title: "Title",
  description: "Description",
  artwork: "Artwork",
  details: "Date and address",
  deadline: "RSVP deadline",
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
  reminders: "Text reminders",
};
export const viewLabels = {
  introText: "Introduction text (all pages)",
  eventInformation: "Event information text and containers",
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
    ["eyebrow", "Text above title"],
    ["status", "Attendance / needed information"],
    ["toolbar", "Toolbar"],
    ["notes", "Private notes"],
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
    [
      ["borderColor", "Border color"],
      ["statusBackground", "Attendance / needed background"],
      ["toolbarBackground", "Toolbar background"],
      ["inputColor", "Input text color"],
      ["inputBackground", "Input background"],
      ["linkColor", "Link color"],
      ["accentColor", "Accent / focus color"],
      ["dangerColor", "Destructive action text color"],
      ["dangerBackground", "Destructive action background"],
      ["notesBackground", "Private notes background"],
    ]
      .map(([key, name]) => field(label(name), key, d[key], "color"))
      .join("") +
    "</div>"
  );
}

// Shared schema: content, role formatting and layout remain independent data.
export const roleDefaults = {
  toolbarSurface: "#fffdf9",
  toolbarOpacity: 96,
  toolbarBorderColor: "#d2dbd4",
  toolbarBorderWidth: 1,
  toolbarBorderStyle: "solid",
  toolbarLabelColor: "#263c35",
  toolbarLabelFont: "system-ui",
  toolbarLabelSize: 17,
  toolbarLabelStyle: "normal",
  buttonSurface: "#fffdf9",
  buttonOpacity: 96,
  buttonBorderColor: "#d2dbd4",
  buttonBorderWidth: 1,
  buttonBorderStyle: "solid",
  buttonLabelColor: "#263c35",
  buttonLabelFont: "system-ui",
  buttonLabelSize: 17,
  buttonLabelStyle: "normal",
  background: "#f3eee8",
  backgroundImage: "",
  containerImage: "",
  containerImageOpacity: 100,
  container: "#fffdf9",
  opacity: 96,
  titleStyle: "normal",
  descriptionStyle: "normal",
  textStyle: "normal",
  borderWidth: 1,
  borderStyle: "solid",
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
// Deterministic compatibility migration. Explicit category keys win; otherwise the
// first saved legacy role in each list supplies that category. Normalize each layer
// before inheritance so an event's legacy override still beats household defaults.
export function categoryDesign(value = {}) {
  const result = { ...value };
  const groups = {
    textColor: [
      "toolbarColor",
      "inputColor",
      "notesColor",
      "buttonText",
      "statusColor",
      "eyebrowColor",
      "linkColor",
      "accentColor",
      "dangerColor",
    ],
    textFont: [
      "toolbarFont",
      "notesFont",
      "buttonFont",
      "statusFont",
      "eyebrowFont",
    ],
    textSize: [
      "toolbarSize",
      "notesSize",
      "buttonSize",
      "statusSize",
      "eyebrowSize",
    ],
    container: [
      "toolbarBackground",
      "inputBackground",
      "notesBackground",
      "statusBackground",
      "dangerBackground",
      "buttonColor",
    ],
  };
  for (const [key, aliases] of Object.entries(groups)) {
    const source = [key, ...aliases].find((k) => Object.hasOwn(value, k));
    if (source !== undefined) {
      result[key] = value[source];
      for (const alias of aliases) result[alias] = value[source];
    }
  }
  // Legacy layers retain their rendered appearance; new editors persist independent roles.
  for (const prefix of ["toolbar", "button"]) {
    const legacy = {
      Surface: result.container,
      Opacity: result.opacity,
      BorderColor: result.borderColor,
      BorderWidth: result.borderWidth,
      BorderStyle: result.borderStyle,
      LabelColor: result.textColor,
      LabelFont: result.textFont,
      LabelSize: result.textSize,
      LabelStyle: result.textStyle,
    };
    for (const [suffix, fallback] of Object.entries(legacy))
      if (!Object.hasOwn(result, prefix + suffix) && fallback !== undefined)
        result[prefix + suffix] = fallback;
  }
  return result;
}
export const appearanceCategories = [
  "Background",
  "Titles",
  "Description",
  "Text",
  "Containers",
  "Toolbars",
  "Buttons",
];
export const independentAppearanceKeys = ["toolbar", "button"].flatMap(
  (prefix) =>
    [
      "Surface",
      "Opacity",
      "BorderColor",
      "BorderWidth",
      "BorderStyle",
      "LabelColor",
      "LabelFont",
      "LabelSize",
      "LabelStyle",
    ].map((suffix) => prefix + suffix),
);
export const appearanceKeys = [
  ...independentAppearanceKeys,
  "background",
  "backgroundImage",
  "titleColor",
  "titleFont",
  "titleSize",
  "titleStyle",
  "descriptionColor",
  "descriptionFont",
  "descriptionSize",
  "descriptionStyle",
  "textColor",
  "textFont",
  "textSize",
  "textStyle",
  "container",
  "containerImage",
  "containerImageOpacity",
  "opacity",
  "borderColor",
  "borderWidth",
  "borderStyle",
];
export function resolveUI(...layers) {
  const result = {
    copy: {},
    design: categoryDesign(roleDefaults),
    layouts: { ...layouts },
  };
  for (const layer of layers) {
    if (!layer) continue;
    Object.assign(result.copy, layer.copy);
    Object.assign(result.design, categoryDesign(layer.design));
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
  invitation: "Invitation",
  "delete-event": "Delete event",
  uploads: "Photo uploads",
  household: "Edit House",
  "new-event": "Create event",
  guests: "Guest list",
  addresses: "Address Book",
  share: "Share",
  cards: "Cards",
  reminders: "Reminders",
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

// Presets are appearance data; all scopes use the same five-category schema.
export function appearancePreset(mode, defaults = roleDefaults) {
  const base = resolveUI({ design: defaults }).design;
  if (mode === "dark")
    Object.assign(base, {
      ...Object.fromEntries(
        ["toolbar", "button"].flatMap((p) => [
          [p + "Surface", "#25282b"],
          [p + "LabelColor", "#f0f2ef"],
          [p + "BorderColor", "#59615d"],
        ]),
      ),
      background: "#151719",
      backgroundImage: "",
      container: "#25282b",
      containerImage: "",
      containerImageOpacity: 100,
      titleColor: "#f4f3ed",
      descriptionColor: "#d3d8d5",
      textColor: "#f0f2ef",
      borderColor: "#59615d",
      opacity: 96,
    });
  return categoryDesign(
    Object.fromEntries(appearanceKeys.map((key) => [key, base[key]])),
  );
}

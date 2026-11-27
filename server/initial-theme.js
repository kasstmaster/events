import { categoryDesign, roleDefaults } from "../public/ui-system.js";

// Produce exactly the same root variables as client/app.js's applyDesign()
// before the browser parses its first frame. The client can still adjust them
// for navigation, appearance editing, and event-specific designs.
const safe = (value) =>
  String(value ?? "").replace(/[;{}<>\u0000-\u001f\u007f]/g, "");
const image = (value) => {
  const source = String(value || "");
  if (!source || !/^(?:https:\/\/|data:image\/|\/)/i.test(source))
    return "none";
  // Quoted CSS URLs are still CSS values: remove structural characters
  // rather than allowing saved appearance data to escape into a style tag.
  return `url("${source.replace(/[<>\u0000-\u001f\u007f]/g, "").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}")`;
};

export function initialThemeStyle(design = {}, defaults = {}) {
  const d = categoryDesign({ ...roleDefaults, ...defaults, ...design });
  const props = {};
  const set = (name, value) => {
    props[name] = safe(value);
  };
  set("--bg", d.background);
  set("--panel-solid", d.container);
  set(
    "--panel",
    d.containerImage
      ? d.background
      : `color-mix(in srgb, ${d.container} ${d.opacity}%, transparent)`,
  );
  for (const prefix of ["toolbar", "button"]) {
    set(`--${prefix}-surface`, d[prefix + "Surface"]);
    set(
      `--${prefix}-panel`,
      `color-mix(in srgb, ${d[prefix + "Surface"]} ${d[prefix + "Opacity"]}%, transparent)`,
    );
    set(`--${prefix}-border-color`, d[prefix + "BorderColor"]);
    set(`--${prefix}-border-width`, d[prefix + "BorderWidth"] + "px");
    set(`--${prefix}-border-style`, d[prefix + "BorderStyle"]);
    set(`--${prefix}-label-color`, d[prefix + "LabelColor"]);
    set(`--${prefix}-label-font`, d[prefix + "LabelFont"]);
    set(`--${prefix}-label-size`, d[prefix + "LabelSize"] + "px");
    set(
      `--${prefix}-label-weight`,
      d[prefix + "LabelStyle"].includes("bold") ? "700" : "400",
    );
    set(
      `--${prefix}-label-style`,
      /italic/i.test(d[prefix + "LabelStyle"]) ? "italic" : "normal",
    );
  }
  set("--heading", d.titleColor);
  set("--ink", d.textColor);
  set("--title-font", d.titleFont);
  set("--body-font", d.textFont);
  set("--title-size", d.titleSize + "px");
  set("--text-size", d.textSize + "px");
  for (const role of [
    "description",
    "button",
    "eyebrow",
    "status",
    "toolbar",
    "notes",
  ]) {
    set(`--${role}-font`, d[role + "Font"]);
    set(`--${role}-size`, d[role + "Size"] + "px");
    set(`--${role}-color`, d[role + "Color"]);
  }
  set("--button-text", d.buttonText);
  for (const key of [
    "borderColor",
    "statusBackground",
    "toolbarBackground",
    "inputColor",
    "inputBackground",
    "linkColor",
    "accentColor",
    "dangerColor",
    "dangerBackground",
    "notesBackground",
  ])
    set("--" + key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase()), d[key]);
  for (const prefix of ["title", "description", "text"]) {
    set(
      `--${prefix}-weight`,
      d[prefix + "Style"].includes("bold") ? "700" : "400",
    );
    set(
      `--${prefix}-style`,
      /italic/i.test(d[prefix + "Style"]) ? "italic" : "normal",
    );
  }
  props["--container-image"] = image(d.containerImage);
  set("--container-image-opacity", String(d.containerImageOpacity / 100));
  set("--border-width", d.borderWidth + "px");
  set("--border-style", d.borderStyle);
  props["--background-image"] = image(d.backgroundImage);
  return `<style id="gather-initial-theme">:root{${Object.entries(props)
    .map(([key, value]) => `${key}:${value}`)
    .join(";")}}</style>`;
}

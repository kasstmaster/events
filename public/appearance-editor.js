import { C, H, ui } from "./ui-runtime.js";
import {
  appearanceCategories,
  appearanceKeys,
  categoryDesign,
  fontOptions,
  resolveUI,
} from "./ui-system.js";
// One draft and toolbar implementation for household, event and platform scopes.
export function appearanceEditor({
  field,
  select,
  fileData,
  notify,
  apply,
  mount,
  measure,
}) {
  let editing = null,
    category = "",
    action = "",
    busy = false,
    revision = 0,
    pendingImage = Promise.resolve();
  const button = (kind, label, id = "") =>
    ui`<button type="button" data-action="appearance-${kind}" data-id="${id}" ${busy ? "disabled" : ""}>${C(label)}</button>`;
  const values = (d) =>
    Object.fromEntries(appearanceKeys.map((k) => [k, d[k]]));
  function controls() {
    const d = editing.draft,
      prefix = { Titles: "title", Description: "description", Text: "text" }[
        category
      ];
    if (action === "copy")
      return (
        select(
          H("Copy formatting from"),
          "appearanceCopy",
          editing.sources.map((s, i) => [String(i), s.label]),
          "",
        ) + button("copy", "Copy Formatting")
      );
    if (prefix) {
      if (action === "Font")
        return select(
          H(category + " font"),
          prefix + "Font",
          fontOptions.map((f) => [f, f]),
          d[prefix + "Font"],
        );
      if (action === "Color")
        return field(
          H(category + " color"),
          prefix + "Color",
          d[prefix + "Color"],
          "color",
        );
      if (action === "Size")
        return field(
          H(category + " size"),
          prefix + "Size",
          d[prefix + "Size"],
          "number",
          `min="${prefix === "title" ? 22 : 14}" max="${prefix === "title" ? 64 : 28}"`,
        );
      if (action === "Style")
        return select(
          H(category + " style"),
          prefix + "Style",
          [
            ["normal", C("Normal")],
            ["bold", C("Bold")],
            ["italic", C("Italic")],
            ["boldItalic", C("Bold italic")],
          ],
          d[prefix + "Style"],
        );
    }
    if (category === "Background") {
      if (action === "Color")
        return field(
          H("Background color"),
          "background",
          d.background,
          "color",
        );
      if (action === "Image")
        return (
          field(
            H("Background image (up to 2 MB)"),
            "appearanceImage",
            "",
            "file",
            'accept="image/png,image/jpeg,image/webp"',
          ) + button("remove-image", "Remove background image")
        );
    }
    if (category === "Containers") {
      if (action === "Image")
        return (
          field(
            H("Containers image (up to 2 MB)"),
            "appearanceContainerImage",
            "",
            "file",
            'accept="image/png,image/jpeg,image/webp"',
          ) +
          field(
            H("Container image opacity (%)"),
            "containerImageOpacity",
            d.containerImageOpacity,
            "number",
            'min="0" max="100"',
          ) +
          button("remove-container-image", "Remove container image")
        );
      if (action === "Background")
        return (
          field(H("Containers background"), "container", d.container, "color") +
          field(
            H("Container opacity (%)"),
            "opacity",
            d.opacity,
            "number",
            'min="35" max="100"',
          )
        );
      if (action === "Border")
        return (
          field(
            H("Containers border color"),
            "borderColor",
            d.borderColor,
            "color",
          ) +
          field(
            H("Border width"),
            "borderWidth",
            d.borderWidth,
            "number",
            'min="0" max="6"',
          ) +
          select(
            H("Border style"),
            "borderStyle",
            [
              ["solid", C("Solid")],
              ["dashed", C("Dashed")],
              ["dotted", C("Dotted")],
              ["none", C("None")],
            ],
            d.borderStyle,
          )
        );
    }
    return "";
  }
  function chrome() {
    if (!editing) return;
    const actions =
      category === "Background"
        ? ["Color", "Image"]
        : category === "Containers"
          ? ["Background", "Image", "Border"]
          : ["Font", "Color", "Style", "Size"];
    const container = mount();
    const options = ui`<details class="appearance-options"><summary>${C("Formatting options")}</summary>${editing.sources.length ? button("action", "Copy Formatting", "copy") : ""}${button("reset", "Reset to Defaults")}${!category ? button("save", "Save") + button("cancel", "Cancel") : ""}</details>`;
    container.innerHTML = ui`<div class="appearance-categories" role="toolbar" aria-label="Appearance categories">${appearanceCategories.map((c) => ui`<button type="button" data-action="appearance-category" data-id="${c}" aria-pressed="${category === c}">${C(c)}</button>`).join("")}</div>${editing.contentActions?.length ? ui`<div class="appearance-content-actions" role="toolbar" aria-label="Event content">${editing.contentActions.map((item) => ui`<button type="button" data-action="${item.action}">${C(item.label)}</button>`).join("")}</div>` : ""}${category ? ui`<div class="appearance-actions" role="toolbar" aria-label="Appearance actions">${actions.map((a) => button("action", a, a)).join("")}${button("save", "Save")}${button("cancel", "Cancel")}${options}</div>` : ""}${action ? ui`<div class="appearance-controls" role="group" aria-label="Appearance controls">${controls()}</div>` : ""}<span class="appearance-error" role="alert"></span>`;
    measure();
  }
  function preview() {
    editing.draft = categoryDesign(editing.draft);
    editing.preview?.(editing.draft);
    apply(editing.draft);
  }
  function cancel() {
    if (!editing || busy) return;
    revision++;
    const e = editing;
    editing = null;
    category = "";
    action = "";
    e.cancel();
  }
  return {
    active: () => !!editing,
    draft: () => editing?.draft,
    start(options) {
      revision++;
      pendingImage = Promise.resolve();
      editing = {
        ...options,
        draft: values(resolveUI({ design: options.design }).design),
        sources: options.sources || [],
      };
      category = "Background";
      action = "";
      busy = false;
      chrome();
      preview();
    },
    chrome,
    async leave() {
      if (!editing) return true;
      if (busy) return false;
      if (
        JSON.stringify(values(editing.draft)) !==
          JSON.stringify(
            values(resolveUI({ design: editing.design }).design),
          ) &&
        !confirm(String(C("Discard unsaved appearance changes?")))
      )
        return false;
      cancel();
      return true;
    },
    async action(name, target) {
      if (!name.startsWith("appearance-")) return false;
      if (!editing || busy) return true;
      const kind = name.slice(11);
      if (kind === "category") {
        category = target.dataset.id;
        action = "";
        chrome();
      } else if (kind === "action") {
        action = target.dataset.id;
        chrome();
      } else if (kind === "cancel") cancel();
      else if (kind === "save") {
        busy = true;
        chrome();
        const draft = editing;
        try {
          await pendingImage;
          editing = null;
          await draft.save(values(draft.draft));
          category = "";
          action = "";
          revision++;
        } catch (error) {
          editing = draft;
          notify(error.message);
        } finally {
          busy = false;
          if (editing) chrome();
        }
      } else if (kind === "reset") {
        if (
          confirm(String(C("Reset all appearance categories to defaults?")))
        ) {
          revision++;
          pendingImage = Promise.resolve();
          editing.draft = values(
            resolveUI({ design: editing.defaults }).design,
          );
          preview();
          chrome();
        }
      } else if (["remove-image", "remove-container-image"].includes(kind)) {
        revision++;
        pendingImage = Promise.resolve();
        editing.draft[
          kind === "remove-image" ? "backgroundImage" : "containerImage"
        ] = "";
        preview();
      } else if (kind === "copy") {
        const source =
          editing.sources[
            Number(mount().querySelector("[name=appearanceCopy]").value)
          ];
        if (source) {
          revision++;
          pendingImage = Promise.resolve();
          editing.draft = values(resolveUI({ design: source.design }).design);
          preview();
          chrome();
        }
      }
      return true;
    },
    async input(event) {
      if (!editing || busy || !event.target.closest(".appearance-controls"))
        return;
      const input = event.target,
        name = input.name,
        current = revision;
      if (["appearanceImage", "appearanceContainerImage"].includes(name)) {
        try {
          pendingImage = fileData(input).then((data) => {
            if (editing && current === revision && data) {
              editing.draft[
                name === "appearanceImage"
                  ? "backgroundImage"
                  : "containerImage"
              ] = data;
              preview();
            }
            return data;
          });
          await pendingImage;
        } catch (error) {
          notify(error.message);
        }
      } else if (appearanceKeys.includes(name)) {
        if (input.type === "number" && (!input.value || !input.checkValidity()))
          return;
        editing.draft[name] =
          input.type === "number" ? Number(input.value) : input.value;
        preview();
      }
    },
  };
}

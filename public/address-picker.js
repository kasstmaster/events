import { addressParts } from "./address-system.js";
import { ui, C, H } from "./ui-runtime.js";
export function addressPicker({
  state,
  field,
  area,
  button,
  escape,
  onChange,
}) {
  let draft = null;
  const form = () => document.querySelector("form[data-form=guest]");
  const addresses = () => state.data.addresses;
  const norm = (value) =>
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
  function selected() {
    return addresses().find((a) => a.id === form()?.elements.address.value);
  }
  function details() {
    const f = form(),
      a = selected(),
      box = f.querySelector("#address-details");
    box.innerHTML = draft
      ? ui`<fieldset><legend>${draft.id ? C("Edit shared address") : C("New shared address")}</legend>${draft.id ? "<p>Saving updates this address for everyone who uses it. Their invite code stays the same.</p>" : ""}${field(H("Address title"), "addressLabel", draft.label || "", "text", 'required maxlength="100"')}${field(H("Street / PO Box"), "addressStreet", addressParts(draft).street, "text", 'maxlength="500" autocomplete="address-line1"')}${field(H("City"), "addressCity", addressParts(draft).city, "text", 'maxlength="100" autocomplete="address-level2"')}<div class="form-grid">${field(H("State"), "addressState", addressParts(draft).state, "text", 'maxlength="100" autocomplete="address-level1"')}${field(H("Zip Code"), "addressZip", addressParts(draft).zip, "text", 'maxlength="30" autocomplete="postal-code"')}</div>${field(H("Address contact phone (optional)"), "addressPhone", draft.phone || "", "tel")}${button("address-cancel-edit", H("Cancel address changes"))}</fieldset>`
      : a
        ? ui`<p><strong>${escape(a.label)}</strong></p><p class="event-details">${escape(a.lines)}</p>${button("address-edit-selected", H("Edit this address"))}${button("address-clear", H("Remove address from guest"))}`
        : "";
  }
  function suggestions() {
    const f = form(),
      query = f.elements.addressSearch.value,
      box = f.querySelector("#address-options");
    const value = norm(query),
      matches = value
        ? addresses()
            .filter((a) => norm(a.label + " " + a.lines).includes(value))
            .slice(0, 10)
        : [];
    const missing = !!query.trim() && !matches.length;
    f.elements.addressSearch.classList.toggle("address-not-found", missing);
    f.elements.addressSearch.setAttribute("aria-invalid", String(missing));
    box.hidden = !query.trim();
    f.elements.addressSearch.setAttribute("aria-expanded", String(!box.hidden));
    box.innerHTML =
      (missing
        ? ui`<p class="address-missing" role="status">Not found</p>`
        : "") +
      matches
        .map(
          (a) =>
            ui`<button type="button" role="option" data-action="address-select" data-id="${escape(a.id)}">${escape(a.label)}<span class="small">${escape(a.lines)}</span></button>`,
        )
        .join("") +
      button("address-create", H("Create new address"));
  }
  return {
    markup(guest) {
      draft = null;
      const a = addresses().find((a) => a.id === guest.address);
      return ui`<div class="address-picker"><input type="hidden" name="address" value="${escape(guest.address || "")}">${field(H("Shared address (optional)"), "addressSearch", a?.label || "", "text", 'autocomplete="off" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="address-options" placeholder="Type an address title or street address"')}<div id="address-options" role="listbox" aria-label="Matching shared addresses" hidden></div><div id="address-details"></div></div>`;
    },
    mount() {
      details();
    },
    input(event) {
      const f = form();
      if (!f || !f.contains(event.target)) return;
      if (event.target.name === "addressSearch") {
        f.elements.address.value = "";
        draft = null;
        details();
        suggestions();
        onChange(f);
      } else if (
        [
          "addressLabel",
          "addressStreet",
          "addressCity",
          "addressState",
          "addressZip",
          "addressPhone",
        ].includes(event.target.name)
      )
        onChange(f);
    },
    action(action, target) {
      if (
        ![
          "address-select",
          "address-create",
          "address-edit-selected",
          "address-clear",
          "address-cancel-edit",
        ].includes(action)
      )
        return false;
      const f = form(),
        query = f.elements.addressSearch.value;
      if (action === "address-select") {
        const a = addresses().find((a) => a.id === target.dataset.id);
        f.elements.address.value = a.id;
        f.elements.addressSearch.value = a.label;
        draft = null;
      }
      if (action === "address-edit-selected") {
        const a = selected();
        draft = { ...a };
      }
      if (action === "address-create") {
        draft = {
          label: /^(?:\d|P\.?O\.?\s+Box\b)/i.test(query) ? "" : query,
          lines: /^(?:\d|P\.?O\.?\s+Box\b)/i.test(query) ? query : "",
        };
        f.elements.address.value = "";
      }
      if (action === "address-clear") {
        draft = null;
        f.elements.address.value = "";
        f.elements.addressSearch.value = "";
      }
      if (action === "address-cancel-edit") {
        draft = null;
        const a = selected();
        f.elements.addressSearch.value = a?.label || "";
      }
      f.elements.addressSearch.classList.remove("address-not-found");
      f.elements.addressSearch.setAttribute("aria-invalid", "false");
      f.querySelector("#address-options").hidden = true;
      f.elements.addressSearch.setAttribute("aria-expanded", "false");
      details();
      onChange(f);
      return true;
    },
    value(f) {
      if (
        !draft &&
        f.elements.addressSearch.value.trim() &&
        !f.elements.address.value
      )
        throw new Error(
          C(
            "Select an address, continue with a new address, or clear the address field.",
          ),
        );
      if (!draft) return undefined;
      return {
        id: draft.id || "",
        version: draft.version,
        label: f.elements.addressLabel.value,
        street: f.elements.addressStreet.value,
        city: f.elements.addressCity.value,
        state: f.elements.addressState.value,
        zip: f.elements.addressZip.value,
        phone: f.elements.addressPhone.value,
      };
    },
    bind() {
      document.addEventListener("keydown", (event) => {
        const f = form();
        if (!f || !f.contains(event.target)) return;
        if (
          event.target.name === "addressSearch" &&
          event.key === "ArrowDown"
        ) {
          event.preventDefault();
          suggestions();
          f.querySelector("#address-options button")?.focus();
        } else if (
          event.target.closest("#address-options") &&
          ["ArrowDown", "ArrowUp", "Escape"].includes(event.key)
        ) {
          event.preventDefault();
          if (event.key === "Escape") {
            f.querySelector("#address-options").hidden = true;
            f.elements.addressSearch.focus();
            return;
          }
          (event.key === "ArrowDown"
            ? event.target.nextElementSibling
            : event.target.previousElementSibling
          )?.focus();
        }
      });
    },
  };
}

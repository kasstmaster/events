import { ui, C, H } from "./ui-runtime.js";
import { topbar } from "./browse-ui.js";
export function recipientManagementUI({
  state,
  api,
  field,
  button,
  select,
  escape,
  render,
  load,
  notify,
}) {
  let person = null,
    security = null,
    address = "";
  const childRow = (child = {}) =>
    ui`<fieldset data-contact-child="${escape(child.id || "")}" data-version="${child.version || 0}"><legend>Child</legend>${field(H("Name"), "childFirst", child.first || "", "text", 'required maxlength="80"')}${field(H("Suffix"), "childSuffix", child.suffix || "", "text", 'maxlength="30"')}</fieldset>`;
  return {
    page() {
      if (state.view === "recipient-security")
        return ui`${topbar({ title: C("Household ID"), back: "page-back" })}<section class="panel"><p>Shared by this recipient household in your Address Book only. Revoking or replacing it immediately closes existing RSVP access. It never opens private individual pages.</p>${field(H("Household ID"), "recipientCode", security.householdID, "text", "readonly")}<p>${security.revoked ? "Revoked" : "Active"}</p><form data-form="recipient-security"><label>Action<select name="operation"><option value="rotate">Replace Household ID</option><option value="revoke">Revoke Household ID</option></select></label><p class="form-error" role="alert"></p><button>Confirm access change</button></form></section>`;
      const children = state.data.guests.filter(
        (g) =>
          g.parent &&
          (address
            ? (g.address ||
                state.data.guests.find((p) => p.id === g.parent)?.address) ===
              address
            : g.parent === person.id),
      );
      return ui`${topbar({ title: C("Children"), back: "page-back" })}<section class="panel"><form data-form="contact-children">${select(H("Shared address"), "childrenAddress", [["", C("Current household")], ...state.data.addresses.map((a) => [a.id, a.label])], address)}<div data-contact-children>${(children.length ? children : [{}]).map(childRow).join("")}</div>${button("recipient-add-child", H("Add another child"))}<p class="form-error" role="alert"></p><button>Save children</button></form></section>`;
    },
    async action(action, target) {
      if (action === "recipient-add-child") {
        document
          .querySelector("[data-contact-children]")
          .insertAdjacentHTML("beforeend", childRow());
        return true;
      }
      if (!["recipient-security", "recipient-children"].includes(action))
        return false;
      person = state.data.guests.find((g) => g.id === target.dataset.id);
      if (!person) throw Error("Save the adult contact first.");
      if (person.parent)
        person = state.data.guests.find((g) => g.id === person.parent);
      address = person.address || "";
      if (action === "recipient-security")
        security = await api("/api/host/recipient-access", {
          method: "POST",
          data: { guest: person.id },
        });
      state.editingGuest = null;
      state.view = action;
      render();
      return true;
    },
    async submit(form) {
      const kind = form.dataset.form;
      if (!["recipient-security", "contact-children"].includes(kind))
        return false;
      if (kind === "recipient-security") {
        if (
          !confirm(
            "Revoke the old Household ID and its active RSVP access? Printed invitations may need a replacement ID.",
          )
        )
          return true;
        security = await api("/api/host/recipient-access", {
          method: "POST",
          data: {
            guest: person.id,
            version: security.version,
            operation: form.elements.operation.value,
            confirm: true,
          },
        });
        notify(
          "Recipient access updated. Share the new ID manually if needed.",
        );
        render();
      } else {
        const children = [...form.querySelectorAll("[data-contact-child]")].map(
          (row) => ({
            id: row.dataset.contactChild || undefined,
            version: Number(row.dataset.version),
            first: row.querySelector('[name="childFirst"]').value,
            suffix: row.querySelector('[name="childSuffix"]').value,
          }),
        );
        await api("/api/host/contact-children", {
          method: "POST",
          data: {
            address: form.elements.childrenAddress.value,
            adult: person.id,
            children,
          },
        });
        state.view = "contacts";
        await load();
        notify("Children saved.");
      }
      return true;
    },
  };
}

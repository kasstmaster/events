import { ui, C, H } from "./ui-runtime.js";
import { topbar, tool } from "./browse-ui.js";
export function personalTools({
  state,
  api,
  field,
  select,
  button,
  notify,
  render,
  load,
}) {
  const current = () => state.data?.personal;
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  function addressFields(prefix, address = {}) {
    return ui`<div class="form-grid">${field(H("Street / PO Box"), prefix + "Street", address.street || "", "text", 'autocomplete="street-address" maxlength="500"')}${field(H("City"), prefix + "City", address.city || "", "text", 'autocomplete="address-level2" maxlength="100"')}${field(H("State"), prefix + "State", address.state || "", "text", 'autocomplete="address-level1" maxlength="80"')}${field(H("Zip Code"), prefix + "Zip", address.zip || "", "text", 'autocomplete="postal-code" maxlength="30"')}</div>`;
  }
  function memberRow(member, members = []) {
    const duplicate =
      members.filter(
        (m) =>
          !m.archived &&
          m.first.trim().toLowerCase() === member.first.trim().toLowerCase() &&
          (m.parent ? "" : m.last || "").trim().toLowerCase() ===
            (member.parent ? "" : member.last || "").trim().toLowerCase(),
      ).length > 1;
    return ui`<fieldset data-personal-member="${esc(member.id || "")}"><legend>${member.parent ? C("Child") : C("Adult")}</legend>${field(H("First name"), "profileFirst", member.first || "", "text", 'required maxlength="80"')}<div data-personal-last ${member.parent ? "hidden" : ""}>${field(H("Last name"), "profileLast", member.last || "", "text", 'maxlength="80"')}</div>${duplicate ? field(H("Suffix"), "profileSuffix", member.suffix || "", "text", 'maxlength="30"') : ui`<input type="hidden" name="profileSuffix" value="${esc(member.suffix || "")}">`}<div data-personal-phone ${member.parent ? "hidden" : ""}>${field(H("Phone number"), "profilePhone", member.phone || "", "tel", 'maxlength="30" autocomplete="tel"')}</div>${select(H("Designated adult"), "profileParent", [["", C("Adult")], ...members.filter((m) => !m.parent && !m.archived && m.id !== member.id).map((m) => [m.id, [m.first, m.last].filter(Boolean).join(" ")])], member.parent || "")}${button("personal-remove-member", H("Remove family entry"))}</fieldset>`;
  }
  function familyFields(data = current()) {
    if (!data) return "";
    const p = data.profile;
    return ui`<input type="hidden" name="profileVersion" value="${p.version}"><fieldset><legend>Physical address</legend>${addressFields("physical", p.physical)}</fieldset><fieldset><legend>Mailing address</legend><label class="check"><input type="checkbox" name="mailingSame" ${p.mailingSame ? "checked" : ""}>${C("Same as physical address")}</label><div data-mailing-fields ${p.mailingSame ? "hidden" : ""}>${addressFields("mailing", p.mailing)}</div></fieldset><fieldset><legend>Family information</legend><div data-personal-members>${p.members
      .filter((m) => !m.archived)
      .map((m) => memberRow(m, p.members))
      .join(
        "",
      )}</div><div class="row">${button("personal-add-adult", H("Add adult"))}${button("personal-add-child", H("Add child"))}</div></fieldset><fieldset><legend>Share updated information</legend>${select(
      H("Who receives updates"),
      "profileSharing",
      [
        ["everyone", C("Everyone who has me as a contact")],
        ["selected", C("Selected contacts")],
      ],
      p.sharing,
    )}<div data-share-recipients>${data.contacts.map((c) => ui`<label class="check"><input type="checkbox" name="profileRecipient" value="${c.id}" ${p.recipients.includes(c.id) ? "checked" : ""} ${c.blocked ? "disabled" : ""}>${esc(c.name)}${c.blocked ? C(" · blocked") : ""}</label>`).join("") || ui`<p>${C("Contacts appear here when someone adds your household.")}</p>`}</div></fieldset>`;
  }
  function collectFamily(form) {
    const fd = new FormData(form),
      address = (prefix) =>
        Object.fromEntries(
          ["street", "city", "state", "zip"].map((key) => [
            key,
            fd.get(prefix + key[0].toUpperCase() + key.slice(1)) || "",
          ]),
        );
    return {
      physical: address("physical"),
      mailing: address("mailing"),
      mailingSame: fd.has("mailingSame"),
      sharing: fd.get("profileSharing"),
      recipients: fd.getAll("profileRecipient"),
      members: [...form.querySelectorAll("[data-personal-member]")].map(
        (row) => ({
          id: row.dataset.personalMember || undefined,
          first: row.querySelector('[name="profileFirst"]').value,
          last: row.querySelector('[name="profileLast"]').value,
          suffix: row.querySelector('[name="profileSuffix"]').value,
          phone: row.querySelector('[name="profilePhone"]').value,
          parent: row.querySelector('[name="profileParent"]').value,
        }),
      ),
    };
  }
  function accountPage() {
    const data = current(),
      a = data.account;
    return ui`${topbar({ title: C("Private sign-in"), back: "home", extra: tool("personal-save", "Save", "", "save") })}<section class="panel"><p>Your username is private. It is never shown to family, friends or hosts.</p><form data-form="personal-account" data-version="${a.version}">${field(H("Username"), "username", a.username, "text", 'required minlength="3" maxlength="80" autocomplete="username"')}${field(H("Recovery phone number"), "recoveryPhone", a.recoveryPhone, "tel", 'required maxlength="30" autocomplete="tel"')}<p class="form-error" role="alert"></p><button>${C("Save")}</button></form>${a.recoveryPhone ? ui`<p>${a.recoveryVerified ? C("Recovery phone verified.") : C("Verify your recovery phone to enable username reminders.")}</p>${a.recoveryVerified ? "" : ui`${button("personal-verify-start", H("Send verification code"))}<form data-form="personal-verify">${field(H("Verification code"), "code", "", "text", 'required inputmode="numeric" maxlength="6"')}<p class="form-error" role="alert"></p><button>${C("Verify")}</button></form>`}` : ""}</section>`;
  }
  function familyPage() {
    return ui`${topbar({ title: C("Family information"), back: "home", extra: tool("personal-save", "Save", "", "save") })}<section class="panel"><form data-form="personal-family">${familyFields()}<p class="form-error" role="alert"></p><button>${C("Save")}</button></form></section>`;
  }
  function contactsPage() {
    const data = current();
    return ui`${topbar({ title: C("Address Book"), back: "home" })}<section class="panel"><form data-form="personal-add-contact">${field(H("Household name"), "name", "", "text", 'required maxlength="100"')}${field(H("Household ID"), "householdId", "", "text", 'required inputmode="numeric" pattern="[0-9]{4}" maxlength="4"')}<p class="form-error" role="alert"></p><button>${C("Add contact")}</button></form><ul class="browse-rows">${data.contacts.map((c) => ui`<li class="browse-row"><div class="grow"><strong>${esc(c.name)}</strong>${c.address ? ui`<p class="contact-mailing-address">${esc(c.address)}</p>` : ""}${c.members ? ui`<ul>${c.members.map((p) => ui`<li>${esc([p.first, p.last, p.suffix].filter(Boolean).join(" "))}${p.child ? C(" · child") : p.phone ? " · " + esc(p.phone) : ""}</li>`).join("")}</ul>` : ""}</div><div class="row">${button("personal-block", H(c.blocked ? "Unblock" : "Block"), `data-id="${c.id}" data-blocked="${c.blocked}"`)}${button("personal-remove-contact", H("Remove"), `data-id="${c.id}"`)}</div></li>`).join("")}</ul></section>`;
  }
  function recoveryPage() {
    return ui`<section class="auth"><h1>Recover username</h1><form data-form="username-recovery">${field(H("Recovery phone number"), "phone", "", "tel", 'required maxlength="30"')}<p>We’ll text your recovery number. Reply YES to receive your username or NO to cancel.</p><p class="form-error" role="alert"></p><button>${C("Request reminder")}</button></form>${button("host-login", H("Back"))}</section>`;
  }
  function homeActions() {
    return ui`<section class="panel guest-account-actions">${button("personal-family", H("Family information"))}${button("personal-contacts", H("Address Book"))}${button("personal-account", H("Private sign-in"))}</section>`;
  }
  return {
    familyFields,
    collectFamily,
    homeActions,
    page: () =>
      state.view === "personal-family"
        ? familyPage()
        : state.view === "personal-contacts"
          ? contactsPage()
          : state.view === "username-recovery"
            ? recoveryPage()
            : accountPage(),
    async action(action, target) {
      if (
        [
          "personal-family",
          "personal-account",
          "personal-contacts",
          "username-recovery",
        ].includes(action)
      ) {
        state.view = action;
        render();
        return true;
      }
      if (action === "personal-save") {
        document
          .querySelector(
            'form[data-form="personal-family"],form[data-form="personal-account"]',
          )
          ?.requestSubmit();
        return true;
      }
      if (action === "personal-add-adult" || action === "personal-add-child") {
        const form = target.closest("form"),
          members = collectFamily(form).members;
        const parent =
          action === "personal-add-child"
            ? members.find((p) => !p.parent)?.id
            : "";
        if (action === "personal-add-child" && !parent)
          throw Error("Save an adult family entry first.");
        form.querySelector("[data-personal-members]").insertAdjacentHTML(
          "beforeend",
          memberRow(
            {
              id: crypto.randomUUID(),
              first: "",
              last: "",
              phone: "",
              parent: parent || "",
            },
            members,
          ),
        );
        form.dataset.dirty = "true";
        return true;
      }
      if (action === "personal-remove-member") {
        const row = target.closest("[data-personal-member]");
        if (row.dataset.personalMember === current().self)
          throw Error("Keep your own adult family entry.");
        row.closest("form").dataset.dirty = "true";
        row.remove();
        return true;
      }
      if (action === "personal-block" || action === "personal-remove-contact") {
        if (
          action === "personal-remove-contact" &&
          !confirm(String(C("Remove this contact from your address book?")))
        )
          return true;
        const data = await api(`/api/personal/contacts/${target.dataset.id}`, {
          method: "PUT",
          version: current().profile.version,
          data: {
            blocked:
              action === "personal-block"
                ? target.dataset.blocked !== "true"
                : false,
            remove: action === "personal-remove-contact",
          },
        });
        state.data.personal = data;
        render();
        return true;
      }
      if (action === "personal-verify-start") {
        await api("/api/personal/phone/start", { method: "POST", data: {} });
        notify(C("Verification code requested."));
        return true;
      }
      return false;
    },
    async submit(form, kind) {
      if (kind === "username-recovery") {
        await api("/api/username-recovery", {
          method: "POST",
          data: Object.fromEntries(new FormData(form)),
        });
        notify(
          C(
            "If this number is eligible, a confirmation text has been requested.",
          ),
        );
        return true;
      }
      if (!kind.startsWith("personal-")) return false;
      let data;
      if (kind === "personal-family")
        data = await api("/api/personal/family", {
          method: "PUT",
          version: Number(form.elements.profileVersion.value),
          data: collectFamily(form),
        });
      else if (kind === "personal-account")
        data = await api("/api/personal/account", {
          method: "PUT",
          version: Number(form.dataset.version),
          data: Object.fromEntries(new FormData(form)),
        });
      else if (kind === "personal-verify") {
        await api("/api/personal/phone/verify", {
          method: "POST",
          data: Object.fromEntries(new FormData(form)),
        });
        data = await api("/api/personal");
      } else if (kind === "personal-add-contact")
        data = await api("/api/personal/contacts", {
          method: "POST",
          data: Object.fromEntries(new FormData(form)),
        });
      if (data) state.data.personal = data;
      delete form.dataset.dirty;
      await load();
      notify(C("Household information saved."));
      return true;
    },
    bind() {
      document.addEventListener("input", (event) => {
        const form = event.target.closest(
          'form[data-form^="personal-"],form[data-form="username-recovery"]',
        );
        if (form) form.dataset.dirty = "true";
      });
      document.addEventListener("change", (event) => {
        const form = event.target.closest("form");
        if (!form) return;
        if (event.target.name === "mailingSame")
          form.querySelector("[data-mailing-fields]").hidden =
            event.target.checked;
        if (event.target.name === "profileParent") {
          const row = event.target.closest("[data-personal-member]"),
            child = !!event.target.value;
          row.querySelector("[data-personal-last]").hidden = child;
          row.querySelector('[name="profileLast"]').required = false;
          row.querySelector("[data-personal-phone]").hidden = child;
        }
      });
    },
  };
}

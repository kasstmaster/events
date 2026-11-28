import { ui, C, H } from "./ui-runtime.js";
import {
  topbar,
  tool,
  addressBookHome,
  addressBookDescription,
} from "./browse-ui.js";
export function personalTools({
  state,
  api,
  field,
  select,
  button,
  notify,
  render,
  load,
  signInControls,
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
    if (state.hostOnly)
      return ui`<fieldset data-personal-member="${esc(member.id || "")}"><legend>${member.parent ? C("Child") : C("Adult")}</legend>${field(H("Name"), "profileFirst", member.first || "", "text", 'required maxlength="80"')}${member.parent ? '<input type="hidden" name="profileLast" value=""><input type="hidden" name="profilePhone" value="">' : field(H("Last name"), "profileLast", member.last || "", "text", 'maxlength="80"') + field(H("Phone number"), "profilePhone", member.phone || "", "tel", 'maxlength="30" autocomplete="tel"')}${field(H("Suffix"), "profileSuffix", member.suffix || "", "text", 'maxlength="30"')}<input type="hidden" name="profileParent" value="${esc(member.parent || "")}">${select(
        H("Shared address"),
        "profileSharedAddress",
        [
          ["physical", C("Physical address")],
          ["mailing", C("Mailing address")],
        ],
        member.sharedAddress || "physical",
      )}${button("personal-remove-member", H("Remove family entry"))}</fieldset>`;

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
  function familyFields(data = current(), includeMembers = true) {
    if (!data) return "";
    const p = data.profile;
    if (state.hostOnly)
      return ui`<input type="hidden" name="profileVersion" value="${p.version}"><div data-layout="personalFamily"><fieldset data-layout-item="physical"><legend>Physical address</legend>${addressFields("physical", p.physical)}</fieldset><fieldset data-layout-item="mailing"><legend>Mailing address</legend><label class="check"><input type="checkbox" name="mailingSame" ${p.mailingSame ? "checked" : ""}>${C("Same as physical address")}</label><div data-mailing-fields ${p.mailingSame ? "hidden" : ""}>${addressFields("mailing", p.mailing)}</div></fieldset>${
        includeMembers
          ? ui`<div data-personal-members>${p.members
              .filter((m) => !m.archived)
              .map((m) => memberRow(m, p.members))
              .join("")}</div>`
          : ""
      }</div>`;

    return ui`<p>${C("Household ID")} · <code>${esc(data.account.householdId || p.publicCode)}</code></p><input type="hidden" name="profileVersion" value="${p.version}"><div data-layout="personalFamily"><fieldset data-layout-item="physical"><legend>Physical address</legend>${addressFields("physical", p.physical)}</fieldset><fieldset data-layout-item="mailing"><legend>Mailing address</legend><label class="check"><input type="checkbox" name="mailingSame" ${p.mailingSame ? "checked" : ""}>${C("Same as physical address")}</label><div data-mailing-fields ${p.mailingSame ? "hidden" : ""}>${addressFields("mailing", p.mailing)}</div></fieldset>${
      includeMembers
        ? ui`<fieldset data-layout-item="members"><legend>Family information</legend><div data-personal-members>${p.members
            .filter((m) => !m.archived)
            .map((m) => memberRow(m, p.members))
            .join(
              "",
            )}</div><div class="row">${button("personal-add-adult", H("Add adult"))}${button("personal-add-child", H("Add child"))}</div></fieldset>`
        : ""
    }<fieldset data-layout-item="sharing"><legend>Share updated information</legend>${select(
      H("Who receives my updated information automatically"),
      "profileSharing",
      [
        ["everyone", C("Everyone who has me as a contact")],
        ["selected", C("Selected contacts")],
      ],
      p.sharing,
    )}<div data-share-recipients>${data.contacts.map((c) => ui`<label class="check"><input type="checkbox" name="profileRecipient" value="${c.id}" ${c.selected ? "checked" : ""} ${c.blocked ? "disabled" : ""}>${esc(c.name)}${c.blocked ? C(" · blocked") : ""}</label>`).join("") || ui`<p>${C("Contacts appear here when someone adds your household as a contact.")}</p>`}</div></fieldset></div>`;
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
    const scope = form.dataset.editScope;
    const existing = current()?.profile;
    if (state.hostOnly && ["person", "children"].includes(scope)) {
      const edited = [...form.querySelectorAll("[data-personal-member]")].map(
        (row) => ({
          id: row.dataset.personalMember || undefined,
          first: row.querySelector('[name="profileFirst"]').value,
          last: row.querySelector('[name="profileLast"]').value,
          suffix: row.querySelector('[name="profileSuffix"]').value,
          phone: row.querySelector('[name="profilePhone"]').value,
          parent: row.querySelector('[name="profileParent"]').value,
          sharedAddress: row.querySelector('[name="profileSharedAddress"]')
            .value,
        }),
      );
      const changed = new Map(edited.map((p) => [p.id, p]));
      return {
        ...existing,
        members: [
          ...existing.members
            .filter((p) => !p.archived)
            .map((p) => changed.get(p.id) || p),
          ...edited.filter(
            (p) => !existing.members.some((old) => old.id === p.id),
          ),
        ],
      };
    }

    if (scope === "person") {
      const row = form.querySelector("[data-personal-member]");
      const person = {
        id: row.dataset.personalMember,
        first: row.querySelector('[name="profileFirst"]').value,
        last: row.querySelector('[name="profileLast"]').value,
        suffix: row.querySelector('[name="profileSuffix"]').value,
        phone: row.querySelector('[name="profilePhone"]').value,
        parent: row.querySelector('[name="profileParent"]').value,
      };
      return {
        ...existing,
        members: existing.members.some((p) => p.id === person.id)
          ? existing.members
              .filter((p) => !p.archived)
              .map((p) => (p.id === person.id ? { ...p, ...person } : p))
          : [...existing.members.filter((p) => !p.archived), person],
      };
    }
    return {
      physical: address("physical"),
      mailing: address("mailing"),
      mailingSame: fd.has("mailingSame"),
      sharing: fd.get("profileSharing"),
      recipients: fd.getAll("profileRecipient"),
      members:
        scope === "details"
          ? existing.members.filter((p) => !p.archived)
          : [...form.querySelectorAll("[data-personal-member]")].map((row) => ({
              id: row.dataset.personalMember || undefined,
              first: row.querySelector('[name="profileFirst"]').value,
              last: row.querySelector('[name="profileLast"]').value,
              suffix: row.querySelector('[name="profileSuffix"]').value,
              phone: row.querySelector('[name="profilePhone"]').value,
              parent: row.querySelector('[name="profileParent"]').value,
            })),
    };
  }
  function accountPage() {
    const data = current(),
      a = data.account;
    if (a.method === "email")
      return ui`${topbar({ title: C("Private sign-in"), back: "page-back" })}<section class="panel"><p>Use your registered email and password.</p>${field(H("Registered email"), "registeredEmail", a.email, "email", "readonly")}</section>`;
    if (a.method === "firebase")
      return ui`${topbar({ title: C("Phone sign-in"), back: "page-back" })}<section class="panel"><p>Your phone sign-in is verified. This device stays signed in until you sign out or access is revoked.</p>${field(H("Verified phone"), "verifiedPhone", a.recoveryPhone || "", "tel", "readonly")}<p>Use Recover Account if you lose access to your phone.</p>${button("recover-account", H("Recover Account"))}</section>`;
    return ui`${topbar({ title: C(a.needsUsername ? "Create private sign-in" : "Private sign-in"), back: a.needsUsername ? "" : "page-back", extra: tool("personal-save", "Save", "", "save") })}<section class="panel" data-layout="personalAccount"><p data-layout-item="description">Your username is private. It is never shown to family, friends or hosts.</p><form data-form="personal-account" data-layout-item="credentials" data-version="${a.version}">${field(H("Username"), "username", a.username, "text", 'required minlength="3" maxlength="80" autocomplete="username"')}${field(H("Recovery phone number"), "recoveryPhone", a.recoveryPhone, "tel", 'required maxlength="30" autocomplete="tel"')}<p class="form-error" role="alert"></p><button>${C("Save")}</button></form></section>`;
  }
  function familyPage(inline = false) {
    const data = current(),
      p = data.profile,
      edit = state.familyMemberEditing;
    const person =
      edit &&
      edit !== "details" &&
      (p.members.find((m) => m.id === edit) || state.familyMemberDraft);
    const childBatch = state.hostOnly && person?.parent;
    const editablePeople = childBatch
      ? [
          ...p.members.filter(
            (m) =>
              m.parent &&
              !m.archived &&
              (m.sharedAddress || "physical") ===
                (person.sharedAddress || "physical"),
          ),
          ...(state.familyMemberDraft ? [state.familyMemberDraft] : []),
        ]
      : person
        ? [person]
        : [];
    const membership = state.centralFamily?.people.find(
      (m) => m.id === person?.id,
    );
    const controls = edit
      ? tool("personal-save", "Save", "", "save") +
        tool("personal-edit-cancel", "Cancel", "", "close")
      : "";
    return ui`${inline ? "" : topbar({ title: C("Family"), back: "page-back", extra: controls })}<section class="panel"><p>${C("Household ID")} · <code>${esc(data.account.householdId || p.publicCode)}</code></p>${
      edit
        ? ui`<form data-form="personal-family" data-edit-scope="${childBatch ? "children" : person ? "person" : "details"}">${person ? ui`<input type="hidden" name="profileVersion" value="${p.version}">${editablePeople.map((m) => memberRow(m, p.members)).join("")}${childBatch ? button("personal-add-another-child", H("Add another child")) : ""}` : familyFields(data, false)}${person?.parent && membership && state.session.role === "host" ? ui`<label class="check"><input type="checkbox" name="allowChildSignIn" ${membership.allowSignIn ? "checked" : ""}>Allow Sign-In</label><p class="small">Child sign-in requires independently verified delivery and administrator approval. Access is limited to authorized Family Workspace records.</p>` : ""}<p class="form-error" role="alert"></p><button>${C("Save")}</button>${inline ? button("personal-edit-cancel", H("Cancel")) : ""}</form>`
        : ui`<ul class="browse-rows">${p.members
            .filter((m) => !m.archived)
            .map(
              (m) =>
                ui`<li class="browse-row"><div class="grow">${esc([m.first, m.parent ? "" : m.last, m.suffix].filter(Boolean).join(" "))}${m.parent ? C(" · child") : ""}</div>${button("personal-edit-member", H("Edit"), `data-id="${esc(m.id)}"`)}</li>`,
            )
            .join(
              "",
            )}</ul><div class="row">${button("personal-add-adult", H("Add adult"))}${button("personal-add-child", H("Add child"))}${button("personal-edit-details", H("Edit family information"))}</div>`
    }</section>`;
  }
  function contactsPage() {
    const data = current();
    return ui`${topbar({ title: C("Address Book"), back: "page-back" })}<section class="panel" data-layout="personalContacts">${addressBookDescription()}<form data-form="personal-add-contact" data-layout-item="add">${field(H("Household name"), "name", "", "text", 'required maxlength="100"')}${field(H("Household ID"), "householdId", "", "text", 'required inputmode="numeric" pattern="[0-9]{4}" maxlength="4"')}<p class="form-error" role="alert"></p><button>${C("Add contact")}</button></form><ul class="browse-rows" data-layout-item="contacts">${data.contacts.map((c) => ui`<li class="browse-row"><div class="grow"><strong>${esc(c.name)}</strong>${c.address ? ui`<p class="contact-mailing-address">${esc(c.address)}</p>` : ""}${c.members ? ui`<ul>${c.members.map((p) => ui`<li>${esc([p.first, p.last, p.suffix].filter(Boolean).join(" "))}${p.child ? C(" · child") : p.phone ? " · " + esc(p.phone) : ""}</li>`).join("")}</ul>` : ""}</div><div class="row">${button("personal-block", H(c.blocked ? "Unblock" : "Block"), `data-id="${c.id}" data-blocked="${c.blocked}"`)}${button("personal-remove-contact", H("Remove"), `data-id="${c.id}"`)}</div></li>`).join("")}</ul></section>`;
  }
  function recoveryPage() {
    return ui`<section class="auth"><h1>Recover Account</h1><form data-form="username-recovery">${field(H("First Name"), "first", "", "text", "required")}${field(H("Last Name"), "last")}${field(H("Household ID"), "householdId", "", "text", 'required pattern="[0-9]{4}" maxlength="4"')}<p class="form-error" role="alert"></p><button>Submit recovery request</button></form>${button("host-login", H("Back"))}</section>`;
  }
  function homeActions() {
    return ui`<div class="guest-account-actions"><section class="panel">${button("personal-family", H("Family information"))}${button("personal-account", H("Private sign-in"))}</section>${addressBookHome(button, "personal-contacts")}</div>`;
  }
  return {
    leave(action, target) {
      const form = document.querySelector(
        'form[data-form^="personal-"][data-dirty="true"],form[data-form="username-recovery"][data-dirty="true"]',
      );
      if (
        !form ||
        target.closest("form") === form ||
        action === "personal-save"
      )
        return true;
      if (!confirm(String(C("Discard unsaved household information?"))))
        return false;
      delete form.dataset.dirty;
      return true;
    },
    familyPage,
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
      if (state.hostOnly && action === "personal-add-another-child") {
        const form = document.querySelector(
          'form[data-form="personal-family"]',
        );
        const parent = current().profile.members.find(
          (m) => !m.parent && !m.archived,
        )?.id;
        target.insertAdjacentHTML(
          "beforebegin",
          memberRow(
            {
              id: crypto.randomUUID(),
              first: "",
              parent,
              sharedAddress: "physical",
            },
            current().profile.members,
          ),
        );
        return true;
      }

      if (
        [
          "personal-family",
          "personal-account",
          "personal-contacts",
          "username-recovery",
        ].includes(action)
      ) {
        state.view = action;
        if (action === "personal-family") {
          state.familyMemberEditing = null;
          state.centralFamily = await api("/api/central/family");
        }
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
      if (
        [
          "personal-edit-member",
          "personal-edit-details",
          "personal-edit-cancel",
        ].includes(action)
      ) {
        state.familyMemberEditing =
          action === "personal-edit-member"
            ? target.dataset.id
            : action === "personal-edit-details"
              ? "details"
              : null;
        state.familyMemberDraft = null;
        render();
        return true;
      }
      if (action === "personal-add-adult" || action === "personal-add-child") {
        const parent =
          action === "personal-add-child"
            ? current().profile.members.find((p) => !p.parent && !p.archived)
                ?.id
            : "";
        if (action === "personal-add-child" && !parent)
          throw Error("Save an adult family entry first.");
        state.familyMemberDraft = {
          id: crypto.randomUUID(),
          first: "",
          last: "",
          phone: "",
          parent: parent || "",
        };
        state.familyMemberEditing = state.familyMemberDraft.id;
        render();
        return true;
      }
      if (action === "personal-remove-member") {
        const key = target.closest("[data-personal-member]").dataset
          .personalMember;
        if (key === current().self)
          throw Error("Keep your own adult family entry.");
        if (!confirm(String(C("Remove this family entry?")))) return true;
        const data = await api("/api/personal/family", {
          method: "PUT",
          version: current().profile.version,
          data: {
            ...current().profile,
            members: current().profile.members.filter(
              (p) => !p.archived && p.id !== key,
            ),
          },
        });
        state.data.personal = data;
        state.familyMemberEditing = null;
        await load();
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
        await load();
        return true;
      }
      return false;
    },
    async submit(form, kind) {
      if (kind === "username-recovery") {
        await api("/api/account-recovery", {
          method: "POST",
          data: Object.fromEntries(new FormData(form)),
        });
        notify(
          C(
            "Your request has been received. The administrator will review it privately.",
          ),
        );
        return true;
      }
      if (!kind.startsWith("personal-")) return false;
      let data;
      if (kind === "personal-family") {
        data = await api("/api/personal/family", {
          method: "PUT",
          version: Number(form.elements.profileVersion.value),
          data: collectFamily(form),
        });
        const child = form.elements.allowChildSignIn;
        const member = state.centralFamily?.people.find(
          (p) => p.id === state.familyMemberEditing,
        );
        if (child && member && child.checked !== member.allowSignIn)
          await api("/api/central/family", {
            method: "POST",
            data: {
              member: member.id,
              version: member.version,
              allowSignIn: child.checked,
            },
          });
        state.familyMemberEditing = null;
        state.familyMemberDraft = null;
        state.centralFamily = await api("/api/central/family");
      } else if (kind === "personal-account")
        data = await api("/api/personal/account", {
          method: "PUT",
          version: Number(form.dataset.version),
          data: Object.fromEntries(new FormData(form)),
        });
      else if (kind === "personal-add-contact")
        data = await api("/api/personal/contacts", {
          method: "POST",
          data: Object.fromEntries(new FormData(form)),
        });
      const completing =
        kind === "personal-account" && current()?.account.needsUsername;
      if (data) state.data.personal = data;
      if (kind === "personal-family" && state.session.role === "host")
        state.familyData = await api("/api/family");
      if (completing && !data.account.needsUsername) state.view = "home";
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

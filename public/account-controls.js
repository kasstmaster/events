import { ui, H } from "/ui-runtime.js";
import { topbar } from "/browse-ui.js";
export function accountControls({
  state,
  api,
  field,
  button,
  notify,
  render,
  load,
}) {
  let nextOffset = null;
  let records = [],
    selected = null,
    disclosure = "",
    challenge = "",
    self = null;
  let privateId =
    location.pathname === "/guest" &&
    /^[A-Za-z0-9_-]{43}$/.test(location.hash.slice(1))
      ? location.hash.slice(1)
      : "";
  if (privateId) {
    history.replaceState(null, "", "/guest");
    state.view = "private-guest-sign-in";
  }
  const esc = (x) =>
    String(x ?? "").replace(
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
  const clearDisclosure = () => {
    disclosure = "";
    const el = document.querySelector("[data-private-disclosure]");
    if (el) el.remove();
  };
  window.addEventListener("blur", clearDisclosure);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearDisclosure();
  });
  const password = () =>
    field(
      H("Current administrator password"),
      "password",
      "",
      "password",
      'required autocomplete="current-password"',
    );
  const administrator = () =>
    state.session?.role === "admin" ||
    (state.session?.role === "host" && state.session.platformAdmin);
  function clearAccounts() {
    records = [];
    selected = null;
    nextOffset = null;
    clearDisclosure();
  }
  function page() {
    if (state.view === "account-management" && !administrator()) {
      clearAccounts();
      return "";
    }
    if (state.view === "private-guest-sign-in")
      return ui`<section class="auth panel"><h1>Private guest sign-in</h1><form data-form="private-guest-access">${challenge ? field(H("Verification code"), "code", "", "text", 'required inputmode="numeric" maxlength="6" autocomplete="one-time-code"') : ui`${field(H("First name"), "first", "", "text", "required")}${field(H("Last name"), "last", "", "text", "required")}${field(H("Household ID"), "householdId", "", "text", 'required inputmode="numeric" pattern="[0-9]{4}" maxlength="4"')}`}<p class="form-error" role="alert"></p><button>${challenge ? "Verify and sign in" : "Send verification code"}</button></form></section>`;
    if (state.view === "own-account")
      return ui`${topbar({ title: "My account", back: "page-back" })}<section class="panel"><form data-form="own-account">${field(H("First name"), "first", self?.first || "", "text", "required")}${field(H("Last name"), "last", self?.last || "")}${field(H("Phone number"), "phone", self?.phone || "", "tel")}${field(H("Address"), "address", self?.physical?.lines || "")}<p class="form-error" role="alert"></p><button>Save</button></form></section>`;
    return ui`${topbar({ title: "Registered accounts", back: "page-back" })}<section class="panel account-management"><form data-form="account-query">${password()}<p class="form-error" role="alert"></p><button>View registered accounts</button><button name="audit" value="true">View restricted audit log</button>${nextOffset !== null ? '<button name="next" value="true">Next account page</button>' : ""}</form>${records.length ? ui`<ul>${records.map((r) => ui`<li>${esc([r.first, r.last].filter(Boolean).join(" ") || r.email)} · ${esc(r.type)} ${button("account-select", "Manage", `data-id="${esc(r.id)}"`)}</li>`).join("")}</ul>` : ""}${selected ? ui`<h2>${esc([selected.first, selected.last].filter(Boolean).join(" ") || selected.email)}</h2><p>${esc(selected.email)} · Household ID ${esc(selected.householdId)} · ${selected.sessions} sessions</p><form data-form="account-edit">${field(H("Registered first name"), "first", selected.first)}${field(H("Registered last name"), "last", selected.last)}${field(H("Registered phone number"), "phone", selected.phone, "tel")}${field(H("Verified sign-in phone"), "verifiedPhone", selected.verifiedPhone || "", "tel", "readonly")}${field(H("Registered physical address"), "physicalAddress", selected.physical?.lines || "")}${field(H("Registered address"), "address", selected.mailing?.lines || "")}<p class="small">A shared family address applies to that central family record. Local Address Book notes remain private.</p><label class="check"><input type="checkbox" name="verifiedOutOfBand">I verified the intended person and phone ownership outside this sign-in attempt.</label><label class="check"><input type="checkbox" name="consented">Security-text delivery is authorized for this number.</label>${password()}<p class="form-error" role="alert"></p><button>Save registered information</button></form><form data-form="account-access"><label>Account security action<select name="action"><option value="revoke">Revoke sessions and authorized devices</option>${selected.type === "family" ? '<option value="reset-password">Reset assigned account password</option>' : ""}${selected.type === "guest" ? '<option value="reveal">Reveal private sign-in URL and ID</option><option value="reset">Regenerate private sign-in URL</option><option value="send">Send private sign-in link</option>' : ""}</select></label>${selected.type === "family" ? field(H("New assigned-account password"), "newPassword", "", "password", 'minlength="12" autocomplete="new-password"') : ""}<label class="check"><input type="checkbox" name="confirm">Confirm this account's URL reset, if selected; the old URL will stop working.</label>${password()}<p class="form-error" role="alert"></p><button>Confirm action</button></form>${disclosure ? ui`<div data-private-disclosure><label>Restricted private sign-in URL<textarea readonly autocomplete="off">${esc(disclosure)}</textarea></label>${field(H("Private URL ID"), "privateUrlId", disclosure.split("#")[1] || "", "text", 'readonly autocomplete="off"')}</div><p class="small">Visible only after your password confirmation. Do not share this with hosts.</p>` : ""}` : ""}<div data-account-audit></div></section>`;
  }
  document.addEventListener(
    "click",
    async (event) => {
      const target = event.target.closest("[data-action]");
      if (!target) return;
      const action = target.dataset.action;
      if (action !== "account-select") {
        clearAccounts();
        self = null;
      }
      if (
        ![
          "account-management",
          "account-select",
          "send-private-link",
          "my-account",
        ].includes(action)
      ) {
        if (state.view === "account-management") {
          records = [];
          selected = null;
          disclosure = "";
        }
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      if (state.preview || state.example) {
        notify("Read-only preview: no account information will be changed.");
        return;
      }
      if (target.disabled) return;
      target.disabled = true;
      try {
        if (
          ["account-management", "account-select"].includes(action) &&
          !administrator()
        )
          throw new Error("System administrator access required.");
        if (action === "account-management") {
          state.view = "account-management";
          render();
        }
        if (action === "account-select") {
          selected = records.find((r) => r.id === target.dataset.id);
          disclosure = "";
          render();
        }
        if (action === "send-private-link") {
          await api("/api/host/guests/" + target.dataset.id + "/sign-in-link", {
            method: "POST",
            data: {},
          });
          notify("Private sign-in link delivery requested.");
        }
        if (action === "my-account") {
          self = await api("/api/account/self");
          state.view = "own-account";
          render();
        }
      } catch (e) {
        notify(e.message);
      } finally {
        target.disabled = false;
      }
    },
    true,
  );
  document.addEventListener(
    "submit",
    async (event) => {
      const form = event.target,
        kind = form.dataset.form;
      if (
        ![
          "account-query",
          "account-edit",
          "account-access",
          "private-guest-access",
          "own-account",
        ].includes(kind)
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (state.preview || state.example) {
        notify("Read-only preview: no account information will be changed.");
        return;
      }
      if (form.dataset.saving) return;
      form.dataset.saving = "true";
      const data = Object.fromEntries(new FormData(form));
      const buttons = [...form.querySelectorAll("button")];
      buttons.forEach((b) => (b.disabled = true));
      try {
        if (kind === "account-query") {
          const audit = event.submitter?.name === "audit";
          const result = await api(
            audit ? "/api/admin/account-audit" : "/api/admin/accounts",
            {
              method: "POST",
              data: {
                password: data.password,
                offset: event.submitter?.name === "next" ? nextOffset : 0,
              },
            },
          );
          form.reset();
          disclosure = "";
          selected = null;
          if (audit) {
            render();
            document.querySelector("[data-account-audit]").textContent =
              result.entries
                .map(
                  (r) =>
                    new Date(r.at).toLocaleString() +
                    " · " +
                    r.action +
                    " · " +
                    r.subject,
                )
                .join("\n");
          } else {
            records = result.accounts;
            nextOffset = result.nextOffset;
            render();
          }
        }
        if (kind === "account-edit") {
          const changed = {};
          if (data.first !== selected.first) changed.first = data.first;
          if (data.last !== selected.last) changed.last = data.last;
          if (
            data.phone !== selected.phone ||
            (data.verifiedOutOfBand === "on" && data.consented === "on")
          )
            changed.phone = data.phone;
          if (data.address !== (selected.mailing?.lines || ""))
            changed.address = { lines: data.address };
          if (data.physicalAddress !== (selected.physical?.lines || ""))
            changed.physicalAddress = { lines: data.physicalAddress };
          const result = await api("/api/admin/account", {
            method: "POST",
            data: {
              id: selected.id,
              action: "update",
              version: selected.version,
              accountVersion: selected.accountVersion,
              password: data.password,
              verifiedOutOfBand: data.verifiedOutOfBand === "on",
              consented: data.consented === "on",
              ...changed,
            },
          });
          records = records.map((r) => (r.id === result.id ? result : r));
          selected = result;
          disclosure = "";
          render();
          notify("Registered information updated.");
        }
        if (kind === "account-access") {
          const result = await api("/api/admin/account", {
            method: "POST",
            data: {
              id: selected.id,
              action: data.action,
              authVersion: selected.authVersion,
              newPassword: data.newPassword,
              password: data.password,
              linkVersion: selected.linkVersion,
              confirm: data.confirm === "on" ? selected.id : null,
            },
          });
          form.reset();
          disclosure = result.url || "";
          if (disclosure) setTimeout(clearDisclosure, 60000);
          if (result.version) selected.linkVersion = result.version;
          render();
          notify("Account security action completed.");
        }
        if (kind === "own-account") {
          await api("/api/account/self", {
            method: "PUT",
            version: self.version,
            data: {
              first: data.first,
              last: data.last,
              phone: data.phone,
              physical: { lines: data.address },
              mailing: { lines: data.address },
            },
          });
          state.view = "home";
          await load();
        }
        if (kind === "private-guest-access") {
          if (!challenge) {
            const result = await api("/api/guest-access/start", {
              method: "POST",
              data: { ...data, privateId },
            });
            challenge = result.challenge;
            render();
          } else {
            await api("/api/guest-access/verify", {
              method: "POST",
              data: { challenge, code: data.code },
            });
            privateId = "";
            challenge = "";
            history.replaceState(null, "", "/");
            state.view = "home";
            await load();
          }
        }
      } catch (e) {
        const error = form.querySelector(".form-error");
        if (error) error.textContent = e.message;
      } finally {
        delete form.dataset.saving;
        buttons.forEach((b) => (b.disabled = false));
      }
    },
    true,
  );
  return { page };
}

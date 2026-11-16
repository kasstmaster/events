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
  let membershipRoster = null,
    enrollmentURL = "";
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
    enrollmentURL = "";
    for (const el of document.querySelectorAll("[data-private-disclosure]"))
      el.remove();
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
    membershipRoster = null;
    records = [];
    selected = null;
    nextOffset = null;
    clearDisclosure();
  }
  function membershipPanel() {
    return ui`<section class="panel"><h2>Central family membership</h2><p>Independent identity review is required. This does not create separate family accounts or send messages.</p><form data-form="membership-query"><label>Host household<select name="household" aria-label="Host household" required><option value="">Choose a household</option>${(state.data?.hosts || []).map((host) => ui`<option value="${esc(host.household)}">${esc(host.householdName || host.email)} · ${esc(host.subdomain || "")}</option>`).join("")}</select></label>${password()}<p class="form-error" role="alert"></p><button>Review family membership</button></form>${
      membershipRoster
        ? ui`<h3>${esc(membershipRoster.name)}</h3><form data-form="membership-action"><label>Person<select name="identity" aria-label="Person">${membershipRoster.people.map((p) => ui`<option value="${esc(p.identity)}">${esc([p.first, p.last].filter(Boolean).join(" "))} · ${p.parent ? "child" : "adult"} · ${esc(p.status)}</option>`).join("")}</select></label><label>Reviewed action<select name="action" aria-label="Reviewed action"><option value="approve-adult">Approve verified adult membership</option><option value="approve-child">Approve child Allow Sign-In</option><option value="child-device">Prepare guardian-mediated child device enrollment</option><option value="adulthood">Review child becoming adult</option><option value="release">Release adult into independent guest household</option></select></label>${field(H("Independently verified own phone (leave empty for guardian delivery)"), "phone", "", "tel")}<label>Verified guardian<select name="guardian" aria-label="Verified guardian"><option value="">Choose guardian</option>${membershipRoster.people
            .filter((p) => !p.parent)
            .map(
              (p) =>
                ui`<option value="${esc(p.identity)}">${esc([p.first, p.last].filter(Boolean).join(" "))}</option>`,
            )
            .join(
              "",
            )}</select></label><label class="check"><input type="checkbox" name="reviewedIdentity" required>I independently reviewed this person's identity and membership.</label><label class="check"><input type="checkbox" name="verifiedOutOfBand">I independently verified the phone owner and delivery authorization.</label><label class="check"><input type="checkbox" name="consented">Security-text delivery is authorized.</label><label class="check"><input type="checkbox" name="guardianConsent">The verified designated guardian approved child-specific delivery and enrollment.</label><label class="check"><input type="checkbox" name="verifiedAge">I independently verified this child's adulthood transition.</label><label class="check"><input type="checkbox" name="remainHousehold" checked>Remain in this household pending adult membership approval.</label>${password()}<p class="form-error" role="alert"></p><button>Confirm reviewed membership action</button></form>`
        : ""
    }${enrollmentURL ? ui`<div data-private-disclosure><label>Restricted child-device enrollment URL<textarea readonly autocomplete="off">${esc(enrollmentURL)}</textarea></label><p>Expires in 10 minutes. Open only in the guardian-approved child's browser. It enrolls a device; it does not sign in.</p></div>` : ""}</section>`;
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
    return ui`${topbar({ title: "Registered accounts", back: "page-back" })}<section class="panel account-management">${button("account-recovery", H("Account Recovery"))}<form data-form="account-query">${password()}<p class="form-error" role="alert"></p><button>View registered accounts</button><button name="audit" value="true">View restricted audit log</button>${nextOffset !== null ? '<button name="next" value="true">Next account page</button>' : ""}</form>${records.length ? ui`<ul>${records.map((r) => ui`<li>${esc([r.first, r.last].filter(Boolean).join(" ") || r.email)} · ${esc(r.type)} ${button("account-select", "Manage", `data-id="${esc(r.id)}"`)}</li>`).join("")}</ul>` : ""}${selected ? ui`<h2>${esc([selected.first, selected.last].filter(Boolean).join(" ") || selected.email)}</h2><p>${esc(selected.email)} · Household ID ${esc(selected.householdId)} · ${selected.sessions} sessions</p><form data-form="account-edit">${field(H("Registered first name"), "first", selected.first)}${field(H("Registered last name"), "last", selected.last)}${field(H("Registered phone number"), "phone", selected.phone, "tel")}${field(H("Verified sign-in phone"), "verifiedPhone", selected.verifiedPhone || "", "tel", "readonly")}${field(H("Registered physical address"), "physicalAddress", selected.physical?.lines || "")}${field(H("Registered address"), "address", selected.mailing?.lines || "")}<p class="small">A shared family address applies to that central family record. Local Address Book notes remain private.</p><label class="check"><input type="checkbox" name="verifiedOutOfBand">I verified the intended person and phone ownership outside this sign-in attempt.</label><label class="check"><input type="checkbox" name="consented">Security-text delivery is authorized for this number.</label>${password()}<p class="form-error" role="alert"></p><button>Save registered information</button></form>${state.passwordless?.enrollmentAvailable ? ui`<form data-form="account-passwordless"><h3>Passwordless enrollment</h3>${field(H("Phone for passwordless enrollment"), "enrollPhone", selected.verifiedPhone || selected.phone, "tel", "readonly")}<p>Use only after independently verifying the registered phone. This does not send a message.</p><label class="check"><input name="verifiedOutOfBand" type="checkbox" required>I verified the intended person and registered phone ownership independently.</label><label class="check"><input name="consented" type="checkbox" required>Security-text delivery is authorized.</label>${password()}<p class="form-error" role="alert"></p><button>Enroll verified phone for sign-in links</button></form>` : ""}<form data-form="account-access"><label>Account security action<select name="action"><option value="revoke">Revoke sessions and authorized devices</option>${selected.type === "family" ? '<option value="reset-password">Reset assigned account password</option>' : ""}${selected.type === "guest" ? '<option value="reveal">Reveal private sign-in URL and ID</option><option value="reset">Regenerate private sign-in URL</option>' : ""}</select></label>${selected.type === "family" ? field(H("New assigned-account password"), "newPassword", "", "password", 'minlength="12" autocomplete="new-password"') : ""}<label class="check"><input type="checkbox" name="confirm">Confirm this account's URL reset, if selected; the old URL will stop working.</label>${password()}<p class="form-error" role="alert"></p><button>Confirm action</button></form>${disclosure ? ui`<div data-private-disclosure><label>Restricted private sign-in URL<textarea readonly autocomplete="off">${esc(disclosure)}</textarea></label>${field(H("Private URL ID"), "privateUrlId", disclosure.split("#")[1] || "", "text", 'readonly autocomplete="off"')}</div><p class="small">Visible only after your password confirmation. Do not share this with hosts.</p>` : ""}` : ""}<div data-account-audit></div></section>${state.passwordless?.enrollmentAvailable ? membershipPanel() : ""}`;
  }
  document.addEventListener(
    "click",
    async (event) => {
      const target = event.target.closest("[data-action]");
      if (!target) return;
      const action = target.dataset.action;
      if (action === "account-recovery") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!administrator()) return;
        state.view = "account-recovery";
        render();
        return;
      }
      if (action !== "account-select") {
        clearAccounts();
        self = null;
      }
      if (
        !["account-management", "account-select", "my-account"].includes(action)
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
          "membership-query",
          "membership-action",
          "account-edit",
          "account-access",
          "account-passwordless",
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
        if (kind === "membership-query") {
          membershipRoster = await api("/api/admin/central-membership", {
            method: "POST",
            data: {
              action: "list",
              household: data.household,
              password: data.password,
            },
          });
          clearDisclosure();
          form.reset();
          render();
        }
        if (kind === "membership-action") {
          const person = membershipRoster.people.find(
            (p) => p.identity === data.identity,
          );
          if (!person) throw Error("Review the current family roster first.");
          if (
            ["release", "adulthood"].includes(data.action) &&
            !confirm(
              "Confirm this reviewed membership change? Existing sessions will be revoked.",
            )
          )
            return;
          const result = await api("/api/admin/central-membership", {
            method: "POST",
            data: {
              ...data,
              household: membershipRoster.household,
              version: person.version,
              profileVersion: membershipRoster.profileVersion,
              allowSignIn: data.action === "approve-child",
              ...Object.fromEntries(
                [
                  "reviewedIdentity",
                  "verifiedOutOfBand",
                  "consented",
                  "guardianConsent",
                  "verifiedAge",
                  "remainHousehold",
                ].map((k) => [k, data[k] === "on"]),
              ),
            },
          });
          clearDisclosure();
          enrollmentURL = result.url || "";
          if (enrollmentURL) setTimeout(clearDisclosure, 60000);
          membershipRoster = null;
          form.reset();
          render();
          notify(
            "Reviewed membership action completed. No messages were sent.",
          );
        }
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
        if (kind === "account-passwordless") {
          await api("/api/admin/passwordless/enroll", {
            method: "POST",
            data: {
              subject: selected.id,
              phone: data.enrollPhone,
              version: selected.passwordlessVersion,
              password: data.password,
              verifiedOutOfBand: data.verifiedOutOfBand === "on",
              consented: data.consented === "on",
            },
          });
          selected = null;
          render();
          notify("Verified phone enrolled. No messages were sent.");
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

export function recoveryUI({ state, api, field, button, render }) {
  let records = [],
    nextOffset = null,
    grant = "";
  const esc = (v) =>
    String(v ?? "").replace(
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
  const password = () =>
    field(
      H("Current administrator password"),
      "password",
      "",
      "password",
      'required autocomplete="current-password"',
    );
  function clear() {
    grant = "";
    records = [];
    nextOffset = null;
    for (const el of document.querySelectorAll("[data-recovery-grant]"))
      el.remove();
  }
  window.addEventListener("blur", clear);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clear();
  });
  return {
    page() {
      if (!(state.session?.role === "admin" || state.session?.platformAdmin)) {
        clear();
        return "";
      }
      return ui`${topbar({ title: "Account Recovery", back: "page-back" })}<section class="panel"><form data-form="recovery-list">${password()}<p class="form-error" role="alert"></p><button>Review recovery requests</button></form>${records.map((r) => ui`<article><h2>${esc(r.first)} ${esc(r.last)}</h2><p>${esc(r.status)} · ${esc(new Date(r.at).toLocaleString())} · Household ID ${esc(r.householdId)}</p>${r.account ? ui`<p>${esc(r.account.phone)} · ${esc(r.account.email)} · ${esc(r.account.mailing?.lines)}</p><h3>Existing Address Book relationships</h3><ul>${r.contacts.map((c) => ui`<li>${esc(c.household)} · ${esc(c.email)} · ${esc(c.phone)}</li>`).join("")}</ul>` : "<p>No unambiguous account match. Investigate independently; these hints are not proof of identity.</p>"}<form data-form="recovery-action" data-id="${esc(r.id)}" data-version="${r.version}"><label>Action<select name="action"><option value="review">Record review</option><option value="authorize">Authorize verified-phone re-enrollment</option><option value="reject">Reject request</option></select></label>${field(H("Review notes"), "review", r.review || "", "text", 'required maxlength="2000"')}${!r.subject ? field(H("Reviewed central account ID"), "subject", "", "text", 'placeholder="person:… or user:…"') : ""}${field(H("Replacement phone"), "phone", "", "tel")}<label class="check"><input type="checkbox" name="verifiedIdentity">I independently verified the intended person; a host statement alone is not sufficient.</label>${password()}<p class="form-error" role="alert"></p><button>Confirm reviewed action</button></form></article>`).join("")}${nextOffset !== null ? ui`<form data-form="recovery-list" data-offset="${nextOffset}">${password()}<p class="form-error" role="alert"></p><button>Next recovery page</button></form>` : ""}${grant ? ui`<label data-recovery-grant>Replacement enrollment link · expires in 30 minutes<textarea readonly>${esc(grant)}</textarea></label><p>Deliver personally only after independent identity review. Firebase will verify the replacement phone. This is not a Firebase code.</p>` : ""}</section>`;
    },
    async submit(form) {
      const data = Object.fromEntries(new FormData(form));
      if (form.dataset.form === "recovery-list") {
        const result = await api("/api/admin/account-recovery", {
          method: "POST",
          data: {
            ...data,
            action: "list",
            offset: Number(form.dataset.offset || 0),
          },
        });
        records = result.records;
        nextOffset = result.nextOffset;
        grant = "";
      } else {
        const result = await api("/api/admin/account-recovery", {
          method: "POST",
          data: {
            ...data,
            id: form.dataset.id,
            version: Number(form.dataset.version),
            verifiedIdentity: data.verifiedIdentity === "on",
          },
        });
        grant = result.recoveryURL || "";
        records = [];
        nextOffset = null;
      }
      render();
    },
    clear,
  };
}

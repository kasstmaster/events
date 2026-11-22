import { ui, C, H } from "./ui-runtime.js";
import { topbar, row } from "./browse-ui.js";
export function hostAdminUI({
  state,
  api,
  field,
  select,
  button,
  escape,
  render,
  notify,
}) {
  let hosts = [],
    invitations = [],
    plan = null,
    signupURL = "",
    selected = null,
    filter = "",
    sort = "name",
    pendingInvite = null;
  const passwordField = () =>
    field(
      H("Current system administrator password"),
      "password",
      "",
      "password",
      'required autocomplete="current-password"',
    );
  return {
    directory: () => hosts,
    page() {
      if (state.view === "admin-approvals")
        return ui`${topbar({ title: C("Host registration"), back: "home" })}<section class="panel"><h2>Issue a temporary registration link</h2><form data-form="host-admin-invite">${field(H("Invited email address"), "email", "", "email", "required")}${select(H("Existing household · adult host member only"), "household", [["", "New household"], ...[...new Map((state.data.hosts || []).map((h) => [h.household, h])).values()].map((h) => [h.household, h.householdName || h.name || h.email])], "")}${select(H("Existing adult family entry · optional"), "rosterMember", [["", "Create a new family entry"], ...hosts.flatMap((h) => h.members.filter((m) => !m.child).map((m) => [m.id, h.name + " · " + [m.first, m.last].filter(Boolean).join(" ")]))], "")}${field(H("Approved adult member name"), "memberName", "", "text")}<label class="check"><input type="checkbox" name="approvedAdult">I explicitly approve this adult to manage the selected household.</label>${passwordField()}<p class="form-error" role="alert"></p><button>Create registration link</button></form>${pendingInvite ? ui`<form data-form="host-admin-revoke-invite"><p>Revoke ${escape(pendingInvite.email)} registration link?</p>${passwordField()}<p class="form-error" role="alert"></p><button>Revoke registration link</button></form>` : ""}${signupURL ? ui`<p>Share this link privately. Email ownership verification is still required.</p>${field(H("Registration link"), "issuedSignupLink", signupURL, "text", "readonly")}` : ""}</section><section class="panel"><h2>Load household family members</h2><form data-form="host-admin-directory">${passwordField()}<p class="form-error" role="alert"></p><button>Load household family members</button></form><h2>Registration links</h2><form data-form="host-admin-invite-list">${passwordField()}<p class="form-error" role="alert"></p><button>Load links</button></form><ul class="browse-rows">${invitations.map((item) => row({ title: escape(item.email) + (item.used ? " · used" : item.revoked ? " · revoked" : item.expires < Date.now() ? " · expired" : " · pending"), action: "host-admin-revoke-invite", id: item.id, symbol: "contacts" })).join("")}</ul></section>${this.transitionPage()}`;
      return ui`${topbar({ title: C("Hosts"), back: "home" })}<section class="panel"><form data-form="host-admin-directory">${passwordField()}<p class="form-error" role="alert"></p><button>Load registered hosts</button></form>${hosts.length ? button("wedding-import-open", H("Import existing wedding content")) : ""}${field(H("Search registered hosts"), "hostDirectorySearch", filter, "search")}<label>Sort<select name="hostDirectorySort"><option value="name" ${sort === "name" ? "selected" : ""}>Household</option><option value="email" ${sort === "email" ? "selected" : ""}>Email</option></select></label><ul class="browse-rows">${hosts
        .filter((h) =>
          (h.name + " " + h.email + " " + h.subdomain)
            .toLowerCase()
            .includes(filter.toLowerCase()),
        )
        .sort((a, b) => String(a[sort]).localeCompare(String(b[sort])))
        .map((h) =>
          row({
            title:
              escape(h.name) +
              " · " +
              escape(h.email) +
              (h.enabled ? "" : " · disabled"),
            action: "host-admin-edit",
            id: h.id,
            symbol: "contacts",
          }),
        )
        .join("")}</ul></section>${selected ? this.hostPage(selected) : ""}`;
    },
    transitionPage() {
      return ui`<section class="panel"><h2>Prepare host-only transition</h2><p>This prepares recoverable local Address Books and strong recipient IDs. It does not enable replacement mode or deploy anything. Existing printed short IDs require reissuance.</p><form data-form="host-admin-transition">${plan ? ui`<p>Review each current adult host account. Existing owners must remain approved.</p>${plan.households.map((h) => ui`<fieldset><legend>${escape(h.name)}</legend>${h.users.map((u) => ui`<label class="check"><input type="checkbox" name="approvedAdults" value="${escape(u.id)}" ${u.id === h.owner ? "checked" : ""}>${escape(u.email)}</label>`).join("")}</fieldset>`).join("")}${field(H("Type PREPARE HOST-ONLY TRANSITION"), "confirm", "", "text", "required")}` : ""}${passwordField()}<p class="form-error" role="alert"></p><button>${plan ? "Prepare reviewed transition" : "Review transition"}</button></form></section>`;
    },
    hostPage(host) {
      return ui`<section class="panel"><h2>${escape(host.name)}</h2><p>${escape(host.email)} · ${escape(host.subdomain || "")}.ilymmd.com</p><ul>${host.members.map((m) => ui`<li>${escape([m.first, m.last, m.suffix].filter(Boolean).join(" "))}${m.child ? " · child" : m.phone ? " · " + escape(m.phone) : ""}</li>`).join("")}</ul><form data-form="host-admin-member"><label>Action<select name="operation"><option value="revoke">Sign out all host devices</option><option value="membership">${host.enabled ? "Disable host access" : "Restore approved host access"}</option><option value="recover">Recover this host account</option></select></label>${field(H("Confirm registered host email"), "confirmEmail", "", "email", "required")}${passwordField()}${field(H("New password · for recovery"), "newPassword", "", "password", 'minlength="12" autocomplete="new-password"')}${field(H("Confirm new password"), "confirmPassword", "", "password", 'autocomplete="new-password"')}<label class="check"><input type="checkbox" name="disconnectGoogle">Disconnect Google during recovery</label><p class="form-error" role="alert"></p><button>Confirm account action</button></form><form data-form="host-admin-identity">${field(H("Household name"), "name", host.name, "text", "required")}${field(H("Household domain label"), "subdomain", host.subdomain || "", "text")}${passwordField()}<p class="form-error" role="alert"></p><button>Save household identity</button></form></section>`;
    },
    async submit(form) {
      const kind = form.dataset.form,
        values = Object.fromEntries(new FormData(form));
      if (!kind.startsWith("host-admin-")) return false;
      if (kind === "host-admin-revoke-invite") {
        if (!confirm("Revoke this registration link?")) return true;
        await api("/api/admin/host-signup-invitations", {
          method: "POST",
          data: {
            password: values.password,
            operation: "revoke",
            id: pendingInvite.id,
            version: pendingInvite.version,
          },
        });
        pendingInvite.revoked = true;
        pendingInvite = null;
      }
      if (kind === "host-admin-invite") {
        const result = await api("/api/admin/host-signup-invitations", {
          method: "POST",
          data: {
            ...values,
            approvedAdult: new FormData(form).has("approvedAdult"),
          },
        });
        signupURL = result.url;
      }
      if (kind === "host-admin-invite-list") {
        invitations = (
          await api("/api/admin/host-signup-invitations", {
            method: "POST",
            data: { password: values.password, operation: "list" },
          })
        ).invitations;
      }
      if (kind === "host-admin-directory") {
        hosts = (
          await api("/api/admin/host-management", {
            method: "POST",
            data: values,
          })
        ).hosts;
        selected = null;
      }
      if (kind === "host-admin-transition") {
        if (!plan)
          plan = await api("/api/admin/host-transition", {
            method: "POST",
            data: values,
          });
        else {
          if (
            !confirm(
              "Prepare the reviewed transition? Existing guest data stays saved; printed short IDs will need reissuance.",
            )
          )
            return true;
          await api("/api/admin/host-transition", {
            method: "POST",
            data: {
              ...values,
              operation: "prepare",
              fingerprint: plan.fingerprint,
              approvedAdults: new FormData(form).getAll("approvedAdults"),
            },
          });
          plan = null;
          notify(
            "Transition prepared; production activation remains disabled.",
          );
        }
      }
      if (kind === "host-admin-member") {
        if (
          !confirm(
            "Confirm this security change? Affected host sessions will be revoked.",
          )
        )
          return true;
        await api("/api/admin/host-management", {
          method: "POST",
          data: {
            ...values,
            user: selected.id,
            accountVersion: selected.accountVersion,
            membershipVersion: selected.membershipVersion,
            enabled: !selected.enabled,
            disconnectGoogle: new FormData(form).has("disconnectGoogle"),
          },
        });
        hosts = [];
        selected = null;
        notify(
          "Host account action completed. Reload the directory to review.",
        );
      }
      if (kind === "host-admin-identity") {
        await api(`/api/admin/households/${selected.household}/identity`, {
          method: "PUT",
          version: selected.householdVersion,
          data: values,
        });
        hosts = [];
        selected = null;
        notify(
          "Household identity saved; existing routing safeguards remain in place.",
        );
      }
      form.querySelector('[name="password"]').value = "";
      render();
      return true;
    },
    async action(action, target) {
      if (action === "host-admin-edit") {
        selected = hosts.find((h) => h.id === target.dataset.id);
        render();
        return true;
      }
      if (action === "host-admin-revoke-invite") {
        const item = invitations.find((i) => i.id === target.dataset.id);
        if (item.used || item.revoked) return true;
        selected = null;
        state.view = "admin-approvals";
        pendingInvite = item;
        render();
        return true;
      }
      return false;
    },
    search(target) {
      if (target.name === "hostDirectorySearch") {
        filter = target.value;
        return true;
      }
      if (target.name === "hostDirectorySort") {
        sort = target.value;
        return true;
      }
      return false;
    },
  };
}

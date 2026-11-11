import { ui, C, H } from "./ui-runtime.js";
import { topbar } from "./browse-ui.js";
export function guestAccessTools({
  state,
  api,
  field,
  select,
  button,
  escape,
  notify,
  render,
  load,
  modal,
}) {
  let privateId =
    location.pathname === "/guest" &&
    /^[A-Za-z0-9_-]{43}$/.test(location.hash.slice(1))
      ? location.hash.slice(1)
      : "";
  let challenge = null,
    draft = null,
    resendAt = 0,
    own = null,
    admin = null,
    actor = "";
  function page(example = false) {
    if (challenge && !example)
      return ui`<section class="auth"><h1>Verify your sign-in</h1><p>Enter the six-digit code sent to your verified contact. It expires in 10 minutes.</p><form data-form="guest-access-verify">${field(H("Verification code"), "code", "", "text", 'required inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code"')}<p class="form-error" role="alert"></p><button>Verify and sign in</button></form>${button("guest-access-resend", H("Resend code"))}<p>Wait at least one minute before requesting another code.</p></section>`;
    return ui`<section class="auth"><h1>Guest sign-in</h1><p>Use your own private sign-in link. New browsers need a verification code from your verified phone.</p>${!privateId && !example ? ui`<p>Open the private sign-in link Gather sent you. Contact the administrator if you need secure phone enrollment or recovery.</p>` : ui`<form data-form="guest-access-start">${field(H("First Name"), "first", example ? "Alex" : draft?.first || "", "text", 'required maxlength="80" autocomplete="given-name"')}${field(H("Last Name"), "last", example ? "Example" : draft?.last || "", "text", 'required maxlength="80" autocomplete="family-name"')}${field(H("Household ID"), "householdId", example ? "0123" : draft?.householdId || "", "password", 'required inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="off"')}<p class="form-error" role="alert"></p><button>Sign In</button></form>`}</section>`;
  }
  async function start() {
    const result = await api("/api/guest-access/start", {
      method: "POST",
      data: { ...draft, privateId },
    });
    challenge = result.challenge;
    resendAt = Date.now() + result.resendAfter * 1000;
    render();
  }
  async function loadSettings() {
    own = null;
    try {
      own = await api("/api/guest-access/self");
    } catch (error) {
      own = { unavailable: error.message };
    }
  }
  function settingsPage() {
    const url = state.example
      ? "https://example.invalid/guest#example-private-page"
      : own?.url;
    return ui`${topbar({ title: C("Private sign-in"), back: "page-back" })}<section class="panel"><h1>Your private guest sign-in</h1><p>Keep your link private. It never signs anyone in by itself. A new browser must also verify a code sent to your verified phone.</p>${url ? ui`${field(H("Your private sign-in link"), "ownGuestLink", url, "text", "readonly autocomplete=off")}${button("guest-access-copy", H("Copy my sign-in link"))}` : ""}${own?.unavailable && !state.example ? ui`<p role="alert">${escape(own.unavailable)}</p>` : ""}<p>Contact the administrator for secure phone enrollment or recovery. Do not give verification codes to anyone.</p>${button("guest-access-revoke", H("Sign out other devices"))}</section>`;
  }
  async function adminOpen(household, offset = 0) {
    const result = await api(
      `/api/admin/guest-access-list/${household}?offset=${offset}`,
    );
    admin = { household, offset, ...result };
    modal(
      C("Guest sign-in access"),
      ui`<p>Private links and verified contacts are administrator-only. Never copy a guest’s link into host notes or exports.</p>${select(
        H("Guest"),
        "accessGuest",
        result.guests.map((g) => [g.guest, g.name]),
      )}${select(H("Action"), "accessAction", [
        ["retrieve", C("Retrieve private sign-in link")],
        ["reset", C("Reset private sign-in link")],
        ["enroll", C("Verified phone enrollment")],
      ])}${field(H("Current administrator password"), "password", "", "password", 'required autocomplete="current-password"')}${field(H("Verified phone number · enrollment only"), "phone", "", "tel", 'autocomplete="off"')}<label class="check"><input type="checkbox" name="verifiedOutOfBand">I verified the intended guest and phone ownership outside this sign-in attempt.</label><label class="check"><input type="checkbox" name="consented">The guest authorized security texts to this number.</label>${field(H("Guest first and last name · reset only"), "confirm")}<div id="guest-access-admin-result"></div>${offset ? button("guest-access-prev", H("Previous guests")) : ""}${result.nextOffset !== null ? button("guest-access-next", H("More guests")) : ""}`,
      "guest-access-admin",
      C("Continue"),
    );
  }
  return {
    page,
    settingsPage,
    loadSettings,
    onSession(session) {
      const next = [
        session?.role,
        session?.household?.id,
        session?.user,
        session?.guest,
      ].join(":");
      if (actor !== next) {
        own = null;
        admin = null;
        actor = next;
      }
      if (session?.role === "guest" && location.pathname === "/guest") {
        history.replaceState(null, "", "/");
        privateId = "";
        challenge = null;
        draft = null;
      }
    },
    async action(action, target) {
      if (action === "guest-access-resend") {
        if (Date.now() < resendAt)
          throw Error(C("Wait one minute before requesting another code."));
        await start();
        return true;
      }
      if (action === "guest-access-copy") {
        const input = document.querySelector('[name="ownGuestLink"]');
        try {
          await navigator.clipboard.writeText(input.value);
          notify(C("Private sign-in link copied."));
        } catch {
          input.select();
          notify(C("Select and copy your private sign-in link."));
        }
        return true;
      }
      if (action === "guest-access-revoke") {
        if (confirm(String(C("Sign out your other guest devices?")))) {
          await api("/api/guest-access/self", { method: "POST", data: {} });
          notify(C("Other guest devices signed out."));
        }
        return true;
      }
      if (action === "guest-send-private-link") {
        await api(`/api/host/guests/${target.dataset.id}/sign-in-link`, {
          method: "POST",
          data: {},
        });
        notify(
          C(
            "Sign-in link submitted for delivery to the guest’s verified contact. Delivery is not confirmed.",
          ),
        );
        return true;
      }
      if (action === "admin-guest-access") {
        await adminOpen(target.dataset.id);
        return true;
      }
      if (action === "guest-access-next" || action === "guest-access-prev") {
        await adminOpen(
          admin.household,
          action === "guest-access-next"
            ? admin.nextOffset
            : Math.max(0, admin.offset - 100),
        );
        return true;
      }
      return false;
    },
    async submit(form, kind) {
      if (kind === "guest-access-start") {
        draft = Object.fromEntries(new FormData(form));
        await start();
        return true;
      }
      if (kind === "guest-access-verify") {
        await api("/api/guest-access/verify", {
          method: "POST",
          data: { challenge, code: form.elements.code.value },
        });
        form.reset();
        challenge = null;
        draft = null;
        privateId = "";
        history.replaceState(null, "", "/");
        state.view = "home";
        await load();
        return true;
      }
      if (kind === "guest-access-admin") {
        const value = Object.fromEntries(new FormData(form)),
          guest = admin.guests.find((g) => g.guest === value.accessGuest),
          action = value.accessAction;
        if (!guest) throw Error(C("Choose a guest."));
        if (
          action === "reset" &&
          !confirm(
            String(
              C(
                "Reset this guest’s private link and sign out all their guest devices?",
              ),
            ),
          )
        )
          return true;
        const result = await api("/api/admin/guest-access", {
          method: "POST",
          version:
            action === "enroll" ? guest.contactVersion : guest.linkVersion,
          data: {
            household: admin.household,
            guest: guest.guest,
            action,
            password: value.password,
            phone: value.phone,
            confirm: value.confirm,
            verifiedOutOfBand: form.elements.verifiedOutOfBand.checked,
            consented: form.elements.consented.checked,
          },
        });
        form.elements.password.value = "";
        form.querySelector("#guest-access-admin-result").innerHTML = result.url
          ? field(
              H("Private guest sign-in link · administrator only"),
              "adminGuestLink",
              result.url,
              "text",
              "readonly autocomplete=off",
            )
          : ui`<p>Verified contact saved. Existing guest sessions were revoked.</p>`;
        if (result.version) guest.linkVersion = result.version;
        else guest.contactVersion++;
        return true;
      }
      return false;
    },
  };
}

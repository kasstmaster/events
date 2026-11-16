import { takeAuthFragment } from "./auth-bootstrap.js";
import { ui, C, H } from "./ui-runtime.js";
export function passwordlessUI({
  state,
  api,
  field,
  button,
  render,
  load,
  notify,
  escape,
}) {
  const fragment = takeAuthFragment();
  let pending =
    location.pathname === "/signin" &&
    /^#[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/.test(fragment)
      ? fragment.slice(1).split(".")
      : null;
  let transfer =
    location.pathname === "/signin"
      ? new URLSearchParams(fragment.slice(1))
      : new URLSearchParams();
  if (location.pathname === "/signin" && location.hash)
    history.replaceState(null, "", "/signin");
  let message = "";
  const entry = () =>
    /^\/([a-z0-9][a-z0-9-]{1,61}[a-z0-9])$/.exec(location.pathname)?.[1] || "";
  const invitation = () =>
    /^\/invite\/([A-Za-z0-9_-]{43})$/.exec(location.pathname)?.[1] || "";
  async function transferTo(destination, ref = "") {
    const origin = new URL(destination).origin;
    if (origin === location.origin) return false;
    location.replace(
      origin +
        "/signin#transfer-start=" +
        encodeURIComponent(location.origin) +
        (ref ? "&invitation=" + encodeURIComponent(ref) : ""),
    );
    return true;
  }
  async function afterAuthentication(result = {}) {
    const ref = result.invitation || invitation();
    if (ref) {
      const view = await api(
        "/api/invitations/" + encodeURIComponent(ref) + "/resolve",
      );
      if (view.authenticated) {
        if (await transferTo(view.destination, ref)) return;
        state.event = view.invitationKey;
        state.view = "home";
      }
    } else {
      const { home } = await api("/api/passwordless/home");
      if (await transferTo(home)) return;
    }
    history.replaceState(null, "", "/");
  }
  return {
    async initialize(config) {
      state.passwordless = config;
      if (config.pwa && !document.querySelector('link[rel="manifest"]')) {
        const manifest = document.createElement("link");
        manifest.rel = "manifest";
        manifest.href = "/api/app/manifest";
        document.head.append(manifest);
        const icon = document.createElement("link");
        icon.rel = "apple-touch-icon";
        icon.href = "/api/app/icon?size=192";
        document.head.append(icon);
        const favicon = document.createElement("link");
        favicon.rel = "icon";
        favicon.href = "/api/app/icon?size=192";
        document.head.append(favicon);
        const branding = await api("/api/app/manifest");
        document.title = branding.name;
        if ("serviceWorker" in navigator)
          navigator.serviceWorker
            .register("/gather-sw.js", { scope: "/" })
            .catch(() => {});
      }
      if (config.enabled && transfer.toString()) {
        const current = transfer;
        transfer = new URLSearchParams();
        try {
          if (current.has("enroll-child")) {
            const [reference, token] = current.get("enroll-child").split(".");
            await api("/api/central/child-device", {
              method: "POST",
              data: { reference, token },
            });
            message =
              "This child’s browser is enrolled. Use the shared name-and-phone sign-in form.";
            return;
          }
          if (current.has("transfer-start")) {
            const result = await api("/api/passwordless/handoff/prepare", {
              method: "POST",
              data: {
                source: current.get("transfer-start"),
                invitation: current.get("invitation"),
              },
            });
            location.replace(result.url);
            return;
          }
          if (current.has("transfer-request")) {
            const result = await api("/api/passwordless/handoff/authorize", {
              method: "POST",
              data: { request: current.get("transfer-request") },
            });
            location.replace(result.url);
            return;
          }
          if (current.has("transfer")) {
            const [request, token] = current.get("transfer").split(".");
            const result = await api("/api/passwordless/handoff/redeem", {
              method: "POST",
              data: { request, token },
            });
            await afterAuthentication(result);
          }
        } catch {
          message =
            "This installed app needs its own sign-in. Request a link inside this app or use account recovery.";
        }
      }
      if (pending) {
        const [challenge, token] = pending;
        pending = null;
        if (config.enabled)
          try {
            const result = await api("/api/passwordless/redeem", {
              method: "POST",
              data: { challenge, token },
            });
            await afterAuthentication(result);
          } catch {
            message =
              "This link could not sign you in. Request a new link in this browser, or use account recovery.";
          }
      }
    },
    async goHome() {
      const { home } = await api("/api/passwordless/home");
      return transferTo(home);
    },
    async resolveInvitation() {
      if (state.session?.role && invitation())
        await afterAuthentication({ invitation: invitation() });
    },
    entry,
    page() {
      return ui`<section class="auth"><p class="eyebrow">${state.publicHousehold ? escape(state.publicHousehold.name) : C("Welcome to Gather")}</p><h1>Sign in</h1><form data-form="passwordless-login">${field(H("First Name"), "first", "", "text", 'required maxlength="80" autocomplete="given-name"')}${field(H("Last Name"), "last", "", "text", 'maxlength="80" autocomplete="family-name"')}${field(H("Phone Number"), "phone", "", "tel", 'required maxlength="30" autocomplete="tel"')}<p class="form-error" role="alert"></p><button>Send Sign-In Link</button></form><p role="status">${message ? C(message) : ""}</p><p class="small">Open the link in the browser where you requested it. Installed apps may need their own sign-in.</p>${button("passwordless-legacy", H("Administrator / account recovery"))}</section>`;
    },
    securityPage() {
      return ui`<section class="auth panel"><h1>Signed in</h1><p>Administrator tools require a separate password confirmation.</p><form data-form="passwordless-step-up">${field(H("System administrator password"), "password", "", "password", 'required autocomplete="current-password"')}<p class="form-error" role="alert"></p><button>Open administrator tools</button></form>${button("passwordless-revoke", H("Sign out other devices"))}${button("passwordless-revoke-all", H("Sign out all devices"))}${button("logout", H("Sign Out"))}</section>`;
    },
    async stepUp(form) {
      await api("/api/passwordless/admin/step-up", {
        method: "POST",
        data: Object.fromEntries(new FormData(form)),
      });
      state.view = "home";
      await load();
    },
    async submit(form) {
      message = (
        await api("/api/passwordless/start", {
          method: "POST",
          data: {
            ...Object.fromEntries(new FormData(form)),
            entry: entry(),
            invitation: invitation(),
          },
        })
      ).message;
      render();
      return true;
    },
    async action(action) {
      if (action === "passwordless-admin-open") {
        state.view = "passwordless-security";
        render();
        return true;
      }
      if (action === "passwordless-legacy") {
        state.passwordlessLegacy = true;
        render();
        return true;
      }
      if (action === "passwordless-revoke-all") {
        if (!confirm(String(C("Sign out on all devices?")))) return true;
        await api("/api/passwordless/sessions/revoke-all", {
          method: "POST",
          data: {},
        });
        state.view = "home";
        state.event = null;
        await load();
        notify(C("All devices signed out."));
        return true;
      }
      if (action === "passwordless-revoke") {
        await api("/api/passwordless/sessions/revoke", {
          method: "POST",
          data: {},
        });
        notify(C("Other devices signed out."));
        return true;
      }
      return false;
    },
  };
}

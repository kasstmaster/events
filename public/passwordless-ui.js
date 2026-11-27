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
  let message = "",
    confirmation = null,
    attempt = null,
    recovering = false;
  const centralOrigin = "https://gather.ilymmd.com";
  let loginContext =
    new URLSearchParams(fragment.slice(1)).get("login-context") || "";
  let loginEntry = "",
    loginInvitation = "",
    loginEnrollment = false,
    handoffFailed = false;
  const recovery = new URLSearchParams(fragment.slice(1)).get("recover") || "";
  async function centralSignIn(enroll = false) {
    const result = await api("/api/firebase/routing/start", {
      method: "POST",
      data: {
        entry: state.publicHousehold?.subdomain || entry(),
        invitation: invitation(),
        ...(enroll ? { enroll: true } : {}),
      },
    });
    if (result.authenticated) return false;
    if (new URL(result.url).origin !== centralOrigin)
      throw Error("Unsupported sign-in destination.");
    location.replace(result.url);
    return true;
  }
  const entry = () =>
    loginEntry ||
    /^\/([a-z0-9][a-z0-9-]{1,61}[a-z0-9])$/.exec(location.pathname)?.[1] ||
    "";
  const invitation = () =>
    loginInvitation ||
    /^\/invite\/([A-Za-z0-9_-]{43})$/.exec(location.pathname)?.[1] ||
    "";
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
    if (loginContext) {
      const routed = await api("/api/firebase/routing/complete", {
        method: "POST",
        data: { reference: loginContext },
      });
      loginContext = "";
      loginEnrollment = false;
      if (await transferTo(routed.destination, routed.invitation)) return true;
      result = { ...result, invitation: routed.invitation };
    }
    const ref = result.invitation || invitation();
    if (ref) {
      const view = await api(
        "/api/invitations/" + encodeURIComponent(ref) + "/resolve",
      );
      if (view.authenticated) {
        if (await transferTo(view.destination, ref)) return true;
        state.event = view.invitationKey;
        state.view = "home";
      }
    } else {
      const { home } = await api("/api/passwordless/home");
      if (await transferTo(home)) return true;
    }
    history.replaceState(null, "", "/");
    return false;
  }
  return {
    async initialize(config) {
      state.passwordless = config;
      if (loginContext && !loginEntry && config.firebaseEnabled) {
        try {
          const context = await api("/api/firebase/routing/context", {
            method: "POST",
            data: { reference: loginContext },
          });
          loginEntry = context.entry;
          loginInvitation = context.invitation;
          loginEnrollment = context.enrollment;
          if (loginEnrollment) state.view = "firebase-enrollment";
        } catch {
          handoffFailed = true;
          loginContext = "";
          message =
            "This sign-in context expired. Open your household or invitation again.";
        }
      }
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
        api("/api/app/manifest")
          .then((branding) => {
            document.title = branding.name;
          })
          .catch(() => {});
        if ("serviceWorker" in navigator)
          navigator.serviceWorker
            .register("/gather-sw.js", { scope: "/" })
            .catch(() => {});
      }
      if (config.enabled && transfer.toString() && !recovery && !loginContext) {
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
            return "redirect";
          }
          if (current.has("transfer-request")) {
            const result = await api("/api/passwordless/handoff/authorize", {
              method: "POST",
              data: { request: current.get("transfer-request") },
            });
            location.replace(result.url);
            return "redirect";
          }
          if (current.has("transfer")) {
            const [request, token] = current.get("transfer").split(".");
            const result = await api("/api/passwordless/handoff/redeem", {
              method: "POST",
              data: { request, token },
            });
            return (await afterAuthentication(result))
              ? "redirect"
              : "redeemed";
          }
        } catch {
          handoffFailed = true;
          message =
            "This installed app could not finish sign-in. Continue in your browser or use Recover Account.";
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
            return (await afterAuthentication(result))
              ? "redirect"
              : "redeemed";
          } catch {
            message =
              "This link could not sign you in. Request a new link in this browser, or use account recovery.";
          }
      }
    },
    async routeSignIn(session, household) {
      if (
        !state.passwordless?.firebaseEnabled ||
        state.preview ||
        state.passwordlessLegacy ||
        state.view === "private-guest-sign-in" ||
        handoffFailed
      )
        return false;
      if (location.origin === centralOrigin) {
        if (
          !session.role &&
          !loginContext &&
          (invitation() || household?.subdomain)
        ) {
          const result = await api("/api/firebase/routing/start", {
            method: "POST",
            data: {
              entry: household?.subdomain || "",
              invitation: invitation(),
            },
          });
          if (new URL(result.url).origin !== centralOrigin)
            throw Error("Unsupported sign-in destination.");
          location.replace(result.url);
          return true;
        }
        if (
          loginContext &&
          session.role &&
          session.passwordless &&
          !loginEnrollment
        ) {
          try {
            return await afterAuthentication();
          } catch {
            loginContext = "";
            message = "This account cannot open that household or invitation.";
            notify(C(message));
            return false;
          }
        }
        return false;
      }
      if (session.role) return false;
      if (recovery) {
        location.replace(
          centralOrigin + "/#recover=" + encodeURIComponent(recovery),
        );
        return true;
      }
      const result = await api("/api/firebase/routing/start", {
        method: "POST",
        data: { entry: household?.subdomain || "", invitation: invitation() },
      });
      if (result.authenticated) return false;
      if (new URL(result.url).origin !== centralOrigin)
        throw Error("Unsupported sign-in destination.");
      location.replace(result.url);
      return true;
    },
    async resolveInvitation() {
      if (state.session?.role && invitation())
        await afterAuthentication({ invitation: invitation() });
    },
    entry,
    page() {
      if (recovering)
        return ui`<section class="auth"><h1>Recover Account</h1><form data-form="passwordless-login">${field(H("First Name"), "first", "", "text", "required")}${field(H("Last Name"), "last")}${field(H("Household ID"), "householdId", "", "text", 'required pattern="[0-9]{4}" maxlength="4" inputmode="numeric"')}<p class="form-error" role="alert"></p><button>Submit recovery request</button></form><p role="status">${escape(message)}</p>${button("firebase-back", "Back to sign in")}</section>`;
      if (state.passwordless?.firebaseEnabled || state.passwordless?.firebase)
        return ui`<section class="auth"><p class="eyebrow">${state.publicHousehold ? escape(state.publicHousehold.name) : C("Welcome to Gather")}</p><h1>Sign in</h1><form data-form="passwordless-login">${confirmation ? field(H("Verification code"), "code", "", "text", 'required pattern="[0-9]{6}" maxlength="6" inputmode="numeric" autocomplete="one-time-code"') : field(H("First Name"), "first", "", "text", 'required maxlength="80" autocomplete="given-name"') + field(H("Last Name"), "last", "", "text", 'maxlength="80" autocomplete="family-name"') + field(H("Phone Number"), "phone", "", "tel", 'required maxlength="30" autocomplete="tel"')}${confirmation && loginEnrollment ? field(H("Current owner password"), "ownerPassword", "", "password", 'required maxlength="256" autocomplete="current-password"') : ""}<div id="firebase-recaptcha"></div><p class="form-error" role="alert"></p><button>${confirmation ? C("Verify and sign in") : C("Send verification code")}</button></form><p role="status">${escape(message)}</p><p class="small">Your device stays signed in until you sign out, unless access is revoked or stored credentials are removed. Installed apps may use separate browser storage. If verification cannot open in this app, use the same sign-in page in your browser.</p>${handoffFailed ? ui`<p><a href="https://gather.ilymmd.com/">Continue sign-in in your browser</a></p>` : ""}${button("recover-account", H("Recover Account"))}${button("passwordless-legacy", H("Administrator / account recovery"))}</section>`;
      return ui`<section class="auth"><p class="eyebrow">${state.publicHousehold ? escape(state.publicHousehold.name) : C("Welcome to Gather")}</p><h1>Sign in</h1><form data-form="passwordless-login">${field(H("First Name"), "first", "", "text", 'required maxlength="80" autocomplete="given-name"')}${field(H("Last Name"), "last", "", "text", 'maxlength="80" autocomplete="family-name"')}${field(H("Phone Number"), "phone", "", "tel", 'required maxlength="30" autocomplete="tel"')}<p class="form-error" role="alert"></p><button>Send Sign-In Link</button></form><p role="status">${message ? C(message) : ""}</p><p class="small">Open the link in the browser where you requested it. Installed apps may need their own sign-in.</p>${button("recover-account", H("Recover Account"))}${button("passwordless-legacy", H("Administrator / account recovery"))}</section>`;
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
      if (recovering) {
        message = (
          await api("/api/account-recovery", {
            method: "POST",
            data: Object.fromEntries(new FormData(form)),
          })
        ).message;
        render();
        return true;
      }
      if (state.passwordless?.firebaseEnabled || state.passwordless?.firebase) {
        if (location.origin !== centralOrigin)
          return centralSignIn(state.view === "firebase-enrollment");
        if (!confirmation) {
          const input = Object.fromEntries(new FormData(form));
          attempt = await api("/api/firebase/start", {
            method: "POST",
            data: {
              ...input,
              entry: entry(),
              invitation: invitation(),
              ...(loginContext ? { context: loginContext } : {}),
            },
          });
          if (attempt.authenticated) {
            await load();
            return true;
          }
          confirmation = await requestFirebaseCode(
            state.passwordless.firebase,
            input.phone,
            "firebase-recaptcha",
          );
          message = "Enter the verification code sent to your phone.";
          render();
          return true;
        }
        const code = new FormData(form).get("code");
        const idToken = await confirmFirebaseCode(confirmation, code);
        const result = await api("/api/firebase/verify", {
          method: "POST",
          data: {
            reference: attempt.reference,
            idToken,
            recovery,
            ...(loginEnrollment
              ? { ownerPassword: new FormData(form).get("ownerPassword") }
              : {}),
          },
        });
        confirmation = null;
        attempt = null;
        await afterAuthentication(result);
        await load();
        return true;
      }
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
      if (action === "firebase-enroll") {
        if (location.origin !== centralOrigin) return centralSignIn(true);
        state.view = "firebase-enrollment";
        render();
        return true;
      }
      if (action === "recover-account" || action === "firebase-back") {
        recovering = action === "recover-account";
        if (state.session?.role) state.view = "firebase-enrollment";
        message = "";
        confirmation = null;
        attempt = null;
        render();
        return true;
      }
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

// Lazy-loaded only after separately approved Firebase activation and an explicit
// sign-in request. Gather's server cookie, not SDK persistence, authorizes the app.
let auth, sdk, verifier;
async function requestFirebaseCode(config, phone, container) {
  if (location.origin !== "https://gather.ilymmd.com")
    throw Error("Continue verification through Gather.");
  const app =
    await import("https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js");
  sdk =
    await import("https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js");
  auth ||= sdk.getAuth(app.getApps()[0] || app.initializeApp(config));
  await sdk.setPersistence(auth, sdk.inMemoryPersistence);
  verifier?.clear();
  verifier = new sdk.RecaptchaVerifier(auth, container, { size: "normal" });
  try {
    return await sdk.signInWithPhoneNumber(auth, phone, verifier);
  } catch {
    verifier.clear();
    verifier = null;
    throw new Error(
      "Verification could not start. Try again later or use Recover Account.",
    );
  }
}
async function confirmFirebaseCode(confirmation, code) {
  try {
    const result = await confirmation.confirm(code);
    return await result.user.getIdToken(true);
  } catch {
    throw new Error(
      "Verification could not be completed. Check the code or use Recover Account.",
    );
  } finally {
    if (auth) await sdk.signOut(auth);
  }
}

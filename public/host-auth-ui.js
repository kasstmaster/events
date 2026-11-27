import { topbar } from "./browse-ui.js";
import { takeHostFragment } from "./auth-bootstrap.js";
import { ui, C, H } from "./ui-runtime.js";
export function hostAuthUI({
  state,
  api,
  field,
  button,
  escape,
  render,
  load,
  fileData,
  familyLogoChoice,
  notify,
}) {
  const parameters = new URLSearchParams(takeHostFragment().slice(1));
  let invite = parameters.get("invite") || "",
    verification = parameters.get("verify") || "",
    reset = parameters.get("reset") || "";
  let transfer = parameters.get("host-transfer") || "",
    request = parameters.get("host-transfer-request") || "",
    source = parameters.get("host-transfer-start") || "",
    completed = false;
  let screen = reset
      ? "reset"
      : verification
        ? "verify"
        : invite
          ? "signup"
          : location.pathname === "/host-recovery"
            ? "recover"
            : "login",
    message =
      parameters.get("host") === "google-failed"
        ? "Google sign-in could not be completed. Try again or use email and password."
        : "";
  addEventListener("gather-host-fragment", () => {
    const next = new URLSearchParams(takeHostFragment().slice(1));
    if (next.get("verify")) {
      verification = next.get("verify");
      screen = "verify";
    } else if (next.get("reset")) {
      reset = next.get("reset");
      screen = "reset";
    } else if (next.get("invite")) {
      invite = next.get("invite");
      screen = "signup";
    }
    if (state.hostOnly) load();
  });
  let config = {},
    invitationContext = null,
    hostPWA = false;

  const central = () => config.centralOrigin || "https://gather.ilymmd.com";
  let firebaseClient, firebasePendingRegistration;
  async function firebase() {
    if (!config.firebase || location.origin !== central())
      throw Error("Use the shared Gather host sign-in page.");
    if (firebaseClient) return firebaseClient;
    const [app, sdk] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js"),
    ]);
    const application =
      app.getApps().find((a) => a.name === "gather-host") ||
      app.initializeApp(config.firebase, "gather-host");
    const auth = sdk.getAuth(application);
    // The durable Gather session is HttpOnly; do not save Firebase credentials
    // in local storage or expose them to guest event pages.
    await sdk.setPersistence(auth, sdk.inMemoryPersistence);
    firebaseClient = { auth, sdk };
    return firebaseClient;
  }
  async function firebaseSignIn(
    values,
    intent = "login",
    provider = "password",
  ) {
    if (location.origin !== central()) {
      location.assign(
        intent === "signup"
          ? central() + "/host-signup#invite=" + encodeURIComponent(invite)
          : central() + "/signin",
      );
      return false;
    }
    const { auth, sdk } = await firebase();
    if (provider === "google") {
      await sdk.signInWithPopup(auth, new sdk.GoogleAuthProvider());
    } else if (intent === "signup") {
      try {
        await sdk.createUserWithEmailAndPassword(
          auth,
          values.email,
          values.password,
        );
      } catch (error) {
        if (error?.code !== "auth/email-already-in-use") throw error;
        await sdk.signInWithEmailAndPassword(
          auth,
          values.email,
          values.password,
        );
      }
    } else {
      try {
        await sdk.signInWithEmailAndPassword(
          auth,
          values.email,
          values.password,
        );
      } catch (error) {
        if (
          ![
            "auth/invalid-credential",
            "auth/wrong-password",
            "auth/user-not-found",
          ].includes(error?.code)
        )
          throw error;
        throw Error(
          intent === "connect"
            ? "Firebase couldn’t sign you in. Use your Firebase password or Google to verify your email, then enter your existing Gather password."
            : "Firebase couldn’t sign you in with that email and password. If you use an administrator account, choose Administrator sign-in and use your Gather password. Otherwise, try Google or reset your Firebase password.",
        );
      }
    }
    await sdk.reload(auth.currentUser);
    if (!auth.currentUser.emailVerified) {
      if (intent === "signup")
        await sdk.sendEmailVerification(auth.currentUser);
      firebasePendingRegistration = intent === "signup" ? values : null;
      screen = intent === "signup" ? "verify" : "login";
      message =
        "Verify your email using Firebase, then return here to continue.";
      render();
      return false;
    }
    const data = {
      intent,
      idToken: await auth.currentUser.getIdToken(true),
      ...(intent === "signup" ? { ...values, invite } : {}),
      ...(intent === "connect"
        ? { currentPassword: values.currentPassword }
        : {}),
    };
    delete data.password;
    await api("/api/host-auth/firebase", { method: "POST", data });
    await sdk.signOut(auth);
    firebasePendingRegistration = null;
    history.replaceState(null, "", "/");
    screen = "login";
    state.view = "home";
    await load();
    await hostFirebaseGoHome();
    return true;
  }
  async function hostFirebaseGoHome() {
    if (!request && state.session?.role === "host") {
      const result = await api("/api/host-auth/home");
      const destination = new URL(result.home);
      if (destination.origin !== location.origin)
        location.replace(
          destination.origin +
            "/signin#host-transfer-start=" +
            encodeURIComponent(location.origin),
        );
    }
  }

  async function navigateTransfer(data) {
    const response = await api("/api/host-auth/handoff/" + data.action, {
      method: "POST",
      data: data.input,
    });
    location.replace(response.url);
  }
  return {
    metadata(session, household) {
      hostPWA = session?.role === "host";
      let favicon = document.querySelector(
        'link[rel="icon"][data-gather-host]',
      );
      if (!favicon) {
        favicon = document.createElement("link");
        favicon.rel = "icon";
        favicon.dataset.gatherHost = "true";
        document.head.append(favicon);
      }
      favicon.href = household?.logo || "/gather-192.png";
      let manifest = document.querySelector('link[rel="manifest"]');
      if (session?.role === "host") {
        if (!manifest) {
          manifest = document.createElement("link");
          manifest.rel = "manifest";
          document.head.append(manifest);
        }
        manifest.href = "/api/app/manifest?v=" + (household?.version || 0);
        navigator.serviceWorker?.register("/gather-sw.js").catch(() => {});
      } else {
        manifest?.remove();
        navigator.serviceWorker
          ?.getRegistrations()
          .then((registrations) => {
            if (hostPWA) return;
            for (const registration of registrations) {
              const worker =
                registration.active ||
                registration.waiting ||
                registration.installing;
              if (
                worker &&
                new URL(worker.scriptURL).origin === location.origin &&
                new URL(worker.scriptURL).pathname === "/gather-sw.js"
              )
                registration.unregister().catch(() => {});
            }
          })
          .catch(() => {});
      }
    },
    stepUpPage() {
      return ui`${topbar({ title: C("Administrator verification"), back: "page-back" })}<section class="panel"><form data-form="host-admin-stepup">${field(H("Current system administrator password"), "password", "", "password", 'required autocomplete="current-password"')}<p class="form-error" role="alert"></p><button>Open administrator tools</button></form></section>`;
    },
    accountPage() {
      return ui`${topbar({ title: C("Host account"), back: "page-back" })}<section class="panel"><h1>Host account</h1>${field(H("Registered email"), "hostEmail", state.hostAccount?.email || "", "email", "readonly")}${config.firebase ? ui`<form data-form="host-firebase-reset"><p>Firebase manages your password and recovery emails.</p><p class="form-error" role="alert"></p><button>Send password reset email</button></form>` : ui`<form data-form="host-password">${field(H("Current password"), "currentPassword", "", "password", 'required autocomplete="current-password"')}${field(H("New password"), "password", "", "password", 'required minlength="12" maxlength="256" autocomplete="new-password"')}<p class="form-error" role="alert"></p><button>Change password</button></form>`}${config.google && !state.session?.platformAdmin ? ui`<form data-form="host-connect-google">${field(H("Current password to connect Google"), "password", "", "password", 'required autocomplete="current-password"')}<p class="form-error" role="alert"></p><button>Connect Google</button></form>` : ""}${state.hostAccount?.googleConnected ? ui`<form data-form="host-disconnect-google">${field(H("Current password to disconnect Google"), "password", "", "password", 'required autocomplete="current-password"')}<p class="form-error" role="alert"></p><button>Disconnect Google and sign out devices</button></form>` : ""}<div class="row">${button("passwordless-revoke", H("Sign out other devices"))}${button("passwordless-revoke-all", H("Sign out all devices"))}${button("host-recovery", H("Recover host account"))}</div></section>`;
    },
    authEntry: () =>
      ["/host-signup", "/host-recovery"].includes(location.pathname),
    async initialize() {
      config = await api("/api/host-auth/config");
      if (invite && screen === "signup") {
        try {
          invitationContext = await api("/api/host-signup/context", {
            method: "POST",
            data: { invite },
          });
        } catch {
          message = "Registration invitation unavailable or expired.";
          screen = "login";
          invite = "";
        }
      }
    },
    async route(getSession) {
      if (source) {
        const value = source;
        source = "";
        await navigateTransfer({ action: "prepare", input: { source: value } });
        return true;
      }
      if (transfer) {
        const [reference, token] = transfer.split(".");
        transfer = "";
        const redeemed = await api("/api/host-auth/handoff/redeem", {
          method: "POST",
          data: { request: reference, token },
        });
        history.replaceState(
          null,
          "",
          redeemed.next === "account" ? "/?account=1" : "/",
        );
        return false;
      }
      if (request && (await getSession()).role === "host") {
        const value = request;
        request = "";
        await navigateTransfer({
          action: "authorize",
          input: { request: value },
        });
        return true;
      }
      if (
        parameters.get("host") === "complete" &&
        !completed &&
        (await getSession()).role === "host"
      ) {
        completed = true;
        return this.goHome({ role: "host" });
      }
      return false;
    },
    async goHome(session = state.session) {
      if (session?.role !== "host") return false;
      const result = await api("/api/host-auth/home");
      const target = new URL(result.home);
      if (target.origin === location.origin) return false;
      location.replace(
        target.origin +
          "/signin#host-transfer-start=" +
          encodeURIComponent(location.origin),
      );
      return true;
    },
    page() {
      const title =
        screen === "signup"
          ? "Create your host account"
          : screen === "reset"
            ? "Reset your host password"
            : screen === "recover"
              ? "Recover host sign-in"
              : screen === "verify"
                ? "Verify your email"
                : screen === "admin"
                  ? "Administrator sign-in"
                  : "Host sign-in";
      const household = state.publicHousehold;
      return ui`<section class="auth"><p class="eyebrow">${household ? escape(household.name) : C("Welcome to Gather")}</p><h1>${C(title)}</h1>${household ? ui`<p class="muted">Open the event link on your invitation to RSVP. Only hosts sign in here.</p>` : ""}<div class="panel">${message ? ui`<p role="status">${escape(message)}</p>` : ""}${screen === "sent" ? ui`<p>Check your email, then open the verification link in this browser. No account has been created yet.</p>` : screen === "verify" ? ui`<form data-form="host-verify"><p>Finish verifying your email to create your host account.</p><p class="form-error" role="alert"></p><button>Verify and continue</button></form>` : screen === "reset" ? ui`<form data-form="host-reset">${field(H("New password"), "password", "", "password", 'required minlength="12" maxlength="256" autocomplete="new-password"')}<p class="form-error" role="alert"></p><button>Reset password</button></form>` : screen === "recover" ? ui`<form data-form="host-recover">${field(H("Email address"), "email", "", "email", 'required autocomplete="email"')}<p class="form-error" role="alert"></p><button>Send recovery email</button></form>` : ui`<form data-form="${screen === "signup" ? "host-signup" : screen === "connect" ? "host-connect-firebase" : "host-login"}">${field(H("Email address"), "email", screen === "signup" ? invitationContext?.email || "" : "", "email", 'required maxlength="254" autocomplete="username"' + (screen === "signup" && invitationContext?.email ? " readonly" : ""))}${screen === "signup" ? field(H("Family household name"), "name", invitationContext?.household?.name || "", "text", 'required maxlength="100"' + (invitationContext?.household ? " readonly" : "")) : ""}${field(H("Password"), "password", "", "password", 'required minlength="12" maxlength="256" autocomplete="current-password"')}${screen === "connect" ? field(H("Existing Gather host password"), "currentPassword", "", "password", 'required autocomplete="current-password"') : ""}${screen === "signup" && !invitationContext?.household ? familyLogoChoice() : ""}<p class="form-error" role="alert"></p><button>${C(screen === "signup" ? "Verify email and create account" : screen === "connect" ? "Connect existing host account" : "Sign in")}</button>${(config.google || config.firebase) && screen !== "admin" ? button("host-google", H(screen === "signup" ? "Sign up with Google" : "Sign in with Google")) : ""}</form>`}</div>${!["signup", "admin"].includes(screen) ? button("host-recovery", H("Forgot password?"), "", "quiet") : ""}${config.firebase && screen === "login" ? button("host-connect-screen", H("Connect an existing host account"), "", "quiet") : ""}${config.firebase && screen === "login" ? button("host-admin-screen", H("Administrator sign-in"), "", "quiet") : ""}${screen !== "login" ? button("host-login-screen", H("Back to host sign-in"), "", "quiet") : ""}<p class="small">New host accounts require an administrator-issued registration link.</p></section>`;
    },
    async submit(form) {
      const kind = form.dataset.form,
        values = Object.fromEntries(new FormData(form));
      if (
        ![
          "host-login",
          "host-connect-firebase",
          "host-signup",
          "host-verify",
          "host-recover",
          "host-reset",
          "host-password",
          "host-firebase-reset",
          "host-connect-google",
          "host-disconnect-google",
          "host-admin-stepup",
        ].includes(kind)
      )
        return false;
      if (kind === "host-admin-stepup") {
        await api("/api/host-auth/admin/step-up", {
          method: "POST",
          data: values,
        });
        state.view = "home";
        await load();
      }
      if (config.firebase && kind === "host-firebase-reset") {
        const { auth, sdk } = await firebase();
        await sdk.sendPasswordResetEmail(auth, state.hostAccount.email);
        notify("Check your email for Firebase password settings.");
        return true;
      }
      if (kind === "host-password") {
        await api("/api/host-auth/password", { method: "POST", data: values });
        state.view = "home";
        await load();
      }
      if (kind === "host-disconnect-google") {
        if (!confirm("Disconnect Google and revoke this host's sessions?"))
          return true;
        await api("/api/host-auth/google/disconnect", {
          method: "POST",
          data: { password: values.password, confirm: true },
        });
        state.view = "home";
        await load();
      }
      if (kind === "host-connect-google") {
        if (location.origin !== central()) {
          location.replace(
            central() +
              "/signin#host-transfer-start=" +
              encodeURIComponent(location.origin) +
              "&host-settings=1",
          );
          return true;
        }
        const result = await api("/api/host-auth/google/start", {
          method: "POST",
          data: { intent: "connect", password: values.password },
        });
        location.assign(result.url);
      }
      if (
        config.firebase &&
        screen !== "admin" &&
        ["host-login", "host-connect-firebase"].includes(kind)
      ) {
        await firebaseSignIn(
          values,
          kind === "host-connect-firebase" ? "connect" : "login",
        );
        return true;
      }
      if (kind === "host-login") {
        await api("/api/host-auth/login", {
          method: "POST",
          data: { ...values, platformAdmin: screen === "admin" },
        });
        screen = "login";
        history.replaceState(null, "", "/");
        state.view = "home";
        await load();
        if (!request) await this.goHome();
      }
      if (config.firebase && kind === "host-signup") {
        values.logo =
          values.logoChoice === "upload"
            ? await fileData(form.elements.registrationLogo)
            : "";
        await firebaseSignIn(values, "signup");
        return true;
      }
      if (kind === "host-signup") {
        values.logo =
          values.logoChoice === "upload"
            ? await fileData(form.elements.registrationLogo)
            : "";
        await api("/api/host-signup/email", {
          method: "POST",
          data: { ...values, invite },
        });
        screen = "sent";
        render();
      }
      if (config.firebase && kind === "host-verify") {
        const { auth, sdk } = await firebase();
        if (!auth.currentUser) throw Error("Please restart Firebase sign-up.");
        await sdk.reload(auth.currentUser);
        if (!auth.currentUser.emailVerified)
          throw Error("Verify the email in Firebase before continuing.");
        // Reauthenticate after opening the email link: identity confirmation can
        // take longer than the server's five-minute fresh-auth window.
        if (firebasePendingRegistration?.password)
          await sdk.signInWithEmailAndPassword(
            auth,
            firebasePendingRegistration.email,
            firebasePendingRegistration.password,
          );
        if (!firebasePendingRegistration)
          throw Error("Please restart Firebase sign-up.");
        const saved = firebasePendingRegistration;
        const data = {
          ...saved,
          invite,
          intent: "signup",
          idToken: await auth.currentUser.getIdToken(true),
        };
        delete data.password;
        await api("/api/host-auth/firebase", { method: "POST", data });
        await sdk.signOut(auth);
        firebasePendingRegistration = null;
        screen = "login";
        history.replaceState(null, "", "/");
        await load();
        await hostFirebaseGoHome();
        return true;
      }
      if (kind === "host-verify") {
        await api("/api/host-signup/complete", {
          method: "POST",
          data: { verification },
        });
        verification = "";
        invite = "";
        history.replaceState(null, "", "/");
        state.view = "home";
        await load();
        await this.goHome();
      }
      if (config.firebase && kind === "host-recover") {
        const { auth, sdk } = await firebase();
        try {
          await sdk.sendPasswordResetEmail(auth, values.email);
        } catch (error) {
          if (error?.code !== "auth/user-not-found") throw error;
        }
        message =
          "If a Firebase host account exists, password recovery has been requested.";
        screen = "login";
        render();
        return true;
      }
      if (kind === "host-recover") {
        await api("/api/host-auth/recovery/start", {
          method: "POST",
          data: values,
        });
        message =
          "If an eligible host account exists, a recovery email has been requested. System administrator recovery remains separately protected.";
        screen = "login";
        render();
      }
      if (kind === "host-reset") {
        await api("/api/host-auth/recovery/complete", {
          method: "POST",
          data: { token: reset, password: values.password },
        });
        reset = "";
        history.replaceState(null, "", "/signin");
        message = "Password updated. Sign in again on each device.";
        screen = "login";
        state.view = "home";
        await load();
      }
      return true;
    },
    async action(action, target) {
      if (action === "passwordless-admin-open") {
        state.settingsOpen = false;
        state.view = "host-admin-stepup";
        render();
        return true;
      }
      if (["my-account", "personal-account", "host-account"].includes(action)) {
        state.hostAccount = await api("/api/host-auth/account");
        state.settingsOpen = false;
        state.view = "host-account";
        render();
        return true;
      }
      if (action === "host-recovery") {
        if (location.origin !== central()) {
          location.assign(central() + "/host-recovery");
          return true;
        }
        screen = "recover";
        render();
        return true;
      }
      if (config.firebase && action === "host-connect-screen") {
        screen = "connect";
        render();
        return true;
      }
      if (config.firebase && action === "host-admin-screen") {
        screen = "admin";
        render();
        return true;
      }
      if (action === "host-login-screen") {
        screen = "login";
        render();
        return true;
      }
      if (action !== "host-google") return false;
      if (screen === "admin") return false;
      if (config.firebase) {
        const form = target.closest("form"),
          values = Object.fromEntries(new FormData(form));
        if (screen === "signup") {
          if (
            !form.elements.email.reportValidity() ||
            !form.elements.name.reportValidity()
          )
            return true;
          values.logo =
            values.logoChoice === "upload"
              ? await fileData(form.elements.registrationLogo)
              : "";
        }
        await firebaseSignIn(
          values,
          screen === "signup"
            ? "signup"
            : screen === "connect"
              ? "connect"
              : "login",
          "google",
        );
        return true;
      }
      if (location.origin !== central()) {
        location.assign(central() + "/signin");
        return true;
      }
      const form = target.closest("form"),
        values = Object.fromEntries(new FormData(form));
      if (screen === "signup") {
        if (
          !form.elements.email.reportValidity() ||
          !form.elements.name.reportValidity()
        )
          return true;
        values.logo =
          values.logoChoice === "upload"
            ? await fileData(form.elements.registrationLogo)
            : "";
      }
      delete values.password;
      const result = await api("/api/host-auth/google/start", {
        method: "POST",
        data: {
          ...values,
          invite,
          intent: screen === "signup" ? "signup" : "login",
        },
      });
      const destination = new URL(result.url);
      if (destination.origin !== "https://accounts.google.com")
        throw Error("Unsupported Google sign-in destination.");
      location.assign(result.url);
      return true;
    },
  };
}

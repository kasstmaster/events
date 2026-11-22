import { randomBytes } from "node:crypto";
import { fail, email, checkPassword, hashPassword } from "./model.js";
import { hostOnlyMode, hostAuthOrigin } from "./host-model.js";
import {
  completeGoogleHost,
  startGoogleHost,
  googleHostConfigured,
  hostTokenHash as hash,
  readBinding,
  setBinding,
} from "./google-host.js";
import {
  hostSignupEnabled,
  invitation,
  registrationInput,
  completeHostRegistration,
  persistentHostSession,
  hostAccountStamp,
} from "./host-signup.js";
import { revokeUserSessions, refreshDeviceSession } from "./device-sessions.js";
import {
  platformAdministrator,
  verifyPlatformLogin,
} from "./platform-access.js";
import { auditAccount } from "./account-management.js";
const P = "platform",
  fresh = () => randomBytes(32).toString("base64url");
const generic = {
  ok: true,
  message:
    "If an eligible host account exists, a verification email will be sent.",
};
function availableHost(store, user) {
  return (
    user?.role === "host" &&
    !store.one("SELECT disabled FROM family_members WHERE id=?", user.id)
      ?.disabled &&
    !store.one(
      "SELECT household FROM household_deletions WHERE household=?",
      user.household,
    ) &&
    store.get("host-membership", user.id, user.household)?.enabled !== false
  );
}
export async function hostAuthAPI(ctx) {
  const {
    path,
    method,
    req,
    res,
    store,
    env,
    session,
    body,
    json,
    origin,
    selected,
    cookie,
    newSession,
    hostVerificationSender,
    hostGoogleFetcher,
  } = ctx;
  if (
    !path.startsWith("/api/host-auth/") ||
    path.startsWith("/api/host-auth/handoff/") ||
    path === "/api/host-auth/home"
  )
    return false;
  if (path === "/api/host-auth/config" && method === "GET") {
    json(res, {
      centralOrigin: hostAuthOrigin(origin),
      enabled: hostOnlyMode(env),
      signup: hostSignupEnabled(env),
      google: googleHostConfigured(env),
      emailVerification: !!hostVerificationSender,
    });
    return true;
  }
  if (!hostSignupEnabled(env)) fail(404, "Page not found.");
  if (path === "/api/host-auth/google/callback" && method === "GET") {
    try {
      if (selected || origin !== hostAuthOrigin(origin))
        fail(403, "Use the central host sign-in page.");
      const { flow, identity } = await completeGoogleHost(
        store,
        env,
        origin,
        req,
        { fetcher: hostGoogleFetcher },
      );
      let user;
      const mappingKey = hash(identity.sub),
        mapping = store.get("host-google-account", mappingKey, P);
      if (flow.intent === "signup") {
        if (mapping) fail(403, "This Google account is already registered.");
        const row = store.get("host-signup-invitation", flow.invitation, P);
        if (!row || row.email !== identity.email)
          fail(403, "Use the invited Google email address.");
        const password = await hashPassword(fresh());
        const account = await completeHostRegistration(
          store,
          row.id,
          identity.email,
          flow.registration,
          password,
          "google",
          (account) => {
            if (store.get("host-google-account", mappingKey, P))
              fail(409, "Google account changed. Try again.");
            store.put("host-google-account", mappingKey, P, {
              user: account.user,
              email: identity.email,
              household: account.household,
            });
          },
          hostOnlyMode(env),
        );
        user = store.one("SELECT * FROM users WHERE id=?", account.user);
      } else if (flow.intent === "connect") {
        user = store.one("SELECT * FROM users WHERE id=?", flow.user);
        if (
          !availableHost(store, user) ||
          user.email !== identity.email ||
          hostAccountStamp(user) !== flow.stamp ||
          !store.one(
            "SELECT token FROM sessions WHERE token=? AND user=? AND expires>?",
            flow.session,
            user.id,
            Date.now(),
          ) ||
          (mapping && mapping.user !== user.id)
        )
          fail(403, "Reconnect Google from your authenticated host settings.");
        if (!mapping)
          store.put("host-google-account", mappingKey, P, {
            user: user.id,
            email: identity.email,
            household: user.household,
          });
        auditAccount(store, user.id, user.id, "host-google-connected");
      } else {
        user =
          mapping && store.one("SELECT * FROM users WHERE id=?", mapping.user);
        if (
          !availableHost(store, user) ||
          user.email !== identity.email ||
          mapping.email !== identity.email
        )
          fail(
            403,
            "Use an approved host Google account, or sign in with email and password.",
          );
      }
      if (store.get("platform-access", user.id, P))
        fail(
          403,
          "System administrators use their separately protected password sign-in.",
        );
      cookie(
        res,
        persistentHostSession(
          store,
          { user: user.id, household: user.household, role: "host" },
          origin,
        ),
      );
      res.writeHead(303, { Location: "/signin#host=complete" });
      res.end();
    } catch {
      // Fixed fragment only: never echo provider responses, codes, tokens or redirect input.
      res.writeHead(303, { Location: "/signin#host=google-failed" });
      res.end();
    }
    return true;
  }
  if (path === "/api/host-auth/account" && method === "GET") {
    const user =
      session?.role === "host" &&
      store.one("SELECT * FROM users WHERE id=?", session.user);
    if (!availableHost(store, user))
      fail(403, "Host account access is required.");
    json(res, {
      email: user.email,
      googleConnected: store
        .list("host-google-account", P)
        .some((m) => m.user === user.id),
      passwordAllowed:
        store.get("host-auth-account", user.id, P)?.passwordAllowed !== false,
    });
    return true;
  }
  if (method !== "POST") fail(405, "Method not allowed.");
  store.limit("host-auth:" + req.socket.remoteAddress, 20, 60000);
  const input = await body(req);
  if (path === "/api/host-auth/admin/step-up") {
    store.limit(
      "host-admin-stepup:" + (session?.user || req.socket.remoteAddress),
      5,
      900000,
    );
    const user =
        session?.role === "host" &&
        store.one("SELECT * FROM users WHERE id=?", session.user),
      proof = session && store.get("passwordless-session", session.token, P);
    if (
      !availableHost(store, user) ||
      proof?.provider !== "host-account" ||
      !platformAdministrator(store, { ...session, token: undefined }) ||
      !(await checkPassword(input.password, user?.password))
    )
      fail(403, "Confirm your current system administrator password.");
    const raw = req.headers.cookie
      ?.split(";")
      .map((value) => value.trim())
      .find((value) => /^(?:__Host-)?events_session=/.test(value))
      ?.split("=")[1];
    const result = store.transaction(() => {
      if (
        !platformAdministrator(store, { ...session, token: undefined }) ||
        hostAccountStamp(
          store.one("SELECT * FROM users WHERE id=?", user.id),
        ) !== proof.stamp
      )
        fail(403, "Administrator authorization changed.");
      return refreshDeviceSession(store, session, raw, origin, {
        force: true,
        grace: false,
        proofChanges: {
          adminRestricted: false,
          adminUntil: Date.now() + 15 * 60000,
        },
      });
    });
    if (!result)
      fail(401, "Sign in again before confirming administrator access.");
    verifyPlatformLogin(store, user);
    cookie(res, result.auth);
    json(res, { ok: true });
    return true;
  }
  if (path === "/api/host-auth/google/disconnect") {
    const user =
      session?.role === "host" &&
      store.one("SELECT * FROM users WHERE id=?", session.user);
    if (
      !availableHost(store, user) ||
      store.get("host-auth-account", user.id, P)?.passwordAllowed === false ||
      !(await checkPassword(input.password, user?.password)) ||
      input.confirm !== true
    )
      fail(
        403,
        "Set and confirm your current host password before disconnecting Google.",
      );
    store.transaction(() => {
      for (const row of store
        .list("host-google-account", P)
        .filter((row) => row.user === user.id))
        store.remove("host-google-account", row.id, P, row.version);
      revokeUserSessions(store, user.id);
      auditAccount(store, user.id, user.id, "host-google-disconnected");
    });
    cookie(res, null);
    json(res, { ok: true });
    return true;
  }
  if (path === "/api/host-auth/password") {
    const user =
      session?.role === "host" &&
      store.one("SELECT * FROM users WHERE id=?", session.user);
    if (
      !availableHost(store, user) ||
      !(await checkPassword(input.currentPassword, user?.password))
    )
      fail(403, "Confirm your current host password.");
    const password = await hashPassword(input.password);
    store.transaction(() => {
      if (
        hostAccountStamp(
          store.one("SELECT * FROM users WHERE id=?", user.id),
        ) !== hostAccountStamp(user)
      )
        fail(409, "Account changed. Sign in again.");
      store.run("UPDATE users SET password=? WHERE id=?", password, user.id);
      store.run(
        "UPDATE family_members SET password=?,version=version+1 WHERE id=?",
        password,
        user.id,
      );
      revokeUserSessions(store, user.id);
      auditAccount(store, user.id, user.id, "host-password-changed");
    });
    cookie(res, null);
    json(res, { ok: true });
    return true;
  }
  if (path === "/api/host-auth/login") {
    const address = email(input.email);
    store.limit("host-email-login:" + hash(address), 10, 60000);
    const user = store.one("SELECT * FROM users WHERE email=?", address),
      valid = await checkPassword(input.password, user?.password);
    if (
      !valid ||
      !user ||
      (user.role !== "admin" && !availableHost(store, user)) ||
      (selected && user.household !== selected.id) ||
      store.get("host-auth-account", user.id, P)?.passwordAllowed === false
    )
      fail(401, "Unable to sign in with these details.");
    verifyPlatformLogin(store, user);
    const account = {
      user: user.id,
      household: user.household,
      role: user.role,
    };
    const auth =
      user.role === "admin"
        ? newSession(account)
        : persistentHostSession(store, account, origin);
    if (user.role === "host" && platformAdministrator(store, account)) {
      const key = hash(auth.token),
        proof = store.get("passwordless-session", key, P);
      store.put(
        "passwordless-session",
        key,
        P,
        {
          ...proof,
          adminRestricted: false,
          adminUntil: Date.now() + 15 * 60000,
        },
        proof.version,
      );
    }
    cookie(res, auth);
    json(res, { ok: true });
    return true;
  }
  if (path === "/api/host-auth/google/start") {
    if (selected || origin !== hostAuthOrigin(origin))
      fail(403, "Use the central host sign-in page.");
    const intent = input.intent || "login";
    let context = { intent };
    if (intent === "signup") {
      const row = invitation(store, input.invite, email(input.email));
      context = {
        ...context,
        invitation: row.id,
        registration: registrationInput(input),
      };
    } else if (intent === "connect") {
      const user =
        session?.role === "host" &&
        store.one("SELECT * FROM users WHERE id=?", session.user);
      if (
        !availableHost(store, user) ||
        store.get("platform-access", user.id, P) ||
        !(await checkPassword(input.password, user?.password))
      )
        fail(403, "Confirm your current host password.");
      context = {
        ...context,
        user: user.id,
        session: session.token,
        stamp: hostAccountStamp(user),
      };
    } else if (intent !== "login") fail(400, "Unsupported Google sign-in.");
    json(res, { url: startGoogleHost(store, env, origin, res, context) });
    return true;
  }
  if (path === "/api/host-auth/recovery/start") {
    if (selected || origin !== hostAuthOrigin(origin))
      fail(403, "Use the central host recovery page.");
    if (!hostVerificationSender)
      fail(503, "Host email verification is not configured.");
    const address = email(input.email);
    store.limit("host-recovery:" + hash(address), 3, 900000);
    const user = store.one("SELECT * FROM users WHERE email=?", address);
    if (
      availableHost(store, user) &&
      !store.get("platform-access", user.id, P)
    ) {
      const raw = fresh(),
        binding = fresh();
      const record = store.put("host-recovery", hash(raw), P, {
        user: user.id,
        stamp: hostAccountStamp(user),
        binding: hash(binding),
        expires: Date.now() + 600000,
      });
      try {
        await hostVerificationSender({
          email: address,
          url: origin + "/host-recovery#reset=" + raw,
          purpose: "recovery",
        });
      } catch {
        store.remove("host-recovery", record.id, P, record.version);
        fail(503, "Account email is unavailable.");
      }
      setBinding(res, origin, "recovery", binding);
    } else setBinding(res, origin, "recovery", fresh());
    json(res, generic);
    return true;
  }
  if (path === "/api/host-auth/recovery/complete") {
    const raw = input.token,
      binding = readBinding(req, origin, "recovery");
    if (!/^[A-Za-z0-9_-]{43}$/.test(raw || "") || !binding)
      fail(403, "Password recovery expired. Request a new link.");
    const password = await hashPassword(input.password);
    store.transaction(() => {
      const row = store.get("host-recovery", hash(raw), P),
        user = row && store.one("SELECT * FROM users WHERE id=?", row.user);
      if (
        !row ||
        row.used ||
        row.expires <= Date.now() ||
        row.binding !== hash(binding) ||
        !availableHost(store, user) ||
        row.stamp !== hostAccountStamp(user) ||
        store.get("platform-access", user.id, P)
      )
        fail(403, "Password recovery expired. Request a new link.");
      store.run("UPDATE users SET password=? WHERE id=?", password, user.id);
      const auth = store.get("host-auth-account", user.id, P);
      store.put(
        "host-auth-account",
        user.id,
        P,
        { ...(auth || {}), emailVerified: true, passwordAllowed: true },
        auth?.version,
      );
      store.put(
        "host-recovery",
        row.id,
        P,
        { ...row, used: true, binding: "" },
        row.version,
      );
      revokeUserSessions(store, user.id);
      auditAccount(store, user.id, user.id, "host-password-recovered");
    });
    cookie(res, null);
    json(res, { ok: true });
    return true;
  }
  fail(404, "Page not found.");
}

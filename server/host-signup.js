// Staged email-ownership onboarding. No event notifications or SMS transports.
import { createHash, randomBytes } from "node:crypto";
import { fail, email, hashPassword } from "./model.js";
import { confirmAdministrator, auditAccount } from "./account-management.js";
import { persistentProof } from "./device-sessions.js";
const P = "platform",
  hash = (v) => createHash("sha256").update(v).digest("hex"),
  fresh = () => randomBytes(32).toString("base64url");
export const hostSignupEnabled = (env) =>
  env.HOST_SIGNUP_INVITATIONS_ENABLED === "true";
export function hostAccountStamp(user) {
  return hash(
    JSON.stringify([
      user.id,
      user.email,
      user.password,
      user.role,
      user.household,
    ]),
  );
}
export function validHostSession(store, session, proof) {
  const user = store.one(
    "SELECT * FROM users WHERE id=? AND role='host'",
    session.user,
  );
  return !!(
    user &&
    session.role === "host" &&
    user.household === session.household &&
    proof.user === user.id &&
    proof.stamp === hostAccountStamp(user) &&
    !store.one("SELECT disabled FROM family_members WHERE id=?", user.id)
      ?.disabled &&
    !store.one(
      "SELECT household FROM household_deletions WHERE household=?",
      user.household,
    )
  );
}
export function persistentHostSession(store, account, origin) {
  const user = store.one(
    "SELECT * FROM users WHERE id=? AND role='host'",
    account.user,
  );
  if (!user || account.role !== "host" || account.household !== user.household)
    fail(403, "Host access is required.");
  return store.transaction(() => {
    const auth = store.newSession({ ...account, passwordless: true }, origin);
    store.put(
      "passwordless-session",
      hash(auth.token),
      P,
      persistentProof({
        provider: "host-account",
        user: user.id,
        stamp: hostAccountStamp(user),
        adminRestricted: true,
      }),
    );
    return auth;
  });
}
function invitation(store, raw, address) {
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(raw))
    fail(403, "Signup invitation unavailable.");
  const row = store.get("host-signup-invitation", hash(raw), P);
  if (
    !row ||
    row.used ||
    row.revoked ||
    row.expires <= Date.now() ||
    row.email !== address
  )
    fail(403, "Signup invitation unavailable.");
  return row;
}
export async function hostSignupAPI(ctx) {
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
    hostVerificationSender,
  } = ctx;
  if (
    ![
      "/api/admin/host-signup-invitations",
      "/api/host-signup/email",
      "/api/host-signup/complete",
    ].includes(path)
  )
    return false;
  if (!hostSignupEnabled(env)) fail(404, "Page not found.");
  if (method !== "POST") fail(405, "Method not allowed.");
  const input = await body(req);
  if (path === "/api/admin/host-signup-invitations") {
    await confirmAdministrator(store, session, input.password);
    const address = email(input.email),
      raw = fresh();
    if (store.one("SELECT id FROM users WHERE email=?", address))
      fail(409, "This host already has an account.");
    const expires = Date.now() + 86400000;
    store.put("host-signup-invitation", hash(raw), P, {
      email: address,
      issuedBy: session.user,
      expires,
    });
    auditAccount(
      store,
      session.user,
      "host-signup",
      "signup-invitation-issued",
      ["email"],
    );
    json(res, { url: origin + "/host-signup#invite=" + raw, expires }, 201);
    return true;
  }
  if (selected) fail(403, "Use the central host signup page.");
  store.limit("host-signup:" + req.socket.remoteAddress, 8, 60000);
  if (path === "/api/host-signup/email") {
    if (typeof hostVerificationSender !== "function")
      fail(503, "Host email verification is not configured.");
    const address = email(input.email),
      invite = invitation(store, input.invite, address);
    const passwordHash = await hashPassword(input.password);
    if (
      typeof input.name !== "string" ||
      !input.name.trim() ||
      input.name.length > 100
    )
      fail(400, "Enter your household name.");
    const raw = fresh(),
      binding = fresh();
    // Password plaintext is never retained, mailed, or placed in a URL.
    const pending = store.put("host-signup-verification", hash(raw), P, {
      email: address,
      name: input.name,
      passwordHash,
      invitation: invite.id,
      binding: hash(binding),
      expires: Date.now() + 600000,
    });
    try {
      await hostVerificationSender({
        email: address,
        url: origin + "/host-signup#verify=" + raw,
      });
    } catch {
      store.remove("host-signup-verification", pending.id, P, pending.version);
      fail(503, "Host email verification could not be sent.");
    }
    res.setHeader(
      "Set-Cookie",
      `events_host_signup=${binding}; Path=/; HttpOnly; SameSite=Strict; Max-Age=600${origin.startsWith("https:") ? "; Secure" : ""}`,
    );
    json(res, { ok: true });
    return true;
  }
  const raw = input.verification,
    binding = /(?:^|;\s*)events_host_signup=([A-Za-z0-9_-]{43})(?:;|$)/.exec(
      req.headers.cookie || "",
    )?.[1];
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(raw) || !binding)
    fail(403, "Verification unavailable. Restart signup on this device.");
  const proof = store.get("host-signup-verification", hash(raw), P);
  const check = () => {
    const current = proof && store.get("host-signup-verification", proof.id, P),
      invite =
        current && store.get("host-signup-invitation", current.invitation, P);
    if (
      !current ||
      current.used ||
      current.expires <= Date.now() ||
      current.binding !== hash(binding) ||
      !invite ||
      invite.used ||
      invite.revoked ||
      invite.expires <= Date.now() ||
      invite.email !== current.email
    )
      fail(403, "Verification unavailable. Restart signup on this device.");
    return { current, invite };
  };
  check();
  // register() rechecks and consumes its approval in the same transaction as the
  // invitation/proof consumption and replacement of the disposable password hash.
  const account = await store.register(
    { email: proof.email, name: proof.name, password: fresh() },
    (account) => {
      const { current, invite } = check();
      store.run(
        "UPDATE users SET password=? WHERE id=?",
        current.passwordHash,
        account.user,
      );
      store.put(
        "host-signup-verification",
        current.id,
        P,
        { ...current, used: true, passwordHash: "", binding: "" },
        current.version,
      );
      store.put(
        "host-signup-invitation",
        invite.id,
        P,
        { ...invite, used: true, account: account.user },
        invite.version,
      );
      auditAccount(
        store,
        invite.issuedBy,
        account.user,
        "host-email-ownership-verified",
        ["email"],
      );
    },
    (address) => {
      const { current, invite } = check();
      if (address !== current.email)
        fail(403, "Email ownership verification is required.");
      store.run(
        "INSERT INTO approvals(email,created) VALUES(?,?) ON CONFLICT(email) DO NOTHING",
        address,
        new Date().toISOString(),
      );
    },
  );
  cookie(res, persistentHostSession(store, account, origin));
  json(res, { ok: true }, 201);
  return true;
}

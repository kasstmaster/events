import { ensureHostRoster } from "./host-roster.js";
import { revokeUserSessions } from "./device-sessions.js";
import { hostOnlyMode, hostAuthOrigin } from "./host-model.js";
import { isolatedAddressBook } from "./recipient-isolation.js";
import { readBinding, setBinding } from "./google-host.js";
// Staged email-ownership onboarding. No event notifications or SMS transports.
import { createHash, randomBytes } from "node:crypto";
import { fail, email, hashPassword, text, image, id } from "./model.js";
import { confirmAdministrator, auditAccount } from "./account-management.js";
import { persistentProof } from "./device-sessions.js";
const P = "platform",
  hash = (v) => createHash("sha256").update(v).digest("hex"),
  fresh = () => randomBytes(32).toString("base64url");
export const hostSignupEnabled = (env) =>
  hostOnlyMode(env) || env.HOST_SIGNUP_INVITATIONS_ENABLED === "true";
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
    (!store.get("host-membership", user.id, user.household) ||
      store.get("host-membership", user.id, user.household).enabled === true) &&
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
export function persistentHostSession(store, account, origin, deviceId) {
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
        deviceId,
        provider: "host-account",
        user: user.id,
        stamp: hostAccountStamp(user),
        adminRestricted: true,
      }),
    );
    return auth;
  });
}
export function invitation(store, raw, address) {
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
      "/api/host-signup/context",
      "/api/host-signup/complete",
    ].includes(path)
  )
    return false;
  if (!hostSignupEnabled(env)) fail(404, "Page not found.");
  if (method !== "POST") fail(405, "Method not allowed.");
  const input = await body(req);
  if (path === "/api/admin/host-signup-invitations") {
    await confirmAdministrator(store, session, input.password);
    const raw = fresh();
    if (input.operation === "list") {
      json(res, {
        invitations: store
          .list("host-signup-invitation", P)
          .map(({ id, email, expires, used, revoked, household, version }) => ({
            id,
            email,
            expires,
            used: !!used,
            revoked: !!revoked,
            household,
            version,
          })),
      });
      return true;
    }
    if (input.operation === "revoke") {
      const record = store.get("host-signup-invitation", input.id, P);
      if (!record) fail(404, "Invitation unavailable.");
      if (record.version !== input.version)
        fail(409, "Invitation changed. Refresh first.");
      store.put(
        "host-signup-invitation",
        record.id,
        P,
        { ...record, revoked: true },
        record.version,
      );
      auditAccount(store, session.user, record.id, "signup-invitation-revoked");
      json(res, { ok: true });
      return true;
    }
    const address = email(input.email);
    const member = input.household
      ? validateHostMemberInvite(store, input)
      : {};
    if (store.one("SELECT id FROM users WHERE email=?", address))
      fail(409, "This host already has an account.");
    const expires = Date.now() + 86400000;
    store.put("host-signup-invitation", hash(raw), P, {
      ...member,
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
    json(
      res,
      { url: hostAuthOrigin(origin) + "/host-signup#invite=" + raw, expires },
      201,
    );
    return true;
  }
  if (selected || origin !== hostAuthOrigin(origin))
    fail(403, "Use the central host signup page.");
  store.limit(
    (path.endsWith("/context") ? "host-signup-context:" : "host-signup:") +
      req.socket.remoteAddress,
    8,
    60000,
  );
  if (path === "/api/host-signup/context") {
    if (
      typeof input.invite !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.invite)
    )
      fail(403, "Signup invitation unavailable.");
    const candidate = store.get(
        "host-signup-invitation",
        hash(input.invite),
        P,
      ),
      row = invitation(store, input.invite, candidate?.email);
    json(res, {
      email: row.email,
      household: row.household
        ? { id: row.household, name: store.household(row.household).name }
        : null,
    });
    return true;
  }

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
      registration: registrationInput(input),
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
    setBinding(res, origin, "signup", binding);
    json(res, { ok: true });
    return true;
  }
  const raw = input.verification,
    binding = readBinding(req, origin, "signup");
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
  const account = await completeHostRegistration(
    store,
    proof.invitation,
    proof.email,
    proof.registration || { name: proof.name },
    proof.passwordHash,
    "email",
    () => {
      const { current } = check();
      store.put(
        "host-signup-verification",
        current.id,
        P,
        { ...current, used: true, passwordHash: "", binding: "" },
        current.version,
      );
    },
    hostOnlyMode(env),
  );
  cookie(res, persistentHostSession(store, account, origin));
  json(res, { ok: true }, 201);
  return true;
}

export function registrationInput(input) {
  const logoChoice = input.logoChoice || "request";
  if (!["request", "upload"].includes(logoChoice))
    fail(400, "Choose a family icon option.");
  const logo = logoChoice === "upload" ? image(input.logo) : "";
  if (logoChoice === "upload" && !logo)
    fail(400, "Choose an uploaded family icon.");
  return { name: text(input.name, 100, true), logoChoice, logo };
}
function validateHostMemberInvite(store, input) {
  const household = text(input.household, 100, true);
  if (
    !store.household(household) ||
    input.approvedAdult !== true ||
    typeof input.memberName !== "string" ||
    !input.memberName.trim()
  )
    fail(400, "Explicitly approve an adult host member.");
  const rosterMember = text(input.rosterMember || "", 100);
  if (rosterMember) {
    const member = store.one(
      "SELECT role FROM family_members WHERE id=? AND household=?",
      rosterMember,
      household,
    );
    const localPerson = store
      .get("host-family-roster", "family:" + household, household)
      ?.members.find((m) => m.id === rosterMember && !m.archived);
    const person =
      localPerson ||
      store
        .list("personal-household", P)
        .find((p) => p.sourceHousehold === household)
        ?.members.find((m) => m.id === rosterMember && !m.archived);
    if ((!member && !person) || member?.role === "kid" || person?.parent)
      fail(400, "Choose an adult roster member.");
  }
  return {
    household,
    rosterMember,
    memberName: text(input.memberName, 100, true),
    approvedAdult: true,
  };
}
// Only server-verified email/Google flows may call this helper. Recheck inside register's transaction.
export async function completeHostRegistration(
  store,
  inviteID,
  address,
  registration,
  passwordHash,
  provider,
  consumeProof = () => {},
  replacement = false,
) {
  const check = () => {
    const row = store.get("host-signup-invitation", inviteID, P);
    if (
      !row ||
      row.used ||
      row.revoked ||
      row.expires <= Date.now() ||
      row.email !== address
    )
      fail(403, "Signup invitation unavailable.");
    if (store.one("SELECT id FROM users WHERE email=?", address))
      fail(403, "Signup invitation unavailable.");
    if (row.household) validateHostMemberInvite(store, row);
    return row;
  };
  check();
  const finalize = (account) => {
    const invite = check();
    consumeProof(account);
    store.run(
      "UPDATE users SET password=? WHERE id=?",
      passwordHash,
      account.user,
    );
    store.put("host-auth-account", account.user, P, {
      provider,
      emailVerified: true,
      passwordAllowed: provider === "email",
    });
    store.put("host-membership", account.user, account.household, {
      enabled: true,
      adult: true,
      approvedBy: invite.issuedBy,
      rosterMember: invite.rosterMember || "",
    });
    if (replacement && !isolatedAddressBook(store, account.household))
      store.put(
        "address-book-policy",
        "local:" + account.household,
        account.household,
        {
          mode: "host-owned",
          actor: invite.issuedBy,
          at: Date.now(),
          newHousehold: true,
        },
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
      "host-ownership-verified",
      ["email", provider],
    );
  };
  const invite = check();
  if (
    replacement &&
    invite.household &&
    !isolatedAddressBook(store, invite.household)
  )
    fail(409, "Prepare the household Address Book transition first.");
  if (invite.household)
    return store.transaction(() => {
      const current = check();
      const linked =
        current.rosterMember &&
        store
          .list("family-profile-member", current.household)
          .find((link) => link.member === current.rosterMember);
      const oldMember =
        current.rosterMember &&
        (store.one(
          "SELECT * FROM family_members WHERE id=? AND household=?",
          current.rosterMember,
          current.household,
        ) ||
          (linked &&
            store.one(
              "SELECT * FROM family_members WHERE id=? AND household=?",
              linked.id,
              current.household,
            )));
      if (oldMember?.role === "kid")
        fail(400, "Child workspace access cannot become host access.");
      const user = oldMember?.id || id(),
        account = { user, household: current.household, role: "host" };
      if (store.one("SELECT id FROM users WHERE id=?", user))
        fail(409, "This family member already has a host account.");
      finalize(account);
      store.run(
        "INSERT INTO users VALUES(?,?,?,?,?)",
        user,
        address,
        passwordHash,
        "host",
        current.household,
      );
      if (oldMember) {
        store.run(
          "UPDATE family_members SET password=?,role='administrator',disabled=0,version=version+1 WHERE id=?",
          passwordHash,
          user,
        );
        revokeUserSessions(store, user);
      } else
        store.run(
          "INSERT INTO family_members(id,household,login,name,password,role,disabled,version) VALUES(?,?,?,?,?,?,0,1)",
          user,
          current.household,
          address,
          current.memberName,
          passwordHash,
          "administrator",
        );
      if (replacement) {
        const roster = ensureHostRoster(store, current.household);
        if (
          current.rosterMember &&
          roster.members.some((m) => m.id === current.rosterMember)
        ) {
          const existing = store.get(
            "family-profile-member",
            user,
            current.household,
          );
          store.put(
            "family-profile-member",
            user,
            current.household,
            { profile: "host-roster", member: current.rosterMember },
            existing?.version,
          );
        } else if (!roster.members.some((m) => m.id === user))
          store.put(
            "host-family-roster",
            roster.id,
            current.household,
            {
              ...roster,
              members: [
                ...roster.members,
                {
                  id: user,
                  rsvpID: "family-" + user,
                  first: current.memberName,
                  last: "",
                  suffix: "",
                  phone: "",
                  parent: "",
                  sharedAddress: "physical",
                },
              ],
            },
            roster.version,
          );
      }
      return account;
    });
  // register inserts the user before finalize, so recheck only the invitation there.
  return store.register(
    { email: address, ...registration, password: fresh() },
    (account) => {
      const row = store.get("host-signup-invitation", inviteID, P);
      if (
        !row ||
        row.used ||
        row.revoked ||
        row.expires <= Date.now() ||
        row.email !== address
      )
        fail(403, "Signup invitation unavailable.");
      consumeProof(account);
      store.run(
        "UPDATE users SET password=? WHERE id=?",
        passwordHash,
        account.user,
      );
      store.put("host-auth-account", account.user, P, {
        provider,
        emailVerified: true,
        passwordAllowed: provider === "email",
      });
      store.put("host-membership", account.user, account.household, {
        enabled: true,
        adult: true,
        approvedBy: row.issuedBy,
      });
      if (replacement)
        store.put(
          "address-book-policy",
          "local:" + account.household,
          account.household,
          {
            mode: "host-owned",
            actor: row.issuedBy,
            at: Date.now(),
            newHousehold: true,
          },
        );
      store.put(
        "host-signup-invitation",
        row.id,
        P,
        { ...row, used: true, account: account.user },
        row.version,
      );
      auditAccount(
        store,
        row.issuedBy,
        account.user,
        "host-email-ownership-verified",
        ["email", provider],
      );
    },
    () => {
      check();
      store.run(
        "INSERT INTO approvals(email,created) VALUES(?,?) ON CONFLICT(email) DO NOTHING",
        address,
        new Date().toISOString(),
      );
    },
  );
}

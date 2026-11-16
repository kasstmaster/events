import {
  membership,
  workspaceId,
  centralPerson,
} from "./central-membership.js";
import { platformAdministrator } from "./platform-access.js";
import { randomBytes, createHash } from "node:crypto";
import { fail, checkPassword } from "./model.js";
import { contactPhone } from "./features.js";
import { compareName, guestRelations } from "./guest-identities.js";
import {
  personalAccount,
  profileForIdentity,
  privateIdentity,
} from "./personal-accounts.js";
import { verifiedGuestContact } from "./guest-auth.js";
import { smsEnabled, sendText } from "./sms-provider.js";
import { confirmAdministrator, auditAccount } from "./account-management.js";
import {
  GATHER_ORIGIN,
  authSmsEnabled,
  passwordlessEnabled,
  universalEnabled,
} from "./gather-flags.js";
export { GATHER_ORIGIN, passwordlessEnabled, universalEnabled };
const P = "platform",
  TTL = 600000;
const nonce = () => randomBytes(32).toString("base64url");
export const authHash = (value) =>
  createHash("sha256").update(String(value)).digest("hex");
const valid = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
export function activeEntry(store, label, hosts) {
  if (
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(label || "") ||
    !hosts.has(label + ".ilymmd.com")
  )
    return null;
  try {
    return store.hostnameHousehold(label);
  } catch {
    return null;
  }
}
export function activeHouseholdLabel(store, house, hosts) {
  if (!house) return null;
  if (activeEntry(store, house.subdomain, hosts)?.id === house.id)
    return house.subdomain;
  for (const hostname of hosts) {
    const label = hostname.slice(0, -".ilymmd.com".length);
    if (activeEntry(store, label, hosts)?.id === house.id) return label;
  }
  return null;
}
function subjects(store) {
  const results = new Map();
  for (const profile of store.list("personal-household", P)) {
    for (const person of profile.members.filter((p) => !p.archived)) {
      if (profileForIdentity(store, person.identity)?.id !== profile.id)
        continue;
      const account = personalAccount(store, person.identity);
      const host =
        account?.hostUser &&
        store.one(
          "SELECT id,household FROM users WHERE id=? AND role='host'",
          account.hostUser,
        );
      const assigned = store
        .list("family-profile-member", profile.sourceHousehold)
        .find(
          (link) => link.profile === profile.id && link.member === person.id,
        );
      const family =
        assigned &&
        store.one(
          "SELECT id,household,disabled FROM family_members WHERE id=? AND household=?",
          assigned.id,
          profile.sourceHousehold,
        );
      const approved =
        profile.sourceHousehold &&
        membership(store, profile.sourceHousehold, person.identity);
      const centralApproved =
        approved?.status === "approved" &&
        (approved.role === "adult" || approved.allowSignIn);
      const relation = guestRelations(store, person.identity).find(
        (r) => !r.record.parent,
      );
      const key = host
        ? "user:" + host.id
        : centralApproved
          ? "person:" + person.identity
          : account && !person.parent
            ? "person:" + person.identity
            : "";
      if (
        !key ||
        (!centralApproved && family?.disabled) ||
        (host &&
          store.one("SELECT disabled FROM family_members WHERE id=?", host.id)
            ?.disabled)
      )
        continue;
      const household =
        host?.household ||
        (centralApproved ? profile.sourceHousehold : relation?.household);
      if (
        store.one(
          "SELECT household FROM household_deletions WHERE household=?",
          household || "",
        )
      )
        continue;
      const verified = verifiedGuestContact(store, person.identity);
      const centralUser =
        (host?.id || family?.id) &&
        store.get("central-user-info", host?.id || family.id, P);
      results.set(key, {
        key,
        identity: person.identity,
        first: person.first,
        last: person.parent ? "" : person.last || "",
        phone:
          (approved?.role === "child"
            ? store.get("passwordless-contact", "person:" + person.identity, P)
                ?.phone
            : "") ||
          verified?.phone ||
          centralUser?.phone ||
          person.phone ||
          "",
        stamp:
          (verified?.stamp || "") +
          ":" +
          (centralApproved ? approved.version : "guest"),
        verifiedPhone: !!verified,
        child: approved?.role === "child",
        guardianMediated: approved?.guardianMediated === true,
        membershipVersion: centralApproved ? approved.version : null,
        role:
          host || (centralApproved && approved.role === "adult")
            ? "host"
            : centralApproved
              ? "family"
              : "guest",
        user:
          host?.id ||
          (centralApproved
            ? workspaceId(store, profile.sourceHousehold, person.identity)
            : null),
        household,
        guest: relation?.guest || null,
      });
    }
  }
  for (const info of store.list("central-user-info", P)) {
    const administrator = store.one(
      "SELECT id FROM users WHERE id=? AND role='admin'",
      info.id,
    );
    if (administrator) {
      results.set("user:" + info.id, {
        key: "user:" + info.id,
        first: info.first,
        last: info.last || "",
        phone: info.phone || "",
        stamp: "",
        role: "admin",
        user: info.id,
        household: null,
        identity: null,
        guest: null,
      });
      continue;
    }
  }

  return [...results.values()];
}
export function passwordlessContact(store, subject) {
  const enrolled = store.get("passwordless-contact", subject.key, P);
  if (enrolled?.guardian) {
    const guardian = verifiedGuestContact(store, enrolled.guardian);
    if (!guardian || guardian.phone !== enrolled.phone) return null;
    subject = { ...subject, stamp: subject.stamp + ":" + guardian.stamp };
  }
  if (enrolled?.verified && enrolled.phone === subject.phone)
    return {
      phone: enrolled.phone,
      stamp: authHash(
        enrolled.phone + ":" + enrolled.version + ":" + subject.stamp,
      ),
    };
  return subject.verifiedPhone
    ? { phone: subject.phone, stamp: authHash(subject.stamp) }
    : null;
}
export function subjectByKey(store, key) {
  return subjects(store).find((p) => p.key === key);
}
export function accountForOrigin(store, subject, selected) {
  if (!subject)
    fail(401, "This sign-in link is invalid or expired. Request a new link.");
  if (
    !selected ||
    selected.id === subject.household ||
    subject.role === "family"
  ) {
    if (selected && selected.id !== subject.household)
      fail(403, "This account cannot access that household.");
    return {
      ...subject,
      entryHousehold: selected?.id || subject.household || "universal",
    };
  }
  const relation =
    subject.identity &&
    guestRelations(store, subject.identity).find(
      (r) => r.household === selected.id && !r.record.parent,
    );
  if (!relation) fail(403, "This account cannot access that invitation.");
  return {
    role: "guest",
    identity: subject.identity,
    household: relation.household,
    guest: relation.guest,
    entryHousehold: selected.id,
  };
}
export function validChildDeviceRecord(store, subject, hash) {
  if (!subject?.guardianMediated) return true;
  const device = hash && store.get("child-device", hash, P);
  return (
    !!device &&
    device.identity === subject.identity &&
    device.membershipVersion === subject.membershipVersion &&
    device.at + 2592000000 > Date.now()
  );
}
function childDevice(store, subject, cookies = "") {
  if (!subject.guardianMediated) return { valid: true, hash: "" };
  const key =
    "__Host-gather_child_" + authHash(subject.identity).slice(0, 16) + "=";
  const secret = cookies
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(key))
    ?.slice(key.length);
  if (!valid(secret)) return { valid: false, hash: "" };
  const hash = authHash(secret),
    device = store.get("child-device", hash, P);
  return {
    valid: validChildDeviceRecord(store, subject, hash),
    hash,
  };
}
export async function startPasswordless(
  store,
  env,
  input,
  {
    origin,
    ip,
    binding,
    entry = "",
    invitation = "",
    fetcher = fetch,
    cookies = "",
    now = Date.now,
  } = {},
) {
  if (!passwordlessEnabled(env)) fail(404, "Page not found.");
  if (!valid(binding))
    fail(400, "A browser-bound sign-in request is required.");
  if (new URL(origin).protocol !== "https:")
    fail(503, "Secure sign-in requires HTTPS.");
  store.limit("magic-ip:" + authHash(ip), 20, 900000);
  store.limit("magic-global", 100, 60000);
  store.run(
    "DELETE FROM records WHERE kind IN ('passwordless-challenge','auth-handoff') AND json_extract(body,'$.expires')<?",
    now(),
  );
  const first = typeof input.first === "string" ? input.first.slice(0, 80) : "";
  const last = typeof input.last === "string" ? input.last.slice(0, 80) : "";
  let phone = "";
  try {
    phone = contactPhone(input.phone);
  } catch {}
  store.limit(
    "magic-match:" +
      authHash(compareName(first) + ":" + compareName(last) + ":" + phone),
    5,
    3600000,
  );
  const candidates = subjects(store).filter(
    (p) =>
      compareName(p.first) === compareName(first) &&
      compareName(p.last) === compareName(last) &&
      p.phone === phone &&
      passwordlessContact(store, p) &&
      childDevice(store, p, cookies).valid,
  );
  const subject =
    first.trim() && phone && candidates.length === 1 ? candidates[0] : null;
  const challenge = nonce(),
    verified = subject && passwordlessContact(store, subject);
  let send = false;
  store.transaction(() => {
    if (
      subject &&
      smsEnabled({
        ...env,
        SMS_ENABLED: authSmsEnabled(env) ? "true" : "false",
      }) &&
      env.AUTH_SMS_ENABLED === "true" &&
      !store.one("SELECT phone FROM sms_optouts WHERE phone=?", verified.phone)
    ) {
      const previous = store.get("passwordless-send", subject.key, P);
      if (!previous || now() - previous.at >= 60000) {
        store.limit("magic-send:" + subject.key, 5, 3600000);
        store.put(
          "passwordless-send",
          subject.key,
          P,
          { at: now() },
          previous?.version,
        );
        send = true;
      }
    }
    store.put("passwordless-challenge", challenge, P, {
      subject: send ? subject.key : null,
      tokenHash: "",
      bindingHash: authHash(binding),
      origin,
      entry,
      invitation,
      contactStamp: verified?.stamp || "",
      childDeviceHash: subject ? childDevice(store, subject, cookies).hash : "",
      expires: now() + TTL,
      state: send ? "queued" : "unavailable",
    });
  });

  return {
    ok: true,
    message:
      "If these details match an eligible account, a sign-in link will be sent. Open it in the same browser within 10 minutes.",
  };
}
// Existing alarm/message runner drains this token-free outbox. Never persist SMS bodies.
export async function runPasswordlessMessages(
  store,
  env,
  { fetcher = fetch, now = Date.now } = {},
) {
  if (
    !passwordlessEnabled(env) ||
    !smsEnabled({
      ...env,
      SMS_ENABLED: authSmsEnabled(env) ? "true" : "false",
    }) ||
    env.AUTH_SMS_ENABLED !== "true"
  )
    return;
  for (const pending of store
    .list("passwordless-challenge", P)
    .filter((r) => r.state === "queued")
    .slice(0, 20)) {
    const token = nonce();
    const attempt = store.transaction(() => {
      const row = store.get("passwordless-challenge", pending.id, P),
        subject = row && subjectByKey(store, row.subject),
        verified = subject && passwordlessContact(store, subject);
      if (!row || row.state !== "queued") return null;
      const eligible =
        row.expires > now() &&
        validChildDeviceRecord(store, subject, row.childDeviceHash) &&
        verified?.stamp === row.contactStamp &&
        !store.one(
          "SELECT phone FROM sms_optouts WHERE phone=?",
          verified?.phone || "",
        );
      store.put(
        "passwordless-challenge",
        row.id,
        P,
        {
          ...row,
          state: eligible ? "attempting" : "revoked",
          tokenHash: eligible ? authHash(token) : "",
        },
        row.version,
      );
      return eligible ? { row, verified, subject } : null;
    });
    if (!attempt) continue;
    const result = await sendText(
      { ...env, SMS_ENABLED: authSmsEnabled(env) ? "true" : "false" },
      attempt.verified.phone,
      (attempt.subject.guardianMediated
        ? "Guardian-approved sign-in for " +
          attempt.subject.first +
          ". Give this link only to the child’s already enrolled requesting browser: "
        : "Your Gather sign-in link (expires within 10 minutes): ") +
        attempt.row.origin +
        "/signin#" +
        attempt.row.id +
        "." +
        token +
        "\nOpen in the browser where you requested it. Never forward this link.",
      fetcher,
    );
    store.transaction(() => {
      const row = store.get("passwordless-challenge", pending.id, P);
      if (row.state === "attempting")
        store.put(
          "passwordless-challenge",
          row.id,
          P,
          {
            ...row,
            state: ["accepted", "unknown"].includes(result.status)
              ? "ready"
              : "failed",
            ...(result.status === "failed" ? { tokenHash: "" } : {}),
          },
          row.version,
        );
    });
  }
}
export function validPasswordlessSession(store, session) {
  const record = store.get("passwordless-session", session.token, P);
  if (!record) return true;
  const subject = subjectByKey(store, record.subject),
    verified = subject && passwordlessContact(store, subject);
  return (
    !!verified &&
    verified.stamp === record.contactStamp &&
    validChildDeviceRecord(store, subject, record.childDeviceHash)
  );
}
export function completePasswordless(
  store,
  env,
  input,
  { origin, binding, selected, newSession, cookies = "", now = Date.now } = {},
) {
  if (!passwordlessEnabled(env)) fail(404, "Page not found.");
  if (!valid(input.challenge) || !valid(input.token) || !valid(binding))
    fail(401, "This sign-in link is invalid or expired. Request a new link.");
  return store.transaction(() => {
    const row = store.get("passwordless-challenge", input.challenge, P),
      subject = row && subjectByKey(store, row.subject),
      verified = subject && passwordlessContact(store, subject);
    if (
      !row ||
      row.state !== "ready" ||
      row.expires <= now() ||
      row.origin !== origin ||
      row.tokenHash !== authHash(input.token) ||
      row.bindingHash !== authHash(binding) ||
      !verified ||
      verified.stamp !== row.contactStamp ||
      !childDevice(store, subject, cookies).valid ||
      (row.childDeviceHash &&
        childDevice(store, subject, cookies).hash !== row.childDeviceHash) ||
      store.one("SELECT phone FROM sms_optouts WHERE phone=?", verified.phone)
    )
      fail(401, "This sign-in link is invalid or expired. Request a new link.");
    const account = accountForOrigin(store, subject, selected);
    store.put(
      "passwordless-challenge",
      row.id,
      P,
      { ...row, state: "consumed", tokenHash: "", bindingHash: "" },
      row.version,
    );
    const session = newSession({ ...account, passwordless: true });
    if (env.PASSWORDLESS_RETIRE_LEGACY_APPROVED === "true") {
      const old = store.get("passwordless-activation", subject.key, P);
      store.put(
        "passwordless-activation",
        subject.key,
        P,
        { at: now() },
        old?.version,
      );
    }
    store.put("passwordless-session", authHash(session.token), P, {
      subject: subject.key,
      identity: subject.identity,
      adminRestricted: true,
      contactStamp: verified.stamp,
      childDeviceHash: row.childDeviceHash || "",
      at: now(),
    });
    return { session, entry: row.entry, invitation: row.invitation };
  });
}
export async function passwordlessAPI(ctx) {
  const {
    path,
    method,
    req,
    res,
    store,
    session,
    body,
    json,
    env,
    origin,
    selected,
    householdHosts,
    cookie,
    newSession,
    fetcher,
  } = ctx;
  if (
    !path.startsWith("/api/passwordless") &&
    path !== "/api/admin/passwordless/enroll"
  )
    return false;
  if (path === "/api/passwordless/config" && method === "GET") {
    json(res, {
      enabled: passwordlessEnabled(env),
      enrollmentAvailable: true,
      universal: universalEnabled(env),
      pwa: universalEnabled(env) && env.GATHER_PWA_ENABLED === "true",
    });
    return true;
  }
  if (!passwordlessEnabled(env) && path !== "/api/admin/passwordless/enroll")
    fail(404, "Page not found.");
  const bindingName = origin.startsWith("https:")
    ? "__Host-gather_login"
    : "gather_login";
  const binding =
    req.headers.cookie
      ?.split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(bindingName + "="))
      ?.slice(bindingName.length + 1) || "";
  if (path === "/api/passwordless/security" && method === "GET") {
    const record =
        session && store.get("passwordless-session", session.token, P),
      subject = record && subjectByKey(store, record.subject);
    if (!subject || subject.role !== "admin")
      fail(403, "Administrator authentication is required.");
    json(res, {
      first: subject.first,
      last: subject.last,
      requiresAdminStepUp: true,
    });
    return true;
  }
  if (path === "/api/passwordless/admin/step-up" && method === "POST") {
    const record =
        session && store.get("passwordless-session", session.token, P),
      subject = record && subjectByKey(store, record.subject);
    const account =
      subject?.user &&
      store.one(
        "SELECT id,household,role,password FROM users WHERE id=?",
        subject.user,
      );
    store.limit(
      "magic-admin-step-up:" +
        authHash(session?.token || req.socket.remoteAddress),
      5,
      900000,
    );
    const input = await body(req);
    if (
      !account ||
      !platformAdministrator(store, {
        role: account.role,
        user: account.id,
        household: account.household,
      }) ||
      !(await checkPassword(input.password, account.password))
    )
      fail(403, "Confirm your system administrator password.");
    const upgraded = store.transaction(() => {
      const auth = newSession({
        role: account.role,
        user: account.id,
        household: account.household,
        passwordless: true,
      });
      store.run("DELETE FROM sessions WHERE token=?", session.token);
      return auth;
    });
    cookie(res, upgraded);
    json(res, { ok: true });
    return true;
  }
  if (path === "/api/passwordless/start" && method === "POST") {
    const input = await body(req),
      secret = valid(binding) ? binding : nonce();
    const entry = input.entry
      ? activeEntry(store, input.entry, householdHosts)
      : null;
    const result = await startPasswordless(store, env, input, {
      origin,
      ip: req.socket.remoteAddress,
      binding: secret,
      cookies: req.headers.cookie || "",
      entry: entry?.id || selected?.id || "",
      invitation: valid(input.invitation) ? input.invitation : "",
      fetcher,
    });
    res.setHeader(
      "Set-Cookie",
      bindingName +
        "=" +
        secret +
        "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600",
    );
    json(res, result);
    return true;
  }
  if (path === "/api/passwordless/redeem" && method === "POST") {
    store.limit(
      "magic-redeem:" + authHash(req.socket.remoteAddress),
      30,
      900000,
    );
    const result = completePasswordless(store, env, await body(req), {
      origin,
      binding,
      selected,
      cookies: req.headers.cookie || "",
      newSession,
    });
    cookie(res, result.session);
    json(res, { ok: true, entry: result.entry, invitation: result.invitation });
    return true;
  }
  if (path === "/api/passwordless/entry" && method === "GET") {
    if (!universalEnabled(env)) fail(404, "Page not found.");
    const label = new URL(req.url, origin).searchParams.get("label"),
      house = activeEntry(store, label, householdHosts);
    if (!house) fail(404, "This household address is unavailable.");
    json(res, {
      household: {
        ...house,
        ui: ctx.effectiveUI(store, store.household(house.id)),
      },
    });
    return true;
  }
  if (path === "/api/passwordless/sessions/revoke" && method === "POST") {
    if (!session) fail(401, "Please sign in.");
    store.transaction(() => {
      const identity = ["host", "guest"].includes(session.role)
        ? privateIdentity(store, session)
        : null;
      const primaryUser =
        session.user ||
        (identity && personalAccount(store, identity)?.hostUser);
      const tokens = new Set(
        store
          .all("SELECT token FROM sessions WHERE user=?", primaryUser || null)
          .map((x) => x.token),
      );
      if (identity)
        for (const row of store.all(
          "SELECT token FROM guest_identity_sessions WHERE identity=?",
          identity,
        ))
          tokens.add(row.token);
      for (const row of store.list("passwordless-session", P))
        if (row.identity && row.identity === identity) tokens.add(row.id);
      tokens.delete(session.token);
      for (const token of tokens) {
        store.run("DELETE FROM sessions WHERE token=?", token);
        store.run("DELETE FROM session_origins WHERE token=?", token);
        store.run("DELETE FROM guest_identity_sessions WHERE token=?", token);
      }
    });
    json(res, { ok: true });
    return true;
  }
  if (path === "/api/admin/passwordless/enroll" && method === "POST") {
    const input = await body(req);
    await confirmAdministrator(store, session, input.password);
    const subject = subjectByKey(store, input.subject);
    if (subject?.child)
      fail(
        400,
        "Use the reviewed child-specific membership and delivery controls.",
      );
    if (
      !subject ||
      !subject.phone ||
      contactPhone(input.phone || "") !== subject.phone ||
      input.verifiedOutOfBand !== true ||
      input.consented !== true
    )
      fail(
        400,
        "Independently verify the registered phone and security-message authorization first.",
      );
    store.transaction(() => {
      const previous = store.get("passwordless-contact", subject.key, P);
      if ((previous?.version || 0) !== input.version)
        fail(409, "Enrollment changed. Refresh first.");
      store.put(
        "passwordless-contact",
        subject.key,
        P,
        { phone: subject.phone, verified: true, at: Date.now() },
        previous?.version,
      );
      for (const row of store.list("passwordless-challenge", P))
        if (row.subject === subject.key)
          store.put(
            "passwordless-challenge",
            row.id,
            P,
            { ...row, state: "revoked", tokenHash: "" },
            row.version,
          );
      auditAccount(
        store,
        session.user,
        subject.key,
        "passwordless-enrollment",
        ["verified-phone"],
      );
    });
    json(res, { ok: true });
    return true;
  }
  fail(404, "Page not found.");
}

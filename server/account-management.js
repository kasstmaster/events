import { id, text, fail, checkPassword, hashPassword } from "./model.js";
import { contactPhone } from "./features.js";
import { addressInput } from "./addresses.js";
import { platformAdministrator } from "./platform-access.js";
import {
  personalAccount,
  profileForIdentity,
  ensurePersonalProfile,
  privateIdentity,
  propagatePersonalProfile,
} from "./personal-accounts.js";
import {
  guestPrivateLink,
  deliverGuestLink,
  enrollGuestContact,
  revokeGuestDevices,
  verifiedGuestContact,
} from "./guest-auth.js";
const PLATFORM = "platform";
export function auditAccount(store, actor, subject, action, fields = []) {
  store.put("account-admin-audit", id(), PLATFORM, {
    actor,
    subject,
    action,
    fields,
    at: Date.now(),
  });
}
export function revokeAccount(store, identity, user) {
  if (identity) revokeGuestDevices(store, identity);
  if (user) {
    store.run(
      "DELETE FROM session_origins WHERE token IN (SELECT token FROM sessions WHERE user=?)",
      user,
    );
    store.run("DELETE FROM sessions WHERE user=?", user);
  }
  if (identity) {
    const challenge = store.get("phone-verification", identity, PLATFORM);
    if (challenge)
      store.put(
        "phone-verification",
        identity,
        PLATFORM,
        { ...challenge, state: "cancelled", message: "", codeHash: "" },
        challenge.version,
      );
    for (const r of store
      .list("username-recovery", PLATFORM)
      .filter((r) => r.accounts?.includes(identity)))
      store.put(
        "username-recovery",
        r.id,
        PLATFORM,
        { ...r, state: "cancelled", message: "" },
        r.version,
      );
  }
}
function principal(store, key) {
  if (typeof key !== "string" || key.length > 150)
    fail(404, "Account not found.");
  if (key.startsWith("person:")) {
    const identity = key.slice(7),
      account = personalAccount(store, identity),
      profile = profileForIdentity(store, identity);
    if (!account || account.hostUser || !profile)
      fail(404, "Account not found.");
    return { key, identity, account, profile, type: "guest" };
  }
  if (key.startsWith("user:")) {
    const user = key.slice(5),
      auth =
        store.one(
          "SELECT id,email,household,role FROM users WHERE id=?",
          user,
        ) ||
        store.one(
          "SELECT id,name,household,role,version FROM family_members WHERE id=?",
          user,
        );
    if (!auth) fail(404, "Account not found.");
    const link =
        auth.household && store.get("host-person", user, auth.household),
      identity = link?.identity;
    return {
      key,
      user,
      auth,
      identity,
      account: identity && personalAccount(store, identity),
      profile: identity && profileForIdentity(store, identity),
      type: auth.email ? auth.role : "family",
    };
  }
  fail(404, "Account not found.");
}
const addressView = (a = {}) =>
  Object.fromEntries(
    ["street", "city", "state", "zip", "lines"].map((k) => [k, a?.[k] || ""]),
  );
const registeredAddress = (value, existing, label) =>
  addressInput(
    {
      ...Object.fromEntries(
        ["street", "city", "state", "zip", "lines"]
          .filter((k) => Object.hasOwn(value, k))
          .map((k) => [k, value[k]]),
      ),
      label,
    },
    existing || {},
  );
function projection(store, p) {
  const member = p.profile?.members.find((m) => m.identity === p.identity),
    extra = p.user && store.get("central-user-info", p.user, PLATFORM);
  const info = extra || {};
  return {
    id: p.key,
    type: p.type,
    first:
      member?.first ||
      info.first ||
      p.auth?.name ||
      (p.user &&
        store.one("SELECT name FROM family_members WHERE id=?", p.user)
          ?.name) ||
      "",
    last: member?.last || info.last || "",
    suffix: member?.suffix || "",
    email: p.auth?.email || "",
    phone: member?.phone || info.phone || p.account?.recoveryPhone || "",
    physical: addressView(p.profile?.physical || info.physical),
    mailing: addressView(
      p.profile
        ? p.profile.mailingSame
          ? p.profile.physical
          : p.profile.mailing
        : info.mailing,
    ),
    householdId: p.profile?.publicCode || "",
    version: p.profile?.version || extra?.version || 0,
    accountVersion: p.account?.version || 0,
    authVersion: p.auth?.version || 0,
    verifiedPhone: p.identity
      ? verifiedGuestContact(store, p.identity)?.phone || ""
      : "",
    linkVersion: p.identity
      ? store.get("guest-private-link", p.identity, PLATFORM)?.version || 0
      : 0,
    hasPrivateLink: !!(
      p.identity && store.get("guest-private-link", p.identity, PLATFORM)
    ),
    sessions: p.identity
      ? store.one(
          "SELECT count(*) AS n FROM guest_identity_sessions g JOIN sessions s ON s.token=g.token WHERE g.identity=? AND s.expires>?",
          p.identity,
          Date.now(),
        ).n
      : store.one(
          "SELECT count(*) AS n FROM sessions WHERE user=? AND expires>?",
          p.user,
          Date.now(),
        ).n,
  };
}
async function confirmAdministrator(store, session, password) {
  if (!platformAdministrator(store, session))
    fail(403, "System administrator access is required.");
  store.limit("central-admin-confirm:" + session.user, 10, 15 * 60000);
  const actor = store.one(
    "SELECT password FROM users WHERE id=?",
    session.user,
  );
  if (!(await checkPassword(password, actor?.password)))
    fail(403, "Confirm your current system administrator password.");
  if (
    !platformAdministrator(store, session) ||
    !store.one(
      "SELECT token FROM sessions WHERE token=? AND expires>?",
      session.token,
      Date.now(),
    ) ||
    store.one("SELECT password FROM users WHERE id=?", session.user)
      ?.password !== actor.password
  )
    fail(403, "Your administrator authentication changed. Sign in again.");
}
export function rejectCentralContactEdits(input) {
  if (
    [
      "account",
      "accountId",
      "centralAccount",
      "registeredPhone",
      "registeredAddress",
      "recoveryPhone",
      "recoveryVerified",
      "privateId",
      "privateUrl",
      "verifiedDevices",
      "authorizedDevices",
      "tokenHash",
      "encryptedToken",
    ].some((k) => Object.hasOwn(input, k))
  )
    fail(
      403,
      "Address Book edits cannot change registered account or sign-in information.",
    );
}
export async function accountManagementAPI(ctx) {
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
    canonicalOrigin,
    version,
  } = ctx;
  const admin =
    path === "/api/admin/accounts" || path === "/api/admin/account-audit";
  if (admin && method === "POST") {
    const input = await body(req);
    await confirmAdministrator(store, session, input.password);
    if (path.endsWith("account-audit")) {
      json(res, {
        entries: store
          .list("account-admin-audit", PLATFORM)
          .sort((a, b) => b.at - a.at)
          .slice(0, 200),
      });
      return true;
    }
    const offset = Number(input.offset || 0);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000)
      fail(400, "Choose a valid account page.");
    const keys = [
      ...store.all("SELECT id FROM users").map((u) => "user:" + u.id),
      ...store
        .all(
          "SELECT f.id FROM family_members f LEFT JOIN users u ON u.id=f.id WHERE u.id IS NULL",
        )
        .map((u) => "user:" + u.id),
      ...store
        .list("person-account", PLATFORM)
        .filter((a) => !a.hostUser && profileForIdentity(store, a.id))
        .map((a) => "person:" + a.id),
    ].sort();
    json(res, {
      accounts: keys
        .slice(offset, offset + 100)
        .map((k) => projection(store, principal(store, k))),
      nextOffset: offset + 100 < keys.length ? offset + 100 : null,
    });
    return true;
  }
  if (path === "/api/admin/account" && method === "POST") {
    const input = await body(req);
    await confirmAdministrator(store, session, input.password);
    const p = principal(store, input.id),
      action = text(input.action, 30, true);
    if (action === "update") {
      const result = store.transaction(() => {
        if (p.profile?.version !== (input.version ?? 0) && p.profile)
          fail(409, "Account information changed. Review it before saving.");
        if (p.user && !p.profile && p.type === "host") {
          const ready = ensurePersonalProfile(store, {
            role: "host",
            user: p.user,
            household: p.auth.household,
          });
          p.identity = ready.identity;
          p.profile = ready.profile;
          p.account = personalAccount(store, p.identity);
          if (input.accountVersion === 0)
            input.accountVersion = p.account.version;
        }
        const fields = [];
        if (p.profile) {
          const own = p.profile.members.find((m) => m.identity === p.identity);
          if (!own) fail(404, "Account information not found.");
          const members = p.profile.members.map((m) =>
            m.identity === p.identity
              ? {
                  ...m,
                  ...(input.first !== undefined
                    ? { first: text(input.first, 80, true) }
                    : {}),
                  ...(input.last !== undefined
                    ? { last: text(input.last, 80) }
                    : {}),
                  ...(input.phone !== undefined
                    ? { phone: contactPhone(input.phone) }
                    : {}),
                }
              : m,
          );
          const next = { ...p.profile, members };
          if (input.address !== undefined) {
            const target = p.profile.mailingSame ? "physical" : "mailing";
            next[target] = registeredAddress(
              input.address,
              p.profile[target],
              p.profile.name,
            );
            fields.push("address");
          }
          if (input.physicalAddress !== undefined) {
            next.physical = registeredAddress(
              input.physicalAddress,
              p.profile.physical,
              p.profile.name,
            );
            fields.push("physical-address");
          }
          if (input.phone !== undefined) fields.push("phone");
          if (input.first !== undefined || input.last !== undefined)
            fields.push("name");
          if (input.phone !== undefined) {
            if (input.verifiedOutOfBand !== true || input.consented !== true)
              fail(
                400,
                "Verify the intended person and phone ownership outside this session and confirm security-text authorization.",
              );
            const phone = contactPhone(input.phone);
            if (!phone)
              fail(400, "Enter a verified international phone number.");
            const current = personalAccount(store, p.identity) || {};
            if ((current.version || 0) !== (input.accountVersion ?? 0))
              fail(409, "Sign-in information changed. Refresh first.");
            store.put(
              "person-account",
              p.identity,
              PLATFORM,
              { ...current, recoveryPhone: phone, recoveryVerified: true },
              current.version,
            );
            if (p.type === "guest")
              enrollGuestContact(store, p.identity, phone, {
                administrator: session.user,
                verifiedOutOfBand: true,
                consented: true,
                version:
                  store.get("guest-auth-contact", p.identity, PLATFORM)
                    ?.version || 0,
              });
            revokeAccount(store, p.identity, p.user);
          }
          const saved = store.put(
            "personal-household",
            p.profile.id,
            PLATFORM,
            next,
            p.profile.version,
          );
          propagatePersonalProfile(store, saved);
        } else {
          const previous = store.get("central-user-info", p.user, PLATFORM);
          if ((previous?.version || 0) !== (input.version ?? 0))
            fail(409, "Account information changed. Refresh first.");
          const next = { ...previous };
          if (input.first !== undefined) {
            next.first = text(input.first, 80, true);
            fields.push("name");
          }
          if (input.last !== undefined) next.last = text(input.last, 80);
          if (input.phone !== undefined) {
            next.phone = contactPhone(input.phone);
            fields.push("phone");
            revokeAccount(store, null, p.user);
          }
          if (input.address !== undefined) {
            next.mailing = registeredAddress(
              input.address,
              previous?.mailing,
              p.auth.name || p.auth.email || "Account",
            );
            fields.push("address");
          }
          if (input.physicalAddress !== undefined) {
            next.physical = registeredAddress(
              input.physicalAddress,
              previous?.physical,
              p.auth.name || p.auth.email || "Account",
            );
            fields.push("physical-address");
          }
          store.put(
            "central-user-info",
            p.user,
            PLATFORM,
            next,
            previous?.version,
          );
        }
        auditAccount(store, session.user, p.key, "account-updated", fields);
        return projection(store, principal(store, p.key));
      });
      json(res, result);
      return true;
    }
    if (action === "reset-password") {
      if (p.type !== "family")
        fail(
          400,
          "Use the existing host recovery control or guest private-link reset.",
        );
      const encoded = await hashPassword(input.newPassword);
      store.transaction(() => {
        if (
          !platformAdministrator(store, session) ||
          !store.one(
            "SELECT token FROM sessions WHERE token=? AND expires>?",
            session.token,
            Date.now(),
          )
        )
          fail(403, "Sign in again before account recovery.");
        if (
          store.one("SELECT version FROM family_members WHERE id=?", p.user)
            ?.version !== input.authVersion
        )
          fail(
            409,
            "Assigned account changed. Review it before resetting authentication.",
          );
        store.run(
          "UPDATE family_members SET password=?,version=version+1 WHERE id=?",
          encoded,
          p.user,
        );
        revokeAccount(store, p.identity, p.user);
        auditAccount(
          store,
          session.user,
          p.key,
          "assigned-authentication-reset",
        );
      });
      json(res, { ok: true });
      return true;
    }
    if (!p.identity || p.type !== "guest") {
      if (action === "revoke") {
        revokeAccount(store, p.identity, p.user);
        auditAccount(store, session.user, p.key, "sessions-revoked");
        json(res, { ok: true });
        return true;
      }
      fail(400, "Private links are available for registered guest accounts.");
    }
    if (action === "reveal" || action === "reset") {
      const result = store.transaction(() => {
        const current = store.get("guest-private-link", p.identity, PLATFORM);
        if (
          action === "reset" &&
          ((current?.version || 0) !== input.linkVersion ||
            input.confirm !== p.key)
        )
          fail(
            409,
            "Confirm the exact account and current private-link version.",
          );
        const link = guestPrivateLink(store, p.identity, env, canonicalOrigin, {
          reset: action === "reset",
        });
        auditAccount(
          store,
          session.user,
          p.key,
          action === "reset" ? "private-link-reset" : "private-link-disclosed",
        );
        return { ...link, privateId: new URL(link.url).hash.slice(1) };
      });
      json(res, result);
      return true;
    }
    if (action === "send") {
      const result = await deliverGuestLink(
        store,
        env,
        p.identity,
        canonicalOrigin,
      );
      auditAccount(
        store,
        session.user,
        p.key,
        "private-link-delivery-requested",
      );
      json(res, result);
      return true;
    }
    if (action === "revoke") {
      revokeAccount(store, p.identity, p.user);
      auditAccount(store, session.user, p.key, "sessions-revoked");
      json(res, { ok: true });
      return true;
    }
    fail(400, "Choose an account action.");
  }
  if (path === "/api/account/self" && ["GET", "PUT"].includes(method)) {
    if (!session) fail(401, "Please sign in.");
    const key =
        session.role === "guest"
          ? "person:" + privateIdentity(store, session)
          : "user:" + session.user,
      p = principal(store, key);
    if (method === "PUT") {
      if (p.profile)
        fail(
          400,
          "Use your existing personal account/family editor for this information.",
        );
      const input = await body(req),
        previous = store.get("central-user-info", p.user, PLATFORM);
      if ((previous?.version || 0) !== version(req))
        fail(409, "Account information changed. Refresh first.");
      store.put(
        "central-user-info",
        p.user,
        PLATFORM,
        {
          ...previous,
          first: text(input.first, 80, true),
          last: text(input.last || "", 80),
          phone: contactPhone(input.phone || ""),
          physical: addressInput({ ...input.physical, label: input.first }),
          mailing: addressInput({
            ...(input.mailing || input.physical),
            label: input.first,
          }),
        },
        previous?.version,
      );
    }
    json(res, projection(store, principal(store, key)));
    return true;
  }
  return false;
}

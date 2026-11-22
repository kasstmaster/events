import { platformAdministrator } from "./platform-access.js";
import { fail, checkPassword, hashPassword } from "./model.js";
import { hostSignupEnabled, hostAccountStamp } from "./host-signup.js";
import { confirmAdministrator, auditAccount } from "./account-management.js";
import { revokeUserSessions } from "./device-sessions.js";
import { ensureHostRoster } from "./host-roster.js";
export async function hostManagementAPI(ctx) {
  const { path, method, req, res, store, env, session, body, json } = ctx;
  if (path !== "/api/admin/host-management") return false;
  if (!hostSignupEnabled(env)) fail(404, "Page not found.");
  if (method !== "POST") fail(405, "Method not allowed.");
  const input = await body(req);
  await confirmAdministrator(store, session, input.password);
  if (!input.operation || input.operation === "directory") {
    const hosts = store
      .all("SELECT id,email,household FROM users WHERE role='host'")
      .map((user) => {
        const row = store.one("SELECT * FROM users WHERE id=?", user.id),
          house = store.household(user.household),
          membership = store.get("host-membership", user.id, user.household),
          roster = house
            ? ensureHostRoster(store, user.household)
            : { members: [], physical: {}, mailing: {}, mailingSame: true };
        return {
          ...user,
          name: house?.name || "Unavailable household",
          subdomain: house?.subdomain,
          householdVersion: house?.version,
          accountVersion: hostAccountStamp(row),
          membershipVersion: membership?.version || 0,
          enabled: membership?.enabled !== false,
          members: roster.members
            .filter((m) => !m.archived)
            .map(({ id, first, last, suffix, parent, phone }) => ({
              id,
              first,
              last,
              suffix,
              child: !!parent,
              phone: parent ? "" : phone,
            })),
          events: store
            .list("event", user.household)
            .map(({ id, title, version }) => ({ id, title, version })),
          physical: roster.physical,
          mailing: roster.mailing,
          mailingSame: roster.mailingSame,
        };
      });
    json(res, { hosts });
    return true;
  }
  const user = store.one(
    "SELECT * FROM users WHERE id=? AND role='host'",
    input.user,
  );
  if (!user || input.confirmEmail !== user.email)
    fail(403, "Confirm the registered host email.");
  if (input.accountVersion !== hostAccountStamp(user))
    fail(409, "Host account changed. Review it again.");
  if (input.operation === "revoke") {
    revokeUserSessions(store, user.id);
    auditAccount(store, session.user, user.id, "host-sessions-revoked");
    json(res, { ok: true });
    return true;
  }
  if (input.operation === "membership") {
    const member = store.get("host-membership", user.id, user.household);
    if (
      (member?.version || 0) !== input.membershipVersion ||
      typeof input.enabled !== "boolean"
    )
      fail(409, "Host membership changed. Review it again.");
    if (
      input.enabled &&
      (store.one(
        "SELECT household FROM household_deletions WHERE household=?",
        user.household,
      ) ||
        store.one("SELECT role FROM family_members WHERE id=?", user.id)
          ?.role === "kid")
    )
      fail(
        409,
        "Review household recovery or adulthood before restoring host access.",
      );
    store.transaction(() => {
      store.run(
        "UPDATE family_members SET disabled=?,version=version+1 WHERE id=? AND household=?",
        input.enabled ? 0 : 1,
        user.id,
        user.household,
      );
      store.put(
        "host-membership",
        user.id,
        user.household,
        {
          ...(member || {}),
          enabled: input.enabled,
          adult: true,
          approvedBy: session.user,
        },
        member?.version,
      );
      revokeUserSessions(store, user.id);
      auditAccount(
        store,
        session.user,
        user.id,
        input.enabled ? "host-membership-enabled" : "host-membership-disabled",
      );
    });
    json(res, { ok: true });
    return true;
  }
  if (input.operation === "recover") {
    if (input.newPassword !== input.confirmPassword)
      fail(400, "The passwords must match.");
    const password = await hashPassword(input.newPassword);
    store.transaction(() => {
      if (
        !platformAdministrator(store, session) ||
        !store.one(
          "SELECT token FROM sessions WHERE token=? AND expires>?",
          session.token,
          Date.now(),
        )
      )
        fail(403, "Administrator authorization changed. Sign in again.");
      if (
        hostAccountStamp(
          store.one("SELECT * FROM users WHERE id=?", user.id),
        ) !== input.accountVersion
      )
        fail(409, "Host account changed. Review it again.");
      store.run("UPDATE users SET password=? WHERE id=?", password, user.id);
      store.run(
        "UPDATE family_members SET password=?,version=version+1 WHERE id=? AND household=?",
        password,
        user.id,
        user.household,
      );
      const auth = store.get("host-auth-account", user.id, "platform");
      store.put(
        "host-auth-account",
        user.id,
        "platform",
        { ...(auth || {}), passwordAllowed: true },
        auth?.version,
      );
      if (input.disconnectGoogle === true)
        for (const mapping of store
          .list("host-google-account", "platform")
          .filter((m) => m.user === user.id))
          store.remove(
            "host-google-account",
            mapping.id,
            "platform",
            mapping.version,
          );
      revokeUserSessions(store, user.id);
      auditAccount(store, session.user, user.id, "host-account-recovered", [
        "password",
        ...(input.disconnectGoogle ? ["google-disconnected"] : []),
      ]);
    });
    json(res, { ok: true });
    return true;
  }
  fail(400, "Choose a supported host-management action.");
}

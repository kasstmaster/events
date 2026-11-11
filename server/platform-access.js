import { fail, checkPassword, text } from "./model.js";
export function platformAdministrator(store, session) {
  if (!session) return false;
  if (session.role === "admin") return true;
  if (!["host", "family"].includes(session.role)) return false;
  const user = store.one(
    "SELECT id,email,household FROM users WHERE id=? AND role='host'",
    session.user,
  );
  const permission = user && store.get("platform-access", user.id, "platform");
  return !!(
    permission &&
    permission.email === user.email &&
    user.household === session.household &&
    !store.one(
      "SELECT household FROM household_deletions WHERE household=?",
      user.household,
    )
  );
}
export function verifyPlatformLogin(store, user) {
  const permission = store.get("platform-access", user.id, "platform");
  if (permission && permission.email === user.email)
    store.put(
      "platform-access",
      user.id,
      "platform",
      { ...permission, verifiedAt: Date.now() },
      permission.version,
    );
}
export async function grantPlatformAccess(store, session, target, input) {
  store.limit("platform-grant-confirm:" + session.user, 10);
  const actor = store.one(
    "SELECT password FROM users WHERE id=?",
    session.user,
  );
  if (
    !platformAdministrator(store, session) ||
    !(await checkPassword(input.password, actor?.password))
  )
    fail(403, "Confirm your current administrator password.");
  return store.transaction(() => {
    const host = store.one(
      "SELECT id,email,household FROM users WHERE id=? AND role='host'",
      target,
    );
    if (
      !host ||
      input.confirmEmail !== host.email ||
      store.one(
        "SELECT household FROM household_deletions WHERE household=?",
        host.household,
      )
    )
      fail(400, "Confirm the registered host email.");
    const current = store.get("platform-access", host.id, "platform");
    if (!current)
      store.put("platform-access", host.id, "platform", {
        email: host.email,
        grantedAt: Date.now(),
        verifiedAt: null,
      });
    return { ok: true, signInAgain: true };
  });
}
export async function retireLegacyAdministrator(store, session, input) {
  store.limit("platform-retire-confirm:" + session.user, 10);
  const permission = store.get("platform-access", session.user, "platform"),
    actor = store.one("SELECT password FROM users WHERE id=?", session.user);
  if (
    !platformAdministrator(store, session) ||
    session.role === "admin" ||
    !permission?.verifiedAt ||
    !(await checkPassword(input.password, actor?.password))
  )
    fail(
      403,
      "Sign in to the promoted host account and confirm its password first.",
    );
  return store.transaction(() => {
    const user = store.one(
      "SELECT id,email FROM users WHERE role='admin' AND email=?",
      text(input.confirmEmail, 254, true),
    );
    if (!user || user.id === session.user)
      fail(400, "Confirm the old administrator email.");
    store.run(
      "INSERT INTO setup_state VALUES(1,1) ON CONFLICT(id) DO UPDATE SET completed=1",
    );
    store.run(
      "DELETE FROM session_origins WHERE token IN (SELECT token FROM sessions WHERE user=?)",
      user.id,
    );
    store.run("DELETE FROM sessions WHERE user=?", user.id);
    store.run("DELETE FROM users WHERE id=? AND role='admin'", user.id);
    return { ok: true };
  });
}

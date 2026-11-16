import { Buffer } from "node:buffer";
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
const P = "platform";
export const DEVICE_COOKIE_SECONDS = 400 * 86400;
export const DEVICE_SESSION_EXPIRY = Number.MAX_SAFE_INTEGER;
export const DEVICE_ROTATION_MS = 86400000;
export const DEVICE_ROTATION_GRACE_MS = 60000;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const token = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const fresh = () => randomBytes(32).toString("base64url");
function rotation(store, raw, origin, now = Date.now()) {
  if (!token(raw)) return null;
  const row = store.get("session-rotation", hash(raw), P);
  return row &&
    row.origin === origin &&
    row.expires > now &&
    store.get("passwordless-session", row.target, P)?.persistent === true
    ? row
    : null;
}
// An old credential is accepted only for a short concurrent-request grace window,
// and only while its replacement remains authorized in the existing sessions table.
export function rotatedSessionHash(store, raw, origin) {
  const alias = rotation(store, raw, origin);
  const next = alias && unseal(raw, alias.box, origin);
  return next && hash(next) === alias.target ? alias.target : null;
}
function key(raw) {
  return createHash("sha256")
    .update("gather-device-rotation-v1:" + raw)
    .digest();
}
function seal(raw, next, origin) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(raw), iv);
  cipher.setAAD(Buffer.from(origin));
  const encrypted = Buffer.concat([
    cipher.update(next, "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
    "base64url",
  );
}
function unseal(raw, box, origin) {
  try {
    const data = Buffer.from(box, "base64url"),
      decipher = createDecipheriv(
        "aes-256-gcm",
        key(raw),
        data.subarray(0, 12),
      );
    decipher.setAAD(Buffer.from(origin));
    decipher.setAuthTag(data.subarray(12, 28));
    const next = Buffer.concat([
      decipher.update(data.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
    return token(next) ? next : null;
  } catch {
    return null;
  }
}
export function persistentProof(proof, now = Date.now()) {
  return {
    ...proof,
    persistent: true,
    deviceId: proof.deviceId || fresh(),
    rotatedAt: now,
  };
}
export function adminSessionRestricted(store, session, now = Date.now()) {
  const proof =
    session?.token && store.get("passwordless-session", session.token, P);
  return (
    !!proof && (proof.adminRestricted !== false || !(proof.adminUntil > now))
  );
}
export function deleteDeviceSessions(store, tokens) {
  for (const value of tokens) {
    store.run("DELETE FROM sessions WHERE token=?", value);
    store.run("DELETE FROM session_origins WHERE token=?", value);
    store.run("DELETE FROM guest_identity_sessions WHERE token=?", value);
    const proof = store.get("passwordless-session", value, P);
    if (proof) store.remove("passwordless-session", proof.id, P, proof.version);
  }
}
export function revokeCurrentDevice(store, session) {
  if (!session) return;
  store.transaction(() => {
    const proof = store.get("passwordless-session", session.token, P);
    const tokens = new Set([session.token]);
    if (proof?.deviceId)
      for (const row of store.list("passwordless-session", P))
        if (row.deviceId === proof.deviceId) tokens.add(row.id);
    deleteDeviceSessions(store, tokens);
  });
}
// Use only after current identity, membership, contact and origin checks pass.
// Security-sensitive rotations use no grace alias (e.g. administrator elevation).
export function refreshDeviceSession(
  store,
  session,
  raw,
  origin,
  { force = false, grace = true, proofChanges = {}, now = Date.now() } = {},
) {
  if (!session || !token(raw)) return null;
  return store.transaction(() => {
    const proof = store.get("passwordless-session", session.token, P);
    if (!proof) return null;
    if (hash(raw) !== session.token) {
      const alias = rotation(store, raw, origin, now);
      const next = alias && unseal(raw, alias.box, origin);
      if (!next || hash(next) !== session.token) return null;
      if (!force)
        return {
          session,
          auth: {
            token: next,
            seconds: DEVICE_COOKIE_SECONDS,
            persistent: true,
          },
        };
      raw = next;
    }
    if (
      !force &&
      proof.persistent &&
      now - (proof.rotatedAt || proof.at || 0) < DEVICE_ROTATION_MS
    )
      return null;
    const current = store.one(
      "SELECT * FROM sessions WHERE token=? AND expires>?",
      session.token,
      now,
    );
    if (!current) return null;
    const next = fresh(),
      target = hash(next),
      nextProof = persistentProof({ ...proof, ...proofChanges }, now);
    store.run(
      "INSERT INTO sessions VALUES(?,?,?,?,?,?)",
      target,
      current.user,
      current.household,
      current.guest,
      current.role,
      DEVICE_SESSION_EXPIRY,
    );
    store.run(
      "INSERT INTO session_origins SELECT ?,origin FROM session_origins WHERE token=?",
      target,
      current.token,
    );
    store.run(
      "INSERT INTO guest_identity_sessions SELECT ?,identity,entry_household FROM guest_identity_sessions WHERE token=?",
      target,
      current.token,
    );
    store.put("passwordless-session", target, P, nextProof);
    // In-flight app handoffs follow rotation, but cannot survive device revocation.
    for (const row of store.list("auth-handoff", P))
      if (
        row.sourceSession === current.token &&
        row.expires > now &&
        row.state === "authorized"
      )
        store.put(
          "auth-handoff",
          row.id,
          P,
          { ...row, sourceSession: target },
          row.version,
        );
    deleteDeviceSessions(store, [current.token]);
    store.run(
      "DELETE FROM records WHERE kind='session-rotation' AND household=? AND json_extract(body,'$.expires')<=?",
      P,
      now,
    );
    if (grace)
      store.put("session-rotation", current.token, P, {
        origin,
        target,
        box: seal(raw, next, origin),
        expires: now + DEVICE_ROTATION_GRACE_MS,
      });
    return {
      session: { ...current, token: target, expires: DEVICE_SESSION_EXPIRY },
      auth: { token: next, seconds: DEVICE_COOKIE_SECONDS, persistent: true },
    };
  });
}

// Security changes revoke every origin-bound session of this registered user,
// including guest-authority handoffs that intentionally have no SQL user field.
export function revokeUserSessions(store, user) {
  const tokens = new Set(
    store
      .all("SELECT token FROM sessions WHERE user=?", user)
      .map((row) => row.token),
  );
  const proofs = store.list("passwordless-session", "platform");
  const identities = new Set(
    proofs
      .filter((proof) => tokens.has(proof.id) && proof.identity)
      .map((proof) => proof.identity),
  );
  for (const proof of proofs)
    if (
      proof.subject === "user:" + user ||
      (proof.identity && identities.has(proof.identity))
    )
      tokens.add(proof.id);
  for (const mapping of store.list("firebase-account", "platform"))
    if (
      mapping.subject === "user:" + user ||
      (mapping.identity && identities.has(mapping.identity))
    )
      store.put(
        "firebase-account",
        mapping.id,
        "platform",
        { ...mapping, notBefore: Math.floor(Date.now() / 1000) },
        mapping.version,
      );
  deleteDeviceSessions(store, [...tokens]);
}
export function revokeHouseholdSessions(store, household) {
  const rows = store.all(
    "SELECT token,user FROM sessions WHERE household=?",
    household,
  );
  for (const user of new Set(rows.map((row) => row.user).filter(Boolean)))
    revokeUserSessions(store, user);
  deleteDeviceSessions(
    store,
    rows.map((row) => row.token),
  );
}

import { hostOnlyMode } from "./host-model.js";
import { boundLoginContext, enrollmentSession } from "./firebase-routing.js";
import { GATHER_ORIGIN } from "./gather-flags.js";
import { auditAccount } from "./account-management.js";
import { firebaseEnroll } from "./firebase-enrollment.js";
import { Buffer } from "node:buffer";
import { webcrypto, randomBytes } from "node:crypto";
import { fail, text, checkPassword } from "./model.js";
import { compareName } from "./guest-identities.js";
import { contactPhone } from "./features.js";
import {
  subjectByKey,
  passwordlessContact,
  accountForOrigin,
  authHash,
  subjects,
} from "./passwordless.js";
import { persistentProof } from "./device-sessions.js";
export const firebaseEnabled = (env) =>
  !hostOnlyMode(env) &&
  env.FIREBASE_AUTH_ENABLED === "true" &&
  env.FIREBASE_ACTIVATION_APPROVED === "true";
const P = "platform";
const neutral =
  "If this request can be completed, continue with verification or use Recover Account.";
const nonce = () => randomBytes(32).toString("base64url");
const valid = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);
const project = (env) =>
  /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(env.FIREBASE_PROJECT_ID || "")
    ? env.FIREBASE_PROJECT_ID
    : fail(503, "Sign-in is not configured.");
const cache = new Map();
export function firebaseConfig(env) {
  if (!firebaseEnabled(env)) return null;
  const projectId = project(env),
    apiKey = text(env.FIREBASE_API_KEY || "", 180),
    authDomain = text(env.FIREBASE_AUTH_DOMAIN || "", 253);
  if (!apiKey || authDomain !== projectId + ".firebaseapp.com")
    fail(503, "Sign-in is not configured.");
  return { projectId, apiKey, authDomain };
}
// Production accepts only RS256 Secure Token signatures for the exact configured project.
// No client-provided issuer/JWKS URL, emulator bypass, service-account secret or raw diagnostics.
export async function verifyFirebaseToken(
  raw,
  env,
  { fetcher = fetch, now = Date.now } = {},
) {
  try {
    if (typeof raw !== "string" || raw.length > 12000) throw 0;
    const parts = raw.split(".");
    if (parts.length !== 3) throw 0;
    const [header, claim] = parts
      .slice(0, 2)
      .map((p) => JSON.parse(Buffer.from(p, "base64url").toString("utf8")));
    const pid = project(env),
      seconds = Math.floor(now() / 1000);
    if (
      header.alg !== "RS256" ||
      typeof header.kid !== "string" ||
      header.kid.length > 160 ||
      claim.aud !== pid ||
      claim.iss !== "https://securetoken.google.com/" + pid ||
      typeof claim.sub !== "string" ||
      !claim.sub ||
      claim.sub.length > 128 ||
      !Number.isSafeInteger(claim.exp) ||
      claim.exp <= seconds ||
      !Number.isSafeInteger(claim.iat) ||
      claim.iat > seconds + 30 ||
      !Number.isSafeInteger(claim.auth_time) ||
      claim.auth_time > seconds + 30 ||
      seconds - claim.auth_time > 300 ||
      claim.firebase?.sign_in_provider !== "phone" ||
      !/^\+[1-9]\d{7,14}$/.test(claim.phone_number || "") ||
      !claim.firebase?.identities?.phone?.includes(claim.phone_number)
    )
      throw 0;
    let keys = cache.get(pid);
    if (!keys || keys.expires <= now()) {
      const response = await fetcher(
        "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
        { redirect: "error", signal: AbortSignal.timeout(10000) },
      );
      if (!response.ok) throw 0;
      const data = await response.json();
      if (!Array.isArray(data.keys) || data.keys.length > 20) throw 0;
      keys = { keys: data.keys, expires: now() + 300000 };
      cache.set(pid, keys);
    }
    const jwk = keys.keys.find((k) => k.kid === header.kid && k.kty === "RSA");
    if (!jwk) throw 0;
    const key = await webcrypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    if (
      !(await webcrypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        Buffer.from(parts[2], "base64url"),
        Buffer.from(parts[0] + "." + parts[1]),
      ))
    )
      throw 0;
    const lookup = await fetcher(
      "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" +
        encodeURIComponent(env.FIREBASE_API_KEY),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: raw }),
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!lookup.ok) throw 0;
    const users = (await lookup.json()).users;
    if (
      !Array.isArray(users) ||
      users.length !== 1 ||
      users[0].disabled ||
      users[0].localId !== claim.sub ||
      users[0].phoneNumber !== claim.phone_number ||
      Number(users[0].validSince || 0) > claim.auth_time
    )
      throw 0;
    return {
      uid: claim.sub,
      phone: claim.phone_number,
      project: pid,
      tokenHash: authHash(raw),
      authTime: claim.auth_time,
    };
  } catch {
    fail(
      401,
      "Verification could not be completed. Try again or use Recover Account.",
    );
  }
}
export function firebaseMappingKey(claim) {
  return authHash(claim.project + ":" + claim.uid);
}
export function revokeFirebaseMappings(store, { identity, user, key } = {}) {
  const subjectsToRevoke = new Set(
    [key, user && "user:" + user, identity && "person:" + identity].filter(
      Boolean,
    ),
  );
  for (const record of store.list("firebase-account", P))
    if (
      subjectsToRevoke.has(record.subject) ||
      (identity && record.identity === identity)
    )
      store.put(
        "firebase-account",
        record.id,
        P,
        { ...record, revoked: true },
        record.version,
      );
}
export function validFirebaseSession(store, session, proof) {
  if (proof.provider !== "firebase") return true;
  const mapping = store.get("firebase-account", proof.mapping, P);
  return (
    !!mapping &&
    !mapping.revoked &&
    mapping.version === proof.mappingVersion &&
    mapping.subject === proof.subject
  );
}
export async function firebaseAPI(ctx) {
  const {
    path,
    method,
    store,
    env,
    req,
    res,
    origin,
    body,
    json,
    cookie,
    newSession,
    session,
  } = ctx;
  if (!path.startsWith("/api/firebase/")) return false;
  if (!firebaseEnabled(env)) fail(404, "Page not found.");
  firebaseConfig(env);
  if (origin !== GATHER_ORIGIN)
    fail(403, "Continue Firebase verification through Gather.");
  if (path === "/api/firebase/start" && method === "POST") {
    const input = await body(req),
      phone = contactPhone(input.phone || "");
    if (
      session &&
      store.get("passwordless-session", session.token, P) &&
      !input.recovery
    ) {
      const existingContext = input.context
        ? boundLoginContext(
            store,
            input.context,
            origin,
            req,
            ctx.householdHosts,
          )
        : null;
      if (!existingContext?.enrollmentSession) {
        json(res, { authenticated: true });
        return true;
      }
    }
    store.limit(
      "firebase-start-ip:" + authHash(req.socket.remoteAddress),
      10,
      900000,
    );
    store.limit("firebase-start-number:" + authHash(phone), 5, 3600000);
    store.limit("firebase-start-cooldown:" + authHash(phone), 1, 60000);
    store.run(
      "DELETE FROM records WHERE household='platform' AND kind IN ('firebase-attempt','firebase-token-used') AND json_extract(body,'$.expires')<=?",
      Date.now(),
    );
    const login = input.context
      ? boundLoginContext(store, input.context, origin, req, ctx.householdHosts)
      : null;
    const reference = nonce(),
      binding = nonce();
    store.put("firebase-attempt", reference, P, {
      first: text(input.first, 80, true),
      last: text(input.last || "", 80),
      phone,
      origin,
      binding: authHash(binding),
      expires: Date.now() + 600000,
      state: "pending",
      context: login?.id || "",
      invitation: login?.invitation || text(input.invitation || "", 80),
      entry: login?.entry || text(input.entry || "", 63),
    });
    res.setHeader(
      "Set-Cookie",
      `__Host-gather_firebase=${binding}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=600`,
    );
    json(res, { reference, message: neutral });
    return true;
  }
  if (path === "/api/firebase/verify" && method === "POST") {
    store.limit(
      "firebase-verify-ip:" + authHash(req.socket.remoteAddress),
      20,
      900000,
    );
    const input = await body(req),
      row =
        valid(input.reference) &&
        store.get("firebase-attempt", input.reference, P);
    const binding = (req.headers.cookie || "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("__Host-gather_firebase="))
      ?.split("=")[1];
    if (
      !row ||
      row.state !== "pending" ||
      row.origin !== origin ||
      row.expires <= Date.now() ||
      !valid(binding) ||
      row.binding !== authHash(binding)
    )
      fail(401, neutral);
    store.limit("firebase-verify-attempt:" + row.id, 5, 600000);
    const claim = await verifyFirebaseToken(input.idToken, env, {
      fetcher: ctx.firebaseFetcher || fetch,
    });
    if (claim.phone !== row.phone) fail(401, neutral);
    const loginBefore = row.context
      ? boundLoginContext(store, row.context, origin, req, ctx.householdHosts)
      : null;
    const ownerBefore = enrollmentSession(store, loginBefore);
    const ownerPasswordHash =
      ownerBefore &&
      store.one("SELECT password FROM users WHERE id=?", ownerBefore.user)
        ?.password;
    if (ownerBefore) {
      store.limit("firebase-owner-confirm:" + ownerBefore.user, 5, 900000);
      if (!(await checkPassword(input.ownerPassword, ownerPasswordHash)))
        fail(
          403,
          "Confirm your current owner password to enroll phone sign-in.",
        );
    }

    const result = store.transaction(() => {
      const current = store.get("firebase-attempt", row.id, P);
      if (
        current.state !== "pending" ||
        current.version !== row.version ||
        store.get("firebase-token-used", claim.tokenHash, P)
      )
        fail(401, neutral);
      const key = firebaseMappingKey(claim);
      let existing = store.get("firebase-account", key, P);
      let candidates = subjects(store).filter(
        (s) =>
          !s.child &&
          s.role !== "admin" &&
          s.phone === claim.phone &&
          compareName(s.first) === compareName(row.first) &&
          compareName(s.last) === compareName(row.last),
      );
      // A phone shared by multiple central people cannot establish account ownership.
      if (subjects(store).filter((s) => s.phone === claim.phone).length !== 1)
        candidates = [];
      let subject = candidates.length === 1 ? candidates[0] : null;
      const login = row.context
        ? boundLoginContext(store, row.context, origin, req, ctx.householdHosts)
        : null;
      const enrollment = enrollmentSession(store, login);
      if (
        enrollment &&
        store.one("SELECT password FROM users WHERE id=?", enrollment.user)
          ?.password !== ownerPasswordHash
      )
        fail(401, "Owner authorization changed. Return to Settings.");
      if (enrollment && subject && subject.key !== "user:" + enrollment.user)
        fail(403, "Enroll only the authenticated owner account.");
      subject =
        firebaseEnroll(store, {
          input,
          row,
          claim,
          subject,
          session: enrollment || session,
        }) || subject;
      if (!subject || subject.child || subject.role === "admin")
        fail(401, neutral);
      const verified = passwordlessContact(store, subject);
      if (!verified || verified.phone !== claim.phone) fail(401, neutral);
      existing = store.get("firebase-account", key, P);
      if (existing && claim.authTime <= (existing.notBefore || 0))
        fail(401, neutral);
      if (
        existing &&
        (existing.subject !== subject.key ||
          ((existing.phone !== claim.phone || existing.revoked) &&
            !input.recovery))
      )
        fail(401, neutral);
      if (
        !input.recovery &&
        !existing &&
        store.list("firebase-account", P).some((m) => m.subject === subject.key)
      )
        fail(401, neutral);
      if (
        store
          .list("firebase-account", P)
          .some((m) => !m.revoked && m.subject === subject.key && m.id !== key)
      )
        fail(401, neutral);
      const account = accountForOrigin(store, subject, ctx.selected);
      const mapping =
        existing && !existing.revoked
          ? existing
          : store.put(
              "firebase-account",
              key,
              P,
              {
                subject: subject.key,
                identity: subject.identity,
                phone: claim.phone,
                created: Date.now(),
                revoked: false,
              },
              existing?.version,
            );
      const auth = newSession({ ...account, passwordless: true });
      store.put(
        "passwordless-session",
        authHash(auth.token),
        P,
        persistentProof({
          provider: "firebase",
          mapping: key,
          mappingVersion: mapping.version,
          subject: subject.key,
          identity: subject.identity,
          contactStamp: verified.stamp,
          adminRestricted: true,
          at: Date.now(),
        }),
      );
      store.put("firebase-token-used", claim.tokenHash, P, {
        expires: Date.now() + 3600000,
      });
      store.put(
        "firebase-attempt",
        row.id,
        P,
        { ...current, state: "consumed", binding: "" },
        current.version,
      );
      auditAccount(
        store,
        "firebase",
        subject.key,
        "firebase-sign-in-verified",
        ["device-session"],
      );
      return { auth, entry: row.entry, invitation: row.invitation };
    });
    cookie(res, result.auth);
    json(res, { ok: true, entry: result.entry, invitation: result.invitation });
    return true;
  }
  fail(404, "Page not found.");
}

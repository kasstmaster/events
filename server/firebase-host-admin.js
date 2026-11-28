import { Buffer } from "node:buffer";
import { createSign } from "node:crypto";
import { fail } from "./model.js";
import { hostFirebaseConfig, hostFirebaseKey } from "./firebase-host.js";

const tokenCache = new Map();
// Share only concurrent OAuth access-token acquisition, never Firebase account
// status or authorization decisions: each request still checks revocation.
const tokenReads = new Map();
const encode = (data) =>
  Buffer.from(JSON.stringify(data)).toString("base64url");

/**
 * This account lookup is authoritative for every existing Gather host session.
 * The PUBLIC Firebase web key cannot retrieve disabled/revoked users by UID.
 * A separate, least-privilege service identity is required and is never sent
 * to browsers, stored in Gather records or logged.
 */
export async function firebaseHostAccountStatus(
  env,
  { project, uid, email, authTime },
  { fetcher = fetch, now = Date.now } = {},
) {
  const config = hostFirebaseConfig(env);
  const serviceEmail = env.HOST_FIREBASE_ADMIN_CLIENT_EMAIL;
  const secret = env.HOST_FIREBASE_ADMIN_PRIVATE_KEY;
  if (
    !config ||
    project !== config.projectId ||
    typeof uid !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(uid) ||
    typeof email !== "string" ||
    !Number.isSafeInteger(authTime) ||
    authTime <= 0
  )
    fail(401, "Sign in to Firebase again.");

  if (
    typeof serviceEmail !== "string" ||
    !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(serviceEmail) ||
    typeof secret !== "string" ||
    !secret.includes("BEGIN PRIVATE KEY")
  )
    fail(503, "Firebase host session verification is not configured.");

  const cacheKey = config.projectId + ":" + serviceEmail;
  let bearer = tokenCache.get(cacheKey);
  if (!bearer || bearer.expires <= now() + 120000) {
    let pending = tokenReads.get(cacheKey);
    if (!pending) {
      // A cold instance can receive several signed-in requests together.
      // Only the access-token exchange is shared; account status is always
      // fetched separately for each request below.
      pending = (async () => {
        let bearer;
      const issued = Math.floor(now() / 1000);
      const payload = [
        encode({ alg: "RS256", typ: "JWT" }),
        encode({
          iss: serviceEmail,
          scope: "https://www.googleapis.com/auth/identitytoolkit",
          aud: "https://oauth2.googleapis.com/token",
          iat: issued,
          exp: issued + 3600,
        }),
      ].join(".");
      let signature;
      try {
        signature = createSign("RSA-SHA256")
          .update(payload)
          .sign(secret.replace(/\\n/g, "\n"), "base64url");
      } catch {
        fail(503, "Firebase host session verification is unavailable.");
      }
      let response;
      try {
        response = await fetcher("https://oauth2.googleapis.com/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion: payload + "." + signature,
          }).toString(),
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        });
      } catch {
        fail(503, "Firebase host session verification is unavailable.");
      }
      if (!response.ok)
        fail(503, "Firebase host session verification is unavailable.");
      const result = await response.json();
      if (
        typeof result.access_token !== "string" ||
        result.token_type?.toLowerCase() !== "bearer" ||
        !Number.isFinite(result.expires_in) ||
        result.expires_in < 120
      )
        fail(503, "Firebase host session verification is unavailable.");
      bearer = {
        token: result.access_token,
        expires: now() + Math.min(result.expires_in, 3600) * 1000,
      };
      tokenCache.set(cacheKey, bearer);

        return bearer;
      })();
      tokenReads.set(cacheKey, pending);
      void pending.then(
        () => {
          if (tokenReads.get(cacheKey) === pending) tokenReads.delete(cacheKey);
        },
        () => {
          if (tokenReads.get(cacheKey) === pending) tokenReads.delete(cacheKey);
        },
      );
    }
    bearer = await pending;
  }
  let response;
  try {
    response = await fetcher(
      "https://identitytoolkit.googleapis.com/v1/projects/" +
        encodeURIComponent(config.projectId) +
        "/accounts:lookup",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer " + bearer.token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ localId: [uid] }),
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      },
    );
  } catch {
    fail(503, "Firebase host session verification is unavailable.");
  }
  if (!response.ok)
    fail(503, "Firebase host session verification is unavailable.");

  const accounts = (await response.json()).users;
  const user =
    Array.isArray(accounts) && accounts.length === 1 ? accounts[0] : null;
  if (
    !user ||
    user.localId !== uid ||
    user.disabled ||
    !user.emailVerified ||
    String(user.email || "").toLowerCase() !== email ||
    Number(user.validSince || 0) > authTime
  )
    return false;
  return true;
}

export async function validFirebaseHostSession(
  store,
  session,
  env,
  { fetcher = fetch, now = Date.now } = {},
) {
  const proof = store.get("passwordless-session", session.token, "platform");
  const identity = proof?.firebase;
  if (
    !proof ||
    proof.provider !== "host-account" ||
    !identity ||
    identity.user !== session.user ||
    identity.household !== session.household ||
    identity.key !== hostFirebaseKey(identity.project, identity.uid)
  )
    return false;

  const mapped = store.get("host-firebase-account", identity.key, "platform");
  if (
    !mapped ||
    mapped.user !== session.user ||
    mapped.household !== session.household ||
    mapped.project !== identity.project ||
    mapped.email !== identity.email
  )
    return false;

  return firebaseHostAccountStatus(env, identity, { fetcher, now });
}

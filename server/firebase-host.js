import { Buffer } from "node:buffer";
import { createHash, webcrypto } from "node:crypto";
import { fail } from "./model.js";
import { hostOnlyMode } from "./host-model.js";

// Separate opt-in for host email/Google Firebase. Never reuse the retired guest SMS flags.
export const hostFirebaseEnabled = (env = {}) =>
  hostOnlyMode(env) &&
  env.HOST_FIREBASE_ENABLED === "true" &&
  env.HOST_FIREBASE_ACTIVATION_APPROVED === "true";

export function hostFirebaseConfig(env = {}) {
  if (!hostFirebaseEnabled(env)) return null;
  const projectId = env.FIREBASE_PROJECT_ID,
    apiKey = env.FIREBASE_API_KEY,
    authDomain = env.FIREBASE_AUTH_DOMAIN;
  if (
    !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId || "") ||
    !/^AIza[A-Za-z0-9_-]{35}$/.test(apiKey || "") ||
    authDomain !== projectId + ".firebaseapp.com"
  )
    fail(503, "Host Firebase authentication is not configured.");
  return { projectId, apiKey, authDomain };
}

const cache = new Map();
const digest = (value) => createHash("sha256").update(value).digest("hex");
export function hostFirebaseKey(project, uid) {
  return digest(project + ":" + uid);
}

// Verifies a signed Firebase ID token, then checks current account state against
// Google's Identity Toolkit. The email is NEVER trusted solely from browser input.
export async function verifyHostFirebaseToken(
  raw,
  env,
  { fetcher = fetch, now = Date.now } = {},
) {
  const message = "Host identity verification failed. Please sign in again.";
  try {
    const config = hostFirebaseConfig(env);
    if (!config || typeof raw !== "string" || raw.length > 12000) throw 0;
    const chunks = raw.split(".");
    if (chunks.length !== 3) throw 0;
    const [header, claim] = chunks.slice(0, 2).map((x) =>
      JSON.parse(Buffer.from(x, "base64url").toString("utf8")),
    );
    const seconds = Math.floor(now() / 1000);
    if (
      header.alg !== "RS256" ||
      !/^[a-zA-Z0-9_-]{1,160}$/.test(header.kid || "") ||
      claim.aud !== config.projectId ||
      claim.iss !== "https://securetoken.google.com/" + config.projectId ||
      typeof claim.sub !== "string" || !claim.sub || claim.sub.length > 128 ||
      !Number.isSafeInteger(claim.iat) || claim.iat > seconds + 30 ||
      !Number.isSafeInteger(claim.exp) || claim.exp <= seconds ||
      !Number.isSafeInteger(claim.auth_time) ||
      claim.auth_time > seconds + 30 || seconds - claim.auth_time > 300 ||
      typeof claim.email !== "string" ||
      !claim.email_verified ||
      !["password", "google.com"].includes(claim.firebase?.sign_in_provider)
    ) throw 0;
    let keys = cache.get(config.projectId);
    if (!keys || keys.expires <= now()) {
      const response = await fetcher(
        "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com",
        { redirect: "error", signal: AbortSignal.timeout(10000) },
      );
      if (!response.ok) throw 0;
      const data = await response.json();
      if (!Array.isArray(data.keys) || data.keys.length > 20) throw 0;
      keys = { keys: data.keys, expires: now() + 300000 };
      cache.set(config.projectId, keys);
    }
    const jwk = keys.keys.find(
      (k) => k.kid === header.kid && k.kty === "RSA",
    );
    if (!jwk) throw 0;
    const key = await webcrypto.subtle.importKey(
      "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false, ["verify"],
    );
    if (!(await webcrypto.subtle.verify(
      "RSASSA-PKCS1-v1_5", key,
      Buffer.from(chunks[2], "base64url"),
      Buffer.from(chunks[0] + "." + chunks[1]),
    ))) throw 0;
    const response = await fetcher(
      "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" +
        encodeURIComponent(config.apiKey),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: raw }),
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok) throw 0;
    const accounts = (await response.json()).users;
    if (!Array.isArray(accounts) || accounts.length !== 1) throw 0;
    const account = accounts[0];
    if (
      account.disabled ||
      account.localId !== claim.sub ||
      !account.emailVerified ||
      String(account.email || "").toLowerCase() !== claim.email.toLowerCase() ||
      Number(account.validSince || 0) > claim.auth_time
    ) throw 0;
    return {
      uid: claim.sub,
      project: config.projectId,
      email: claim.email.toLowerCase(),
      provider: claim.firebase.sign_in_provider,
      authTime: claim.auth_time,
      tokenHash: digest(raw),
    };
  } catch {
    fail(401, message);
  }
}

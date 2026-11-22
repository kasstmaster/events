import { Buffer } from "node:buffer";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { fail, email } from "./model.js";
const fresh = () => randomBytes(32).toString("base64url");
export const hostTokenHash = (value) =>
  createHash("sha256").update(String(value)).digest("hex");
export function googleHostConfigured(env) {
  return (
    /^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(
      env.HOST_GOOGLE_CLIENT_ID || "",
    ) &&
    typeof env.HOST_GOOGLE_CLIENT_SECRET === "string" &&
    !!env.HOST_GOOGLE_CLIENT_SECRET
  );
}
export function bindingCookie(origin, kind) {
  return (origin.startsWith("https:") ? "__Host-" : "") + "gather_host_" + kind;
}
export function readBinding(req, origin, kind) {
  const name = bindingCookie(origin, kind);
  return (
    req.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(name + "="))
      ?.slice(name.length + 1) || ""
  );
}
export function setBinding(
  res,
  origin,
  kind,
  value,
  seconds = 600,
  sameSite = "Strict",
) {
  res.setHeader(
    "Set-Cookie",
    `${bindingCookie(origin, kind)}=${value}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${seconds}${origin.startsWith("https:") ? "; Secure" : ""}`,
  );
}
// Verify actual signed OIDC bytes against Google's fixed JWKS endpoint, never client keys.
export async function verifyGoogleHostToken(
  raw,
  env,
  nonce,
  { fetcher = fetch, now = Date.now } = {},
) {
  try {
    if (typeof raw !== "string" || raw.length > 16384) throw 0;
    const parts = raw.split(".");
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p)))
      throw 0;
    const [head, claims] = parts
      .slice(0, 2)
      .map((p) => JSON.parse(Buffer.from(p, "base64url").toString("utf8")));
    const seconds = Math.floor(now() / 1000);
    if (
      head.alg !== "RS256" ||
      typeof head.kid !== "string" ||
      head.kid.length > 160 ||
      !["https://accounts.google.com", "accounts.google.com"].includes(
        claims.iss,
      ) ||
      claims.aud !== env.HOST_GOOGLE_CLIENT_ID ||
      (claims.azp && claims.azp !== env.HOST_GOOGLE_CLIENT_ID) ||
      claims.nonce !== nonce ||
      claims.email_verified !== true ||
      typeof claims.sub !== "string" ||
      !claims.sub ||
      claims.sub.length > 255 ||
      !Number.isSafeInteger(claims.exp) ||
      claims.exp <= seconds ||
      !Number.isSafeInteger(claims.iat) ||
      claims.iat > seconds + 30 ||
      seconds - claims.iat > 300
    )
      throw 0;
    const response = await fetcher(
      "https://www.googleapis.com/oauth2/v3/certs",
      { redirect: "error", signal: AbortSignal.timeout(10000) },
    );
    if (!response.ok) throw 0;
    const data = await response.json();
    if (!Array.isArray(data.keys) || data.keys.length > 20) throw 0;
    const jwk = data.keys.find(
      (key) =>
        key.kid === head.kid &&
        key.kty === "RSA" &&
        (!key.alg || key.alg === "RS256") &&
        (!key.use || key.use === "sig"),
    );
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
    return { sub: claims.sub, email: email(claims.email) };
  } catch {
    fail(401, "Google verification could not be completed.");
  }
}
export function startGoogleHost(store, env, origin, res, context) {
  if (!googleHostConfigured(env))
    fail(503, "Google host sign-in is not configured.");
  const state = fresh(),
    secret = fresh(),
    verifier = fresh(),
    nonce = fresh();
  store.put("host-google-flow", hostTokenHash(state), "platform", {
    ...context,
    origin,
    binding: hostTokenHash(secret),
    verifier,
    nonce,
    expires: Date.now() + 600000,
  });
  setBinding(res, origin, "oauth", secret, 600, "Lax");
  const params = new URLSearchParams({
    client_id: env.HOST_GOOGLE_CLIENT_ID,
    redirect_uri: origin + "/api/host-auth/google/callback",
    response_type: "code",
    scope: "openid email",
    state,
    nonce,
    code_challenge: hostTokenHashBytes(verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  });
  return "https://accounts.google.com/o/oauth2/v2/auth?" + params;
}
const hostTokenHashBytes = (value) =>
  createHash("sha256").update(value).digest("base64url");
export async function completeGoogleHost(
  store,
  env,
  origin,
  req,
  { fetcher = fetch } = {},
) {
  if (!googleHostConfigured(env))
    fail(503, "Google host sign-in is not configured.");
  const params = new URL(req.url, origin).searchParams,
    state = params.get("state"),
    code = params.get("code"),
    binding = readBinding(req, origin, "oauth");
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(state || "") ||
    !binding ||
    !code ||
    code.length > 4096
  )
    fail(401, "Google sign-in expired. Try again.");
  const flow = store.transaction(() => {
    const row = store.get("host-google-flow", hostTokenHash(state), "platform");
    if (
      !row ||
      row.used ||
      row.origin !== origin ||
      row.expires <= Date.now() ||
      row.binding !== hostTokenHash(binding)
    )
      fail(401, "Google sign-in expired. Try again.");
    store.put(
      "host-google-flow",
      row.id,
      "platform",
      { ...row, used: true, verifier: "", binding: "", nonce: "" },
      row.version,
    );
    return row;
  });
  let response;
  try {
    response = await fetcher("https://oauth2.googleapis.com/token", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: env.HOST_GOOGLE_CLIENT_ID,
        client_secret: env.HOST_GOOGLE_CLIENT_SECRET,
        redirect_uri: origin + "/api/host-auth/google/callback",
        grant_type: "authorization_code",
        code_verifier: flow.verifier,
      }).toString(),
    });
  } catch {
    fail(503, "Google sign-in is unavailable.");
  }
  if (!response.ok) fail(401, "Google verification could not be completed.");
  let result;
  try {
    result = await response.json();
  } catch {
    fail(401, "Google verification could not be completed.");
  }
  return {
    flow,
    identity: await verifyGoogleHostToken(result.id_token, env, flow.nonce, {
      fetcher,
    }),
  };
}

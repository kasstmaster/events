import { readFile, lstat, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { createHash } from "node:crypto";
export const PROJECT = "gather-58a79";
export const CENTRAL = "https://gather.ilymmd.com";
export const SDK = "https://www.gstatic.com/firebasejs/12.6.0/";
export const SDK_AUTH = SDK + "firebase-auth.js";
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export class HarnessError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
export function requireTest(condition, code) {
  if (!condition) throw new HarnessError(code);
}
export function validateConfig(input) {
  requireTest(
    input && typeof input === "object" && !Array.isArray(input),
    "CONFIG_INVALID",
  );
  const fields = [
    "projectId",
    "authDomain",
    "apiKey",
    "fictionalPhoneNumbers",
    "acknowledgeFirebaseFictionalNumbers",
    "acknowledgeProviderTestUserRecord",
  ];
  requireTest(
    Object.keys(input).every((key) => fields.includes(key)),
    "CONFIG_UNKNOWN_FIELD",
  );
  requireTest(
    input.projectId === PROJECT &&
      input.authDomain === PROJECT + ".firebaseapp.com",
    "PROJECT_MISMATCH",
  );
  requireTest(
    typeof input.apiKey === "string" &&
      /^AIza[A-Za-z0-9_-]{35}$/.test(input.apiKey),
    "PUBLIC_CONFIG_INVALID",
  );
  requireTest(
    input.acknowledgeFirebaseFictionalNumbers === true &&
      input.acknowledgeProviderTestUserRecord === true,
    "FICTIONAL_NUMBER_CONFIRMATION_REQUIRED",
  );
  requireTest(
    Array.isArray(input.fictionalPhoneNumbers) &&
      input.fictionalPhoneNumbers.length >= 1 &&
      input.fictionalPhoneNumbers.length <= 3 &&
      input.fictionalPhoneNumbers.every(
        (phone) => typeof phone === "string" && /^\+[1-9]\d{7,14}$/.test(phone),
      ) &&
      new Set(input.fictionalPhoneNumbers).size ===
        input.fictionalPhoneNumbers.length,
    "PHONE_ALLOWLIST_INVALID",
  );
  return Object.freeze({
    ...input,
    fictionalPhoneNumbers: Object.freeze([...input.fictionalPhoneNumbers]),
  });
}
export async function readPrivateConfig(path, repository) {
  const location = resolve(path),
    root = await realpath(repository),
    info = await lstat(location);
  requireTest(
    info.isFile() && !info.isSymbolicLink() && info.size <= 16384,
    "CONFIG_FILE_INVALID",
  );
  const actual = await realpath(location),
    rel = relative(root, actual);
  requireTest(
    isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep),
    "CONFIG_MUST_BE_OUTSIDE_REPOSITORY",
  );
  requireTest(
    (info.mode & 0o077) === 0 &&
      (typeof process.getuid !== "function" || info.uid === process.getuid()),
    "CONFIG_REQUIRES_OWNER_ONLY_PERMISSIONS",
  );
  let value;
  try {
    value = JSON.parse(await readFile(actual, "utf8"));
  } catch {
    throw new HarnessError("CONFIG_INVALID");
  }
  return validateConfig(value);
}
export function tokenPhone(raw) {
  try {
    const part = JSON.parse(
      Buffer.from(raw.split(".")[1], "base64url").toString("utf8"),
    );
    requireTest(
      part.aud === PROJECT &&
        part.iss === "https://securetoken.google.com/" + PROJECT &&
        typeof part.phone_number === "string",
      "TOKEN_PROJECT_INVALID",
    );
    return part.phone_number;
  } catch {
    throw new HarnessError("TOKEN_INVALID");
  }
}
export class NetworkPolicy {
  constructor(config) {
    this.config = config;
    this.phones = new Set(config.fictionalPhoneNumbers);
    this.permits = new Set();
    this.sessions = new Set();
    this.refreshes = new Set();
    this.tokens = new Set();
    this.sends = 0;
    this.blocked = 0;
  }
  phone(value) {
    requireTest(this.phones.has(value), "PHONE_NOT_APPROVED");
    return value;
  }
  permit(phone, token) {
    this.phone(phone);
    // Firebase Auth 1.11.1 (Web SDK 12.6.0) generates a random 50-character
    // alphanumeric token in official appVerificationDisabledForTesting mode.
    // A live reCAPTCHA token must NEVER reach a phone-send endpoint.
    requireTest(
      typeof token === "string" && /^[A-Za-z0-9]{50}$/.test(token),
      "LIVE_CAPTCHA_TOKEN_BLOCKED",
    );
    this.permits.add(digest(phone + ":" + token));
  }
  approveGoogle(url, method, body, mode = "auth") {
    const u = new URL(url);
    requireTest(
      u.protocol === "https:" && !u.port && !u.username && !u.password,
      "NETWORK_BLOCKED",
    );
    if (u.hostname === "identitytoolkit.googleapis.com") {
      requireTest(
        u.searchParams.getAll("key").length === 1 &&
          u.searchParams.get("key") === this.config.apiKey,
        "PROJECT_KEY_MISMATCH",
      );
      if (
        method === "OPTIONS" &&
        [
          "/v1/recaptchaParams",
          "/v1/projects",
          "/v1/accounts:sendVerificationCode",
          "/v1/accounts:signInWithPhoneNumber",
          "/v1/accounts:lookup",
        ].includes(u.pathname)
      )
        return "preflight";
      if (
        method === "GET" &&
        ["/v1/recaptchaParams", "/v1/projects", "/v2/recaptchaConfig"].includes(
          u.pathname,
        )
      )
        return "read";
      requireTest(
        mode === "auth" && method === "POST",
        "PROVIDER_WRITE_BLOCKED",
      );
      const data = JSON.parse(body || "{}");
      if (u.pathname === "/v1/accounts:sendVerificationCode") {
        this.phone(data.phoneNumber);
        requireTest(
          Object.keys(data).every((k) =>
            [
              "phoneNumber",
              "recaptchaToken",
              "clientType",
              "captchaResponse",
              "recaptchaVersion",
            ].includes(k),
          ),
          "SEND_FIELDS_BLOCKED",
        );
        requireTest(
          (data.clientType === undefined ||
            data.clientType === "CLIENT_TYPE_WEB") &&
            (data.captchaResponse === undefined ||
              data.captchaResponse === "NO_RECAPTCHA") &&
            (data.recaptchaVersion === undefined ||
              data.recaptchaVersion === "RECAPTCHA_ENTERPRISE"),
          "LIVE_CAPTCHA_TOKEN_BLOCKED",
        );
        const key = digest(data.phoneNumber + ":" + data.recaptchaToken);
        requireTest(this.permits.delete(key), "UNAPPROVED_SEND_BLOCKED");
        requireTest(++this.sends <= 3, "TEST_ATTEMPT_LIMIT");
        return "fictional-send";
      }
      if (u.pathname === "/v1/accounts:signInWithPhoneNumber") {
        requireTest(
          this.sessions.has(digest(data.sessionInfo || "")) &&
            /^\d{6}$/.test(data.code || "") &&
            Object.keys(data).every((k) => ["sessionInfo", "code"].includes(k)),
          "UNAPPROVED_CONFIRMATION_BLOCKED",
        );
        return "fictional-confirm";
      }
      if (u.pathname === "/v1/accounts:lookup") {
        requireTest(
          this.tokens.has(digest(data.idToken || "")),
          "UNAPPROVED_TOKEN_BLOCKED",
        );
        return "lookup";
      }
      throw new HarnessError("PROVIDER_WRITE_BLOCKED");
    }
    if (u.hostname === "securetoken.googleapis.com") {
      if (
        method === "OPTIONS" &&
        u.pathname === "/v1/token" &&
        u.searchParams.getAll("key").length === 1 &&
        u.searchParams.get("key") === this.config.apiKey
      )
        return "preflight";
      const data = new URLSearchParams(body || "");
      requireTest(
        mode === "auth" &&
          method === "POST" &&
          u.pathname === "/v1/token" &&
          u.searchParams.getAll("key").length === 1 &&
          u.searchParams.get("key") === this.config.apiKey &&
          data.get("grant_type") === "refresh_token" &&
          this.refreshes.has(digest(data.get("refresh_token") || "")),
        "UNAPPROVED_REFRESH_BLOCKED",
      );
      return "refresh";
    }
    requireTest(method === "GET" || method === "POST", "NETWORK_BLOCKED");
    if (
      u.hostname === "www.gstatic.com" &&
      method === "GET" &&
      (u.pathname.startsWith("/firebasejs/12.6.0/") ||
        u.pathname.startsWith("/recaptcha/"))
    )
      return "asset";
    if (
      ["www.google.com", "www.recaptcha.net", "recaptcha.google.com"].includes(
        u.hostname,
      ) &&
      u.pathname.startsWith("/recaptcha/")
    )
      return "captcha";
    if (
      u.hostname === PROJECT + ".firebaseapp.com" &&
      method === "GET" &&
      u.pathname.startsWith("/__/auth/")
    )
      return "asset";
    if (
      ["fonts.gstatic.com", "fonts.googleapis.com"].includes(u.hostname) &&
      method === "GET"
    )
      return "asset";
    throw new HarnessError("NETWORK_BLOCKED");
  }
  capture(kind, json) {
    if (kind === "fictional-send" && json.sessionInfo) {
      requireTest(
        typeof json.sessionInfo === "string",
        "PROVIDER_RESPONSE_INVALID",
      );
      this.sessions.add(digest(json.sessionInfo));
    }
    if (["fictional-confirm", "refresh"].includes(kind)) {
      const token = json.idToken || json.id_token,
        refresh = json.refreshToken || json.refresh_token;
      if (token) {
        this.phone(tokenPhone(token));
        this.tokens.add(digest(token));
      }
      if (refresh) this.refreshes.add(digest(refresh));
    }
  }
  async backendFetch(url, options = {}, transport = fetch) {
    if (
      url ===
      "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
    ) {
      requireTest(
        !options.method || options.method === "GET",
        "BACKEND_NETWORK_BLOCKED",
      );
    } else {
      requireTest(
        this.approveGoogle(url, options.method || "GET", options.body) ===
          "lookup",
        "BACKEND_NETWORK_BLOCKED",
      );
    }
    return transport(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  }
}
export function sdkShim(config) {
  const remote = SDK_AUTH + "?gather-fictional-only=1";
  return `import * as sdk from ${JSON.stringify(remote)};
 export * from ${JSON.stringify(remote)};
 const allowed=new Set(${JSON.stringify(config.fictionalPhoneNumbers)});
 export function getAuth(...args){const auth=sdk.getAuth(...args);auth.settings.appVerificationDisabledForTesting=true;return auth;}
 export class RecaptchaVerifier extends sdk.RecaptchaVerifier {constructor(auth,...args){auth.settings.appVerificationDisabledForTesting=true;super(auth,...args);}}
 export async function signInWithPhoneNumber(auth,phone,verifier){
  if(!allowed.has(phone)||auth.app.options.projectId!==${JSON.stringify(PROJECT)})throw Error('Unapproved test request.');
  auth.settings.appVerificationDisabledForTesting=true;
  const verify=verifier.verify.bind(verifier);
  verifier.verify=async()=>{const value=await verify();await window.__gatherFictionalPermit(phone,value);return value;};
  return sdk.signInWithPhoneNumber(auth,phone,verifier);
 }`;
}

import { validChildDeviceRecord } from "./passwordless.js";
import { randomBytes } from "node:crypto";
import { fail } from "./model.js";
import {
  authHash,
  GATHER_ORIGIN,
  passwordlessEnabled,
  subjectByKey,
  passwordlessContact,
  accountForOrigin,
  activeHouseholdLabel,
} from "./passwordless.js";
const P = "platform",
  valid = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{43}$/.test(s),
  nonce = () => randomBytes(32).toString("base64url");
export function accountHome(store, subject, hosts, fallback) {
  if (subject.role === "host" || subject.role === "family") {
    const house = store.household(subject.household),
      label = activeHouseholdLabel(store, house, hosts),
      hostname = label && label + ".ilymmd.com";
    return hosts.has(hostname) ? "https://" + hostname : fallback;
  }
  return GATHER_ORIGIN;
}
export async function handoffAPI(ctx) {
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
    householdHosts,
    selected,
    newSession,
    cookie,
  } = ctx;
  if (
    !path.startsWith("/api/passwordless/handoff") &&
    path !== "/api/passwordless/home"
  )
    return false;
  if (!passwordlessEnabled(env)) fail(404, "Page not found.");
  const allowed = new Set([
    origin,
    ctx.canonicalOrigin || origin,
    GATHER_ORIGIN,
    ...[...householdHosts].map((host) => "https://" + host),
  ]);
  const bindingName = "__Host-gather_transfer",
    binding =
      req.headers.cookie
        ?.split(";")
        .map((p) => p.trim())
        .find((p) => p.startsWith(bindingName + "="))
        ?.slice(bindingName.length + 1) || "";
  if (path === "/api/passwordless/home" && method === "GET") {
    const record =
        session && store.get("passwordless-session", session.token, P),
      subject = record && subjectByKey(store, record.subject);
    if (!subject) fail(401, "Please sign in.");
    json(res, { home: accountHome(store, subject, householdHosts, origin) });
    return true;
  }
  if (method !== "POST") fail(405, "Method not allowed.");
  const input = await body(req);
  store.limit("auth-handoff:" + authHash(req.socket.remoteAddress), 30, 60000);
  if (path === "/api/passwordless/handoff/prepare") {
    store.limit("auth-handoff-global", 120, 60000);
    store.run(
      "DELETE FROM records WHERE kind='auth-handoff' AND json_extract(body,'$.expires')<?",
      Date.now(),
    );
    if (!allowed.has(input.source) || input.source === origin)
      fail(400, "Unsupported app handoff.");
    const request = nonce(),
      secret = nonce();
    store.put("auth-handoff", request, P, {
      source: input.source,
      target: origin,
      bindingHash: authHash(secret),
      state: "prepared",
      expires: Date.now() + 60000,
      invitation: valid(input.invitation) ? input.invitation : "",
    });
    res.setHeader(
      "Set-Cookie",
      bindingName +
        "=" +
        secret +
        "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=60",
    );
    json(res, { url: input.source + "/signin#transfer-request=" + request });
    return true;
  }
  if (!valid(input.request))
    fail(401, "App handoff expired. Sign in inside this app.");
  if (path === "/api/passwordless/handoff/authorize") {
    const token = nonce();
    const target = store.transaction(() => {
      const row = store.get("auth-handoff", input.request, P),
        record = session && store.get("passwordless-session", session.token, P);
      if (
        !record ||
        !row ||
        row.expires <= Date.now() ||
        row.state !== "prepared" ||
        row.source !== origin ||
        !allowed.has(row.target)
      )
        fail(401, "App handoff expired. Sign in inside this app.");
      store.put(
        "auth-handoff",
        row.id,
        P,
        {
          ...row,
          state: "authorized",
          tokenHash: authHash(token),
          subject: record.subject,
          contactStamp: record.contactStamp,
          childDeviceHash: record.childDeviceHash || "",
          sourceSession: session.token,
        },
        row.version,
      );
      return row.target;
    });
    json(res, {
      url: target + "/signin#transfer=" + input.request + "." + token,
    });
    return true;
  }
  if (path === "/api/passwordless/handoff/redeem") {
    const result = store.transaction(() => {
      const row = store.get("auth-handoff", input.request, P),
        subject = row && subjectByKey(store, row.subject),
        verified = subject && passwordlessContact(store, subject);
      if (
        !row ||
        row.state !== "authorized" ||
        row.expires <= Date.now() ||
        row.target !== origin ||
        !valid(binding) ||
        row.bindingHash !== authHash(binding) ||
        !valid(input.token) ||
        row.tokenHash !== authHash(input.token) ||
        !verified ||
        !validChildDeviceRecord(store, subject, row.childDeviceHash) ||
        verified.stamp !== row.contactStamp ||
        !store.one(
          "SELECT token FROM sessions WHERE token=? AND expires>?",
          row.sourceSession,
          Date.now(),
        )
      )
        fail(401, "App handoff expired. Sign in inside this app.");
      const account = accountForOrigin(store, subject, selected);
      store.put(
        "auth-handoff",
        row.id,
        P,
        { ...row, state: "consumed", tokenHash: "", bindingHash: "" },
        row.version,
      );
      const auth = newSession({ ...account, passwordless: true });
      store.put("passwordless-session", authHash(auth.token), P, {
        subject: subject.key,
        identity: subject.identity,
        contactStamp: verified.stamp,
        childDeviceHash: row.childDeviceHash || "",
        adminRestricted: true,
        at: Date.now(),
      });
      return { auth, invitation: row.invitation };
    });
    cookie(res, result.auth);
    json(res, { ok: true, invitation: result.invitation });
    return true;
  }
  fail(404, "Page not found.");
}

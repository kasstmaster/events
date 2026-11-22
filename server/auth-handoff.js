import {
  hostSignupEnabled,
  validHostSession,
  persistentHostSession,
} from "./host-signup.js";
import { validFirebaseSession } from "./firebase-auth.js";
import { persistentProof } from "./device-sessions.js";
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
    path: originalPath,
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
  const native = originalPath.startsWith("/api/host-auth/");
  const path = native
    ? originalPath.replace("/api/host-auth/", "/api/passwordless/")
    : originalPath;
  if (
    !path.startsWith("/api/passwordless/handoff") &&
    path !== "/api/passwordless/home"
  )
    return false;
  if (native ? !hostSignupEnabled(env) : !passwordlessEnabled(env))
    fail(404, "Page not found.");
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
      subject =
        native &&
        record?.provider === "host-account" &&
        validHostSession(store, session, record)
          ? { role: "host", household: session.household }
          : !native && record && subjectByKey(store, record.subject);
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
      native,
      next: native && input.next === "account" ? "account" : "home",
      invitation: native ? "" : valid(input.invitation) ? input.invitation : "",
    });
    res.setHeader(
      "Set-Cookie",
      bindingName +
        "=" +
        secret +
        "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=60",
    );
    json(res, {
      url:
        input.source +
        "/signin#" +
        (native ? "host-transfer-request=" : "transfer-request=") +
        request,
    });
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
      if (row.native !== native)
        fail(401, "App handoff expired. Sign in inside this app.");
      if (native) {
        const label = new URL(row.target).hostname.split(".")[0];
        const target = householdHosts.has(new URL(row.target).hostname)
          ? store.hostnameHousehold(label)
          : null;
        if (
          record.provider !== "host-account" ||
          !validHostSession(store, session, record) ||
          (target && target.id !== session.household)
        )
          fail(403, "This household is not available to your account.");
      }
      store.put(
        "auth-handoff",
        row.id,
        P,
        {
          ...row,
          state: "authorized",
          tokenHash: authHash(token),
          user: native ? session.user : undefined,
          household: native ? session.household : undefined,
          stamp: native ? record.stamp : undefined,
          subject: record.subject,
          contactStamp: record.contactStamp,
          childDeviceHash: record.childDeviceHash || "",
          sourceSession: session.token,
          deviceId: record.deviceId,
          firebase: native ? record.firebase : undefined,
          adminFallback: native ? record.adminFallback === true : undefined,
          provider: record.provider,
          mapping: record.mapping,
          mappingVersion: record.mappingVersion,
        },
        row.version,
      );
      return row.target;
    });
    json(res, {
      url:
        target +
        "/signin#" +
        (native ? "host-transfer=" : "transfer=") +
        input.request +
        "." +
        token +
        (native &&
        store.get("auth-handoff", input.request, P)?.next === "account"
          ? "&host-settings=1"
          : ""),
    });
    return true;
  }
  if (path === "/api/passwordless/handoff/redeem") {
    const result = store.transaction(() => {
      const row = store.get("auth-handoff", input.request, P);
      if (native) {
        const source =
          row &&
          store.one(
            "SELECT * FROM sessions WHERE token=? AND expires>?",
            row.sourceSession,
            Date.now(),
          );
        if (
          !row ||
          row.native !== true ||
          row.state !== "authorized" ||
          row.expires <= Date.now() ||
          row.target !== origin ||
          row.bindingHash !== authHash(binding) ||
          !valid(binding) ||
          !valid(input.token) ||
          row.tokenHash !== authHash(input.token) ||
          !source ||
          !validHostSession(store, source, row) ||
          (selected && selected.id !== row.household)
        )
          fail(401, "App handoff expired. Sign in inside this app.");
        store.put(
          "auth-handoff",
          row.id,
          P,
          { ...row, state: "consumed", tokenHash: "", bindingHash: "" },
          row.version,
        );
        return {
          auth: persistentHostSession(
            store,
            { user: source.user, household: source.household, role: "host" },
            origin,
            row.deviceId,
            row.firebase,
            row.adminFallback === true,
          ),
          next: row.next,
          invitation: "",
        };
      }
      const subject = row && subjectByKey(store, row.subject),
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
        !validFirebaseSession(store, null, row) ||
        !verified ||
        !validChildDeviceRecord(store, subject, row.childDeviceHash, {
          allowExpired: true,
        }) ||
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
      store.put(
        "passwordless-session",
        authHash(auth.token),
        P,
        persistentProof({
          subject: subject.key,
          identity: subject.identity,
          contactStamp: verified.stamp,
          childDeviceHash: row.childDeviceHash || "",
          adminRestricted: true,
          deviceId: row.deviceId,
          provider: row.provider,
          mapping: row.mapping,
          mappingVersion: row.mappingVersion,
          at: Date.now(),
        }),
      );
      return { auth, invitation: row.invitation };
    });
    cookie(res, result.auth);
    json(res, {
      ok: true,
      invitation: result.invitation,
      ...(native ? { next: result.next } : {}),
    });
    return true;
  }
  fail(404, "Page not found.");
}

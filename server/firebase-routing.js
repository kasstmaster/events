import { randomBytes } from "node:crypto";
import { fail } from "./model.js";
import { firebaseEnabled } from "./firebase-auth.js";
import { GATHER_ORIGIN } from "./gather-flags.js";
import {
  authHash,
  activeEntry,
  activeHouseholdLabel,
  subjectByKey,
  accountForOrigin,
  validPasswordlessSession,
} from "./passwordless.js";
import { accountHome } from "./auth-handoff.js";
import { resolveRSVPReference } from "./invitation-routing.js";
const P = "platform",
  COOKIE = "__Host-gather_central";
const valid = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const nonce = () => randomBytes(32).toString("base64url");
const binding = (req) =>
  (req.headers.cookie || "")
    .split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(COOKIE + "="))
    ?.slice(COOKIE.length + 1) || "";
function currentContext(store, reference, hosts) {
  const row =
    valid(reference) && store.get("firebase-login-context", reference, P);
  if (!row || row.state !== "pending" || row.expires <= Date.now())
    fail(
      401,
      "Sign-in context expired. Return to your invitation or household and try again.",
    );
  if (
    row.household &&
    activeEntry(store, row.entry, hosts)?.id !== row.household
  )
    fail(404, "This household address is unavailable.");
  if (row.invitation) {
    const ref = store.get("rsvp-reference", row.invitation, P),
      event = ref && store.get("event", ref.event, ref.household);
    if (
      !event ||
      ref.household !== row.household ||
      !ref.guests.some((id) => event.invited.includes(id))
    )
      fail(404, "Invitation unavailable.");
  }
  return row;
}
export function boundLoginContext(store, reference, origin, req, hosts) {
  if (origin !== GATHER_ORIGIN) fail(403, "Continue sign-in through Gather.");
  const row = currentContext(store, reference, hosts),
    secret = binding(req);
  if (
    !valid(secret) ||
    !row.browserHash ||
    row.browserHash !== authHash(secret)
  )
    fail(
      401,
      "Sign-in context belongs to another browser. Return to your household and try again.",
    );
  return row;
}
export function enrollmentSession(store, row) {
  if (!row?.enrollmentSession) return null;
  const session = store.one(
    "SELECT * FROM sessions WHERE token=? AND expires>?",
    row.enrollmentSession,
    Date.now(),
  );
  const scope =
    session &&
    store.one(
      "SELECT origin FROM session_origins WHERE token=?",
      session.token,
    );
  if (
    !session ||
    session.role !== "host" ||
    scope?.origin !== row.source ||
    session.household !== row.household ||
    !validPasswordlessSession(store, session) ||
    store.one("SELECT disabled FROM family_members WHERE id=?", session.user)
      ?.disabled ||
    !store.one(
      "SELECT id FROM users WHERE id=? AND household=? AND role='host'",
      session.user,
      row.household,
    )
  )
    fail(401, "Owner enrollment authorization expired. Return to Settings.");
  return session;
}
export async function firebaseRoutingAPI(ctx) {
  const {
    path,
    method,
    store,
    env,
    origin,
    session,
    req,
    res,
    body,
    json,
    selected,
    householdHosts,
  } = ctx;
  if (!path.startsWith("/api/firebase/routing/")) return false;
  if (!firebaseEnabled(env)) fail(404, "Page not found.");
  if (method !== "POST") fail(405, "Method not allowed.");
  const input = await body(req);
  store.limit(
    "firebase-routing:" + authHash(req.socket.remoteAddress),
    40,
    60000,
  );
  if (path === "/api/firebase/routing/start") {
    if (
      Object.keys(input).some(
        (k) => !["entry", "invitation", "enroll"].includes(k),
      )
    )
      fail(400, "Unsupported sign-in context.");
    if (session && !input.enroll) {
      json(res, { authenticated: true });
      return true;
    }
    if (input.enroll && session?.role !== "host")
      fail(403, "A signed-in household owner is required.");
    let house =
      selected ||
      (input.entry && activeEntry(store, input.entry, householdHosts)) ||
      null;
    if (
      input.entry &&
      (!house ||
        activeEntry(store, input.entry, householdHosts)?.id !== house.id)
    )
      fail(404, "This household address is unavailable.");
    const invitation = input.invitation || "";
    if (invitation) {
      const ref =
        valid(invitation) && store.get("rsvp-reference", invitation, P);
      if (!ref || (house && ref.household !== house.id))
        fail(404, "Invitation unavailable.");
      house = store.household(ref.household);
    }
    const entry = house && activeHouseholdLabel(store, house, householdHosts);
    if (house && !entry) fail(404, "This household address is unavailable.");
    if (input.enroll && (!house || house.id !== session.household))
      fail(403, "Enroll only your own household account.");
    const reference = nonce();
    store.run(
      "DELETE FROM records WHERE kind='firebase-login-context' AND household=? AND json_extract(body,'$.expires')<=?",
      P,
      Date.now(),
    );
    store.put("firebase-login-context", reference, P, {
      state: "pending",
      expires: Date.now() + 600000,
      source: origin,
      household: house?.id || null,
      entry: entry || "",
      invitation,
      target: selected
        ? origin
        : house && origin !== GATHER_ORIGIN
          ? "https://" + entry + ".ilymmd.com"
          : null,
      enrollmentSession: input.enroll ? session.token : null,
    });
    currentContext(store, reference, householdHosts);
    json(res, { url: GATHER_ORIGIN + "/signin#login-context=" + reference });
    return true;
  }
  if (origin !== GATHER_ORIGIN) fail(403, "Continue sign-in through Gather.");
  if (path === "/api/firebase/routing/context") {
    const row = currentContext(store, input.reference, householdHosts),
      previous = binding(req),
      secret = valid(previous) ? previous : nonce();
    if (row.browserHash && row.browserHash !== authHash(secret))
      fail(401, "Sign-in context belongs to another browser.");
    if (!row.browserHash)
      store.put(
        "firebase-login-context",
        row.id,
        P,
        { ...row, browserHash: authHash(secret) },
        row.version,
      );
    res.setHeader(
      "Set-Cookie",
      COOKIE +
        "=" +
        secret +
        "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=600",
    );
    json(res, {
      entry: row.entry,
      invitation: row.invitation,
      enrollment: !!row.enrollmentSession,
    });
    return true;
  }
  if (path === "/api/firebase/routing/complete") {
    const row = boundLoginContext(
        store,
        input.reference,
        origin,
        req,
        householdHosts,
      ),
      proof = session && store.get("passwordless-session", session.token, P),
      subject = proof && subjectByKey(store, proof.subject);
    if (!subject) fail(401, "Please sign in before continuing.");
    let destination = GATHER_ORIGIN;
    if (row.invitation)
      destination = resolveRSVPReference(
        store,
        row.invitation,
        session,
        householdHosts,
      ).destination;
    else if (row.target) {
      const house = store.household(row.household),
        hostname = new URL(row.target).hostname;
      if (
        activeEntry(
          store,
          hostname.replace(/\.ilymmd\.com$/, ""),
          householdHosts,
        )?.id !== house?.id
      )
        fail(404, "This household address is unavailable.");
      accountForOrigin(store, subject, house);
      destination = row.target;
    } else if (row.household) {
      accountForOrigin(store, subject, store.household(row.household));
      destination =
        subject.role === "guest"
          ? GATHER_ORIGIN + "/" + row.entry
          : "https://" + row.entry + ".ilymmd.com";
    } else
      destination = accountHome(store, subject, householdHosts, GATHER_ORIGIN);
    store.put(
      "firebase-login-context",
      row.id,
      P,
      { ...row, state: "consumed", browserHash: "", enrollmentSession: null },
      row.version,
    );
    json(res, { destination, invitation: row.invitation, entry: row.entry });
    return true;
  }
  fail(404, "Page not found.");
}

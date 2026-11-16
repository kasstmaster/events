import { accessFor } from "./guest-access.js";
import { verifiedGuestContact } from "./guest-auth.js";
import { randomBytes } from "node:crypto";
import { id, text, fail } from "./model.js";
import { subjects, subjectByKey, authHash } from "./passwordless.js";
import { compareName, guestRelations } from "./guest-identities.js";
import {
  profileForIdentity,
  personalAccount,
  propagatePersonalProfile,
} from "./personal-accounts.js";
import {
  confirmAdministrator,
  auditAccount,
  revokeAccount,
  principal,
  projection,
} from "./account-management.js";
import { contactPhone } from "./features.js";
const P = "platform";
const neutral =
  "Your request has been received. The administrator will review it privately.";
function matches(store, input) {
  return subjects(store).filter(
    (s) =>
      s.role !== "admin" &&
      compareName(s.first) === compareName(input.first) &&
      compareName(s.last) === compareName(input.last) &&
      profileForIdentity(store, s.identity)?.publicCode === input.householdId,
  );
}
export function recoveryEnrollment(store, { input, row, claim }) {
  if (!input.recovery) return null;
  const [reference, secret] = String(input.recovery).split("."),
    request = store.get("account-recovery", reference, P);
  if (
    !request ||
    request.status !== "authorized" ||
    request.expires <= Date.now() ||
    request.phone !== claim.phone ||
    request.grantHash !== authHash(secret || "")
  )
    fail(401, "Recovery authorization is unavailable.");
  const s = subjectByKey(store, request.subject),
    p = s && profileForIdentity(store, s.identity);
  if (
    !s ||
    !p ||
    s.child ||
    s.role === "admin" ||
    compareName(s.first) !== compareName(row.first) ||
    compareName(s.last) !== compareName(row.last)
  )
    fail(401, "Recovery authorization is unavailable.");
  if (
    subjects(store).some(
      (other) => other.key !== s.key && other.phone === claim.phone,
    )
  )
    fail(401, "Recovery authorization is unavailable.");
  revokeAccount(store, s.identity, s.user);
  const account = personalAccount(store, s.identity);
  store.put(
    "person-account",
    s.identity,
    P,
    { ...account, recoveryPhone: claim.phone, recoveryVerified: true },
    account?.version,
  );
  const old = store.get("guest-auth-contact", s.identity, P);
  store.put(
    "guest-auth-contact",
    s.identity,
    P,
    {
      phone: claim.phone,
      verified: true,
      verifiedAt: Date.now(),
      source: "firebase-recovery",
    },
    old?.version,
  );
  const enroll = store.get("passwordless-contact", s.key, P);
  store.put(
    "passwordless-contact",
    s.key,
    P,
    { phone: claim.phone, verified: true, at: Date.now() },
    enroll?.version,
  );
  const next = store.put(
    "personal-household",
    p.id,
    P,
    {
      ...p,
      members: p.members.map((m) =>
        m.identity === s.identity ? { ...m, phone: claim.phone } : m,
      ),
    },
    p.version,
  );
  propagatePersonalProfile(store, next);
  store.put(
    "account-recovery",
    request.id,
    P,
    {
      ...request,
      status: "completed",
      completedAt: Date.now(),
      grantHash: "",
      phone: "",
      expires: 0,
    },
    request.version,
  );
  auditAccount(
    store,
    request.actor,
    request.id,
    "firebase-recovery-completed",
    ["verified-phone", "sessions", "credential-mappings"],
  );
  return subjectByKey(store, s.key);
}
export async function accountRecoveryAPI(ctx) {
  const { path, method, store, session, req, body, json } = ctx;
  if (path === "/api/account-recovery" && method === "POST") {
    const input = await body(req);
    store.limit(
      "recovery-ip:" + authHash(req.socket.remoteAddress),
      5,
      3600000,
    );
    const hint = {
      first: text(input.first, 80, true),
      last: text(input.last || "", 80),
      householdId: text(input.householdId, 4, true),
    };
    if (!/^\d{4}$/.test(hint.householdId))
      fail(400, "Enter a four-digit Household ID.");
    store.limit(
      "recovery-hint:" +
        authHash(
          compareName(hint.first) +
            ":" +
            compareName(hint.last) +
            ":" +
            hint.householdId,
        ),
      3,
      3600000,
    );
    const found = matches(store, hint);
    const requestId = id();
    store.put("account-recovery", requestId, P, {
      ...hint,
      status: "pending",
      at: Date.now(),
      subject: found.length === 1 ? found[0].key : null,
    });
    auditAccount(
      store,
      "public-recovery",
      requestId,
      "account-recovery-submitted",
    );
    json(ctx.res, { message: neutral });
    return true;
  }
  if (path !== "/api/admin/account-recovery" || method !== "POST") return false;
  const input = await body(req);
  await confirmAdministrator(store, session, input.password);
  if (input.action === "list") {
    const offset = input.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000)
      fail(400, "Choose a valid recovery page.");
    const total = store.list("account-recovery", P).length;
    const records = store
      .list("account-recovery", P)
      .sort((a, b) => b.at - a.at)
      .slice(offset, offset + 50)
      .map((r) => {
        const subject = r.subject && subjectByKey(store, r.subject);
        const account = subject
          ? projection(store, principal(store, subject.key))
          : null;
        const contacts = subject?.identity
          ? guestRelations(store, subject.identity).map((rel) => {
              const household = store.household(rel.household),
                host = store.one(
                  "SELECT id,email FROM users WHERE household=? AND role='host'",
                  rel.household,
                );
              const owner =
                host && store.get("host-person", host.id, rel.household);
              return {
                household: household?.name || "",
                email: host?.email || "",
                phone: owner
                  ? verifiedGuestContact(store, owner.identity)?.phone || ""
                  : "",
                relationship: "Address Book contact",
              };
            })
          : [];
        return {
          id: r.id,
          status: r.status,
          at: r.at,
          first: r.first,
          last: r.last,
          householdId: r.householdId,
          subject: r.subject,
          version: r.version,
          review: r.review || "",
          audit: store
            .list("account-admin-audit", P)
            .filter((a) => a.subject === r.id)
            .map((a) => ({ at: a.at, actor: a.actor, action: a.action })),
          account,
          contacts,
        };
      });
    auditAccount(store, session.user, "queue", "account-recovery-read");
    json(ctx.res, {
      records,
      nextOffset:
        offset + records.length < total ? offset + records.length : null,
    });
    return true;
  }
  const record = store.get("account-recovery", input.id, P);
  if (!record || record.version !== input.version)
    fail(409, "Recovery request changed. Review it again.");
  if (!["review", "authorize", "reject"].includes(input.action))
    fail(400, "Choose a recovery action.");
  const review = text(input.review, 2000, true);
  let grant = "",
    reviewedSubject = record.subject;
  store.transaction(() => {
    if (input.action === "authorize") {
      reviewedSubject = record.subject || text(input.subject || "", 150);
      const reviewedPerson =
        reviewedSubject && subjectByKey(store, reviewedSubject);
      if (
        !reviewedPerson ||
        reviewedPerson.child ||
        reviewedPerson.role === "admin" ||
        input.verifiedIdentity !== true
      )
        fail(
          400,
          "Independently verify the intended person before authorizing recovery.",
        );
      const phone = contactPhone(input.phone || "");
      if (!phone)
        fail(400, "Enter the replacement international phone number.");
      if (
        subjects(store).some(
          (s) => s.key !== reviewedSubject && s.phone === phone,
        )
      )
        fail(409, "That phone cannot be associated with this account.");
      const secret = randomBytes(32).toString("base64url");
      grant = record.id + "." + secret;
      // Issuance itself revokes access; new authority is granted only after fresh Firebase proof.
      const subject = reviewedPerson;
      revokeAccount(store, subject.identity, subject.user);
      store.put(
        "account-recovery",
        record.id,
        P,
        {
          ...record,
          subject: reviewedSubject,
          status: "authorized",
          review,
          actor: session.user,
          phone,
          grantHash: authHash(secret),
          expires: Date.now() + 1800000,
        },
        record.version,
      );
    } else
      store.put(
        "account-recovery",
        record.id,
        P,
        {
          ...record,
          status: input.action === "reject" ? "rejected" : "reviewed",
          review,
          actor: session.user,
        },
        record.version,
      );
    auditAccount(
      store,
      session.user,
      record.id,
      "account-recovery-" + input.action,
      ["review"],
    );
  });
  json(ctx.res, {
    ok: true,
    ...(grant
      ? { recoveryURL: "https://gather.ilymmd.com/#recover=" + grant }
      : {}),
  });
  return true;
}

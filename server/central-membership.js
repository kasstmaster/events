import { isolatedAddressBook } from "./recipient-isolation.js";
import { randomBytes, randomInt } from "node:crypto";
import { fail, id } from "./model.js";
import { confirmAdministrator, auditAccount } from "./account-management.js";
import {
  profileForIdentity,
  personalAccount,
  privateIdentity,
  propagatePersonalProfile,
} from "./personal-accounts.js";
import { contactPhone } from "./features.js";
const P = "platform";
export function centralPerson(store, identity) {
  const profile = profileForIdentity(store, identity),
    person = profile?.members.find(
      (p) => p.identity === identity && !p.archived,
    );
  return person ? { profile, person } : null;
}
export function primaryIdentity(store, household) {
  const user = store.one(
    "SELECT id FROM users WHERE household=? AND role='host'",
    household,
  );
  return user && store.get("host-person", user.id, household)?.identity;
}
export function membership(store, household, identity) {
  const central = centralPerson(store, identity);
  if (!central || central.profile.sourceHousehold !== household) return null;
  const record = store.get("household-member", identity, household);
  if (record && (record.role === "child") !== !!central.person.parent)
    return null;
  if (record)
    return { ...record, person: central.person, profile: central.profile };
  if (primaryIdentity(store, household) === identity && !central.person.parent)
    return {
      id: identity,
      identity,
      household,
      status: "approved",
      role: "adult",
      owner: true,
      allowSignIn: true,
      version: 0,
      ...central,
    };
  return null;
}
export function workspaceId(store, household, identity) {
  const person = centralPerson(store, identity);
  const legacy =
    person &&
    store
      .list("family-profile-member", household)
      .find(
        (link) =>
          link.profile === person.profile.id &&
          link.member === person.person.id,
      );
  return legacy?.id || identity;
}
export function centralMemberForActor(store, session) {
  if (session?.household && isolatedAddressBook(store, session.household))
    return null;
  if (!session?.household || !session.user) return null;
  let identity = store.get(
    "household-member",
    session.user,
    session.household,
  )?.identity;
  const legacy = store.get(
    "family-profile-member",
    session.user,
    session.household,
  );
  if (!identity && legacy)
    identity = store
      .get("personal-household", legacy.profile, P)
      ?.members.find((p) => p.id === legacy.member)?.identity;
  const member = identity && membership(store, session.household, identity);
  if (
    !member ||
    member.status !== "approved" ||
    (member.role === "child" && !member.allowSignIn)
  )
    return null;
  return {
    id: workspaceId(store, session.household, identity),
    identity,
    household: session.household,
    name: [member.person.first, member.person.last].filter(Boolean).join(" "),
    role: member.role === "adult" ? "administrator" : "kid",
    membershipVersion: member.version,
  };
}
export function centralWorkspaceMembers(store, household) {
  if (isolatedAddressBook(store, household)) return [];
  return store.list("household-member", household).flatMap((record) => {
    const member = membership(store, household, record.identity);
    if (
      !member ||
      member.status !== "approved" ||
      (member.role === "child" && !member.allowSignIn)
    )
      return [];
    return [
      {
        id: workspaceId(store, household, member.identity),
        identity: member.identity,
        household,
        name: [
          member.person.first,
          member.person.parent ? "" : member.person.last,
        ]
          .filter(Boolean)
          .join(" "),
        role: member.role === "adult" ? "administrator" : "kid",
        disabled: 0,
        version: member.version,
        central: true,
      },
    ];
  });
}
export function revokeMembershipSessions(
  store,
  identity,
  household,
  extraUsers = [],
) {
  const users = new Set([
    identity,
    workspaceId(store, household, identity),
    ...extraUsers.filter(Boolean),
  ]);
  for (const row of store.all(
    "SELECT id FROM users WHERE household=?",
    household,
  ))
    if (store.get("host-person", row.id, household)?.identity === identity)
      users.add(row.id);
  const tokens = new Set(
    store
      .all(
        "SELECT token FROM guest_identity_sessions WHERE identity=?",
        identity,
      )
      .map((row) => row.token),
  );
  for (const user of users)
    for (const row of store.all(
      "SELECT token FROM sessions WHERE user=?",
      user,
    ))
      tokens.add(row.token);
  for (const row of store.list("passwordless-session", P))
    if (row.identity === identity) tokens.add(row.id);
  for (const token of tokens) {
    store.run("DELETE FROM sessions WHERE token=?", token);
    store.run("DELETE FROM session_origins WHERE token=?", token);
    store.run("DELETE FROM guest_identity_sessions WHERE token=?", token);
  }
  for (const row of store.list("passwordless-challenge", P))
    if (
      row.subject === "person:" + identity ||
      users.has(row.subject?.slice(5))
    )
      store.put(
        "passwordless-challenge",
        row.id,
        P,
        { ...row, state: "revoked", tokenHash: "", bindingHash: "" },
        row.version,
      );
}
export function permanentProfileCode(store) {
  const used = new Set([
    ...store.list("personal-household", P).map((p) => p.publicCode),
    ...store.list("personal-code-reservation", P).map((p) => p.id),
    ...store.list("guest-access-code", P).map((p) => p.code),
  ]);
  if (used.size >= 10000) fail(409, "Household ID capacity has been reached.");
  let code;
  do {
    code = String(randomInt(0, 10000)).padStart(4, "0");
  } while (used.has(code));
  store.put("personal-code-reservation", code, P, { allocated: true });
  return code;
}
export function releaseAdult(
  store,
  household,
  identity,
  { version, profileVersion, administrator },
) {
  return store.transaction(() => {
    const current = membership(store, household, identity);
    if (
      !current ||
      current.role !== "adult" ||
      current.person.parent ||
      current.owner ||
      primaryIdentity(store, household) === identity
    )
      fail(
        400,
        "Release requires a non-owner adult. Review ownership transfer first.",
      );
    if (
      current.version !== version ||
      current.profile.version !== profileVersion
    )
      fail(409, "Family membership changed. Review before releasing.");
    if (
      current.profile.members.some(
        (p) => !p.archived && p.parent === current.person.id,
      )
    )
      fail(
        400,
        "Review and reassign this adult's dependent children before release.",
      );
    const target = id(),
      code = permanentProfileCode(store),
      old = current.profile;
    const next = {
      ...old,
      id: undefined,
      version: undefined,
      household: undefined,
      name: [current.person.first, current.person.last]
        .filter(Boolean)
        .join(" "),
      publicCode: code,
      sourceHousehold: null,
      releasedFrom: old.id,
      members: [{ ...current.person, parent: "", archived: false }],
      recipients: [],
      blocked: [...old.blocked],
      sharing: "selected",
    };
    store.put(
      "personal-household",
      old.id,
      P,
      {
        ...old,
        members: old.members.map((p) =>
          p.identity === identity ? { ...p, archived: true } : p,
        ),
      },
      old.version,
    );
    const saved = store.put("personal-household", target, P, next);
    const link = store.get("personal-member", identity, P);
    store.put(
      "personal-member",
      identity,
      P,
      { profile: target, member: current.person.id },
      link.version,
    );
    const account = personalAccount(store, identity);
    if (!account) store.put("person-account", identity, P, {});
    store.put(
      "household-member",
      identity,
      household,
      {
        identity,
        role: "adult",
        status: "released",
        allowSignIn: false,
        at: Date.now(),
      },
      current.version,
    );
    const legacy = workspaceIdFromProfile(
      store,
      old,
      household,
      current.person.id,
    );
    if (legacy)
      store.run(
        "UPDATE family_members SET disabled=1,version=version+1 WHERE id=? AND household=?",
        legacy,
        household,
      );
    revokeMembershipSessions(store, identity, household, [legacy]);
    // Move only explicitly person-owned contact edges; shared household edges stay private.
    for (const edge of store.list("personal-contact", old.id))
      if (edge.ownerIdentity === identity) {
        store.put("personal-contact", edge.id, target, { ...edge });
      }
    propagatePersonalProfile(store, saved);
    auditAccount(
      store,
      administrator,
      "person:" + identity,
      "household-adult-released",
      ["membership", "sessions", "independent-household"],
    );
    return { householdId: code, profile: target };
  });
}
function workspaceIdFromProfile(store, profile, household, personId) {
  return store
    .list("family-profile-member", household)
    .find((link) => link.profile === profile.id && link.member === personId)
    ?.id;
}
export async function centralMembershipAPI(ctx) {
  const { path, method, req, res, store, session, body, json, version, env } =
    ctx;
  if (
    path !== "/api/central/family" &&
    path !== "/api/admin/central-membership" &&
    path !== "/api/central/child-device"
  )
    return false;
  if (path === "/api/central/family" && method === "GET") {
    if (!session || !["host", "guest"].includes(session.role))
      fail(403, "A central household account is required.");
    const identity = privateIdentity(store, session),
      central = centralPerson(store, identity);
    if (!central) fail(404, "Family unavailable.");
    json(res, {
      version: central.profile.version,
      self: central.person.id,
      people: central.profile.members
        .filter((p) => !p.archived)
        .map((p) => {
          const member =
            central.profile.sourceHousehold &&
            membership(store, central.profile.sourceHousehold, p.identity);
          return {
            id: p.id,
            identity: p.identity,
            first: p.first,
            last: p.parent ? "" : p.last,
            suffix: p.parent ? "" : p.suffix,
            parent: p.parent,
            status: member?.status || "pending",
            role: p.parent ? "child" : "adult",
            allowSignIn: member?.allowSignIn === true,
            version: member?.version || 0,
            registered: !!personalAccount(store, p.identity),
          };
        }),
    });
    return true;
  }
  if (path === "/api/central/family" && method === "POST") {
    if (session?.role !== "host")
      fail(403, "Host family management is required.");
    const input = await body(req),
      actor = privateIdentity(store, session),
      central = centralPerson(store, actor),
      person = central?.profile.members.find(
        (p) => p.id === input.member && !p.archived,
      );
    if (
      !person ||
      central.profile.sourceHousehold !== session.household ||
      !person.parent ||
      typeof input.allowSignIn !== "boolean"
    )
      fail(400, "Choose a child in this household.");
    const guardian = central.profile.members.find(
      (p) => p.id === person.parent,
    );
    if (
      guardian?.identity !== actor &&
      primaryIdentity(store, session.household) !== actor
    )
      fail(
        403,
        "The verified guardian or household owner manages child sign-in.",
      );
    store.transaction(() => {
      const old = store.get(
        "household-member",
        person.identity,
        session.household,
      );
      if ((old?.version || 0) !== input.version)
        fail(409, "Child access changed. Review before saving.");
      store.put(
        "household-member",
        person.identity,
        session.household,
        {
          ...old,
          identity: person.identity,
          role: "child",
          status: old?.status || "pending",
          allowSignIn: input.allowSignIn && old?.status === "approved",
          requested: input.allowSignIn,
          guardian: guardian?.identity,
        },
        old?.version,
      );
      if (!input.allowSignIn)
        revokeMembershipSessions(store, person.identity, session.household);
    });
    json(res, { ok: true, pending: input.allowSignIn });
    return true;
  }
  if (path === "/api/admin/central-membership" && method === "POST") {
    const input = await body(req);
    await confirmAdministrator(store, session, input.password);
    if (input.action === "list") {
      const house = store.household(input.household);
      if (!house) fail(404, "Household unavailable.");
      const profile = store
        .list("personal-household", P)
        .find((p) => p.sourceHousehold === house.id);
      if (!profile)
        fail(404, "Open Family once to establish its central roster.");
      json(res, {
        household: house.id,
        name: house.name,
        profileVersion: profile.version,
        people: profile.members
          .filter((p) => !p.archived)
          .map((p) => ({
            id: p.id,
            identity: p.identity,
            first: p.first,
            last: p.parent ? "" : p.last,
            parent: p.parent,
            phone: p.phone,
            version:
              store.get("household-member", p.identity, house.id)?.version || 0,
            status:
              membership(store, house.id, p.identity)?.status || "pending",
            allowSignIn:
              membership(store, house.id, p.identity)?.allowSignIn === true,
          })),
      });
      return true;
    }
    const central = centralPerson(store, input.identity),
      household = central?.profile.sourceHousehold;
    if (!central || !household || household !== input.household)
      fail(400, "Choose an existing central family member.");
    const previous = store.get("household-member", input.identity, household);
    if (
      (previous?.version || 0) !== input.version ||
      central.profile.version !== input.profileVersion
    )
      fail(409, "Family membership changed. Refresh first.");
    if (input.action === "release") {
      json(
        res,
        releaseAdult(store, household, input.identity, {
          version: input.version,
          profileVersion: input.profileVersion,
          administrator: session.user,
        }),
      );
      return true;
    }
    if (input.reviewedIdentity !== true)
      fail(400, "Confirm an independent identity and membership review.");
    if (input.action === "approve-adult") {
      if (central.person.parent)
        fail(400, "Review the adulthood transition separately first.");
      const phone = contactPhone(input.phone);
      if (
        !phone ||
        input.verifiedOutOfBand !== true ||
        input.consented !== true
      )
        fail(
          400,
          "Verify this adult's own registered phone and authorization.",
        );
      store.transaction(() => {
        const account = personalAccount(store, input.identity);
        store.put(
          "person-account",
          input.identity,
          P,
          { ...account, recoveryPhone: phone, recoveryVerified: true },
          account?.version,
        );
        store.put(
          "household-member",
          input.identity,
          household,
          {
            identity: input.identity,
            role: "adult",
            status: "approved",
            allowSignIn: true,
            approvedBy: session.user,
            at: Date.now(),
          },
          previous?.version,
        );
        revokeMembershipSessions(store, input.identity, household);
        auditAccount(
          store,
          session.user,
          "person:" + input.identity,
          "adult-membership-approved",
          ["identity", "membership", "verified-phone"],
        );
      });
      json(res, { ok: true });
      return true;
    }
    if (input.action === "approve-child") {
      if (
        !central.person.parent ||
        input.allowSignIn !== true ||
        input.verifiedOutOfBand !== true ||
        input.consented !== true
      )
        fail(400, "Review child access and verified delivery authorization.");
      const guardian = central.profile.members.find(
        (p) => p.id === central.person.parent && !p.archived,
      );
      const account = guardian && personalAccount(store, guardian.identity);
      const guardianPhone = account?.recoveryVerified && account.recoveryPhone;
      const ownPhone = contactPhone(input.phone || "");
      const mediated = !ownPhone || ownPhone === guardianPhone;
      if (
        mediated &&
        (!guardianPhone ||
          input.guardianConsent !== true ||
          input.guardian !== guardian.identity)
      )
        fail(
          400,
          "Independently verify the designated guardian and child-specific delivery approval.",
        );
      store.transaction(() => {
        store.put(
          "household-member",
          input.identity,
          household,
          {
            identity: input.identity,
            role: "child",
            status: "approved",
            allowSignIn: true,
            guardian: guardian.identity,
            guardianMediated: mediated,
            approvedBy: session.user,
            at: Date.now(),
          },
          previous?.version,
        );
        const enrollment = store.get(
          "passwordless-contact",
          "person:" + input.identity,
          P,
        );
        store.put(
          "passwordless-contact",
          "person:" + input.identity,
          P,
          {
            phone: ownPhone || guardianPhone,
            guardian: mediated ? guardian.identity : null,
            verified: true,
            at: Date.now(),
          },
          enrollment?.version,
        );
        revokeMembershipSessions(store, input.identity, household);
        auditAccount(
          store,
          session.user,
          "person:" + input.identity,
          "child-sign-in-approved",
          ["guardian", "child-access"],
        );
      });
      json(res, { ok: true, requiresDeviceEnrollment: mediated });
      return true;
    }
    if (input.action === "adulthood") {
      if (
        !central.person.parent ||
        input.verifiedAge !== true ||
        typeof input.remainHousehold !== "boolean"
      )
        fail(400, "Review age, identity and household membership explicitly.");
      store.transaction(() => {
        const members = central.profile.members.map((p) =>
          p.identity === input.identity
            ? {
                ...p,
                parent: "",
                last:
                  typeof input.last === "string"
                    ? input.last.slice(0, 80)
                    : p.last || "",
              }
            : p,
        );
        store.put(
          "personal-household",
          central.profile.id,
          P,
          { ...central.profile, members },
          central.profile.version,
        );
        store.put(
          "household-member",
          input.identity,
          household,
          {
            identity: input.identity,
            role: "adult",
            status: "pending",
            allowSignIn: false,
            adulthoodReviewed: true,
            at: Date.now(),
          },
          previous?.version,
        );
        if (!personalAccount(store, input.identity))
          store.put("person-account", input.identity, P, {});
        revokeMembershipSessions(store, input.identity, household);
        if (!input.remainHousehold) {
          const next = store.get("household-member", input.identity, household);
          releaseAdult(store, household, input.identity, {
            version: next.version,
            profileVersion: central.profile.version + 1,
            administrator: session.user,
          });
        }
        auditAccount(
          store,
          session.user,
          "person:" + input.identity,
          "adulthood-reviewed",
          ["age", "membership", "sessions"],
        );
      });
      json(res, { ok: true, pendingAdultApproval: input.remainHousehold });
      return true;
    }
    if (input.action === "child-device") {
      const member = membership(store, household, input.identity);
      if (
        !member ||
        member.role !== "child" ||
        !member.allowSignIn ||
        !member.guardianMediated
      )
        fail(400, "Approve this child's guardian-mediated sign-in first.");
      const token = randomBytes(32).toString("base64url"),
        reference = id();
      const { authHash } = await import("./passwordless.js");
      store.put("child-device-enrollment", reference, P, {
        identity: input.identity,
        household,
        tokenHash: authHash(token),
        membershipVersion: member.version,
        expires: Date.now() + 600000,
        state: "pending",
      });
      auditAccount(
        store,
        session.user,
        "person:" + input.identity,
        "child-device-enrollment-issued",
        ["guardian", "device-enrollment"],
      );
      json(res, {
        url:
          (ctx.householdHosts?.has(
            store.household(household).subdomain + ".ilymmd.com",
          )
            ? "https://" + store.household(household).subdomain + ".ilymmd.com"
            : "https://gather.ilymmd.com") +
          "/signin#enroll-child=" +
          reference +
          "." +
          token,
      });
      return true;
    }
    fail(400, "Choose an approved membership action.");
  }
  if (path === "/api/central/child-device" && method === "POST") {
    const input = await body(req),
      { authHash } = await import("./passwordless.js");
    store.limit("child-device-ip:" + req.socket.remoteAddress, 10, 900000);
    if (
      typeof input.token !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.token) ||
      typeof input.reference !== "string" ||
      input.reference.length > 40
    )
      fail(401, "Child device enrollment is invalid or expired.");
    const secret = randomBytes(32).toString("base64url");
    const identity = store.transaction(() => {
      const row = store.get("child-device-enrollment", input.reference, P),
        member = row && membership(store, row.household, row.identity);
      if (
        !row ||
        row.state !== "pending" ||
        row.expires <= Date.now() ||
        authHash(input.token) !== row.tokenHash ||
        !member?.allowSignIn ||
        member.version !== row.membershipVersion
      )
        fail(401, "Child device enrollment is invalid or expired.");
      store.put(
        "child-device-enrollment",
        row.id,
        P,
        { ...row, state: "consumed", tokenHash: "" },
        row.version,
      );
      store.put("child-device", authHash(secret), P, {
        identity: row.identity,
        household: row.household,
        membershipVersion: member.version,
        at: Date.now(),
      });
      return row.identity;
    });
    res.setHeader(
      "Set-Cookie",
      "__Host-gather_child_" +
        authHash(identity).slice(0, 16) +
        "=" +
        secret +
        "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000",
    );
    json(res, { ok: true });
    return true;
  }
  fail(405, "Method not allowed.");
}

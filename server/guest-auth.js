import {
  randomBytes,
  randomInt,
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
  timingSafeEqual,
} from "node:crypto";
import { fail, text } from "./model.js";
import { accessCandidates, accessFor } from "./guest-access.js";
import {
  guestRelations,
  compareName,
  identityFor,
} from "./guest-identities.js";
import { privateIdentity, personalAccount } from "./personal-accounts.js";
import { contactPhone } from "./features.js";
import { smsEnabled, sendText } from "./sms-provider.js";
const PLATFORM = "platform",
  TTL = 10 * 60000,
  COOLDOWN = 60000;
const digest = (value) =>
  createHash("sha256").update(String(value)).digest("hex");
const nonce = () => randomBytes(32).toString("base64url");
const validToken = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
function key(env) {
  if (!/^[a-f0-9]{64}$/i.test(env.GUEST_LINK_ENCRYPTION_KEY || ""))
    fail(
      503,
      "Private guest sign-in is not configured. Contact the administrator.",
    );
  return Buffer.from(env.GUEST_LINK_ENCRYPTION_KEY, "hex");
}
function encrypt(value, identity, env) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(env), iv);
  cipher.setAAD(Buffer.from(identity));
  return Buffer.concat([
    iv,
    cipher.update(value, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64url");
}
function decrypt(value, identity, env) {
  try {
    const bytes = Buffer.from(value, "base64url"),
      decipher = createDecipheriv(
        "aes-256-gcm",
        key(env),
        bytes.subarray(0, 12),
      );
    decipher.setAAD(Buffer.from(identity));
    decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([
      decipher.update(bytes.subarray(12, -16)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    fail(
      503,
      "The private sign-in link cannot be opened. Contact the administrator; do not reset the account.",
    );
  }
}
function identityExists(store, identity) {
  const record = store.get("guest-identity", identity, PLATFORM);
  if (!record || !guestRelations(store, identity).some((r) => !r.record.parent))
    fail(404, "Guest account not found.");
  return record;
}
export function guestPrivateLink(
  store,
  identity,
  env,
  origin,
  { reset = false } = {},
) {
  identityExists(store, identity);
  return store.transaction(() => {
    let record = store.get("guest-private-link", identity, PLATFORM);
    if (!record || reset) {
      const token = nonce();
      record = store.put(
        "guest-private-link",
        identity,
        PLATFORM,
        {
          tokenHash: digest(token),
          encryptedToken: encrypt(token, identity, env),
          createdAt: Date.now(),
        },
        record?.version,
      );
      if (reset) revokeGuestDevices(store, identity);
    }
    return {
      url: origin + "/guest#" + decrypt(record.encryptedToken, identity, env),
      version: record.version,
    };
  });
}
export function verifiedGuestContact(store, identity) {
  const enrolled = store.get("guest-auth-contact", identity, PLATFORM);
  if (enrolled?.verified === true)
    return {
      phone: enrolled.phone,
      stamp: digest(enrolled.phone + ":" + enrolled.version),
    };
  const account = personalAccount(store, identity);
  if (account?.recoveryVerified && account.recoveryPhone)
    return {
      phone: account.recoveryPhone,
      stamp: digest(account.recoveryPhone + ":" + account.version),
    };
  return null;
}
export function enrollGuestContact(
  store,
  identity,
  phone,
  { administrator, verifiedOutOfBand, consented, version },
) {
  identityExists(store, identity);
  if (verifiedOutOfBand !== true || consented !== true)
    fail(
      400,
      "Confirm that the intended guest and phone ownership were verified outside this sign-in attempt and security texts are authorized.",
    );
  phone = contactPhone(phone);
  if (!phone) fail(400, "A verified international phone number is required.");
  return store.transaction(() => {
    const old = store.get("guest-auth-contact", identity, PLATFORM);
    if ((old?.version || 0) !== version)
      fail(409, "Verified contact changed. Review it before saving.");
    store.put(
      "guest-auth-contact",
      identity,
      PLATFORM,
      { phone, verified: true, verifiedAt: Date.now(), administrator },
      old?.version,
    );
    revokeGuestDevices(store, identity);
    return { verified: true };
  });
}
export function revokeGuestDevices(store, identity, keep = "") {
  store.run(
    "DELETE FROM sessions WHERE token IN (SELECT token FROM guest_identity_sessions WHERE identity=? AND token<>?)",
    identity,
    keep,
  );
  for (const c of store
    .list("guest-auth-challenge", PLATFORM)
    .filter((c) => c.identity === identity && c.state !== "consumed"))
    store.put(
      "guest-auth-challenge",
      c.id,
      PLATFORM,
      { ...c, state: "revoked", codeHash: "" },
      c.version,
    );
}
function proof(store, input) {
  if (!validToken(input.privateId))
    fail(401, "Unable to authorize guest sign-in.");
  const row = store.one(
    "SELECT id FROM records WHERE kind='guest-private-link' AND household='platform' AND json_extract(body,'$.tokenHash')=?",
    digest(input.privateId),
  );
  if (!row || !/^\d{4}$/.test(input.householdId || ""))
    fail(401, "Unable to authorize guest sign-in.");
  const link = store.get("guest-private-link", row.id, PLATFORM);
  const relation = accessCandidates(store, input.householdId).find(
    (r) =>
      !r.record.parent &&
      compareName(r.record.first) ===
        compareName(text(input.first, 80, true)) &&
      compareName(r.record.last) === compareName(text(input.last, 80, true)) &&
      store.one(
        "SELECT identity FROM guest_identity_links WHERE household=? AND guest=?",
        r.household,
        r.guest,
      )?.identity === row.id,
  );
  if (!relation) fail(401, "Unable to authorize guest sign-in.");
  return { identity: row.id, link, relation };
}
function ready(store, env, contact) {
  key(env);
  if (!contact)
    fail(
      403,
      "This account requires administrator-assisted phone enrollment before sign-in.",
    );
  if (!smsEnabled(env))
    fail(
      503,
      "Guest verification texting is not enabled. Contact the administrator.",
    );
  if (store.one("SELECT phone FROM sms_optouts WHERE phone=?", contact.phone))
    fail(
      403,
      "Security texts are unavailable for this verified contact. Contact the administrator.",
    );
}
function reserveSend(store, identity, kind, now) {
  const old = store.get("guest-auth-send", identity + ":" + kind, PLATFORM);
  if (old && now - old.at < COOLDOWN)
    fail(429, "Wait one minute before requesting another message.");
  store.limit("guest-auth-send:" + kind + ":" + identity, 5, 3600000);
  store.put(
    "guest-auth-send",
    identity + ":" + kind,
    PLATFORM,
    { at: now },
    old?.version,
  );
}
const otpHash = (env, challenge, identity, code) =>
  createHmac("sha256", key(env))
    .update("guest-otp:" + challenge + ":" + identity + ":" + code)
    .digest("hex");
export async function startGuestVerification(
  store,
  env,
  input,
  { ip, fetcher = fetch, now = Date.now } = {},
) {
  store.limit("guest-auth-ip:" + digest(ip || "unknown"), 30, 15 * 60000);
  const p = proof(store, input),
    contact = verifiedGuestContact(store, p.identity);
  ready(store, env, contact);
  const challenge = nonce(),
    code = String(randomInt(100000, 1000000)),
    at = now();
  store.transaction(() => {
    reserveSend(store, p.identity, "code", at);
    for (const c of store
      .list("guest-auth-challenge", PLATFORM)
      .filter((c) => c.identity === p.identity && c.state !== "consumed"))
      store.put(
        "guest-auth-challenge",
        c.id,
        PLATFORM,
        { ...c, state: "superseded", codeHash: "" },
        c.version,
      );
    store.put("guest-auth-challenge", digest(challenge), PLATFORM, {
      identity: p.identity,
      household: p.relation.household,
      guest: p.relation.guest,
      credentialHash: digest(input.householdId),
      linkVersion: p.link.version,
      contactStamp: contact.stamp,
      expires: at + TTL,
      attempts: 0,
      state: "dispatching",
      codeHash: otpHash(env, challenge, p.identity, code),
    });
  });
  const result = await sendText(
    env,
    contact.phone,
    "Your Gather sign-in verification code is " +
      code +
      ". It expires in 10 minutes. Do not share this code.",
    fetcher,
  );
  const current = store.get(
    "guest-auth-challenge",
    digest(challenge),
    PLATFORM,
  );
  if (current?.state === "dispatching")
    store.put(
      "guest-auth-challenge",
      current.id,
      PLATFORM,
      {
        ...current,
        state:
          result.status === "accepted"
            ? "pending"
            : result.status === "unknown"
              ? "unknown"
              : "failed",
        ...(result.status === "failed" ? { codeHash: "" } : {}),
      },
      current.version,
    );
  if (!["accepted", "unknown"].includes(result.status))
    fail(503, "Verification could not be sent. Contact the administrator.");
  return { challenge, expiresIn: 600, resendAfter: 60 };
}
export function completeGuestVerification(
  store,
  env,
  input,
  establish,
  { entryHousehold, now = Date.now } = {},
) {
  if (!validToken(input.challenge))
    fail(401, "The verification code is invalid or expired.");
  // Persist failed attempts outside the success transaction; errors must not roll them back.
  const current = store.get(
    "guest-auth-challenge",
    digest(input.challenge),
    PLATFORM,
  );
  if (
    !current ||
    !["pending", "unknown"].includes(current.state) ||
    current.expires <= now() ||
    current.attempts >= 5
  )
    fail(401, "The verification code is invalid or expired.");
  const attempted = store.put(
    "guest-auth-challenge",
    current.id,
    PLATFORM,
    { ...current, attempts: current.attempts + 1 },
    current.version,
  );
  const expected = otpHash(
    env,
    input.challenge,
    current.identity,
    String(input.code || ""),
  );
  if (
    !/^\d{6}$/.test(input.code || "") ||
    !timingSafeEqual(
      Buffer.from(expected, "hex"),
      Buffer.from(current.codeHash, "hex"),
    )
  )
    fail(401, "The verification code is invalid or expired.");
  return store.transaction(() => {
    const latest = store.get("guest-auth-challenge", current.id, PLATFORM),
      link = store.get("guest-private-link", current.identity, PLATFORM),
      contact = verifiedGuestContact(store, current.identity);
    const guest = store.get("guest", current.guest, current.household),
      identity =
        guest &&
        store.one(
          "SELECT identity FROM guest_identity_links WHERE household=? AND guest=?",
          current.household,
          current.guest,
        )?.identity;
    if (
      latest.version !== attempted.version ||
      !["pending", "unknown"].includes(latest.state) ||
      !guest ||
      guest.parent ||
      identity !== current.identity ||
      store.one(
        "SELECT household FROM household_deletions WHERE household=?",
        current.household,
      ) ||
      link?.version !== current.linkVersion ||
      contact?.stamp !== current.contactStamp ||
      digest(accessFor(store, guest, current.household).code) !==
        current.credentialHash
    )
      fail(401, "The verification code is invalid or expired.");
    store.put(
      "guest-auth-challenge",
      latest.id,
      PLATFORM,
      { ...latest, state: "consumed", codeHash: "" },
      latest.version,
    );
    const activation = store.get(
      "guest-auth-activation",
      current.identity,
      PLATFORM,
    );
    if (!activation)
      store.put("guest-auth-activation", current.identity, PLATFORM, {
        activatedAt: now(),
      });
    return establish({
      household: current.household,
      guest: current.guest,
      identity: current.identity,
      role: "guest",
      entryHousehold: entryHousehold || current.household,
    });
  });
}
export async function deliverGuestLink(
  store,
  env,
  identity,
  origin,
  { fetcher = fetch, now = Date.now } = {},
) {
  const contact = verifiedGuestContact(store, identity);
  ready(store, env, contact);
  store.transaction(() => reserveSend(store, identity, "link", now()));
  const { url } = guestPrivateLink(store, identity, env, origin);
  const result = await sendText(
    env,
    contact.phone,
    "Your private Gather sign-in page: " +
      url +
      "\nKeep this link private. The link alone cannot sign you in.",
    fetcher,
  );
  if (!["accepted", "unknown"].includes(result.status))
    fail(503, "The sign-in link could not be sent. Contact the administrator.");
  return { status: result.status === "accepted" ? "accepted" : "unconfirmed" };
}
export async function guestAuthAPI(ctx) {
  const {
    path,
    method,
    req,
    res,
    store,
    session,
    body,
    version,
    json,
    env,
    requireRole,
    cookie,
    newSession,
    canonicalOrigin,
    selected,
    fetcher,
  } = ctx;
  if (path === "/api/guest-access/start" && method === "POST") {
    json(
      res,
      await startGuestVerification(store, env, await body(req), {
        ip: req.socket.remoteAddress,
        fetcher,
      }),
    );
    return true;
  }
  if (path === "/api/guest-access/verify" && method === "POST") {
    const input = await body(req);
    store.limit(
      "guest-auth-verify-ip:" + digest(req.socket.remoteAddress),
      50,
      15 * 60000,
    );
    cookie(
      res,
      completeGuestVerification(store, env, input, newSession, {
        entryHousehold: selected?.id,
      }),
    );
    json(res, { ok: true });
    return true;
  }
  if (path === "/api/guest-access/self") {
    if (session?.role !== "guest")
      fail(403, "A signed-in guest account is required.");
    const identity = privateIdentity(store, session);
    if (method === "GET") {
      const link = guestPrivateLink(store, identity, env, canonicalOrigin),
        contact = verifiedGuestContact(store, identity);
      json(res, { ...link, verifiedContact: !!contact });
      return true;
    }
    if (method === "POST") {
      revokeGuestDevices(store, identity, session.token);
      json(res, { ok: true });
      return true;
    }
    fail(405, "Method not allowed.");
  }
  const send = path.match(
    /^\/api\/host\/guests\/([a-zA-Z0-9-]+)\/sign-in-link$/,
  );
  if (send && method === "POST") {
    requireRole("host");
    if (session.role !== "host") fail(403, "Host access is required.");
    const guest = store.get("guest", send[1], session.household);
    if (!guest || guest.parent) fail(404, "Adult contact not found.");
    json(
      res,
      await deliverGuestLink(
        store,
        env,
        identityFor(store, guest, session.household).id,
        canonicalOrigin,
        { fetcher },
      ),
    );
    return true;
  }
  const list = path.match(/^\/api\/admin\/guest-access-list\/([a-zA-Z0-9-]+)$/);
  if (list && method === "GET") {
    requireRole("admin");
    if (!store.household(list[1])) fail(404, "Household not found.");
    const offset = Number(
      new URL(req.url, canonicalOrigin).searchParams.get("offset") || 0,
    );
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000)
      fail(400, "Choose a valid page.");
    const people = store.list("guest", list[1]).filter((g) => !g.parent);
    json(res, {
      guests: people.slice(offset, offset + 100).map((g) => {
        const identity = identityFor(store, g, list[1]).id;
        return {
          guest: g.id,
          name: [g.first, g.last, g.suffix].filter(Boolean).join(" "),
          verifiedContact: !!verifiedGuestContact(store, identity),
          contactVersion:
            store.get("guest-auth-contact", identity, PLATFORM)?.version || 0,
          linkVersion:
            store.get("guest-private-link", identity, PLATFORM)?.version || 0,
        };
      }),
      nextOffset: people.length > offset + 100 ? offset + 100 : null,
    });
    return true;
  }
  if (path === "/api/admin/guest-access" && method === "POST") {
    requireRole("admin");
    const input = await body(req);
    store.limit("guest-access-admin:" + session.user, 20, 3600000);
    const { checkPassword } = await import("./model.js");
    if (
      !(await checkPassword(
        input.password,
        store.one("SELECT password FROM users WHERE id=?", session.user)
          ?.password,
      ))
    )
      fail(403, "Confirm your current administrator password.");
    const guest = store.get(
      "guest",
      text(input.guest, 100, true),
      text(input.household, 100, true),
    );
    if (!guest || guest.parent) fail(404, "Adult guest account not found.");
    const identity = identityFor(store, guest, input.household).id;
    if (input.action === "enroll") {
      json(
        res,
        enrollGuestContact(store, identity, input.phone, {
          administrator: session.user,
          verifiedOutOfBand: input.verifiedOutOfBand,
          consented: input.consented,
          version: version(req),
        }),
      );
      return true;
    }
    if (!["retrieve", "reset"].includes(input.action))
      fail(400, "Choose a guest access action.");
    const old = store.get("guest-private-link", identity, PLATFORM);
    if (
      input.action === "reset" &&
      (input.confirm !== [guest.first, guest.last].join(" ") ||
        version(req) !== (old?.version || 0))
    )
      fail(
        409,
        "Review the exact guest and current link version before resetting.",
      );
    json(
      res,
      guestPrivateLink(store, identity, env, canonicalOrigin, {
        reset: input.action === "reset",
      }),
    );
    return true;
  }
  return false;
}

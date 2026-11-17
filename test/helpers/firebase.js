import { generateKeyPairSync, sign, randomUUID } from "node:crypto";
import { application, password } from "./application.js";
import { ensurePersonalProfile } from "../../server/personal-accounts.js";
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "synthetic-key",
  alg: "RS256",
  use: "sig",
};
export const firebaseFetcher = async (url, options) => {
  if (
    url.startsWith(
      "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=",
    )
  ) {
    const claim = JSON.parse(
      Buffer.from(
        JSON.parse(options.body).idToken.split(".")[1],
        "base64url",
      ).toString(),
    );
    return Response.json({
      users: [
        { localId: claim.sub, phoneNumber: claim.phone_number, validSince: 0 },
      ],
    });
  }
  if (
    url !==
    "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"
  )
    throw Error("Unexpected external request");
  return Response.json({ keys: [jwk] });
};
export function token(
  env,
  { uid = "synthetic-phone-user", phone = "+15005550121", ...changes } = {},
) {
  const now = Math.floor(Date.now() / 1000),
    header = { alg: "RS256", kid: jwk.kid };
  const claim = {
    sub: uid,
    aud: env.FIREBASE_PROJECT_ID,
    iss: "https://securetoken.google.com/" + env.FIREBASE_PROJECT_ID,
    iat: now,
    auth_time: now,
    exp: now + 3600,
    phone_number: phone,
    firebase: { sign_in_provider: "phone", identities: { phone: [phone] } },
    ...changes,
  };
  const data = [header, claim]
    .map((v) => Buffer.from(JSON.stringify(v)).toString("base64url"))
    .join(".");
  return (
    data +
    "." +
    sign("RSA-SHA256", Buffer.from(data), privateKey).toString("base64url")
  );
}
export async function firebaseFixture(t, { householdHosts = new Set() } = {}) {
  const project = "gather-test-" + randomUUID().slice(0, 8);
  const env = {
    FIREBASE_AUTH_ENABLED: "true",
    FIREBASE_ACTIVATION_APPROVED: "true",
    FIREBASE_PROJECT_ID: project,
    FIREBASE_API_KEY: "synthetic-public-api-key",
    FIREBASE_AUTH_DOMAIN: project + ".firebaseapp.com",
    GATHER_UNIVERSAL_ENABLED: "true",
    SMS_ENABLED: "false",
  };
  const f = await application(t, env, {
    origin: "https://gather.ilymmd.com",
    firebaseFetcher,
    householdHosts,
  });
  const host = await f.host("Alpha"),
    ready = ensurePersonalProfile(f.store, {
      role: "host",
      user: host.user,
      household: host.household.id,
    });
  const profile = f.store.put(
    "personal-household",
    ready.profile.id,
    "platform",
    {
      ...ready.profile,
      members: ready.profile.members.map((m) => ({
        ...m,
        first: "Alex",
        last: "Example",
        phone: "+15005550121",
      })),
    },
    ready.profile.version,
  );
  f.store.put("guest-auth-contact", ready.identity, "platform", {
    phone: "+15005550121",
    verified: true,
    verifiedAt: Date.now(),
  });
  async function start(data = {}) {
    // Tests use isolated client identities and reset only this synthetic cooldown.
    f.store.run("DELETE FROM limits WHERE key LIKE 'firebase-start-%'");
    return f.request("/api/firebase/start", {
      method: "POST",
      data: { first: "Alex", last: "Example", phone: "+15005550121", ...data },
    });
  }
  async function finish(attempt, claim = {}, extra = {}) {
    return f.request("/api/firebase/verify", {
      method: "POST",
      cookie: attempt.cookie,
      data: {
        reference: attempt.body.reference,
        idToken: token(env, claim),
        ...extra,
      },
    });
  }
  return {
    ...f,
    env,
    host,
    createHost: f.host,
    profile,
    identity: ready.identity,
    start,
    finish,
    password,
  };
}

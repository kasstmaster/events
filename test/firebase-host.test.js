import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign } from "node:crypto";
import {
  hostFirebaseEnabled,
  hostFirebaseConfig,
  hostFirebaseKey,
  verifyHostFirebaseToken,
} from "../server/firebase-host.js";

const env = {
  HOST_ONLY_MODEL_ENABLED: "true",
  HOST_ONLY_MODEL_ACTIVATION_APPROVED: "true",
  HOST_FIREBASE_ENABLED: "true",
  HOST_FIREBASE_ACTIVATION_APPROVED: "true",
  FIREBASE_PROJECT_ID: "gather-58a79",
  FIREBASE_API_KEY: "AIza" + "a".repeat(35),
  FIREBASE_AUTH_DOMAIN: "gather-58a79.firebaseapp.com",
};
const now = 1800000000000;
const seconds = Math.floor(now / 1000);
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "host-test-key" };
function token(overrides = {}) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "host-test-key" }),
  ).toString("base64url");
  const claim = Buffer.from(
    JSON.stringify({
      aud: "gather-58a79",
      iss: "https://securetoken.google.com/gather-58a79",
      sub: "firebase-host-uid",
      email: "host@example.test",
      email_verified: true,
      iat: seconds - 30,
      exp: seconds + 3600,
      auth_time: seconds - 60,
      firebase: { sign_in_provider: "password" },
      ...overrides,
    }),
  ).toString("base64url");
  const data = header + "." + claim;
  const signature = createSign("RSA-SHA256")
    .update(data)
    .sign(privateKey)
    .toString("base64url");
  return data + "." + signature;
}
const fetcher = async (url, options = {}) => {
  if (url.includes("/jwk/"))
    return { ok: true, json: async () => ({ keys: [jwk] }) };
  assert.match(url, /identitytoolkit\\.googleapis\\.com/);
  assert.equal(options.method, "POST");
  return {
    ok: true,
    json: async () => ({
      users: [{
        localId: "firebase-host-uid",
        email: "host@example.test",
        emailVerified: true,
        disabled: false,
        validSince: String(seconds - 3600),
      }],
    }),
  };
};

test("host Firebase stays off unless both the model and provider are approved", () => {
  assert.equal(hostFirebaseEnabled({ ...env, HOST_FIREBASE_ACTIVATION_APPROVED: "false" }), false);
  assert.equal(hostFirebaseEnabled({ ...env, HOST_ONLY_MODEL_ENABLED: "false" }), false);
  assert.equal(hostFirebaseConfig({ ...env, HOST_FIREBASE_ENABLED: "false" }), null);
  assert.equal(hostFirebaseConfig(env).projectId, "gather-58a79");
  assert.notEqual(hostFirebaseKey("gather-58a79", "u1"), hostFirebaseKey("other", "u1"));
});

test("accepts an approved, freshly signed Firebase email/password identity", async () => {
  const claim = await verifyHostFirebaseToken(token(), env, {
    fetcher, now: () => now,
  });
  assert.equal(claim.email, "host@example.test");
  assert.equal(claim.uid, "firebase-host-uid");
  assert.equal(claim.provider, "password");
});

test("rejects wrong project, unverified email, retired phone auth and stale sessions", async () => {
  for (const changes of [
    { aud: "other" },
    { email_verified: false },
    { firebase: { sign_in_provider: "phone" } },
    { auth_time: seconds - 700 },
  ]) {
    await assert.rejects(
      verifyHostFirebaseToken(token(changes), env, {
        fetcher, now: () => now,
      }),
      /Host identity verification failed/,
    );
  }
});

test("rejects forged JWT signatures even when the account lookup would accept", async () => {
  const forged = token().split(".");
  forged[2] = Buffer.from("fake").toString("base64url");
  await assert.rejects(
    verifyHostFirebaseToken(forged.join("."), env, {
      fetcher, now: () => now,
    }),
    /Host identity verification failed/,
  );
});

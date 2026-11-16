// Isolated accounts and mocked SMS only. No production provider calls.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { application } from "./application.js";
import { ensurePersonalProfile } from "../../server/personal-accounts.js";
import {
  startPasswordless,
  runPasswordlessMessages,
  authHash,
} from "../../server/passwordless.js";
export const origin = "https://gather.ilymmd.com";
export const env = {
  PASSWORDLESS_ENABLED: "true",
  PASSWORDLESS_ACTIVATION_APPROVED: "true",
  GATHER_UNIVERSAL_ENABLED: "true",
  AUTH_SMS_ENABLED: "true",
  SMS_ENABLED: "false",
  TWILIO_ACCOUNT_SID: "synthetic",
  TWILIO_AUTH_TOKEN: "synthetic",
  TWILIO_FROM: "+15005550006",
};
export async function deviceFixture(t) {
  const runtimeEnv = { ...env };
  const f = await application(t, runtimeEnv, { origin }),
    host = await f.host("Alpha");
  const ready = ensurePersonalProfile(f.store, {
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
      members: ready.profile.members.map((p) => ({
        ...p,
        first: "Alex",
        last: "Example",
        phone: "+15005550121",
      })),
    },
    ready.profile.version,
  );
  const account = f.store.get("person-account", ready.identity, "platform");
  f.store.put(
    "person-account",
    ready.identity,
    "platform",
    { ...account, recoveryPhone: "+15005550121", recoveryVerified: true },
    account.version,
  );
  const messages = [];
  async function login(person = profile.members[0], phone = person.phone) {
    const previous = f.store.get(
      "passwordless-send",
      person.identity === ready.identity
        ? "user:" + host.user
        : "person:" + person.identity,
      "platform",
    );
    if (previous)
      f.store.put(
        "passwordless-send",
        previous.id,
        "platform",
        { at: Date.now() - 61000 },
        previous.version,
      );
    const binding = randomBytes(32).toString("base64url");
    await startPasswordless(
      f.store,
      runtimeEnv,
      { first: person.first, last: person.parent ? "" : person.last, phone },
      { origin, ip: randomUUID(), binding },
    );
    const before = messages.length;
    await runPasswordlessMessages(f.store, runtimeEnv, {
      fetcher: async (_url, options) => {
        messages.push(new URLSearchParams(options.body).get("Body"));
        return Response.json({ sid: "synthetic" });
      },
    });
    assert.equal(messages.length, before + 1);
    const url = new URL(messages.at(-1).match(/https:\/\/\S+/)[0]),
      [challenge, token] = url.hash.slice(1).split(".");
    const response = await fetch(f.url + "/api/passwordless/redeem", {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Cookie: "__Host-gather_login=" + binding,
      },
      body: JSON.stringify({ challenge, token }),
    });
    assert.equal(response.status, 200);
    const setCookie = response.headers.get("set-cookie"),
      cookie = setCookie.split(";")[0];
    return {
      cookie,
      setCookie,
      raw: cookie.split("=")[1],
      hash: authHash(cookie.split("=")[1]),
    };
  }
  return {
    ...f,
    runtimeEnv,
    createHost: f.host,
    host,
    identity: ready.identity,
    person: profile.members[0],
    profile,
    login,
    messages,
  };
}

import test from "node:test";
import assert from "node:assert/strict";
import { hostTransfer } from "../client/host-transfer.js";
const token = "a".repeat(43),
  request = "b".repeat(43),
  origin = "https://alpha.ilymmd.com";
test("thin transfer never redirects on a server denial and retains sign-in fallback on expired source sessions", async () => {
  let navigations = 0;
  const options = {
    origin,
    post: async () => ({ ok: false, status: 401 }),
    navigate: () => navigations++,
    replace: () => navigations++,
  };
  assert.deepEqual(
    await hostTransfer("#host-transfer-request=" + request, options),
    { handled: false },
  );
  await assert.rejects(
    hostTransfer("#host-transfer-start=https%3A%2F%2Funtrusted.test", options),
  );
  assert.equal(navigations, 0);
});
test("thin transfer rejects malformed credentials and unsafe redirect envelopes without revealing tokens", async () => {
  let calls = 0,
    navigations = 0;
  const options = {
    origin,
    post: async () => {
      calls++;
      return {
        ok: true,
        body: {
          url: "http://untrusted.test/signin#host-transfer-request=" + request,
        },
      };
    },
    navigate: () => navigations++,
    replace: () => navigations++,
  };
  await assert.rejects(hostTransfer("#host-transfer=guessable", options));
  assert.equal(calls, 0);
  await assert.rejects(
    hostTransfer(
      "#host-transfer-start=https%3A%2F%2Fgather.ilymmd.com",
      options,
    ),
  );
  assert.equal(navigations, 0);
});
test("redemption uses only existing POST capabilities and fixed local destinations", async () => {
  let destination = "",
    submitted;
  const result = await hostTransfer("#host-transfer=" + request + "." + token, {
    origin,
    post: async (path, data) => {
      submitted = { path, data };
      return { ok: true, body: { next: "https://untrusted.test" } };
    },
    navigate: () => assert.fail("No cross-origin navigation after redemption"),
    replace: (path) => (destination = path),
  });
  assert.deepEqual(submitted, {
    path: "/api/host-auth/handoff/redeem",
    data: { request, token },
  });
  assert.equal(destination, "/");
  assert.equal(result.redeemed, true);
});

test("verified OAuth completion uses the server-owned household destination without loading the app first", async () => {
  let destination = "";
  const options = {
    origin: "https://gather.ilymmd.com",
    post: () =>
      assert.fail("No transfer POST until target browser binding exists"),
    home: async () => ({ ok: true, body: { home: origin } }),
    navigate: (url) => (destination = url),
    replace: () => assert.fail("Household is on a different origin"),
  };
  assert.deepEqual(
    await hostTransfer("#host=complete&return=https://untrusted.test", options),
    { handled: true },
  );
  assert.equal(
    destination,
    origin + "/signin#host-transfer-start=https%3A%2F%2Fgather.ilymmd.com",
  );
  assert.deepEqual(
    await hostTransfer("#host=complete", {
      ...options,
      home: async () => ({ ok: false, status: 401 }),
    }),
    { handled: false },
  );
});

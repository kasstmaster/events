import test from "node:test";
import assert from "node:assert/strict";
import {
  routingFixture,
  centralOrigin,
  cookies,
} from "./helpers/firebase-routing.js";
import { referenceFor } from "../server/rsvp-cards.js";
import { identityFor } from "../server/guest-identities.js";
import { ensurePersonalProfile } from "../server/personal-accounts.js";
const ref = (result) =>
  new URL(result.body.url).hash.slice("#login-context=".length);
test("Firebase SDK configuration and verification are central-only, while household branding remains unchanged", async (t) => {
  const f = await routingFixture(t),
    config = await f.alpha.request("/api/passwordless/config");
  assert.equal(config.body.firebase, null);
  assert.equal(config.body.firebaseEnabled, true);
  assert.equal(config.body.firebaseOrigin, centralOrigin);
  const page = await f.alpha.request("/");
  assert.doesNotMatch(
    page.headers.get("content-security-policy"),
    /www\.google|www\.gstatic/,
  );
  for (const path of ["/api/firebase/start", "/api/firebase/verify"])
    assert.equal(
      (
        await f.alpha.request(path, {
          method: "POST",
          data: { phone: "+15005550121" },
        })
      ).status,
      403,
    );
  assert.equal(f.store.list("firebase-attempt", "platform").length, 0);
  const routed = await f.route(f.alpha),
    reference = ref(routed),
    context = await f.claim(reference);
  assert.equal(new URL(routed.body.url).origin, centralOrigin);
  assert.equal(context.body.entry, "alpha");
  const branded = await f.request(
    "/api/passwordless/entry?label=" + context.body.entry,
  );
  assert.equal(branded.body.household.name, f.host.household.name);
  assert.doesNotMatch(
    JSON.stringify(context.body),
    /enrollmentSession|tokenHash|browserHash|phone/,
  );
});
test("hosts verify centrally and return via the existing single-use, persistent origin-bound handoff", async (t) => {
  const f = await routingFixture(t),
    reference = ref(await f.route(f.alpha)),
    signed = await f.sign(reference);
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  const complete = await f.complete(reference, signed);
  assert.equal(complete.body.destination, f.alpha.origin);
  assert.equal((await f.complete(reference, signed)).status, 401);
  const returned = await f.handoff(f.alpha, signed);
  assert.equal(returned.status, 200, JSON.stringify(returned.body));
  assert.equal(
    (await f.alpha.request("/api/session", { cookie: returned.cookie })).body
      .role,
    "host",
  );
  assert.equal(
    (await f.beta.request("/api/session", { cookie: returned.cookie })).body
      .role,
    null,
  );
  const local = await f.route(f.alpha);
  assert.equal(local.status, 200);
  const existing = await f.alpha.request("/api/firebase/routing/start", {
    method: "POST",
    cookie: returned.cookie,
    data: {},
  });
  assert.deepEqual(existing.body, { authenticated: true });
});
test("a valid central session resumes a new household context without requesting another code", async (t) => {
  const f = await routingFixture(t),
    first = ref(await f.route(f.alpha)),
    signed = await f.sign(first);
  assert.equal(signed.status, 200);
  const second = ref(await f.route(f.alpha)),
    claimed = await f.claim(second, signed.contextCookie);
  const resumed = await f.complete(second, {
    ...signed,
    contextCookie: claimed.cookie,
  });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.destination, f.alpha.origin);
  const already = await f.request("/api/firebase/start", {
    method: "POST",
    cookie: signed.cookie,
    data: { first: "Alex", last: "Example", phone: "+15005550121" },
  });
  assert.deepEqual(already.body, { authenticated: true });
  assert.equal(f.store.list("firebase-attempt", "platform").length, 1);
});
test("context origin, expiry, browser binding and unknown redirect inputs fail closed", async (t) => {
  const f = await routingFixture(t);
  for (const data of [
    { returnTo: "https://evil.invalid" },
    { entry: "beta", target: "https://evil.invalid" },
    { entry: "unknown" },
  ])
    assert.ok((await f.route(f.alpha, data)).status >= 400);
  const reference = ref(await f.route(f.alpha)),
    claimed = await f.claim(reference);
  assert.equal((await f.claim(reference)).status, 401);
  assert.equal(
    (
      await f.beta.request("/api/firebase/routing/context", {
        method: "POST",
        data: { reference },
      })
    ).status,
    403,
  );
  const row = f.store.get("firebase-login-context", reference, "platform");
  f.store.put(
    "firebase-login-context",
    reference,
    "platform",
    { ...row, expires: Date.now() - 1 },
    row.version,
  );
  assert.equal((await f.claim(reference, claimed.cookie)).status, 401);
  assert.equal(
    (
      await f.alpha.request("/api/firebase/routing/start", {
        method: "POST",
        data: {},
        headers: { Origin: "https://evil.invalid" },
      })
    ).status,
    403,
  );
});
test("host QR recipients keep guest-only authority at the inviter and unrelated household returns are refused", async (t) => {
  const f = await routingFixture(t),
    guest = await f.guest(f.betaHost, {
      first: "Alex",
      last: "Example",
      phone: "+15005550121",
    });
  f.store.run(
    "UPDATE guest_identity_links SET identity=? WHERE household=? AND guest=?",
    f.identity,
    f.betaHost.household.id,
    guest.id,
  );
  const event = await f.event(f.betaHost, [guest]),
    invitation = referenceFor(f.store, f.betaHost.household.id, event, {
      id: guest.id,
      guests: [guest.id],
    });
  assert.equal((await f.route(f.alpha, { invitation })).status, 404);
  const reference = ref(await f.route(f.beta, { invitation })),
    signed = await f.sign(reference);
  assert.equal(signed.status, 200);
  const completed = await f.complete(reference, signed);
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.destination, f.beta.origin + "/");
  const returned = await f.handoff(f.beta, signed, invitation);
  assert.equal(returned.status, 200);
  assert.equal(
    (await f.beta.request("/api/session", { cookie: returned.cookie })).body
      .role,
    "guest",
  );
  assert.equal(
    (await f.beta.request("/api/host", { cookie: returned.cookie })).status,
    403,
  );
});
test("regular new invitees keep branded Gather QR routing and cannot acquire host authority", async (t) => {
  const f = await routingFixture(t),
    guest = await f.guest(f.betaHost, {
      first: "New",
      last: "Guest",
      phone: "+15005550122",
    }),
    event = await f.event(f.betaHost, [guest]),
    invitation = referenceFor(f.store, f.betaHost.household.id, event, {
      id: guest.id,
      guests: [guest.id],
    });
  const reference = ref(await f.route(f.beta, { invitation })),
    signed = await f.sign(reference, {
      person: { first: "New", last: "Guest" },
      phone: "+15005550122",
      uid: "new-invitee",
    });
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  const completed = await f.complete(reference, signed);
  assert.equal(completed.body.destination, centralOrigin + "/beta");
  assert.equal(
    (await f.request("/api/host", { cookie: signed.cookie })).status,
    403,
  );
  const resolver = await f.request(
    "/api/invitations/" + invitation + "/resolve",
    { cookie: signed.cookie },
  );
  assert.equal(resolver.body.invitationKey, event.id + ":" + guest.id);
});
test("newly registered active subdomains work from the shared registry without Firebase domain entries", async (t) => {
  const f = await routingFixture(t),
    fresh = await f.createHost("NewRegistered"),
    freshSite = await f.site(fresh),
    reference = ref(await f.route(freshSite));
  const claimed = await f.claim(reference);
  assert.equal(claimed.body.entry, "newregistered");
  const settings = await freshSite.request("/api/passwordless/config");
  assert.equal(settings.body.firebase, null);
  const signed = await f.sign(reference, { contextCookie: claimed.cookie });
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  assert.equal(
    (await f.complete(reference, signed)).status,
    403,
    "central identity is not authorized in another household",
  );
  const row = f.store.get("firebase-login-context", reference, "platform");
  f.store.run(
    "UPDATE household_domains SET retired=1 WHERE label=?",
    "newregistered",
  );
  assert.equal((await f.claim(row.id, signed.contextCookie)).status, 404);
});
test("owner onboarding context cannot replace source authentication; fresh password and live owner access remain necessary", async (t) => {
  const f = await routingFixture(t),
    fresh = await f.createHost("Enroll"),
    site = await f.site(fresh),
    auth = f.store.newSession(
      { role: "host", user: fresh.user, household: fresh.household.id },
      site.origin,
    ),
    cookie = "__Host-events_session=" + auth.token;
  const intent = await site.request("/api/firebase/routing/start", {
      method: "POST",
      cookie,
      data: { enroll: true },
    }),
    reference = ref(intent);
  const denied = await f.sign(reference, {
    person: { first: "New", last: "Owner" },
    phone: "+15005550128",
    uid: "new-owner",
  });
  assert.equal(denied.status, 403);
  const accepted = await f.sign(reference, {
    person: { first: "New", last: "Owner" },
    phone: "+15005550128",
    uid: "new-owner",
    ownerPassword: f.password,
    contextCookie: denied.contextCookie,
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  const returned = await f.handoff(site, accepted);
  assert.equal(returned.status, 200);
  assert.equal(
    (await site.request("/api/session", { cookie: returned.cookie })).body.role,
    "host",
  );
});

test("invitation withdrawal and source-owner revocation invalidate pending login contexts", async (t) => {
  const f = await routingFixture(t),
    guest = await f.guest(f.betaHost, {
      first: "New",
      last: "Guest",
      phone: "+15005550122",
    }),
    event = await f.event(f.betaHost, [guest]),
    invitation = referenceFor(f.store, f.betaHost.household.id, event, {
      id: guest.id,
      guests: [guest.id],
    });
  const reference = ref(await f.route(f.beta, { invitation })),
    signed = await f.sign(reference, {
      person: { first: "New", last: "Guest" },
      phone: "+15005550122",
      uid: "withdrawn",
    });
  assert.equal(signed.status, 200);
  f.store.put(
    "event",
    event.id,
    f.betaHost.household.id,
    { ...event, invited: [] },
    event.version,
  );
  assert.equal((await f.complete(reference, signed)).status, 404);
  const fresh = await f.createHost("Revoked"),
    site = await f.site(fresh),
    auth = f.store.newSession(
      { role: "host", user: fresh.user, household: fresh.household.id },
      site.origin,
    );
  const intent = await site.request("/api/firebase/routing/start", {
    method: "POST",
    cookie: "__Host-events_session=" + auth.token,
    data: { enroll: true },
  });
  f.store.run("DELETE FROM sessions WHERE user=?", fresh.user);
  assert.equal(
    (
      await f.sign(ref(intent), {
        person: { first: "New", last: "Owner" },
        phone: "+15005550128",
        uid: "revoked-owner",
        ownerPassword: f.password,
      })
    ).status,
    401,
  );
});

test("branded central household entry returns an invited host to that household without changing QR references", async (t) => {
  const f = await routingFixture(t),
    guest = await f.guest(f.betaHost, {
      first: "Alex",
      last: "Example",
      phone: "+15005550121",
    });
  f.store.run(
    "UPDATE guest_identity_links SET identity=? WHERE household=? AND guest=?",
    f.identity,
    f.betaHost.household.id,
    guest.id,
  );
  const routed = await f.request("/api/firebase/routing/start", {
      method: "POST",
      data: { entry: "beta" },
    }),
    reference = ref(routed),
    signed = await f.sign(reference);
  assert.equal(signed.status, 200);
  assert.equal(
    (await f.complete(reference, signed)).body.destination,
    f.beta.origin,
  );
  const returned = await f.handoff(f.beta, signed);
  assert.equal(
    (await f.beta.request("/api/session", { cookie: returned.cookie })).body
      .role,
    "guest",
  );
});

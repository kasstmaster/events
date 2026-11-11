import test from "node:test";
import assert from "node:assert/strict";
import {
  runAccountMessages,
  processAccountReply,
} from "../server/personal-accounts.js";
import { application } from "./helpers/application.js";

test("personal family bootstraps once, keeps host notes private and requires versions without granting host rights", async (t) => {
  const f = await application(t),
    host = await f.host("FamilySource"),
    other = await f.host("OtherSource");
  const adult = await f.guest(host, {
      addressDraft: {
        label: "Example household",
        lines: "PO Box 12",
        notes: "Never shared private note",
      },
    }),
    child = await f.guest(host, {
      first: "Riley",
      last: "",
      parent: adult.id,
      address: adult.address,
    });
  const login = await f.guestLogin(host, adult),
    own = await f.request("/api/personal", { cookie: login.cookie });
  assert.equal(own.status, 200);
  assert.equal(own.body.profile.members.length, 2);
  assert.doesNotMatch(JSON.stringify(own.body), /Never shared/);
  assert.equal(
    (await f.request("/api/host", { cookie: login.cookie })).status,
    403,
  );
  assert.equal(
    (await f.request("/api/personal", { cookie: f.admin })).status,
    403,
  );
  const extra = await f.guest(host, { first: "Later", address: adult.address });
  const reread = await f.request("/api/personal", { cookie: login.cookie });
  assert.equal(reread.body.profile.members.length, 2);
  const profile = own.body.profile;
  const input = {
    ...profile,
    physical: {
      street: "PO Box 25",
      city: "Sample",
      state: "CA",
      zip: "90210",
    },
    mailingSame: true,
    sharing: "everyone",
  };
  const saved = await f.request("/api/personal/family", {
    cookie: login.cookie,
    method: "PUT",
    version: profile.version,
    data: input,
  });
  assert.equal(saved.status, 200);
  assert.match(
    f.store.get("address", adult.address, host.household.id).lines,
    /PO Box 25/,
  );
  assert.equal(
    f.store.get("address", adult.address, host.household.id).notes,
    "Never shared private note",
  );
  assert.equal(
    (
      await f.request("/api/personal/family", {
        cookie: login.cookie,
        method: "PUT",
        version: profile.version,
        data: input,
      })
    ).status,
    409,
  );
  assert.equal(f.store.list("guest", other.household.id).length, 0);
  assert.ok(f.store.get("guest", extra.id, host.household.id));
  assert.ok(f.store.get("guest", child.id, host.household.id));
});

test("legacy usernames cannot authenticate new browsers, remain private and never queue disabled SMS", async (t) => {
  const f = await application(t),
    host = await f.host("PrivateIdentity"),
    adult = await f.guest(host),
    login = await f.guestLogin(host, adult);
  const own = (await f.request("/api/personal", { cookie: login.cookie })).body;
  const saved = await f.request("/api/personal/account", {
    cookie: login.cookie,
    method: "PUT",
    version: own.account.version,
    data: { username: "private.casey", recoveryPhone: "+15551234567" },
  });
  assert.equal(saved.status, 200);
  assert.equal((await f.guestLogin(host, adult)).status, 401);
  const signin = await f.request("/api/sign-in", {
    method: "POST",
    data: { account: "private.casey", secret: adult.inviteCode },
  });
  assert.equal(signin.status, 401);
  const contacts = (await f.request("/api/host", { cookie: host.cookie })).body
    .guests;
  assert.doesNotMatch(JSON.stringify(contacts), /private.casey|15551234567/);
  const phone = await f.request("/api/personal/phone/start", {
    cookie: login.cookie,
    method: "POST",
    data: {},
  });
  assert.equal(phone.status, 503);
  assert.equal(f.store.list("phone-verification", "platform").length, 0);
  assert.equal(
    (
      await f.request("/api/username-recovery", {
        method: "POST",
        data: { phone: "+15551234567" },
      })
    ).status,
    503,
  );
  assert.equal(f.store.list("username-recovery", "platform").length, 0);
});

test("reciprocal household contacts expose shared details only after approval and stop exposing them on block", async (t) => {
  const f = await application(t),
    host = await f.host("ContactSource");
  const a = await f.guest(host, {
      first: "Alpha",
      addressDraft: { label: "Alpha home", lines: "PO Box 1" },
    }),
    b = await f.guest(host, {
      first: "Beta",
      addressDraft: { label: "Beta home", lines: "PO Box 2" },
    });
  const sa = await f.guestLogin(host, a),
    sb = await f.guestLogin(host, b);
  const pa = (await f.request("/api/personal", { cookie: sa.cookie })).body,
    pb = (await f.request("/api/personal", { cookie: sb.cookie })).body;
  const added = await f.request("/api/personal/contacts", {
    cookie: sa.cookie,
    method: "POST",
    data: { name: pb.profile.name, householdId: pb.profile.publicCode },
  });
  assert.equal(added.status, 200);
  assert.equal(
    added.body.contacts.find((c) => c.id === pb.profile.id).address,
    undefined,
  );
  assert.ok(
    (
      await f.request("/api/personal", { cookie: sb.cookie })
    ).body.contacts.some((c) => c.id === pa.profile.id),
  );
  const share = await f.request("/api/personal/family", {
    cookie: sb.cookie,
    method: "PUT",
    version: pb.profile.version,
    data: { ...pb.profile, sharing: "everyone" },
  });
  assert.equal(share.status, 200);
  const view = (await f.request("/api/personal", { cookie: sa.cookie })).body;
  assert.equal(
    view.contacts.find((c) => c.id === pb.profile.id).address,
    "PO Box 2",
  );
  assert.doesNotMatch(
    JSON.stringify(view.contacts),
    /username|recoveryPhone|notes/,
  );
  const block = await f.request("/api/personal/contacts/" + pb.profile.id, {
    cookie: sa.cookie,
    method: "PUT",
    version: view.profile.version,
    data: { blocked: true },
  });
  assert.equal(block.status, 200);
  assert.equal(
    block.body.contacts.find((c) => c.id === pb.profile.id).address,
    undefined,
  );
});

test("only a password-confirmed administrator may rename household identity and previous domains remain claimed aliases", async (t) => {
  const f = await application(t),
    host = await f.host("RenameSource");
  const path = `/api/admin/households/${host.household.id}/identity`,
    input = {
      name: "Renamed source",
      subdomain: "renamed-source",
      password: "Isolated-family-test-passphrase",
    };
  assert.equal(
    (
      await f.request(path, {
        method: "PUT",
        cookie: host.cookie,
        version: host.household.version,
        data: input,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/host/household", {
        method: "PUT",
        cookie: host.cookie,
        version: host.household.version,
        data: { ...host.household, name: "Unauthorized" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(path, {
        method: "PUT",
        cookie: f.admin,
        version: host.household.version,
        data: { ...input, password: "wrong" },
      })
    ).status,
    403,
  );
  const renamed = await f.request(path, {
    method: "PUT",
    cookie: f.admin,
    version: host.household.version,
    data: input,
  });
  assert.equal(renamed.status, 200);
  const saved = f.store.household(host.household.id);
  assert.equal(saved.subdomain, "renamed-source");
  assert.ok(saved.domainAliases.includes(host.household.subdomain));
  assert.equal(saved.slug, host.household.slug);
  assert.equal(
    f.store.hostnameHousehold(host.household.subdomain).id,
    host.household.id,
  );
  assert.equal(f.store.routingJob("renamed-source").phase, "pending");
  assert.equal(f.store.domainAvailable(host.household.subdomain), false);
  assert.equal(
    (
      await f.request(path, {
        method: "PUT",
        cookie: f.admin,
        version: host.household.version,
        data: input,
      })
    ).status,
    409,
  );
});

test("recovery phone verification is one-use and username reminders require YES; NO and unknown sends do not retry", async (t) => {
  // Fake provider settings are used only with the injected mock below. No live transport runs.
  const env = {
    SMS_ENABLED: "true",
    TWILIO_ACCOUNT_SID: "synthetic-account",
    TWILIO_AUTH_TOKEN: "synthetic-provider-secret",
    TWILIO_FROM: "+15005550006",
  };
  const f = await application(t, env),
    host = await f.host("VerifiedRecovery"),
    adult = await f.guest(host),
    login = await f.guestLogin(host, adult),
    phone = "+15005550123";
  let own = (await f.request("/api/personal", { cookie: login.cookie })).body;
  assert.equal(
    (
      await f.request("/api/personal/account", {
        cookie: login.cookie,
        method: "PUT",
        version: own.account.version,
        data: { username: "private.recovery", recoveryPhone: phone },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request("/api/personal/phone/start", {
        cookie: login.cookie,
        method: "POST",
        data: {},
      })
    ).status,
    200,
  );
  const challenge = f.store.list("phone-verification", "platform")[0],
    code = challenge.message.match(/\b[0-9]{6}\b/)[0],
    messages = [];
  const fetcher = async (_url, request) => {
    messages.push(new URLSearchParams(request.body).get("Body"));
    return Response.json(
      { sid: "synthetic-message-" + messages.length },
      { status: 201 },
    );
  };
  await runAccountMessages(f.store, env, { fetcher });
  await runAccountMessages(f.store, env, { fetcher });
  assert.equal(messages.length, 1);
  assert.equal(
    (
      await f.request("/api/personal/phone/verify", {
        cookie: login.cookie,
        method: "POST",
        data: { code: "000000" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request("/api/personal/phone/verify", {
        cookie: login.cookie,
        method: "POST",
        data: { code },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request("/api/personal/phone/verify", {
        cookie: login.cookie,
        method: "POST",
        data: { code },
      })
    ).status,
    400,
  );
  own = (await f.request("/api/personal", { cookie: login.cookie })).body;
  assert.equal(own.account.recoveryVerified, true);
  const recover = () =>
    f.request("/api/username-recovery", { method: "POST", data: { phone } });
  assert.equal((await recover()).status, 200);
  await runAccountMessages(f.store, env, { fetcher });
  assert.doesNotMatch(messages.at(-1), /private.recovery/);
  processAccountReply(
    f.store,
    new URLSearchParams({ From: phone, Body: "NO" }),
  );
  await runAccountMessages(f.store, env, { fetcher });
  assert.equal(messages.length, 2);
  assert.equal((await recover()).status, 200);
  await runAccountMessages(f.store, env, { fetcher });
  processAccountReply(
    f.store,
    new URLSearchParams({ From: phone, Body: "YES" }),
  );
  await runAccountMessages(f.store, env, { fetcher });
  assert.match(messages.at(-1), /private.recovery/);
  processAccountReply(
    f.store,
    new URLSearchParams({ From: phone, Body: "YES" }),
  );
  await runAccountMessages(f.store, env, { fetcher });
  assert.equal(messages.length, 4);
  assert.equal((await recover()).status, 200);
  let attempts = 0;
  const unknown = async () => {
    attempts++;
    throw Error("Synthetic transport interruption");
  };
  await runAccountMessages(f.store, env, { fetcher: unknown });
  await runAccountMessages(f.store, env, { fetcher: unknown });
  assert.equal(attempts, 1);
  assert.equal(
    f.store.list("username-recovery", "platform")[0].state,
    "unknown",
  );
  assert.equal((await recover()).status, 429);
});

test("administrator aliases are all validated before cleanup and deleting a host preserves its linked private guest account", async (t) => {
  const f = await application(t),
    host = await f.host("AliasSource"),
    other = await f.host("ProtectedHost");
  await f.request("/api/host", { cookie: host.cookie });
  const ownerLink = f.store.get("host-person", host.user, host.household.id),
    account = f.store.get("person-account", ownerLink.identity, "platform");
  const { createHash } = await import("node:crypto");
  f.store.put(
    "person-account",
    account.id,
    "platform",
    {
      ...account,
      username: "alias.owner",
      usernameHash: createHash("sha256").update("alias.owner").digest("hex"),
      recoveryPhone: "+15005550123",
    },
    account.version,
  );
  const invited = await f.guest(other, { first: "Alias", last: "Owner" });
  f.store.run(
    "UPDATE guest_identity_links SET identity=?,linked=1 WHERE household=? AND guest=?",
    ownerLink.identity,
    other.household.id,
    invited.id,
  );
  const renamed = f.store.renameHousehold(
    host.household.id,
    { name: "Renamed owner", subdomain: "alias-new" },
    host.household.version,
  );
  const labels = [renamed.subdomain, ...renamed.domainAliases],
    resources = new Map();
  for (const [i, label] of labels.entries()) {
    const receipt = f.store.routingJob(label);
    f.store.routingReceipt(label, { dns_id: "dns" + i, route_id: "route" + i });
    resources.set("dns" + i, {
      name: label + ".ilymmd.com",
      type: "AAAA",
      content: "100::",
      proxied: true,
      comment: "events-household:" + receipt.id,
    });
    resources.set("route" + i, {
      pattern: label + ".ilymmd.com/*",
      script: "events-household-gateway",
    });
  }
  const { deletionSummary, requestDeletion } =
      await import("../server/account-deletion.js"),
    { runAccountCleanup } = await import("../cloudflare/account-cleanup.js");
  const summary = deletionSummary(f.store, host.user);
  requestDeletion(f.store, host.user, {
    confirmEmail: summary.email,
    confirmDomain: summary.domain,
    householdVersion: renamed.version,
    confirmRevision: summary.revision,
  });
  assert.throws(
    () =>
      f.store.renameHousehold(
        host.household.id,
        { name: "Too late" },
        renamed.version,
      ),
    /disabled/,
  );
  resources.get("route1").script = "unrelated-worker";
  const deleted = [];
  const fetcher = async (url, request) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/workers/domains"))
      return Response.json({
        success: true,
        result: [],
        result_info: { total_pages: 1 },
      });
    const id = path.split("/").at(-1);
    if (request.method === "DELETE") {
      deleted.push(id);
      resources.delete(id);
      return Response.json({ success: true, result: {} });
    }
    return resources.has(id)
      ? Response.json({ success: true, result: resources.get(id) })
      : new Response(null, { status: 404 });
  };
  await runAccountCleanup(
    f.store,
    { HOUSEHOLD_DNS_TOKEN: "synthetic-only" },
    { fetcher },
  );
  assert.deepEqual(deleted, []);
  assert.equal(
    f.store.one(
      "SELECT error FROM household_deletions WHERE household=?",
      host.household.id,
    ).error,
    "cleanup_ownership_conflict",
  );
  resources.get("route1").script = "events-household-gateway";
  f.store.run(
    "UPDATE household_deletions SET next_attempt=0 WHERE household=?",
    host.household.id,
  );
  await runAccountCleanup(
    f.store,
    { HOUSEHOLD_DNS_TOKEN: "synthetic-only" },
    { fetcher },
  );
  assert.deepEqual(
    new Set(deleted),
    new Set(["dns0", "route0", "dns1", "route1"]),
  );
  assert.equal(f.store.household(host.household.id), null);
  assert.ok(f.store.household(other.household.id));
  const remaining = f.store.get("person-account", account.id, "platform");
  assert.equal(remaining.username, "alias.owner");
  assert.equal(remaining.hostUser, undefined);
  assert.equal(
    f.store.one(
      "SELECT identity FROM guest_identity_links WHERE household=? AND guest=?",
      other.household.id,
      invited.id,
    ).identity,
    ownerLink.identity,
  );
  assert.equal(
    (
      await f.request("/api/sign-in", {
        method: "POST",
        data: { account: "alias.owner", secret: invited.inviteCode },
      })
    ).status,
    401,
  );
  for (const label of labels)
    assert.equal(f.store.domainAvailable(label), false);
});

test("reciprocal host-profile contacts share only approved data and profile-alias blocking suppresses invitations and updates", async (t) => {
  const f = await application(t),
    alpha = await f.host("ContactAlpha"),
    beta = await f.host("ContactBeta"),
    adult = await f.guest(alpha, {
      addressDraft: {
        label: "Example family",
        lines: "PO Box 1",
        notes: "PRIVATE",
      },
      phone: "+15005550111",
    }),
    login = await f.guestLogin(alpha, adult);
  let own = (await f.request("/api/personal", { cookie: login.cookie })).body;
  await f.request("/api/personal/account", {
    cookie: login.cookie,
    method: "PUT",
    version: own.account.version,
    data: { username: "reciprocal.owner", recoveryPhone: "+15005550199" },
  });
  const hostProfile = (
    await f.request("/api/personal", { cookie: beta.cookie })
  ).body;
  assert.equal(
    (
      await f.request("/api/personal/contacts", {
        cookie: login.cookie,
        method: "POST",
        data: {
          name: hostProfile.profile.name,
          householdId: hostProfile.profile.publicCode,
        },
      })
    ).status,
    200,
  );
  own = (await f.request("/api/personal", { cookie: login.cookie })).body;
  assert.equal(own.contacts.filter((c) => c.name === "ContactBeta").length, 1);
  const saved = await f.request("/api/personal/family", {
    cookie: login.cookie,
    method: "PUT",
    version: own.profile.version,
    data: {
      ...own.profile,
      sharing: "selected",
      recipients: [hostProfile.profile.id],
      mailing: { street: "PO Box 22" },
      mailingSame: false,
    },
  });
  assert.equal(saved.status, 200);
  const related = f.store
    .list("guest", beta.household.id)
    .find((g) => g.first === adult.first);
  assert.ok(related);
  assert.equal(related.phone, "+15005550111");
  assert.match(
    f.store.get("address", related.address, beta.household.id).lines,
    /PO Box 22/,
  );
  assert.doesNotMatch(
    JSON.stringify(
      (await f.request("/api/host", { cookie: beta.cookie })).body.guests,
    ),
    /reciprocal.owner|15005550199|PRIVATE/,
  );
  const event = await f.event(beta, [related]);
  assert.ok(
    (await f.request("/api/guest", { cookie: login.cookie })).body.events.some(
      (e) => e.id === event.id,
    ),
  );
  const before = (await f.request("/api/personal", { cookie: login.cookie }))
    .body;
  // Simulate a retained profile-key preference written by an earlier client.
  f.store.put(
    "personal-household",
    before.profile.id,
    "platform",
    {
      ...f.store.get("personal-household", before.profile.id, "platform"),
      blocked: [hostProfile.profile.id],
    },
    before.profile.version,
  );
  const blocked = (await f.request("/api/personal", { cookie: login.cookie }))
    .body;
  assert.equal(
    blocked.contacts.find((c) => c.name === "ContactBeta").blocked,
    true,
  );
  assert.equal(
    (await f.request("/api/guest", { cookie: login.cookie })).body.events.some(
      (e) => e.id === event.id,
    ),
    false,
  );
  assert.equal(
    (
      await f.request("/api/personal/contacts/" + beta.household.id, {
        cookie: login.cookie,
        method: "PUT",
        version: blocked.profile.version,
        data: { blocked: false },
      })
    ).status,
    200,
  );
  assert.ok(
    (await f.request("/api/guest", { cookie: login.cookie })).body.events.some(
      (e) => e.id === event.id,
    ),
  );
});

test("shared name and Household ID cannot authenticate, even when a suffix is supplied", async (t) => {
  const f = await application(t),
    host = await f.host("NoSharedSignIn"),
    adult = await f.guest(host);
  for (const data of [
    { account: "Casey Example", secret: adult.inviteCode },
    {
      account: "Casey Example",
      secret: adult.inviteCode,
      suffix: "",
      suffixProvided: true,
    },
  ]) {
    const result = await f.request("/api/sign-in", { method: "POST", data });
    assert.equal(result.status, 401);
    assert.equal(result.cookie, undefined);
    assert.equal(result.body.suffixRequired, undefined);
  }
});

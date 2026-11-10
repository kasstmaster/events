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

test("private usernames replace name sign-in, stay out of host projections, preserve address codes and never queue disabled SMS", async (t) => {
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
  assert.equal(signin.status, 200);
  const contacts = (await f.request("/api/host", { cookie: host.cookie })).body
    .guests;
  assert.doesNotMatch(JSON.stringify(contacts), /private.casey|15551234567/);
  const phone = await f.request("/api/personal/phone/start", {
    cookie: signin.cookie,
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

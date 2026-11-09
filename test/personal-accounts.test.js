import test from "node:test";
import assert from "node:assert/strict";
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

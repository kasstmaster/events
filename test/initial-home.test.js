import test from "node:test";
import assert from "node:assert/strict";
import { cardInput } from "../server/features.js";
import { application } from "./helpers/application.js";
import {
  addressBookCheckpoint,
  isolateAddressBook,
} from "../server/recipient-isolation.js";
import { publicEventReference } from "../server/public-invitations.js";
import {
  initialHomeHtml,
  initialHomeTopbar,
  initialHomeBottomBar,
} from "../server/initial-home.js";
import { initialThemeStyle } from "../server/initial-theme.js";

test("initial HTML needs no JavaScript and exposes no account details to visitors", () => {
  const output = initialHomeHtml();
  assert.match(output, /Welcome to Gather/);
  assert.match(output, /href="\/signin"/);
  assert.doesNotMatch(output, /Getting things ready/);
});

test("validated host gets escaped, lightweight event summaries", () => {
  const output = initialHomeHtml({
    household: { name: '<script id="secret">&</script>' },
    events: [
      {
        title: "<img src=x onerror=alert(1)>",
        description: "Hello & welcome",
        date: "2030-02-10",
      },
      { title: "Old memory", date: "2000-02-10" },
    ],
  });
  assert.match(output, /Your gathering place/);
  assert.match(
    output,
    /&lt;script id=&quot;secret&quot;&gt;&amp;&lt;\/script&gt;/,
  );
  assert.match(output, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(output, /Hello &amp; welcome/);
  assert.match(output, /Archived events/);
  assert.doesNotMatch(output, /<script|<img/);
  assert.doesNotMatch(output, /Getting things ready/);
});

test("first document includes real Home controls and event buttons", () => {
  const markup = initialHomeHtml({
    household: { name: "Acme", logo: "/gather-192.png" },
    events: [{ id: "event123", title: "Picnic", totals: { attending: 3 } }],
  });
  assert.match(initialHomeTopbar(), /data-action="new-event"/);
  assert.match(initialHomeBottomBar(), /data-action="home"/);
  assert.match(markup, /data-action="addresses"/);
  assert.match(markup, /data-action="family-workspace"/);
  assert.match(markup, /data-action="cards"/);
  assert.match(markup, /data-action="open-event"/);
  assert.match(markup, /data-action="event-action-dashboard"/);
  assert.match(markup, /data-action="event-action-cards"/);
  assert.match(markup, /class="card host-event-choice"/);
  assert.match(markup, /3 attending/);
});

test("saved design is present before the client app initializes", () => {
  const markup = initialThemeStyle({
    background: "#111827",
    container: "#223344",
    titleColor: "#abcdef",
    buttonSurface: "#334455",
    buttonLabelColor: "#f8fafc",
    toolbarSurface: "#123456",
    titleFont: "Georgia",
  });
  assert.match(markup, /id="gather-initial-theme"/);
  assert.match(markup, /--bg:#111827/);
  assert.match(markup, /--panel-solid:#223344/);
  assert.match(markup, /--button-surface:#334455/);
  assert.match(markup, /--button-panel:color-mix/);
  assert.match(markup, /--button-label-color:#f8fafc/);
  assert.match(markup, /--toolbar-surface:#123456/);
  assert.match(markup, /--heading:#abcdef/);
  assert.match(markup, /--title-font:Georgia/);
});

test("appearance data cannot escape its initial inline style", () => {
  const markup = initialThemeStyle({
    titleFont: "Georgia;}</style><script>alert(1)</script>",
    backgroundImage: "javascript:alert(1)",
  });
  assert.doesNotMatch(markup, /<script>|<\/style><script>/);
  assert.match(markup, /--background-image:none/);
});

test("image-based household themes retain data URL MIME separators", () => {
  const markup = initialThemeStyle({
    backgroundImage: "data:image/png;base64,AAAA",
    containerImage: "data:image/png;base64,BBBB",
  });
  assert.match(
    markup,
    /--background-image:url\("data:image\/png;base64,AAAA"\)/,
  );
  assert.match(
    markup,
    /--container-image:url\("data:image\/png;base64,BBBB"\)/,
  );
});

test("artwork-heavy snapshots use scoped display URLs and unchanged startup responses stay small", async (t) => {
  const mode = {
    HOST_ONLY_MODEL_ENABLED: "true",
    HOST_ONLY_MODEL_ACTIVATION_APPROVED: "true",
  };
  const f = await application(t, mode);
  const host = await f.host("ArtHost");
  const other = await f.host("OtherArtHost");
  const household = host.household.id;
  isolateAddressBook(
    f.store,
    household,
    addressBookCheckpoint(f.store, household).fingerprint,
    "synthetic",
  );
  isolateAddressBook(
    f.store,
    other.household.id,
    addressBookCheckpoint(f.store, other.household.id).fingerprint,
    "synthetic",
  );
  const artwork = (fill) =>
    "data:image/png;base64," + Buffer.alloc(1_500_000, fill).toString("base64");
  const logo = artwork(1);
  const house = f.store.household(household);
  f.store.put(
    "household",
    household,
    household,
    {
      ...house,
      logo,
      design: { backgroundImage: artwork(2), containerImage: artwork(3) },
    },
    house.version,
  );
  let event;
  for (let i = 0; i < 3; i++) {
    const record = await f.event(host, [], { title: "Gathering " + i });
    event = f.store.put(
      "event",
      record.id,
      household,
      {
        ...record,
        icon: artwork(4 + i),
        design: { backgroundImage: artwork(9) },
      },
      record.version,
    );
  }
  for (let i = 0; i < 8; i++)
    f.store.put(
      "template",
      "artwork-" + i,
      "platform",
      cardInput({ name: "Artwork " + i, background: artwork(20 + i) }),
    );
  const ref = publicEventReference(f.store, household, event.id);
  const startup = "/api/startup?view=home";
  for (const path of [
    "/",
    "/?event=" + event.id,
    "/event/" + ref,
    startup,
    startup + "&workspace=1",
    "/api/host?view=home",
  ]) {
    const result = await f.request(path, { cookie: host.cookie });
    const body =
      typeof result.body === "string"
        ? result.body
        : JSON.stringify(result.body);
    assert.equal(result.status, 200, path);
    assert.ok(Buffer.byteLength(body) < 100_000, path);
    assert.doesNotMatch(body, /data:image\//);
  }
  const boot = (await f.request(startup, { cookie: host.cookie })).body;
  assert.equal(boot.host.templates, undefined);
  assert.equal(boot.host.guests, undefined);
  assert.equal(boot.host.events.length, 3);
  const picker = await f.request("/api/host/workspace", {
    cookie: host.cookie,
  });
  assert.deepEqual(picker.body.templates[0], {
    id: "artwork-0",
    name: "Artwork 0",
  });
  const original = await f.request("/api/admin/templates/artwork-0", {
    cookie: f.admin,
  });
  assert.equal(original.body.background, artwork(20));
  const privateLogo = boot.host.household.logo;
  assert.match(privateLogo, /^\/api\/display-media\/host\//);
  const full = await fetch(f.url + privateLogo, {
    headers: { Cookie: host.cookie },
  });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get("content-type"), "image/png");
  assert.deepEqual(
    Buffer.from(await full.arrayBuffer()),
    Buffer.alloc(1_500_000, 1),
  );
  const conditional = { "If-None-Match": full.headers.get("etag") };
  assert.equal(
    (
      await f.request(privateLogo, {
        cookie: host.cookie,
        headers: conditional,
      })
    ).status,
    304,
  );
  assert.equal(
    (await f.request(privateLogo, { headers: conditional })).status,
    401,
  );
  assert.equal(
    (
      await f.request(privateLogo, {
        cookie: other.cookie,
        headers: conditional,
      })
    ).status,
    404,
  );
  const publicBoot = (await f.request("/api/public/events/" + ref)).body;
  const publicArtwork = publicBoot.events[0].icon;
  assert.match(publicArtwork, /^\/api\/display-media\/event\//);
  const publicImage = await fetch(f.url + publicArtwork);
  assert.deepEqual(
    Buffer.from(await publicImage.arrayBuffer()),
    Buffer.alloc(1_500_000, 6),
  );
  const seen = startup + "&seen=" + boot.revision;
  assert.deepEqual((await f.request(seen, { cookie: host.cookie })).body, {
    unchanged: true,
    revision: boot.revision,
  });
  const raw = f.store.get("event", event.id, household);
  f.store.put(
    "event",
    raw.id,
    household,
    { ...raw, title: "Changed" },
    raw.version,
  );
  const changed = (await f.request(seen, { cookie: host.cookie })).body;
  assert.notEqual(changed.revision, boot.revision);
  assert.equal(
    changed.host.events.find((e) => e.id === raw.id).title,
    "Changed",
  );
  assert.equal(f.store.household(household).logo, logo);
  const link = f.store.get("public-event", ref, "platform");
  f.store.put(
    "public-event",
    ref,
    "platform",
    { ...link, revoked: true },
    link.version,
  );
  assert.equal((await f.request(publicArtwork)).status, 404);
});

import test from "node:test";
import assert from "node:assert/strict";
import { initialHomeHtml } from "../server/initial-home.js";
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
  assert.match(markup, /data-action="new-event"/);
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

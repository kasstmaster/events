import test from "node:test";
import assert from "node:assert/strict";
import { initialHomeHtml } from "../server/initial-home.js";

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

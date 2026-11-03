import test from "node:test";
import assert from "node:assert/strict";
import { checkMetadata } from "./cloudflare-metadata-check.mjs";

const privateValue = "synthetic-private-diagnostic";
const env = { CLOUDFLARE_API_TOKEN: privateValue };
const version = "ad58a701-d5c5-432f-a432-3221a6d7c7a4";
function fixture(fail = "") {
  const paths = [],
    logs = [];
  return {
    paths,
    logs,
    options: {
      env,
      log: (value) => logs.push(value),
      fetcher: async (url, init) => {
        assert.equal(init.method, "GET");
        assert.equal(init.redirect, "error");
        const path = new URL(url).pathname;
        assert.ok(
          path.startsWith(
            "/client/v4/accounts/37d068144865a0b725ee272bc7b2eb71/workers/",
          ),
        );
        assert.ok(url.includes("events"));
        paths.push(path);
        if (fail && path.endsWith(fail))
          return Response.json(
            {
              success: false,
              errors: [
                { code: 10000, message: privateValue },
                { code: privateValue },
              ],
              privateValue,
            },
            { status: 403 },
          );
        let result = { privateValue };
        if (path.endsWith("/deployments"))
          result = {
            deployments: [
              { versions: [{ version_id: version, percentage: 100 }] },
            ],
          };
        if (path.endsWith("/services/events"))
          result = {
            default_environment: { environment: "production" },
            privateValue,
          };
        return Response.json({ success: true, result });
      },
    },
  };
}
test("metadata inventory is Events-only GET and emits no runtime values", async () => {
  const f = fixture();
  assert.equal(await checkMetadata(f.options), true);
  assert.equal(f.paths.length, 9);
  assert.ok(f.logs.includes("active-version: " + version));
  assert.ok(!f.logs.join("\n").includes(privateValue));
});
test("failed metadata read identifies its stage and numeric status without raw provider diagnostics", async () => {
  const f = fixture("/records");
  assert.equal(await checkMetadata(f.options), false);
  assert.ok(f.logs.includes("custom-domains: HTTP 403; fail; codes 10000"));
  assert.ok(!f.logs.join("\n").includes(privateValue));
});
test("missing credentials, malformed environments and transport errors fail closed without secret output", async () => {
  const logs = [];
  assert.equal(
    await checkMetadata({
      env: {},
      log: (v) => logs.push(v),
      fetcher: () => assert.fail("must not fetch"),
    }),
    false,
  );
  assert.equal(
    await checkMetadata({
      env,
      log: (v) => logs.push(v),
      fetcher: async () => {
        throw Error(privateValue);
      },
    }),
    false,
  );
  const f = fixture();
  f.options.fetcher = async () =>
    Response.json({
      success: true,
      result: { default_environment: { environment: "../other-worker" } },
    });
  assert.equal(await checkMetadata(f.options), false);
  assert.ok(!logs.concat(f.logs).join("\n").includes(privateValue));
});

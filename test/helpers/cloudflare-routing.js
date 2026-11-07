import assert from "node:assert/strict";
// Cloudflare control-plane simulator. No requests leave the test process.
export function cloudflareRouting() {
  const records = [],
    routes = [],
    domains = [],
    writes = [];
  let failure = null;
  const json = (result) => Response.json({ success: true, result });
  async function fetcher(request, init) {
    const req =
      typeof request === "string" ? new Request(request, init) : request;
    const url = new URL(req.url);
    assert.equal(url.origin, "https://api.cloudflare.com");
    if (failure)
      return new Response("private upstream error must not leak", {
        status: failure,
      });
    let collection;
    if (url.pathname.endsWith("/dns_records")) collection = records;
    else if (url.pathname.endsWith("/workers/routes")) collection = routes;
    else if (url.pathname.endsWith("/workers/domains")) collection = domains;
    else throw new Error("Unexpected management API path");
    if (req.method === "GET") return json(collection);
    assert.equal(
      req.method,
      "POST",
      "must never replace/delete existing resources",
    );
    assert.notEqual(collection, domains);
    const value = { ...(await req.json()), id: `synthetic-${writes.length}` };
    collection.push(value);
    writes.push({ url: url.pathname, value });
    return json(value);
  }
  return {
    records,
    routes,
    domains,
    writes,
    fetcher,
    fail: (code) => {
      failure = code;
    },
  };
}
export async function waitForActive(f, host) {
  for (let i = 0; i < 150; i++) {
    const result = await f.request("/api/host", { cookie: host.cookie });
    if (result.body.household?.subdomainStatus === "active")
      return result.body.household;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const storage = await f.runtime.unsafeGetDurableObjectStorage(
    "events",
    "EventsDatabase",
    { name: "events-platform-v1" },
  );
  throw new Error(
    "Synthetic automatic routing did not activate: " +
      JSON.stringify({
        jobs: await storage.exec(
          "SELECT label,phase,error FROM household_routing",
        ),
        trace: f.trace,
      }),
  );
}

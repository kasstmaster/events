import { pathToFileURL } from "node:url";
import { runtimeSchemaSummary } from "./automatic-events-release.mjs";

const ACCOUNT = "37d068144865a0b725ee272bc7b2eb71";
const SCRIPT = `/accounts/${ACCOUNT}/workers/scripts/events`;
const SERVICE = `/accounts/${ACCOUNT}/workers/services/events`;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

// No response bodies, headers, exception messages or runtime setting values escape.
export async function checkMetadata({
  env = process.env,
  fetcher = fetch,
  log = console.log,
} = {}) {
  if (!env.CLOUDFLARE_API_TOKEN) {
    log("credential: missing");
    return false;
  }
  let passed = true;
  async function read(stage, path) {
    try {
      const response = await fetcher(
        `https://api.cloudflare.com/client/v4${path}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
          signal: AbortSignal.timeout(15000),
          redirect: "error",
        },
      );
      let body;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      const codes = Array.isArray(body?.errors)
        ? body.errors
            .map((e) => e?.code)
            .filter(Number.isSafeInteger)
            .slice(0, 8)
        : [];
      const ok = response.ok && body?.success === true;
      log(
        `${stage}: HTTP ${response.status}; ${ok ? "pass" : "fail"}; codes ${codes.join(",") || "none"}`,
      );
      if (!ok) passed = false;
      return ok ? body.result : null;
    } catch {
      passed = false;
      log(`${stage}: transport-failure`);
      return null;
    }
  }
  const settings = await read("settings", `${SCRIPT}/settings`);
  if (settings)
    log(
      `settings-schema (names/types only): ${runtimeSchemaSummary(settings)}`,
    );
  const deployment = await read("active-deployment", `${SCRIPT}/deployments`);
  const versions = deployment?.deployments?.[0]?.versions;
  if (
    versions?.length === 1 &&
    versions[0].percentage === 100 &&
    uuid.test(versions[0].version_id)
  )
    log(`active-version: ${versions[0].version_id}`);
  const service = await read("service", SERVICE);
  const environment = service?.default_environment?.environment;
  if (
    typeof environment !== "string" ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(environment)
  ) {
    log("service-environment: unavailable");
    return false;
  }
  const base = `${SERVICE}/environments/${encodeURIComponent(environment)}`;
  const requests = [
    ["bindings", `${base}/bindings`],
    ["routes", `${base}/routes?show_zonename=true`],
    [
      "custom-domains",
      `/accounts/${ACCOUNT}/workers/domains/records?page=0&per_page=5&service=events&environment=${encodeURIComponent(environment)}`,
    ],
    ["subdomain", `${base}/subdomain`],
    ["service-environment", base],
    ["schedules", `${SCRIPT}/schedules`],
  ];
  for (let i = 0; i < requests.length; i += 2)
    await Promise.all(
      requests.slice(i, i + 2).map(([stage, path]) => read(stage, path)),
    );
  log(
    "Read-only Events metadata check finished. No configuration or data was changed.",
  );
  return passed;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (!(await checkMetadata())) process.exitCode = 1;
}

import { mkdir, writeFile } from "node:fs/promises";
import {
  safeSettings,
  activeDeployment,
  settingsChanges,
} from "./manual-events-release.mjs";
const account = "37d068144865a0b725ee272bc7b2eb71";
const base = `/accounts/${account}/workers/scripts/events`;
const good = "2445780c-00a8-4be8-be81-64e450420038";
const expected = "466edc14-ed97-42b1-9759-0bcbb571ecd4";
const report = {
  account,
  worker: "events",
  approved_application: "925c25ad0f89b6deb85838ae36f13d168444b1d0",
  approved_version: good,
  checks: {},
};
async function request(host, path, token, method = "GET") {
  const r = await fetch(`https://${host}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  let j;
  try {
    j = await r.json();
  } catch {}
  return {
    ok: r.ok && (host !== "api.cloudflare.com" || j?.success === true),
    status: r.status,
    result: host === "api.cloudflare.com" ? j?.result : j,
    date: r.headers.get("date"),
    codes: (j?.errors || []).map((e) => e.code).filter(Number.isInteger),
  };
}
async function cf(stage, path, required = true) {
  const r = await request(
    "api.cloudflare.com",
    `/client/v4${path}`,
    process.env.CLOUDFLARE_API_TOKEN,
  );
  report.checks[stage] = { status: r.status, ok: r.ok, codes: r.codes };
  if (!r.ok && required)
    throw new Error(
      `STOP: ${stage} HTTP ${r.status}; codes ${r.codes.join(",")}`,
    );
  return r;
}
try {
  const workflow =
    "/repos/kasstmaster/events/actions/workflows/deploy-events-auto.yml";
  const disabled = await request(
    "api.github.com",
    `${workflow}/disable`,
    process.env.GH_TOKEN,
    "PUT",
  );
  if (!disabled.ok)
    throw new Error(`STOP: disable automatic workflow HTTP ${disabled.status}`);
  const wf = await request("api.github.com", workflow, process.env.GH_TOKEN);
  report.workflow_disable_check = {
    put_status: disabled.status,
    get_status: wf.status,
    state: /^[a-z_]+$/.test(wf.result?.state || "")
      ? wf.result.state
      : "unavailable",
  };
  if (!wf.ok || wf.result?.state !== "disabled_manually")
    report.automatic_workflow_blocker =
      "STOP: automatic workflow disable not verified";
  report.automatic_workflow = { id: wf.result.id, state: wf.result.state };
  const runs = await request(
    "api.github.com",
    `${workflow}/runs?per_page=100`,
    process.env.GH_TOKEN,
  );
  if (!runs.ok) throw new Error("STOP: workflow run inventory failed");
  const active = runs.result.workflow_runs.filter(
    (r) => r.status !== "completed",
  );
  if (active.length)
    throw new Error(
      `STOP: ${active.length} automatic release runs remain active`,
    );
  const settings = (await cf("settings", `${base}/settings`)).result;
  report.settings = safeSettings(settings);
  report.deployment = activeDeployment(
    (await cf("deployment", `${base}/deployments`)).result,
  );
  if (report.deployment.version_id !== expected)
    throw new Error("STOP: production differs from reviewed PR 70 version");
  const current = (await cf("current-version", `${base}/versions/${expected}`))
    .result;
  const original = (await cf("approved-version", `${base}/versions/${good}`))
    .result;
  report.migration_tags = {
    current: current?.resources?.script_runtime?.migration_tag,
    approved: original?.resources?.script_runtime?.migration_tag,
  };
  if (
    report.migration_tags.current !== "events-v1" ||
    report.migration_tags.approved !== "events-v1"
  )
    throw new Error("STOP: migration lineage mismatch");
  report.approved_version_created = original.metadata?.created_on;
  // Version bindings never serialize secret text. Only names/types and nonsecret digests.
  try {
    report.approved_settings = safeSettings({
      ...original.resources.script_runtime,
      bindings: original.resources.bindings,
    });
    report.version_setting_changes = settingsChanges(
      report.approved_settings,
      report.settings,
    );
  } catch {
    report.version_setting_changes = [
      "Historical version settings cannot establish complete secret/value continuity; do not roll back blindly.",
    ];
  }
  report.schedules = (
    await cf("schedules", `${base}/schedules`)
  ).result.schedules?.map((s) => s.cron);
  report.subdomain = (await cf("subdomain", `${base}/subdomain`)).result;
  if (report.subdomain.previews_enabled !== false)
    throw new Error("STOP: preview URLs are not disabled");
  const service = (
    await cf("service", `/accounts/${account}/workers/services/events`)
  ).result;
  const environment = service.default_environment?.environment;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(environment))
    throw new Error("STOP: service environment missing");
  const serviceBase = `/accounts/${account}/workers/services/events/environments/${environment}`;
  const routes = await cf("routes", `${serviceBase}/routes?show_zonename=true`);
  report.routes = routes.result;
  await cf("service-environment", serviceBase);
  // Read only. Lack of build-control visibility blocks a release, never changes settings.
  const builds = await cf(
    "build-triggers",
    `/accounts/${account}/builds/triggers?external_script_id=${encodeURIComponent(settings.id || settings.tag || "events")}`,
    false,
  );
  report.build_controls_verified =
    builds.ok && Array.isArray(builds.result) && builds.result.length === 0;
  for (const [label, url] of [
    ["setup", "https://events.kassandraraudman.workers.dev/api/setup"],
    ["root", "https://events.kassandraraudman.workers.dev/"],
    ["household", "https://name.ilymmd.com/"],
  ]) {
    const r = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    if (label === "setup") {
      const j = await r.json();
      report.checks.setup = {
        status: r.status,
        closed: j.required === false && j.enabled === false,
      };
    } else {
      const body = await r.text();
      report.checks[label] = {
        status: r.status,
        unavailable: body.includes("This household address is unavailable."),
        bytes: Buffer.byteLength(body),
      };
    }
  }
  const final = activeDeployment(
    (await cf("stable-deployment", `${base}/deployments`)).result,
  );
  if (JSON.stringify(final) !== JSON.stringify(report.deployment))
    throw new Error("STOP: concurrent production change");
  const clock = (await cf("clock", `${base}/settings`)).date;
  report.recovery = {
    namespace: "8203f4cd7fde45d2ab49de62e239d744",
    class: "EventsDatabase",
    object: "events-platform-v1",
    timestamp: clock,
    kind: "approximate SQLite PITR timestamp; not an exact bookmark or exported backup",
    restore_performed: false,
  };
  report.production_changed = false;
  console.log(
    "Inspection completed; no Cloudflare writes or data writes. Automatic GitHub release workflow disabled.",
  );
} catch (e) {
  report.blocker = e.message.startsWith("STOP:")
    ? e.message
    : "STOP: inspection transport or parsing failure (details suppressed)";
  process.exitCode = 1;
}
await mkdir("recovery", { recursive: true });
await writeFile(
  "recovery/pre67-inspection.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));

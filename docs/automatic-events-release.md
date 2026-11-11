# Owner-merged Gather releases

The application was verified before preparing automation: PR #74 merged as `562ca263097e79fa8026d6427a21ebedfe8deae1`, and its frontend, shared server/Worker code, dependencies, tests and Worker configurations match approved application `925c25ad0f89b6deb85838ae36f13d168444b1d0` exactly. The integrated main commit is an ancestry floor, not an application checkout or deployment pin.

Codex implements, tests, commits and pushes a feature branch. The owner creates/reviews the PR, waits for required checks and merges it into main. Only that owner merge can initiate `.github/workflows/deploy-approved-events.yml`. Codex must not create/merge PRs or dispatch/deploy releases. The new filename avoids reviving the old manually disabled unsafe workflow.

**Merging this setup PR is a real approved release**, not a non-production test. No live release or Cloudflare settings change is performed while preparing/testing this branch. Cloudflare's Git-connected production and preview builds must remain disabled; GitHub Actions is the sole automatic release path. Leave the obsolete automatic workflow disabled. Never change credentials to install automation.

## Owner configuration before merging

GitHub metadata reported main **unprotected** at preparation time. Configure a branch protection rule or equivalent active ruleset for `main` in **Settings → Branches / Rules → Rulesets**:

1. Require pull requests and conversation resolution. If a separate trusted reviewer is available, require an approving review, dismiss stale approvals and require approval after the most recent push. For a solo owner, retain required PRs and CI checks and review the changes before merging; GitHub does not allow approving your own PR, so do not configure an impossible self-approval requirement.
2. Require status checks, with branches up to date before merge: `test`, `browser (navigation)`, `browser (editors)`, `browser (accounts)`, `Release safety and Worker build`. The always-on release check includes the manual safeguard tests; do not require the separate path-filtered `safety` check on every PR, since it may not run for unrelated changes. Select the GitHub Actions app as the expected source. The new check appears after this feature PR's first validation run; configure the rule before merging.
3. Block force pushes/deletion and direct pushes; include administrators/no bypass where available. Do not add paid features or change plan to complete this setup. If the rule UI/plan differs, use equivalent required PR/check protections and inspect enforcement before merging.
4. Keep GitHub Actions enabled and allow the repository's existing checkout/setup-node/upload-artifact/download-artifact actions. Preserve the existing GitHub `CLOUDFLARE_API_TOKEN` secret; the built-in short-lived `github.token` supplies read-only repository/Actions/PR/issue access.
5. Confirm the new **Deploy approved merged Gather** workflow is enabled after integration. Do not enable Cloudflare builds, previews or the old automatic workflow. If the first owner merge is blocked because protection was not enabled, fix protection and rerun only after reviewing the failed preflight and current live version.

The publish helper checks GitHub's `protected` flag and fails closed when false. A true flag alone cannot prove the exact review/check rules: the owner must configure the settings above. Repository administration is not available through this session's connector; this branch does not claim those settings were changed.

## Exact source and appearance protections

The automatic workflow listens only for `pull_request: closed` targeting main. Every validation job requires a merged same-repository PR whose merger is `kasstmaster`. Checkout uses only `pull_request.merge_commit_sha`, full Git history and no persisted Git credentials. No deployment runs on push, create, opened/updated/unmerged PRs, previews, workflow-run, schedules, workflow dispatch or unrelated repositories.

The source guard verifies exact HEAD, full integrated history, a clean tracked tree, no unreviewed application files and all required shared application paths. An ancestry check alone is insufficient: the former operations tree retained old history while losing the real application. Missing shared modules or an older source tree therefore stop before production access.

`.github/release/approved-application.json` records the approved public-file hashes and required application files. All public assets must match the manifest, including additions/removals. Changes under `public/` also require that PR to update the manifest and carry `approved-appearance-change`, with the latest application of that label performed by the owner. A copied/forged label or missing/incomplete event history fails closed. Public JavaScript changes also require this review because it defines page layouts and interactions.

For an intentional, owner-requested public change, stage its files, update the manifest locally, review it with the code, and commit both:

```sh
git add public
node scripts/automatic-events-release.mjs manifest
npx prettier --write .github/release/approved-application.json
git add .github/release/approved-application.json
```

The owner applies the appearance approval label before merging that PR. This is an approval for the specific reviewed change; it does not authorize generic redesigns or overwrite tenant formatting. This setup changes no application files or appearance.

Configuration and the production storage adapter have additional fixed fingerprints, not merely an editable manifest value. Automatic releases preserve account `37d068144865a0b725ee272bc7b2eb71`, Worker `events`, binding `EVENTS_DATABASE`, namespace `8203f4cd7fde45d2ab49de62e239d744`, class `EventsDatabase`, object `events-platform-v1`, migration tag `events-v1`, assets directory/binding, both compatibility flags, date `2026-10-30`, keep-vars, workers.dev, disabled preview URLs and the existing five-minute cron. Changing these requires a separately reviewed infrastructure release, never a policy-file-only bypass. No gateway deployment, namespace recreation or reverse migration is performed.

## Validation and publish ordering

Before publication, independent merge jobs run formatting, all application/API and release-safety tests, six AnyList adapter tests, both Cloudflare runtime checks, a local events Worker dry run, and all 11 browser suites across navigation/editors/accounts matrices. Failed or skipped required dependencies prevent publication. PR/main validation separately runs the application/browser suites and the release/build check, without Cloudflare credentials or publishing.

Publishing shares the unchanged manual workflow's `events-production` concurrency lock, with cancellation disabled. GitHub may replace pending jobs, but cannot overlap running releases. Within that lock the helper re-reads GitHub and requires the exact owner-reviewed merged SHA to still be latest main immediately before publishing. Annotated production releases must be strict ancestors of the next release; equal, unknown or newer/unrelated releases stop. The one unannotated baseline allowed is the previously verified restored Worker `2445780c-00a8-4be8-be81-64e450420038`. This is a recovery baseline only, never a deployment target. Any unexpected manual production version requires fresh review rather than guessing.

A newer owner merge may arrive during an active release. It waits for the same lock. Read-only verification of the already-published release can finish; a queued older release must pass latest-main checks again before it can publish. Direct pushes to main never trigger production.

## Production preflight and checkpoint

Two stable read-only snapshots verify the active single 100% version, SQLite migration lineage, exact binding, runtime settings, variable fingerprints, schedules, route/custom-domain inventories, disabled preview URLs and closed setup. The complete settings object is hashed without serializing private values, so otherwise unknown runtime settings are protected too. No provider response bodies, Authorization headers, secret values or raw exception diagnostics are emitted.

The timestamp checkpoint identifies the existing SQLite object and recovery version. It is an **approximate SQLite PITR timestamp**, not an exact bookmark or exported database backup, and no restore is performed. Its nominal PITR window is 30 days; the artifact is retained for 29 days.

Checkpoint upload must succeed before publishing. The helper separately verifies the artifact ID/name/digest/expiry/size through GitHub, validates the unchanged checkpoint hash and freshness, and repeats source, GitHub/latest-main and live-state checks. A failed/missing upload or changed state stops without calling Wrangler.

Only preflight, publishing and verification steps in the serialized production job receive the existing Cloudflare secret. Validation jobs have no production credential. Wrangler deploys the checked-out merged SHA to `events` with `--keep-vars` and a message containing that exact SHA. A private temporary config retains the exact reviewed application/configuration and overlays only the observed existing runtime settings (including observability, placement, limits, cache and logging/tails). This avoids Wrangler silently disabling omitted observability. No secret values or variable values are written into that config. An additional local dry run validates it; unknown metadata, unsupported extra bindings or rejected/unrecognized config fields stop before publishing. Source/checkpoint/live-state/latest-main checks repeat after this local build immediately before publish. Ordinary existing tags and billing metadata are inherited without config overrides; reserved service/environment tags stop preflight because this Worker must not be regrouped. The temporary config and raw output are deleted afterward; the committed Worker config remains unchanged. Inherited proxy/CA settings are preserved. Raw Wrangler output is captured privately and discarded; only one validated production deployment version ID is retained. There is no publishing retry, forced secret rollback, runtime correction exception, separate upload of an old application, or settings/credential mutation.

## Live verification and failure handling

After deployment, read-only verification requires the exact emitted Worker version at 100% traffic, its merged-SHA annotation, closed setup and unchanged complete runtime/settings fingerprints, binding identity, schedules, routes and custom-domain inventories. Every public asset is compared byte-for-byte to the reviewed merged source on the canonical origin and representative existing `name.ilymmd.com` household origin. Bounded polling allows the known Durable Object/edge code handover to converge without republishing. This checks actual live resources, not only local tests.

Private host/guest UI interactions remain covered by isolated pre-release browser suites, not fabricated live accounts. Existing authorized sessions are required for manual production sign-in/RSVP/editor acceptance. Never modify real responses or send real SMS for testing; SMS remains disabled.

If publication fails or its outcome is uncertain, inspect the active version and saved checkpoint before doing anything else. Do not rerun a deployment merely to retry health checks. If assets fail to converge, investigate and perform read-only verification; never automatically roll back code or data. If unknown runtime metadata legitimately changes, stop and review rather than weakening fingerprints. Raw logs are deliberately withheld because provider diagnostics may carry private values. The fixed failure stage and safe artifact contain the useful context.

The existing manual workflow/helper/tests and their known-good application pin remain unchanged as the separate recovery option. Their historical baseline intentionally fails closed until a future manual deployment receives a fresh reviewed baseline. The manual job and automatic publish job cannot overlap. Cloudflare live permissions/build controls are not exercised by local mock validation; the first owner-approved release performs real preflight and stops before publish if any required inventory cannot be read. Do not rotate credentials on that evidence.

## Validation of this setup

Non-production validation passed: 141 application/API tests, all 11 phone/desktop browser suites, 2 Cloudflare runtime checks, 22 automatic/manual/metadata safety tests, 6 AnyList transport/reconciliation tests, formatting, YAML trigger/dependency/credential checks, and the local events Worker dry run. A second real local bundle validated a private effective config with synthetic observability/placement/limits/cache settings; its production command was intercepted and never executed. Guard tests also verify that unknown runtime fields stop before publishing and that raw output/private temporary files are discarded.

Application files, public assets, dependencies, Worker configurations and the manual release workflow/helper/tests remain byte-for-byte unchanged from merged main. No PR was created, no live release was triggered, and no Cloudflare settings, stored data or credentials were changed to test automation. Live credential permissions, provider metadata shape and production preflight remain unverified by this non-production task; the first owner merge must pass those real gates before Wrangler can publish. A denied/unrecognized inventory is a safe stop requiring review, not evidence to rotate a working credential.

## Settings-schema investigation without production changes

When preflight stops at `settings-schema`, do not relax the allowlist or retry a
production run to discover the response. The read-only **Check Cloudflare
authentication (read only)** workflow can run against a pushed diagnostic branch
using its existing GitHub-held credential. Its settings read reports only bounded lowercase
schema field names and types. Credential-shaped/free-form keys, nested settings,
bindings and all values remain withheld. Unknown fields still stop production; this diagnostic
adds no accepted settings and no publish operation.

Run it from Actions → Check Cloudflare authentication (read only) → Run workflow,
select the diagnostic branch, then inspect the `settings-schema (names/types only)`
line. Use that evidence and the provider/Wrangler schema to implement and test an
explicit preservation mapping before approving another release. Local Cloudflare
credentials are separate from GitHub credentials; never rotate either to resolve
an unsupported response schema.

# Approved Gather application source integration

This is a source-only integration. It does not publish code, update Cloudflare settings, invoke AnyList sync, send messages or access/migrate production data.

## Source and boundaries

- Integration base: recovered main `ca8f74cde96b7f5a91555ba77e9a1ab240cf2b63`.
- Approved application: `925c25ad0f89b6deb85838ae36f13d168444b1d0`.
- Last restored live Worker: `2445780c-00a8-4be8-be81-64e450420038`.

The approved commit is already an ancestor of main. This integration explicitly restores its tree; an ordinary merge would leave the older application in place.

All files in `public/`, `server/`, `cloudflare/`, `test/` and `integrations/` match the approved commit, as do `package.json`, `package-lock.json`, `wrangler.jsonc`, `wrangler.gateway.jsonc`, the shared application scripts, README and existing application documentation. This includes all layouts, typography, toolbar/navigation controls, household/event appearance inheritance, Address Book, Family Workspace, cards, invitations, sign-in and RSVP behavior. No application file is redesigned or edited as part of integration.

The approved Worker configuration retains account `37d068144865a0b725ee272bc7b2eb71`, compatibility date `2026-10-30`, both `nodejs_compat` and `global_fetch_strictly_public`, `keep_vars: true`, the existing ASSETS/EVENTS_DATABASE bindings, unchanged `events-v1` migration definition and `*/5 * * * *` cron. Restoring this source file does not apply it to production. Gateway source/configuration is restored for completeness and local runtime regression coverage; the gateway must not be deployed.

## Intentionally retained operations files

These files remain byte-for-byte identical to integration base main:

- `.github/workflows/deploy-events-manual.yml`
- `.github/workflows/check-cloudflare-auth.yml`
- `.github/workflows/inspect-events-settings.yml`
- `.github/workflows/sync-meyer-anylist.yml`
- `.github/workflows/validate-manual-release.yml`
- `scripts/manual-events-release.mjs` and its test
- `scripts/cloudflare-metadata-check.mjs` and its test
- `docs/manual-events-release.md`

The manual release and AnyList driver retain the known-good `925c25ad0f89b6deb85838ae36f13d168444b1d0` application reference. The manual release's historical current-version guard is intentionally unchanged: it must stop until any future deployment receives a fresh review. No recovery or deployment workflow is dispatched during integration.

The approved `.github/workflows/validate.yml` is restored to exercise the complete application API, browser matrix and Cloudflare runtime tests. It runs only validation on PRs and main pushes, with read-only repository permissions. The separate manual-release safeguard validation also remains validation-only.

No `deploy-events-auto.yml`, `approved-worker-recovery.yml`, `verify-approved-worker.yml` or `pre67-inspection.yml` is included. The deploy, sync and read-only inspection workflows require explicit `workflow_dispatch`; no feature push, PR open/update/merge, schedule, workflow-run, reusable workflow or create event dispatches them. Validation jobs do not receive Cloudflare credentials or invoke a production publish command.

The owner confirmed external Cloudflare production/preview builds and the former GitHub automatic release workflow are disabled during recovery. This source-only task does not change that configuration. The former automatic workflow is also absent from current remote main and this integration. Existing closed temporary recovery PRs are not merged or reactivated.

## Comparison and local validation

Compare the complete application tree with the approved source:

```sh
git diff --exit-code 925c25ad0f89b6deb85838ae36f13d168444b1d0 -- public server cloudflare test integrations package.json package-lock.json wrangler.jsonc wrangler.gateway.jsonc scripts/build-copy-catalog.js scripts/prepare-household-routing.js
```

Use a checkout containing the approved source history for this one-time comparison. The only differences from the complete approved tree should be the retained operations files above, AGENTS.md's owner-controlled handoff policy, and this integration record.

Run Node.js 24 validation with synthetic isolated databases and no live fixtures:

```sh
npm ci
npm ci --ignore-scripts --prefix integrations/anylist
npm run format:check
npm test
npm run test:mobile
npm run test:cloudflare
node --test scripts/manual-events-release.test.mjs scripts/cloudflare-metadata-check.test.mjs
node --test integrations/anylist/reader.test.js integrations/anylist/writer.test.js
npx wrangler deploy --dry-run --name events --config wrangler.jsonc --outdir test-results/integration-worker-dry-run
```

A dry run bundles code locally; it is not a deployment or migration. Browser suites cover synthetic mobile and desktop workflows; they are not live production acceptance. Do not enable SMS or send real messages.

## Owner review and next task

Codex commits and pushes the integration feature branch. The owner creates, reviews and merges its PR after required validation succeeds. No release is expected from this merge. Do not run the manual release workflow or enable Cloudflare builds to merge it.

After the owner verifies the merged source, permanent automatic deployment can be designed in a separate task. Do not add or activate deployment automation in this integration. GitHub branch metadata currently reports main as unprotected; the owner should use required PR reviews/checks for review protection. This task does not change repository settings or claim branch protection has been enabled.

## Completed integration validation

Local Node.js 24 validation passed: 141 application/API tests, all 11 browser suites, 2 Cloudflare runtime checks, 10 manual-release/metadata safeguard tests, 6 AnyList transport/reconciliation tests, formatting and the events Worker dry-run bundle. Application parity comparison passed for all 110 files in the application/configuration/dependency/test scope above. All retained operations files match the recovered main base unchanged.

Browser checks exercised isolated phone and desktop scenarios for host/guest navigation, shared editors/defaults, household appearance inheritance, family permissions/collaboration, Address Book grouping, RSVP, Information pop-ups, full-page card/template editing/export, private accounts and mocked e-vite delivery. No production accounts, responses, messages, data migrations or Cloudflare writes were used. The Worker dry run exited without publishing.

Workflow trigger inspection and GitHub metadata confirm the integration restores validation-only PR/main CI, leaves all production operations behind explicit manual dispatch, and introduces no automatic or temporary recovery workflow. GitHub-hosted integration CI will run when the owner creates the PR; this handoff reports local results, not an uncreated PR's status.

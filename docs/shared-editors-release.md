# Shared editors release handoff

## Reviewed scope

Published branch: [`feat/shared-editors-cards-reminders`](https://github.com/kasstmaster/events/tree/feat/shared-editors-cards-reminders), implementation commit `6ee0c94`. Based on the latest recorded `feat/household-subdomains` commit `1ea6290b5d7dc9ae4e89c1237c17c4f2a160d0af`. PR #3's routing foundation is already in this branch; avoid replacing it with the older `main` tree. This release changes only `kasstmaster/events` and its existing application resources.

The requested implementation includes borderless icon navigation, combined event editing, upload links/deadline placement, scoped defaults/copy/roles/layout and read-only preview, one card/template renderer/editor with exports, phone contacts and private notes, disabled-by-default SMS scheduling and confirmed receipt-based account cleanup. See [operations and rollback](shared-editors.md).

## Validation performed locally

- 49 application/API/provisioning tests passed, including permissions, isolation, inheritance, snapshot ownership, QR, notes, uploads, reminder deduplication/STOP/signatures/timezones and deletion ownership/pagination.
- Original phone workflow and two-household phone/desktop routing suites passed.
- Shared editor browser suite passed: roles at 390px/1440px, event appearance, notes privacy, upload buttons, recipient preview, SVG/PNG downloads, quantity printing and read-only preview. Screenshots inspected locally in ignored `test-results/`.
- Actual local Cloudflare Worker/SQLite Durable Object suite passed.
- Formatting and whitespace checks passed.
- Both Worker dry-run bundles passed; production dependencies have zero audit findings.
- No real messages, real account deletions, paid services, production data writes or other-repository changes were used.

No separate lint/typecheck/frontend-build script exists; Node/browser execution, formatting and Worker bundling are the applicable checks. These are local results, not GitHub checks or live deployment verification.

## Access blocked in this execution environment

On 2026-11-01, `gh pr view 3 --repo kasstmaster/events --json state,headRefName,baseRefName` failed with `Post "https://api.github.com/graphql": Forbidden`. PR creation from this environment failed with the same GraphQL `Forbidden` response. The owner subsequently created [PR #4](https://github.com/kasstmaster/events/pull/4) from the signed-in environment; it remains unmerged/undeployed. The enforced managed network policy does not include `api.github.com` or Cloudflare API/dashboard domains. Environment observations report no Cloudflare identity, runtime secrets or deployment variables; `npx wrangler whoami` reports unauthenticated. A desired environment draft is not a ready credential.

The latest repository deployment inspection records production branch `feat/cloudflare-deployment`, Disable builds ON, previews OFF and validation-only GitHub Actions. This task explicitly authorizes publication, merge after required checks and deployment; it does not provide API access. Recheck live build controls and versions from the signed-in deployment environment before release. Do not enable automatic/preview builds as a workaround.

## Remaining release actions

1. In an authorized environment with GitHub API access and existing events-account deployment credentials, open a PR for this branch with the final scope and local validation. If using a stacked PR against `feat/household-subdomains`, preserve PR #3's routing foundation and record the intended final merge target. Do not accidentally deploy the older `main` implementation.
2. Wait for required GitHub checks; merge only on success, as authorized. Use the exact reviewed resulting commit.
3. Record live versions/recovery checkpoint and disabled build settings. Deploy only the existing events Worker using `npx wrangler deploy --name events --config wrangler.jsonc`, preserving current bindings, secrets, variables, cron and names. The gateway code is unchanged; no gateway deploy is needed.
4. Verify setup remains closed, sign-in/opaque links/QR and representative guest RSVP/editor flows work, custom-household routing still verifies, and unrelated existing websites retain their behavior. No fake live account, real deletion or message is a smoke test.
5. Keep SMS disabled. The Twilio sender/billing, encrypted credentials and signed webhook setup listed in the operations guide are a separate owner-approved provider task.

Never paste credentials into chat. No Node installation or server on the owner's Mac is required; use the existing remote deployment process. Do not label the feature deployed until the live verification above succeeds.

## PR #4 browser stall follow-up

The owner reported run `41257064511` timed out during the combined browser step after the original and household-routing suites passed; Cloudflare runtime was skipped. Direct CI log access here still returns GitHub API `Forbidden`, so the exact last CI operation cannot be independently established. The shared editor suite called native `window.print()` on its generated iframe, a blocking browser operation whose behavior differs across Chromium builds. Its test now intercepts that API in every frame and asserts one print invocation plus the two generated card copies. Application printing code is unchanged.

The browser suite now logs each stage, has a 150-second process watchdog including cleanup, and prints the failure stage before teardown. CI gives the three browser suites separate named steps; runtime checks still run after an ordinary earlier failure, and failed runs upload synthetic screenshots. The ten-minute job limit has not been increased. Locally the updated editor suite completes successfully using system Chromium. Installing Playwright's pinned Chromium here failed with `403 Domain forbidden` from `cdn.playwright.dev`; the matching CI-browser result must come from the new GitHub run. Do not claim this run passed until checked in GitHub.

## Visual defaults and complete formatting follow-up

The `fix/shared-formatting-controls` branch keeps the PR #4 application/routing foundation. Administrators edit platform defaults through synthetic visual examples with double-click selection, drag positioning and keyboard/touch move controls; individual household/event administration editors are removed and denied by the API. Shared wording/positions apply globally. Changing default formatting transactionally preserves existing household appearance; changing household formatting preserves existing events. Hosts retain one complete shared formatting editor in household/event settings, explicit formatting copy, confirmed color reset, private-note formatting, the combined Address book and confirmed event deletion inside Edit event.

Validated on Node.js 24: 50 application/API/provisioning tests, all three phone/desktop browser suites using system Chromium, the actual local Worker/SQLite suite, formatting/whitespace checks, both Worker bundle dry runs and a zero-finding production dependency audit. Browser checks include visual selection/dragging, existing-format preservation, toolbar/above-title/button/notes roles, reset cancellation/confirmation, event-copy controls, deletion cancellation, RSVP/privacy and card exports. Synthetic data only; no live messages, account deletion, gateway deployment or live data mutation.

Release must use the resulting reviewed merge commit. The deployment helper on `main` is still pinned to the previous release and must not be run as if it deploys this follow-up. Record a fresh events-only preflight/recovery checkpoint and retain existing bindings, variables, secrets, routes, cron and disabled SMS/production/preview builds. Direct authentication from this managed environment still fails with Cloudflare 6003/6111; no deployment of this follow-up or live acceptance verification is claimed here.

## Settings modes and event inheritance follow-up

Household page modes now live inside Settings: Light Mode, Dark Mode and Custom Colors Mode. Event Settings offers only Default Mode and Custom Colors Mode. Default events follow the full household design, including a custom home design; explicitly customized events retain their own formatting. Versioned household updates classify legacy default palettes conservatively and apply inheritance transactionally without changing event content, invitations or responses. Event Default Mode clears only appearance overrides.

Settings and Household Link and QR appear in every host page menu. Household Details fields render inline beneath all Settings actions/modes. Unsaved Details pause background adoption and require discard confirmation before navigation; Settings returns to the originating page and preserves card drafts. Potluck & drinks precedes invited guests. Container background opacity reaches zero independently from image opacity and text.

Release the resulting reviewed application merge through the exact-commit manual workflow; do not deploy the older application on main. Preserve runtime settings/bindings and disabled messaging/builds, record the current Worker version and recovery artifact before publishing, and distinguish synthetic acceptance tests from authenticated live verification.

## Completed household RSVP and input update

The completed application change is separated from the unfinished shared-account/card/e-vite/AnyList implementation. The completed branch preserves the existing sign-in, database schema, credentials, invitations and responses. It adds shared household grouping in Address Book/manual RSVP/dashboard, adult/child dashboard totals, right-aligned RSVP actions, readable editing fields and preserved event/card indentation, hidden child surnames with legacy-data retention, draft-preserving Address Book selection from event forms, Your Plans first, and host Settings toolbar Save/last Sign Out. Contact menus retain Invite/Uninvite through the existing versioned event endpoints. Household ID is a visible label change only.

Local verification: 122 API tests, both actual Cloudflare runtime tests, all seven browser suites (the six existing suites plus focused phone/desktop household checks), formatting and the events Worker dry-run bundle passed. Browser assertions follow the intended labels/navigation; coverage retains destructive confirmation, stale writes, data isolation, shared appearance editing, card exports, guest sign-in and RSVP. Synthetic isolated data only. Mobile/desktop dashboard screenshots were inspected.

The user authorized a PR and merge of the completed work, with unfinished work preserved on a separate continuation branch. This does not authorize deployment. Before publication, retain the existing build-safety gate and verify automatic production and preview builds remain disabled. No runtime settings, credentials, SMS flags, routes, cron, namespace, object names, gateway or other repository have been changed.

## Simple Information and guest presentation follow-up

This update keeps the existing account/sign-in/RSVP mechanisms. Information adds selected-word pop-up explanations immediately before Add link: validated bounded plain text, escaped labels/attributes/dialog contents, keyboard activation, edit/removal and read-only guest viewing. Links and pop-ups are exclusive on a text run. Your Plans now follows the RSVP action/registries and precedes optional event content, including single-container layouts. Family labels/errors use Username. Household invitation wording places the host name above INVITED YOU TO A NEW EVENT. Guest Home uses a dark page and the signed-in full name, with per-inviter card appearance projected as public design only. Notification/error backgrounds are transparent with readable page text.

New personal accounts, unified/private guest usernames and recovery, contact propagation, outbound AnyList and e-vites are not included. Preserve that work on the continuation branch. This follow-up has no database migration, provider activation or live guest-data mutation. Keep SMS and automatic/preview builds disabled and do not deploy the gateway or another site. Release must pin the reviewed application merge and check the current Worker/recovery checkpoint through the existing manual Events workflow.

Validation for this follow-up: 123 API tests, both Cloudflare runtime tests, all eight isolated browser suites, formatting and the events Worker dry-run bundle passed. Tests cover phone/desktop pop-up creation, persistence, editing/removal, keyboard activation, escaped content and guest activation without RSVP writes. Existing navigation, sign-in, household isolation, shared editing and card export checks passed. Live authenticated guest acceptance remains unverified; no production fixtures were created.

## Shared accounts, cards, e-vites and explicit AnyList reconciliation

This continuation completes the features described in [shared accounts and reconciliation](shared-accounts-preview.md). The owner authorized completion, PR, merge and deployment after the earlier checkpoint. Cards/templates use dedicated pages and the shared toolbar; guest accounts use private usernames/current address credentials; family profiles and reciprocal contacts respect selected sharing/blocking; registered matching is conservative; administrator renaming retains aliases and deletion proves all receipts before deleting any resource. Recipient-specific e-vites have missing-phone reports and limited resends. Explicit AnyList modes reconcile independent additions and preserve Gather's conflicting fields using revision checks, stable reservations, bounded writes and verified acknowledgements. SMS remains disabled.

Local verification on Node.js 24: `npm ci`, 140 API tests, all eleven browser suites, both actual Cloudflare runtime tests, six isolated AnyList protocol tests, formatting and the events-only dry-run bundle. The focused account browser suite additionally verifies code-qualified suffix selection, including deliberately choosing no suffix. The runtime browser test completes first-time username setup before the existing RSVP/privacy/persistence assertions. No checks are skipped or timeouts increased. CI runs browser groups separately within the existing limits. Card and guest-home screenshots were inspected.

The last successful deployed application before this release is `4086bcdd378b24d37692ace69433790603bcd233`, verified by manual run `42833803895`, active Worker `3046c37d-2fd5-4965-83e4-319ff0215ba4`. Its recovery artifact is `events-recovery-42833803895-1`; the next release must record a fresh checkpoint and stop if that Worker baseline changed. Pin the resulting reviewed application merge in both the manual deployment checks and the Events AnyList workflow on main. Do not deploy main's older application tree or rerun an old immutable deployment job expecting new code.

Preserve runtime settings, namespace/class/object names, routes, cron, secrets and stored data. Automatic/preview builds and SMS stay disabled. Do not deploy the gateway or touch another repository/site. Live AnyList writes, provider delivery/recovery, real account cleanup and new alias activation remain unverified; synthetic tests do not establish live provider acceptance. Deployment and authenticated live smoke results must be recorded separately after the new release actually runs.

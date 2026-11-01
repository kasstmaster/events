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

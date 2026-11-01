# Family workspace release handoff

## Scope and source

This release extends the `feat/household-subdomains` application after `ae782336cab30f3469e7f6b82915ce2b3a84f92e`. It adds permanent guest-code identities and approved shared invitations, household family accounts and child-specific permissions, shared lists, reviewed recipe import, private home documents, recurring chores and in-app reminders. Family logos, custom RSVP items and strict deadlines are included. The existing shared visual-default, formatting and card flows remain shared. See [operations and rollout](family-workspace.md).

Merge the application PR against `feat/household-subdomains`. The older `main` application tree is not a release candidate. After merge, a separate `main` operations PR must pin the manual workflow/helper to that resulting application SHA. Automatic production and preview builds remain disabled; no gateway or other website is deployed.

## Local validation

Node.js 24 with `npm ci`:

- 71 application/API/domain/provisioning/family/identity tests passed.
- All four phone/desktop browser suites passed, including existing QR/routing, scoped visual editing, card SVG/PNG/print, invite codes/suffixes, custom RSVP/deadline, household accounts, lists, recipe review, private downloads and assigned chores. Added connection-failure/browser checks separately passed: failed saves retain drafts, retry saves once, other devices receive it and polling resumes on reconnect.
- Actual local Cloudflare Worker/SQLite Durable Object suite passed, including restart persistence, guest auth/RSVP capacity and newly added member ACL, concurrent list items, chunked private document persistence and immediate download revocation.
- Formatting/whitespace checks and both Worker dry-run bundles passed; production dependency audit had zero findings. The gateway was bundled only, never deployed.

All fixtures were synthetic and isolated on loopback. No live accounts, messages, account deletion, private-data edits or other repository/resource changes were used. No separate lint/typecheck/frontend build script exists; Node/browser/runtime execution, formatting and Worker bundling are applicable checks. GitHub checks and live acceptance must be recorded separately.

## Deployment access and checkpoint

Last known successful existing manual release: run `41279587173`, application `ae782336cab30f3469e7f6b82915ce2b3a84f92e`, Worker version `952087e0-adc8-4f57-b941-5287237e5aea`. Its recovery artifact is retained in that run. This is a recorded baseline, not a fresh live preflight. A new release must refuse unexpected version drift and capture a new PITR checkpoint before publishing.

The current managed environment reports its Cloudflare network-secret binding ready, `api.cloudflare.com` allowed and proxy configured with the expected account ID. A fresh proxy-respecting verification of both user- and account-owned token endpoints fails HTTP 400 with Cloudflare 6003/6111; the actual Worker settings read fails 9106. These are malformed authentication failures before permission evaluation. The saved secret value is not readable here, so a wrong saved format cannot be distinguished conclusively from failed proxy substitution. No token, authorization header or raw diagnostics are exposed, and no proxy bypass is used. Do not claim a permissions-only problem or request token replacement without evidence.

Use the existing GitHub manual deployment credential/process after merging the new release pin. It performs fresh live account/binding/setup/version checks, saves recovery artifacts and verifies preserved configuration after publication. If workflow dispatch from this environment is still policy-denied, the smallest remaining action is to run **Deploy events manually** on **main** in GitHub Actions. No Mac installation or credential pasted into chat is required.

## Acceptance and recovery

Mandatory codes intentionally retire name-only guest sessions; original hosts privately distribute their own codes from the Address book. Host-selected matches do not grant access until code-authenticated guest approval. Undo retains records and restores the prior identity/code while revoking affected sessions. Existing links, QR, responses, private contacts, notes and content remain intact.

After deployment verify setup closed; existing sign-in/links/QR; code-qualified invitations/RSVP; family child access; formatting inheritance and card preview/export using existing authorized sessions. Do not create fake live users, send messages or delete live accounts. Until that happens, live interactive flows are unverified. Keep SMS, automatic production builds, previews, bindings, secrets, runtime variables, namespace/class/object names, routes and cron unchanged. Prefer a forward fix over pre-family authorization rollback; retain additive identity/member/owner/history tables and reserved codes.

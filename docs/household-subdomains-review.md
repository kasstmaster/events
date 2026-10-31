# Registration follow-up review

The current follow-up is not deployed. It removes independent domain selection and all host domain editing. `Dubois` generates `dubois`, `Raudman` generates `raudman`. The same shared normalizer runs in browser/server. Registration atomically claims the exact normalized name, rejecting occupied/reserved/retired/invalid names and preserving approval on failure. No suffixes/extra words, existing-claim renames, data backfill or opaque-link changes. The API rejects arbitrary registration overrides and domain-change attempts. Display names remain editable without changing the claim.

Automatic DNS/routing activation remains blocked by the missing deployed durable provisioner and runtime-scoped Cloudflare management credentials in both accounts (DNS/Routes in the domain account and controlled updates to full allowlists). Workstation OAuth is not a runtime credential and lacks DNS Edit. Claims stay pending; sharing/QR uses opaque links. See the architecture guide for exact missing integration, production changes and rollback. No settings or existing websites changed for this follow-up.

Follow-up validation: Node.js 24.22.1, `npm ci`, `npm test` 26/26, original phone/tablet/desktop suite and domain phone (390px)/desktop (1440px) suite, real local Cloudflare Worker/Durable Object suite, format and diff checks passed. The pinned CDN archive was invalid in this environment; the same pinned Chrome version 145.0.7632.6 Headless Shell was downloaded from official Google storage and used through `CHROMIUM_PATH`. All fixtures are isolated; no live account/guest/RSVP writes.

Publication gate: current browser is signed into the domain account, and the events-account dashboard returns “Page not found” / possible missing permission. Fresh production/preview-build inspection is therefore blocked. The prior verified settings had production builds disabled and preview branch builds off, but that historical result is not a fresh verification. No feature-branch push until read-only access is restored; source is locally committed and PR notes can be updated independently. GitHub workflow remains validation-only.

The following original review records the earlier implementation and publication snapshot; current behavior above supersedes editable registration/rename references below.

# Review: shared household subdomains

## Proposed pull request

**Title:** Add isolated household subdomains through an exact-host routing gateway

**Base:** `feat/cloudflare-deployment` at `b429b294df16114f83cab37ea539f03dd45bcffb` (verified production branch and prior code-build baseline; active dashboard version is `ff03b044`).

**Head:** `feat/household-subdomains`.

**State:** implemented/tested and approved for branch publication after read-only Cloudflare verification. Production branch is `feat/cloudflare-deployment`; `feat/household-subdomains` is distinct and did not exist remotely. **Builds for Preview branches is off.** Production **Disable builds is off**, so production auto-builds remain enabled for its own branch; no setting was changed. PRs run validation-only GitHub Actions. No merge, feature deployment, new live account, DNS/route change, secret change or data operation was performed.

## PR description prepared for publication

Registration now derives a non-editable address from the whole household name; hosts cannot change domains later. Exact provisioned hostnames open that household's personalized guest-login page using the existing shared frontend, authorization, RSVP code and database. Atomic claims prevent duplicate ownership; retired names stay reserved permanently. Existing opaque household links and QR codes keep working; newly generated sharing/QR links use the custom address after operator activation. Household login styles and event overrides remain independent.

A new stateless gateway in the `ilymmd.com` account proxies only exact allowed household hostnames to the verified events workers.dev origin. HMAC verification, short validity windows and mutation replay protection secure forwarding. Custom-host sessions are origin-bound and use host-only Secure cookies; setup/registration are canonical-only and cross-household requests fail closed. DNS/routes are provisioned per hostname, never by a new wildcard. The events Worker/account is pinned, and the existing `EVENTS_DATABASE` class/namespace/object-name architecture is retained. The PR includes an offline provisioning planner, refreshed README/security/AGENTS documentation, inventory evidence and the complete deployment/rollback procedure.

## Validation actually completed

- `npm ci` on Node.js 24.22.1.
- `npm test`: 24/24 passed, including original authorization/RSVP regressions and new claim/race/rename/gateway/provisioning tests.
- `npm run test:mobile`: original Node phone/tablet/desktop suite and the new actual gateway/Worker frontend tests passed. Both Raudman and Dubois **synthetic** household hostnames were tested at 390px and 1440px with sign-in, RSVP, assets, distinct branding, independent event appearance, Secure host-only browser cookies, household isolation and no horizontal overflow. Chosen registration names and later editing also passed. Every browser request used an isolated fixture; no real hosts/guests were used.
- `npm run test:cloudflare`: passed, including real local Worker/Durable Object storage, administrator setup, mobile flow, tenant isolation, racing claims and restart persistence.
- `npm run format:check` and `git diff --check`: passed.
- Application and gateway `wrangler deploy --dry-run`: bundled successfully; nothing uploaded/deployed.

Browser suites used `CHROMIUM_PATH` pointing to the official Chromium Headless Shell 141 download, because the pinned browser download returned invalid content. CI should use the pinned Playwright browser. The Cloudflare test child has a loopback-only fallback for this executor's unsupported OS interface enumeration; it does not change production behavior or network permissions.

## Exact proposed production changes

Only after separate owner approval of the published/reviewed commit:

1. Deploy the reviewed application to existing `events` in account `37d068144865a0b725ee272bc7b2eb71`, retaining its verified existing `EVENTS_DATABASE` binding/namespace, `EventsDatabase` class and `events-platform-v1` object. No live record migration/reset/import. Additive metadata tables initialize in that same store.
2. Create the new stateless `events-household-gateway` Worker in domain account `e8cdf5b38fa02d2d1b7f30f2389888b7`. Keep its workers.dev/preview URLs disabled. No bindings to gatherings resources.
3. Securely configure one new `EVENTS_GATEWAY_SECRET` on the two events components, plus exact `EVENTS_ORIGIN` and operator-maintained `HOUSEHOLD_HOSTS`; preserve all other variables/secrets/settings.
4. After the genuine hosts claim their chosen labels, add only absent proxied AAAA `100::` records and exact routes for `theraudmans.ilymmd.com/*` and `thedubois.ilymmd.com/*` to the new gateway. Nothing is preclaimed for real households. Preserve all other DNS/routes/custom domains/Workers, especially `themeyers.ilymmd.com`, `curly-sun-ef0f` and gatherings resources.
5. Verify actual public cross-account Fetch, DNS/TLS, correct login pages/assets, authorization/CSRF/cookies, stable links and unchanged existing sites before reporting activation. No fake live registrations or RSVPs. Keep preview builds disabled and do not alter the currently enabled production trigger without separate approval.

## Verified publication evidence and remaining release checks

The signed-in events account is now accessible. Read-only Settings confirms the repository, production branch/build commands, preview builds off and no Deploy Hooks. Active deployment `ff03b044` is at 100% traffic and reflects removal of `ADMIN_SETUP_TOKEN`; the earlier code-build version `5333b596` links to baseline SHA `b429b294df16114f83cab37ea539f03dd45bcffb`. Overview confirms `EVENTS_DATABASE` uses namespace `8203f4cd7fde45d2ab49de62e239d744` (`events_EventsDatabase`) and `ASSETS` is present separately. No custom domains/routes exist on this Worker. None of these settings, resources or secrets were modified.

The build API token selector says **Configured API token unavailable**. This is a future deployment credential check, not the publication safety mechanism. Do not rotate/recreate it in this PR. Wrangler is still unauthenticated locally. A release must recheck the active deployment's full identity, setup-closed status without creating an administrator, namespace/class/object mapping, recovery checkpoint, actual public cross-account Fetch, DNS/TLS and account limits. Local tests do not establish those live deployment properties. The [architecture and rollout guide](household-subdomains.md) contains the complete procedure, concrete alternative and rollback/partial-failure plan.

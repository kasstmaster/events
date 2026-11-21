# Host-owned invitations: staged implementation

This branch implements the first functional part of the consolidated owner ticket.
**It is not a completed guest-account retirement or production-ready cutover.**
The existing website design remains authoritative. No CSS, shared visual component,
theme default, Worker adapter, database schema/migration, live configuration or
production data is changed.

## Implemented and disabled by default

- `PUBLIC_INVITATIONS_ENABLED=true` enables synthetic/local testing of public event
  pages and scoped RSVP capabilities. It is not configured in Wrangler or CI's
  production deployment environment. Do not enable it in production yet.
- Hosts can prepare `/api/host/events/:id/public-invitation` with POST and the event
  `version`. The authenticated household, not request data, determines ownership.
  It returns a stable `/event/:reference` and recipient Household IDs.
- Household IDs contain 128 random bits and are stable per inviting host/address
  (or unattached adult). Existing short codes are neither reused nor overwritten.
  Independent host books get independent credentials. Existing printed short codes
  need a reviewed reissuance plan before retiring legacy access.
- Public GET `/api/public/events/:reference` returns an explicit public field
  allowlist, aggregate counts and the existing appearance configuration. It does
  not return the invitation roster, private notes, accounts or response records.
  It ignores existing host/guest cookies: visiting another host's invitation does
  not grant management access. Household-host routing still scopes the reference.
- POST `.../access` accepts the Household ID and issues an event/host/recipient-bound
  30-minute bearer capability. The browser retains it only in memory; it is not a
  login, cookie or URL credential. Invalid lookups use a uniform failure and peer/
  event rate limits. Refresh requires ID entry again, not sign-in.
- PUT `.../rsvp` uses the existing transactional address RSVP engine. Only invited
  household members are returned. Versions, menu limits, deadlines, partial answers
  and uninviting checks remain enforced. Successful submission returns to the event.
- The same approved event renderer and full-page RSVP form serve this new path.
  No guest Home, account settings or sign-in UI is rendered on `/event/:reference`.
- The shared QR-card endpoint, when the public flag is enabled, uses the direct
  event link, prints a strong Household ID and the selected household's invited
  names, including invited children. Invitation and enclosure print separately.
  The existing flag-off renderer and print behavior remain unchanged.

`HOST_SIGNUP_INVITATIONS_ENABLED=true` separately stages email/password onboarding:

- POST `/api/admin/host-signup-invitations` requires current system administrator
  authority and password confirmation. It issues an email-bound, one-time,
  24-hour signup URL and a restricted audit event. Ordinary hosts cannot issue it.
- A signup URL alone cannot register an account. POST `/api/host-signup/email`
  requires an explicitly supplied server verification-mail transport. No production
  transport is configured; absent transport returns 503 and creates no account.
- The verification token is delivered only through that transport, not returned
  by the API. Tokens are hashed at rest, expire after ten minutes, are single-use
  and require the original device's separate HttpOnly binding cookie.
- Completion uses the existing registration/domain allocator, atomically consumes
  the proof/invitation and stores only a password hash. No standing legacy approval
  is created when a signup URL is issued. Direct legacy registration is denied
  while this flag is on. Both flags remain absent/off in normal operation.
- The resulting host device session reuses persistent, rotating, origin-bound
  session infrastructure. Current account/password/membership/deletion checks are
  re-evaluated; a password/security change invalidates its proof. Administrator
  elevation remains restricted. No Firebase, SMS or event delivery is involved.

The signup API is tested with an injected **mock mail sender**, not a real email
provider. Registration UI, Google verification/consent, production mail integration,
password recovery and cross-subdomain host handoff are not finished. Do not activate
this signup flag before those pieces and their browser tests are complete.

## Address Book cutover preparation

`server/recipient-isolation.js` provides a low-level, explicit, fingerprint-checked
checkpoint/preparation operation. Nothing invokes it on startup or production.
It snapshots contacts, addresses, managed-contact associations and historical
identity links, then writes an additive host-owned policy marker. Existing guest,
address, identity, event and RSVP IDs/rows are preserved. A stale checkpoint rejects
atomically; repeated preparation is idempotent.

For prepared synthetic households, matching and personal-profile propagation stop,
shared invitation authority excludes their records, local contact projection uses
strong recipient IDs, and host Home excludes received invitations. Historical
links remain available for recovery rather than being deleted. This is not a
complete global legacy-auth retirement: complete all remaining authorization and
migration-path audits before exposing a production cutover control.

Rollback preparation requires reviewing local edits since the checkpoint. Never
blindly restore an old snapshot or re-enable cross-host propagation. Ordinary source
rollback needs no schema reversal; retain additive records and saved responses.

## Wedding reference and remaining implementation

Read-only inspection of `kasstmaster/themeyersgatherings` found:

- `data/app-state.json`, blob `22277514d0a3792f11112d3cde6556025f1959ad`.
- Its wedding object has event/address/RSVP-date and registry fields, but no saved
  wedding-party members, member pages, roles or responsibilities. Accounts and RSVP
  arrays in that checked-in state are empty. Do not invent the missing content.
- `wedding-party.js` defines member pages and responsibilities handling, but source
  code defining a data model is not evidence of the currently saved member content.

No wedding content, guest list or RSVPs have been imported. A complete authoritative
saved-content export and identification of the existing target household/event are
still needed for a reviewed idempotent import. Private per-member grants, protected
page delivery/editing and the extra event-page buttons remain to be implemented;
a shared Household ID must never authorize these private pages.

Other code still needed in this same feature workstream:

1. Finish host-only Google/email UI and verified-provider integration; explicit
   approved adult host memberships, recovery and origin handoff regressions.
2. Complete global retirement of legacy guest sign-in/session/recovery/inbox/PWA
   routes and UI, while preserving historical data and active host permissions.
3. Audit all import, matching, linking and authorization paths, then provide a
   confirmed, audited, recoverable Address Book cutover and short-code reissuance.
4. Complete explicit +1 modeling/rendering, credential revocation controls, card
   pagination for unusually large households, and signup-management UI.
5. Finish the consolidated admin, children/batch editing, settings/logo/PWA,
   workspace/navigation and wedding-specific gaps without restyling existing pages.

These are implementation tasks, not a request for the owner to write code. No
production activation should be attempted until the core replacement is complete.

## Validation

Run `npm test`, `npm run test:mobile`, `npm run test:cloudflare`, and
`npm run format:check`. New API tests cover default-off behavior, contact isolation,
recipient guessing, cross-host/event misuse, children, stale response conflicts,
uninviting, QR routing and independent signup verification. New browser tests cover
390/768/1366px full-page no-login RSVP. The approved-design browser test compares
complete synthetic Home/Event/Address Book screenshots byte-for-byte with approved
main assets at 390/1366px. CI fetches history for that test baseline only.

Legacy offline suites remain compatibility regressions during staging. Passing
local tests does not prove production migration or live provider behavior. This
branch does not activate, deploy, send real messages or modify provider settings.

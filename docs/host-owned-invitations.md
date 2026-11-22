# Host-owned invitations and host-only authentication

The consolidated owner ticket supersedes the old central guest-account and
Firebase/SMS plan. This branch implements the replacement behind **two default-off
flags**. No production activation, provider configuration, live mail, import or
migration has been performed. The approved website design remains authoritative;
no global CSS, theme defaults, Worker adapter, database schema or migration changes
are required.

## Activation boundary

Both `HOST_ONLY_MODEL_ENABLED=true` and
`HOST_ONLY_MODEL_ACTIVATION_APPROVED=true` are required. Neither is configured in
Wrangler or production deployment settings. Do not enable the replacement until
the reviewed transition, real provider acceptance and printed-ID reissuance are
complete. The older `PUBLIC_INVITATIONS_ENABLED` and
`HOST_SIGNUP_INVITATIONS_ENABLED` remain isolated test/staging switches; they are
not substitutes for a complete cutover. Default-off legacy behavior remains for
recovery, with historical records intact.

## Host authentication and administration

- Only hosts sign in and have Home pages. Home lists owned events only. Visiting
  another host's public event never grants management rights or adds it to Home.
- A password-confirmed system administrator issues an email-bound, one-use,
  24-hour registration URL. Email ownership must be independently verified by
  Google or a ten-minute, browser-bound verification email. URLs alone never grant
  host authority. New households use the existing permanent domain allocator.
- An existing household may have additional explicitly approved adult hosts.
  Invitations can name an existing adult roster entry without duplicating it or
  losing workspace assignments. Name/address similarity and child membership never
  confer host privileges. No global recipient account is created.
- Google uses fixed endpoints, PKCE, state, nonce and actual RS256/JWKS verification
  including issuer, audience, expiry and verified email. Existing password accounts
  cannot be claimed through matching Google email. Connecting Google requires the
  existing host's password/session; platform administrators use separate password
  authentication.
- Persistent rotating HttpOnly origin-bound device sessions reuse Gather's existing
  revocation and single-use cross-origin handoff. Only current authorized household
  destinations are allowed. Password recovery/changes, disabling and revocation
  invalidate affected sessions immediately. Administrator elevation expires after
  15 minutes independently of an ordinary remembered host session.
- Account Settings support password change, verified recovery, explicit Google
  connection/disconnection and other/all-device sign-out. Google-only users must
  establish a password through verified email recovery before disconnecting Google.
- The full-page administrator directory supports search/sort, household/member
  inspection, confirmed identity/domain edits, host access disable/restore, account
  recovery and session revocation. Registration links can be listed and revoked.
  Sensitive operations require current administrator password and restricted audits.
  Existing guarded household deletion/routing/recovery remain authoritative.

### Provider prerequisites (not configured by this branch)

Google requires a Web OAuth client with callback
`https://gather.ilymmd.com/api/host-auth/google/callback`, and Worker secrets
`HOST_GOOGLE_CLIENT_ID` and `HOST_GOOGLE_CLIENT_SECRET`. All Google verification is
central; approved household domains use the existing browser-bound session
handoff and need no individual Google redirect registrations. Local tests use
loopback callbacks and synthetic signed identity responses only.

The optional account-only Resend adapter requires `HOST_EMAIL_ENABLED=true`,
`HOST_EMAIL_API_KEY` (secret), and `HOST_EMAIL_FROM` (verified sender address).
The sender must belong to a provider-verified domain. Email is only for ownership
verification/password recovery, never invitations, RSVP confirmations, reminders
or upgrades. No provider purchase, cost commitment, credential setup or live send
has occurred. Confirm provider costs/limits and perform separately authorized real
mail/Google acceptance before activation. Missing configuration fails closed.

## Independent Address Books and recoverable transition

Each inviting host owns its contacts, addresses, notes, recipient IDs and responses.
Prepared books never match, link or propagate information across hosts. Historical
central identities and links are retained, not used for new authority.

The administrator registration screen includes a **reviewed transition** control:
`POST /api/admin/host-transition` first previews a complete fingerprinted plan.
Preparation requires that fingerprint, current password, explicit adult user
approvals and `PREPARE HOST-ONLY TRANSITION`. It atomically snapshots Address Book
contacts/addresses/managed relationships/historical links, prepares host-local
policy/roster records and event references, reserves strong recipient IDs and
revokes unapproved access. Stale plans fail without partial writes. Nothing runs at
startup; preparing records does not enable the replacement flags.

IDs for policy/checkpoint/roster records include the tenant because the shared
record primary key is globally `(kind,id)`. Existing guest, event, address,
workspace, invitation and RSVP IDs and all migration history are preserved.
Existing roster person IDs preserve host-family RSVP participation.

Before a separately authorized cutover:

1. Retain the existing approved deployment recovery checkpoint/artifact and review
   current runtime/binding/database identity through the normal release safeguards.
2. Review the transition plan against current households and explicitly approve
   adult managers. Prepare using the same unchanged fingerprint.
3. Review each strong recipient ID and reissue unsafe old printed four-digit
   credentials. Existing short codes remain historical, not valid replacement IDs.
4. Validate actual Google/email and native-device behavior, then separately approve
   flag activation. No source task authorizes these production operations.

Rollback retains additive records and response history. Review post-checkpoint
local edits before any recovery; never blindly overwrite current contacts or
reenable cross-host propagation. No reverse schema migration is needed.

## Public events, RSVP and cards

- `/event/:reference` and existing preserved invitation references open the shared
  event renderer directly without guest sign-in, cookies or a Home page. Public
  projections contain only allowed event content, appearance and aggregate totals.
- RSVP asks for a stable, printable **128-bit host-local Household ID**, shared by
  the explicitly assigned recipient household. Scoped, rate-limited lookups return
  only that household's invited adults/children and explicit +1 indicators.
- A 30-minute in-memory bearer capability is host/event/recipient bound. The shared
  full-page transactional RSVP engine retains deadlines, versions, partial answers,
  menu capacity, uninvite checks and per-person answers. Submission returns to the
  event; refreshing requires ID entry again, never an account or SMS.
- Host-family attending responses still count only toward attendance. Guests cannot
  use recipient IDs to obtain host permissions, notes or unrelated responses.
- Hosts can inspect, revoke or rotate a recipient ID. Rotation invalidates old
  capabilities immediately and requires sharing the new printed ID manually.
- Ordinary invitation and QR enclosure are separate pages. Only the enclosure has
  the direct event QR, Household ID and all invited names/+1 labels. Long households
  paginate without clipping; the ordinary invitation is not duplicated. Shared
  card preview/download/print/manual sharing and saved designs remain in use.
- Contact children use name, suffix and shared address with Add Another/batch
  editing. Own family Settings initially lists read-only people with explicit Edit;
  its local roster never creates guest accounts or cross-host links. Explicit
  optional Family Workspace access remains separately permission-limited.

## Private pages and existing wedding content

Hosts manage event pages full-page through the existing Information editor,
Save/Cancel, safe links/pop-up text/images and existing shared toolbar controls.
Public page buttons appear immediately after RSVP. Role/member page titles and
content require independent **256-bit**, hashed, expiring, revocable individual
links. A shared Household ID or RSVP capability never authorizes private pages.
Current invitation/host-family membership, role and revocation are checked on every
read. Secrets are removed from fragments immediately, retained only in memory,
and excluded from ordinary logs and storage. Archived pages retain history.

The administrator import screen accepts a normalized complete saved-content export
with schema `1`, repository `kasstmaster/themeyersgatherings`, full `sourceCommit`,
`authoritative:true`, and the real `pages` and `members` arrays. Each member must
be explicitly mapped to an existing invited contact or host-family person. Pages
use the same `title`, `content` Information runs, `image`, `audience`
(`public`, `roles`, `members`), `roles` and `members` fields as the shared page API.
Source member IDs are mapped explicitly, never by name. Preview returns a
fingerprint; apply requires the same fingerprint, password and typed confirmation.
Source account/phone/private-link fields and old guest/RSVP records are excluded.
The existing destination event remains the destination; no duplicate wedding is
created. Import archives content, records the source/mapping fingerprint, is
idempotent, and refuses overwriting later local edits. Hosts then issue new private
links manually through the shared page manager.

**Authoritative source blocker:** read-only inspection of checked-in
`data/app-state.json` (previously recorded blob
`22277514d0a3792f11112d3cde6556025f1959ad`) and a fresh read during this session
found event/address/registry fields but no saved wedding-party members, roles,
responsibilities or individual pages. `wedding-party.js` defines the model but is
not saved-content evidence. A complete actual saved-content export plus the
existing Gather destination household/event is required. No wedding content,
accounts, old guest list or RSVPs were imported, and nothing was fabricated.

## Retirement, settings and appearance

In replacement mode old guest/Firebase/SMS/private-account/recovery/matching/linking
APIs cannot authenticate or authorize; old guest cookies are ignored and virtual
central-host identities are rejected. Old guest pages show neutral event-link
instructions, not forms/inboxes. Explicit Family Workspace members retain only
that access; children never obtain host/Address Book authority. Offline legacy
tests remain recovery regressions; the real-Firebase harness command now refuses
provider testing. Both production Firebase activation flags remain unchanged/off.
Old outbound event messaging remains disabled even if obsolete SMS flags are set.

Native host metadata uses the household logo for favicon/PWA icons with versioned
cache invalidation and fallback. Visitors get no PWA manifest/registration; the known Gather service worker is
unregistered for guest/signed-out views without clearing account credentials. Settings
remain standard light/dark, not custom; appearance controls precede other settings.
Event settings reuse existing fields with primary section actions and confirmed
Delete, avoiding duplicate Invite controls. Workspace Create defaults to its current
section and filters folders; the main workspace retains its type chooser. No
unrelated layouts, CSS, fonts, colors, spacing or shared theme defaults changed.

## Validation and remaining external acceptance

Run `npm test`, `npm run test:mobile`, `npm run test:cloudflare`, formatting, Worker
dry-run and release-safety tests. New tests cover native host authentication,
actual signed Google claims with synthetic transport, explicit adults/child denial,
recovery/revocation, origin handoff, isolation, private pages, +1/large cards,
administrator restrictions and owner-reviewed wedding import. New native browser
journeys cover 390/768/1366px. Approved Home/Event/Address Book screenshots are
compared pixel-for-pixel against approved main assets at phone/desktop sizes.

Verified in this checkout: 235 application tests, all 23 browser entry points,
four actual local Cloudflare/runtime checks, 56 release-safety tests, six AnyList
tests, formatting and a Worker dry-run. Approved-main pixel comparisons passed
for Home, Event and Address Book at 390px and 1366px. A further 38 targeted
application regressions and two asset/runtime checks passed after the final
wording-catalog and host-PWA changes. All provider transport remained synthetic.

Passing automated tests does not verify real provider delivery, native Safari/iOS/
Android installation, or production migration. Those separately authorized checks
and the missing authoritative wedding export remain required before activation.
Codex validates, commits and pushes this branch; the owner creates/reviews/merges
its PR. No deployment or live settings/data/provider operation is authorized here.

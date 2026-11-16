# Ticket 01 — Firebase phone sign-in and recovery

This supersedes the Twilio magic-link plan for normal hosts and guests. PR #87's
persistent Gather device sessions remain the authorization layer. Source starts
from main `0b2319e` (PR #87); no production setting or stored record is migrated.

## Implemented boundaries

The existing First Name, Last Name and Phone Number fields now lead to a six-digit
Firebase SMS code when Firebase is separately activated. Firebase Web SDK 12.6.0
loads lazily from Google's HTTPS CDN after an explicit request, uses reCAPTCHA and
in-memory SDK credentials, then signs out of the SDK after verification. SMS codes
and Firebase ID/refresh tokens are never stored in Gather's database, web storage,
URLs, ordinary logs or administrator queue. Only replay-prevention hashes persist.

The shared server verifies RS256 against Google's fixed Secure Token JWKS endpoint,
exact project/issuer/audience, phone sign-in provider, phone identity, expiration
and an authentication time within five minutes. It also checks the Firebase
accounts lookup endpoint for disabled accounts, changed phones and revoked tokens.
Unknown signatures, stale tokens, lookup/network failures and ambiguity fail closed.
No caller-selected verifier, issuer, key URL or emulator bypass exists in production.

A verified phone is necessary, not sufficient: an existing person requires one
unambiguous, independently verified authoritative central phone/name association.
Firebase UID bindings cannot claim a second person or replace an existing/revoked
binding. Household IDs and typed phones never prove ownership. Existing host roles
still derive from approved registration/verified adult membership, not Firebase.
Invited hosts get guest authority in the inviter's app. Children are not silently
enrolled or upgraded by this host/guest migration; preserve their approved legacy
access and membership restrictions during staging.

New adult invitees may self-enroll only with an active recipient QR reference,
fresh phone verification and an exact, unambiguous invited contact. This creates
only their own new central profile, never copies another adult, claims an existing
registered profile, merges identities or grants hosting. An approved new household
owner can use Settings → Set up phone sign-in from their existing authenticated
registration session to enroll only their own previously unverified phone. Existing
verified numbers cannot be replaced through that path. Ambiguous/old unverified
registered accounts use independent recovery rather than automatic claiming.

Gather issues secure, host-only, HttpOnly, SameSite=Strict persistent cookies.
No idle expiry: closing/restarting a browser/PWA or returning months later normally
requires no additional SMS. Credentials rotate during use; current authority and
Firebase mapping versions are checked on protected operations, including origin
handoffs. Sign Out is per device; other/all-device revocation stays available.
Security changes/recovery revoke affected sessions and mappings. All-device sign-out
also prevents pre-revocation Firebase authentication proofs from minting new sessions.
Strong system-administrator password login, fresh step-up and restricted audits stay
independent of phone possession. Browser/OS deletion and separate Safari/PWA storage
containers can still require a new sign-in. No universal native-app-opening promise.

## Recovery queue

Recover Account collects First Name, Last Name and four-digit Household ID. Matching
and nonmatching requests receive the same receipt. These are lookup hints only.
The private Administration → Account Recovery queue requires a current system-admin
password for every read/action. It shows bounded recent requests, status/time,
authoritative account details and actual linked host-household names/contact methods.
It never includes host notes, entire Address Books, unrelated people or Firebase codes.

The administrator records independent identity review. A host statement alone never
authorizes recovery. Authorization immediately revokes affected access and creates a
single-use, 30-minute enrollment link to deliver personally after that review. Its
random secret is stored only as a hash and is removed from browser history on entry.
The replacement phone must still pass fresh Firebase verification; only then are
central phone data and approved contact propagation updated. The account identity,
Household ID, memberships, invitations and RSVP history stay intact. Completion clears
the grant and writes a non-secret audit. Failed writes roll back atomically.

## Outbound messaging removal and migration fallback

Event SMS schedules, e-vite sending/media, RSVP confirmation texts, username SMS
recovery, phone-verification reminders and host-requested private-link delivery are
retired from application UI/API/queue/scheduler paths. Former routes return 410.
No existing schedules/delivery records or other historical data are deleted. Signed
historical provider receipts and STOP suppression remain readable/updateable; they
cannot enqueue sends. Manual invitations, in-app invitations, card SVG/PNG/print/share,
recipient-named QR cards and private guest pages remain. Family Workspace in-app
notifications are unchanged. No SMS/email invitation or reminder delivery is enabled.

Legacy passwords and existing sessions remain usable. The custom login token/outbox
is retained solely for controlled migration fallback, not normal Firebase login.
Once Firebase is active, custom SMS start and dispatch are disabled unless the owner
explicitly approves `LEGACY_SMS_FALLBACK_APPROVED=true`. The alarm invokes legacy login
delivery only with that fallback flag; it never dispatches event/account notifications.
Keep fallback off unless specifically needed for recovery. Do not remove the old
login implementation/records until owner-approved Firebase and real-device acceptance.
Never enable `SMS_ENABLED` to activate Firebase; no Twilio Verify is added.

## Owner configuration — not performed by Codex

1. Review/merge the feature branch and let existing guarded release automation deploy
   source **with Firebase activation flags absent/false**. Verify legacy access first.
   Keep Cloudflare Git builds/previews disabled and keep existing Worker/SQLite identity,
   routes, secrets, cron, flags and all production records.
2. In the owner's existing chosen Firebase project, register a Web app and review
   Authentication → Sign-in method → Phone. Enabling Phone, SMS regions or billing
   requires a separate owner decision. No Firebase project or paid plan was created.
3. Review Authentication → Settings → Authorized domains: include `gather.ilymmd.com`,
   the canonical Events hostname if it will offer verification, and each active host
   hostname used for direct phone verification. Do not authorize arbitrary domains,
   previews or wildcards. Gather's branded universal entry and signed origin handoff
   remain available. Add future direct-verification hostnames through reviewed setup.
4. Record the Web app's **public configuration**, not service-account credentials:
   `FIREBASE_PROJECT_ID`, `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN` (exactly
   `<project-id>.firebaseapp.com`). The API key is public Web configuration, not an
   administrator secret. Google API restrictions must permit Identity Toolkit and
   Secure Token. A browser-referrer-only key cannot serve the server's accounts lookup;
   resolve that configuration securely before activation. Never paste private keys,
   service accounts, SMS codes or ID/refresh tokens into chat or repository files.
5. Configure Firebase test phone numbers/codes and test reCAPTCHA with authorized
   domains. These avoid real SMS charges. Current automated tests mock Firebase SDK
   transport and use locally signed synthetic tokens/JWKS/account lookup; they do not
   contact Firebase or require the Auth emulator. Emulator unsigned tokens are not
   accepted by the production verifier. No production test bypass flag is supplied.
6. Separately approve `FIREBASE_AUTH_ENABLED=true` AND
   `FIREBASE_ACTIVATION_APPROVED=true`. Existing `GATHER_UNIVERSAL_ENABLED`,
   `GATHER_DOMAIN_APPROVED`, `GATHER_PWA_ENABLED` remain separate existing routing/PWA
   approvals; this source change activates none of them. Missing flags are false.
   Keep `SMS_ENABLED=false`, `AUTH_SMS_ENABLED=false` and legacy fallback off normally.
   Preserve the strong administrator login and legacy passwords during acceptance.
7. Test known existing accounts and authorized new invitees with Firebase test numbers
   before approving any real SMS. Review unmatched legacy records privately; do not
   backfill or auto-claim central accounts. Roll back activation flags if verification
   is unavailable; preserve additive mapping/session/recovery records and data.

## Abuse controls, quotas and costs

Gather allows at most one code-start per phone per minute, five per phone per hour,
ten per IP per 15 minutes; five server verification attempts per browser challenge,
twenty per IP per 15 minutes; recovery has five requests per IP/hour and three per
normalized lookup hint/hour. Login challenge lifetime is ten minutes. Limits and
non-secret security audits provide request monitoring. There is **no global daily
10-text cap**. Expired challenge/replay records are cleaned on new requests.

Firebase independently enforces app verification, project/number/IP quotas and SMS
region policy. Rates/free allowances vary by region, plan and Google's current
terms. No free allowance or permanent zero-cost operation is assumed. Real SMS can
require billing and incur charges; owner must check the current project console,
[pricing](https://firebase.google.com/pricing) and
[Authentication limits](https://firebase.google.com/docs/auth/limits) before activation.
Current live pricing/allowances could not be fetched from this restricted workspace;
no numeric price or unverified quota is promised. Application limits are not a billing
ceiling and cannot stop direct requests outside Gather. Review region restrictions,
provider quotas and billing alerts; alerts themselves are not a hard spending limit.
Remembered devices reduce repeat authentication SMS, not the cost of initial/recovery SMS.

## Remaining live acceptance

No native iOS/Android/Safari/PWA or live Firebase project was exercised. With approved
test numbers verify reCAPTCHA/code delivery, account association, independent new
invitee enrollment, inviter QR authorization, separate installed-app containers and
browser fallback, app/browser/device restarts, one-device/all-device sign-out,
current membership removal, administrator recovery and replacement-number verification.
Check host/guest roles and mobile/desktop approved appearance. No real SMS, production
account changes, DNS, billing activation or manual deployment is authorized by local tests.

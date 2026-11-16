# Passwordless Gather: implementation and staged activation

This branch starts at approved main `70ee1c8cd6f3230fb25d207cadab1f39a6b1408d` (PR #83). It preserves the shared application and existing data. No production configuration, credentials, DNS, SMS service, Worker deployment, database migration, account or RSVP is changed by preparing this branch.

## What is implemented

- One shared First Name / Last Name / Phone Number form, shown only after explicit passwordless activation. Unknown, ambiguous, unverified, suppressed and otherwise ineligible matches receive the same response. Public requests cannot create or claim accounts. A branded entry retains its inviting-household context; an invitation reference opens the authorized event after authentication. Matching uses central profiles, reviewed authoritative memberships and registered central account information, never a host's editable Address Book phone as proof.
- Existing independently verified recovery phones can qualify. Administrators can enroll another registered phone through Registered Accounts, after their current password, independent verification and security-text authorization. This restricted enrollment control is available before activating normal passwordless sign-in. It sends no messages. Missing name/phone records must be corrected through the existing restricted account editor first.
- A token-free authentication outbox uses the existing Twilio transport and existing EventsDatabase alarm. A fresh 256-bit token is generated in memory only when attempting delivery; only its hash is saved. Links expire within ten minutes of the original request, are single-use and bound to an HttpOnly browser cookie and the exact HTTPS origin. Reservations are transactional, delivery attempts are one-shot, and uncertain outcomes never trigger an automatic resend. Rate limits, a global request bound, cooldowns, STOP suppression and send-time contact verification apply.
- The SMS URL uses a fragment. A small first-loaded module removes authentication/handoff fragments from the address bar and history entry and retains them only in module memory until redemption. Neither tokens nor message bodies are saved in web storage, manifests, cards, ordinary logs or the database. Link possession alone cannot authenticate a different browser.
- Existing identity/session tables and roles are reused. Phone changes invalidate eligibility and related sessions. Users can revoke other authorized sessions. SMS-authenticated administrators are signed in with restricted authority: system administration requires a separate password step-up, including for promoted host administrators. Sensitive administration still uses the existing fresh-password controls and audit logs. The legacy strong administrator recovery route is retained.
- Existing household URLs remain separate applications. Their sign-in form uses their current shared appearance data. `gather` remains reserved. Approved universal routing identifies no household: `gather.ilymmd.com` uses Gather branding and `gather.ilymmd.com/<registered-label>` is a branded entry into the same universal app. Only active, owned labels/aliases qualify. Pending, unavailable and retired claims cannot impersonate an entry page.
- Universal guest Home uses Gather branding and all authorized cross-household invitations. Host Home retains owned events plus received invitations; opening a received invitation uses the shared event/RSVP flow and cannot grant management rights in the inviter's household.
- Dynamic app manifests, icons/favicon links, standalone scope/start URLs and a network-only service worker support installation. Household apps use their own name and uploaded logo; universal guest entry uses Gather branding. Private pages, API responses and media are not cached offline. An offline page contains no household data. Existing raster logos retain their actual media type rather than being mislabeled as PNG.
- Cross-origin handoff first sets a proof cookie in the destination browser, then authorizes a single-use, 60-second transfer from the signed-in source. Source session, contact proof, target origin and target browser are checked again before minting an origin-bound session. No Domain cookies, shared-origin session assumption, permissive CORS or arbitrary redirects are introduced. A visiting host receives guest authority in the inviter's app and can return Home to their own app.
- Separate compact RSVP enclosures show recipient/household names, a black QR on a white quiet zone and “Scan to RSVP.” They reuse the shared SVG renderer and support individual SVG/PNG downloads, batch enclosure printing, copies per recipient and paired invitation/enclosure printing. Large artwork batches are bounded to an 8 MB estimate; select fewer recipients if that bound is exceeded. Existing main designs/templates remain stored unchanged; paired output omits the main QR and invite-code variable. Recipient selection is scoped to the event, with version checks and household grouping.
- QR references are random navigation references, not authentication tokens. Their IDs remain stable across recipient account upgrades. Anonymous scans may reveal only already-public inviter branding, never event content or recipient account type. After authentication, invitation access is checked again and current central host/guest status determines the destination: inviter household origin for a host recipient, Gather's inviter-branded entry for a guest. Uninvite/block invalidates access. Active aliases can preserve routing during an authorized household rename.

## Flags and deployment boundary

No flags are added to `wrangler.jsonc`, set in Cloudflare, or enabled in production by this work. Missing flags are false.

| Setting                                    | Purpose                                                                                                                                                                                                                            |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PASSWORDLESS_ENABLED=true`                | Enable new passwordless endpoints/form.                                                                                                                                                                                            |
| `PASSWORDLESS_ACTIVATION_APPROVED=true`    | Independent operator approval required as well.                                                                                                                                                                                    |
| `AUTH_SMS_ENABLED=true`                    | Explicitly permit transactional authentication delivery with the existing provider.                                                                                                                                                |
| `GATHER_UNIVERSAL_ENABLED=true`            | Permit universal app and branded entry functionality.                                                                                                                                                                              |
| `GATHER_DOMAIN_APPROVED=true`              | Permit exactly `gather.ilymmd.com` at the trusted edge/gateway. No wildcard or household claim is used.                                                                                                                            |
| `GATHER_PWA_ENABLED=true`                  | Expose/install the new PWA metadata and service worker after universal activation.                                                                                                                                                 |
| `PASSWORDLESS_RETIRE_LEGACY_APPROVED=true` | Optional, separate migration approval. Only an account that subsequently completes passwordless sign-in is marked migrated. Its old normal login cannot mint another session. Administrator recovery remains strong and available. |

Authentication delivery is independent of optional messaging. **Keep `SMS_ENABLED=false`** when approving authentication alone. Existing RSVP confirmations, e-vites and reminders remain governed by their existing opt-in, provider, STOP and global messaging controls. Do not enable optional production messaging merely to make sign-in work.

The existing `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_FROM` secure settings are reused. No new provider or paid service is created. Do not copy values into chat, source files or workflow output. Authentication delivery must be verified and explicitly authorized before enabling it for real people; development uses mocked providers only.

Owner-merging this PR can trigger the existing main release. The new paths remain inactive with the current missing/disabled flags. The manual recovery workflow, release serialization, full validation, mandatory checkpoint/artifact upload, runtime inventory and post-publish verification remain intact. The adapter fingerprint is updated for this explicitly gated source change; the Durable Object class, namespace, database binding, `events-platform-v1` object name, migration configuration and production settings are unchanged. The owner reviews the infrastructure changes, source fingerprints and appearance manifest in the PR and merges it without adding approval labels. Source approval does not authorize SMS or DNS activation.

## Required owner activation sequence

1. Review the PR and its appearance/infrastructure changes and matching manifests; no approval labels are required. Keep automatic Cloudflare Builds/previews disabled. Let the existing GitHub release checks and production recovery safeguards run after your merge. Codex does not create/merge the PR or deploy.
2. Preserve and verify a working strong system-administrator sign-in and recovery path. Inventory central names and independently verified phones for hosts, guests, central adult members, opted-in children and administrators. Shared/ambiguous names and phone matches need administrator resolution, never guesses. Enroll missing verified records through the restricted account controls. Do not retire any legacy method at this stage.
3. Verify ownership, current DNS/routes and absence of a conflicting `gather.ilymmd.com` resource. Arrange an explicit, separately approved exact-domain route/custom domain to the existing events Worker, or review the existing gateway's guarded universal-domain support. Do not assign Gather to a household, create another Worker/database, add wildcard routes or adopt another website's resources.
4. **The existing gateway also needs a separately approved source release before passwordless links/handoffs on household subdomains can work.** Its old cookie filter accepts only the session cookie; the reviewed update narrowly permits the login/handoff proof cookies and narrowly named per-child device proof cookies too. No gateway deployment was performed by Codex. Preserve its existing routes, secrets and host inventory.
5. Verify the existing SMS provider's ability to deliver transactional sign-in messages, registered-number ownership, suppression and recovery handling. Owner approval is required before any real delivery. Keep optional RSVP/reminder/e-vite SMS disabled unless separately approved.
6. In an approved validation environment, enable the flags and verify name/phone sign-in, all roles, valid/expired/replayed links, other-device revocation, household branding/aliases, universal guest Home, received host invitations, QR authorization and paired exports. Confirm preserved production inventory/data before any live activation. Enable production authentication/domain flags only after these checks and an explicit approval.
7. Test real iPhone Safari versus installed PWA, Android installed-app behavior and desktop installation with authorized accounts. Do not assume cookies are shared between Safari and an installed iPhone app. Confirm the safe fallback before treating installation as verified.
8. Retire legacy normal sign-in only after verified phone coverage, delivery and recovery are proven. Enable the separate retirement flag only when approved; migration is per account after successful replacement authentication. No old credentials/private-link mappings are deleted. Disabling passwordless activation restores the prior normal methods without a database rollback or reverse migration. Revoke outstanding sessions/challenges through the authorized controls when executing an incident recovery.

## Device and verification limits

A PWA cannot guarantee automatic link opening on every operating system. HTTPS/app-scope link handling is used where supported. The handoff requires actual proof cookies in the destination browser/container and fails closed when they are absent; it does not pretend to authenticate an unrelated installed app. If iOS opens SMS in Safari instead of the requesting PWA, request and redeem the link in the same Safari browser and use the website there. Guaranteed native Universal Links/App Links and cross-container app opening require a native application and platform association setup, which this task does not create.

Local automated tests cover shared sign-in, browser/origin binding, hashes/expiry/replay, ambiguous/unverified numbers, STOP/cooldowns, role/step-up restrictions, legacy migration, session revocation, QR references/upgrades, universal manifests, virtual-HTTPS browser flows and the actual local Worker/SQLite universal edge. Actual production SMS delivery, real device installation/link opening, production DNS/routes and interactive private production flows are **not** verified or activated by local tests. Preserve that distinction in handoff reports.

## Central family membership and review

Family opens as a read-only name list. Select Edit for a person, or Edit family information for addresses/sharing. Add adult/child adds a central roster identity without creating a separate username/password account. Existing optional credentials are retained for recovery; new standalone account creation is rejected after passwordless activation. Archived people are not resurrected by unrelated address or person edits.

A system administrator uses Registered accounts → Central family membership, selects the host household from the restricted host inventory and confirms their current password to review the roster. Every membership action confirms the password again and checks both profile and membership versions. Only independently reviewed identity, membership, phone ownership and authorized security-text delivery may be approved. Exact names, surnames, addresses and shared phones never grant membership automatically. Verified approved central adults get host authority only in their own household; no new family-account row is created.

Children default to Allow Sign-In off. The verified guardian or original household owner can request access or immediately turn it off in the child's editor. Administrator approval is required before a pending request becomes active. An approved child has only explicitly granted Family Workspace access, never Address Book, event management or system administration. Every enclosing-folder grant remains required. Existing child password sessions cannot bypass the off switch after activation.

For a child with an independently verified personal phone, the administrator may approve delivery to that number. Without a personal phone (including use of the designated guardian's phone), the verified guardian must approve child-specific delivery. After approval the administrator prepares a restricted ten-minute, single-use device-enrollment URL. Give it only to the verified guardian for opening in the approved child's requesting browser. It establishes an HttpOnly device proof, not a session. The child then requests the normal SMS link using their name and authorized guardian number; that link must be opened in the same enrolled requesting browser. Name plus a shared phone alone cannot start child authentication. Device proofs expire after thirty days, are invalidated by membership changes and require renewed reviewed enrollment. SMS delivery and session/handoff validation recheck the current child membership and device proof. Never put enrollment URLs into logs, ordinary exports or printed invitations.

A reviewed adulthood transition preserves the central identity/member ID and all existing records, but revokes sessions and removes child authority. Remaining in the household creates pending adult membership; it does not immediately grant host access. Approve the adult's own independently verified phone and membership separately. Alternatively release them into an independent guest household. No birthdate, displayed name or address automatically upgrades an account.

A reviewed adult release preserves central identity and unrelated invitations/RSVPs, allocates a permanently reserved four-digit household ID and creates an independent personal-family profile. It archives the old roster entry, revokes former host/workspace sessions and moves only explicitly person-owned contact edges. Shared household workspace records and unattributed household contacts remain with their household. Existing central personal records are not deleted. The released adult is a guest and can manage their own family; becoming a host requires separate host approval. The original registered household owner must undergo a separately reviewed ownership transfer before release, and dependent children require explicit guardian reassignment first. These safeguards fail closed rather than guessing ownership.

New approved host registrations with duplicate display names atomically claim the first never-used label (`dubois`, `dubois2`, `dubois3`). Display names stay unchanged. Retired labels remain reserved; reserved platform names cannot be bypassed with numbering. Existing household labels/aliases are not renamed. Branded Gather entry paths and QR routing use these authoritative active labels through the same shared routing checks. Allocation does not activate DNS or provision another application.

The central membership regression suite covers approved adult access, tenant restrictions, child opt-in/out and both delivery paths, device enrollment/replay, reviewed adulthood, independent release and preserved identity/response data. Domain tests cover concurrent duplicate-name allocation and retired-label reservations. Browser coverage checks the actual read-only Family renderer and explicit Edit/Cancel on phone, tablet and desktop.

## Ticket 01 — Persistent sign-in: remember users

After successful Twilio SMS link redemption, hosts, guests and approved family
members receive an independent, persistent device session. There is no inactivity
timeout: closing the browser/PWA, restarting the device or returning months later
does not normally require another SMS. Valid sessions bypass SMS authentication.
Existing, still-valid SMS sessions upgrade on their next use; expired credentials
are never revived. Legacy password authentication is unchanged.

Credentials remain host-only Secure, HttpOnly, SameSite=Strict cookies, with a
400-day browser lifetime refreshed during use. Server records have no ordinary
expiry. Active credentials rotate after one day; a bounded 60-second encrypted
receipt handles concurrent requests without storing the replacement in plaintext.
Strong administrator elevation remains separately limited to eight hours and
requires password confirmation, never another SMS solely because elevation expired.
No authentication credential is placed in localStorage or the service-worker cache.

Sign out revokes the current device, including its authorized cross-origin
handoff sessions. Settings also provides other-device and all-device revocation.
Administrator revocation, account recovery and security changes invalidate affected
sessions immediately. Current identity, verified contact, household membership,
child approval and per-request permissions remain authoritative; remembered access
never freezes authorization. Expiry of a child's enrollment proof prevents a new
sign-in but does not expire an already approved session; withdrawal of approval
still revokes access immediately.

Persistence is subject to browser/OS restrictions, cookie clearing and storage
removal. Separate browser/PWA storage profiles can require separate authentication.
Do not promise permanence beyond those platform controls. Local regression coverage
uses real Chromium profile restarts and simulated elapsed months; native iOS/Android
PWA persistence and live Twilio delivery still require separately authorized testing.

SMS configuration/activation remains disabled and no provider is purchased or
activated. Preserve the existing sign-in fields and Ticket 01 SMS design; optional
passkeys require a separate decision. This feature does not authorize deployment.

## Firebase replacement of the normal sign-in provider

The later Ticket 01 request supersedes the Twilio magic-link design above for normal
hosts/guests. [Firebase phone sign-in](firebase-auth.md) preserves persistent Gather
sessions and existing identities, gates activation, adds independent new-invitee
onboarding and restricted administrator recovery, and retires outbound event/account
texts. Legacy login/outbox exists only for controlled fallback until acceptance.
No Firebase or production settings have been activated by preparing source.

# Shared accounts, cards and reconciliation

This continuation implements the requested account/card/contact integration in the shared application. It follows the deployed Information pop-up and RSVP ordering update from PR #63. Merge/deployment is owner-authorized, subject to passing checks and the exact-commit release safeguards. Validation uses isolated synthetic databases, loopback browsers and mocked providers.

## Accounts and family information

Existing unregistered guests enter their name and current four-digit address credential. First sign-in requires a private username and recovery phone before continuing. Registered guests use username plus a current address credential; registered hosts use email/password, including when a proven existing guest identity is attached during registration. Ambiguous identities are never guessed. Moved/removed address credentials cannot be reused through another relationship. Optional suffixes appear only when current code-qualified candidates require them.

Private usernames and recovery phones are visible only to their account owner. Phone verification is one-use. Username recovery requires a verified phone and explicit YES; NO cancels. Disabled SMS cannot verify a phone or send recovery texts, and unknown delivery is never retried. No provider is enabled by this change.

Family bootstrap runs once from the proven existing address. Later host edits cannot replace the self-managed profile. Physical/mailing addresses, adult phones and designated children are shared only with selected reciprocal contacts (mailing takes precedence). Removing/blocking a contact updates access immediately. New reciprocal host contacts may receive approved profile data, never invitations. Existing private host notes, identities, responses and relationship-specific data remain separate. Conservative exact name plus phone/address association links only one unambiguous registered adult; children must match their designated parent.

## Cards, templates and e-vites

The dedicated manager, editor and preview reuse one card renderer and the shared three-level toolbar. The palette supports variables, snapping, resizing and keyboard positioning. SVG/PNG/print/share use the same document without selection guides. Existing source snapshots survive formatting edits. Changing one source updates only that source. Save waits for the current artwork read; stale writes retain drafts; private/shared templates remain separate. Invite codes are optional recipient variables and never become shared template values. QR color, transparency and editable text above it are supported.

Recipient-specific e-vites render separate PNGs from the selected document, preserving its event snapshot. Missing-phone reports can be copied/downloaded. Later sends are restricted to previously missing-phone recipients; accepted, delivered and unknown attempts are not resent. Bounded image batches share one user-action limit. Status refresh is automatic, while acceptance is explicitly distinguished from delivery. SMS remains disabled; browser tests intercept only the sender/provider boundary. Native sharing/email is an explicit user action and does not claim delivery.

## AnyList and administration

The selected verified host can choose Pull from AnyList, Update AnyList or Sync both. Stable source mappings and separate field baselines preserve independent remote additions while Gather wins conflicts. A revision check and short write lease guard outbound application; fresh source inventory and post-write acknowledgement guard convergence. Reserved source IDs recover uncertain writes without duplicating people. Addressless contacts retain credentials until assigned a real address. No missing-source deletion or event/response/notes export occurs. See [AnyList operations](meyer-anylist.md).

Only a password-confirmed administrator can rename a host household or claim a new domain label. Old labels remain aliases; new ones stay pending until the existing proof/inventory checks pass. Deletion validates all alias receipts before deleting any exact owned resource, retains retired names and preserves global identities/other relationships. Removing a linked host restores eligible private guest sign-in without deleting its personal profile.

Synthetic page-default examples use actual page renderers, including first-time/private account, family information and registered Address Book. Shared wording/positions remain administrator-only and preserve host/event appearance overrides. No new runtime bindings, secrets, routes, cron, namespace or object names are introduced.

Live AnyList authentication/writes, SMS/recovery delivery, real account deletion and new public hostname activation remain unverified. Do not use real guests or messages to turn those limitations into release tests. Deployment verification must separately establish the exact live Worker version, closed setup and preserved runtime settings.

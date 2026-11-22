# Firebase host-only authentication migration (staged)

This branch is an opt-in conversion of **hosts only** from custom Google OAuth,
Gather password verification and Resend to Firebase Authentication. Guests still
open the event directly and RSVP with a host-scoped Household ID. No guest
Firebase account, guest sign-in, guest Home or SMS is introduced. Approved UI
components and styling are unchanged.

## Safety and staging

The new provider works only when **all four flags** are explicitly true:

- `HOST_ONLY_MODEL_ENABLED`
- `HOST_ONLY_MODEL_ACTIVATION_APPROVED`
- `HOST_FIREBASE_ENABLED`
- `HOST_FIREBASE_ACTIVATION_APPROVED`

All are absent/off in production. Merely adding the Firebase client configuration
does not activate the migration. Do not enable flags from this PR alone.
No deployment, account migration, DNS, billing, service credentials or live
provider operation is authorized by this source change.

When opted in, Firebase verifies Google or email/password host identity with
signed ID tokens and the current provider account lookup. Gather still controls
host membership, admin-issued invitations, host-specific domains, sessions,
roles, contact isolation and event RSVP. No email/name match alone creates or
grants a host account; new hosts must use a valid administrator-issued invitation.
Existing hosts require their verified Firebase identity **and** previous Gather
password to connect. A special administrator password route remains separate.

Firebase's own `sendEmailVerification` and `sendPasswordResetEmail` replace
the custom verification/recovery mail sender. Resend is not needed for this
provider mode. Historical user hashes, old mappings and signed-in sessions
are retained for recovery and controlled transition; they are not deleted.

## Firebase Console prerequisites

In existing project `gather-58a79`:

1. Enable **Email/Password** and **Google** under Firebase Authentication
   sign-in providers; Phone may remain disabled and is never used for hosts.
2. Configure Firebase Authentication authorized domains to include
   `gather.ilymmd.com` and the existing `gather-58a79.firebaseapp.com`.
   Household subdomains use central session handoff rather than direct provider
   sign-in.
3. Set appropriate Firebase password-reset and email verification templates,
   their continue URL / allowed domain, and Google consent configuration.
   Test real delivery and real Google sign-in with an approved isolated test
   account. Consent-screen testing mode restricts Google accounts to test users.
4. Retain public Firebase Web app values `FIREBASE_PROJECT_ID`,
   `FIREBASE_API_KEY` and `FIREBASE_AUTH_DOMAIN`. No service-account
   private key and no Resend key are used for this feature.
5. Review authorized browser/API-key restrictions and the sender settings.
   Firebase default email templates are subject to the provider's limits.

Existing `HOST_GOOGLE_CLIENT_ID` and `HOST_GOOGLE_CLIENT_SECRET` can be
left dormant for rollback, rather than removed during migration.

## Acceptance required before activation

- Review all existing host accounts, including accounts with platform admin
  permissions, and test the separate administrator password login/step-up.
- Use an isolated registered host and an admin-issued signup invitation to
  validate Google signup, email/password signup, verification, recovery,
  linkage of an existing Gather host, persistent/revocable sessions and
  correct household routing on desktop and native Safari/PWA.
- Confirm that Firebase account disable, provider password reset, and account
  deletion have a documented Gather session-revocation policy. Existing Gather
  sessions do not automatically become revoked just because a Firebase
  account is disabled; production cutover requires a verified revocation design.
- Complete the independent Address Book transition and reissue retired
  short Household IDs using the existing reviewed admin flow.
- Run CI, browser and Worker runtime checks and visually compare approved
  Home/Event/Address Book pages.
- Preserve historical accounts/data; only after migration and acceptance,
  separately approve and activate the provider flags.

Do not merge/deploy or turn on host-only replacement merely because unit tests
pass. This first branch adds Firebase-backed host exchange and frontend entry
points but is **not an accepted production cutover** until the above live
verification and revocation conditions pass.

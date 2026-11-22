> Retired by the consolidated host-owned invitation model. The
> `npm run test:firebase:real` command now refuses execution. Do not activate
> Firebase or use the historical live-provider instructions below for this ticket.
> Offline synthetic tests remain only for flag-off recovery compatibility.
> See [the replacement implementation](host-owned-invitations.md).

# Isolated real-Firebase phone verification

This runner uses the existing Firebase SDK, Gather server, SQLite store, account
matching, QR references and session handoff. It does not enable production login,
deploy a Worker, modify DNS, copy production data or use the production database.

## Safety boundary and what "real" means

The SDK and Firebase phone-code verification are real in the manual runner. Firebase
ID tokens go through Gather's existing Google-signature and account-state checks.
However, **the phone request always uses Firebase's official
`appVerificationDisabledForTesting` mode**. That mode accepts configured fictional
numbers and rejects ordinary/unconfigured numbers rather than sending a real SMS.
A browser transport guard additionally requires an explicitly approved number,
a one-use SDK-generated testing token and the fixed project's API key. A normal
live reCAPTCHA token is never permitted on a phone-send request. At most three
fictional verification requests are allowed per run; this is a test limit, not a
production SMS policy or a guarantee about the Firebase project's overall billing.

The runner first opens a **separate genuine reCAPTCHA check** using the real SDK
with testing bypass disabled. That page has no phone-send operation; its transport
blocks all authentication writes. The solved real token is discarded. The later
phone flow uses the SDK's official fictional-number verifier. Thus this tests the
real challenge separately and the real fictional-number authentication/session flow,
**not the normal real-reCAPTCHA-token-to-SMS delivery chain**. No mocks are substituted
in the manual run. The official SDK testing verifier is deliberately used for the
phone request. Do not disable that protection to test the live delivery chain.

The guard is pinned to Web SDK 12.6.0 / Firebase Auth 1.11.1's official testing-token
format and fixed Web-client/NO_RECAPTCHA metadata. Real Enterprise/App Check tokens,
unsupported SDK payloads, redirects, unapproved numbers,
unknown Google endpoints or keys fail closed. If the project requires a different
verification payload, stop for review; do not loosen guards or alter Firebase settings
to make this runner pass. Project `gather-58a79` is the only accepted project.

All Gather URLs—including `gather.ilymmd.com` and two synthetic household hostnames—
are intercepted in a fresh private Chromium profile and fulfilled from loopback.
They never reach public Gather DNS/hosting. Service workers are blocked. The profile
contains no existing user's cookies. Only approved Firebase/Google reCAPTCHA network
operations may leave the harness. No admin API, billing, user deletion, password-reset,
email, Cloudflare API or production resource operation is allowed.

## What the temporary database contains

A new owner-only OS temporary directory contains SQLite, WAL files and a browser
profile. The shared application creates synthetic owner accounts, a primary household,
event and invited adult named **Firebase Test Guest**. A second synthetic household,
event and contact reference to that same invited identity provide the multiple-household
checks. There is only one invited adult identity, with the first approved fictional
number. No real names, accounts, contacts or invitations are imported.

The runner exercises signup through that synthetic invitation, guest matching,
both household session handoffs, guest denial of host APIs, one isolated RSVP,
refresh, closing/reopening Chromium with the same private profile, and device sign-out
revoking central/household sessions. It verifies that restart/handoff never sends
another code. All Gather records and local browser credentials are removed afterward.

Firebase may create or update the **fictional-number Firebase Auth user** and provider
usage/authentication metadata when verification succeeds. That is the expected real
provider interaction. The runner does not delete Firebase users afterward, because
that could delete an existing provider record. It never modifies real-user records
or project configuration. If you cannot accept a provider test-user record in this
project, do not run the real-provider test.

## Prepare privately

Use an existing development desktop environment with Node.js 24, this checkout's
`npm ci` dependencies and a working Chromium installation. Do not install anything
on your Mac just for this procedure: it can run in an already provisioned development
desktop. A terminal-only API environment without an interactive display cannot
complete the live challenge. The automatic offline test works headlessly.

1. Keep both Firebase activation flags **false on the production `events` Worker**.
   Keep all production secrets, bindings, routes, cron and other settings unchanged.
2. Confirm the chosen phone is listed under Firebase Console → `gather-58a79` →
   Authentication → Sign-in method → Phone → Phone numbers for testing. Do not use
   a real person's number. The console must contain the corresponding fixed code.
3. Retain `gather.ilymmd.com` in Firebase Authorized Domains and the existing
   `gather-58a79.firebaseapp.com` auth domain. No synthetic household domain or
   wildcard needs adding. Leave API key Application restrictions as None for this
   implementation; API restrictions must allow Identity Toolkit and Token Service.
   This runner never changes those settings.
4. Create an owner-readable JSON file **outside the repository**, using your local
   editor. For example: `$HOME/.config/gather/firebase-test.private.json`.
   Replace the placeholders privately; do not paste values into chat or GitHub:

```json
{
  "projectId": "gather-58a79",
  "authDomain": "gather-58a79.firebaseapp.com",
  "apiKey": "COPY_THE_WEB_APP_PUBLIC_API_KEY_HERE",
  "fictionalPhoneNumbers": ["COPY_YOUR_CONFIGURED_FICTIONAL_E164_NUMBER_HERE"],
  "acknowledgeFirebaseFictionalNumbers": true,
  "acknowledgeProviderTestUserRecord": true
}
```

5. Set owner-only permissions, substituting the path you used:

```sh
chmod 600 "$HOME/.config/gather/firebase-test.private.json"
```

The file must be a regular, non-symlink file outside this checkout, owned by the
current user with no group/other permissions. Codes, tokens and private keys are
not accepted config fields. **Do not put the verification code in this file.**
The public Web API key is not a service-account credential, but it is still kept
out of reports and repository files. No Cloudflare token or Firebase admin/service
account key is needed. Do not pass numbers/codes/keys as command-line arguments.

## Run with manual interaction

From the repository in that interactive desktop:

```sh
npm run test:firebase:real -- --real-fictional --config "$HOME/.config/gather/firebase-test.private.json"
```

1. A new Chromium window opens with an **ISOLATED GATHER TEST** banner. Use only that
   window; an ordinary browser's public Gather tab still connects to production.
2. Click **Check reCAPTCHA** and complete the genuine Google challenge. This step
   cannot request a phone code.
3. The runner then opens the isolated recipient invitation. Enter:
   - First Name: `Firebase`
   - Last Name: `Test Guest`
   - Phone Number: the configured fictional number from your private file
4. Click **Send verification code**. No real message is sent. Enter the fixed code
   from Firebase Console in Gather's browser form and click **Verify and sign in**.
   Never type that code into the terminal or save it in a report/screenshot.
5. Let the runner navigate and verify automatically. It will close and reopen its
   own browser profile, check persistence, then sign out. Do not close the window
   during those automatic steps. No further code should be needed.
6. A sanitized PASS/STOP result is printed. Reports contain stage codes only, not
   phone numbers, codes, tokens, cookies, URLs or request/response bodies.

The manual runner is explicit opt-in and is never run by GitHub Actions. CI runs
only the offline regression with synthetic Google responses and synthetic signed
claims. The real provider test was not performed while developing this branch:
owner configuration and manual reCAPTCHA/code entry are required.

## Cleanup and failures

Normal completion, caught errors, window cancellation and Ctrl+C close the browser,
loopback servers and database, then remove the owned temporary directory. Your
private configuration file is retained for reuse; remove it yourself if no longer
wanted. SIGKILL, power loss or OS failure cannot guarantee immediate cleanup.
After such an interruption, run:

```sh
npm run test:firebase:real -- --cleanup-stale
```

This removes only this runner's OS temporary directories with its marker, current
user ownership and a dead process ID. It never targets the checkout, a user-supplied
database/profile path or Cloudflare resources. Active/unknown directories are skipped.

A missing config gives `USAGE_REAL_FICTIONAL_CONFIG_REQUIRED`; a terminal-only machine
stops with `INTERACTIVE_DESKTOP_REQUIRED`. Wrong numbers are blocked locally before
SDK send. An unconfigured Firebase fictional number fails provider app verification
in official testing mode rather than sending a text. Do not retry with real numbers.
A guard failure must be investigated using its fixed stage code; do not post raw
network diagnostics, Firebase codes, ID/refresh tokens or browser profiles.

This validates Chromium and its private profile restart. It does not verify actual
Safari, iOS/Android installation or automatic opening of native installed PWAs.

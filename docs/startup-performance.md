> The follow-up in [lightweight browser entry](lightweight-entry.md) replaces the
> module-preload approach below with a verified single application build and tiny
> authentication-transfer pages. The results below describe PR #106, not proof
> that production loading was resolved.

# Gather startup loading

This correction starts from approved main `673e12f0556026a7bd3afc231d60014e622c3446`.
It changes request scheduling, not sign-in policy, branding, page layouts or data.

## Verified causes in the application

The entry module imports the shared editor, card, workspace and authentication
modules. Their further imports were discovered in later request waves. With an
uncached browser the application could not start its API requests until that
module dependency chain completed. HTML now preloads the same 24 static local
modules the application already imports; it does not load Firebase's remote SDK
or execute additional features.

Plain Home now starts public context, interface defaults and its existing session
read alongside setup/configuration. Sign-in and session-handoff routes retain
ordered redemption before their session read. Startup configuration includes the
same public host configuration returned by the existing host-auth endpoint,
using one shared server helper. New clients retain fallback support for the old
server response. This removes a configuration round trip without changing Google,
Firebase, Gather-password or administrator authentication.

Direct `/event/:reference` pages now request only their public event data. They
never need the administrator setup endpoint, sign-in configuration, a session
read or an invitation-to-event document redirect. Their existing public projection,
Household ID lookup, full-page RSVP permissions and private-page grants remain
unchanged. No service worker, gateway, Worker, route, binding or database changes
are included. Secure cross-domain handoffs remain intact rather than being bypassed
or simulated by hiding the loading message.

## Controlled browser measurement

These are **local synthetic measurements, not production measurements**. Chromium
uses a fresh context for each run, the actual application and an in-memory SQLite
fixture, with 200 ms added before every local request. The baseline serves the
approved main asset bytes; the corrected run serves current asset bytes. Both
asset sets are loaded into memory before timing to avoid Git/filesystem timing
bias. Measurement runs from navigation until the form, dashboard action or event
RSVP button is visible/usable. The table reports the median of three cold runs.

| Scenario                      |  Before |   After | Main-document loads before/after |
| ----------------------------- | ------: | ------: | -------------------------------- |
| Signed-out Home               | 2.019 s | 1.023 s | 1 / 1                            |
| Signed-in synthetic host Home | 2.017 s | 1.519 s | 1 / 1                            |
| Direct public event           | 1.365 s | 0.908 s | 1 / 1                            |

CPU/network conditions affect these values; they are not a production SLA or proof
that every source of production delay has been measured. Home uses five startup
API reads instead of six in replacement mode; the public event uses one instead
of two. Existing authenticated dashboard/template reads remain permission checked.

`test/startup-mobile.js` also deterministically holds the entry module until a
deep dependency is requested, and holds startup configuration until all independent
Home reads have started. It tests signed-out, signed-in host, signed-in administrator
and direct public event journeys, one main document, no obsolete sign-in form, and
no setup/session/config dependency for the event. Provider regressions compare the
inline and existing configuration in both Gather-password and Firebase host modes
and ensure private provider credentials are never returned.

## Production verification limitations

This chat has no connected browser-control tool. The Cloud environment's proxy
rejects the requested production sites with HTTP 403, and its access expansion
was not approved. Production navigation times, document/redirect counts and a real
signed-in Meyer session therefore remain unverified. Local read-only Cloudflare
metadata requests also returned transport failures; no credential changes or
production writes were attempted to overcome this.

Production publishing must use the existing owner-merge GitHub Actions workflow,
including its unchanged recovery upload, ancestry/configuration guards and actual
post-deployment version/asset/binding checks. Reopening the two exact owner URLs
in the connected browser is still required for real before/after acceptance when
that browser is available. Do not substitute synthetic times for that evidence.

# Gather · shared event hosting

A mobile-first application for independent hosts and households. Every household and event uses the same server, event builder, guest page, RSVP flow, and design controls. Differences are persisted as data in one centralized SQLite database. No emails are sent.

## Run locally

Requires **Node.js 24** for local development and deployment tooling (also pinned in `.nvmrc`). There is no frontend build step. Cloudflare Workers is supported through the same shared application; see [Cloudflare deployment](docs/cloudflare.md).

```sh
npm ci
npm start
```

The default server is `http://127.0.0.1:3000`. The default database is `var/events.sqlite`; the directory is ignored by Git. Keep the application server running for cross-device use. Data is never stored primarily in browser local storage.

For this local Node development workflow, create the initial administrator with `npm run admin` after supplying `ADMIN_EMAIL` and `ADMIN_PASSWORD` through a secure shell environment. There is no default account or password; use at least 12 characters. Do not put passwords in source code, shell command history, or committed configuration. Unset the bootstrap variables afterward. The command creates an administrator account, never sends an email, and refuses duplicate email addresses.

### Everyday workflow

1. The administrator signs in through **Host Login**, approves an email address, and personally shares the site link. Approvals can be removed until consumed by registration.
2. An approved host chooses **Create your account**, sets a password and family household name, and signs in. Approval is consumed atomically; public/unapproved registration is rejected.
3. Hosts use **Guest list** to add adults and children, and **Address book** to create optional shared addresses. Each child has one designated adult. Multiple adults can share one address without sharing a login or RSVP.
4. **Household** previews and edits the household name, background/image, container color/opacity, title and text colors/fonts/sizes. The stable household login link and QR use these settings.
5. The fixed **+** toolbar button creates an event. Add artwork, description, date, numeric or written time, address, RSVP deadline, individual adult/child invitations, and potluck/drink items with quantities. Copy menu items from any previous event in the same household. The pencil changes only that event’s appearance.
6. Optional **Gift registries** in the same event editor accept multiple custom titles and HTTP/HTTPS URLs. Add, edit, remove and move them up/down. Guest registry buttons appear directly below RSVP in the saved order and inherit event formatting. Events without registries display no registry section.
7. **Share household link** displays a reusable QR, SVG download, copy/share actions, and the personalized guest login page. The link remains stable through event creation, household renaming, and design changes.
8. Guests enter first/last name and their suffix if recorded. They see only their invitations, RSVP for themselves and their invited children, select available menu quantities, and see their own saved items on the event page. Each adult responds independently. Print includes event information and their items.
9. Hosts open **RSVPs** for adult/child attendance, declines, no response, complete invited list, and menu requested/claimed/remaining totals and claimants.

The administrator can upload, rename, replace or remove shared PNG/JPEG/WebP invitation artwork. Hosts select a template per event. **Preview invitation** combines its artwork with the event’s current information and household QR; print/save as PDF uses the same populated preview. A template in use cannot be removed. Template updates intentionally apply to events that reference it.

### Synchronization and conflict handling

Active pages re-fetch authorized server data every 10 seconds and on reconnection. Separate devices see saved changes without sharing browser storage. Polling pauses while an editor or input is active so it cannot erase an unsaved draft. Close the editor and reload the latest information after a conflict.

Host updates/deletions require the record version (`If-Match`). RSVPs have a version per adult/event. Stale writes return **409**; they never silently overwrite newer data. RSVP capacity validation and reservation run inside one SQLite transaction, so two guests cannot simultaneously claim the last quantity. Declining releases that adult’s items and children cannot attend without their designated adult. After the RSVP deadline (UTC calendar date), attendance changes and item reductions remain possible; item increases are rejected. Existing claims are preserved if a host later reduces a requested quantity.

Guests with recorded responses cannot be silently removed from event invitations; items with claims cannot be removed. Release claims or explicitly delete the event, with confirmation. Deleting an event removes its RSVP records. Guest deletion requires removing associated children and event invitations first; address deletion requires unassigning it from guests.

## Tests

```sh
npm test
npm run format:check
# Use system Chromium, or install Playwright's browser first:
npx playwright install chromium
npm run test:mobile
npm run test:cloudflare
```

Set `CHROMIUM_PATH` to use another Chromium executable. Browser tests use an isolated in-memory database on loopback port 3147 and block all external browser requests. Do not run them against a deployed site. HTTP integration tests use temporary databases and randomly assigned loopback ports. Some managed environments require execution permission for local sockets and browser processes.

The test suite covers two hosts, role/tenant isolation, approvals/passwords, CSRF, suffixes/ambiguous names, shared addresses, individually invited children, RSVP totals, racing quantities, deadlines, record conflicts, persistence after restart, templates/QR, and ordered registries. The browser test exercises approval through RSVP on a phone viewport, checks independent household/event colors, a second host on a tablet, another guest session on desktop, and automatic registry synchronization. CI runs both suites on Ubuntu 24.04, pinned because Playwright 1.58.2 does not support Ubuntu 26.04 selected by `ubuntu-latest`. Keep the runner and Playwright's supported operating systems compatible when updating either. There is no automatic deployment workflow. CI also validates the local Cloudflare Workers/Durable Objects runtime.

## Architecture and runtime configuration

- `server/model.js`: shared SQLite storage, tenant-scoped access, design validation, password/session handling and transactional RSVPs. Large records use transactional chunks compatible with Cloudflare row limits.
- `server/node-store.js`: local Node.js SQLite driver.
- `server/handler.js`: shared HTTP request handling, role authorization, validation, CSRF and QR generation.
- `server/app.js`: local Node HTTP/static-file adapter.
- `cloudflare/worker.js`: Cloudflare Fetch/assets and SQLite-backed Durable Object adapters; one new Worker and database namespace, without touching the gatherings site.
- `public/app.js`: shared views/forms for administrator, host and guest; one event editor/page, RSVP system and appearance editor.
- `public/style.css`: touch-friendly shared design and fixed toolbar, responsive dialogs, print and safe-area rules.
- `test/`: HTTP integration and multi-session mobile browser checks.

Appearance resolves as **platform defaults → household settings → event overrides**. Household login uses only the first two layers. New events store empty appearance overrides. Changes made with an event’s pencil store only changed/previously overridden values; **Use household defaults** clears those overrides. Content, images, ordered registries, invitations, menus and styles are JSON records associated with a household; credentials and sessions use separate server-only tables. Private reads and writes are always scoped by the server session, never by an untrusted client-supplied household ID. Public household lookup has an indexed, opaque stable slug.

| Variable                        | Default                 | Purpose                                                                                          |
| ------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------ |
| `PORT`                          | `3000`                  | HTTP listener port                                                                               |
| `HOST`                          | `127.0.0.1`             | Listener address; use `0.0.0.0` behind your chosen trusted HTTPS edge                            |
| `APP_ORIGIN`                    | `http://127.0.0.1:PORT` | Exact public origin, with no path or trailing slash; used for CSRF checks and household QR links |
| `DATABASE_PATH`                 | `var/events.sqlite`     | Central persistent database on a private durable volume                                          |
| `NODE_ENV`                      | unset                   | `production` requires HTTPS `APP_ORIGIN`                                                         |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | none                    | Initial administrator CLI only; never needed by the running server                               |

Cloudflare is the selected deployment target, using a separate `events` Worker and SQLite-backed Durable Object in the owner's chosen account. See [deployment and administrator bootstrap instructions](docs/cloudflare.md). `npm run deploy:cloudflare` requires working Cloudflare authentication; configuration or a dry run alone does not establish a live deployment. No custom domain route or existing gatherings resource is changed. The administrator can complete one-time browser setup at `/setup` using a securely configured `ADMIN_SETUP_TOKEN` secret. No local installation is needed. Passwords are hashed server-side, setup is origin-checked and rate-limited, and a durable completion marker locks it permanently after creating the administrator. Existing administrators are unaffected. See the deployment guide for the dashboard steps.

The original Node server remains available for local development or a separately chosen single-server host. Its database lives at `DATABASE_PATH`; the Cloudflare adapter uses Cloudflare's durable storage instead. The local database is never silently uploaded to Cloudflare. Multiple Node replicas need a shared database service rather than separate database copies. Use SQLite-consistent backups for the local server; cloud storage recovery/exports require an operator procedure as documented in the deployment guide.

## Security and limits

Host passwords are salted with Node’s scrypt; random sessions are stored only as SHA-256 hashes, expire server-side, and use HttpOnly, SameSite=Strict cookies (Secure in HTTPS). Administration and host sessions last eight hours; guest sessions last seven days. Logout revokes the server session. All mutations require the exact configured Origin. Responses are no-store; a CSP limits resources to the application and uploaded raster images. Uploads are limited to 2 MB per image, names and settings are validated, and registry URLs reject executable schemes and embedded credentials. Rendering escapes user content. Private data and credentials must never enter the repository.

**Name-only guest sign-in is not proof of identity.** Anyone who knows a household link and an invited adult’s full recorded name may impersonate them. This limitation cannot be eliminated while also requiring only a shared household QR and name-only login. The implementation restricts lookup to that household, accepts suffixes without returning name lists, rejects exact duplicate names, rate-limits attempts, and exposes only the signed-in adult’s party and authorized event information. Do not use it for sensitive personal information or claim cryptographic guest identity verification. Stronger identity would require a separately approved change such as per-guest private credentials; none is silently added here. See [security boundaries and release prerequisites](docs/security.md).

[AGENTS.md](AGENTS.md) is the permanent development rulebook. Only `kasstmaster/events` may be modified; the other repositories are read-only references.

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
3. Hosts use **Contacts** to manage adults, children and optional shared addresses together. Type an address title or street in the guest editor, select/edit an existing match or create a new address inline; address and guest changes save together. Each child has one designated adult. Multiple adults can share one address without sharing a login or RSVP.
4. Open **Settings** in the three-dot menu to choose household Light Mode, Dark Mode or Custom Colors Mode. Custom opens the shared seven-category live toolbar editor with Save/Cancel. **Details** fields below Settings actions edit display name, logo and timezone inline. Home returns directly to the signed-in landing page; Contacts, Cards & Invites and Family Workspace open from Home containers.
5. **Create Event** in the home Plus menu creates an event. Edit event details in the event top menu maintains content, artwork, invitations, registries, potluck and confirmed deletion. Event **Settings** offers **Default Mode** (inherits the full home appearance) and **Custom Colors Mode** (the shared event-only appearance editor).
6. Optional **Gift registries** in the same event editor accept multiple custom titles and HTTP/HTTPS URLs. Add, edit, remove and move them up/down. Guest registry buttons appear directly below RSVP in the saved order and inherit event formatting. Events without registries display no registry section.
7. **Share household link** displays a reusable QR, SVG download, copy/share actions, and the personalized guest login page. The link remains stable through event creation, household renaming, and design changes.
8. Guests enter first/last name and their four-digit address invite code; a suffix appears only for a code-qualified record that needs it. They see only their invitations across explicitly linked hosts, RSVP for invited adults/children at the same address, select available menu quantities, and see their own saved items on the event page. Each adult keeps a separate response; blank choices preserve existing answers. Print includes event information and their items.
9. Hosts open **RSVPs** for adult/child attendance, declines, no response, complete invited list, and menu requested/claimed/remaining totals and claimants.

The administrator manages shared invitation, thank-you and holiday templates; hosts use the same editor for private templates and saved cards. Cards snapshot their source design and use one renderer for preview, SVG/PNG download and print. The full-screen editor has a side variable palette and per-item formatting/size controls; drag variables into the preview, resize selections, and snap items to the center/edges. Address invite code is an optional recipient variable, omitted unless added. Select a QR item to set its color or transparent background and add a separate, fully editable text field above it. Shared-template previews use an example QR; cards use the existing household link. Optional QR codes keep existing destinations. Native sharing and email composers never claim delivery. See [shared editors, cards, reminders and deletion](docs/shared-editors.md) for the inheritance model, copy catalog, supported layout controls, private notes, contacts and release instructions.

Text reminders are implemented but **disabled until a separately approved Twilio sender, credentials, webhooks and billing are configured**. No real texts are sent by tests or this default configuration. Administrator account removal requires an explicit scope/email/domain confirmation and receipt-verified cleanup; it is never exercised against live accounts during testing.

### Synchronization and conflict handling

Active pages re-fetch authorized server data every 3 seconds and on reconnection. Separate devices see saved changes without sharing browser storage. Polling pauses while an editor or input is active so it cannot erase an unsaved draft. Background refreshes preserve the current page scroll position while adopting updated server content. Close the editor and reload the latest information after a conflict.

Host updates/deletions require the record version (`If-Match`). RSVPs have a version per adult/event. Stale writes return **409**; they never silently overwrite newer data. RSVP capacity validation and reservation run inside one SQLite transaction, so two guests cannot simultaneously claim the last quantity. Declining releases that adult’s items and children cannot attend without their designated adult. After the RSVP deadline (UTC calendar date), all guest RSVP edits are closed. Existing claims are preserved if a host later reduces a requested quantity.

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
- `public/ui-system.js`, `public/ui-runtime.js`, `public/ui-copy.js`: shared formatting/layout schema and escaped editable copy catalog.
- `public/card-system.js`, `public/editor-tools.js`: one card renderer and shared page/card/reminder editors.
- `server/feature-api.js`, `server/features.js`, `server/reminders.js`, `server/account-deletion.js`: scoped customization, safe field validation, disabled-by-default provider adapter and confirmed deletion.
- `cloudflare/account-cleanup.js`: receipt-based dedicated-resource cleanup.
- `public/app.js`: shared views/forms for administrator, host and guest; one event editor/page, RSVP system and appearance editor.
- `public/style.css`: touch-friendly shared design and fixed toolbar, responsive dialogs, print and safe-area rules.
- `test/`: HTTP integration and multi-session mobile browser checks.

Appearance resolves as **platform defaults → household settings → event overrides**. Household login uses only the first two layers. New events store empty appearance overrides. Changes made with an event’s pencil store only changed/previously overridden values; **Copy formatting from** copies a selected household/event design; **Reset to default colors** requires confirmation. Administrator changes to default formatting preserve existing household/event formatting, while shared wording and position changes apply to every household. Content, images, ordered registries, invitations, menus and styles are JSON records associated with a household; credentials and sessions use separate server-only tables. Private reads and writes are always scoped by the server session, never by an untrusted client-supplied household ID. Public household lookup has an indexed, opaque stable slug.

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

**Guest sign-in requires a private invite code.** Hosts privately share each address’s four-digit code from Contacts. People explicitly assigned to one address share its code; moving an entry gives it the destination code and revokes old access. Entries without an address have an individual fallback code. Stable guest identities and existing responses stay intact. Household links and QR destinations remain unchanged and are navigation links only. Legacy name-only guest sessions must sign in again with their code; saved responses, invitations and guest IDs are preserved. Similar names/addresses produce private suggestions, never automatic linking. A host’s Use Existing choice requests a link; the existing guest must approve with their code before invitations become shared. Mistaken links can be reversed with confirmation, restoring the prior identity and revoking affected sessions without changing address codes. See [family workspace and shared identities](docs/family-workspace.md) for rollout, permissions and recovery.

[AGENTS.md](AGENTS.md) is the permanent development rulebook. Only `kasstmaster/events` may be modified; the other repositories are read-only references.

## Household web addresses

Registration derives the household address from the entire entered household name immediately as the host types: `Dubois` → `dubois.ilymmd.com`, `Raudman` → `raudman.ilymmd.com`. The preview is text only; there is no separate domain input. No added “the”, pluralization, words or collision suffixes. The server derives and atomically claims the same label when approved registration succeeds. Invalid, reserved, retired or occupied names fail without consuming approval; choose a different household name. Hosts cannot change their address in registration, settings or API calls. Existing claims are preserved; later display-name edits never rename their domain. Existing accounts without a claim remain on their opaque links; there is no automatic backfill.

Normalization is shared by server and browser: Unicode NFKD, remove combining accents U+0300–U+036F, lowercase, remove straight/curly apostrophes, replace other non-ASCII letter/digit runs with a hyphen, trim hyphens and truncate to 63 characters (trim any trailing hyphen again). Final labels must contain 3–63 ASCII letters/digits/internal hyphens. Reserved site/platform names, `themeyers` and `xn--` labels cannot be claimed. Empty/short/unsupported names require another household name; normalization can collide and does not grant ownership.

A claim remains **pending** until its exact DNS record, gateway route and authoritative routing state are verified. Sharing and new QR codes use stable opaque `/h/...` links while pending. Existing opaque links/QR remain valid. Unknown/retired routed names fail closed. The shared application and database serve every hostname.

Automatic routing is implemented in the existing events Durable Object: registration atomically queues a job; alarms create only conflict-free exact DNS/routes, verify the hostname through the gateway, then mark it active. Failed/partial work stays pending with durable retries and opaque-link sharing. No separate application or household database, wildcard, host-accessible token or per-registration deployment is needed. The approved runtime setup needs a domain-account token scoped to ilymmd.com DNS Edit, Workers Routes Edit, and account Workers Scripts Read, stored only as the events runtime secret `HOUSEHOLD_DNS_TOKEN`, plus `HOUSEHOLD_ROUTING_ENABLED=true` on both Workers. A five-minute recovery cron wakes the same object. The owner-approved routing service and runtime credential are deployed; live activation remains pending until all hostname verification checks pass. Fixed stage/status diagnostics distinguish runtime denial from shared-handler failures without logging request or credential values. See [architecture, permissions, deployment and rollback](docs/household-subdomains.md).

## Private family workspace

Hosts open **Family workspace** alongside event tools. Owners create separate owner/administrator/member/kid sign-ins without requiring email for children. The workspace provides household-created folders, lists/categories with versioned collaboration, private home records/documents, tasks and recurring assigned chores and in-app reminders. There are no sample lists or required categories. Explicit child access is enforced on every record, enclosing folder, file, search/feed and notification; assigned chores never expose linked private records. Only the owner controls ownership and household administrators. The platform administrator still edits visual page defaults rather than individual household pages.

Files use existing private SQLite storage, limited to 2 MB each and 20 MB per household. Notifications are in-app only: no push, email or SMS delivery is configured. Read [permissions, operations and release safeguards](docs/family-workspace.md) before rollout. Tests use isolated synthetic records, including concurrent items, child revocation, imports, private downloads, recurrence, cross-domain code sign-in and mobile/desktop workflows.

See [visual/address/card release operations](docs/visual-address-card-release.md) for the current four-digit address-code rollout, optional invitation variable, full-page editor and recovery safeguards. The shared code is an address-group credential rather than a private individual password; names select the adult, and duplicate name/suffix matches in one group fail closed. Codes are not automatically embedded in links or QR images.

See [shared navigation](docs/shared-navigation.md) for the common workspace/Contacts browsers, fixed role-specific toolbars and release verification.

See [fixed toolbars and inline editing](docs/fixed-toolbars-inline-editing.md) for the five-category migration, inline Contacts, role-specific Settings and administrator management/defaults.

In Contacts, **Invite Guests** enables multi-selection; **Uninvited Guests** filters contacts not invited to any saved event. The sticky green **Select Event** action opens the host's event picker. Choosing an event adds invitations without sending messages or changing existing responses. Child selection includes the designated adult, and Cancel clears the unsaved selection.

Contacts displays the four-digit **Guest ID** beside its address title; everyone explicitly assigned to that address shares it. Individual RSVP identities stay separate. Unmatched address searches show **Not found** with a red border and **Create new address**. The inline form has Street / PO Box, City, State and Zip Code with browser autofill and prefilling from recognizable mailing text. Unfamiliar old addresses are retained. List/contact name buttons use equal padding on all sides. Routine connected/updated/sync banners are hidden; failures and conflicts remain visible.

[Optional Meyer AnyList sync](docs/meyer-anylist.md) adds host-only controls to the operator-selected existing household, using the same shared contacts code. It reads AnyList without changing it and preserves website invitations, responses, notes and address credentials. After starting a sync, progress and completed contacts update automatically while the page is open; unsaved editors remain protected. It uses the same `GITHUB_TOKEN`, `ANYLIST_EMAIL`, `ANYLIST_PASSWORD` and optional `ANYLIST_LIST_NAME` setting names as Gatherings, configured separately for Events. Secure Events-specific callback configuration and workflow publication are required; other accounts have no integration controls or API access. Dropbox remains unchanged.

Hosts no longer select a text-reminder consent checkbox. A submitted explicit adult RSVP records phone-scoped enrollment and one confirmation saying **Reply STOP to opt out**. It uses the existing disabled-by-default provider and honors STOP, unchanged phone/invitation eligibility and at-most-one delivery attempt. Other skipped adults/children are not enrolled by someone else's RSVP. Disabled submissions never send later when a provider is activated. No live messages are sent during validation.

Host and guest event pages share the same event-body layout, including information, RSVP/registries/upload buttons, table and personal plans. The household-name “invites you” line is removed. Hosts have their own toolbars; their RSVP button selects an invited person for a manual RSVP, using the same address-party validation and response versions. Hosts can record answers after the guest deadline without enrolling guest SMS consent or sending a confirmation. Read-only guest experience preview remains separate. In **Edit Event**, **Template** opens the shared invitation/card editor and **Table** opens the event menu editor with reusable private table templates. Save/update templates separately; applying one appends fresh items to the event draft, and deleting a template requires confirmation without changing existing events. Hosts can double-click their content (description, dates/time, address, artwork, upload link and menu items) to open the same focused editor. Legacy event notes are retained in storage but have no visible editor/menu. Shared interface wording and layout remain administrator-only.

An existing host can receive separate platform administrator permission while keeping their normal household/event pages and bottom toolbar. Their Home top toolbar adds Approvals, Hosts, Defaults and Templates. A current administrator grants this from Hosts using their password and the exact target email; the promoted host signs in again and verifies the tools before removing the old administrator through Hosts. Removal requires the promoted host's password and exact old email, revokes the old sessions and keeps setup permanently closed. This is account data on the shared application, with no special household build. Live promotion/removal requires an authenticated session and is not performed by tests.

The three-dot menu includes **Preview guest experience**, scoped to the host's household and read-only. Guests' Home uses the same event cards, showing only invited events with nearest upcoming dates first (then undated and recent past events). Editing toolbars are opaque in the selected container color; normal page/container transparency is preserved.

Host Home introduces **Contacts** in a container above **Family Workspace**, with an Open button for each, followed by invitations. Those destinations are no longer in the toolbar. **Household Link and QR** and **Settings** are in every host three-dot menu; appearance modes and inline Details are inside Settings; host bottom navigation is Home. Guests/family members and legacy administrators also open Settings from their three-dot menu. Existing role restrictions, Home-only promoted-administrator tools and guest invitation ordering stay intact. All dedicated notes fields/sections and maintenance-note text are removed from the interface; saved legacy notes remain stored and are preserved by normal edits.

In Contacts, **Uninvite Guests** starts contact selection followed by an event choice and confirmation. Selecting an adult includes their children; a child can be selected on their own. Only the chosen event's invitations change. Saved RSVPs block removal, and contact records, address codes, content and other events remain unchanged. No messages are sent. Cancel makes no changes.

Private household notes belong to saved contact addresses and appear in tiny text only in the owning host’s Contacts and RSVP dashboard. Edit notes uses a versioned address save; guest/public/preview/card/family payloads exclude them. AnyList category titles supply the household name and mailing address (`Title - Street / PO Box, City ST ZIP`), including structured city/state/ZIP without an extra comma. Sync preserves notes, address Guest IDs, person associations and saved responses.

The shared Containers appearance category includes an uploaded PNG/JPEG/WebP image (up to 2 MB) and independent image opacity from 0–100%. The image is a separate surface layer so text stays opaque; Save/Cancel, inheritance, copy and reset use the same shared editor. Editing toolbars remain solid. RSVP fills its action row, and summary counts fit narrow screens without a horizontal scrollbar.

Event Settings offers Default Mode and Custom Colors Mode. Default Mode follows the current home design, including custom home colors; Custom Colors Mode opens the complete event-only formatting editor. Switching to Default Mode clears appearance overrides without changing event content or responses.

Back returns to the actual previous page visited in the current signed-in session, including workspace folders, linked records, settings and search context. Home remains the landing-page action. If history is unavailable or access to the previous record was removed, Back reports that instead of sending the user elsewhere.

On signed-in Home, Contacts and Cards & Invites share the first row when space permits; Family Workspace remains below. Cards & Invites opens the existing cards/template manager. A single visible event spans the available width; multiple visible events use at most two columns, collapsing to one on small screens. Host event menus retain event details and Settings; invitation/menu editing is available through Home Invitation Cards and event details, while Share Invitation is in bottom navigation. The full-page card/template editor has extra space above its heading and buttons.

Contacts and Cards & Invites stay side by side on phones, with small descriptions. Shared address headings show the title/Guest ID and a private-notes pencil, followed by the mailing address. Sync AnyList sits beside Invite/Uninvite. Event cards combine card/invitation tools under Invitation Cards; event Settings offers bold Default Mode and Custom Colors Mode. Share Invitation is in the host event bottom toolbar. Preview guest experience is restricted to platform administrators on both UI and API.

Formatting separates Containers, Toolbars and Buttons, alongside Background, Titles, Description and Text. Each surface/label role is independent; legacy records preserve their old appearance and new saves retain that separation. Bottom navigation/menu button backgrounds, borders and image layers stay transparent; editing-toolbar controls use Buttons formatting. Copy Formatting and Reset to Defaults appear on separate menu lines. Card and template editors share the same reduced top gap.

All host pages using household formatting offer Light Mode, Dark Mode and Custom Colors Mode inside Settings through the same shared editor/preset system. Default events follow the full home appearance; explicitly custom events retain their own design. Card/template documents and drafts remain independent. Household Link and QR and Settings are available in every host page menu. Modes form a three-column icon row directly beneath Family Members. Appearance and Details have no separate panel backgrounds or borders; Details fields appear inline below Settings actions. Container background opacity supports 0–100%, with text remaining opaque and image opacity controlled separately. Event details place Potluck & drinks above Who’s invited?

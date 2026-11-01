# Shared pages, cards, reminders and account removal

All households use the same application. Content, formatting and layout are persisted separately; no household has a separate page implementation. The `events` Worker and its existing `EVENTS_DATABASE` / `ASSETS` bindings, `EventsDatabase` class and `events-platform-v1` object remain unchanged.

## Pages and inheritance

The administrator opens **Edit global defaults** for platform wording, formatting and structured layout. **Edit household / event pages** explicitly selects one household and optionally one event. Hosts use **Page wording & layout**, **Edit household**, and **Edit event**. The event editor includes appearance, optional upload link and private notes. Background image precedes background color. Home page actions are separate from the icon-over-label toolbar; Sign out lives in the toolbar.

Resolution is platform → household → event. Wording, role formatting and supported ordering resolve independently. Only changed scoped values are saved; explicit overrides survive default changes. Resetting scoped appearance returns it to inheritance. Event changes never change household login or sibling events. Titles, descriptions, body text, buttons and containers use shared roles. The administrator edits interface wording rather than event/household data by changing defaults. Selected-scope editing also permits the applicable public name/description/event content. Display-name changes never rename an existing household address.

The centralized copy catalog is generated with `npm run copy:catalog` from shared UI and server validation messages. `public/ui-runtime.js` renders edited copy as escaped text. Never translate protocol values, record IDs, URLs, field names or user content. When adding interface text, use the shared copy helpers and regenerate the catalog. Dynamic dates, names, counts and provider status codes remain data, not editable wording.

Layout is validated structured ordering, not arbitrary HTML/CSS: host home, guest home, event sections, login form, administration sections, navigation, home actions and event actions. Drag lists also have Move up/down buttons for keyboard and touch. RSVP and registries move together; registries stay directly below RSVP. Unsupported or duplicate keys are rejected server-side.

**Preview guest experience** selects a household and event or its login page. It uses an in-memory preview person, never creates a guest or RSVP, and disables mutation actions. The preview API returns safe public branding/event data, without private notes, contacts or reminders. Actual guests still see only their own invitations and party.

## One card editor and renderer

**Cards & templates** supports invitations, thank-you and holiday cards. Administrators manage shared templates; hosts manage private templates and saved cards. All use `public/card-system.js` for SVG preview/export and PNG rasterization. Existing artwork-only templates remain usable. Selecting a source creates a snapshot; source changes never overwrite a saved customized card.

Upload raster background artwork, add supported dynamic fields, set fallback text, drag position or use numeric position/size controls, and choose font/color/alignment. Supported fields use safe selected household/event/recipient information, never notes. Text wraps and clips inside its field bounds. Adjust long text in preview before exporting. Desktop or a large tablet is recommended for detailed positioning; phone controls and previews remain available.

QR is optional and uses the existing household share destination, including opaque fallback while routing is pending. It retains the QR library's white quiet zone and black modules. No token or authentication behavior changes. Preview, SVG, PNG and print all use the same rendered card. Raster output depends on installed fonts; inspect the preview on the exporting device.

**Download SVG/PNG** saves locally. **Share / text** deliberately opens supported native sharing with a PNG, or explains downloading/attaching it. **Email composer** opens the user's mail application; attach the download there. Neither action means delivered. **Print quantity** generates that many card copies, one card per page (1–50); the browser/printer still controls paper, scaling, copies and duplex settings. No email service or automated registration email is introduced.

## Contacts, notes and uploads

Phone numbers extend existing guest/address records. SMS-eligible guests need their own explicit consent and an international E.164 phone number (for example `+12025550123`); children are never SMS recipients. Address records and guest/address relationships remain intact. Hosts record consent only after obtaining it from the recipient.

Household notes and event notes are host-private. They are absent from public/guest/preview APIs and card field inputs. Upload links accept only HTTP(S) external destinations and are navigation only; the server does not fetch them. Hosts configure Dropbox File Requests, Google Drive, OneDrive or another service's upload permissions themselves. An empty link removes the guest button.

## SMS setup and limitations

No messaging provider existed. The shared server now has a Twilio REST adapter, signature-verified webhooks and durable scheduling; it is **off unless explicitly enabled by the operator**. No paid service, sender, billing or live message is provisioned by this release. All tests mock transport.

Before enabling real delivery, the owner must separately arrange/approve Twilio billing, a suitable SMS-capable sender, any required regional sender registration, and recipient consent. Then install encrypted runtime secrets `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` privately in the existing events Worker; set `TWILIO_FROM` to the approved sender. Do not commit credentials or paste them into chat. Configure `SMS_WEBHOOK_URL=https://events.kassandraraudman.workers.dev/api/messaging/twilio` and the Twilio sender's incoming-message webhook to that same exact HTTPS POST URL; configure delivery status callbacks. The app verifies `X-Twilio-Signature` against the exact canonical URL. Verify the provider's webhook configuration and opt-out behavior before setting `SMS_ENABLED=true`. Keep this flag absent/false until setup and real sending are separately approved. Current established five-minute cron recovers alarms; configured reminders run without an open browser or a Mac server.

Hosts schedule RSVP reminders for unanswered invitations or upcoming reminders for adults attending. They select an IANA timezone and local wall time; UTC is stored. Nonexistent/ambiguous daylight-saving times are rejected rather than guessed. Preview shows currently eligible recipients and message without dispatch. Eligibility, consent, opt-out, event existence and RSVP are checked again before sending. Guests sharing a phone receive at most one attempt for that event/reminder. An existing attempt is not repeated after schedule edits; create a new reminder deliberately for another message.

Signed STOP/STOPALL/UNSUBSCRIBE/CANCEL/END/QUIT messages create a global phone suppression retained across account removal; the application does not automatically lift it. Every outgoing body includes STOP instructions. Removing an invitation, withdrawing consent, disabling a reminder, deleting its event or deleting the account prevents future attempts. A message already accepted by the provider cannot be recalled.

Statuses distinguish accepted, sent, delivered, failed, undelivered, cancelled and unknown. REST acceptance is not delivery. Only signed provider receipts establish sent/delivered status. Timeouts, server errors and interrupted dispatches remain unknown and are never automatically retried, avoiding duplicate sends at the cost of possible nondelivery. The provider can charge for accepted messages and multi-segment text. The application does not guarantee delivery or purchase messaging services. The local Node adapter has no daemon scheduler; production scheduling uses the existing Cloudflare Durable Object alarm/cron.

## Administrator account deletion

**Delete account** first presents the exact email, affected domain, counts and irreversible data scope. Submission requires exact email/domain confirmation plus current household version and a content revision fingerprint. Only an authenticated administrator may request it. Tests use synthetic accounts only.

The transaction revokes sessions, disables tenant access, cancels reminders and retires the claimed name permanently. A durable cleanup job checks saved provisioning receipts. It deletes only exact dedicated DNS/route IDs whose hostname, AAAA target, proxy flag, ownership comment and gateway script match. It never deletes the base domain, wildcard/shared routing, unknown/manual resources or another household's resources. Custom-domain conflicts and incomplete inventories fail closed. Missing credentials/permissions leave a visible pending cleanup error and retry; they do not silently report success. An unclaimed household can be removed without domain API calls.

After cleanup verifies absence, this tenant's account, approval, household, contacts, events, responses, notes, cards, templates and reminder records are removed. Retired names, global SMS opt-outs and a minimal completion receipt remain for safety. No old address is released. Deletion is irreversible after confirmation; a code rollback cannot restore data.

## Release and rollback

Run the required Node, mobile/desktop and actual local Cloudflare runtime suites, formatting, both Worker dry runs and production dependency audit. CI is validation-only. Before publishing/deploying, verify production/preview build controls and selected account; preserve established disabled automatic/preview builds. Deployment authorization does not create credentials or override managed network policy.

Deploy the reviewed commit to the existing `events` Worker with `npx wrangler deploy --name events --config wrangler.jsonc` through the existing authenticated process. This feature adds no gateway code change and no DNS wildcard. Preserve `keep_vars`, both bindings, existing secrets, runtime flags, routes and five-minute cron. New SQLite tables are additive and initialized by the same existing object; no import, reset, namespace replacement or household backfill is performed. SMS stays disabled; no new provider secrets are required merely to deploy nonmessaging features.

Before release, record current application/gateway versions and a consistent recovery checkpoint. After release, verify setup closed, canonical/custom-host sign-in, opaque links/QR, guest RSVP, existing event content, editor inheritance and unchanged unrelated website responses. Do not delete a live account or send a real text as a smoke test. Local tests and a deployment build alone do not establish live correctness.

For rollback, first set `SMS_ENABLED=false`, `ACCOUNT_CLEANUP_ENABLED=false` and `HOUSEHOLD_ROUTING_ENABLED=false` in the events Worker as needed to pause background writes. Account-cleanup pause also prevents scheduling a hot retry loop. Keep the active gateway and authoritative retired/deleting claims fail-closed. Preserve the new additive tables and receipts. Do not roll back to code that ignores pending deletion/retired-claim access protections; review queued deletions and choose a compatible checkpoint or forward fix. Restore only the reviewed previous events version after that check, never a database reset or the gatherings resources. Do not re-enable automation until its queues/configuration are verified. SMS configuration/billing remains a separate provider task.

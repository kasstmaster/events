# Cloudflare deployment

This application deploys as its own **`events`** Worker and **`EventsDatabase`** SQLite-backed Durable Object namespace. It serves its own static frontend and stores its own data. It does not use or modify the gatherings site's Workers, routes, databases, buckets, secrets or deployments. Use the intended existing Cloudflare account, not a temporary Wrangler account.

## Why SQLite-backed Durable Objects

The shared application requires an atomic read/validate/reserve transaction when guests claim menu quantities. A SQLite-backed Durable Object preserves these existing synchronous transactions and the existing scrypt password hashes. D1 is not used: its asynchronous/batch transaction model would require a different reservation implementation. Both runtimes use the same authorization, validation, account, event, registry and RSVP code in `server/model.js` and `server/handler.js`.

- `server/node-store.js` and `server/app.js` adapt local Node.js SQLite/HTTP.
- `cloudflare/worker.js` adapts Cloudflare SQLite storage and Fetch requests; it is not a second application.
- `public/` remains the one shared frontend.
- Large JSON records are stored as ordered chunks inside the same transaction so 2 MB uploaded images do not exceed Cloudflare SQLite's per-row size limit. Household slug and invitation-template references stay indexed. Unicode pairs and optimistic versions are preserved.

A single named object (`events-platform-v1`) owns this initial application's centralized database. This is suitable for the initial deployment, not a claim of unlimited throughput. Quotas and billing follow the selected Cloudflare account/plan; no command in this repository enables a paid plan. SQLite-backed Durable Objects are available on Workers Free subject to its limits. Review current account usage before inviting hosts. Future sharding must preserve the same shared application and tenant isolation.

## 1. Authenticate to the correct account

From this repository on Node.js 24:

```sh
npm ci
npx wrangler whoami
```

On your own computer you can use `npx wrangler login`. In automation, supply `CLOUDFLARE_API_TOKEN` securely and select the intended `CLOUDFLARE_ACCOUNT_ID`. Use account-scoped **Workers Scripts: Edit** and **Account Settings: Read** access. Restrict the token to the account that should own this app. No zone/DNS, existing gatherings database, R2 or email permissions are required for the default workers.dev deployment. The account identifier is not a password; the token is. Never commit either a token or local `.dev.vars` files.

The managed development environment may inject credentials through its HTTPS proxy. Preserve that proxy and TLS verification; configure the token securely for `api.cloudflare.com`. A configured draft is not applied authentication. Verify `wrangler whoami` and confirm the account selection before deployment. If multiple accounts are shown, select the intended account explicitly rather than assuming.

## 2. Validate, then deploy the new application

```sh
npm test
npm run test:mobile
npm run test:cloudflare
npm run format:check
npm run deploy:cloudflare
```

`wrangler.jsonc` names only the new Worker, assets binding and new SQLite class migration. There are deliberately no custom domain routes, so no existing gathering hostname or path is replaced. Wrangler prints the new HTTPS workers.dev URL. If this worker name already belongs to an unrelated application, stop and select a new events-only name instead of overwriting it.

Deployment does not merge a branch. Deploy only the reviewed/tested commit selected by the owner. No GitHub workflow automatically deploys on a push. This deployment command needs working Cloudflare credentials; a dry run does not create a live site.

## 3. Set up the administrator in your browser

The owner does not need Node.js, Terminal, a local server, or an email service. After deploying this version:

1. In Cloudflare, open **Workers & Pages → events → Settings → Variables and Secrets**.
2. Add a **Secret** named `ADMIN_SETUP_TOKEN`. Generate a unique random 32–256 character value using a password manager. Save it securely and deploy the secret update. This token is not your administrator password. Do not put it in a URL, source file, screenshot or chat.
3. Open `https://events.kassandraraudman.workers.dev/setup`. Enter the setup token, your chosen administrator email, a new password of at least 12 characters, and its confirmation.
4. Choose **Create administrator**. The server checks the secret and request origin, hashes the password with scrypt and atomically creates exactly one administrator. It signs you in automatically. No emails are sent.
5. After confirming the administrator screen opens, delete `ADMIN_SETUP_TOKEN` from the **events** Worker's secrets and deploy that secret removal. The account and setup-completion marker remain in persistent storage.

Without a sufficiently long configured token, the setup form cannot create any account. Setup attempts are limited to five per IP and twenty globally per 15 minutes. The setup token, password and confirmation are never returned in API responses or saved in browser storage. They are submitted in an HTTPS request body, not a URL.

After completion, `POST /api/setup` returns 410 even if the token remains configured or is replaced. A persistent completion marker prevents setup from becoming an account-replacement flow. Concurrent submissions can create only one administrator. If `BOOTSTRAP_ADMIN_EMAIL` is already configured, the browser form must use that address. Existing administrators are never changed by deploying this feature.

The earlier `npm run cloudflare:bootstrap` hash-upload tool remains an optional operator alternative; it is not required for browser setup. If legacy bootstrap secrets are already configured, the existing one-time hash initialization remains compatible. Remove any legacy bootstrap secrets after successful initialization. Never delete the Durable Object namespace, change its class or change `events-platform-v1` to reset setup: those actions would disconnect live data. Account recovery is a separate operator procedure.

## 4. Verify the live site

Use non-mutating requests first:

```sh
# Substitute the actual new workers.dev hostname printed by Wrangler.
curl -fsS https://YOUR-EVENTS-WORKER.workers.dev/
curl -fsS https://YOUR-EVENTS-WORKER.workers.dev/api/session
```

Before setup, `/api/setup` returns only `required` and `enabled` flags; `/api/session` returns setup-pending HTTP 503. After setup, an anonymous session response must be `{"role":null}`. Protected host endpoints must return 401 without a session. Confirm the first Host Login in a browser. Do not run the synthetic test suites against live users or data. The automated runtime test uses a temporary database and never deploys.

`APP_ORIGIN` is optional for workers.dev: the Worker uses the HTTPS request origin for same-origin checks, Secure cookies and stable QR links. If a separately approved custom hostname is added later, set `APP_ORIGIN` to that exact canonical HTTPS origin. Do not configure it to the gatherings site's existing origin. Cookie paths, authentication and all data remain separate from that site.

## Persistence and operations

Cloudflare's SQLite-backed Durable Object storage persists across Worker deployments and includes its managed point-in-time recovery facilities, subject to platform retention limits. Establish and test an operator recovery/export process before relying on the app for irreplaceable information. Do not treat local `.wrangler/` test storage as a cloud backup. The Node developer database is not uploaded or migrated by deployment.

Cloudflare sets `CF-Connecting-IP`; the edge adapter overwrites the internal client-IP header before forwarding into the private Durable Object. The generic Node server still ignores untrusted forwarding headers. Name-only guest identity limitations remain unchanged; see [security.md](security.md).

There is no automatic live deployment in CI. CI validates the Node application, mobile browser flow and actual local Workers/Durable Objects runtime, including bootstrap, two-host isolation, a mobile child RSVP, racing claims, large images, versions and persistence after a runtime restart.

## Optional household routing gateway

[Household subdomains](household-subdomains.md) extend this same Worker/database through an exact-host gateway in the separate domain account. Follow that guide for the current inspection evidence and deployment credential checks, new `EVENTS_GATEWAY_SECRET`, exact `EVENTS_ORIGIN`, operator-controlled `HOUSEHOLD_HOSTS`, provisioning, verification and rollback. `wrangler.gateway.jsonc` targets only the new gateway in Plex and initially contains no routes or configured origin; do not deploy it as a working feature. The existing events namespace/class/object name and stored data must remain unchanged. Automatic/preview build safety must be verified before pushing the review branch. No wildcard or CNAME-only cross-account design is used.

## Automatic household routing (reviewed release required)

The existing events DO now contains the durable routing service, driven by registration outbox jobs, alarms and a new five-minute recovery Cron Trigger. No new DO namespace/class/database or data import is required. Gateway and app must both run the compatible reviewed source with `HOUSEHOLD_ROUTING_ENABLED=true`. Store the domain-owner's narrow token only in the events encrypted runtime secret `HOUSEHOLD_DNS_TOKEN`; never use a frontend/build variable. The gateway does not receive that token. Preserve the shared HMAC secret, exact origin and any static host/route inventory. See [complete permissions, exact two-account procedure, verification and rollback](household-subdomains.md). Runtime provisioning performs no Worker deployments or settings updates, and never edits/deletes existing DNS/routes. Do not deploy the empty gateway route template over existing routing. This follow-up remains approval-gated; no automatic builds are enabled.

## Shared editors and background jobs

See [shared feature operations](shared-editors.md) for the additive `household_deletions`, `reminder_deliveries` and `sms_optouts` tables, the shared card/page editors, confirmed receipt-based account cleanup, and rollback pauses. The same object/alarm/cron owns these jobs; bindings, namespace and object names do not change. SMS remains off until separately approved provider setup. `HOUSEHOLD_DNS_TOKEN` remains server-only; deletion uses it solely for exact resources proven exclusively owned by receipts, never base/shared DNS or unrelated sites. No gateway redeployment is needed for this feature set.

## Family workspace and guest-code release

The additive family/member/shared-identity schema and rollout are documented in [family workspace operations](family-workspace.md). New private files remain in the existing SQLite Durable Object. Family scheduling reuses the existing alarm/cron; retain all current Worker configuration and `global_fetch_strictly_public`. No gateway deployment, extra storage binding, paid notification provider or external message is part of this release. Keep SMS and automatic/preview builds disabled.

The reviewed source is the application merge on `feat/household-subdomains`; `main` has a separate manual release pin. Pin the actual reviewed merge only after validation, then use the existing events-only manual workflow with a fresh live version/recovery checkpoint. Never substitute the older main application tree or silently roll back to name-only authentication. Existing users must privately distribute permanent guest codes before guests can sign in again; no links, QR destinations or responses are replaced.

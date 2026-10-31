# Cloudflare deployment

This application deploys as its own **`gather-events-platform`** Worker and **`EventsDatabase`** SQLite-backed Durable Object namespace. It serves its own static frontend and stores its own data. It does not use or modify the gatherings site's Workers, routes, databases, buckets, secrets or deployments. Use the intended existing Cloudflare account, not a temporary Wrangler account.

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

## 3. Set up the administrator securely

The Worker intentionally returns a setup-pending error for its API until an administrator has been provisioned. This prevents public registration or an exposed first-user-wins setup screen.

On your own computer, provide `ADMIN_EMAIL` and `ADMIN_PASSWORD` through a secure shell environment, then run:

```sh
npm run cloudflare:bootstrap
```

Use the owner's chosen administrator email and a password of at least 12 characters. Do not put the password in command history or send it through chat. The command hashes the password locally using the same scrypt implementation and uploads only `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_HASH` as encrypted Worker secrets. It does not print their values, send emails, approve any hosts or overwrite an existing administrator. Clear the local password variable afterward.

The next API request inserts the initial administrator once, atomically. Sign in through **Host Login** and approve the desired host email addresses. Once the first login succeeds, remove both bootstrap secrets in the new Worker's settings; the administrator remains in the persistent database. Updating bootstrap secrets is not a password reset. Never delete the Durable Object namespace, change its class or change the singleton name to recover an account: those actions would disconnect live data.

## 4. Verify the live site

Use non-mutating requests first:

```sh
# Substitute the actual new workers.dev hostname printed by Wrangler.
curl -fsS https://YOUR-EVENTS-WORKER.workers.dev/
curl -fsS https://YOUR-EVENTS-WORKER.workers.dev/api/session
```

After bootstrap, an anonymous session response must be `{"role":null}`. Protected host endpoints must return 401 without a session. Confirm the first Host Login in a browser. Do not run the synthetic test suites against live users or data. The automated runtime test uses a temporary database and never deploys.

`APP_ORIGIN` is optional for workers.dev: the Worker uses the HTTPS request origin for same-origin checks, Secure cookies and stable QR links. If a separately approved custom hostname is added later, set `APP_ORIGIN` to that exact canonical HTTPS origin. Do not configure it to the gatherings site's existing origin. Cookie paths, authentication and all data remain separate from that site.

## Persistence and operations

Cloudflare's SQLite-backed Durable Object storage persists across Worker deployments and includes its managed point-in-time recovery facilities, subject to platform retention limits. Establish and test an operator recovery/export process before relying on the app for irreplaceable information. Do not treat local `.wrangler/` test storage as a cloud backup. The Node developer database is not uploaded or migrated by deployment.

Cloudflare sets `CF-Connecting-IP`; the edge adapter overwrites the internal client-IP header before forwarding into the private Durable Object. The generic Node server still ignores untrusted forwarding headers. Name-only guest identity limitations remain unchanged; see [security.md](security.md).

There is no automatic live deployment in CI. CI validates the Node application, mobile browser flow and actual local Workers/Durable Objects runtime, including bootstrap, two-host isolation, a mobile child RSVP, racing claims, large images, versions and persistence after a runtime restart.

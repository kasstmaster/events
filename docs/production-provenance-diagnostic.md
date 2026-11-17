# Production application provenance: staged read-only investigation

Stage 1 is prepared, not executed. Stage 2 is deliberately unimplemented and
unactivated until production evidence passes. This branch does not change
`automatic-events-release.mjs`, the release policy, application files, or the
automatic/manual deployment workflows. It cannot unblock a release by itself.

## Fixed evidence and acceptance conditions

The diagnostic compares active version
`6ad2eca8-f6fe-44e0-8683-a448a613d4ab` with verified version
`b43cd66d-43de-44a5-bdb2-f62c4c2ba371`, associated with merged application commit
`39bf57fd6b3f1a3e11176d1aeadbbdc31aa31138`. Approved main is
`c5e402a9fc5ce3803830aebf9526a59f1a28f789`.

The historical verification receipt comes from successful release run
`43939613620`, attempt 2, artifact `14280212512`. The exact extracted
`events-verification.json` SHA-256 is pinned as
`63a8f799a09320c77f8cca31ee41eab4c4f6c979ae5ca12f0a250acd5bae9dd0`.
This hash was calculated from the existing GitHub verification artifact, not
from new production reads. An expired/missing artifact or different receipt
fails closed; do not replace the hash with an unverified file.

Cloudflare's SDK documents a GET to
`/accounts/{account}/workers/workers/{worker}/versions/{version}?include=modules`.
The response includes `main_module` and `modules` with `name`, `content_type`
and `content_base64`. See the provider's
[version GET and module types](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/workers/beta/workers/versions.ts).
The diagnostic hashes every returned module's actual bytes, including WASM,
sourcemaps and routing files, and includes names/types/entrypoint in the identity.
No message, ETag, dashboard source or UUID substitutes for those bytes.

It also requires identical provider-returned asset upload references/configuration
for both versions, and fetches every reviewed asset from the pinned commit's
appearance manifest on the canonical and representative household origins.
Asset references are hashed in memory, never decoded, printed or uploaded.
If the provider omits module bytes or asset references, this is a blocker,
even if the public pages look correct. It never enables preview URLs to inspect
historical assets or substitutes the current main manifest for the baseline.

Existing `safeSettings`, runtime schema validation and runtime fingerprinting
verify the approved EventsDatabase namespace/class, compatibility settings and
full baseline runtime. Only the five previously authorized Firebase additions
are removed when comparing with the historical fingerprint. Both activation
flags must be explicit plain-text `false`; project/auth-domain/API-key shape
must match the requested configuration. All other settings/binding differences
fail. Secrets are checked by their provider-visible binding descriptors only:
Cloudflare does not return their values, so this cannot prove secret-value
equality. No credential or secret value is changed or exposed.

The script verifies `events-v1` lineage, exact historical routes/domains/cron,
production service environment and disabled previews. It rechecks deployment
identity and the full settings fingerprint after reading public assets, to reject
concurrent changes. No account, session, invitation or RSVP endpoint is accessed.

## Owner approval and execution

Do not run until the owner explicitly approves the reviewed diagnostic.
Codex has not dispatched it. The only network operations in this diagnostic are
GETs to fixed Cloudflare resources and the two existing public asset origins.
The job never installs/runs Wrangler, publishes, deploys, mutates configuration,
reads database contents or sends messages. It shares the production concurrency
lock to avoid overlap with a release, without cancelling existing work.

The existing registered **Check Cloudflare authentication (read only)** workflow
has an opt-in `provenance` mode that calls the new dedicated workflow from this
branch. Its default remains the existing metadata check. This bridge permits
testing the feature-branch workflow without first merging a new workflow into
main. With an already authorized GitHub CLI, after review and approval the owner
can run exactly:

```sh
gh workflow run check-cloudflare-auth.yml --repo kasstmaster/events \
  --ref fix/production-provenance-diagnostic \
  -f diagnostic=provenance -f confirm=VERIFY_READ_ONLY
```

This is a command for the owner after approval, not one Codex has executed.
Do not dispatch a deployment workflow. No new credential is needed: the job uses
the existing GitHub-held `CLOUDFLARE_API_TOKEN` and read-only GitHub artifact access.
Only actor `kasstmaster` in repository `kasstmaster/events` with the exact
confirmation can reach the credential-bearing step. The job checks out the
dispatch commit with full Git history and without persisted Git credentials.

Open the run under Actions. Download only the
`events-provenance-diagnostic-<run>-<attempt>` artifact. Its JSON contains fixed
identifiers, fingerprints and check/blocker codes only. Never upload the downloaded
historical artifact, provider payloads, source modules or runtime settings.
Return the sanitized JSON for review. The script exits nonzero on missing evidence
or mismatch. `verified-diagnostic-only` is evidence, **not release authorization**.

An inaccessible beta endpoint, missing historical artifact, absent asset reference,
unexpected schema, changed version/configuration or unmatched bytes must be
investigated. Do not loosen checks, replace provenance or change credentials to
produce a green result. If the active version has changed, review that new state
before changing this diagnostic's fixed inputs.

## Stage 2, after verified evidence

The permanent design remains pending. Its implementation should:

1. Bootstrap trusted application identity from the reviewed Stage 1 result and
   existing successful release receipt, preserving the verified merged SHA.
2. Add full code/asset fingerprints and Git SHA to mandatory per-release receipts
   from successful owner-merged release jobs, with durable trusted storage and
   verified artifact provenance/retention. Expired/missing receipts must block.
3. Resolve an active configuration-only version to a trusted release by byte/asset
   identity, then require that release's SHA to be an ancestor of the exact proposed
   owner-merged main commit. Never resolve by dashboard message/source/UUID alone.
4. Distinguish explicitly permitted ordinary configuration changes from protected
   infrastructure/activation settings. Preserve current values across deployment;
   require both Firebase flags false. Never silently accept arbitrary configuration.
5. Keep all existing owner/main gates, source/appearance checks, SQLite identity,
   migrations, routes, cron, compatibility checks, fresh recovery checkpoints,
   successful pre-publication artifact upload, shared concurrency/latest-main
   checks, and post-deployment verification. Preserve manual recovery separately.
6. Test legitimate dashboard changes, missing/untrusted/expired receipts, byte and
   asset changes, unrelated/newer/equal SHAs, changed protected configuration,
   stale/concurrent reads and preservation after publishing with synthetic providers.

This allows ordinary permitted variable updates without per-version manual
reconciliation, once the permanent mechanism is proven. A one-off UUID allowlist
or accepting non-SHA messages would not provide that guarantee.

Local validation uses only synthetic module bytes, asset references, settings and
provider responses:

```sh
node --test scripts/production-provenance-diagnostic.test.mjs
```

Real Cloudflare, account data, Firebase/SMS and production flows are not used in
those tests. No live verification or permanent repair is claimed from local tests.

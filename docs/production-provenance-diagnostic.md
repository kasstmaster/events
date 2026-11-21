# Application and static-asset provenance

The repair is implemented in repository code, but has not been exercised against
production or deployed. No new diagnostic was dispatched while preparing it.
The earlier diagnostic proved module equality and stopped because an upload-only
asset JWT was absent. This implementation never requires that JWT.

## Evidence and limits

Cloudflare's documented version GET supports `include=modules`, returning actual
module bytes. The script hashes every module (including maps, WASM and asset
routing files), its name/type, and the entrypoint. It compares immutable historical
version modules with active-version modules. Messages, ETags, dashboard source and
version UUIDs never replace this proof.

Provider reference:
[version GET, module and asset configuration types](https://github.com/cloudflare/cloudflare-typescript/blob/main/src/resources/workers/beta/workers/versions.ts).
Pinned Wrangler uses an asset JWT when uploading; its upload form is not evidence
that the same token is available through a version GET. The supported API examined
here provides no complete historical static-asset download/list operation. No preview
URL, extra route or provider setting is enabled to compensate.

Historical asset evidence comes independently from the successful release receipt:

- Run `43939613620`, attempt 2, artifact `14280212512`.
- Worker `b43cd66d-43de-44a5-bdb2-f62c4c2ba371`.
- Application commit `39bf57fd6b3f1a3e11176d1aeadbbdc31aa31138`.
- Exact original verification JSON SHA-256:
  `63a8f799a09320c77f8cca31ee41eab4c4f6c979ae5ca12f0a250acd5bae9dd0`.

That immutable, pinned receipt attests the historical verifier compared **all**
reviewed public assets on both existing origins after verifying the actual deployed
version and commit. The manifest is loaded from that historical Git commit, checked
against every tracked file in its public tree, and each Git blob is hashed again.
It contains 27 files for this bootstrap release. Today's live bytes are not used
to invent a historical manifest or attest the old version retrospectively.

The active version's entire relevant public asset set is then fetched on both
`events.kassandraraudman.workers.dev` and `name.ilymmd.com`, with redirects refused
and caching disabled. Every byte hash must match the historical manifest. This is
combined with immutable module-byte equality, stable deployment/settings reads,
and independently verified `assets.config.run_worker_first=true` with the approved
root/default asset routing. Other asset routing requires separate infrastructure
review and stops before publishing. Missing configuration metadata is a blocker.

This proves the complete **reviewed application-served asset set**, not the contents
of an inaccessible provider storage bucket. The approved Worker routes all requests
through the shared handler's finite asset map; it does not expose arbitrary ASSETS
paths. Unreferenced provider objects are not application assets. Additional `_headers`
and `_redirects` modules are included in module identity; unreviewed control files
in a source manifest are rejected. Module equality alone never authorizes assets.
If any of these conditions cannot be established, the repair fails closed.

## Permanent release behavior

Before production preflight, the publish job selects the newest successful run of
this repository's owner-merged release workflow. It confirms the exact associated
owner-merged main PR and head SHA, matching run attempt, artifact name, unexpired
status and provider archive digest. It never falls back to an older successful
release just because the latest receipt is unavailable.

The archive is downloaded using GET only. The initial GitHub credential is never
forwarded to its signed blob URL. Redirect targets are restricted to GitHub/Azure
artifact hosts; the full ZIP SHA-256 must match GitHub metadata before extraction.
Only expected JSON entries are accepted, with size and duplicate checks. Only the
verification JSON is extracted, privately, outside the checkout. Ubuntu's `unzip`
is required; there is no executable content or generic archive extraction.

The bootstrap additionally requires the exact original receipt hash above. Later
successful releases record an `application` receipt containing the merged commit,
module fingerprint, complete asset-manifest fingerprint/count, normalized asset
routing fingerprint and protected configuration fingerprints. Receipts are accepted
only from trusted successful release runs. Missing modern fields do not fall back
to a version message. Future receipts bind observed code to the exact Wrangler
version produced from the reviewed merged source, after live asset verification.

For a dashboard-created version, preflight independently compares code and all
reviewed asset bytes with the selected trusted release. Only then does it resolve
application identity to the receipt's SHA and perform the existing forward-only
Git ancestry check. Equal, newer or unrelated releases still stop. It never rewrites
Cloudflare annotations. Every checkpoint and pre-publish snapshot repeats the
relevant checks, and post-deployment verification records the new provenance.

Configuration handling is separate. The three public Firebase configuration fields
must have the approved project/domain/key shape, and both activation fields must
be explicit `false`. These five fields alone are excluded from the protected
historical fingerprint, permitting ordinary public-key/configuration updates while
preserving their current values through deployment. Arbitrary new variables,
changed protected values, secret descriptors, namespace/class, migrations, routes,
cron, compatibility settings, preview state, service environment or other runtime
changes cannot pass. Other ordinary variables can be added to the explicit policy
through an owner-reviewed code change; there is no unsafe catch-all allowlist.
Cloudflare does not reveal secret values; only their binding descriptors can be
compared. Existing keep-vars/keep-secrets behavior remains unchanged.

All existing owner/main gates, integrated-source/appearance checks, local validation,
shared concurrency lock, latest-main checks, fresh recovery checkpoint, mandatory
checkpoint upload and pre-publish digest verification remain. The separate manual
recovery workflow/helper and production database identity are unchanged.

Successful verification artifacts are mandatory and retained for 90 days, subject
to GitHub policy. The recovery timestamp remains approximately 30 days; longer
receipt retention does not extend SQLite recovery. If receipts expire or an actual
published release never completes verification, stop for reviewed recovery evidence;
never silently adopt the currently running code. Routine variable updates within
an available trusted receipt's lifetime need no per-version reconciliation.

## Owner-run validation before merging

After reviewing and approving the branch, use the existing read-only workflow:

1. Open GitHub Actions → **Check Cloudflare authentication (read only)**.
2. Click **Run workflow** and select branch `fix/asset-provenance-release-repair`.
3. Select diagnostic `provenance`, enter confirmation `VERIFY_READ_ONLY`, and run.
4. Download the sanitized `events-provenance-diagnostic-…` artifact for review.

Alternatively, with an already authorized GitHub CLI:

```sh
gh workflow run check-cloudflare-auth.yml --repo kasstmaster/events \
  --ref fix/asset-provenance-release-repair \
  -f diagnostic=provenance -f confirm=VERIFY_READ_ONLY
```

Codex has not executed this command. It uses only the existing GitHub-held credential.
The diagnostic is pinned to active version
`3f5968c5-8813-4a77-adfa-d46c4d480e92`, following the owner-reported correction
to the activation flag. The previously inspected `6ad2eca8-f6fe-44e0-8683-a448a613d4ab`
is not adopted as the current deployment. If the active version changes again, the
report includes the observed UUID and deployment ID but still fails closed.
The diagnostic still verifies the original receipt bytes, migration lineage,
full historical manifest, current module/asset bytes and all later configuration,
routing, cron, service and stability checks. Its output is sanitized IDs, hashes,
counts and fixed outcomes only, never raw code, bindings, URLs or credentials.

Share only the sanitized diagnostic artifact. `verified-diagnostic-only` does not
publish or authorize a release by itself. Missing historical receipt/modules/asset
routing metadata, incomplete manifests, altered bytes or unexpected configuration
produce an explicit blocker, not success. Firebase failures additionally report only
the allowlisted field name and `missing-binding`, `wrong-binding-type` or
`invalid-value`; no configured value is emitted. Diagnostic and release validation
share the same Firebase validator. Do not change credentials or weaken
checks to obtain a green result.

Then create the PR, wait for validation and review/merge it yourself. **Merging can
initiate the existing production workflow**; it will publish only if all real gates
pass. Do not retry the old deployment runs for #89/#90/#91, which are stale main
commits. No additional label or per-dashboard-version allowlist is required.

Local tests use synthetic provider responses and temporary data only:

```sh
node --test scripts/application-provenance.test.mjs \
  scripts/production-provenance-diagnostic.test.mjs \
  scripts/automatic-events-release.test.mjs \
  scripts/manual-events-release.test.mjs scripts/cloudflare-metadata-check.test.mjs
```

The pinned diagnostic version is an investigation target only. The permanent
automatic guard discovers the active UUID each run and compares its application
identity against trusted successful release evidence; it has no per-dashboard-version
allowlist. A configuration-only transition from the previously inspected version to
the new version is covered by regression tests, including the real Git ancestry
check. Running this branch's read-only diagnostic is still required to verify the
owner-reported configuration correction and all later checks on production.

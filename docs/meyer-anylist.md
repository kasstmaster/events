# Optional household AnyList contacts

Events keeps one shared application and contact model. A private runtime setting selects the existing verified host email; only that host's household receives the Sync AnyList control and automatic progress updates. Names, slugs and browser parameters never enable the integration. Other hosts, household members, guests and the platform administrator cannot invoke the host integration. An optional exact household ID also pins the target. Dropbox is unchanged; its requested integration was canceled.

## Data and reconciliation

The authenticated host starts a bounded job. The Worker uses Cloudflare-supported manual redirect handling and accepts only successful dispatch responses; redirects are never followed, so authorization cannot be forwarded to a different destination. Events dispatches only `kasstmaster/events`'s `sync-meyer-anylist.yml` on `main`. The job uses a small scoped HTTPS adapter and pinned `protobufjs@7.6.6` to read the selected Address Book. Its wire mapping follows the reference AnyList client; the vulnerable old client and its legacy dependencies are not installed. The adapter logs only fixed outcomes and never caches credentials. Pull never writes to AnyList. Explicit Update AnyList / Sync both jobs may update the selected Address Book only; neither Gatherings repository is written. Categories become address groups; category mailing text populates the shared structured address fields when recognized. Items become adults and recognized name-only note lines become their designated children, matching the reference Address Book convention. Suffixes are retained. Unsupported or ambiguous names are skipped. This unofficial adapter may need updates when AnyList changes.

Stable source identifiers map to normal household-scoped address/contact IDs. The first import may adopt one exact, unique name within one exact matching address; duplicate candidates or records already mapped to another source are skipped, never merged. Subsequent linked updates retain IDs, address Guest IDs and website-owned private notes and non-conflicting phone edits, invitations, responses, consent and identity relationships. Missing source records are retained. Person mappings use the globally stable AnyList item identifier across categories. Ambiguous external moves/associations are skipped rather than guessed. Explicit Gather moves can be exported using stable source mappings; current address credentials rotate only when the actual Gather address assignment changes. Sync never grants event invitations or sends messages. Four-digit Guest IDs remain address credentials; internal person IDs remain necessary for separate RSVPs and relationships and are not displayed as Guest IDs.

A job snapshots contact/address versions before dispatch. Any edit during the read rejects the whole import; the host must start a fresh sync. The import is transactional and idempotent per job. Errors, expired jobs and ambiguous matches never trigger destructive fallback. A running job expires after 15 minutes. After Sync AnyList starts a job, the normal authorized host refresh includes its current status. Contacts shows pending progress, automatically adopts completed imports and announces completion once; no Check sync status button or permanent connected/updated banner is needed. Refresh/adoption still pauses during unsaved editors or contact selection. This does not schedule new imports or increase AnyList calls. Starting a new sync is limited to six attempts per 15 minutes.

The callback accepts only the Events canonical origin, the private import secret, a current job ID and the configured existing target household. It cannot choose another household. Secrets and provider tokens never reach browser payloads or logs. The reader disables credential-file caching and suppresses dependency diagnostics; workflow logs contain fixed outcomes only. No workflow artifact contains contact data. The whole reader runs in GitHub Actions; it is not bundled into the Worker or exposed as a public asset.

## Secure activation after review

The implementation is disabled until configured. Existing Gatherings secrets cannot be read or transferred through GitHub APIs. Configure the existing values privately in Events; never paste them into chat or source files.

On the existing **events Worker** in the approved account:

| Secret / runtime setting | Value                                                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MEYER_HOST_EMAIL`       | The owner-confirmed existing Meyer host sign-in email. Resolve it against the server's verified registered host record; do not use a display name.               |
| `MEYER_HOUSEHOLD_ID`     | Optional additional exact opaque household ID guard. A mismatch disables the integration.                                                                        |
| `GITHUB_TOKEN`           | Fine-grained GitHub credential limited to `kasstmaster/events`, with Actions read/write for workflow dispatch. No cross-repository or Contents write permission. |
| `ANYLIST_IMPORT_SECRET`  | A new random value of at least 32 characters, also saved under the same name in Events' GitHub Actions secrets.                                                  |

Gatherings uses these same `GITHUB_TOKEN`, `ANYLIST_EMAIL`, `ANYLIST_PASSWORD` and `ANYLIST_LIST_NAME` names. An existing token can be reused if its repository access includes Events and Actions read/write. Saved secret values are scoped to their Worker/repository and are not automatically shared. The legacy Events `EVENTS_ACTIONS_TOKEN` remains a fallback only when `GITHUB_TOKEN` is absent; `GITHUB_TOKEN` takes precedence. Optional Gatherings-style Worker variables `GITHUB_WORKFLOW_REPOSITORY` and `GITHUB_WORKFLOW_BRANCH` must be `kasstmaster/events` and `main` respectively, or omitted. Other values fail closed. Do not copy Gatherings' state repository settings or dispatch its workflow. Events needs its own `ANYLIST_IMPORT_SECRET` callback secret because its authoritative data is in the existing Events database, not a GitHub state file.

Under **kasstmaster/events → Settings → Secrets and variables → Actions**, add secrets `ANYLIST_EMAIL`, `ANYLIST_PASSWORD` and the matching `ANYLIST_IMPORT_SECRET`. Optionally set variable `ANYLIST_LIST_NAME`; the default is `Address Book`. Only the job receives the AnyList login. No state-repository token, new database, external storage, paid provider, new cron or Mac installation is required.

The workflow and the complete `integrations/anylist/` reader directory must be reviewed and present on `main` before the button can dispatch it. Deploy the reviewed application merge through the existing manual release procedure; do not deploy main's older application tree. Keep automatic production/preview builds and SMS disabled. Preserve existing bindings, secrets, routes, cron and namespace/object names. Do not run the Gatherings sync as an Events workaround.

Validation uses isolated fake households and mocked dispatch/import transport. Live AnyList authentication, a production sync and secure activation are separately unverified until the owner configures the settings and chooses Sync. Never manufacture live contacts or send real messages for verification.

## Cloudflare dispatch compatibility

Cloudflare native Fetch rejects `redirect: "error"` before sending a request. The dispatch uses `redirect: "manual"` and rejects non-success statuses, including every redirect. Native-runtime regression coverage bundles the actual dispatcher into workerd, intercepts all outbound requests with a synthetic provider, proves a 204 starts the job and a redirect fails after exactly one request. No real GitHub workflow, AnyList read or production import is invoked by these tests. Node-only mocked dispatch tests do not establish native Fetch compatibility.

## GitHub credential rejection

HTTP 401 from the fixed GitHub workflow-dispatch endpoint means GitHub rejected the configured credential value; it is distinct from a transport failure or the Cloudflare deployment credential. Error messages name the actual Worker secret selected: GITHUB_TOKEN takes precedence when present, otherwise EVENTS_ACTIONS_TOKEN. Neither value is returned or logged. A token's display name, a Cloudflare token or an AnyList password cannot authenticate GitHub. Configure the full active GitHub personal access token privately (without Bearer/quotes); existing stored values cannot be read back through APIs. Do not replace tokens or broaden permissions based on transport errors alone. HTTP 403/404 instead points to repository/workflow access and needs separate review.

AnyList categories supply shared-address data using `HOUSEHOLD TITLE - Street / PO Box, City ST ZIP` (a comma before the state is optional). Suite/building/PMB commas remain part of the street field. Each sync also refreshes structured address fields when source category text is unchanged, repairing earlier unsplit imports without replacing address/person IDs or four-digit Guest IDs. Unfamiliar mailing formats remain intact in Street / PO Box. Private website address notes survive category address updates.

## Explicit outbound reconciliation

Sync AnyList opens Pull from AnyList, Update AnyList and Sync both. All modes
read current source data before reconciliation. Separate local/remote baselines
keep Gather’s changed fields in a conflict while accepting independent remote
additions. Outbound plans exclude private notes, credentials, usernames, recovery
phones, invitations and responses. They never delete absent people/categories.
Explicit adult `Phone:`/`Tel:` note fields support international numbers; unknown
notes and unsupported phone formats survive.

A prepared plan must claim the current Gather revision. A 120-second lease blocks
contact/address changes during provider writes. Stable external IDs are reserved
before writing, so a later pull recovers a partial/uncertain result without
duplicating the contact. A fresh source fingerprint is required before the
single bounded update request, and a fresh read must match all planned fields
before baselines are acknowledged. Unknown writes are never automatically
retried. The unofficial external API is not a cross-service transaction; failures
require a fresh sync, not a blind retry. No-address contacts use source categories
without creating Gather addresses or changing their credentials; adding a real
address later moves the same contacts through normal credential validation.

The operations workflow on main must check out the exact reviewed application
merge containing both adapters. Its runtime secret names and callback destination
remain unchanged. No live outbound provider call was used for validation.

Imported contacts use the same conservative registered-account matcher as manual contact creation: an exact name and matching phone/address may associate one registered identity. Ambiguous matches and existing self-managed identities are never overwritten. Association grants no event invitation and never returns private usernames or recovery phones.

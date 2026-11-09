# Continuation branch

Branch: `wip/shared-accounts-cards-anylist`.

The tested household RSVP/input update is extracted to `fix/household-rsvp-inputs` at `180ea1cca7fe096b057cd576c3728ae3d403dba5`. This branch includes that completed base; compare against it to review only the remaining work. The original complete work-in-progress snapshot remains recoverable at `b0facbe`.

Remaining implementation/review:

- Full-page Cards & Templates, preview/export actions and shared three-level editing toolbar: finish browser regressions and confirm all existing document/draft/export interactions.
- Personal guest accounts, private usernames/recovery, once-only family population, sharing/blocking and registered contact association: finish integration, account-deduplication and cross-host permission coverage. Review directory-code behavior when existing address credentials move. Keep legacy identities, codes, notes and responses intact.
- Administrator-only name/domain changes: finish alias, deletion/recovery and routing regression review. New domains stay pending until the existing ownership/inventory/proof checks pass.
- E-vites: mocked provider/deduplication tests exist, but full UI and receipt/recovery coverage remains. Group texts currently reject recipient-specific variables; review the intended recipient rendering before release. Keep SMS disabled; do not use live people or send real messages.
- AnyList: separate local/remote baselines and pull conflict tests exist. Outbound writes, acknowledgements and full convergence are not implemented. The current AnyList transport remains read-only. Preserve the configured Events-only integration and do not change Gatherings.
- Complete the browser-suite transition for new sign-in and card interactions. Existing failures on this branch must not be described as green release checks.

The user authorized merging only completed, working changes. This continuation branch is not approved for merge or deployment. Do not enable automatic/preview builds or SMS, alter runtime secrets/settings/bindings, deploy the gateway or write to another repository. See `shared-accounts-preview.md` for the earlier implementation notes.

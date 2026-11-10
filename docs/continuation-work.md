# Continuation branch

Branch: `wip/shared-accounts-cards-anylist`.

The tested household RSVP/input update was merged in [PR #61](https://github.com/kasstmaster/events/pull/61) to `feat/household-subdomains` at `1d5f20799c7a72f41328d288e4466b952c0b7f92`, after all GitHub checks passed. This branch includes that completed merge; compare against `feat/household-subdomains` to review only the remaining work. PR #61 was deployed successfully by manual run 42727410288 as Worker cd19484d-8fbf-4dc0-8c21-ec4d47911077. The original complete work-in-progress snapshot remains recoverable at `b0facbe`.

Remaining implementation/review:

- Full-page Cards & Templates, preview/export actions and shared three-level editing toolbar: finish browser regressions and confirm all existing document/draft/export interactions.
- Personal guest accounts, private usernames/recovery, once-only family population, sharing/blocking and registered contact association: finish integration, account-deduplication and cross-host permission coverage. Review directory-code behavior when existing address credentials move. Keep legacy identities, codes, notes and responses intact.
- Administrator-only name/domain changes: finish alias, deletion/recovery and routing regression review. New domains stay pending until the existing ownership/inventory/proof checks pass.
- E-vites: mocked provider/deduplication tests exist, but full UI and receipt/recovery coverage remains. Group texts currently reject recipient-specific variables; review the intended recipient rendering before release. Keep SMS disabled; do not use live people or send real messages.
- AnyList: separate local/remote baselines and pull conflict tests exist. Outbound writes, acknowledgements and full convergence are not implemented. The current AnyList transport remains read-only. Preserve the configured Events-only integration and do not change Gatherings.
- Complete the browser-suite transition for new sign-in and card interactions. Existing failures on this branch must not be described as green release checks.

The user authorized merging only completed, working changes. This continuation branch is not approved for merge or deployment. Do not enable automatic/preview builds or SMS, alter runtime secrets/settings/bindings, deploy the gateway or write to another repository. See `shared-accounts-preview.md` for the earlier implementation notes.

The tested simple follow-up in PR #63 is integrated here: Information word pop-ups before Add link, Your Plans below RSVP, Username labels, transparent readable notifications and independent guest-home presentation. These are no longer unfinished items. The remaining features above still require implementation/integration work; they are not missing owner credential setup. Any later release must preserve these completed fixes.

# Private guest sign-in branch publication evidence

This handoff publishes `feat/private-guest-sign-in` to `kasstmaster/events` for owner review. It does not create a PR, merge, dispatch a workflow or deploy anything. Preserve implementation commit `8c944d526fdb7f222ab2afecff0c91d95524c8a3` and handoff-rule commit `7f00d7b` as ancestors; do not rewrite them.

## Verified GitHub triggers

On 2026-11-11, `git fetch`, `git ls-remote` and the connected GitHub repository/ref/contents APIs independently identified remote default branch `main` at `da9ff2c0973db0bee1f39275ccc3dc5d9e2c098b`. Repository metadata permits pushing. The feature branch did not yet exist remotely and its workflow-run count was zero.

The GitHub contents API and fetched tree agree on all seven default-branch workflows:

| Workflow                      | Trigger and publication effect                                                                                                                                   |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy-events-auto.yml`      | Only `pull_request: closed`, base `main`; deployment job additionally requires `merged == true` and base ref `main`. An ordinary feature push cannot trigger it. |
| `deploy-events-manual.yml`    | Explicit `workflow_dispatch` only; no dispatch is part of this handoff.                                                                                          |
| `check-cloudflare-auth.yml`   | Read-only explicit dispatch only.                                                                                                                                |
| `inspect-events-settings.yml` | Read-only explicit dispatch only.                                                                                                                                |
| `sync-meyer-anylist.yml`      | Explicit dispatch only, not a push hook.                                                                                                                         |
| `validate-manual-release.yml` | Pull-request validation only.                                                                                                                                    |
| `validate.yml`                | Pull-request validation or pushes to `main` only.                                                                                                                |

The actual feature tree contains only `validate.yml` (PRs or pushes to `main`, validation only) and the explicit-dispatch AnyList workflow. There is no feature-push/create/workflow-run trigger, reusable-workflow invocation, deployment command in validation, active local push hook or alternate tracked deployment manifest capable of deploying this feature push. Local validation's only Wrangler deploy command is explicitly a dry run. No production workflow or setting is modified by this documentation correction.

GitHub Actions metadata corroborates the configuration: the latest automatic-release event was `pull_request` (run `42941251014`), main validation was a successful `push` run (`42941249744`), and the last successful manual release was an explicit `workflow_dispatch` (`42896278490`). These historical records are corroboration, not proof of new production acceptance. The production release remains owner-controlled.

The existing hostname operations guide records Cloudflare's legacy Git builds disabled and preview branch builds off. This handoff does not enable or change them. It does not claim a fresh live Cloudflare-settings inspection: no Cloudflare credential, binding, secret, setting or API authentication is needed or changed for this verified GitHub-only push. If a known external integration is subsequently enabled for a feature ref, the publication checks must catch that hazard before pushing. A source push is never permission to enable builds or previews.

## Validation and release limits

The completed implementation passed 152 API tests, all 12 browser suites, both Cloudflare runtime checks, six isolated AnyList tests, formatting and a production Worker dry run. Its production bundle excluded test-only session helpers. This follow-up changes documentation only; formatting/diff checks and workflow-trigger assertions are the relevant additional local checks. The private guest sign-in implementation and empty-calendar ornament removal are unchanged.

Cloudflare authentication, current production version/settings, CI on an eventual PR, recovery checkpoint/upload, exact-source/configuration guards and post-deployment verification remain deployment requirements. Existing automatic/manual production safeguards are preserved. Before separately approved live new-device guest sign-in, configure the encryption key, verified guest contacts and approved SMS service as described in [private guest sign-in](private-guest-sign-in.md). No SMS is activated or delivered by this handoff.

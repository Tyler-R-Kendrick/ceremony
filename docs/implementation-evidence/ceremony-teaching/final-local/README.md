# Exact-commit local evidence

Tested implementation commit: `29e8340fb4b9aeeb47eeddb8416c0a7e34a66930`.

The checkout was clean before the full deterministic run and before the production release check. Generated reports were added afterward. These files describe that tested implementation commit, not a claim that later documentation commits or deployments were executed.

## Outcomes

| Gate                                          | Actual result                                                                           |
| --------------------------------------------- | --------------------------------------------------------------------------------------- |
| `npm run verify`                              | PASS; all eight required stages exited zero                                             |
| Node/contract/security coverage suite         | 283 passed, zero failed/skipped                                                         |
| Actual local Workflow runtime                 | 2 passed, including SIGKILL/replacement-process persisted-wait recovery                 |
| Critical-guard mutation suite                 | 62 killed, zero failed/skipped mutation outcomes                                        |
| Browser suite                                 | 68 passed, zero failed/skipped; Chromium 153.0.8010.12, Firefox 155.0, WebKit 26.6      |
| Strict local acceptance audit                 | **FAIL**: 46 passed, AC-05/AC-06 missing, five external cases not requested             |
| Default unconfigured production release check | **FAIL**: zero passed, 47 failed, four externally blocked, two explicitly not requested |

AC-05 and AC-06 have no complete scenario in the supplied acceptance brief. They were not invented, assigned replacement assertions, or mislabeled as external blockers. The deterministic suite is green; the strict all-cases delivery verdict is not.

## Machine evidence

- [commands.json](commands.json): automatically captured stage exit statuses, real counts, timestamps, clean commit, local configuration digest and actual launched browser versions.
- [coverage.json](coverage.json): allowlisted numeric coverage totals.
- [browser-results.json](browser-results.json): safe source-location/project/status/retry results, without titles, errors, DOM or attachments.
- [workflow-results.json](workflow-results.json): safe source-location/state evidence, including actual restart recovery.
- [acceptance-executions.json](acceptance-executions.json): strict execution records with reviewed case mappings, actual counts and existing relative evidence paths.
- [verification.json](verification.json): generated local verdict and exact failure reasons.
- [production-verification.json](production-verification.json): separate generated production verdict from the intentionally unconfigured production profile; no local fingerprint was rewritten to obtain production certification.
- [local-profile.json](local-profile.json) and [production-profile.json](production-profile.json): the distinct non-secret evaluated profiles.

Case mappings require the independently inspected assertions documented in [domain-acceptance.md](../domain-acceptance.md), [acceptance-browser.md](../acceptance-browser.md), and the threat model. They were not inferred merely from stage success. AC-34 additionally uses the actual local Workflow restart result; local browser/node evidence alone would not satisfy it.

## Executed report commands

On the clean tested checkout, the default `npm run verify:release` exited **1**, producing the unconfigured production report. No live/provider authorization flags were supplied and no live-provider command was invoked.

After preserving that report, the following audit exited **1**, correctly retaining the two undefined local acceptance cases:

```sh
CEREMONY_RELEASE_PROFILE=docs/implementation-evidence/ceremony-teaching/local-profile.json CEREMONY_VERIFICATION_RESULTS=artifacts/verification/acceptance-executions-29e8340.json node --import tsx scripts/verify-release.ts audit
```

The audit input is preserved here as `acceptance-executions.json`; its artifact paths resolve to this directory. The full deterministic run used the installed local browser/runtime paths documented in [domain-acceptance.md](../domain-acceptance.md), not an external deployment.

Real GitHub account certification, deployed Vercel/Workflow certification, actual installed-PWA devices and manual assistive-platform checks were **not executed**. The reports contain no credentials, provider/model payloads, private browser captures or account-identifying material.

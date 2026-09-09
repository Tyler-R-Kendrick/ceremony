# Conformance and compatibility

Conformance has separate levels. A product MUST NOT promote a lower level to a higher one merely because a schema parses.

| Level               | Required evidence                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Structural          | Generated JSON Schema accepts the shape; unknown keys and bounded fields respected                                             |
| Semantic            | Runtime Zod checks, cross-field rules, configuration groups, recipe graph/type/registry and workflow-reference validation pass |
| Implementation      | Host registration binds real handlers and verifiers; protocol, authorization, privacy and recovery tests exercise them         |
| Deployment/provider | Explicitly authorized live account/gateway/platform tests for the exact configured release profile                             |

`support: live-adapter` asserts only that a trusted adapter exists. It does not imply configured, enabled, production-ready or certified. Absence of a model, hosted browser or native WebMCP cannot disable the normal deterministic/human path.

## Executable mapping

| Case    | Assertion                                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------------- |
| SPEC-01 | All shipped inventories satisfy version 1; live and fixture support stay distinct; ownership remains explicit             |
| SPEC-02 | Legacy readers remain supported; formal manifests require classification and cannot invent certification/version fields   |
| SPEC-03 | Handoff/configuration shapes reject private references, recipients, URLs, executable/authority fields and grant-on-return |
| SPEC-04 | Configuration groups preserve all-or-none and alternative semantics without values                                        |
| SPEC-05 | Duplicate, foreign and excessive requirements fail; UTF-8 import boundary is checked before parsing                       |
| SPEC-06 | Selection produces bounded reasons and rejects unsupported availability values                                            |
| SPEC-07 | Generated surface/scope/availability permutations preserve eligible-selection invariants                                  |
| SPEC-08 | Actual controller resumption honors the same surface constraint                                                           |
| SPEC-09 | Host Arazzo reference catalog rejects missing documents/workflows/version mismatches                                      |
| SPEC-10 | Checked-in schema documents exactly match generation from runtime contracts                                               |

The cases live in [specifications.test.ts](../../tests/specifications.test.ts), are recursively discovered by the normal Node runner, and run with `npm run test:specs`. Existing resolution, Arazzo, projection, GitHub children, A2H signature/replay, Pact, recipe, command, browser and consumer tests retain responsibility for their actual boundaries. See [testing](../testing.md) for required complete verification, critical mutation gates and coverage scope. A schema test is not an external-service contract test.

SPEC-11 additionally verifies that the agent requirements projection excludes private handles, addresses, URLs and configuration values, including unexpected nested keys.

## Change procedure

1. Change the owning runtime schema and implementation together; retain legacy behavior or document an intentional migration.
2. Add positive and negative conformance cases, including changed privacy/authority boundaries.
3. Generate schemas with `npm run specs:generate`; inspect differences. Never weaken constraints to accept an unsupported protocol or model output.
4. Run focused tests, formatting/type checks, complete deterministic verification and relevant mutation tests. Preserve failed attempts and their fixes.
5. Pin published recipe closures and recheck current configuration/permission policy. A document version/digest is integrity metadata, not authorization or certification.

JSON Schema cannot express every runtime refinement or trusted-state check. The generated documents say so explicitly; consumers MUST run the authoritative validators and policy service before effects. Untrusted descriptive text remains inert and must pass the existing model-ingress policy before inference. The schema does not promise to detect arbitrary secrets pasted into prose.

Changes here do not regenerate or supersede historical release certificates. Use [commit-bound evidence](../implementation-evidence/ceremony-teaching/README.md) and actual command results. Live provider, deployed Workflow and installed-PWA certification remain separately gated.

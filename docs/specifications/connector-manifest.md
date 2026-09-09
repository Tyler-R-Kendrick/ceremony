# Connector manifest v1

Runtime: `connectorManifestV1Schema`, `manifestSchema`, `methodContractSchema`, `parseConnectorManifest` from `@ceremony/auth`. Structural schema: [connector-manifest-v1](schemas/connector-manifest-v1.schema.json).

## Manifest envelope

| Member                | Requirement                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| `schemaVersion`       | MUST be `1` for this profile                                                                                |
| `support`             | `fixture` or `live-adapter`; describes implementation, never certification or enabled deployment capability |
| `id`                  | Stable lowercase identifier, 1–64 characters; unique within host registration                               |
| `name`, `description` | Bounded display text, not instructions or authority                                                         |
| `methods`             | 1–12 uniquely identified methods, each with an explicit contract                                            |

Unknown keys and versions MUST be rejected. Import MUST be bounded to 256 KiB UTF-8 before JSON parsing. `parseConnectorManifest` implements that boundary. Endpoint URLs, credentials, callbacks, recipients, executable code, publication grants and runtime artifact handles MUST NOT be embedded. The host MUST separately register handlers and approved origins; an imported inventory cannot enable a live method.

## Authentication method

Existing `id`, `label`, `kind`, `fields`, `claimFields`, `scopes` and `templateId` remain. Kinds are `api-key`, `basic`, `form`, `oauth-code`, `device`, `authmd-anonymous`, and `github-app`. A kind is not an assertion that every provider implements that protocol. OAuth App and GitHub App identities MUST NOT be interchanged.

Fields MUST declare `classification`: `public`, `personal`, `secret`, `artifact` or `unclassified`. Password/token fields remain secret regardless of appearance. Only explicitly public values may use the public agent-input path; personal, artifact and unknown values require their protected host paths. A manifest MUST NOT redefine the registered operation's classification. Field names are unique; Basic requires username/password, API key requires token, and form requires at least one field. Redirect/device/App profiles cannot invent credential fields. Claim fields apply only to anonymous auth.

`scopes` describe the method's requestable inventory, not granted permissions. Actual scopes MUST be verified. `templateId` selects presentation only and cannot change actions, endpoints or evidence requirements.

## Method contract

| Member                | Semantics                                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `profile`             | Stable provider-specific profile identity; no implicit conversion between profiles                                                           |
| `surfaces`            | Nonempty unique browser/headless entry surfaces; selection and resumption honor this constraint                                              |
| `configuration`       | Up to 24 unique names, their host/session-environment source, classification and required presence; **no values/defaults**                   |
| `configurationGroups` | Up to 12 named groups over distinct declared names: `all-or-none` or `at-least-one`                                                          |
| `prerequisites`       | Up to 12 unique setup requirements: configuration, provider registration or consent; each has a human fallback and `reuse: verified-context` |
| `handoff`             | Required private collector/provider-browser participation, recipient policy, optional A2H delivery profile, and verification on return       |
| `completion`          | Trusted verifier identity and allowed ownership outcomes; it neither creates nor executes a verifier                                         |
| `workflows`           | Up to 12 pinned host-document/version/workflow references; duplicate document/workflow pairs are rejected                                    |

Prerequisite declarations summarize the registered implementation; they are **not a second executable graph**. The existing recipe's bindings and dependencies govern composition. A declaration MUST match the actual adapter/recipe behavior in conformance tests. Adding a prerequisite to an imported manifest alone does not implement it. Live registration MUST bind the corresponding implementation; unsupported capabilities stay unavailable.

`inspectConfiguration(contract, presentNames)` consumes names from a trusted lookup and returns `ready`, `missingRequired`, and `unsatisfiedGroups`. For `at-least-one`, the missing names are alternatives—not instructions to collect them all. For `all-or-none`, an empty group is valid; a partially supplied group needs completion or explicit removal. Presence is advisory: empty/invalid/revoked values, origin compatibility and provider permissions MUST still be validated by the adapter. The result is not a credential grant.

Environment variables are shared by the authenticated user session by default. Connector requirements select relevant names; they do not create per-connector credential ownership. Host-only configuration remains inaccessible to the browser/model. Classification of a configuration declaration does not authorize projecting its actual value. Group errors SHOULD be resolved through one protected collector or an authorized owner, not repeated prompts.

## Concrete shipped profiles

| Connector/profile                                                                             | Requirements and evidence                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub App, live adapter                                                                      | Optional existing `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_OWNER`, `GITHUB_APP_PRIVATE_KEY` are all-or-none. Otherwise prepare app registration, then installation. App/installation/repository evidence must be verified before authenticated completion. Both SDK workflows are pinned to 1.0.0. |
| Stripe key, live adapter                                                                      | Reuse `STRIPE_SECRET_KEY` or collect a key privately; read balance through the bound SDK workflow. No payment operation is authorized.                                                                                                                                                                    |
| Supabase password, live adapter                                                               | Required project URL and either publishable-key or anon-key variable. Missing configuration is collected inline; password exchange must yield a valid project session.                                                                                                                                    |
| GitHub OAuth/device/PAT, Jira Basic, Supabase form, Stripe key, Neon anonymous/claim fixtures | Explicit fixture contracts. These inventories MUST NOT be promoted to live support by changing a field or model suggestion.                                                                                                                                                                               |

See the executable examples in [example manifests](../../examples/manifests.ts), [GitHub](../../src/server/github.ts), and [service manifests](../../src/server/services.ts). The list describes adapter capability, not attended live-account certification. Neon claimed ownership is distinct from continuing authenticated API access.

## Compatibility

Legacy manifests without `schemaVersion` remain accepted by `manifestSchema`; unclassified fields remain private/unclassified and no contract is inferred. New authors SHOULD use `connectorManifestV1Schema`. Formal version 1 requires all method contracts, support labels and explicit field classifications. Old readers that reject the new fields require a host-controlled legacy projection during rollout; do not silently strip fields at an authorization boundary. Rollback may restore the old deployment/configuration, but MUST NOT erase persisted credentials, evidence or active runs. Changes to operation versions, permission/configuration policy or callback origins require the existing runtime revalidation, not merely a metadata edit.

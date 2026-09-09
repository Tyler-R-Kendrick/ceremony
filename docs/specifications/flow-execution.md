# Decision and execution profile v1

## Authority and configuration owners

| Part         | Host configuration                                                                                                                       | Portable declaration / machine input                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Identity     | Authenticated tenant, subject, session; role and delegation checks                                                                       | Actor shape is descriptive only; browser cannot supply authority                                        |
| Connector    | Registered adapters/operations, approved provider origins and capability availability                                                    | Versioned connector manifest and method contract                                                        |
| Setup reuse  | Encrypted artifacts, principal/tenant policy, target, environment, exact callback origin, configuration/permission version and freshness | Typed recipe input/output slots and prerequisite descriptions                                           |
| Composition  | Published revision, current retirement policy and pinned child closure                                                                   | [Recipe schema](schemas/recipe-v1.schema.json); one representation for whole/partial flows              |
| Execution    | Input/output schemas, classifications, effects, handler, verifier, fallback and required fixtures                                        | [Operation contract](schemas/operation-v1.schema.json), never generated code                            |
| Commands     | Authenticated actor, effect intent, revision, stable command identity and worker fencing                                                 | [Command envelope](schemas/command-v1.schema.json); input/output/literal bindings only                  |
| Agent        | Server-only model routing, durable budgets and scoped authorization                                                                      | Positive-allowlist state, registered tools, [selection result](schemas/method-selection-v1.schema.json) |
| Human        | Authenticated recipient, attempt/effect binding, private broker, trusted return route                                                    | [Handoff contract](schemas/human-handoff-v1.schema.json)                                                |
| Observation  | Transactional semantic events/outbox, consent, retention and destination-specific projections                                            | [Demonstration event](schemas/demonstration-event-v1.schema.json)                                       |
| Continuation | Registered original host task, durable delivery and receiver deduplication                                                               | Non-authorizing run correlation only; no model-supplied callback endpoint                               |

The manifest does not configure database connections, OIDC keys, model credentials, A2H recipients or gateway secrets. Those are host-owned [production configuration](../production-deployment.md). Neither JSON Schema validity nor a model/tool source string authenticates a caller.

## Selection algorithm

SEL-01: Reuse compatible verified access or a resumable attempt before starting setup. Revalidate scope and current host availability. A configured app is not itself an authenticated connection.

SEL-02: For new selection, validate the manifest and strict entry context. `surface` defaults to browser; `requiredScopes` defaults to empty. Reject undeclared context keys. Availability comes only from trusted host/session lookup and must be available, configured or unavailable.

SEL-03: Exclude unavailable methods, unsupported declared surfaces and methods missing any required scope. Structured reasons are `unavailable`, `unsupported-surface`, `insufficient-scopes`, or `eligible`, in that precedence. `explainCeremonySelection` returns identifiers/reasons only and `selectedMethodId: null` when none qualifies. It performs no provider work.

SEL-04: Prefer configured eligible methods. Within that class, browser preference is OAuth code, GitHub App, device, anonymous, API key, form, Basic; headless preference exchanges the first positions to device, OAuth code, GitHub App. Manifest order breaks ties. `resolveCeremonyMethod` uses the same decision and throws when no method qualifies. Explicit start is still subject to host authorization; surface is a UX capability constraint, not proof of identity.

SEL-05: An agent MAY use these reasons and safe tool requirements to propose a supported method or route an unresolved requirement to a human. It MUST NOT treat `eligible`, configuration presence or a successful tool response as provider approval. The server remains authoritative for resumption, action validation and execution.

## Participation and state

| Trusted state/blocker                          | Required behavior                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Usable verified connection                     | Reuse and resume the authorized host task; no model or registration required                      |
| Missing setup                                  | Run the registered prerequisite or request its authorized owner; never silently skip it           |
| Credential/private choice                      | Native private collector or configured MCP collector; model receives no value                     |
| Provider login, MFA, passkey, CAPTCHA, consent | Own-browser human handoff; A2H may deliver the request when configured                            |
| `awaiting-human`                               | Persist wait; no busy model loop; retain parent identity                                          |
| `verifying`                                    | Run the trusted verifier under current authority; a human response cannot supply `verified: true` |
| `uncertain`                                    | Reconcile the existing effect; do not blindly repeat one-use registration/conversion              |
| `failed`, expired, stale or denied             | Bounded diagnostics and supported recovery only; no inferred success                              |
| Cancelled                                      | Fence local pending work and attempts; no implicit upstream revocation                            |

Stop assistant, cancel connection and discard demonstration remain separate operations. Stopping assistance does not rollback provider effects. Discarding teaching data does not delete mandatory security records or invalidate a connection.

## Composition, effects and hooks

Recipes MUST use registered operation/version leaves or pinned reviewed child recipes, explicit dependencies and typed bindings. The runtime rejects cycles, unknown versions, missing producers, incompatible contracts, secret literals and invalid evidence. Limit imports to 256 KiB, expansion to 32 leaves and eight nested levels. Publication requires review of the exact revision/digest plus required fixtures. Import always creates an untrusted draft. Sharing a recipe never shares credentials or the author's authorization.

Before an external effect, admit the command and persist its canonical effect identity. A retry keeps that identity; changing actor, target, scope, arguments or operation under the same key is rejected. Work claims use generations; stale workers cannot commit. Transactions MUST NOT span HTTP, inference or human waits. Uncertain provider effects remain uncertain until reconciled. No provider exactly-once claim is implied.

UI/WebMCP execution hooks and Arazzo step observers report success/failure at their respective action/step boundary. Observer success is not verification; observer failure cannot replay an effect. Durable semantic events and outbox continuation—not a tab callback or model prose—drive essential follow-up work. Consumers deduplicate by stable continuation identity.

Reviewed deterministic recipes execute without a model. Default assistant budgets remain eight tool requests per turn, 16 model calls/64 model-requested tools per run and two authoring calls including repair. Budget reservation precedes inference; failed calls count. Human waits and provider polling have separate lifecycle rules and do not justify inference loops. See [agent integration](../agent-integration.md).

## Authoring guidance for AI

1. Read the formal manifest, trusted operation catalog and current safe state; use the structured selection/configuration result rather than guessing endpoints or credentials.
2. Preserve variable account/scope choices as typed inputs. Never generalize one demonstrated approval into future authority.
3. Draft the existing recipe format. Do not create JavaScript, HTTP destinations, verifier expressions or a second branch language.
4. At a human blocker, request the declared participation through the protected command path. Keep login and secrets outside narration, model context and recordings.
5. After return, reread trusted state and verify; stop on denial, revocation, ambiguity or uncertainty. Only accepted evidence satisfies downstream dependencies.
6. Validate, review and publish explicitly. Model output alone is neither an executable registry extension nor a published procedure.

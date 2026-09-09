# Teaching and agent trust boundaries

This document records implemented boundaries and the evidence that exercises them. It is not a production certification. Consult the release evidence for unexecuted or externally blocked gates.

## Assets and actors

Protected assets include provider credentials, callback codes/state, collection references, setup artifacts, authenticated sessions, review grants, effect authority, and continuation identities. A procedure is shareable under tenant policy; those assets are not transferred with it. Authors, reviewers, publishers, executors, workload agents, and the trusted host have different authority. A model is an untrusted proposer, never a verifier or identity provider.

The trusted computing boundary includes the authenticated application server, its configured identity adapter, encryption keys, trusted operation implementations, the intended private collector, and the user's browser. Encryption at rest does not hide plaintext from a compromised authorized server or browser. Configured model, gateway, workflow and hosted-browser operators are separate processors; minimize data before their ingress, not after logging.

## Concrete regression findings

| Finding                                                                                                                   | Enforcement and evidence                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An agent stopped during a provider call could otherwise commit using its previously checked authority.                    | The shared command path rechecks persisted delegation identity, expiration, revocation and stop state at admission and the fenced commit. `tests/security/teaching-authority.test.ts` holds a handler in flight, stops the assistant, and proves no verified node commits. It also rejects undelegated, revoked, expired and wrong-session agents before effects. |
| Reusing a completed run could otherwise treat historical verification as current access.                                  | `ProtectedCommandService.revalidate` invokes only registered verifiers, checks current provider evidence, and invalidates failed nodes and their dependent descendants. It does not rerun registration to test validity. The same security test proves reuse performs a verifier call but no new effect, and revoked evidence returns an active unverified run.   |
| A small nested recipe document could otherwise trigger exponential pinned-child traversal after exceeding the leaf limit. | Recipe expansion stops globally on exhaustion, with at most 32 leaves, eight levels and 256 visited invocation positions. `tests/security/recipe-resources.test.ts` supplies a seven-level, 32-way repeated-child graph and bounds resolver calls.                                                                                                                |

External host policy checks run outside database transactions. Transactional delegation checks use the command transaction, so they cannot deadlock by recursively opening an async store transaction. A host must implement its own current policy; browser `source`, owner fields, IDs and model-written text are not authorization.

## Required negative boundaries

Strict recipe schemas reject unknown structure, executable operation definitions, prototype keys and unregistered versions. Publishing binds a specific reviewed revision and digest; a digest alone grants nothing. Pinned child publication is tenant-owned and current retirement policy is checked separately from definition integrity. Runtime artifacts require fresh compatibility and verification in the current principal, target, origin, environment and configuration context.

Private inputs and transient authorization instructions must remain excluded from agent state, demonstration events, portable definitions and telemetry. Human views may need information that agents must not receive. Native WebMCP is a transport, not extra permission. Pure snapshot reads must not poll providers. A human return starts verification, not proof of consent.

The secret-ingress guard rejects known protected formats; it cannot reliably recognize every arbitrary password in unstructured text. This feature does not require narration or attachments. Credentials belong in the private collector, never instructions to the model.

## Failure and diagnostics policy

Stop assistant prevents subsequent agent work and does not revoke provider effects. Cancel connection fences local work and does not secretly revoke upstream grants. Discard demonstration deletes teaching material, not the underlying connection or mandatory audit records. A provider request may already have happened when cancellation or revocation wins; uncertain effects require reconciliation, not automatic replay.

Disable traces, screenshots, video, HAR and arbitrary request/console capture on private authentication paths. Synthetic security tests use controlled values and bounded assertions; real provider bodies, tokens, browser profiles and decrypted stores must not become evidence artifacts. Mandatory security records retain sanitized action metadata under a separate policy from optional demonstrations.

## Remaining release boundaries

The focused regressions above use the actual encrypted local store and shared runtime, but are not evidence of distributed PostgreSQL races, deployed Workflow replay, real GitHub account certification or installed-PWA OS behavior. Those require their separately executed gates. No platform, provider or device gate may pass solely because its credentials or environment are unavailable. The original provider's external effect cannot be promised exactly once without that provider's idempotency or reconciliation support.

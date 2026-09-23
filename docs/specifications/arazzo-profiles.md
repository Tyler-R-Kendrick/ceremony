# Arazzo interoperability profiles

Status: **Ceremony implementation profile, version 1.** This page describes what `src/server/connectors/formats/arazzo/` does with an [Arazzo](https://spec.openapis.org/arazzo/v1.1.0.html) description. It is not a claim to implement the Arazzo language, and it does not replace [the bounded 1.0.1 executor](protocol-profiles.md), which keeps its own contract for the studio's authored ceremonies.

Four capabilities are reported separately, because they succeed and fail independently:

| Capability      | Entry point                                                           | What success means                                                                   |
| --------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Read            | `readArazzo(document, options)`                                       | The description was parsed within bounds, preserved, and projected as a description. |
| Execute         | `compileArazzoToRecipe(read, bindings, options)`                      | Every step resolved to a host-registered operation and the workflow became a recipe. |
| Import          | `ceremony_arazzo_import` (MCP), `POST /api/v1/teaching/drafts/arazzo` | The compiled recipe was saved as a draft under the caller's authorship; nothing ran. |
| Review / export | `reviewArazzoImport`, `exportArazzo`                                  | The studio can edit it losslessly; a named Arazzo version can be written back.       |

A document that reads cleanly may still be unexecutable, and an unexecutable document is still readable, exportable and reviewable. Reading never registers an operation, never fetches a source description and never rewrites a version string.

The compiled recipe is the only way an imported workflow executes. It runs as any other recipe does: an author imports it as a draft, a person reviews and publishes it, and the `ProtectedCommandService` then executes it step by step. The import tool and route are offered only when the host configured `arazzoCatalog` (ARZ-N6) and only to an `author`. With the catalog, they compile one workflow of a JSON description and return either a draft or the blocking issues. An issue carries a code, a pointer and a fixed message, and never quotes document text. Tests: `tests/arazzo-import.test.ts`.

## ARZ-N1: version dispatch

The reader dispatches on the `arazzo` string. `1.0.1` and `1.1.0` are implemented; every other value, including `1.0.0` and `1.2.0`, produces one blocking `arazzo.version.unsupported` issue and no interpretation at all. The declared version is preserved verbatim and reported as `declaredVersion`; nothing in this directory writes a version into a document it did not create.

Fields are gated per version. A field the declared version does not define is preserved under the object's `unknown` map and reported as `arazzo.version.field-unavailable`, blocking whatever it affects. So `$self`, `channelPath`, `timeout`, `correlationId`, `action`, step-level `dependsOn`, action `parameters`, `targetSelectorType`, Selector Objects, the `asyncapi` source type, the `querystring` parameter location, the `jsonpointer` expression type and the `rfc9535`/`xpath-31` expression versions are all read in a `1.1.0` document and all blocked in a `1.0.1` one. Ignoring them silently would change what the author wrote; interpreting them would apply semantics the declared version does not have.

## ARZ-N2: preservation

The preserved model keeps `info`, `sourceDescriptions` (both `openapi` and `arazzo` types, plus `asyncapi` in 1.1.0), workflows with their `inputs` JSON Schema, `dependsOn`, steps (`operationId`, `operationPath`, `channelPath`, `workflowId`, `parameters`, `requestBody`, `successCriteria`, `onSuccess`, `onFailure`, `outputs`, `timeout`, `correlationId`, `action`, `dependsOn`), workflow-level actions, outputs and parameters, `components` (`inputs`, `parameters`, `successActions`, `failureActions`), Reusable Objects and every `x-` extension on every object. A JSON Schema is data: it is stored as written and never compiled, expanded or resolved, so a recursive schema round-trips without expansion.

Source description URLs are declared data. A URL is projected into `NormalizedDefinition.declaredServers` only when its source description declares `type: openapi` and the URL is absolute and free of userinfo; a URL carrying credentials is refused as a declared server with a blocking `arazzo.source.url-credentials` and never reaches a definition, an issue message or a projection. Declaring a server is not approval to contact it: a `RuntimeBinding` decides that.

The normalized definition uses ecosystem `arazzo` and carries one `custom` capability per workflow whose `nativeId` is the `workflowId` exactly as spelled.

## ARZ-N3: bounds

`ARAZZO_LIMITS` bounds document depth (64), total nodes, any single string (64 KiB), total bytes (`DEFINITION_LIMITS.bytes`), source descriptions (32), workflows (128), steps (256), parameters (64), criteria (32), actions (16), outputs (64), components (256), `dependsOn` entries (64), payload replacements (64), identifiers (200 characters), expressions (1024) and conditions (2048). A document beyond a bound is refused with a pointer; nothing is truncated into a smaller document that would run differently. Reserved object keys (`__proto__`, `prototype`, `constructor`) and non-JSON values are refused before interpretation, and the input value is never modified.

## ARZ-N4: the executable subset

`compileArazzoToRecipe(read, bindings, { workflowId, registry, tenantId })` translates one workflow into a `RecipeDefinition` that the existing `validateRecipe`, `RecipeService` and `ProtectedCommandService` execute. Supported:

- sequential steps, and the step-level `dependsOn` DAG in 1.1.0, compiled into one deterministic order that satisfies every declared and implicit dependency (document order breaks ties);
- workflow inputs (`$inputs.<name>`) and step output references (`$steps.<id>.outputs.<name>`) as recipe bindings;
- literal parameter values, but only for an input whose registered contract is classified `public` and whose schema accepts the value;
- `successCriteria` of an operation step, in the evaluator's subset (ARZ-N5). They are carried into the recipe as the invocation's `outcome` and enforced by the command service when the step runs; see ARZ-N4a;
- `onSuccess: end` on the final step, and `onSuccess: goto` that names the next sequential step (both are the order the recipe already has);
- `onFailure: retry` on an operation step, with a bounded `retryLimit` (at most 5) and `retryAfter` (at most 300s). The bound operation's catalog `replay` must be `read-only`, `upstream-idempotency-key` or `reconciliation`, and the registered operation must carry the host's `replay` evidence too. It is carried in the same `outcome`;
- a `workflowId` step, and a workflow-level `dependsOn`, bound to a published recipe through the catalog;
- a JSON `requestBody` whose top-level properties map to registered inputs;
- a step `timeout` of at most 10 minutes, accepted with the `arazzo.step.timeout-adapted` warning. The recipe does not carry it; the host's command signal bounds each attempt instead.

Everything else is preserved and blocked with its pointer: `regex`, `jsonpath` and `xpath` criteria; criteria with a `context`; criteria or bindings reading `$request`, `$response`, `$message`, `$url`, `$method` or `$self` beyond the evaluator's subset; JSON pointer extraction inside a binding; `{$...}` templates inside strings; Selector Objects; payload replacements; `querystring` parameters; non-JSON request bodies; `channelPath`, `correlationId` and `action` steps; `goto` that branches, repeats or leaves the workflow; conditional `end`; an `end` that leaves later steps unreachable; `goto` cycles; `dependsOn` cycles; timeouts beyond 10 minutes; `successCriteria` or `onFailure: retry` on a `workflowId` step (`arazzo.step.workflow-outcome-unsupported`); a criterion that reads a step's own outputs, a workflow output (`$outputs.*`) or a value not classified `public` (`arazzo.policy.private-criterion`); and a workflow with more steps than one recipe may hold.

A blocked compilation returns `status: "blocked"`, the issues, and **no recipe**. A valid-but-unsupported feature therefore produces a preserved document and a blocked execution report, never a truncated runnable workflow.

## ARZ-N4a: outcomes at run time

The compiler writes each operation step's criteria and retry into a declarative `outcome` on the recipe invocation (`recipe-contracts.ts`). The outcome holds the condition texts, the bounded retry and a `values` map that binds each `$inputs.<name>` and `$steps.<id>.outputs.<name>` the conditions read to a recipe input or an earlier step's output. A producer an outcome reads becomes an explicit dependency. `validateRecipe` rechecks every outcome, whoever wrote it. It refuses a condition outside the subset, a reference not bound in `values`, a bound value whose contract is not `public`, and a retry on an operation without registered `replay`.

When the step runs, the command service evaluates the conditions after the operation's own verifier accepts the result. It reads the public values the outcome binds and whatever transport facts the handler reported: `$statusCode`, `$url`, `$method` and `$response.header.<name>`. The handler decides which facts are public; they are evaluated and then dropped, and never stored, returned or recorded. A fact the handler did not report is unresolved, so the criterion fails closed. An operation whose handler reports no status therefore cannot satisfy `$statusCode == 200`. An attempt that misses its criteria is `failed` with `verification-rejected` and publishes no outputs.

Retries are not automatic. The command service records the failed attempt. When a retry remains and the retry `criteria` hold for that attempt, the snapshot shows `retry: { attempts, notBefore }`, and the step may be advanced again at or after `notBefore`; an earlier attempt is a conflict. Otherwise the step is exhausted and cannot run again, so the run does not complete. An `uncertain` attempt is never retried.

This is not a general Arazzo runner. Outcomes do not branch or jump, and they evaluate nothing beyond ARZ-N5's subset over public values. The bounded 1.0.1 executor `runArazzo` ([protocol profiles](protocol-profiles.md)) remains a sequencer of host-bound SDK closures inside a provider handler: it passes no data between steps and evaluates no criteria. Tests: `tests/connectors/arazzo/compile.test.ts`, `tests/connectors/arazzo/runtime.test.ts`, `tests/recipe-outcome.test.ts`.

## ARZ-N5: the bounded evaluator

Only Arazzo `simple` conditions are evaluated, by a hand-written tokenizer and recursive-descent parser: no `eval`, no `Function`, no dynamic import and no regular expression built from document text. Supported expressions are `$inputs.x`, `$steps.id.outputs.y`, `$outputs.y`, `$statusCode`, `$url`, `$method` and `$response.header.Name`; supported syntax is the specification's literals (single-quoted strings with `''` escapes, numbers, `true`, `false`, `null`), `==`, `!=`, `<`, `>`, `<=`, `>=`, `&&`, `||`, `!` and parentheses, plus RFC 6901 pointers on a resolved value. Comparison follows the specification: string comparison is case-insensitive, numeric strings coerce, and `null` equals only `null`. Token count (256), parser depth (16), literal length (512) and pointer segments (16) are bounded, and a syntax error reports a code and a position, never document text.

A condition passes only when it evaluates to boolean `true`. An unresolved reference, an unsupported reference, an incomparable pair and a non-boolean result all fail closed and say which.

Every value carries a classification, and every result carries the join of what it was derived from: a comparison against a `secret` input is `secret`, and negating it does not launder it. A workflow output that resolves to a step output classified `personal` or `secret` is a blocking `arazzo.policy.private-output`, and one with no registered classification is a blocking `arazzo.policy.unclassified-output`.

The evaluator itself resolves `$outputs.y`, but the executable profile does not use it in criteria. At run time (ARZ-N4a), the evaluator is only ever given public values.

## ARZ-N6: binding identity

The `OperationBindingCatalog` is host state. Per source description name it pins one document identity — a source digest or an exact URL — the document version the host reviewed, and, for each `operationId` or `operationPath`, the registered operation `id@version` it means, plus its parameter, request-body and output mappings and its replay policy.

Resolution is exact and never a first match:

- a plain `operationId` is looked up in every non-`arazzo` source description; if more than one **registered** document defines it, the step is a blocking `arazzo.identity.ambiguous-operation` and must disambiguate with `$sourceDescriptions.<name>.<operationId>` or an `operationPath`;
- an `operationPath` must be `{$sourceDescriptions.<name>.url}#<json-pointer>`; an absolute URL, a foreign location or a bare pointer is refused;
- a catalog document whose pinned URL differs from the declared source description URL is `arazzo.identity.source-mismatch`;
- more than one catalog document for one source description is `arazzo.identity.ambiguous-document`;
- an operation the catalog does not bind is `arazzo.binding.unbound-operation`, and one the catalog names but the `OperationRegistry` does not hold is `arazzo.binding.unregistered-operation`;
- a catalog whose `tenantId` differs from the compilation's is refused outright.

An imported description contributes no part of this. Importing a workflow never registers a provider operation. For the import tool and route, the catalog comes from the host's `arazzoCatalog(actor)` option on the teaching runtime, never from the request. A host that does not configure it offers neither.

## ARZ-N7: studio review and export

`reviewArazzoImport(document)` reports the read, a studio projection and a per-workflow executability review. The studio edits the deliberately constrained v1 shape — Arazzo `1.0.1`, `info.version` `1.0.0`, exactly one `openapi` source named `provider`, lowercase identifiers, `operationId`-only steps — so every other construct is a loss with a pointer, and `editable` is true only when no loss is blocking. Saved v1 projects keep validating through `connectorProjectSchema` unchanged; nothing here relaxes them.

`exportArazzo(read, { version })` writes the preserved model back in the specification's field order for the requested version. Same-version and 1.0.1 → 1.1.0 exports are exact (the latter noting `arazzo.export.version-changed`). A 1.1.0 document containing 1.1-only constructs cannot be written as 1.0.1: each construct is a blocking `arazzo.export.version-downgrade-loss` and **no document is produced**. Fields outside the specification are dropped with a warning; `x-` extensions round-trip.

## Sources

- Arazzo 1.1.0: <https://spec.openapis.org/arazzo/v1.1.0.html>
- Arazzo 1.0.1: <https://spec.openapis.org/arazzo/v1.0.1.html>

Tests: `tests/connectors/arazzo/read.test.ts`, `compile.test.ts`, `evaluator.test.ts`, `preservation.test.ts`, `runtime.test.ts`, plus `tests/arazzo-import.test.ts` and `tests/recipe-outcome.test.ts`. The providers in them are loopback fixtures. Passing them is unit and protocol-fixture evidence; it is not a claim that any third-party Arazzo runner accepts these documents.

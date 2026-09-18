# Arazzo interoperability profiles

Status: **Ceremony implementation profile, version 1.** This page describes what `src/server/connectors/formats/arazzo/` does with an [Arazzo](https://spec.openapis.org/arazzo/v1.1.0.html) description. It is not a claim to implement the Arazzo language, and it does not replace [the bounded 1.0.1 executor](protocol-profiles.md), which keeps its own contract for the studio's authored ceremonies.

Three capabilities are reported separately, because they succeed and fail independently:

| Capability      | Entry point                                      | What success means                                                                   |
| --------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Read            | `readArazzo(document, options)`                  | The description was parsed within bounds, preserved, and projected as a description. |
| Execute         | `compileArazzoToRecipe(read, bindings, options)` | Every step resolved to a host-registered operation and the workflow became a recipe. |
| Review / export | `reviewArazzoImport`, `exportArazzo`             | The studio can edit it losslessly; a named Arazzo version can be written back.       |

A document that reads cleanly may still be unexecutable, and an unexecutable document is still readable, exportable and reviewable. Reading never registers an operation, never fetches a source description and never rewrites a version string.

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
- `successCriteria` of the supported evaluator (ARZ-N5);
- `onSuccess: end` on the final step, and `onSuccess: goto` that names the next sequential step;
- `onFailure: retry` with a bounded `retryLimit` (at most 5) and `retryAfter` (at most 300s), and only when the bound operation's catalog `replay` is `read-only`, `upstream-idempotency-key` or `reconciliation`;
- a `workflowId` step, and a workflow-level `dependsOn`, bound to a published recipe through the catalog;
- a JSON `requestBody` whose top-level properties map to registered inputs.

Everything else is preserved and blocked with its pointer: `regex`, `jsonpath` and `xpath` criteria; criteria with a `context`; criteria or bindings reading `$request`, `$response`, `$message`, `$url`, `$method` or `$self` beyond the evaluator's subset; JSON pointer extraction inside a binding; `{$...}` templates inside strings; Selector Objects; payload replacements; `querystring` parameters; non-JSON request bodies; `channelPath`, `correlationId` and `action` steps; `goto` that branches, repeats or leaves the workflow; conditional `end`; an `end` that leaves later steps unreachable; `goto` cycles; `dependsOn` cycles; timeouts beyond 10 minutes; and a workflow with more steps than one recipe may hold.

A blocked compilation returns `status: "blocked"`, the issues, and **no recipe**. A valid-but-unsupported feature therefore produces a preserved document and a blocked execution report, never a truncated runnable workflow.

## ARZ-N5: the bounded evaluator

Only Arazzo `simple` conditions are evaluated, by a hand-written tokenizer and recursive-descent parser: no `eval`, no `Function`, no dynamic import and no regular expression built from document text. Supported expressions are `$inputs.x`, `$steps.id.outputs.y`, `$outputs.y`, `$statusCode`, `$url`, `$method` and `$response.header.Name`; supported syntax is the specification's literals (single-quoted strings with `''` escapes, numbers, `true`, `false`, `null`), `==`, `!=`, `<`, `>`, `<=`, `>=`, `&&`, `||`, `!` and parentheses, plus RFC 6901 pointers on a resolved value. Comparison follows the specification: string comparison is case-insensitive, numeric strings coerce, and `null` equals only `null`. Token count (256), parser depth (16), literal length (512) and pointer segments (16) are bounded, and a syntax error reports a code and a position, never document text.

A condition passes only when it evaluates to boolean `true`. An unresolved reference, an unsupported reference, an incomparable pair and a non-boolean result all fail closed and say which.

Every value carries a classification, and every result carries the join of what it was derived from: a comparison against a `secret` input is `secret`, and negating it does not launder it. A workflow output that resolves to a step output classified `personal` or `secret` is a blocking `arazzo.policy.private-output`, and one with no registered classification is a blocking `arazzo.policy.unclassified-output`.

## ARZ-N6: binding identity

The `OperationBindingCatalog` is host state. Per source description name it pins one document identity — a source digest or an exact URL — the document version the host reviewed, and, for each `operationId` or `operationPath`, the registered operation `id@version` it means, plus its parameter, request-body and output mappings and its replay policy.

Resolution is exact and never a first match:

- a plain `operationId` is looked up in every non-`arazzo` source description; if more than one **registered** document defines it, the step is a blocking `arazzo.identity.ambiguous-operation` and must disambiguate with `$sourceDescriptions.<name>.<operationId>` or an `operationPath`;
- an `operationPath` must be `{$sourceDescriptions.<name>.url}#<json-pointer>`; an absolute URL, a foreign location or a bare pointer is refused;
- a catalog document whose pinned URL differs from the declared source description URL is `arazzo.identity.source-mismatch`;
- more than one catalog document for one source description is `arazzo.identity.ambiguous-document`;
- an operation the catalog does not bind is `arazzo.binding.unbound-operation`, and one the catalog names but the `OperationRegistry` does not hold is `arazzo.binding.unregistered-operation`;
- a catalog whose `tenantId` differs from the compilation's is refused outright.

An imported description contributes no part of this. Importing a workflow never registers a provider operation.

## ARZ-N7: studio review and export

`reviewArazzoImport(document)` reports the read, a studio projection and a per-workflow executability review. The studio edits the deliberately constrained v1 shape — Arazzo `1.0.1`, `info.version` `1.0.0`, exactly one `openapi` source named `provider`, lowercase identifiers, `operationId`-only steps — so every other construct is a loss with a pointer, and `editable` is true only when no loss is blocking. Saved v1 projects keep validating through `connectorProjectSchema` unchanged; nothing here relaxes them.

`exportArazzo(read, { version })` writes the preserved model back in the specification's field order for the requested version. Same-version and 1.0.1 → 1.1.0 exports are exact (the latter noting `arazzo.export.version-changed`). A 1.1.0 document containing 1.1-only constructs cannot be written as 1.0.1: each construct is a blocking `arazzo.export.version-downgrade-loss` and **no document is produced**. Fields outside the specification are dropped with a warning; `x-` extensions round-trip.

## Sources

- Arazzo 1.1.0: <https://spec.openapis.org/arazzo/v1.1.0.html>
- Arazzo 1.0.1: <https://spec.openapis.org/arazzo/v1.0.1.html>

Tests: `tests/connectors/arazzo/read.test.ts`, `compile.test.ts`, `evaluator.test.ts`, `preservation.test.ts`, `runtime.test.ts`. Passing them is unit and protocol-fixture evidence; it is not a claim that any third-party Arazzo runner accepts these documents.

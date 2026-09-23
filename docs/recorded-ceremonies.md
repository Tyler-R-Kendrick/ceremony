# Recorded ceremonies

A recorded ceremony is a login written down as data: which page, which control, and what was done to it. It is captured while the browser login driver completes a real login, and it replays later with no model in the loop. This is what "an AI recorded a new auth ceremony" means for a service the code has never seen. No code is generated, and no endpoint is embedded. The artifact is value-free, a person publishes it, and the driver that replays it is the same driver that enforces every safety rule on a live login.

It sits beside two things that already existed:

- A [ceremony plan](ceremony-discovery.md) says what getting in _requires_: the steps, their order, and the data a caller must bring. It has no actions, so nothing can execute one. `ceremonyPlanFromRecording` derives the plan a recording implies, so the question "what do I have to supply?" can be asked of a recording too.
- A [recipe](ceremony-teaching.md) composes _registered_ operations. A demonstration can only rearrange steps that already exist in TypeScript, and `compileDemonstration` drops an event whose operation is unregistered. A recorded ceremony is how a new provider's sign-in pages become something that can run again.

## What a recording holds

The schema is `recordedCeremonySchema` in `src/core/recorded-ceremony.ts`, at version 1. Every object in it is strict.

| Field          | Meaning                                                                                                                                                                                                                                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `origins`      | Every origin the recording may act on: HTTPS, or the loopback fixture. Each page, branch and success check must name one of them.                                                                                                                                                                                            |
| `entry`        | Where a replay is expected to start: an origin and a path pattern.                                                                                                                                                                                                                                                           |
| `steps[]`      | Ordered. Each step has a `page` (origin plus a path pattern where `*` is exactly one segment, with no query or fragment), an `action`, and `optional`.                                                                                                                                                                       |
| `action`       | `fill` a `target` with a credential **role** (`username`, `password`, `totp-code`, …), `click` a `target` expecting `navigation` or `same-page`, `check` a checkbox, `select` an `option` of a select by its visible label, or `wait-for` a page mid-transition. There is no value field, so nothing can put one there.      |
| `target`       | A fingerprint, not a selector: control kind, input type, `name`, `autocomplete`, accessible name (`label`), `placeholder`, and caption (`text`). `ordinal` of `of` settles identical twins. At least one descriptor is required.                                                                                             |
| `branches[]`   | A page that changes what happens wherever it appears. `continue-at` a step (an MFA page that only sometimes appears), `finish`, or `stop` with a reason (an account chooser that a person must answer).                                                                                                                      |
| `success[]`    | Pages that mean the login finished. A replay claims completion there. The claim is only a claim, and the verifier decides.                                                                                                                                                                                                   |
| `roles`        | Exactly the roles that some step fills. The schema checks this in both directions.                                                                                                                                                                                                                                           |
| `issued`       | Optional. What a replay keeps from a provider page (an OAuth client's ID and secret), by the exact label of each read-only field, and which host sink kind receives it. The same declaration a login plan carries; see [keeping a value the provider issues](browser-login-sessions.md#keeping-a-value-the-provider-issues). |
| `recordedWith` | `deterministic` (the built-in rules chose), `host-model` (the host's model chose), or `repair` (a model fixed a drifted step of `basedOn`). A reviewer weighs each one differently.                                                                                                                                          |

Limits: 32 steps, 8 branches, 4 success pages, 8 origins, 120 characters per descriptor, and 64 KiB canonical.

### Why no value can get in

- A fill names a role. The driver resolves that role from the host's credential source at the moment of filling. A TOTP code is derived from a held seed at that moment. The recording never sees any of these.
- Descriptor text that looks like a value is refused by the schema: an address, a run of six or more digits, a base32 seed (grouped or lower-cased), an `otpauth:` URI, or a long token. A "Continue as ada@example.com" caption costs the fingerprint that descriptor. The value never reaches the recording.
- While compiling, every descriptor that contains a value the login resolved is dropped. This covers every role, not only the secret ones, and it covers the expected account reference too. A path segment that contains one of those values, or looks like a value, becomes `*`. Segments are judged after percent-decoding, so `/u/alice%40corp.example/password` is recorded as `/u/*/password`. Then the finished canonical bytes are checked against all of those values again. If one survived anywhere, compilation fails with `protected-value` and no recording exists. A trace the format cannot hold at all, such as more identical controls than a fingerprint can count, is refused as `invalid`. Either way only the recording is lost: the login's own result is reported as it happened.
- A chosen option is page text, held to the descriptor rule. An option that reads like a value (an address, an account number) cannot be stored, so the compile fails with `unrecordable-choice` rather than keep it.
- `issued` names fields by label. The values the login kept are added to the compile's exclusions, and nothing in a recording could hold one anyway.
- Only actions the driver actually _applied_ are recorded. The recording seam is `onApplied`. A refused proposal, a re-read after the page moved, or a note an interpreter wrote never reaches it. An exact repeat of the previous action is a retry, and it is not replayed.

## Recording

`browser_record_login` over MCP, or `POST /api/v1/teaching/tools/browser-record-login`, takes the same draft as `browser_login` plus `recording: { id, title }`. The id and title are checked against the recording format before anything runs: a title that is untrimmed or looks like a value (an address, a run of digits) is a bad request. The login runs exactly as it otherwise would. With `reasoning: "host-model"` the host's model reads the pages. With `deterministic` the built-in rules do. The value-free trace of what was applied is compiled at the end. The result is saved as a **draft** only if the login reached a submission (`verified`, or `submitted-unverified` where the host allows that). The draft records which of those two outcomes it came from.

The tool needs both `executor` (it drives a login) and `author` (it saves an artifact). It is registered only when the host keeps recordings (`createHostBrowserLogin` always does) and only for an actor who could author. `ceremony_recording_read` reads a draft by `draftId`, or a published version by `{ id, version, digest }`. A draft is returned with the plan it implies.

## Review and publication stay with people

Drafts follow the recipe lifecycle, with one addition: review and publication require `actorKind: "human"` as well as the capability.

| Route (under `/api/v1/teaching`)                    | Who                                                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `GET /recorded-ceremonies/drafts/:draftId`          | Its author, or anyone holding `reviewer` or `publisher`                                                      |
| `POST /recorded-ceremonies/drafts/:draftId/edit`    | Its author. The edit is a new revision and a new digest. It cannot change `id`, `recordedWith` or `basedOn`. |
| `POST /recorded-ceremonies/drafts/:draftId/review`  | A person holding `reviewer`, for one `{ revision, digest }`                                                  |
| `POST /recorded-ceremonies/drafts/:draftId/publish` | A person holding `publisher`, only for a digest that has a current review. It mints `1.0.N`.                 |

No MCP tool reviews, publishes or retires a recording. Published versions are immutable and tenant-scoped. They are digested again on every read, so bytes that changed underneath their digest are refused and never replayed. An admin can retire a version through `RecordedCeremonies.retire`.

## Replay

A login plan names a published recording in `draft.recording: { id, version, digest }`. The reference is part of the compiled plan and its digest, so an approval to replay one recording cannot be used to replay another. Before any browser starts, `browser_login` refuses with `plan-rejected` if the recording is not published at that digest for that connector (`recording-unavailable`), or if it acts on an origin the plan does not admit (`recording-origin-not-declared`). A recording keeps exactly what its reviewer saw it keep: a plan replaying one must carry the same `issued` declaration (fields in any order, same sink kind), and a plan that adds one, drops one or changes one is refused as `recording-issued-mismatch`.

`runRecordedCeremony` (in `browser-driver.ts`) does not drive the browser itself. It becomes the interpreter for `runCeremony`. At each observation it finds the next step whose page matches and locates that step's control by fingerprint. The control's kind and input type must agree, and a majority of the recorded descriptors must still agree. It then proposes exactly what was recorded. Origin policy, per-role recipients, the protected-value canary, the dispatch ledger, stale-document refusals, human handoff and the step budget all apply unchanged. **A replay makes zero model calls.** The tests count them.

### Drift

When the provider no longer matches the recording, the replay stops before acting and says where. The `RecordingDrift` kinds are:

- `element-missing`: the step's page matched, but no control fits the fingerprint.
- `element-ambiguous`: more controls fit than were recorded.
- `unexpected-page`: the next required step's page did not appear. If a click recorded as `navigation` left the page where it was, the report names that click.
- `undeclared-origin` and `missing-role`: refused before a page is opened.

Each kind carries the step id, the expected page pattern, the control descriptors, and the observed origin plus pathname. None of these can hold a value. Through `browser_login`, drift ends as `blocked` with reason `recording-drift`, and the model is not consulted even when the plan allows one.

A **repair** happens only through `browser_record_login` with `basedOn`, and only when the plan says `reasoning: "host-model"` and the host has a model. The model is asked about the drifted pages only. The replay picks the recording up again as soon as a page matches. What worked is compiled as a new draft with `recordedWith: "repair"` and `basedOn` set. It is never published automatically. The published version keeps drifting until a person publishes the repair.

## Evidence

- `tests/recorded-ceremony.test.ts` runs in Node against the [auth scenario double](auth-scenario-doubles.md) in its identifier-first shape with a seed-derived TOTP code (`identifierFirst`, `totpSeed`). It records with a scripted interpreter standing in for a model, replays with zero interpreter calls, restyles the double (`restyle(seed)`: same origin and accounts, regenerated markup) to force drift, repairs only with a fallback, and checks that the schema rejects value fields, value-like text, undeclared origins and query strings. Canary credentials are asserted absent from recordings, transcripts, progress events and drift reports. It also records a registration whose required country picker the production heuristic answers from the plan's `choices`, and replays the `select` step at a fresh provider with zero interpreter calls.
- `ISSUED-SERVICE` in `tests/browser-login-service.test.ts` records an app registration that keeps a client's ID and secret, has its author widen the numbered settings path, publishes it, refuses replays whose `issued` declaration differs, and replays it with the same one.
- `tests/recorded-ceremony-host.test.ts` runs through the reference host in a real Chromium, over MCP and HTTP. An agent records, a person reviews and publishes, `browser_login` replays with zero model calls, a redeploy stops with `recording-drift`, and a repair is only a draft. Every tool result and route response is swept for the canaries.
- `tests/recorded-ceremonies-store.test.ts` covers the draft, review and publish gating, edits, digest pinning, tamper refusal, tenant scope and retirement.

This is local fixture evidence against owned doubles. It is not certification of any real provider. A recording made against a real provider replays only as long as that provider's pages keep the shape the recording saw.

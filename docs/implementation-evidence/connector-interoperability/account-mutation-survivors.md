# Account sign-in mutation: the run and every survivor

`npm run test:accounts:mutation` (`stryker.accounts.config.mjs`) mutates the
account sign-in decisions in a stated set of files. The comment at the top of
that config is the list, and it also names the files that are not mutated, so a
score here says nothing about them. This page records the last full run, what
was done about its survivors, and a verdict on every mutant that is still
undetected.

A verdict is a reading of the code, not a measurement. "Equivalent" and
"unreachable" are claims a reviewer can check against the line named in the row.
No second tool confirmed any of them.

## The full run

|         |                                                                                                                                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tree    | `b2def3a`. The commit after it, `5d71114`, adds tests and no source.                                                                                                                                                     |
| Command | `node node_modules/@stryker-mutator/core/bin/stryker.js run stryker.accounts.config.mjs --concurrency 2 --reporters progress-append-only,json` (the config asks for 3 workers; the run used 2 on a shared 4-CPU machine) |
| Runner  | Stryker 10.0.0, tap runner, per-test coverage (which this runner takes per test file)                                                                                                                                    |
| Window  | 2026-10-12, 10:20 to 11:46 UTC                                                                                                                                                                                           |
| Time    | 86 minutes 52 seconds, of which the unmutated initial run was 1 minute 2 seconds                                                                                                                                         |
| Mutants | 1,354 in 11 files                                                                                                                                                                                                        |
| Result  | 1,253 killed, 4 timed out, 92 survived, 5 without coverage: 97 undetected, 92.84%                                                                                                                                        |

The raw report is 1.1 MB, repeats the source of all 11 files, and is not
committed. The tables below are the record.

## After the run

Sixteen of the 97 sat in code this round added or changed and could reasonably
be pinned. Commit `5d71114` adds the tests. Two partial reruns then ran only the
lines they target:

- The first passed one `--mutate` per range. Stryker 10 uses only the last of a
  repeated `--mutate`, so it ran only `invoke.ts` lines 182 to 186: 5 mutants, 4
  detected, 1 undetected (the `invoke.ts` 184:15 row below, the optional chain). 1 minute 32 seconds.
- The second used a temporary config (since deleted) whose `mutate` list named
  the other five ranges: `refresh.ts` 119 to 125, `selection.ts` 171,
  `client.ts` 67, `evidence.ts` 53 to 66 and `invoke.ts` 90 to 93. 34 mutants in
  5 files, 34 detected. 4 minutes 5 seconds.

So at most 81 mutants are undetected: 97 less the 16, a score of 94.02%. That
figure is arithmetic over one full run and two partial reruns, not one run. The
remaining mutants were not rerun after the new tests. A test cannot turn a
killed mutant into a survivor, which is why the figure is a ceiling on the
undetected count. It has not been checked by a second full run, which is about
87 minutes.

## A run that was discarded

An earlier full run is not quoted anywhere. It started before the last changes
of this round, and it crossed 10:00 UTC, when the Vercel double's ID tokens
stopped validating against the wall clock (fixed in `84ac563`). Tests failing
because of the date would have counted as kills. Its report was not kept.

## Verdicts

- **equivalent**: the mutant changes nothing a caller can observe, or the same
  result is reached another way. The row says which.
- **unreachable**: an invariant the row names keeps the mutated branch from
  running. A test cannot reach it without breaking that invariant.
- **layered**: another check on purpose kept in the code answers first, so the
  mutated one is a duplicate. Removing the duplicate would be a design change.
- **wording**: the text of a message or of a capability row's `limitations`, or
  a label inside an opaque reference. No test is for it.
- **debug cause**: the `cause` kept on an error so a person debugging can read
  it. Nothing in the product reads it. What it must not contain is pinned by the
  custody and error-cause sweeps, not that it is there.
- **test gap**: a test could pin it and none does yet. It needs a person to
  decide whether it is worth the fixture.

Of the 81: 47 equivalent, 13 unreachable, 9 debug cause, 6 wording, 3 layered
and 3 test gap.

## By file

Counts are mutants. "After" subtracts the 16 detected by the reruns above.
Three files have no undetected mutant and so no rows below:
`vercel/credentials.ts` (the lease guard), `vercel-account/contracts.ts` (the
issuer-policy guard) and `vercel-account/management.ts`.

| File                               | Mutants  | Detected, full run | Undetected, full run | Score, full run | Undetected after the rerun | Score after |
| ---------------------------------- | -------- | ------------------ | -------------------- | --------------- | -------------------------- | ----------- |
| `aws-identity-center/refresh.ts`   | 137      | 125                | 12                   | 91.24%          | 10                         | 92.70%      |
| `vercel-account/ceremony.ts`       | 281      | 261                | 20                   | 92.88%          | 20                         | 92.88%      |
| `vercel-account/invoke.ts`         | 152      | 140                | 12                   | 92.11%          | 9                          | 94.08%      |
| `vercel-account/session.ts`        | 96       | 80                 | 16                   | 83.33%          | 16                         | 83.33%      |
| `aws-identity-center/material.ts`  | 145      | 138                | 7                    | 95.17%          | 7                          | 95.17%      |
| `aws-identity-center/selection.ts` | 260      | 250                | 10                   | 96.15%          | 9                          | 96.54%      |
| `vercel/credentials.ts`            | 34       | 34                 | 0                    | 100.00%         | 0                          | 100.00%     |
| `vercel-account/client.ts`         | 99       | 95                 | 4                    | 95.96%          | 3                          | 96.97%      |
| `vercel-account/contracts.ts`      | 10       | 10                 | 0                    | 100.00%         | 0                          | 100.00%     |
| `vercel-account/evidence.ts`       | 72       | 56                 | 16                   | 77.78%          | 7                          | 90.28%      |
| `vercel-account/management.ts`     | 68       | 68                 | 0                    | 100.00%         | 0                          | 100.00%     |
| **all**                            | **1354** | **1257**           | **97**               | **92.84%**      | **81**                     | **94.02%**  |

## Every undetected mutant

Location is line:column in the file named by the heading, as of `b2def3a`.
`5d71114` changes no source, so the locations still hold.

### `aws-identity-center/refresh.ts`

| Location | Mutation                                                                           | Verdict                                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 58:9     | ConditionalExpression: `cause === undefined` to `true`                             | **debug cause**: the cause kept on an ended session is for people who debug; nothing reads it                                                   |
| 58:9     | ConditionalExpression: `cause === undefined` to `false`                            | **debug cause**: the cause kept on an ended session is for people who debug; nothing reads it                                                   |
| 58:9     | EqualityOperator: `cause === undefined` to `cause !== undefined`                   | **debug cause**: the cause kept on an ended session is for people who debug; nothing reads it                                                   |
| 58:36    | ObjectLiteral: `{ cause }` to `{}`                                                 | **debug cause**: the cause kept on an ended session is for people who debug; nothing reads it                                                   |
| 90:5     | ObjectLiteral: `{ mode: "until-applied", random: ctx.environment.random }` to `{}` | **equivalent**: beginAttempt takes the `until-applied` path for any mode other than `each-request`, so an empty options object behaves the same |
| 90:13    | StringLiteral: `"until-applied"` to `""`                                           | **equivalent**: beginAttempt takes the `until-applied` path for any mode other than `each-request`, so an empty mode behaves the same           |
| 142:7    | ConditionalExpression: `!(error instanceof ConnectorError)` to `false`             | **equivalent**: a value that is not a ConnectorError falls through to `return error` either way                                                 |
| 146:41   | ObjectLiteral: `{ ...` to `{}`                                                     | **equivalent**: verify answers `error.detail ?? role.revoked`, so a missing detail reads the same                                               |
| 169:11   | ConditionalExpression: `refreshed === current` to `false`                          | **equivalent**: wrapping when nothing was refreshed rewrites the unchanged record; no caller reads the generation it bumps                      |
| 227:5    | ConditionalExpression: `described.expiresAt !== undefined` to `true`               | **equivalent**: custody stamps an expiry on every record this adapter writes, so the guard is always true                                       |

### `vercel-account/ceremony.ts`

| Location | Mutation                                                                                                                                           | Verdict                                                                                                                                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 234:21   | ArrayDeclaration: `[]` to `["Stryker was here"]` (no coverage)                                                                                     | **unreachable**: the sign-in always carries the credential-accepted claim, so the default is never taken                                                                                                           |
| 87:57    | ObjectLiteral: `{ ...` to `{}`                                                                                                                     | **equivalent**: these inputs matter only to dynamic or metadata-document registration; the pinned policy allows only a pre-registered client                                                                       |
| 88:17    | ArrayDeclaration: `[VERCEL_DEVICE_GRANT]` to `[]`                                                                                                  | **equivalent**: same: the grant types are read only when a client is registered dynamically                                                                                                                        |
| 105:15   | ConditionalExpression: `typeof raw !== "object"` to `false`                                                                                        | **equivalent**: a non-object that reaches the destructuring has no numeric members, and the next guard returns undefined for it                                                                                    |
| 108:5    | ConditionalExpression: `typeof interval !== "number" \|\| ...` to `false`                                                                          | **equivalent**: redundant with the `Number.isFinite` guards below, which are false for any non-number                                                                                                              |
| 108:5    | LogicalOperator: `typeof interval !== "number" \|\| ...` to `typeof interval !== "number" && typeof nextPollAt !== "nu...`                         | **equivalent**: redundant with the `Number.isFinite` guards below, which are false for any non-number                                                                                                              |
| 108:5    | ConditionalExpression: `typeof interval !== "number"` to `false`                                                                                   | **equivalent**: redundant with the `Number.isFinite` guards below, which are false for any non-number                                                                                                              |
| 109:5    | ConditionalExpression: `typeof nextPollAt !== "number"` to `false`                                                                                 | **equivalent**: redundant with the `Number.isFinite` guards below, which are false for any non-number                                                                                                              |
| 119:11   | StringLiteral: `"complete"` to `""`                                                                                                                | **equivalent**: continueAfterSignIn replaces a complete result with its own, which already sets handoffSettled                                                                                                     |
| 129:19   | ConditionalExpression: `handoff.intent !== DEVICE_CODE_INTENT` to `false`                                                                          | **layered**: the shared device poll repeats this handoff-kind check and refuses with the same detail                                                                                                               |
| 144:7    | LogicalOperator: `result.state !== "complete" \|\| !result.credentialRef` to `result.state !== "complete" && !result.credentialRef`                | **unreachable**: a complete result always has a credential reference and no other result has one, so `                                                                                                             |     | `and`&&` agree |
| 144:7    | ConditionalExpression: `result.state !== "complete"` to `false`                                                                                    | **unreachable**: a complete result always has a credential reference and no other result has one, so `                                                                                                             |     | `and`&&` agree |
| 196:10   | MethodExpression: `'${lead}${parts.join("; ")}${truncated ? "; more are avai...` to `'${lead}${parts.join("; ")}${truncated ? "; more are avai...` | **unreachable**: the line is held under the instructions limit before this cap, so the cap never cuts                                                                                                              |
| 232:10   | MethodExpression: `( ...` to `claims.find(claim => claim.kind === "credential-accepted"...`                                                        | **layered**: storedScopes bounds the list to sixteen again before anything is stored (storedScopes is pinned directly); this cut only bounds the line the selection handoff carries privately, which no test reads |
| 233:5    | OptionalChaining: `claims.find((claim) => claim.kind === "credential-accepte...` to `claims.find(claim => claim.kind === "credential-accepted"...` | **equivalent**: the credential-accepted claim is always present and always has permissions, so the optional chains never short-circuit                                                                             |
| 233:5    | OptionalChaining: `claims.find((claim) => claim.kind === "credential-accepte...` to `claims.find(claim => claim.kind === "credential-accepted"...` | **equivalent**: the credential-accepted claim is always present and always has permissions, so the optional chains never short-circuit                                                                             |
| 233:28   | ConditionalExpression: `claim.kind === "credential-accepted"` to `true`                                                                            | **equivalent**: the credential-accepted claim is the first this adapter returns, so `find` returns it with or without the predicate                                                                                |
| 363:19   | OptionalChaining: `described?.expiresAt` to `described.expiresAt`                                                                                  | **unreachable**: custody keeps the record between the steps, so `describe` never returns undefined here                                                                                                            |
| 373:13   | ConditionalExpression: `described?.expiresAt !== undefined` to `true`                                                                              | **unreachable**: custody keeps the record between the steps, so `describe` never returns undefined here                                                                                                            |
| 373:13   | OptionalChaining: `described?.expiresAt` to `described.expiresAt`                                                                                  | **unreachable**: custody keeps the record between the steps, so `describe` never returns undefined here                                                                                                            |

### `vercel-account/invoke.ts`

| Location | Mutation                                                                                 | Verdict                                                                                                       |
| -------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 196:36   | StringLiteral: `"session.expired"` to `""` (no coverage)                                 | **unreachable**: an ended sign-in always carries a detail, so the default is never taken                      |
| 58:13    | StringLiteral: `"read"` to `""`                                                          | **equivalent**: the command layer replaces a result's `effect` with the bound operation's                     |
| 65:7     | ConditionalExpression: `!(error instanceof ConnectorError)` to `false`                   | **equivalent**: a value that is not a ConnectorError falls through to `return undefined` either way           |
| 68:31    | StringLiteral: `"expired"` to `""`                                                       | **equivalent**: callers use only whether endedSignIn answered and its detail; the code is not read afterwards |
| 127:15   | StringLiteral: `"read"` to `""`                                                          | **equivalent**: the command layer replaces a result's `effect` with the bound operation's                     |
| 168:45   | ArrayDeclaration: `[]` to `["Stryker was here"]`                                         | **equivalent**: the claims of a result that is not complete are not read                                      |
| 176:21   | OptionalChaining: `described?.expiresAt` to `described.expiresAt`                        | **unreachable**: custody keeps the record between the steps, so `describe` never returns undefined here       |
| 184:15   | OptionalChaining: `described?.expiresAt` to `described.expiresAt`                        | **unreachable**: custody keeps the record between the steps, so `describe` never returns undefined here       |
| 219:7    | ConditionalExpression: `oauth.policy.revocation !== "on-upstream-disconnect"` to `false` | **layered**: revokeUpstreamGrant applies the same policy check, so a disabled policy still sends nothing      |

### `vercel-account/session.ts`

| Location | Mutation                                                                                                                    | Verdict                                                                                                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 65:56    | StringLiteral: `""` to `"Stryker was here!"` (no coverage)                                                                  | **unreachable**: a configuration-required error always has a detail, so the default is never taken                                                                                                       |
| 49:3     | StringLiteral: `"oauth.client.secret-missing"` to `""`                                                                      | **equivalent**: the client-secret detail applies to a confidential client; the Vercel client is public (`none`)                                                                                          |
| 50:3     | StringLiteral: `"oauth.client.private-key-missing"` to `""`                                                                 | **equivalent**: the private-key detail applies to a confidential client; the Vercel client is public (`none`)                                                                                            |
| 63:7     | LogicalOperator: `error instanceof ConnectorError && ...` to `error instanceof ConnectorError && error.code === "config...` | **equivalent**: any other error reaches the same rethrow once the lookup of missing names comes back empty                                                                                               |
| 63:7     | ConditionalExpression: `error instanceof ConnectorError && ...` to `true`                                                   | **equivalent**: any other error reaches the same rethrow once the lookup of missing names comes back empty                                                                                               |
| 63:7     | LogicalOperator: `error instanceof ConnectorError && ...` to `error instanceof ConnectorError \|\| error.code === "conf...` | **equivalent**: any other error reaches the same rethrow once the lookup of missing names comes back empty                                                                                               |
| 64:7     | ConditionalExpression: `error.code === "configuration-required"` to `true`                                                  | **equivalent**: any other error reaches the same rethrow once the lookup of missing names comes back empty                                                                                               |
| 71:11    | ConditionalExpression: `missing.length` to `true`                                                                           | **unreachable**: a client-configuration error is raised only when a configuration name is missing, so the list is never empty                                                                            |
| 97:9     | ConditionalExpression: `cause === undefined` to `true`                                                                      | **debug cause**: the cause kept on an ended session is for people who debug; nothing reads it                                                                                                            |
| 97:9     | ConditionalExpression: `cause === undefined` to `false`                                                                     | **debug cause**: the cause kept on an ended session is for people who debug; nothing reads it                                                                                                            |
| 97:36    | ObjectLiteral: `{ cause }` to `{}`                                                                                          | **debug cause**: the cause kept on an ended session is for people who debug; nothing reads it                                                                                                            |
| 97:9     | EqualityOperator: `cause === undefined` to `cause !== undefined`                                                            | **debug cause**: the cause kept on an ended session is for people who debug; nothing reads it                                                                                                            |
| 129:37   | StringLiteral: `"expires_at"` to `""`                                                                                       | **test gap**: the re-check under the lease only matters when a second process has already refreshed the token; the in-process double's single flight answers first, so it takes two processes to observe |
| 130:16   | ConditionalExpression: `!Number.isFinite(held) \|\| held <= now + TOKEN_RENEW_BUF...` to `true`                             | **test gap**: same: the re-check under the lease needs a second process that refreshed first                                                                                                             |
| 130:16   | BooleanLiteral: `!Number.isFinite(held)` to `Number.isFinite(held)`                                                         | **test gap**: same: the re-check under the lease needs a second process that refreshed first                                                                                                             |
| 134:9    | ConditionalExpression: `error instanceof ConnectorError` to `true`                                                          | **equivalent**: a value that is not a ConnectorError has no detail, so it reaches `throw error` either way                                                                                               |

### `aws-identity-center/material.ts`

| Location | Mutation                                                             | Verdict                                                                                                                               |
| -------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 59:7     | ConditionalExpression: `value === undefined` to `false`              | **equivalent**: every caller treats an absent value as malformed, and `Number(undefined)` is not a safe integer, so both paths refuse |
| 176:11   | StringLiteral: `"the rotation kept its material and failed"` to `""` | **equivalent**: never observed: KeptWithFailure is thrown inside the rotation and caught there                                        |
| 177:17   | StringLiteral: `"KeptWithFailure"` to `""`                           | **equivalent**: never observed: KeptWithFailure is thrown inside the rotation and caught there                                        |
| 193:56   | ObjectLiteral: `{ failed: false }` to `{}`                           | **equivalent**: an absent `failed` is falsy, the same as false                                                                        |
| 243:12   | ConditionalExpression: `current.phase === "role-bound"` to `false`   | **equivalent**: the in-memory phase of signedIn's result is never read, and the record stores none                                    |
| 243:30   | StringLiteral: `"role-bound"` to `""`                                | **equivalent**: the in-memory phase of signedIn's result is never read, and the record stores none                                    |
| 243:45   | StringLiteral: `"role-bound"` to `""`                                | **equivalent**: the in-memory phase of signedIn's result is never read, and the record stores none                                    |

### `aws-identity-center/selection.ts`

| Location | Mutation                                                                                                                   | Verdict                                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 118:17   | StringLiteral: `"choose"` to `""`                                                                                          | **equivalent**: `choose` is the fall-through kind: only `none` and `single` are tested for                         |
| 132:13   | StringLiteral: `"choose"` to `""`                                                                                          | **equivalent**: `choose` is the fall-through kind: only `none` and `single` are tested for                         |
| 144:11   | StringLiteral: `"choose"` to `""`                                                                                          | **equivalent**: `choose` is the fall-through kind: only `none` and `single` are tested for                         |
| 145:14   | MethodExpression: `accounts.slice(0, MAX_CHOICES)` to `accounts`                                                           | **equivalent**: the line shown holds fewer than 40 accounts before its own length cap, so the count cap never cuts |
| 150:37   | ConditionalExpression: `accounts.length > MAX_CHOICES` to `false`                                                          | **equivalent**: the line's own length cap already says "more are available" well before 40 accounts                |
| 150:37   | EqualityOperator: `accounts.length > MAX_CHOICES` to `accounts.length >= MAX_CHOICES`                                      | **equivalent**: the line's own length cap already says "more are available" well before 40 accounts                |
| 172:10   | MethodExpression: `'${lead}${parts.join("; ")}${more}.'.slice(0, PRESENTATIO...` to `'${lead}${parts.join("; ")}${more}.'` | **unreachable**: the line is held under the instructions limit before this cap, so the cap never cuts              |
| 266:24   | MethodExpression: `[...SELECTION_FIELDS].sort()` to `[...SELECTION_FIELDS]`                                                | **equivalent**: SELECTION_FIELDS is already in sorted order                                                        |
| 324:16   | StringLiteral: `"role-bound"` to `""`                                                                                      | **equivalent**: the in-memory phase of the bound material is never read, and the record stores none                |

### `vercel-account/client.ts`

| Location | Mutation                                         | Verdict                                                                                                         |
| -------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| 75:45    | ObjectLiteral: `{ cause: error }` to `{}`        | **debug cause**: the cause kept on a cancelled call is for people who debug; nothing reads it                   |
| 90:11    | BlockStatement: `{ ...` to `{}`                  | **equivalent**: a body that is not JSON leaves `json` undefined with or without the handler's (empty) statement |
| 147:7    | AssignmentOperator: `added += 1` to `added -= 1` | **equivalent**: `added` is only compared with zero, and -1 is as non-zero as 1                                  |

### `vercel-account/evidence.ts`

| Location | Mutation                                                                              | Verdict                                                                                        |
| -------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 111:9    | ConditionalExpression: `input.validUntil !== undefined` to `true`                     | **equivalent**: the second conjunct `validUntil > now` is already false for an undefined value |
| 126:60   | StringLiteral: `"none"` to `""`                                                       | **wording**: the permission source is not part of the stored evidence                          |
| 126:41   | StringLiteral: `"token-response"` to `""`                                             | **wording**: the permission source is not part of the stored evidence                          |
| 131:9    | StringLiteral: `"Vercel reports granted scopes, not the team permissions ...` to `""` | **wording**: limitation text, which no test is for                                             |
| 139:21   | StringLiteral: `"User reported by GET /v2/user for this sign-in"` to `""`             | **wording**: limitation text, which no test is for                                             |
| 144:32   | StringLiteral: `"team"` to `""`                                                       | **wording**: the label inside an opaque evidence reference                                     |
| 147:9    | StringLiteral: `"The team appeared in GET /v2/teams for this token; what ...` to `""` | **wording**: limitation text, which no test is for                                             |

## What is left for a person

- The three **test gap** rows are in `vercel-account/session.ts` lines 129 and
  130, the re-check of the token's expiry after the refresh lease is taken. It
  matters only when a second process refreshed first. The double's single flight
  in one process answers before it, so seeing it needs two processes sharing
  one store. Whether that fixture is worth it is a call for the owner.
- The 47 **equivalent** and 13 **unreachable** rows are claims. Each names the
  line that makes it so; a reviewer who finds one wrong has found a missing test.
- Nothing here is evidence about a live provider. The doubles are the
  protocol-fixture evidence described in `docs/testing.md`.

## Reproduce

```
npm run test:accounts:mutation
```

The report lands in `artifacts/accounts-mutation/mutation.json`. Expect about
87 minutes with two workers (`-- --concurrency 2`). To rerun only some lines,
use a temporary config that spreads the base and lists ranges on the paths,
because a repeated `--mutate` flag keeps only its last value:

```js
import base from "./stryker.accounts.config.mjs";
const P = "src/server/connectors/providers";
export default {
  ...base,
  mutate: [
    `${P}/vercel-account/evidence.ts:53-66`,
    `${P}/vercel-account/invoke.ts:90-93`,
  ],
  reporters: ["progress-append-only", "json"],
};
```

# Teaching delivery ownership

Starting local source matches delivery branch `fix/unified-connector-ceremonies`
at `db46b2d06f62b72316d8e46c4a87cc22967590ad`, newer than the brief's
`efaf73b5046a91d9703643359b8b2468e7bcce72` research baseline. The original
workspace's Git metadata is mounted read-only; delivery Git operations use the
existing isolated clone. Existing encrypted development state is preserved and
is not an input to tests or model requests.

| Owner             | Files / invariant                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| INT (coordinator) | Dependencies, exports, mounting, command integration, test discovery, final evidence                                                             |
| TYP               | `src/core/*-contracts.ts`, `projections.ts`; strict portable types and positive allowlists                                                       |
| STO               | `src/server/persistence/`; awaited transactions, encrypted records, CAS and fencing                                                              |
| IDN               | `src/server/identity.ts`, `authorization.ts`; host-derived principal and OIDC sessions                                                           |
| ACT / ORC         | `commands.ts`, `teaching-runtime.ts`, `recipes/`, core tools; protected dispatch, pinned composition, verified dependency gates and continuation |
| PRV / HUM         | `github-runtime.ts`, `recipes/github.ts`, private collections, legacy MCP; real protocol children, recipient binding and cancellation fencing    |
| AGT / AUT         | `server/agent/`, `demonstrations.ts`, recipe service; bounded AI SDK, actual Workflow waits, consent ledger and reviewed publication             |
| UX / PWA          | `src/react/teaching.tsx`, existing example/PWA assets; shared host-stylable surface, private cache policy and supported install controls         |
| E2E (independent) | `tests/browser/teaching-*`, fixtures, packed consumers; actual mounted three-engine journeys and provider-side effect assertions                 |
| SEC (independent) | security tests, mutation guards, transport/projection attacks and evidence validation; no blanket success from a scanner                         |
| OPS / INT         | hosted routes, maintenance, sanitized verification runner, strict release profile and exact-checkout delivery                                    |

Concurrent owners consume these shared interfaces and pass focused results back
to the coordinator. No independently generated schema duplicates or parallel authority
engines are permitted. Raw provider credentials, private browser state and model
prompts are excluded from evidence. Each executed gate must identify its command
and actual result; an unexecuted requirement is not passing evidence.

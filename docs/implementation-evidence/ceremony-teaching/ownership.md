# Teaching delivery ownership

Starting local source matches delivery branch `fix/unified-connector-ceremonies`
at `db46b2d06f62b72316d8e46c4a87cc22967590ad`, newer than the brief's
`efaf73b5046a91d9703643359b8b2468e7bcce72` research baseline. The original
workspace's Git metadata is mounted read-only; delivery Git operations use the
existing isolated clone. Existing encrypted development state is preserved and
is not an input to tests or model requests.

| Owner | Files / invariant |
| --- | --- |
| INT (coordinator) | Dependencies, exports, mounting, command integration, test discovery, final evidence |
| TYP | `src/core/*-contracts.ts`, `projections.ts`; strict portable types and positive allowlists |
| STO | `src/server/persistence/`; awaited transactions, encrypted records, CAS and fencing |
| IDN | `src/server/identity.ts`, `authorization.ts`; host-derived principal and OIDC sessions |

Later domain, agent, UX and independent verification owners consume these shared
interfaces. No independently generated schema duplicates or parallel authority
engines are permitted. Raw provider credentials, private browser state and model
prompts are excluded from evidence. Each executed gate must identify its command
and actual result; an unexecuted requirement is not passing evidence.

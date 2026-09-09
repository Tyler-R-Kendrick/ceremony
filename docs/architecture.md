# Architecture and ownership

Ceremony is an authentication library with a reference browser/PWA and a hosted adapter, not a general workflow editor. Connect is an outcome: reuse compatible verified access, prepare missing prerequisites, request necessary human participation, verify provider evidence, then resume the authorized host task.

## Repository boundaries

| Path           | Owns                                                                                                                 | Must not own                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `src/core/`    | Strict schemas, recipes, projections, client state, shared tool definitions                                          | React, model inference, storage, provider secrets            |
| `src/react/`   | Optional components, OpenUI rendering, host-overridable styles                                                       | Protocol authority or provider verification                  |
| `src/mcp-app/` | Trusted native private collector integration                                                                         | Agent-visible credential values                              |
| `src/server/`  | Authenticated commands, registered operations, identity, private broker, recipes, storage, agent/hosted integrations | Authority inferred from model prose or browser source labels |
| `hosted/`      | Thin Nitro HTTP mounting of the production runtime                                                                   | Alternate process-local authorization implementation         |
| `examples/`    | Reference UI, loopback server and protocol fixtures                                                                  | Production identity or vendor certification                  |
| `tests/`       | Independent boundaries, properties, faults, protocol/browser/packed-consumer proof                                   | Live secrets or manufactured acceptance success              |
| `scripts/`     | Developer verification, release evidence and storage maintenance                                                     | End-user ceremony dependencies                               |

Public exports remain `@ceremony/auth`, `./react`, `./server`, `./server/teaching`, `./mcp-app`, and optional styles. The package is private; moving code across one of these boundaries requires consumer/bundle verification, not just a TypeScript pass.

## Execution and trust

```text
Host UI / native WebMCP / in-page agent
                 |
Authenticated command policy + revision/effect binding
                 |
Deterministic recipes -> registered provider operations -> trusted verification
                 |                     |
        encrypted shared state    private broker / human handoff
                 |
Transactional events + outbox -> durable host continuation
```

The host supplies authenticated tenant, subject and session context. A source string, recipe digest, callback, private-reference shape or human “Done” message does not grant authority. Consequential work rechecks current policy and context. Provider verification—not successful tool transport—establishes authenticated access.

Whole ceremonies and fragments use one recipe schema. Publication pins reviewed child versions; import creates a draft. Sharing a procedure never transfers credentials, browser sessions, account ownership or earlier consent. Artifacts must match the new principal, provider/profile, environment, callback origin, target and configuration/permission version before reuse.

Commands persist identities and effect intent before external effects. Transactions do not span inference, provider HTTP or human waits. Revisions and worker generations fence stale commits; uncertain one-use effects enter reconciliation rather than blind replay. Outbox delivery is at least once with stable continuation identities, not a claim of universal provider exactly-once behavior.

## Deliberate integration choices

- OpenUI owns presentation; registered operations own executable semantics. Existing Arazzo exports are compatibility surfaces, not generated-code authority.
- AI SDK provides bounded model/tool calls and authoring suggestions. Workflow carries durable agent turns/waits. Domain records remain authoritative; reviewed recipe execution needs zero model calls. No second Eve/Chat SDK runtime is introduced.
- Async PostgreSQL is the shared production store. Local encrypted SQLite supports development; legacy synchronous APIs are explicitly compatibility-only. See [migration](persistence-migration.md).
- GitHub App preparation, installation and access verification are real composable operations exercised with signed local HTTP fixtures. Optional human-browser/MCP/A2H behavior and other adapters retain their exact [support status](service-examples.md); no broad certification is implied.
- Human, agent, demonstration, export and audit projections are separate positive allowlists. Secrets, protocol codes and control URLs never enter model histories, demonstrations, analytics captures or exported recipes.

Stop assistant, cancel connection and discard demonstration are distinct controls. None silently revokes upstream grants. The service worker caches only explicitly permitted static assets; offline UI cannot claim stale access is verified or queue credential writes.

See [threat model](ceremony-teaching-threat-model.md), [agent integration](agent-integration.md), [production requirements](production-deployment.md), and [evidence](implementation-evidence/ceremony-teaching/README.md) for enforceable limits and certification gaps.

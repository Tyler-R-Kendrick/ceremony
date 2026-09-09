# Dependency and boundary review

Installed package metadata inspected for this delivery:

| Package                     | Version         | Declared license | Boundary                                      |
| --------------------------- | --------------- | ---------------- | --------------------------------------------- |
| `ai`                        | 7.0.95          | Apache-2.0       | Server-only bounded model/tool execution      |
| `@ai-sdk/openai-compatible` | 3.0.45          | Apache-2.0       | Explicit full-endpoint adaptation             |
| `workflow`                  | 4.8.7           | Apache-2.0       | Optional peer, hosted durable carrier         |
| `@workflow/vitest`          | 4.0.23          | Apache-2.0       | Local Workflow verification only              |
| `pg`                        | 8.23.0          | MIT              | Shared transactional production store         |
| `nitro`                     | 3.0.260903-beta | MIT              | Thin Vite-compatible hosted adapter           |
| `embedded-postgres`         | 18.4.0-beta.17  | MIT              | Isolated real PostgreSQL test process         |
| `zod`                       | 4.5.4           | MIT              | Strict runtime contracts                      |
| `jose`                      | 6.2.12          | MIT              | Maintained signed-token verification          |
| `oauth4webapi`              | 3.8.8           | MIT              | Maintained OIDC/OAuth protocol implementation |
| `linkedom`                  | 0.18.13         | ISC              | Existing component-test DOM                   |

The lockfile is authoritative. This is a direct-added-dependency license review, not a legal certification of every transitive package. No AGPL recorder code, browser extension, Eve runtime, Chat SDK, vector database or additional hosted browser subscription was added. Workflow remains optional for library consumers; no model or hosted SDK is initialized by importing the framework-neutral core. Packed consumer builds exercise those boundaries.

Nitro and the embedded database package carry the beta versions shown above; local compatibility tests do not establish deployed Vercel certification. The latter is an explicit live release gate. AI Gateway is chosen only through explicit host configuration; an existing compatible endpoint is not silently routed to a paid provider.

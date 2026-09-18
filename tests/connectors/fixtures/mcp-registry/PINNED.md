# Pinned MCP registry artifacts

Fetched 2026-09-18 from primary sources; tests never reach the network.

| Artifact | Source | Pin |
| --- | --- | --- |
| `server.schema.2025-12-11.json` | https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json | sha256 `3fba09590c99f61735d234822279f4223fab9e300c0a81e81c91ab62a4114de0` |
| REST API | https://registry.modelcontextprotocol.io/openapi.yaml (`Official MCP Registry` 1.0.0, OpenAPI 3.1.0), generic spec `$id` https://modelcontextprotocol.io/schemas/draft/2025-12-01/server-registry-openapi | `/v0.1`: `GET /servers` (`cursor`, `limit` ≤ 100, `search`, `updated_since`, `version`, `include_deleted`), `GET /servers/{serverName}/versions`, `GET /servers/{serverName}/versions/{version}` (`latest` alias), `POST /publish` (bearer) |
| Aggregator guidance | https://modelcontextprotocol.io/registry/registry-aggregators | base URL `https://registry.modelcontextprotocol.io`; path parameters URL-encoded once; `status` may become `deprecated`/`deleted` |

`servers/*.json` are the documented examples from `docs/reference/server-json/generic-server-json.md` plus adversarial variants authored here (`malicious-package.json`, `legacy-snake-case.json`, `missing-schema.json`). `api/servers-page.json` is a list page in the `ServerListResponse` shape.

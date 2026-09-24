# Clients and the package

There are two ways to program against Ceremony from outside this repository. The first is the connector HTTP API, which any language can call through its OpenAPI description. The second is the `@ceremony/auth` package, for TypeScript and JavaScript hosts that embed the runtime or its UI.

## The connector API description

[`docs/openapi/connectors.openapi.json`](openapi/connectors.openapi.json) is an OpenAPI 3.1 description of `/api/v1/connectors/*`: the directory, import and review, bindings, connections, invocation, handoffs, revocation, the provider callback and the signed event routes.

It is generated, not written by hand. `npm run openapi:generate` builds it from the Zod schemas that the handler validates requests with and that the projections parse responses through. `npm run openapi:check` runs as part of `npm run check` and fails when the committed file is stale. `tests/connectors/commands/openapi-contract.test.ts` then drives every operation in the file through the real handler. It checks each request against the description before sending it and each response after it comes back. It fails if an operation is never exercised, if a status code is undocumented, or if a body does not match. The description covers the connector routes only. The teaching routes, `/api/auth/*` and the MCP endpoint are not in it.

### What a client has to know

- **Authentication is the deployment's session cookie**, set by its OIDC sign-in (see [host identity](host-identity.md)). These routes do not accept bearer tokens. An OAuth access token is accepted only by the [MCP endpoint](mcp-endpoint.md), which exposes a narrower set of connector tools. A host that mounts the handler itself supplies its own identity adapter, so its authentication may differ.
- **Every `POST` is a same-origin mutation.** It must send `Origin` equal to the deployment's origin and `Content-Type: application/json`. The description declares `Origin` as a required header parameter, so generated clients send it. A browser sends it anyway.
- **References go in the path percent-encoded.** A connection or definition reference can contain `/` and `:`.
- **Errors** always have the same shape: `{ "error": <code>, "message": <fixed sentence>, "detail"?: <refinement> }`. The code-to-status mapping is fixed, and the `Error<status>` responses list which codes each status carries. Branch on `error`, never on `message`.
- **Human-only operations** carry `x-ceremony-human-only: true`. When any actor other than an authenticated human calls one, the server refuses it with 403 `denied`. `x-ceremony-human-only-inputs` names individual inputs that only a person may send, such as `confirm` on invoke or `accountSwitch` on reconnect. An assistant should not offer these routes or inputs at all.
- **`x-ceremony-capabilities`** lists the host capabilities that admit a caller to each operation. `admin` admits a caller to all of them.

### Generating a client

Any OpenAPI 3.1 generator can read the file. For example:

```sh
# Python, Go, Java, C#, ... (needs a Java runtime)
npx @openapitools/openapi-generator-cli generate \
  -i docs/openapi/connectors.openapi.json -g python -o clients/python

# TypeScript types only
npx openapi-typescript docs/openapi/connectors.openapi.json -o connectors.d.ts
```

A few caveats:

- **Patterns use Unicode property escapes** (`\p{Cc}`, `\u{202A}`). They are valid ECMA-262 regular expressions, which is what JSON Schema 2020-12 specifies, but some generators compile them with engines that reject those escapes. If yours does, turn off its client-side pattern validation. The server validates every request regardless.
- **One pattern is stricter than the server.** A media type's pattern is case-sensitive in the description but case-insensitive on the server, because JSON Schema cannot express the regex flag. Send media types in lower case.
- **`ConnectionView` is a union.** A person gets the full projection, and an assistant gets a narrower one with `verified` instead of verification details. Generators that do not handle `anyOf` well may need the two branches mapped by hand.

None of these generators runs in this repository's CI. The contract test checks the description against the handler, not against a generated client. A client generated from it is only as tested as your own use of it.

## The package

`@ceremony/auth` is ESM-only, requires Node 22.12 or later, and ships its TypeScript declarations. It is not published to a registry (`"private": true` stays in place so that nothing publishes it by accident). To use it, build it and install the tarball:

```sh
npm run build
npm pack                       # writes ceremony-auth-0.1.0.tgz
cd ../your-app && npm install ../ceremony/ceremony-auth-0.1.0.tgz
```

| Entry point                              | What it is                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `@ceremony/auth`                         | Framework-neutral core: contracts, schemas, the ceremony and connector clients            |
| `@ceremony/auth/react`                   | React components (optional peers `react`, `react-dom`, `@openuidev/react-lang`)           |
| `@ceremony/auth/server`                  | Server runtime: persistence, identity, recipes, teaching and the HTTP handlers            |
| `@ceremony/auth/server/connectors`       | The connector runtime (`createConnectorRuntime`), adapters, registry and `ConnectorError` |
| `@ceremony/auth/server/teaching`         | The teaching runtime on its own                                                           |
| `@ceremony/auth/mcp-app`                 | The private-collector MCP App                                                             |
| `@ceremony/auth/openapi/connectors.json` | The connector API description above, importable with `with { type: "json" }`              |
| `@ceremony/auth/*.css`                   | `styles.css`, `teaching.css`, `connectors.css`                                            |

The tarball holds `dist/` (JavaScript and `.d.ts`), the three stylesheets, `README.md`, `LICENSE` and the reader documentation under `docs/`. It leaves out the implementation evidence, the demo recordings and the internal reviews. The package has no command-line `bin`.

`npm run test:package` checks this in two ways. It packs the package and checks the file list: no tests, fixtures, recordings or built module without a source. Then it unpacks the tarball into a consumer outside this repository whose `node_modules` holds the package's declared dependencies and nothing else. From there it imports every export-map entry by its public name and type-checks each one with `tsc`. If an entry imports a package the manifest does not declare, the import fails. The consumer's dependencies are links to this repository's installed copies, not a fresh `npm install`. That proves the declared set is sufficient, but not that a registry install would resolve the same versions. The suite needs `npm run build` first and skips without it.

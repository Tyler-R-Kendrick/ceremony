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

Any OpenAPI 3.1 generator can read the file. Two of them are exercised against the real handler in this repository's CI, and these are the commands they run:

```sh
# TypeScript: types from openapi-typescript, calls through openapi-fetch
npm install --save-dev openapi-typescript@7.13.0
npm install openapi-fetch@0.17.0
npx openapi-typescript docs/openapi/connectors.openapi.json \
  --default-non-nullable false -o src/generated/connectors.d.ts

# Python: openapi-python-client (pure Python, no Java runtime; Python 3.10+)
python -m pip install openapi-python-client==0.29.1
openapi-python-client generate --path docs/openapi/connectors.openapi.json \
  --output-path ceremony_connectors --meta none
```

`--default-non-nullable false` matters for TypeScript. Without it openapi-typescript makes every property that has a default required, so a request type would demand values the server already defaults, such as `confirm` on invoke and `ownerKind` on connect. `--meta none` writes a bare Python package. Leave it out to get a `pyproject.toml` as well.

**What CI proves.** `npm run test:clients` runs two tests:

- `tests/openapi-client.test.ts` generates the TypeScript types from the committed description into a gitignored directory. It type-checks [a small openapi-fetch consumer](../tests/consumers/openapi-typescript/client.ts) against them with `tsc`, with no casts. It also type-checks [a file of calls the types must refuse](../tests/consumers/openapi-typescript/misuse.ts), such as a `POST` without `Origin`, an unknown route or an unknown lifecycle. Then it drives the real connector handler through that consumer: import, review, binding approval, connect, the provider's authorization, listing, invocation, the 404 for an unknown connection, the assistant's projection and the 403 for a wrong `Origin`. It runs wherever the rest of the suite does.
- `tests/openapi-python-client.test.ts` generates the Python package the same way and fails if the generator reports any warning. Then [`smoke.py`](../tests/consumers/openapi-python/smoke.py) drives the same handler through it over loopback HTTP, covering the same ground except invocation. It needs the pinned generator ([`requirements.txt`](../tests/consumers/openapi-python/requirements.txt)) and skips without it. The `python-client` job in `verify.yml` installs the generator and sets `CEREMONY_REQUIRE_PYTHON_CLIENT=1`, so there the skip becomes a failure.

Both run against the local fixture handler. They show that each generator reads the description and that the resulting client speaks to the handler correctly. They say nothing about a deployment's identity layer, and nothing about any other generator. `@openapitools/openapi-generator-cli` (Go, Java, C# and others, which needs a Java runtime) is not exercised here.

A few caveats:

- **Patterns use Unicode property escapes** (`\p{Cc}`, `\u{202A}`). They are valid ECMA-262 regular expressions, which is what JSON Schema 2020-12 specifies, but some generators compile them with engines that reject those escapes. If yours does, turn off its client-side pattern validation. The server validates every request regardless. Neither generator above compiles them.
- **One pattern is stricter than the server.** A media type's pattern is case-sensitive in the description but case-insensitive on the server, because JSON Schema cannot express the regex flag. Send media types in lower case.
- **`ConnectionView` is a union** of `HumanConnectionView` and `AgentConnectionView`. A person gets the full projection. An assistant gets a narrower one, with `verified` in place of verification details. The two branches are named components. When they were inline, openapi-python-client generated both branches' `handoff` models under the same name, rejected them and silently dropped both projections. Narrow the union on `verified`, which only the assistant's projection has. The generated Python client tries the person's projection first.
- **The provider callback is a browser route.** `GET /callback` is where the provider sends the person's browser back to. It is documented so that its answers are described, but a generated client has no reason to call it.

## The package

`@ceremony/auth` is ESM-only, requires Node 22.12 or later, and ships its TypeScript declarations. It has not been published yet. Until it is, build it and install the tarball:

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

## Releasing

`.github/workflows/release.yml` publishes the package to npm when a GitHub release is published or a `v*` tag is pushed. No release has been cut, and nothing has been published.

**Before the first release, the maintainer must own the `@ceremony` scope on npm.** Create the npm organization or user `ceremony`, or rename the package to a scope you own. Then add an npm automation token with publish rights as the `NPM_TOKEN` secret. It can go on the repository or on the `release` environment the workflow uses. The environment is also where to add required reviewers, so that a pushed tag waits for a person before anything is published.

The workflow:

1. **Stops on a fork.** The job is skipped there.
2. **Fails before anything else if `NPM_TOKEN` is missing**, with an error that says so.
3. **Checks the tag against `package.json`.** `scripts/release-guard.ts` refuses unless the tag is exactly `v` plus the version. Tag `v0.2.0` after setting `"version": "0.2.0"`, never the other way round.
4. Runs `npm ci`, `npm run check`, `npm run build` and `npm run test:package`.
5. **Skips a version the registry already has.** Publishing a release usually pushes its tag as well, so both triggers can fire for one version.
6. **Publishes** with `npm publish --ignore-scripts --provenance --access public`. The token is in the environment of this step and the registry check only; no build or test tool runs with it, because `--ignore-scripts` skips `prepublishOnly` after the steps above have already run the guard, `check`, `build` and `test:package`. The `id-token: write` permission lets npm sign a provenance statement that ties the tarball to this commit and workflow. A version with a prerelease suffix (`0.2.0-rc.1`) goes to the `next` dist-tag instead of `latest`.

`"private": true` is gone, because npm refuses to publish a private package at all. `prepublishOnly` takes over its job: it runs the same release guard first and then `check`, `build` and `test:package`. So `npm publish` from a checkout, without the tag in `CEREMONY_RELEASE_TAG`, stops before building anything. `publishConfig.provenance` also makes npm refuse a publish from outside a CI provider it can attest. The workflow skips `prepublishOnly` with `--ignore-scripts`, because it has just run the same checks as separate steps without the token. A manual `npm publish --ignore-scripts` would skip them too; a manual publish is also refused by `publishConfig.provenance` outside CI.

`tests/release.test.ts` holds the guard to its rule and the workflow to these properties without publishing anything.

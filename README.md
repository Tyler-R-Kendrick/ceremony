# Ceremony

Composable authentication ceremonies with browser-native teaching and optional agent assistance. A host chooses a service; Ceremony reuses compatible setup, guides necessary human participation, verifies access and resumes the authorized task. OpenUI renders presentation; registered server operations execute protocols.

## Run

Use Node **24** (see [.nvmrc](.nvmrc)) and npm:

```sh
npm ci
npm run dev
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173). The separate local protocol fixture uses **4174**. Origins are exact: do not substitute `localhost`. Startup creates an encrypted local vault under `.ceremony/`; never delete its key independently of its database or use it as production identity.

[Development setup](docs/development.md) covers the devcontainer, browser dependencies, configuration and safe cleanup. The repository's [.env.example](https://github.com/Tyler-R-Kendrick/ceremony/blob/main/.env.example) documents configuration names; the app does not automatically load `.env`. Native **Environment** editing keeps values private and session-scoped across connectors.

## Connect, teach, and reuse

- **Connect GitHub** keeps app registration, installation and access verification in one parent ceremony; compatible setup is reused.
- **Workflow studio** creates new connector definitions, authentication methods, Arazzo workflows and A2H fallbacks, with draft save/reopen and isolated OpenUI presentation authoring. It does not run Connect or access Environment.
- **Teach this connection / Teach this step** on Connect capture permitted semantic transitions, not provider DOM or secret input.
- Review a whole ceremony or a contiguous fragment and save a reusable recipe. Compatible published recipes compose with fresh principal/environment bindings; sharing procedure does not share access.
- Reviewed recipes execute without a model. Optional AI SDK assistance and Workflow continuation use the same protected command service and explicit human fallbacks.

Read [teaching behavior](docs/ceremony-teaching.md), [service support](docs/service-examples.md), and [live authentication](docs/live-auth.md). GitHub, Stripe and Supabase have provider-backed adapters; the explicit `/?mode=test` harness contains simulations. Neither local fixtures nor adapter code constitute live-vendor certification. The composable teaching runtime currently uses GitHub App children.

## Library interfaces

The framework-neutral core, optional React/OpenUI components and scoped styles remain independently usable. Hosts own rendering, navigation, identity and policy; server integrations stay behind server exports. The package remains private, with packed React/Vue consumer tests.

See [embedding](docs/integration.md), [API reference](docs/reference.md#library-interfaces), [architecture](docs/architecture.md), and [production deployment](docs/production-deployment.md).

### WebMCP and execution hooks

Native WebMCP and local protected tools share validated commands. Browser source labels are not authority; hooks describe operation outcomes, not proof of provider consent. See [tool contracts and migration](docs/reference.md#webmcp-and-execution-hooks) and [agent integration](docs/agent-integration.md).

## Verification

```sh
npm run setup:browsers
npm run verify
```

The deterministic command covers recursive Node/Pact/security/integration tests, coverage, actual local Workflow recovery, critical mutations, builds, browser behavior and packed consumers. The broader mutation matrix runs separately in CI. See [testing](docs/testing.md) and [contributing](CONTRIBUTING.md).

[Commit-bound implementation evidence](docs/implementation-evidence/ceremony-teaching/final-local/README.md) retains failures and separates local proof from live/deployed/device certification. `verify:live` and `verify:release` fail when required authorized configuration or evidence is absent; a successful merge is not production certification.

## Boundaries

Production requires authenticated host identity, exact HTTPS origins, encrypted shared PostgreSQL state, current policy and configured integrations. The loopback example, local SQLite compatibility APIs and protocol fixtures are not substitutes. Secrets and transient protocol material are excluded from agent, demonstration, export and diagnostic surfaces.

Cancellation does not secretly revoke upstream grants. Payment processing, lead capture, a generic workflow marketplace, package publication and automatic paid-resource provisioning are outside scope. Optional remote-browser/MCP/A2H capabilities keep their documented support and certification limits.

[Documentation index](docs/README.md) · [Product scope](PRODUCT.md) · [Threat model](docs/ceremony-teaching-threat-model.md)

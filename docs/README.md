# Documentation

## Use and embed

- [Teaching and reusable recipes](ceremony-teaching.md): whole/partial demonstrations, review, consent and composition.
- [Embedding](integration.md): framework-neutral and React interfaces, host-owned styles/navigation and consumer examples.
- [API and protocol reference](reference.md): detailed library examples, WebMCP hooks and presentation contracts.
- [Live authentication](live-auth.md), [service support](service-examples.md), and [auth catalog](auth-catalog.md): real adapters versus simulations and unsupported profiles.
- [Connector directory](connector-directory.md): the two in-application connector surfaces — browsing before committing with the four-step Add Connection drawer, and the server-bound workspace for finding, reviewing, connecting and managing a connector.
- [Workflow studio](workflow-studio.md): author new connectors and ceremonies, save drafts, validate and export Arazzo/manifest definitions.
- [Formal specifications](specifications/README.md): versioned connector manifests, AI decision contracts, Arazzo/A2H profiles and executable conformance.
- [Connector interoperability profile](specifications/connector-interoperability.md): source provenance, normalized definitions, the version 2 envelope, support dimensions, evidence levels and projections.
- [Connector dialects and versions](specifications/connector-dialects.md): which document dialects and protocol revisions are read, which subset of each can execute, and how to migrate when one moves.
- [Connector support matrix](specifications/connector-support-matrix.md): per-adapter, per-dimension support, generated from the adapters and the ledgers.
- [Provider catalog](provider-catalog.md): providers described as data, Nango `providers.yaml` import, and declared endpoints approved at binding review.

## Develop and operate

- [Development setup](development.md) and [contributing](../CONTRIBUTING.md): root layout, Node, devcontainer, local state and safe cleanup.
- [Architecture](architecture.md): current ownership and trust boundaries; [product scope](../PRODUCT.md) and [reference design](../DESIGN.md).
- [Testing](testing.md) and [contract testing](contract-testing.md): reproducible checks and honest coverage boundaries.
- [Auth scenario doubles](auth-scenario-doubles.md): self-hosted provider pages for each auth situation, and the ceremony contracts driven against them.
- [Demo videos](demos.md): webreel recordings of the real driver against those doubles, led by account registration, plus a stitched run from "no account" to verified API access. They show what is real and what is a double, and how to regenerate them.
- [Browser login and retained sessions](browser-login-sessions.md): logging into a selected browser, proving which account arrived there, and what releasing it does and does not do — including which backends are proven and which are not.
- [Ceremony discovery](ceremony-discovery.md): reading a provider to work out what getting in requires, without submitting anything, and writing it down as a shareable plan.
- [Recorded ceremonies](recorded-ceremonies.md): recording a real browser login on a service the code has never seen as a value-free artifact, publishing it through human review, and replaying it with no model — stopping by name when the provider drifts.
- [Agent integration](agent-integration.md): AI SDK, Workflow, model configuration and protected tools.
- [MCP endpoint](mcp-endpoint.md): driving ceremonies from a chat client, and why no credential crosses MCP.
- [Local MCP](mcp-local.md): pointing a chat client at the reference application through a tunnel.
- [Connector provider setup](connector-provider-setup.md): redirect origins, permissions, webhook verification, credential custody, environment separation, incidents and reconnects, and why a local disconnect is not an upstream revocation.
- [Host identity](host-identity.md), [production deployment](production-deployment.md), and [persistence migration](persistence-migration.md).
- [Threat model](ceremony-teaching-threat-model.md): protected sources, prohibited sinks and residual risks.

## Evidence and history

[Implementation evidence](implementation-evidence/ceremony-teaching/README.md) contains dated, commit-bound results, including retained failed attempts. [The final implementation checkpoint](implementation-evidence/ceremony-teaching/final-local/README.md) is not a rolling certificate for future commits. The [orchestration design](ceremony-orchestration-design.md) and [Impeccable audit](impeccable-audit.md) retain earlier decisions and observations; current architecture and support documentation govern new work.

[Connector interoperability evidence](implementation-evidence/connector-interoperability/evidence-report.md) joins every required work item to its files, tests, recorded results, pinned sources and blocked live prerequisites, and names the requirements nobody delivered. The [source lock](implementation-evidence/connector-interoperability/source-lock.md) records every external document an adapter depends on.

Local protocol tests, browser tests, installed-PWA device checks and real-provider/deployed-platform certification are different evidence classes. Missing production configuration or external certification never means PASS.

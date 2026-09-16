# Documentation

## Use and embed

- [Teaching and reusable recipes](ceremony-teaching.md): whole/partial demonstrations, review, consent and composition.
- [Embedding](integration.md): framework-neutral and React interfaces, host-owned styles/navigation and consumer examples.
- [API and protocol reference](reference.md): detailed library examples, WebMCP hooks and presentation contracts.
- [Live authentication](live-auth.md), [service support](service-examples.md), and [auth catalog](auth-catalog.md): real adapters versus simulations and unsupported profiles.
- [Workflow studio](workflow-studio.md): author new connectors and ceremonies, save drafts, validate and export Arazzo/manifest definitions.
- [Formal specifications](specifications/README.md): versioned connector manifests, AI decision contracts, Arazzo/A2H profiles and executable conformance.

## Develop and operate

- [Development setup](development.md) and [contributing](../CONTRIBUTING.md): root layout, Node, devcontainer, local state and safe cleanup.
- [Architecture](architecture.md): current ownership and trust boundaries; [product scope](../PRODUCT.md) and [reference design](../DESIGN.md).
- [Testing](testing.md) and [contract testing](contract-testing.md): reproducible checks and honest coverage boundaries.
- [Auth scenario doubles](auth-scenario-doubles.md): self-hosted provider pages for each auth situation, and the ceremony contracts driven against them.
- [Ceremony discovery](ceremony-discovery.md): reading a provider to work out what getting in requires, without submitting anything, and writing it down as a shareable plan.
- [Agent integration](agent-integration.md): AI SDK, Workflow, model configuration and protected tools.
- [MCP endpoint](mcp-endpoint.md): driving ceremonies from a chat client, and why no credential crosses MCP.
- [Local MCP](mcp-local.md): pointing a chat client at the reference application through a tunnel.
- [Host identity](host-identity.md), [production deployment](production-deployment.md), and [persistence migration](persistence-migration.md).
- [Threat model](ceremony-teaching-threat-model.md): protected sources, prohibited sinks and residual risks.

## Evidence and history

[Implementation evidence](implementation-evidence/ceremony-teaching/README.md) contains dated, commit-bound results, including retained failed attempts. [The final implementation checkpoint](implementation-evidence/ceremony-teaching/final-local/README.md) is not a rolling certificate for future commits. The [orchestration design](ceremony-orchestration-design.md) and [Impeccable audit](impeccable-audit.md) retain earlier decisions and observations; current architecture and support documentation govern new work.

Local protocol tests, browser tests, installed-PWA device checks and real-provider/deployed-platform certification are different evidence classes. Missing production configuration or external certification never means PASS.

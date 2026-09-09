# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers embedding authentication ceremonies in external apps are the primary audience. End users complete the embedded ceremonies. The user confirmed this audience and the priorities below on 2026-09-08.

## Product Purpose

Provide reusable, composable ceremonies selected from a connector's declared authentication methods. Developers retain control over their app's styling, navigation and UI library. Success means a real supported auth flow can be embedded without copying the example application.

## Capabilities and Constraints

- Authentication is the current scope. Payments and lead qualification are future work, not implemented capabilities.
- OpenUI templates define presentation; trusted runtime bindings and server adapters own actions, credentials and protocol decisions.
- All ceremony operations must be invocable through WebMCP and share success/failure hooks with UI execution.
- Preserve existing auth families, session isolation, revision checks, native credential entry, and secret exclusion from templates and execution notifications.
- Prioritize host-controlled styling, accessibility and framework-neutral execution. A cross-framework compiler is permitted, not required.
- Browser-native semantic teaching and reviewed whole/partial recipes reuse the same registered operations; sharing procedure never shares credentials or consent.
- Production hosting uses authenticated host identity, encrypted async PostgreSQL storage, fenced effects and durable continuation. Local SQLite and anonymous loopback ownership are development/compatibility paths.
- AI SDK provides bounded optional assistance; Workflow carries durable turns and waits. Reviewed recipe execution remains model-independent.
- Package publication and external-provider/deployed-device certification remain separate release gates. Implementation and local verification are not certification.

## Operating Context

Embedded app components and connector hubs. The repository includes a local Connect page, template authoring studio, and a separate test protocol provider. Provider consent remains provider-owned.

## Evidence on Hand

[Architecture](docs/architecture.md), [service support](docs/service-examples.md), and [commit-bound evidence](docs/implementation-evidence/ceremony-teaching/README.md) describe the supported slice. Demo accounts are local test data, not customer evidence. Older audit statements retain their dates and do not override current support boundaries.

## Product Principles

- Keep protocol authority separate from generated presentation.
- Let host applications own their UI and UX.
- Reuse the same execution semantics across UI frameworks and agents.
- Report verified outcomes without leaking credentials.

# Executable workflow studio

Open `http://127.0.0.1:4173/?section=studio`. The default is a live GitHub App ceremony, not a preview. Existing session configuration is reused; missing app registration blocks installation, and provider verification blocks completion. Other services remain explicitly labelled local simulations until a live adapter is implemented.

The advanced OpenUI editor changes presentation only. It cannot execute code, supply credentials, bypass prerequisites or redefine provider operations.

## Execution boundary

The server exports `githubWorkflows` and `runArazzo` from `@ceremony/auth/server`. The GitHub adapter runs the actual document's ordered operations against the official `@octokit/request` and `@octokit/auth-app` SDKs. Registration exchanges the one-shot manifest code and verifies app identity. Access verification requests a read-only installation token and checks repository access before storing a connection reference.

This is a **bound sequential Arazzo 1.0.1 profile**, not a general-purpose Arazzo interpreter. Operation inputs and authentication are bound by trusted server handlers to the validated session/callback state. Human approval, crash recovery and private collection remain the responsibility of the ceremony runtime. The exported document describes the automatic operation sequences; it is not a standalone end-to-end workflow for an arbitrary third-party runner. Unsupported fields, duplicate IDs and unbound operations are rejected before effects. No external source loading, evaluation, automatic retries, generic HTTP proxy or browser-auth scripting is enabled by an imported document.

Provider effects are never retried blindly: registration credentials are persisted before verification; interrupted token issuance enters the existing recovery path. Success/failure observers receive operation and step identifiers only, never tokens, request bodies, responses or provider errors. `GitHubOptions.onWorkflowStep` observes server execution. UI and WebMCP continue to invoke the same ceremony client actions and its existing `onActionSuccess` / `onActionFailure` hooks.

## Reuse and composition

Embed `Ceremony` from `@ceremony/auth/react`, or use `createCeremonyClient` from `@ceremony/auth` with your own React/Vue/other framework view. Pass your manifest and server transport; the host owns styling, navigation and credential storage. No Studio dependency is needed in an embedding app.

To compose a trusted automatic sequence, provide an `ArazzoDocument` and a `Map` of operation IDs to SDK-backed async handlers, then call `runArazzo(document, workflowId, operations, onStep)`. Handlers must validate inputs and provider evidence and keep private results in their server-owned context. All bindings are checked before execution; a failed handler stops the sequence. A successful observer cannot change authentication, and an observer failure cannot replay a provider operation.

## Verification and sources

`tests/arazzo.test.ts` checks ordering, binding preflight, failure short-circuiting and redacted hooks. Existing GitHub Pact tests now exercise the SDK-backed workflow consumer over HTTP, including rejected credentials and a deliberately incompatible permission request. Browser tests cover the working Studio, presentation separation and mobile accessibility. These checks do not constitute live GitHub provider certification or authorize creating an app in a real account.

[Arazzo 1.0.1](https://spec.openapis.org/arazzo/v1.0.1.html) defines ordered operation steps and default failure termination. [Octokit app authentication](https://github.com/octokit/auth-app.js) implements app JWT authentication; [GitHub's installation authentication guide](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation) documents the SDK-backed installation flow.

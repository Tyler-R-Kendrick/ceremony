# Workflow studio

Open [Workflow studio](http://127.0.0.1:4173/?section=studio) with the local app running.

Studio is an **agent chat**. Talk to the authoring agent on the page; it registers `ceremony_author_*` WebMCP tools. There is no Create connector form, file picker, or field for connector name/ID/OpenAPI. Connect runs existing connectors; Environment manages private session configuration.

## Create a connector

There is no studio form for this. The human names a provider to the assistant. The agent:

1. Disambiguates the name and auto-corrects high-confidence misspellings. Ambiguous names elicit a public confirmation.
2. Crawls well-known auth documents (OAuth/OIDC metadata, `auth.md`, OpenAPI) and may search only if those are unpublished.
3. Drafts generic family templates. Credentials are never tool arguments.
4. Elicits a person only for provider consent (A2H) or private credentials (collector).

The conversation drafts the connector. File pickers are not part of kickoff.

## Presentation

The review stage has **Customize ceremony presentation**. Its OpenUI preview uses the authored connector and synthetic state, not another service's session. Edit/import/export templates or optionally generate presentation copy with the configured server model. **Save presentation to project** changes only the project. Saved templates reopen for editing; no action applies them to Connect.

Generation accepts a bounded authored connector name rather than requiring a built-in connector ID. Existing API callers using `connectorId` remain supported. Model credentials stay server-side. Free-form author instructions and names are user-provided text; never enter secrets there.

## Portable contract

The version-1 project envelope carries a formal manifest, optional reviewed templates, and named Arazzo documents. It is an authoring container, not another workflow language. Core exports `connectorProjectSchema`, `connectorProjectDraftSchema`, `parseConnectorProject`, `parseConnectorDraft`, and `exportConnectorFiles`. Completed projects require a formal manifest, 1–12 named Arazzo 1.0.1 documents, and optional templates. Manifest methods must point at a real document/workflow/version. Drafts may omit names, verifiers and operations so research can continue; they cannot be treated as completed exports. The envelope cannot carry publication, installation, grant, credential, cookie, control-URL or environment-secret fields. Workflow steps name trusted host operations; they cannot carry `x-` extensions, `operationPath`, `workflowId` chaining, success-criteria expressions, `dependsOn`, or output/step parameters. Human participation is always A2H authorization that resumes at verification. Importing a file does not register a connector, grant access, or copy credentials.

`npm pack` includes `dist/core/connector-authoring.d.ts`. See [Arazzo and A2H profiles](specifications/protocol-profiles.md) and [connector contracts](specifications/connector-manifest.md).

## Compatibility and verification

The old Studio-as-GitHub-session screen, **Create connector** form, and **Use on Connect page** behavior were intentionally removed. Existing embedded `TeachingConnection` APIs remain available; the example's teaching controls now live on Connect. Authoring tools are registered for the browser agent.

`tests/connector-authoring.test.ts` covers draft/completed boundaries, unsafe imports, references, limits, conservative auth-family defaults and execution through the existing Arazzo runner. `tests/authoring-tools.test.ts` covers agent draft/discover/compose without a studio form. `tests/browser/workflow-studio.spec.ts` covers the absence of kickoff forms, review/export of imported drafts, and desktop/mobile accessibility in Chromium, Firefox and WebKit.

These are local implementation checks, not live-provider certification. This change does not provision resources, publish connectors or execute a new real-provider flow.

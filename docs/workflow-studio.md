# Workflow studio

Open [Workflow studio](http://127.0.0.1:4173/?section=studio) with the local app running.

Studio is an authoring tool for **new connectors and their ceremonies**. It does not start GitHub, inspect an active connection, or read Environment. Connect runs existing connectors; Environment manages private session configuration. Teaching an existing connection stays contextual on Connect.

## Create a connector

1. Choose **Create connector**, name the service and describe its purpose. Set its stable ID and public OpenAPI document URL. Or enter a provider name and choose **Build from this provider** to start from generic ceremony templates (OAuth, device, API key, and so on). Studio does not fetch the provider or certify an adapter.
2. Choose **Design ceremonies**, then add the service's supported auth methods. Each method starts from that family's generic Arazzo outline and OpenUI template. Select two or more methods and **Compose selected ceremonies** to add a parent that reuses them as prerequisites. Define requested permissions, a host verifier, configuration names and additional prerequisites.
3. Add and reorder steps. Describe each action and reference the provider operation that a trusted SDK handler will implement. Configure the appropriate human recipient; A2H return always leads to verification.
4. Choose **Review connector**. Fix validation issues before exporting a manifest or Arazzo workflow. **Save connector project** also saves incomplete drafts so operation research can continue later.
5. Use **Open project** to resume a saved file. Import never installs a connector or transfers publication status, credentials, access, or authority.

The editor works without a model or a provider account. It keeps work in component memory across navigation tabs, not local/session storage. Download a project before closing or reloading the page; unfinished edits trigger the browser's leave warning where supported. Importing over edits requires an explicit replace choice. Do not enter credentials or signed URLs into project metadata.

## Presentation

The review stage has **Customize ceremony presentation**. Its OpenUI preview uses the authored connector and synthetic state, not another service's session. Edit/import/export templates or optionally generate presentation copy with the configured server model. **Save presentation to project** changes only the project. Saved templates reopen for editing; no action applies them to Connect.

Generation accepts a bounded authored connector name rather than requiring a built-in connector ID. Existing API callers using `connectorId` remain supported. Model credentials stay server-side. Free-form author instructions and names are user-provided text; never enter secrets there.

## Portable contract

The version-1 project envelope carries a formal manifest, optional reviewed templates, and named Arazzo documents. It is an authoring container, not another workflow language. Core exports `connectorProjectSchema`, `connectorProjectDraftSchema`, `parseConnectorProject`, `parseConnectorDraft`, and `exportConnectorFiles`.

Draft validation permits empty form fields while retaining structural limits and graph linkage. Completed-definition validation additionally requires method details, operation IDs, verifier IDs and valid references. Both reject unknown keys and imported publication/owner/connection fields. Import is capped at 256 KiB. Projects allow up to 12 methods and 32 total executable steps. This editor profile supports one sequential workflow per method, with explicit document/version references; it does not author branching expressions or arbitrary code.

The generated [project schema](specifications/schemas/connector-project-v1.schema.json) and [draft schema](specifications/schemas/connector-project-draft-v1.schema.json) are structural descriptions. Runtime cross-reference and presentation validation still apply.

## Host integration and trust boundary

A valid exported definition is **not** a deployed or provider-certified connector. The default `live-adapter` manifest metadata describes the intended integration, not proof that its adapter exists.

The host must register trusted SDK handlers, completion verifiers, origin policy, prerequisite gates and authorization. Supply exported manifest/templates to the existing framework-neutral client or React view with the host's transport. Register exported Arazzo documents in the server's trusted catalog. `runArazzo(document, workflowId, operations, onStep)` preflights all operation bindings before running them and stops on failure. It does not fetch a source URL, execute author code, infer authentication inputs, retry one-shot effects or approve a human request.

Human approval, protected input, verified artifact reuse, durable effects and continuation remain domain-runtime responsibilities. A2H describes how to request necessary participation; it never grants access by itself. Shared definitions never contain an author's credentials or session. GitHub, Stripe and Supabase SDK paths remain separate registered integrations, not automatic support for a newly named provider.

## Compatibility and verification

The old Studio-as-GitHub-session screen and **Use on Connect page** behavior were intentionally removed. Existing embedded `TeachingConnection` APIs remain available; the example's teaching controls now live on Connect.

`tests/connector-authoring.test.ts` covers draft/completed boundaries, unsafe imports, references, limits, conservative auth-family defaults and execution through the existing Arazzo runner. `tests/browser/workflow-studio.spec.ts` covers creation, ordering, export/reopen, malformed imports, draft preservation, no connection/environment requests, and desktop/mobile accessibility in Chromium, Firefox and WebKit. Presentation-generation regression tests use the actual local model HTTP boundary, not a forged completed connection.

The prior merged build (`77e9b54`) measured 451,231 raw / 140,120 gzip JavaScript bytes. The initial standalone Studio implementation measured 472,127 / 146,751, including its separately loaded authoring chunk. The total-download regression ceiling is now 485,000 / 150,000 to cover this concrete editor; it remains a build gate. Core consumers do not acquire React, model SDKs or server SDKs from the authoring contracts. Build output records current exact measurements in `artifacts/bundle/size.json`.

These are local implementation checks, not live-provider certification. This change does not provision resources, publish connectors or execute a new real-provider flow.

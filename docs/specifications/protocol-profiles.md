# Arazzo and A2H integration profiles

## Arazzo: bound sequential 1.0.1

The [upstream Arazzo specification](https://spec.openapis.org/arazzo/v1.0.1.html) defines workflow descriptions. Ceremony intentionally implements its bounded sequential subset; it is not a general Arazzo evaluator. Runtime: `arazzoSchema`, `runArazzo`, `validateConnectorWorkflows` from `@ceremony/auth/server`. [Structural schema](schemas/arazzo-profile-1.0.1.schema.json).

ARZ-01: A document MUST declare `arazzo: "1.0.1"`, info title/version, exactly one OpenAPI source description, and 1–32 uniquely named workflows. Each workflow contains 1–32 uniquely named steps. Each step MUST specify exactly one operation ID or supported operation-path reference. Unknown fields/control flow are rejected.

ARZ-02: Source URLs are descriptive, not permission to fetch or execute. The host supplies the document catalog and operation map. Before mounting a versioned connector, `validateConnectorWorkflows` checks every referenced document, exact info version and workflow ID. Before execution, `runArazzo` preflights every selected operation binding before the first effect. An unbound operation fails without partial execution.

ARZ-03: Steps execute in declared order and stop at first handler failure. Registered handlers own SDK calls, private input bindings, protocol state, origin checks and verification. There is no generated handler, arbitrary HTTP proxy, source loader, implicit retry or expression evaluation. A resolved handler promise means the step finished; only trusted provider evidence can complete the parent connection.

ARZ-04: Arazzo documents describe automatic SDK sequences. Recipes govern reusable children/dependencies, and the ceremony runtime governs preparation, human waits, one-shot recovery and continuation. Do not concatenate a click trace into a new execution language or assume this subset is independently executable by an arbitrary third-party runner.

ARZ-05: `onStep` exposes workflow/step/operation identity and success/failure only. It MUST NOT receive handler results, tokens, request bodies or raw errors. Observer failures cannot roll back or repeat effects. Workflow document metadata and declared contracts must remain consistent with SDK-bound implementations.

Current bindings: GitHub register-app converts an approved manifest and verifies app identity; verify-access issues installation access and reads repositories. Stripe verify-access reads balance. Supabase sign-in exchanges private credentials using its SDK. The newer deterministic GitHub recipe children implement the same protocol obligations directly through the registry; this profile does not pretend that their durable orchestration history is an Arazzo document.

## Human participation: Ceremony contract and Agent2Human transport

`humanHandoffContractSchema` declares **participation policy**, not an A2H wire envelope. Required keys are `surface` (provider-browser/private-collector), `recipient` (initiating-subject/authorized-owner), `delegation: "a2h-authorize"`, and `resume: "verify"`. The delegation value means an optional supported transport, not a requirement to send a message or enable a gateway. Own-browser/private native controls MUST remain usable without it.

A2H-01: The existing adapter targets [Twilio Labs Agent2Human 1.0](https://github.com/twilio-labs/Agent2Human/blob/main/a2h_framework.md), specifically AUTHORIZE and signed RESPONSE handling. This is not a claim of support for every A2H intent, channel, hosted profile or differently named protocol. A2H COLLECT is not used to carry raw secrets; private web/MCP collectors retain their separate protected path.

A2H-02: Gateway origin, pinned verification key, signing key/key ID, API credential and authenticated recipient resolver are host configuration. They MUST NOT come from a manifest, model tool arguments or imported recipe. An authorized-owner role is resolved by current host policy; portable definitions cannot select a person or transfer authority. If the owner cannot be resolved, keep an actionable blocker rather than inventing a recipient.

A2H-03: Before delivery, discover compatible version, channel, authentication and TTL at the configured gateway. The adapter uses a bounded TTL, signed canonical payload, stable persisted interaction/message identities, and a non-secret authenticated HTTPS human route. Retry uncertain delivery using the existing interaction rather than prompting again with new authority.

A2H-04: Verify the response signature with the pinned key; bind principal, interaction, original message, decision time, expiration and replay state. A mismatched, expired, replayed or denied response MUST NOT advance authorization. APPROVE returns `verify`; DECLINE returns `deny`. Neither decision manufactures a provider grant. The domain service MUST recheck the recipient's authority and current run/effect context at consequential boundaries.

A2H-05: Human handoffs must preserve the parent, avoid popup assumptions after asynchronous agent work and provide an own-browser fallback. Provider pages and private collectors are outside model/recording capture. No credential, transient code/state, control URL or browser cookie is portable recipe data. Remote Cloudflare assistance remains optional and scenario-bound; no arbitrary tab recording or cross-context cookie copying is implied.

The legacy A2H adapter retains its signed external envelope compatibility; the strict portable handoff schema is deliberately narrower and carries no external evidence payload. Hosted deployments MUST advertise A2H only when actually configured and tested. Local signature/replay tests and Pact consumer checks do not certify a live gateway.

# Composable authentication, prerequisites and human handoff

Status: approved by the user, 2026-09-08; first GitHub implementation in progress. This is the target design, not a claim that every release criterion has passed. See [implementation coverage and host configuration](live-auth.md).

## Job and acceptance

A developer embeds one connector ceremony. A user or agent requests a connection, the runtime resolves reusable prerequisites, automates authorized work, requests the smallest necessary human intervention, and verifies provider evidence before reporting usable access. The same flow must work in the webpage, an external UI library, WebMCP, and an MCP App.

Preserve the current workbench, OpenUI presentation, framework-neutral client and action hooks. This is an execution and interaction redesign, not another visual redesign. Do not add a general-purpose workflow language for future payments or lead capture.

The release criterion is a live GitHub path from missing configuration to verified access, including registration, browser/A2H fallback, secure credential handling and restart recovery. Local simulation tests are necessary but insufficient evidence of that outcome. Other connectors remain explicitly unavailable for live execution until their actual adapters and prerequisites pass the equivalent checks.

## Original gaps that motivated the design

- `examples/server.ts` points the connector adapters at loopback test endpoints and `ceremony-local`. Service labels do not supply vendor configuration.
- `CeremonyController.start()` immediately constructs an auth adapter. There is no dependency evaluation, setup artifact or blocking prerequisite state.
- `src/core/webmcp.ts` exposes raw `submit.values`. Secret-free results and hooks do not keep incoming tool arguments out of model context.
- `navigate` opens a browser destination but has no remote-browser ownership, human assignment, takeover or resumption semantics.
- Adapters keep protocol secrets and progress in closures; the controller stores live adapter objects. Persisting the current snapshot alone cannot resume OAuth or a browser handoff after restart.
- Execution hooks are best-effort browser notifications. They cannot reliably drive work after a tab closes.

## One parent ceremony, reusable child ceremonies

```text
Connect service
  → resolve and verify existing configuration/access
  → satisfy missing prerequisites
      ├─ reuse a verified setup artifact
      └─ run setup child
           → trusted provider API / manifest handshake
           → approved browser scenario where needed
           → human child when required
  → run the selected auth profile
  → verify provider identity, target and access
  → publish connection reference

Any child needing human participation
  → private input in a trusted MCP App / web collector
     OR provider-owned page in the user's browser / remote takeover
  → verify evidence → resume the SAME blocked parent
```

MCP Apps and external human links are two presentations of the human child, not separate workflow engines. A2H carries the human request and response. Browser automation is an executor of a step, not the authority that decides prerequisites or declares authentication complete.

Use small, versioned connector recipes with explicit dependencies. Reject cycles and unsupported profiles before execution. The model may choose among authorized methods or request a handoff; it cannot invent executable dependencies, URLs or verification rules.

### Reuse and blocking rules

Setup artifacts are keyed by tenant/owner, provider, auth profile, deployment environment, callback origin and configuration/permission version. Personal tokens additionally belong to their principal and approved use. App configuration can be shared where policy permits; a user's browser session or consent cannot silently become another user's prerequisite.

Resolve references in the server. Revalidate required capabilities and expiry before using an artifact. Configuration changes invalidate only dependent nodes. Share one in-flight setup child across matching requests, with explicit subscribers; cancelling one parent does not cancel setup still needed by another.

The server rejects downstream actions while dependencies are missing, invalid or awaiting a human. A disabled button is not enforcement. Browser results, UI clicks and A2H responses cannot directly set a prerequisite to succeeded. A trusted verifier must accept the evidence.

Keep these concepts separate:

| Record           | Meaning                                                                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| Run and node     | Progress, dependencies, revision, actor lease and retry state                                                     |
| Setup artifact   | Verified provider configuration that another run may reuse                                                        |
| Secret reference | Scoped handle to vault material; no secret-bearing read tool                                                      |
| Handoff          | Assigned human task, reason, deadline, return route and evidence requirements                                     |
| Connection       | Verified provider identity/target and capabilities, or an explicitly different outcome such as ownership transfer |

Node states: blocked, ready, running, awaiting-human, verifying, succeeded, failed, expired, cancelled. Missing setup is actionable blocking, not an authentication failure. A human response transitions to verification, never directly to authenticated.

## GitHub: eliminate unnecessary registration work

Prefer a deployment's already-configured integration. Ordinary users should not register their own app when the host already has one. An administrator supplies shared configuration once; tenant-owned apps remain available when required.

Keep three distinct recipes:

| Requested access                              | Prerequisites                                                                                                       | Auth and evidence                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Existing OAuth App: user OAuth or device flow | Verified OAuth client configuration; callback/client authentication for web flow; device capability for device flow | Provider approval, code/token exchange, account and capability check             |
| GitHub App: installation access               | Existing app or app registration child; approved installation and repository selection                              | Server-side app signing, installation verification and scoped installation token |
| Personal access token                         | Existing authorized vault reference, or private collection/creation handoff                                         | Validate token identity and required capabilities without broadening permissions |

A GitHub App is not an OAuth App. Do not attach a GitHub App manifest registration to the current OAuth App method and call the protocols interchangeable. User authorization for a GitHub App is also distinct from installation authorization. [GitHub authentication profiles](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).

For a new GitHub App, use its official manifest handshake: prepare the requested configuration, let the owner review creation on GitHub, validate the returned state/code, exchange that code server-side, and put returned credentials directly in the vault. Registration produces an app artifact; installation remains a separately verified dependency when needed. This avoids asking a user to copy a private key into chat. [Manifest registration](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest), [conversion endpoint](https://docs.github.com/en/rest/apps/apps#create-a-github-app-from-a-manifest).

Publish the registration child as an independently invocable browser-use scenario with declared inputs, allowed origins, expected owner, effects, success verifier and human fallback. The scenario should use the manifest mechanism instead of brittle dashboard typing wherever possible. OAuth App registration without a verified equivalent API uses a bounded browser setup scenario plus secure configuration collection, not an invented manifest API.

Target human effort: zero interventions for reusable valid access; typically one authorization session for configured integrations; one guided owner session for new app creation and installation where provider policy permits. Login, MFA, organization approval and separate permission grants can require more. Minimize repeated context switches, not required consent.

## Executor order and browser-use contract

Choose the lowest-interaction valid route: reuse verified access → provider API/manifest → bounded browser scenario → human child. A sensitive human-only step can go straight to handoff; do not first make an agent fail against MFA or a password page.

A browser scenario declares public inputs, configuration/secret references, permitted origins/actions, expected account, bounded time/action budget, capture policy, verifier and fallback. No arbitrary browser JavaScript from untrusted webpage content gets privileged vault access. Sensitive values are injected by a trusted broker into approved destinations, never interpolated into model-authored scripts or tool arguments. If the runner cannot prevent secret-bearing DOM, screenshots, network traces or downloads from reaching the model, hand the step to the user instead.

Cloudflare Browser Run is the proposed first remote executor because it documents structured handoff and resumption through CDP and Live View. Its handoff-complete event is a signal to verify, not proof of a provider grant. [Human in the Loop](https://developers.cloudflare.com/browser-run/features/human-in-the-loop/).

Vercel's documented remote-browser route includes Browserbase over CDP. Keep the executor boundary portable, but do not build both providers initially. A local Playwright runner can exercise the same scenario contract in tests. [Vercel Browserbase integration](https://vercel.com/changelog/browserbase-joins-the-vercel-agent-marketplace).

Sensitive auth sessions run without session recording, model screenshots, DOM/AX snapshots, request/response body logging, cookie dumps or crash attachments. Cloudflare recordings are opt-in; input masking is not sufficient protection for tokens displayed elsewhere on a page. Browser infrastructure remains a trusted data processor, not a promise that its operator cannot observe the session. [Recording behavior](https://developers.cloudflare.com/browser-run/features/session-recording/).

On takeover, the worker acquires a human lease and fences automation for that session. On return, it verifies the intended account/step, checks the lease generation and resumes permitted work. Expired sessions trigger a fresh handoff while preserving completed setup. Switching to the user's browser restarts only the browser-bound attempt; never copy an entire cookie jar between contexts as an implicit shortcut.

## Private secrets: references, not encoded chat

Encoding a credential does not hide it. Encryption alone also does not establish that an MCP host excludes an argument or tool result from context. The preferred path avoids carrying the secret through the model/tool transport at all:

```text
Model requests collection of declared credential fields
  → trusted private collector renders in an MCP App or isolated web page
  → human submits directly over TLS to the credential broker
  → vault stores encrypted secret under tenant and purpose policy
  → tool binds an opaque reference to the blocked ceremony
  → adapter resolves it internally for the approved provider operation
```

Use a fixed trusted collector, not model-generated executable form logic. MCP App capability negotiation and narrowly scoped resource CSP are required. App-only tool visibility reduces model exposure; it is not authorization. Keep raw values out of tool arguments/results, `_meta`, model-context updates, telemetry, URLs, local/session storage and recordings. UI-only metadata may carry a short-lived collection handle, not a reusable credential. [MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview), [tool visibility](https://apps.extensions.modelcontextprotocol.io/api/interfaces/app.McpUiToolMeta.html).

The broker needs authenticated issuance, origin/CSRF checks, exact field/purpose binding, short expiry, replay protection, size limits and encrypted storage. An opaque reference is not a bearer permission to read the secret: resolution requires the matching tenant, principal, run/node, provider operation and current authorization. There is no model-callable reveal/get-secret tool. Validation errors never reflect submitted content.

If direct private collection is unsupported by the host, open the authenticated web collector through A2H. Do not fall back to asking for credentials in chat. Optional sealed-payload transport needs separately tested host behavior, authenticated key distribution and replay binding; it is not the initial default.

For agent-facing WebMCP/MCP, replace secret-bearing `submit(values)` with reference binding. Public choices may still be plain values. UI native inputs submit through the private broker. The agent can request every operation, including human participation, without impersonating the human or possessing their secret. This deliberately changes the current raw-credential tool contract and needs explicit migration tests.

## A2H and human fallbacks

Assumption pending confirmation: A2H means Twilio Labs' Agent2Human protocol. Implement it as a transport adapter for the shared human child. Negotiate capabilities and pin the implementation version; do not equate an ordinary deep link with protocol conformance. The published framework includes signed messages, discovery, response correlation and expiry; standing policies and delegation are deferred, so host authorization must not be invented as an A2H feature. [Agent2Human](https://github.com/twilio-labs/Agent2Human), [framework](https://raw.githubusercontent.com/twilio-labs/Agent2Human/main/a2h_framework.md).

Map data collection to COLLECT and distinct authorization decisions to AUTHORIZE, with RESULT after verification. Browser takeover is our internal handoff kind; use an explicitly negotiated mapping/profile instead of assuming A2H ESCALATE standardizes remote-browser control. Chain distinct intents without making the person reopen the interface for each one.

Each potentially non-agent-executable step declares its human fallback and required evidence. Recipe validation rejects a step that can require interaction but lacks this path. Runtime policy also allows unknown browser barriers to enter the common fallback. Examples:

| Barrier                                                | Human experience                                                  | What permits resumption                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Password, MFA, passkey or CAPTCHA                      | Open provider locally, or explicitly take over the remote session | Verified provider response/account state; never automated challenge bypass |
| App ownership or organization permission               | Assigned owner/admin reviews the exact request                    | Verified registration/installation/permission artifact                     |
| API key/private configuration                          | Private collector; never chat                                     | Broker receipt plus provider validation                                    |
| Account/repository choice                              | Only unresolved choices, with safe defaults where authorized      | Bound selection and subsequent provider checks                             |
| Unrecognized page or automation failure                | Exact reason, current task and a takeover/open-page action        | Trusted verifier or clear unresolved status                                |
| Unsupported MCP App host or remote browser unavailable | Authenticated web handoff on the same run                         | Same evidence requirements as the embedded route                           |

The handoff records recipient, reason, provider, intended effect, run/node/revision, deadline and return route. Delivery acknowledgement, a clicked link, a typed “done” or the browser provider's success flag is insufficient evidence of authentication. Dedupe requests for the same blocker; reject stale, replayed, wrong-principal and out-of-order responses. Denial blocks the dependent action without repeated prompting.

Human links enter an authenticated broker route; raw browser control URLs and provider secrets do not go into public run state or model events. Bound links cannot redirect to arbitrary destinations. Cross-device and remote-browser callbacks use one-time server-bound state correlated to the authorized principal/run/attempt, not an assumption that the callback browser has the original webpage's session cookie.

## User experience and composition

Keep one connection surface and one primary action. Show a compact progress summary such as **Prepare integration → Authorize access → Verify connection**, with completed/reused setup collapsed. Only expose the current blocker; advanced details show the dependency tree and evidence without secrets.

Examples of actionable copy:

- “GitHub needs an app before it can authorize access. We can prepare it; an owner must approve creation.”
- “Your administrator has already configured this integration.”
- “GitHub needs you to sign in. We’ll continue automatically after verification.”
- “This browser session expired. Your app setup is saved.”

Do not show a dead Connect button. Offer the required setup, request the right owner, or explain exactly why the method is unavailable. Unsupported live adapters are not selectable as though they work; keep simulations in an explicit demo mode.

Use the same headless state and actions for webpage, MCP App and external React/Vue hosts. Compose a current-step renderer, prerequisite summary, private-collection launcher and human-handoff view; host apps retain styling and navigation ownership. On mobile, place the current required action before technical context. Announce waits/results accessibly, restore focus after handoff and preserve keyboard-only completion. No repeated confirmation for already authorized non-sensitive work; separate consent when the effect or scope changes.

## Persistence, events and implementation sequence

The server is authoritative. Introduce durable run/node records, transactional revision checks and worker leases. Refactor adapters to serialize private protocol state into protected storage and hydrate execution per operation; never serialize functions, raw browser objects or secrets into public snapshots. Persist references to recoverable remote sessions, and handle sessions that cannot be recovered.

Use an outbox with at-least-once delivery and consumer deduplication for server execution events. Keep existing UI success/failure hooks as projections, not workflow triggers or authorization gates. Add run, parent, node and actor correlation with a common event ID. “Handoff created” is operation success while the parent remains blocked. Only verified connection completion emits the connection outcome.

Build in this order:

1. Dependency gating, protected artifact/secret references, persistent node state and common human-child contract. Prove direct API/WebMCP calls cannot skip prerequisites.
2. One live GitHub recipe: reuse configuration, manifest-based GitHub App registration, installation approval, server-side signing and capability verification. Keep OAuth App/device profiles separate. Deliver browser-use registration and local-browser handoff as part of this slice.
3. MCP App/private web collector and reference-only agent submission; verify context exclusion in actual supported hosts, not just unit mocks.
4. Cloudflare executor and Agent2Human transport with authenticated human assignment, takeover fencing, verified resumption and expiry recovery. No paid service activation or external account creation until its configuration and authority are supplied.
5. Roll the same primitives through Stripe key acquisition, Jira site/token setup, Supabase project configuration and user sign-in, and Neon's provisioning/ownership profile. Do not automatically create accounts/projects merely because configuration is missing; those are explicit effects requiring authorization.

## Proof required before claiming delivery

- Missing prerequisite prevents auth start through UI, WebMCP and direct HTTP; valid shared setup avoids duplicate registration.
- Real provider artifacts are obtained and checked; simulation and live results cannot be confused.
- GitHub OAuth App, GitHub App and personal-token paths never consume one another's incompatible configuration.
- Browser scenario succeeds on an authorized session or produces the correct human child. Automation cannot act during takeover.
- Callbacks, human responses and reference binding reject wrong tenants, replay, changed permissions, expiry and stale attempts.
- A sentinel secret entered in each supported collector never appears in model messages, tool inputs/results, hooks, traces, screenshots, logs or storage outside the vault. Test deliberate UI/host telemetry leaks and fail closed.
- A2H delivery failure, denial, timeout and duplicate responses do not grant access or repeat irreversible setup.
- Restart during registration, OAuth, waiting for a human or post-provider/pre-local-commit recovery preserves correctness. Reconcile uncertain external effects before retrying; never blindly recreate an app after a lost response.
- Tab closure, iframe teardown, unsupported MCP Apps, browser session loss and cross-device completion resume the same parent where safe.
- WebMCP and MCP Apps use the same server policy; external React/Vue consumers remain independently buildable and styleable.

## Approved initial choices

Recommended initial choices: Cloudflare Browser Run as remote executor; Twilio Agent2Human as A2H transport; host-configured GitHub integration first with tenant-owned registration when needed; private direct-to-vault collection with reference-only tool binding. Browser vendor credentials, callback deployment, vault/key management and A2H gateway authority must be configured outside chat before live end-to-end verification.

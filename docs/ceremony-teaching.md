# Connect, teach, and reuse

Choose a service and connect. Ceremony checks the current authenticated context, reuses compatible setup, and shows the next blocker in the same connection surface. GitHub app preparation, installation and access verification are children of that connection—not a separate registration product. Already available setup is collapsed. Provider login, account choice, MFA and required consent remain with the person and the provider.

Teaching is optional. Use **Teach this step** in the connection, or **Create from demonstration** in the studio. The browser does not require an extension, desktop recorder or CLI. The application records semantic transitions from its authoritative server ledger, not a recording of arbitrary provider tabs. Private entry and provider control material do not enter demonstrations.

## Review a whole ceremony or a part

Pause or stop recording when appropriate. Select a contiguous section of the semantic timeline; verified child boundaries are the meaningful reusable boundaries. Review what the procedure starts with, what it does, which choices need fresh input, when a person is needed, and which registered verifier proves completion. Use **Adjust** to change the name or selected portion. Advanced authors can inspect the declarative definition, but JSON is not necessary for the normal review.

Use **Save reusable step** to review and publish the exact current revision. The host must grant both review and publication rights; executor permission alone is insufficient. Invalid or incomplete drafts remain drafts with diagnostics. Generated suggestions never publish automatically. An observed failure does not become a success path, and one account choice does not become blanket permission for every future account.

A whole ceremony and a fragment use the same recipe format. External dependencies of a selected fragment become typed inputs; an installation-only fragment does not secretly repeat app creation. A publishable definition references only registered operation versions or pinned child recipes. There is no generated JavaScript, arbitrary HTTP endpoint, SQL, shell command or expression evaluator.

## Reuse and composition

Saved recipes are tenant-scoped procedures. Select compatible reusable steps in the studio and combine them; inspect and review the composition before publishing. The server validates each input/output boundary and pins the child versions. Recipes created by different authorized authors can be composed, but each new run binds its own principal, target, environment, origin and configuration.

Sharing a procedure does not share a password, app private key, browser session, installation approval or connection handle. A cached setup artifact is reused only when its full context and current provider verification match. A retired dependency cannot be revived by an old client cache. A recipe export contains the definition, not the original run's authority; importing creates an untrusted draft.

Reviewed recipes execute without a model on their healthy path. Optional assistance can propose supported actions, but the same server command service validates current authority, expected revision and prerequisites. The assistant cannot skip provider evidence or complete a connection by saying it succeeded. After verification, the registered durable continuation resumes the original host task; applications must register a deduplicating continuation consumer.

## Embedding in another application

The same surface used by the example is exported as `TeachingConnection` from `@ceremony/auth/react`. Import `@ceremony/auth/teaching.css` only if you want the supplied styles; `className` and `style` remain host-owned. Core recipe contracts, projections and connection tools remain available without React or hosted SDK imports.

```tsx
import { TeachingConnection } from "@ceremony/auth/react";

<TeachingConnection
  apiBase="/api/v1/teaching"
  resumeId={hostRunId}
  onRunChange={(run) => setHostRunId(run.id)}
  onSignIn={() => host.signIn()}
  onSignedOut={() => host.showSignedOut()}
  autoFocus={false}
  webmcp={false}
  className="my-connection"
/>;
```

Supplying `onRunChange` leaves URL ownership with the host; no authorizing state is stored in browser storage. Use distinct WebMCP prefixes for simultaneously mounted instances, or disable registration and use the exported local tool definitions. The API base must route to the authenticated server handlers; changing presentation cannot replace server authorization. Framework-neutral hosts can render their own UI from those same HTTP contracts and tools. Own-browser handoffs still require exact server callback configuration.

## Different stopping controls

- **Stop assistant** prevents additional agent work. It does not undo effects already completed by the provider.
- **Cancel connection** terminates local authorization work and fences pending attempts. It does not silently revoke upstream grants.
- **Discard demonstration** removes teaching material. It does not delete the connection or mandatory security audit records.

Closing a tab is not cancellation. Returning to the parent connection requires authenticated server access; a URL resume hint is not a credential. Offline mode cannot verify stale state, queue private writes or replay authorization actions. Reconnect to refresh authoritative status.

## Boundaries and limits

Definitions are limited to 256 KiB, 32 expanded executable leaves, and eight nested recipe levels. Public metadata and input values are bounded. Publication rejects missing bindings, unknown operation versions, cycles, unsupported expressions and private literals. Lower trusted deployment budgets may apply.

Current composable provider children are GitHub App preparation, installation authorization and verified installation access. Other legacy connectors/protocol fixtures retain their documented support status; a demonstration does not turn a simulated or unsupported live method into a real integration. See [live authentication](live-auth.md) and the [release evidence](implementation-evidence/ceremony-teaching/README.md).

The PWA cannot inspect arbitrary cross-origin provider pages. Own-browser handoffs are the default. Optional configured remote assistance is limited to its documented scenarios; login, CAPTCHA, passkeys and consent still require the correct human surface. Never paste credentials into assistant text. Use native private collection; text scanning cannot recognize every arbitrary password.

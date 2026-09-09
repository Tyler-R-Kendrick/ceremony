# Embedding ceremonies

The package separates execution from presentation. Use the React/OpenUI view, replace it with your UI library, or use the same client from another framework. Nothing imports the demo shell or its global CSS.

## Install a local artifact

Run `npm run build && npm pack` in this repository, then install the resulting tarball in your app. The package remains private; publication is not part of this change.

React hosts also install `react@^19.1.0`, `react-dom@^19.1.0` and `@openuidev/react-lang@0.2.15`. These are optional peers: a headless Vue app does not need React or OpenUI. Imports are ESM with TypeScript declarations.

## React and OpenUI

```tsx
import { Ceremony } from "@ceremony/auth/react";
import { createHttpTransport } from "@ceremony/auth";
import "@ceremony/auth/styles.css"; // optional

const transport = createHttpTransport("/api/ceremonies");

<Ceremony
  key={connector.id}
  manifest={connector}
  transport={transport}
  className="connection-dialog"
  aria-label="Team account connection"
  autoFocus={false}
  webmcp={{ prefix: "team_connection" }}
  onComplete={(outcome) => saveConnection(outcome.connectionRef)}
  onActionSuccess={(event) => observeExecution(event)}
  onActionFailure={(event) => observeExecution(event)}
/>;
```

Keep the transport stable. A mounted `Ceremony` owns one client: re-key it when changing the manifest, transport, resume ID or navigation policy. Callback props remain current across renders. Give simultaneous instances distinct WebMCP prefixes and meaningful `aria-label` values. Native input IDs are unique automatically. Disable `autoFocus` when a host dialog or wizard manages focus; otherwise the region receives focus when the ceremony changes step.

The optional stylesheet uses zero-specificity `:where()` selectors under `[data-ceremony]`, inherits the host font, and has no global reset. Override with ordinary host classes or inherited variables:

```css
.connection-dialog {
  --ceremony-bg: #182b24;
  --ceremony-fg: #eef5ef;
  --ceremony-muted: #b9cabe;
  --ceremony-border: #809d8a;
  --ceremony-accent: #b4e2c4;
  --ceremony-on-accent: #182b24;
  --ceremony-focus: #b4e2c4;
  --ceremony-radius: 0.25rem;
  --ceremony-gap: 1rem;
  padding: 1rem;
}
```

`style`, `className`, `id`, and `dir` apply to the stock view. `[data-step]` identifies its state; `[data-ceremony-part]` identifies the method picker, form, fields and transport-error area. Maintain contrast, focus visibility and usable control sizes when replacing styles.

## Host UI libraries and composition

Pass a render function as `Ceremony`'s child to replace the entire view while retaining the client, initialization and WebMCP registration. It receives `{ snapshot, busy, refreshing, error, execute, client, manifest }`. Render your library's fields/buttons; submit native form values using `execute({ action: "submit", values })`. Catch rejected executions and present `error`; do not put credentials in global state, logs or analytics. Only display actions allowed by the current snapshot. The dispatcher validates again before contacting the server.

For host-owned lifetimes, create a client once and call `useCeremony(client)`. Render `CeremonyView` with the resulting model or your own components. Multiple views can share the client, including a wizard summary and active step; do not create a second execution engine. `CeremonyView` alone does not register WebMCP. Register once at the owning boundary.

Working, independently built examples:

- [React: stock light/dark instances and host-owned form](../tests/consumers/react/main.tsx)
- [Vue: native host form and shared client](../tests/consumers/vue/main.ts)

The fixtures are repository test sources, not files shipped inside the tarball.

## Framework-neutral client

```ts
import {
  browserModelContext,
  createCeremonyClient,
  createHttpTransport,
} from "@ceremony/auth";

const client = createCeremonyClient({
  manifest: connector,
  transport: createHttpTransport(),
  onActionSuccess: observeExecution,
  onActionFailure: observeExecution,
});
const unsubscribe = client.subscribe(() => render(client.getState()));
const context = browserModelContext();
const detach = context
  ? client.attachWebMCP(context, "account_connection")
  : undefined;
await client.initialize(); // catch errors in your host's mount lifecycle
```

Run initialization and registration from the host's mount lifecycle and handle rejection. Read `client.getState()` for the initial render. On final teardown call `unsubscribe()`, `detach?.()` and `client.dispose()`.

Construction performs no I/O. `initialize()` runs once: it reads `resumeId`, starts a single available method, or leaves multiple methods for selection. Use `execute({ action: "start", methodId })` to select or retry initialization after failure. `execute({ action: "read" })` refreshes an existing/resumed instance. Waiting states poll while at least one subscriber is attached. The last unsubscribe stops polling; re-subscribing resumes it. Do not dispose a shared client merely because one view unmounts. Treat returned state as immutable.

SSR can construct a per-request client without browser globals. Mount initialization and registration belong on the client; never share a server-side singleton across users. The default navigation handler uses the browser; non-browser hosts provide `navigate(url, target)` to handle validated provider URLs.

Every framework uses the same eleven commands and sanitized success/failure hooks documented in the [README](../README.md#webmcp-and-execution-hooks). Hook success is operation success, not necessarily completed authentication. Browser hooks are best-effort; durable server events are delivered separately. Disposing prevents new work and removes tools; an already-dispatched operation can still settle. For prerequisite composition, GitHub registration, secret-reference collection and MCP Apps, see [live authentication](live-auth.md). Host forms still submit native values through `execute`; the HTTP transport's `collect` method brokers password fields before the action call. Custom transports should implement `collect` and `privateInputUrl`; never route secrets through tool arguments.

## Backend boundary

The host must supply session ownership, trusted connector adapters, credential storage, callback routing and origin/CSRF controls. `createHttpTransport` expects the documented same-origin HTTP API. Cross-origin hosts need their own carefully configured transport; the test fixture's loopback proxy is not a deployment security policy. Provider consent and credential verification remain server/provider responsibilities.

## Cross-framework compilation

[Builder.io Mitosis](https://mitosis.builder.io/docs/components/) is the likely compiler mentioned: it generates framework components, but passes imports through. It would not convert the React-only OpenUI renderer into a Vue renderer. This implementation therefore keeps a framework-neutral TypeScript client and an optional React/OpenUI view. React and Vue adoption are tested against packed production builds. No generated Vue/Svelte/Angular OpenUI renderer or universal framework certification is claimed.

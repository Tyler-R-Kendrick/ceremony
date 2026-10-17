/*
 * The gate's two ledgers (custom-fetch-gate.test.ts says what each holds and
 * why). Each entry names a file, its count and its reason; the test fails on
 * a count that is off in either direction, so both only fall.
 */

export type Accepted = { count: number; why: string };
const LOADS_IN_PAGE =
  "an import run inside the browser page under test, of the bundle that page serves";
export const ACCEPTED: Record<string, Accepted> = {
  "scripts/certify-attended.ts": {
    count: 1,
    why: "loads the certification plan of the flow file the operator names on the command line",
  },
  "scripts/connector-support-matrix.ts": {
    count: 1,
    why: "loads each adapter module the repository's own list names, to read its declarations",
  },
  "tests/browser/ceremony.spec.ts": { count: 1, why: LOADS_IN_PAGE },
  "tests/browser/webmcp.spec.ts": { count: 2, why: LOADS_IN_PAGE },
  "tests/connectors/auth/response-bound.test.ts": {
    count: 9,
    why: "the transport's own test: each OAuth request is made with the options under test, passed in",
  },
  "tests/extension-inference-output.test.ts": {
    count: 1,
    why: "a require for the extension bundle under test, which esbuild leaves external",
  },
  "tests/extension-ui-lifecycle.test.ts": {
    count: 1,
    why: "a require handed to the extension bundle under test inside a sandbox",
  },
  "tests/fixtures/workflow-restart-worker.mjs": {
    count: 1,
    why: "loads the workflow bundle the parent test built, by the directory it names",
  },
  "tests/openapi-client.test.ts": {
    count: 1,
    why: "loads the client the test generated, by a path built at run time so tsc does not follow it",
  },
};

const EXAMPLE_PAGE = "the example page reading the example server's own API";
export const BODY_READS: Record<string, Accepted> = {
  "examples/agent-routes.ts": {
    count: 1,
    why: "the example server reading a request body from its caller",
  },
  "examples/http.ts": {
    count: 1,
    why: "the example server reading a request body from its caller",
  },
  "examples/issuer.ts": {
    count: 2,
    why: "the example issuer reading its callers' requests (a JSON and a form body)",
  },
  "examples/server.ts": {
    count: 4,
    why: "the example server relaying its own API's answers (two bodies, one stream) to the page it serves, and reading one of them",
  },
  "examples/showcase/main.tsx": { count: 1, why: EXAMPLE_PAGE },
  "examples/web/agent-card.tsx": { count: 2, why: EXAMPLE_PAGE },
  "examples/web/connection-plan.ts": { count: 3, why: EXAMPLE_PAGE },
  "examples/web/environment.tsx": { count: 3, why: EXAMPLE_PAGE },
  "examples/web/extension-setup.tsx": { count: 1, why: EXAMPLE_PAGE },
  "examples/web/main.tsx": { count: 2, why: EXAMPLE_PAGE },
  "examples/web/presentation-studio.tsx": { count: 2, why: EXAMPLE_PAGE },
  "examples/web/workflow-studio.tsx": {
    count: 4,
    why: "the example page reading the example server's own API, one of them its event stream",
  },
  "extensions/browser-login/worker.ts": {
    count: 1,
    why: "the extension reading the configuration its local bridge serves",
  },
  "scripts/demos/device.ts": {
    count: 1,
    why: "the demo reading the signed-in subject from the local server it started",
  },
  "scripts/prove-e2e.ts": {
    count: 8,
    why: "the end-to-end proof reading the pages and API of the local server it started",
  },
  "scripts/verify-attended.ts": {
    count: 1,
    why: "the attended check reading a run's status from the deployment under test",
  },
  "src/core/client.ts": {
    count: 2,
    why: "the app's own API answering its own client, in the browser",
  },
  "src/core/connectors/client.ts": {
    count: 2,
    why: "the app's own connector API answering its own client, in the browser",
  },
  "src/mcp-app/index.ts": {
    count: 1,
    why: "the app's own API answering the MCP app's client",
  },
  "src/react/connector-connection.tsx": {
    count: 1,
    why: "the app's own API answering the page that calls it",
  },
  "src/react/teaching.tsx": {
    count: 3,
    why: "the app's own API answering the page that calls it",
  },
  "src/server/a2h.ts": {
    count: 1,
    why: "the delivery acknowledgement from the operator's HTTPS A2H gateway, a notification service of the deployment's own, not a credential",
  },
  "src/server/adapters.ts": {
    count: 6,
    why: "each read is of a response that request() or the OAuth transport already read under the ceiling and rebuilt",
  },
  "src/server/authored-inbox.ts": {
    count: 5,
    why: "messages from the inbox the operator supplied: the address, the list and each message, which carry the verification codes and links the sign-in reads; the mailbox token's own answer is bounded",
  },
  "src/server/browser-verification.ts": {
    count: 1,
    why: "the provider's whoami page read through the browser's own Playwright request context, to compare an account name",
  },
  "src/server/connectors/auth/response-bound.ts": {
    count: 1,
    why: "the bounded reader itself: it reads the Response it rebuilt from bytes read under the ceiling",
  },
  "src/server/connectors/import/network.ts": {
    count: 2,
    why: "an import's own fetch, read after the import service's byte limit has been applied to the stream",
  },
  "src/server/connectors/import/service.ts": {
    count: 1,
    why: "an import's document, read after the import service's byte limit has been applied",
  },
  "src/server/connectors/mcp/http.ts": {
    count: 1,
    why: "an MCP server's event stream, read frame by frame and bounded by frame size and frame count rather than a running total",
  },
  "src/server/hosted/continuations.ts": {
    count: 1,
    why: "the acknowledgement of the host's own continuation endpoint, a one-field object",
  },
};

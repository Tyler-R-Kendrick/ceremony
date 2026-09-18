import assert from "node:assert/strict";
import test from "node:test";
import {
  browserModelContext,
  createCeremonyTools,
  registerCeremonyTools,
  type CeremonyTool,
} from "../../../src/core/webmcp.js";
import {
  createConnectorWebmcpTools,
  detectConnectorWebmcp,
  mountConnectorWebmcpTools,
  ownedConnectorToolNames,
  type ConnectorDispatchRequest,
} from "../../../src/server/connectors/agents/webmcp.js";
import { manifests } from "../../../examples/manifests.js";

/*
 * AG-04 and AC-AG-03.
 *
 * The existing WebMCP integration is the baseline these tests protect: the
 * same feature detection, the same registration shape, the same ownership by
 * AbortSignal. What is new is a second set of tools beside the ceremony ones,
 * and the rule that they decide nothing — the authenticated dispatcher does.
 */

type Registration = { tool: CeremonyTool; options: Record<string, unknown> };

function nativeContext() {
  const registrations: Registration[] = [];
  return {
    registrations,
    context: {
      async registerTool(tool: CeremonyTool, options: { signal: AbortSignal }) {
        registrations.push({ tool, options: { ...options } });
      },
    },
  };
}

/** Installs a native model context for the duration of one test. */
function withDocument(t: { after(fn: () => void): void }, value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value,
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "document", descriptor);
    else Reflect.deleteProperty(globalThis, "document");
  });
}

const dispatcher = () => {
  const seen: ConnectorDispatchRequest[] = [];
  return {
    seen,
    dispatch: async (request: ConnectorDispatchRequest) => {
      seen.push(request);
      return { connections: [] };
    },
  };
};

test("AC-AG-03: a browser without the native API gets ordinary UI, no polyfill and no registration", async (t) => {
  // Node has no `document`, which is exactly the unsupported-browser case.
  assert.equal(browserModelContext(), undefined);
  assert.deepEqual(detectConnectorWebmcp(), {
    available: false,
    reason: "no-native-model-context",
  });
  const { dispatch, seen } = dispatcher();
  const tools = createConnectorWebmcpTools(dispatch);
  const mount = await mountConnectorWebmcpTools(tools);
  assert.deepEqual(
    { available: mount.available, registered: mount.registered },
    { available: false, registered: [] },
  );
  assert.equal(mount.owns(tools[0]!.name), false);
  mount.unmount();

  // Nothing was installed anywhere: the absent API is still absent.
  assert.equal(
    (globalThis as { document?: unknown }).document,
    undefined,
  );
  assert.equal(
    (globalThis.navigator as { modelContext?: unknown } | undefined)
      ?.modelContext,
    undefined,
  );
  assert.equal(browserModelContext(), undefined);
  assert.deepEqual(ownedConnectorToolNames(), []);
  assert.equal(seen.length, 0);

  // The tool definitions still exist, so the application can render the same
  // capabilities as ordinary controls without a model context.
  assert.equal(tools.length, 7);
  t.diagnostic(`fallback-browser evidence: ${tools.length} tools built, 0 registered`);
});

test("AG-04: feature detection is the existing one and still prefers the current document API", (t) => {
  const legacy = { registerTool: async () => {} };
  const current = { registerTool: async () => {} };
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis.navigator,
    "modelContext",
  );
  Object.defineProperty(globalThis.navigator, "modelContext", {
    configurable: true,
    value: legacy,
  });
  t.after(() => {
    if (descriptor)
      Object.defineProperty(globalThis.navigator, "modelContext", descriptor);
    else Reflect.deleteProperty(globalThis.navigator, "modelContext");
  });
  withDocument(t, {});
  let detected = detectConnectorWebmcp();
  assert.equal(detected.available, true);
  assert.equal(detected.available && detected.api, "navigator");
  assert.equal(detected.available && detected.context, legacy);

  withDocument(t, { modelContext: current });
  detected = detectConnectorWebmcp();
  assert.equal(detected.available && detected.api, "document");
  assert.equal(detected.available && detected.context, current);
  assert.equal(browserModelContext(), current);
});

test("AG-04: mounting registers exactly the declared tools, with a signal and no cross-origin exposure", async (t) => {
  const native = nativeContext();
  withDocument(t, { modelContext: native.context });
  const { dispatch } = dispatcher();
  const tools = createConnectorWebmcpTools(dispatch, { prefix: "ceremony_connector" });
  const mount = await mountConnectorWebmcpTools(tools);
  t.after(() => mount.unmount());
  assert.equal(mount.available, true);
  assert.equal(mount.api, "document");
  assert.deepEqual(mount.registered, tools.map((tool) => tool.name));
  for (const registration of native.registrations) {
    // Only `signal`. Passing `exposedTo` would be a claim to drive another
    // origin's frame, and this page makes no such claim.
    assert.deepEqual(Object.keys(registration.options), ["signal"]);
    assert.ok(registration.options.signal instanceof AbortSignal);
  }
  assert.equal(mount.crossOriginExposure, "not-requested");
  assert.deepEqual(
    native.registrations.map((registration) => registration.tool.name),
    [
      "ceremony_connector_list",
      "ceremony_connector_inspect",
      "ceremony_connector_status",
      "ceremony_connector_connect",
      "ceremony_connector_operations",
      "ceremony_connector_reconnect",
      "ceremony_connector_disconnect",
    ],
  );
});

test("AG-04: tool ownership survives mount and unmount and never reaches another owner's tools", async (t) => {
  const native = nativeContext();
  withDocument(t, { modelContext: native.context });

  // The ceremony tools the application already registers, with their own signal.
  const ceremonyAbort = new AbortController();
  await registerCeremonyTools(
    native.context,
    "ceremony",
    manifests[0]!,
    async () => undefined,
    ceremonyAbort.signal,
  );
  const ceremonyNames = native.registrations.map((r) => r.tool.name);
  assert.ok(ceremonyNames.length > 0);

  const { dispatch } = dispatcher();
  const tools = createConnectorWebmcpTools(dispatch);
  const mount = await mountConnectorWebmcpTools(tools);
  assert.deepEqual(ownedConnectorToolNames().sort(), mount.registered.sort());
  for (const name of ceremonyNames) assert.equal(mount.owns(name), false);

  // A second mount of the same names while the first is live is refused
  // rather than allowed to shadow it.
  await assert.rejects(
    mountConnectorWebmcpTools(createConnectorWebmcpTools(dispatch)),
    /already mounted/,
  );

  // Unmounting aborts our own signal only; the ceremony tools' signal is untouched.
  const ours = native.registrations
    .filter((r) => mount.registered.includes(r.tool.name))
    .map((r) => r.options.signal as AbortSignal);
  mount.unmount();
  assert.ok(ours.every((signal) => signal.aborted));
  assert.equal(ceremonyAbort.signal.aborted, false);
  assert.deepEqual(ownedConnectorToolNames(), []);

  // And the names are free again.
  const second = await mountConnectorWebmcpTools(
    createConnectorWebmcpTools(dispatch),
  );
  t.after(() => second.unmount());
  assert.equal(second.registered.length, 7);
});

test("AG-04: an outer abort unmounts, and an already-aborted signal registers nothing", async (t) => {
  const native = nativeContext();
  withDocument(t, { modelContext: native.context });
  const { dispatch } = dispatcher();
  const aborted = new AbortController();
  aborted.abort();
  const none = await mountConnectorWebmcpTools(
    createConnectorWebmcpTools(dispatch),
    { signal: aborted.signal },
  );
  assert.deepEqual(none.registered, []);
  assert.equal(native.registrations.length, 0);

  const page = new AbortController();
  const mount = await mountConnectorWebmcpTools(
    createConnectorWebmcpTools(dispatch),
    { signal: page.signal },
  );
  assert.equal(mount.registered.length, 7);
  page.abort();
  assert.ok(
    native.registrations.every((r) => (r.options.signal as AbortSignal).aborted),
  );
  assert.deepEqual(ownedConnectorToolNames(), []);
  mount.unmount();
});

test("AG-04: connector tools go through the authenticated dispatcher, and an annotation grants nothing", async (t) => {
  const native = nativeContext();
  withDocument(t, { modelContext: native.context });
  const { dispatch, seen } = dispatcher();
  const tools = createConnectorWebmcpTools(dispatch);
  const mount = await mountConnectorWebmcpTools(tools);
  t.after(() => mount.unmount());
  const registered = new Map(
    native.registrations.map((r) => [r.tool.name, r.tool]),
  );

  const disconnect = registered.get("ceremony_connector_disconnect")!;
  assert.deepEqual(disconnect.annotations, {
    readOnlyHint: false,
    consequentialHint: true,
    untrustedContentHint: true,
  });
  // A model (or a page script) rewriting the annotation changes nothing: the
  // dispatcher is not told about it and the server never sees it.
  disconnect.annotations.readOnlyHint = true;
  disconnect.annotations.consequentialHint = false;
  const result = await disconnect.execute({
    connectionRef: "connection:1",
    expectedRevision: 3,
  });
  assert.equal(Reflect.get(Object(result), "ok"), true);
  assert.equal(seen.length, 1);
  assert.deepEqual(Object.keys(seen[0]!).sort(), ["input", "intent", "signal"]);
  assert.equal(seen[0]!.intent, "disconnect");
  assert.deepEqual(seen[0]!.input, {
    connectionRef: "connection:1",
    expectedRevision: 3,
  });

  // Arguments that try to name an actor, a tenant or an unknown field never
  // reach the dispatcher.
  for (const input of [
    null,
    [],
    "text",
    { intent: "disconnect" },
    { actor: { subjectId: "other" }, connectionRef: "connection:1" },
    { connectionRef: "connection:1", expectedRevision: 3, tenantId: "tenant-b" },
    { connectionRef: "connection:1", expectedRevision: 3, scope: "upstream" },
    { connectionRef: "connection:1" },
  ]) {
    const before = seen.length;
    const failed = await disconnect.execute(input);
    assert.equal(Reflect.get(Object(failed), "ok"), false);
    assert.equal(seen.length, before, JSON.stringify(input));
  }
});

test("AG-04: a dispatcher failure is reported without echoing what the server said", async (t) => {
  const native = nativeContext();
  withDocument(t, { modelContext: native.context });
  const tools = createConnectorWebmcpTools(async () => {
    throw new Error("invalid_grant: CANARY_PROVIDER_MSG_1a9");
  });
  const mount = await mountConnectorWebmcpTools(tools);
  t.after(() => mount.unmount());
  const listed = await tools[0]!.execute({});
  assert.equal(Reflect.get(Object(listed), "ok"), false);
  assert.doesNotMatch(JSON.stringify(listed), /CANARY|invalid_grant/);
});

test("AG-04: connector tools have the same shape as the ceremony tools already registered", async () => {
  const { dispatch } = dispatcher();
  const connector = createConnectorWebmcpTools(dispatch);
  const ceremony = createCeremonyTools(
    "ceremony",
    manifests[0]!,
    async () => undefined,
    new AbortController().signal,
  );
  const shapeOf = (tool: CeremonyTool) => Object.keys(tool).sort();
  for (const tool of connector) assert.deepEqual(shapeOf(tool), shapeOf(ceremony[0]!));
  // Every input schema is a closed object, so an unknown field is a refusal
  // rather than something a client may hope the server ignores.
  for (const tool of connector) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(tool.description.length > 20);
  }
  assert.throws(() => createConnectorWebmcpTools(dispatch, { prefix: "bad prefix" }));
});

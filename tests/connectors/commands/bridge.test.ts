import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActorContext } from "../../../src/core/operation-contracts.js";
import { CeremonyController } from "../../../src/server/controller.js";
import {
  connectorToolDependencies,
  createConnectorRegistration,
  CONNECTOR_CALLBACK_PATH,
  type ConnectorToolDependencies,
} from "../../../src/server/connectors/commands/index.js";
import {
  agent,
  createHarness,
  delegate,
  FIXTURE_DOCUMENT,
  human,
  ORIGIN,
  type Harness,
} from "./harness.js";

/*
 * The bridges: the existing Ceremony lifecycle driven by the same command
 * service, the tool dependency object the MCP surface consumes, and the
 * effect discipline that keeps a prior approval from covering changed input
 * or a changed binding revision.
 */

const SESSION = "human-session";

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function reviewed(
  harness: Harness,
  actor: ActorContext,
  approvals: Record<string, unknown> = {},
) {
  harness.register(SESSION, actor);
  const imported = await json(
    await harness.fetch("/api/v1/connectors/import", {
      body: {
        kind: "upload",
        mediaType: "application/json",
        text: FIXTURE_DOCUMENT(harness.provider.origin),
      },
      session: SESSION,
    }),
  );
  const definitionRef = (imported.definitions as string[])[0]!;
  const binding = await json(
    await harness.fetch("/api/v1/connectors/bindings", {
      body: {
        definitionRef,
        adapterId: "fixture-http",
        approvals: {
          destinations: [harness.provider.origin],
          operations: [
            "listItems",
            { nativeId: "createItem", consent: "none" },
          ],
          profileId: "oauth",
          ...approvals,
        },
      },
      session: SESSION,
    }),
  );
  const definition = await harness.definitions.getDefinition(
    actor.tenantId,
    definitionRef,
  );
  assert.ok(definition);
  return {
    definitionRef,
    definition,
    bindingRef: binding.bindingRef as string,
    revision: binding.revision as number,
  };
}

function operationRef(
  harness: Harness,
  bindingRef: string,
  nativeId: string,
  revision?: number,
): string {
  const bindings = harness.definitions
    .bindings()
    .filter((item) => item.bindingRef === bindingRef)
    .sort((a, b) => a.revision - b.revision);
  const binding =
    revision === undefined
      ? bindings.at(-1)
      : bindings.find((item) => item.revision === revision);
  const operation = binding?.operations.find(
    (item) => item.nativeId === nativeId,
  );
  if (!operation) throw new Error(`no approved operation ${nativeId}`);
  return operation.operationRef;
}

test("CMD-02: a reviewed connector runs as a v1 ceremony through the controller", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const actor = human();
  const { definition, bindingRef } = await reviewed(harness, actor);

  const registration = createConnectorRegistration(
    harness.service,
    "fixture-http",
    {
      connectorId: "fixture",
      definition,
      bindingRef,
      actorFor: (owner) => (owner === "owner-1" ? actor : undefined),
    },
  );

  assert.deepEqual(
    registration.manifest.methods.map((method) => ({
      id: method.id,
      kind: method.kind,
    })),
    [
      { id: "oauth", kind: "oauth-code" },
      { id: "api-key", kind: "api-key" },
    ],
    "the manifest is derived from the definition's profiles, with nothing invented",
  );
  assert.equal(registration.manifest.support, "fixture");
  assert.equal(
    registration.availability?.("stranger", registration.manifest.methods[0]!),
    "unavailable",
    "an unauthenticated owner has no available method",
  );

  const controller = new CeremonyController([registration]);
  const started = controller.start("owner-1", "fixture", "oauth");
  assert.equal(started.step, "intro");

  const begun = await controller.act("owner-1", started.id, {
    action: "begin",
    revision: started.revision,
    values: {},
  });
  assert.equal(begun.step, "redirect");
  assert.ok(
    begun.authorizationUrl?.startsWith(
      `${harness.provider.origin}/oauth/authorize`,
    ),
    "the ceremony shows the provider URL the command service issued",
  );

  const redirect = await fetch(begun.authorizationUrl!, { redirect: "manual" });
  const location = new URL(redirect.headers.get("location")!);
  await redirect.body?.cancel().catch(() => {});
  assert.equal(
    location.pathname,
    CONNECTOR_CALLBACK_PATH,
    "the provider was given the deployment's fixed callback path",
  );
  assert.equal(location.origin, ORIGIN);

  const completed = await controller.callback("owner-1", started.id, location);
  assert.equal(completed.step, "complete");
  assert.ok(completed.outcome?.connectionRef.startsWith("connection:"));
  assert.deepEqual(
    completed.outcome?.scopes,
    ["read", "write"],
    "the outcome reports the scopes the method asked for",
  );
  assert.ok(
    !JSON.stringify(completed).includes("code_verifier"),
    "no protected handoff material reaches the ceremony snapshot",
  );

  const view = await harness.service.status(
    actor,
    completed.outcome!.connectionRef,
  );
  assert.equal(view.lifecycle, "active");
});

test("CMD-02: an api-key ceremony collects through the same command service", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const actor = human();
  const { definition, bindingRef } = await reviewed(harness, actor);
  const registration = createConnectorRegistration(
    harness.service,
    "fixture-http",
    {
      connectorId: "fixture",
      definition,
      bindingRef,
      profiles: ["api-key"],
      actorFor: () => actor,
    },
  );
  assert.equal(registration.manifest.methods.length, 1);
  const controller = new CeremonyController([registration]);
  const started = controller.start("owner-1", "fixture", "api-key");
  assert.equal(started.step, "input");
  assert.deepEqual(
    started.fields.map((field) => field.name),
    ["token"],
  );

  const submitted = await controller.act("owner-1", started.id, {
    action: "submit",
    revision: started.revision,
    values: { token: "fixture-api-key" },
  });
  assert.equal(submitted.step, "complete");
  assert.ok(submitted.outcome);
  const view = await harness.service.status(
    actor,
    submitted.outcome!.connectionRef,
  );
  assert.equal(view.lifecycle, "active");
  assert.ok(
    !JSON.stringify(submitted).includes("fixture-api-key"),
    "the submitted key never appears in a ceremony snapshot",
  );
});

test("a definition with no drivable profile yields no fabricated method", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const actor = human();
  const { definition, bindingRef } = await reviewed(harness, actor);
  const publicOnly = {
    ...definition,
    authentication: [
      {
        id: "public",
        label: "Public",
        kind: "none" as const,
        reason: "public" as const,
      },
    ],
    capabilities: definition.capabilities.map((capability) => ({
      ...capability,
      authentication: [],
    })),
  };
  assert.throws(
    () =>
      createConnectorRegistration(harness.service, "fixture-http", {
        connectorId: "fixture",
        definition: publicOnly,
        bindingRef,
        actorFor: () => actor,
      }),
    /supported|unsupported|not supported/i,
    "a no-credential description never becomes a fake login method",
  );
});

test("CMD-03/AGENT: the tool dependency object exposes catalog, status, connect and invoke", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const actor = human();
  const { bindingRef } = await reviewed(harness, actor);
  const tools: ConnectorToolDependencies = connectorToolDependencies(
    harness.service,
  );

  const catalog = await tools.catalog(actor);
  assert.ok(catalog.some((entry) => entry.id === "fixture-http"));

  const connected = await tools.connect(actor, {
    bindingRef,
    intent: { profileId: "oauth", requestedPermissions: ["read"] },
  });
  assert.equal(
    (connected as Record<string, unknown>).presentation,
    undefined,
    "a tool result never carries presentation material, even for a human actor",
  );
  const connectionRef = connected.connectionRef;

  const status = await tools.status(actor, { connectionRef });
  assert.equal(status.connectionRef, connectionRef);
  assert.equal((status as Record<string, unknown>).presentation, undefined);

  // The human surface still gets what it needs to continue.
  const human_ = await harness.service.status(actor, connectionRef);
  assert.ok(
    (human_ as { presentation?: { url?: string } }).presentation?.url,
    "the same connection presents a URL on the human surface",
  );

  await assert.rejects(
    () =>
      tools.invoke(actor, {
        connectionRef,
        operationRef: "operation:x",
        commandId: "c1",
      }),
    "an unapproved operation is refused through the tool surface too",
  );

  const model = agent();
  await delegate(harness.store, model);
  const forAgent = await tools.status(model, { connectionRef });
  assert.equal((forAgent as Record<string, unknown>).displayName, undefined);
  assert.deepEqual(
    (forAgent as { handoff?: unknown }).handoff,
    { kind: "provider-browser", state: "issued" },
    "an agent sees a handoff's kind and state, never its presentation",
  );
});

test("CMD-04: a prior approval does not cover changed input or a changed binding revision", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const actor = human();
  const { definitionRef, bindingRef, revision } = await reviewed(
    harness,
    actor,
    {
      operations: ["listItems"],
    },
  );
  const connected = await json(
    await harness.fetch("/api/v1/connectors/connections", {
      body: {
        bindingRef,
        intent: { profileId: "oauth", requestedPermissions: ["read"] },
      },
      session: SESSION,
    }),
  );
  const connectionRef = connected.connectionRef as string;
  const redirect = await fetch(
    (connected.presentation as { url: string }).url,
    {
      redirect: "manual",
    },
  );
  const location = new URL(redirect.headers.get("location")!);
  await redirect.body?.cancel().catch(() => {});
  await harness.fetch(`${location.pathname}${location.search}`, {
    session: SESSION,
  });

  const listItems = operationRef(harness, bindingRef, "listItems", revision);
  const first = await json(
    await harness.fetch(
      `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/invoke`,
      {
        body: {
          operationRef: listItems,
          input: { project: "alpha" },
          commandId: "cmd-1",
        },
        session: SESSION,
      },
    ),
  );
  assert.equal(first.state, "complete");

  const reusedCommand = {
    operationRef: listItems,
    input: { project: "beta" },
    commandId: "cmd-1",
  };
  const changedInput = await harness.fetch(
    `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/invoke`,
    { body: reusedCommand, session: SESSION },
  );
  assert.equal(
    changedInput.status,
    403,
    "the same command id with different input is refused",
  );
  assert.equal((await json(changedInput)).detail, "command.reused");
  assert.equal(
    harness.provider.received("GET", "/v1/items").length,
    1,
    "and nothing further reached the provider",
  );

  // The refusal happened before anything external was attempted, so sending it
  // again must read exactly the same way. A refusal that left its journal entry
  // open would answer this repeat from the journal instead -- reporting an
  // effect that never started as one that may have landed, and, for a write,
  // telling the caller and the operator to reconcile something that does not
  // exist.
  const repeated = await harness.fetch(
    `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/invoke`,
    { body: reusedCommand, session: SESSION },
  );
  assert.equal(
    repeated.status,
    403,
    "repeating the refused command is refused again, not replayed",
  );
  assert.equal((await json(repeated)).detail, "command.reused");
  assert.equal(
    harness.provider.received("GET", "/v1/items").length,
    1,
    "and still nothing reached the provider",
  );
  const journal = harness.ports.inspect.effects();
  assert.deepEqual(
    journal.filter((effect) => !effect.outcome).map((effect) => effect.intent),
    [],
    "no journal entry is left without an outcome for reconciliation to chase",
  );
  const refused = journal.filter(
    (effect) => effect.outcome?.code === "command.reused",
  );
  assert.equal(refused.length, 1, "the refused intent is journaled once");
  assert.equal(
    refused[0]!.outcome?.status,
    "not-applied",
    "and recorded as definitively not applied, since nothing was attempted",
  );

  // A later review approves more; the live connection stays pinned to the
  // revision it was verified against.
  const second = await json(
    await harness.fetch("/api/v1/connectors/bindings", {
      body: {
        definitionRef,
        adapterId: "fixture-http",
        approvals: {
          destinations: [harness.provider.origin],
          operations: [
            "listItems",
            {
              nativeId: "createItem",
              consent: "none",
              outputClassification: "public",
            },
          ],
          profileId: "oauth",
        },
      },
      session: SESSION,
    }),
  );
  assert.equal(
    second.revision,
    revision + 1,
    "a review creates a new revision",
  );
  const newWrite = operationRef(
    harness,
    bindingRef,
    "createItem",
    second.revision as number,
  );
  assert.throws(
    () => operationRef(harness, bindingRef, "createItem", revision),
    "the reviewed revision this connection uses never approved that operation",
  );

  const usingNew = await harness.fetch(
    `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/invoke`,
    {
      body: {
        operationRef: newWrite,
        input: { name: "x" },
        commandId: "cmd-2",
        confirm: true,
      },
      session: SESSION,
    },
  );
  assert.equal(
    usingNew.status,
    403,
    "an operation from a revision this connection never reviewed is unapproved",
  );
  assert.equal((await json(usingNew)).detail, "operation.unapproved");

  const stored = harness.ports.inspect
    .connections()
    .find((entry) => entry.record.connectionRef === connectionRef);
  assert.equal(
    stored?.record.bindingRevision,
    revision,
    "the connection stays pinned until it is deliberately reconnected",
  );

  const status = await json(
    await harness.fetch(
      `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}`,
      { session: SESSION },
    ),
  );
  await harness.fetch(
    `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/reconnect`,
    { body: { expectedRevision: status.revision }, session: SESSION },
  );
  const adopted = harness.ports.inspect
    .connections()
    .find((entry) => entry.record.connectionRef === connectionRef);
  assert.equal(
    adopted?.record.bindingRevision,
    second.revision,
    "reconnect adopts the current reviewed revision",
  );
});

test("CMD-04: an interrupted write is indeterminate and never blindly replayed", async (t) => {
  const harness = await createHarness({
    provider: { dropWriteResponse: true },
  });
  t.after(() => harness.close());
  const actor = human();
  const { bindingRef } = await reviewed(harness, actor, {
    operations: [
      "listItems",
      {
        nativeId: "createItem",
        consent: "none",
        replay: "upstream-idempotency-key",
        outputClassification: "public",
      },
    ],
  });
  const connected = await json(
    await harness.fetch("/api/v1/connectors/connections", {
      body: {
        bindingRef,
        intent: { profileId: "oauth", requestedPermissions: ["write"] },
      },
      session: SESSION,
    }),
  );
  const connectionRef = connected.connectionRef as string;
  const redirect = await fetch(
    (connected.presentation as { url: string }).url,
    {
      redirect: "manual",
    },
  );
  const location = new URL(redirect.headers.get("location")!);
  await redirect.body?.cancel().catch(() => {});
  await harness.fetch(`${location.pathname}${location.search}`, {
    session: SESSION,
  });

  const write = operationRef(harness, bindingRef, "createItem");
  const body = {
    operationRef: write,
    input: { name: "interrupted" },
    commandId: "cmd-write",
    confirm: true,
  };
  const dropped = await harness.fetch(
    `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/invoke`,
    { body, session: SESSION },
  );
  assert.equal(dropped.status, 409);
  const explained = await json(dropped);
  assert.equal(explained.error, "indeterminate");
  assert.equal(explained.detail, "effect.uncertain");

  const retried = await json(
    await harness.fetch(
      `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/invoke`,
      { body, session: SESSION },
    ),
  );
  assert.equal(
    retried.state,
    "indeterminate",
    "the journal answers the retry rather than repeating the effect",
  );
  assert.equal(retried.replayed, true);
  assert.equal(
    harness.provider.received("POST", "/v1/items").length,
    1,
    "the provider saw exactly one write attempt",
  );
});

test("CMD-05: status, poll and handoff outcomes stay deterministic without a model", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const actor = human();
  const { bindingRef } = await reviewed(harness, actor);
  const connected = await json(
    await harness.fetch("/api/v1/connectors/connections", {
      body: {
        bindingRef,
        intent: { profileId: "oauth", requestedPermissions: ["read"] },
      },
      session: SESSION,
    }),
  );
  const connectionRef = connected.connectionRef as string;

  const polled = await json(
    await harness.fetch(
      `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/poll`,
      { body: {}, session: SESSION },
    ),
  );
  assert.equal(
    polled.lifecycle,
    "authorization-required",
    "polling a pending provider-browser handoff reports pending, never success",
  );
  assert.equal(polled.lastOutcome, "authorization.pending");
  assert.ok(
    (polled.presentation as { url?: string }).url,
    "and the person keeps the link they need",
  );

  const cancelled = await json(
    await harness.fetch(
      `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/cancel`,
      { body: {}, session: SESSION },
    ),
  );
  assert.equal(cancelled.lastOutcome, "handoff.cancelled");
  assert.equal(
    (cancelled.handoff as { state: string }).state,
    "cancelled",
    "closing the window is recorded as a cancellation, not a completion",
  );
  assert.notEqual(cancelled.lifecycle, "active");
  assert.equal(cancelled.verification, undefined);
});

test("CMD-01: the catalog separates fixture, unconfigured and configured entries", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const actor = human();
  harness.register(SESSION, actor);
  const { createFixtureAdapter } =
    await import("../doubles/fixture-adapter.js");
  const provider = createFixtureAdapter();
  harness.registry.register({
    ...provider,
    id: "provider-backed",
    support: "provider-backed",
    configuration: [
      {
        name: "PROVIDER_CLIENT_ID",
        source: "host",
        classification: "public",
        required: true,
      },
    ],
  });

  const before = (
    await json(
      await harness.fetch("/api/v1/connectors/catalog", { session: SESSION }),
    )
  ).entries as Array<Record<string, unknown>>;
  const unconfigured = before.find((entry) => entry.id === "provider-backed");
  assert.equal(
    unconfigured?.support,
    "unconfigured",
    "a provider-backed adapter without its configuration reports unconfigured",
  );
  assert.deepEqual(unconfigured?.configuration, [
    {
      name: "PROVIDER_CLIENT_ID",
      required: true,
      classification: "public",
      present: false,
    },
  ]);

  harness.setConfiguration(actor, "PROVIDER_CLIENT_ID", "abc");
  const after = (
    await json(
      await harness.fetch("/api/v1/connectors/catalog", { session: SESSION }),
    )
  ).entries as Array<Record<string, unknown>>;
  assert.equal(
    after.find((entry) => entry.id === "provider-backed")?.support,
    "provider-backed",
    "and reports itself configured once the name is present for this actor",
  );
  assert.equal(
    after.find((entry) => entry.id === "fixture-http")?.support,
    "fixture",
    "while the fixture entry stays visibly a fixture",
  );

  const stranger = human({ subjectId: "subject-9", sessionId: "session-9" });
  harness.register("stranger", stranger);
  const theirs = (
    await json(
      await harness.fetch("/api/v1/connectors/catalog", {
        session: "stranger",
      }),
    )
  ).entries as Array<Record<string, unknown>>;
  assert.equal(
    theirs.find((entry) => entry.id === "provider-backed")?.support,
    "unconfigured",
    "configuration presence is resolved per actor, never globally",
  );
});

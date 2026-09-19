import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agent,
  completeOauthCallback,
  createHarness,
  delegate,
  FIXTURE_DOCUMENT,
  human,
  type Harness,
} from "./harness.js";
import { createAgentConnectorIntents } from "../../../src/server/connectors/agents/intents.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";

/*
 * INT-AG-01..07: the seam between the command service and an assistant's
 * connector intents.
 *
 * The intents narrow every result themselves, so what reaches them must be
 * unprojected. `agentDependencies()` is the only way to get that, and these
 * tests treat it as an attack surface rather than a convenience: the actor
 * must really be a delegated agent, the policy must really be asked again on
 * each call, and nothing presentational may survive the round trip to an
 * intent's result.
 *
 * They also drive the real dependencies rather than a stub, because each one
 * hands the service an object a schema then parses: a key in the wrong place
 * still compiles, since those methods take `unknown` and let the schema be the
 * contract, so only a real call proves the intent is reachable at all.
 */

const SESSION = "human-session";

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function approved(harness: Harness) {
  const actor = human();
  harness.register(SESSION, actor);
  const imported = await harness.fetch("/api/v1/connectors/import", {
    body: {
      kind: "upload",
      mediaType: "application/json",
      text: FIXTURE_DOCUMENT(harness.provider.origin),
    },
    session: SESSION,
  });
  assert.equal(imported.status, 200);
  const result = await json(imported);
  const definitionRef = (result.definitions as string[])[0]!;
  const binding = await harness.fetch("/api/v1/connectors/bindings", {
    body: {
      definitionRef,
      adapterId: "fixture-http",
      approvals: {
        destinations: [harness.provider.origin],
        operations: ["listItems"],
        profileId: "oauth",
        permittedTargets: [{ kind: "account", id: "acct-primary" }],
      },
    },
    session: SESSION,
  });
  assert.equal(binding.status, 201);
  return {
    definitionRef,
    bindingRef: (await json(binding)).bindingRef as string,
  };
}

test("INT-AG-01: a human actor cannot reach the agent seam", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const deps = harness.service.agentDependencies();
  // A human holds strictly more capability than an agent, which is exactly
  // why the seam must not accept one: its results are unprojected, and the
  // intents would hand them straight back.
  //
  // The assertion reads `detail`, not the message: a ConnectorError message
  // is the same sentence for every denial on purpose, so a message match
  // would pass for any refusal at all and prove nothing about this one.
  const refused = async (call: () => Promise<unknown>): Promise<void> => {
    await assert.rejects(call, (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.code, "denied");
      assert.equal(error.detail, "agent.actor-required");
      return true;
    });
  };
  await refused(() => deps.list(human()));
  await refused(() => deps.status(human(), "connection:anything"));
});

test("INT-AG-02: an agent without executor capability is refused", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const deps = harness.service.agentDependencies();
  const weak = agent({ capabilities: [] });
  await delegate(harness.store, weak);
  await assert.rejects(() => deps.list(weak));
});

test("INT-AG-03: the seam returns unprojected state the intents can narrow", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { definitionRef } = await approved(harness);
  const actor = agent();
  await delegate(harness.store, actor);

  const deps = harness.service.agentDependencies();
  const definition = await deps.definition(actor, definitionRef);
  assert.ok(definition, "an agent may read a definition it can execute");
  // Unprojected: the full normalized shape, not the review or agent view.
  assert.ok(Array.isArray(definition.capabilities));
  assert.ok(
    definition.sourceRef,
    "the raw definition still carries its source",
  );

  // And the intent built on it narrows that away.
  const intents = createAgentConnectorIntents(deps);
  const inspect = intents.find((item) => item.intent === "inspect");
  assert.ok(inspect);
  const narrowed = (await inspect.run(actor, { definitionRef })) as Record<
    string,
    unknown
  >;
  assert.ok(!("sourceRef" in narrowed), "the projection drops the source");
  assert.ok(
    !JSON.stringify(narrowed).includes(harness.provider.origin),
    "no destination reaches an assistant",
  );
});

test("INT-AG-04: an unknown reference and a denied one read alike", async (t) => {
  const harness = await createHarness({
    policy: (base) => ({
      ...base,
      authorize: (actor, subject, action) =>
        action === "catalog" && subject.kind === "definition"
          ? false
          : base.authorize(actor, subject, action),
    }),
  });
  t.after(() => harness.close());
  const { definitionRef } = await approved(harness);
  const actor = agent();
  await delegate(harness.store, actor);
  const deps = harness.service.agentDependencies();

  // The reference exists and the policy refuses it. The answer is the same
  // absence an unknown reference gets, so an assistant cannot use the seam to
  // discover which references are real.
  assert.equal(await deps.definition(actor, definitionRef), undefined);
  assert.equal(await deps.definition(actor, "definition:not-real"), undefined);
});

test("INT-AG-05: a delegation stopped between two calls denies the second", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { definitionRef } = await approved(harness);
  const actor = agent();
  await delegate(harness.store, actor);
  const deps = harness.service.agentDependencies();
  assert.ok(await deps.definition(actor, definitionRef));

  // Nothing about the actor changed; the delegation behind it stopped. The
  // seam asks again rather than trusting the first answer.
  await delegate(harness.store, actor, { stopped: true });
  assert.equal(await deps.definition(actor, definitionRef), undefined);
});

test("INT-AG-06: listing is scoped to the caller and never leaks another tenant", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  await approved(harness);
  const actor = agent();
  await delegate(harness.store, actor);
  const deps = harness.service.agentDependencies();
  // No connection yet, so the honest answer is an empty list, not an error.
  assert.deepEqual(await deps.list(actor), []);

  const foreign = agent({ tenantId: "tenant-b", delegationId: "run:other" });
  await delegate(harness.store, foreign);
  assert.deepEqual(await deps.list(foreign), []);
});

test("INT-AG-07: an agent's reconnect reaches the service as the service declares it", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const { bindingRef } = await approved(harness);
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
  await completeOauthCallback(
    harness,
    SESSION,
    (connected.presentation as { url: string }).url,
  );

  const actor = agent();
  await delegate(harness.store, actor);
  const deps = harness.service.agentDependencies();
  const before = await deps.status(actor, connectionRef);
  assert.ok(
    before,
    "the agent can see the connection it is about to reconnect",
  );

  // `accountSwitch` still refuses here, and that refusal is the proof the seam
  // hands the service the keys it declares: a wrapped or dropped flag would
  // reach `reconnect` as the default and quietly reconnect the same account.
  await assert.rejects(
    () =>
      deps.reconnect(actor, {
        connectionRef,
        expectedRevision: before.revision,
        accountSwitch: true,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.code, "denied");
      assert.equal(error.detail, "account-switch.human-only");
      return true;
    },
  );

  const summary = await deps.reconnect(actor, {
    connectionRef,
    expectedRevision: before.revision,
  });
  assert.equal(
    summary.lifecycle,
    "authorization-required",
    "an expired connection can be re-established through the agent seam",
  );
  assert.equal(
    summary.generation,
    before.generation + 1,
    "and the reconnect really advanced the generation, not just parsed",
  );
});

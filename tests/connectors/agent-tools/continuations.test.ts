import assert from "node:assert/strict";
import test from "node:test";
import type { ActorContext } from "../../../src/core/operation-contracts.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  DelegationStopRegistry,
  assertContinuation,
  continuationSurfaces,
  createContinuationGuard,
  evaluateContinuation,
  isDelegatedWork,
  type ContinuationConnection,
  type ContinuationIntent,
  type ContinuationRequest,
  type ContinuationState,
  type ContinuationSurface,
} from "../../../src/server/connectors/agents/continuations.js";
import { fixtureActor } from "../doubles/ports.js";

/*
 * AG-05 and AC-AG-04.
 *
 * The point of every test here is that the answer does not depend on the
 * transport. Each one asks the same question on HTTP, MCP, WebMCP and A2A
 * and asserts one answer, so a surface that grew its own opinion would fail
 * rather than quietly become the deployment's real policy.
 */

const agentActor: ActorContext = { ...fixtureActor, actorKind: "agent" };

const connection: ContinuationConnection = {
  connectionRef: "connection:1",
  tenantId: fixtureActor.tenantId,
  ownerId: fixtureActor.subjectId,
  lifecycle: "active",
  generation: 2,
  bindingRevision: 5,
  policyRevision: "policy:7",
  configurationRevision: "cfg:3",
};

const baseState = (
  overrides: Partial<ContinuationState> = {},
): ContinuationState => ({
  now: 1_760_000_000_000,
  capabilities: ["executor", "admin"],
  connection,
  ...overrides,
});

const request = (
  surface: ContinuationSurface,
  overrides: Partial<ContinuationRequest> = {},
): ContinuationRequest => ({
  surface,
  actor: agentActor,
  intent: "operate",
  connectionRef: "connection:1",
  operationRef: "operation:listPets",
  ...overrides,
});

/** Runs one question on all four surfaces and returns the four answers. */
const acrossSurfaces = (
  overrides: Partial<ContinuationRequest>,
  state: ContinuationState,
) =>
  continuationSurfaces.map((surface) => ({
    surface,
    decision: evaluateContinuation(request(surface, overrides), state),
  }));

test("AC-AG-04: stopping the assistant denies the same action on HTTP, MCP, WebMCP and A2A alike", () => {
  const stopped = baseState({ stoppedAt: 1_759_000_000_000 });
  for (const intent of [
    "connect",
    "operate",
    "delegate",
  ] as ContinuationIntent[]) {
    const answers = acrossSurfaces({ intent }, stopped);
    assert.deepEqual(
      answers.map((answer) => [
        answer.surface,
        answer.decision.allowed,
        answer.decision.allowed ? undefined : answer.decision.denial,
      ]),
      continuationSurfaces.map((surface) => [
        surface,
        false,
        "assistant-stopped",
      ]),
      intent,
    );
    // The same failure code on every transport, so no surface reports it as
    // something a caller may work around.
    for (const answer of answers)
      if (!answer.decision.allowed) {
        assert.equal(answer.decision.code, "cancelled");
        assert.equal(answer.decision.detail, "continuation.assistant-stopped");
      }
  }
  // Reading state and taking a connection apart are still possible: a stop
  // halts new delegated work, it does not strand the person.
  for (const intent of ["read", "disconnect"] as ContinuationIntent[])
    for (const answer of acrossSurfaces({ intent }, stopped))
      assert.equal(
        answer.decision.allowed,
        true,
        `${intent} ${answer.surface}`,
      );
});

test("AC-AG-04: a WebMCP call is delegated work even though it runs in the person's own session", () => {
  const humanSession = { ...request("webmcp"), actor: fixtureActor };
  assert.equal(isDelegatedWork(humanSession), true);
  const decision = evaluateContinuation(
    humanSession,
    baseState({ stoppedAt: 1 }),
  );
  assert.equal(decision.allowed, false);
  assert.equal(
    decision.allowed === false && decision.denial,
    "assistant-stopped",
  );

  // The same person clicking in the application is not delegated work.
  const browsing = { ...request("http"), actor: fixtureActor };
  assert.equal(isDelegatedWork(browsing), false);
  assert.equal(
    evaluateContinuation(browsing, baseState({ stoppedAt: 1 })).allowed,
    true,
  );
  // But an explicit delegation from that same session is.
  assert.equal(
    evaluateContinuation(
      { ...browsing, intent: "delegate" },
      baseState({ stoppedAt: 1 }),
    ).allowed,
    false,
  );
});

test("AG-05: a role change applies equally to every transport", () => {
  const demoted = baseState({ capabilities: ["author"] });
  for (const intent of [
    "read",
    "connect",
    "operate",
    "delegate",
    "disconnect",
  ] as ContinuationIntent[])
    for (const answer of acrossSurfaces({ intent }, demoted)) {
      assert.equal(
        answer.decision.allowed,
        false,
        `${intent} ${answer.surface}`,
      );
      assert.equal(
        answer.decision.allowed === false && answer.decision.denial,
        "role-revoked",
      );
    }
  // Administration needs more than an executor, on every transport.
  for (const answer of acrossSurfaces(
    { intent: "administer" },
    baseState({ capabilities: ["executor"] }),
  ))
    assert.equal(
      answer.decision.allowed === false && answer.decision.denial,
      "role-revoked",
      answer.surface,
    );
});

test("AG-05: a policy, binding, configuration or generation change fences continuations everywhere", () => {
  const cases = [
    [{ generation: 1 }, "generation-fenced"],
    [{ bindingRevision: 4 }, "binding-revised"],
    [{ policyRevision: "policy:6" }, "policy-revised"],
    [{ configurationRevision: "cfg:2" }, "configuration-revised"],
  ] as const;
  for (const [observed, denial] of cases)
    for (const answer of acrossSurfaces({ observed }, baseState())) {
      assert.equal(
        answer.decision.allowed === false && answer.decision.denial,
        denial,
        `${denial} ${answer.surface}`,
      );
      assert.equal(
        answer.decision.allowed === false && answer.decision.code,
        "conflict",
      );
    }
  // What the caller last read matching the current state is allowed.
  for (const answer of acrossSurfaces(
    {
      observed: {
        generation: 2,
        bindingRevision: 5,
        policyRevision: "policy:7",
        configurationRevision: "cfg:3",
      },
    },
    baseState(),
  ))
    assert.equal(answer.decision.allowed, true, answer.surface);
});

test("AG-05: a connection that is not this actor's is missing on every transport, and an inactive one cannot be operated", () => {
  const foreign = baseState({
    connection: { ...connection, ownerId: "subject-2" },
  });
  for (const answer of acrossSurfaces({}, foreign))
    assert.equal(
      answer.decision.allowed === false && answer.decision.denial,
      "connection-not-owned",
      answer.surface,
    );
  const absent = baseState({ connection: undefined });
  for (const answer of acrossSurfaces({}, absent))
    assert.equal(
      answer.decision.allowed === false && answer.decision.denial,
      "connection-missing",
      answer.surface,
    );
  const inactive = baseState({
    connection: { ...connection, lifecycle: "reconnect-required" },
  });
  for (const intent of ["operate", "delegate"] as ContinuationIntent[])
    for (const answer of acrossSurfaces({ intent }, inactive))
      assert.equal(
        answer.decision.allowed === false && answer.decision.denial,
        "connection-inactive",
        `${intent} ${answer.surface}`,
      );
  // Reading its state is still allowed, which is how a person finds out.
  for (const answer of acrossSurfaces({ intent: "read" }, inactive))
    assert.equal(answer.decision.allowed, true, answer.surface);
});

test("AG-05: a stop is refused before anything is looked up, so it cannot be used to probe", () => {
  const stopped = baseState({ stoppedAt: 1, connection: undefined });
  const decision = evaluateContinuation(request("mcp"), stopped);
  assert.equal(
    decision.allowed === false && decision.denial,
    "assistant-stopped",
    "a stopped caller learns nothing about whether the connection exists",
  );
});

test("AG-05: the guard reads a stop registry and raises one connector failure for every surface", async () => {
  const stops = new DelegationStopRegistry();
  const guard = createContinuationGuard({
    stops,
    now: () => 1_760_000_000_000,
    connection: async () => connection,
  });
  for (const surface of continuationSurfaces)
    assert.equal((await guard.evaluate(request(surface))).allowed, true);

  // A session-scoped stop covers that session only.
  stops.stop(
    {
      tenantId: agentActor.tenantId,
      subjectId: agentActor.subjectId,
      sessionId: agentActor.sessionId,
    },
    1_759_000_000_000,
  );
  for (const surface of continuationSurfaces) {
    const decision = await guard.evaluate(request(surface));
    assert.equal(decision.allowed, false, surface);
    await assert.rejects(guard.assert(request(surface)), (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.code, "cancelled");
      assert.equal(error.detail, "continuation.assistant-stopped");
      return true;
    });
  }
  const otherSession = {
    ...request("mcp"),
    actor: { ...agentActor, sessionId: "session-9" },
  };
  assert.equal((await guard.evaluate(otherSession)).allowed, true);

  // A subject-scoped stop covers every session of that subject.
  stops.stop(
    { tenantId: agentActor.tenantId, subjectId: agentActor.subjectId },
    1_759_000_000_000,
  );
  assert.equal((await guard.evaluate(otherSession)).allowed, false);

  // And resuming restores every surface at once.
  stops.resume({
    tenantId: agentActor.tenantId,
    subjectId: agentActor.subjectId,
  });
  stops.resume({
    tenantId: agentActor.tenantId,
    subjectId: agentActor.subjectId,
    sessionId: agentActor.sessionId,
  });
  for (const surface of continuationSurfaces)
    assert.equal(
      (await guard.evaluate(request(surface))).allowed,
      true,
      surface,
    );
});

test("AG-05: a stop scope cannot be confused by a subject or session that contains a separator", () => {
  const stops = new DelegationStopRegistry();
  stops.stop({ tenantId: "t", subjectId: "a|b", sessionId: "c" }, 1);
  // Length-prefixed keys: "a|b"+"c" and "a"+"b|c" are different scopes.
  assert.equal(
    stops.readStop({
      tenantId: "t",
      subjectId: "a",
      sessionId: "b|c",
      actorKind: "agent",
      capabilities: ["executor"],
    }),
    undefined,
  );
  assert.equal(
    stops.readStop({
      tenantId: "t",
      subjectId: "a|b",
      sessionId: "c",
      actorKind: "agent",
      capabilities: ["executor"],
    }),
    1,
  );
});

test("AG-05: assertContinuation raises the same failure the decision names", () => {
  assert.doesNotThrow(() =>
    assertContinuation(
      request("http", { actor: fixtureActor, intent: "read" }),
      baseState(),
    ),
  );
  assert.throws(
    () =>
      assertContinuation(
        request("a2a", { intent: "delegate" }),
        baseState({ stoppedAt: 1 }),
      ),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "cancelled" &&
      error.detail === "continuation.assistant-stopped",
  );
});

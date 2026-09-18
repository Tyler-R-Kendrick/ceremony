import assert from "node:assert/strict";
import test from "node:test";
import {
  connectWidgetHandoff,
  humanHandoffPresentation,
  inputRequiredHandoff,
  issueHandoff,
  popupCompletionMessageType,
  privateCollectorHandoff,
  validatePopupCompletion,
} from "../../../src/server/connectors/auth/index.js";
import {
  humanConnectionProjection,
  agentConnectorProjection,
} from "../../../src/core/connectors/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type { HandoffRecord } from "../../../src/server/connectors/index.js";
import { fixtureActor } from "../doubles/ports.js";
import { authHarness, testConnection } from "./harness.js";

/*
 * The private handoff contract: what may be issued, what a person may see, and
 * what a browser message can and cannot do. No provider prose or model claim
 * appears anywhere in these assertions.
 */

const expectation = {
  origin: "https://app.example",
  sourceWindowId: "window-abc-123",
  correlation: "correlation-xyz-789",
};
const goodMessage = {
  type: popupCompletionMessageType,
  origin: expectation.origin,
  sourceWindowId: expectation.sourceWindowId,
  correlation: expectation.correlation,
};

test("AC-AUTH-14: a valid popup message only authorizes server verification", () => {
  const decision = validatePopupCompletion(goodMessage, expectation);
  assert.equal(decision.accepted, true);
  assert.equal(
    decision.accepted === true && decision.next,
    "verify",
    "acceptance means ask the server, never connected",
  );
});

test("AC-AUTH-14: a message from an unexpected origin, window or correlation is rejected", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ ...goodMessage, origin: "https://evil.example" }, "origin"],
    [{ ...goodMessage, origin: "null" }, "origin"],
    [{ ...goodMessage, sourceWindowId: "window-other" }, "window"],
    [{ ...goodMessage, correlation: "correlation-other" }, "correlation"],
    [{ ...goodMessage, type: "something.else" }, "type"],
    [{ origin: expectation.origin }, "shape"],
  ];
  for (const [message, reason] of cases) {
    const decision = validatePopupCompletion(message, expectation);
    assert.equal(decision.accepted, false, JSON.stringify(message));
    assert.equal(
      decision.accepted === false && decision.reason,
      reason,
      JSON.stringify(message),
    );
  }
  for (const value of [null, undefined, "string", 42, []])
    assert.equal(validatePopupCompletion(value, expectation).accepted, false);
});

test("AC-AUTH-15: closing a window or pressing Done produces no message and no completion", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
  });
  const ctx = harness.ctx();
  const issued = await issueHandoff(ctx, {
    kind: "provider-browser",
    presentation: "popup",
    expiresAt: harness.now() + 600_000,
    intent: "oauth.authorization-code",
    correlationKey: expectation.correlation,
    private: { authorizationUrl: `${harness.server.origin}/authorize` },
  });
  // Whatever the browser does locally, the stored handoff stays pending and
  // the connection is not connected until the server verifies.
  assert.equal(issued.summary.state, "issued");
  const record = harness.ports.inspect.handoffs()[0]!;
  assert.equal(record.state, "issued");
  const view = agentConnectorProjection({
    ...testConnection(),
    lifecycle: "authorization-required",
  });
  assert.equal(view.verified, false);
});

test("the public handoff summary carries no private material", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
  });
  const ctx = harness.ctx();
  const secret = "urn:widget:token:super-secret";
  const issued = await issueHandoff(
    ctx,
    connectWidgetHandoff({
      connectLink: "https://broker.example/connect/abc",
      token: secret,
      expiresAt: harness.now() + 300_000,
    }),
  );
  const serialized = JSON.stringify(issued.summary);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("broker.example"), false);
  assert.deepEqual(Object.keys(issued.summary).sort(), [
    "expiresAt",
    "generation",
    "handoffRef",
    "kind",
    "presentation",
    "state",
  ]);
});

test("the human presentation shows only a safe URL or user code", async (t) => {
  const base: Omit<HandoffRecord, "kind" | "private"> = {
    handoffRef: "handoff:1",
    tenantId: fixtureActor.tenantId,
    subjectId: fixtureActor.subjectId,
    sessionId: fixtureActor.sessionId,
    connectionRef: "connection:oauth-1",
    bindingRef: "binding:oauth-1",
    generation: 0,
    presentation: "popup",
    expiresAt: 2_000,
    intent: "oauth.authorization-code",
    state: "issued",
    issuedAt: 0,
  };
  const browser = humanHandoffPresentation(
    {
      ...base,
      kind: "provider-browser",
      private: {
        authorizationUrl: "https://as.example/authorize?state=abc",
        state: "abc",
        verifier: "the-verifier",
      },
    },
    1_000,
  );
  assert.equal(browser.url, "https://as.example/authorize?state=abc");
  assert.equal(JSON.stringify(browser).includes("the-verifier"), false);

  const widget = humanHandoffPresentation(
    {
      ...base,
      kind: "connect-widget",
      private: {
        connectLink: "https://broker.example/c/1",
        token: "widget-token",
      },
    },
    1_000,
  );
  assert.equal(widget.url, "https://broker.example/c/1");
  assert.equal(JSON.stringify(widget).includes("widget-token"), false);

  // A completed or expired handoff presents nothing at all.
  assert.deepEqual(
    humanHandoffPresentation(
      {
        ...base,
        state: "completed",
        kind: "provider-browser",
        private: { authorizationUrl: "https://as.example/a" },
      },
      1_000,
    ),
    {},
  );
  assert.deepEqual(
    humanHandoffPresentation(
      {
        ...base,
        kind: "provider-browser",
        private: { authorizationUrl: "https://as.example/a" },
      },
      3_000,
    ),
    {},
  );
});

test("an unsafe presentation URL is refused rather than shown", () => {
  assert.throws(
    () =>
      humanHandoffPresentation(
        {
          kind: "provider-browser",
          state: "issued",
          expiresAt: 2_000,
          private: { authorizationUrl: "javascript:alert(1)" },
        },
        1_000,
      ),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "oauth.handoff.unsafe-url",
  );
});

test("the human projection is the only one that may carry a URL or code", () => {
  const summary = testConnection();
  const human = humanConnectionProjection(summary, {
    url: "https://as.example/authorize",
    userCode: "ABCD-1234",
  });
  assert.equal(human.presentation?.url, "https://as.example/authorize");
  assert.equal(human.presentation?.userCode, "ABCD-1234");
  const agent = agentConnectorProjection(summary);
  const serialized = JSON.stringify(agent);
  assert.equal(serialized.includes("ABCD-1234"), false);
  assert.equal(serialized.includes("as.example"), false);
});

test("handoff proposals reject bad expiry, intent and oversized private material", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
  });
  const ctx = harness.ctx();
  await assert.rejects(
    issueHandoff(ctx, {
      kind: "provider-browser",
      presentation: "popup",
      expiresAt: harness.now() - 1,
      intent: "oauth.authorization-code",
      private: {},
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "oauth.handoff.expiry",
  );
  await assert.rejects(
    issueHandoff(ctx, {
      kind: "provider-browser",
      presentation: "popup",
      expiresAt: harness.now() + 1000,
      intent: "Not A Code",
      private: {},
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "oauth.handoff.intent",
  );
  await assert.rejects(
    issueHandoff(ctx, {
      kind: "provider-browser",
      presentation: "popup",
      expiresAt: harness.now() + 1000,
      intent: "oauth.authorization-code",
      private: { huge: "x".repeat(20_000) },
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "oauth.handoff.private-shape",
  );
});

test("collector and input-required handoffs keep their references private", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
  });
  const ctx = harness.ctx();
  const collector = await issueHandoff(
    ctx,
    privateCollectorHandoff({
      collectorRef: "collector:secret-ref",
      expiresAt: harness.now() + 60_000,
    }),
  );
  assert.equal(collector.summary.kind, "private-collector");
  assert.equal(
    JSON.stringify(collector.summary).includes("secret-ref"),
    false,
  );
  const input = await issueHandoff(
    ctx,
    inputRequiredHandoff({
      expiresAt: harness.now() + 60_000,
      continuationToken: "continue-token",
      fields: ["verificationCode"],
    }),
  );
  assert.equal(input.summary.kind, "input-required");
  assert.equal(
    JSON.stringify(input.summary).includes("continue-token"),
    false,
  );
  const record = harness.ports.inspect
    .handoffs()
    .find((item) => item.handoffRef === input.handoffRef)!;
  assert.equal(record.private["continuationToken"], "continue-token");
});

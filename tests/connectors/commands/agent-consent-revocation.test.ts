import assert from "node:assert/strict";
import { test } from "node:test";
import type { ActorContext } from "../../../src/core/operation-contracts.js";
import {
  agent,
  completeOauthCallback,
  createHarness,
  delegate,
  FIXTURE_DOCUMENT,
  human,
  type Harness,
} from "./harness.js";

/*
 * Two decisions only a person makes: that an assistant may read personal
 * output of a binding (given at binding approval), and that a connection's
 * access is revoked upstream (an administrator's `revoke`). An assistant can
 * ask for the second and can never give itself the first.
 */

const SESSION = "human-session";

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function bind(
  harness: Harness,
  session: string,
  approvals: Record<string, unknown> = {},
  importSession = session,
) {
  const imported = await json(
    await harness.fetch("/api/v1/connectors/import", {
      body: {
        kind: "upload",
        mediaType: "application/json",
        text: FIXTURE_DOCUMENT(harness.provider.origin),
      },
      session: importSession,
    }),
  );
  return harness.fetch("/api/v1/connectors/bindings", {
    body: {
      definitionRef: (imported.definitions as string[])[0]!,
      adapterId: "fixture-http",
      approvals: {
        destinations: [harness.provider.origin],
        // listItems is a read; reviewed here as personal output.
        operations: [
          { nativeId: "listItems", outputClassification: "personal" },
        ],
        profileId: "oauth",
        ...approvals,
      },
    },
    session,
  });
}

async function activeConnection(
  harness: Harness,
  owner: ActorContext,
  approvals: Record<string, unknown> = {},
) {
  harness.register(SESSION, owner);
  const binding = await json(await bind(harness, SESSION, approvals));
  const bindingRef = binding.bindingRef as string;
  const connected = await json(
    await harness.fetch("/api/v1/connectors/connections", {
      body: {
        bindingRef,
        intent: { profileId: "oauth", requestedPermissions: ["read"] },
      },
      session: SESSION,
    }),
  );
  const presentation = connected.presentation as { url: string };
  assert.equal(
    (await completeOauthCallback(harness, SESSION, presentation.url)).status,
    303,
  );
  const listItems = harness.definitions
    .bindings()
    .find((item) => item.bindingRef === bindingRef)!
    .operations.find((item) => item.nativeId === "listItems")!.operationRef;
  return {
    bindingRef,
    connectionRef: connected.connectionRef as string,
    listItems,
  };
}

async function invokeAs(
  harness: Harness,
  session: string,
  connectionRef: string,
  operationRef: string,
  commandId: string,
) {
  return harness.fetch(
    `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/invoke`,
    { body: { operationRef, input: {}, commandId }, session },
  );
}

test("personal output reaches an assistant only under the binding's owner consent", async (t) => {
  const harness = await createHarness();
  const second = await createHarness();
  t.after(() => harness.close());
  t.after(() => second.close());
  const model = agent();
  for (const each of [harness, second]) {
    await delegate(each.store, model);
    each.register("agent", model);
  }

  const withheld = await activeConnection(harness, human());
  const refused = await invokeAs(
    harness,
    "agent",
    withheld.connectionRef,
    withheld.listItems,
    "cmd-1",
  );
  assert.equal(refused.status, 403);
  assert.equal((await json(refused)).detail, "output.classification");

  const consented = await activeConnection(second, human(), {
    agentOutputConsent: "personal",
  });
  const released = await json(
    await invokeAs(
      second,
      "agent",
      consented.connectionRef,
      consented.listItems,
      "cmd-2",
    ),
  );
  assert.equal(released.state, "complete");
  assert.equal(released.outputClassification, "personal");
  assert.equal(released.agentOutputConsent, "personal");
  assert.ok(released.output);
});

test("an assistant cannot give itself output consent at binding approval", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const reviewerAgent = agent({ capabilities: ["executor", "reviewer"] });
  await delegate(harness.store, reviewerAgent);
  harness.register("agent-reviewer", reviewerAgent);
  harness.register(SESSION, human());
  const response = await bind(
    harness,
    "agent-reviewer",
    { agentOutputConsent: "personal" },
    SESSION,
  );
  assert.equal(response.status, 403);
  assert.equal((await json(response)).detail, "consent.human-only");
  assert.equal(
    harness.definitions.bindings().some((item) => item.agentOutputConsent),
    false,
  );
});

test("an assistant can request revocation but only a person decides it", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const owner = human({ capabilities: ["executor", "reviewer", "admin"] });
  const { connectionRef } = await activeConnection(harness, owner);
  const model = agent();
  await delegate(harness.store, model);
  harness.register("agent", model);
  const path = `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}`;

  const direct = await harness.fetch(`${path}/revoke`, {
    body: { expectedRevision: 1 },
    session: "agent",
  });
  assert.equal(direct.status, 403, "an assistant never revokes directly");

  const requested = await json(
    await harness.fetch(`${path}/revoke-request`, {
      body: {},
      session: "agent",
    }),
  );
  assert.equal(requested.revocation, "pending-approval");
  const again = await json(
    await harness.fetch(`${path}/revoke-request`, {
      body: {},
      session: "agent",
    }),
  );
  assert.equal(again.requestedAt, requested.requestedAt);

  const status = await json(await harness.fetch(path, { session: SESSION }));
  assert.equal(status.lifecycle, "active", "a request revokes nothing");
  assert.equal(status.lastOutcome, "revoke.requested");
  assert.equal(harness.provider.received("POST", "/revoke").length, 0);

  const declinedByAgent = await harness.fetch(`${path}/revoke-decline`, {
    body: { expectedRevision: status.revision },
    session: "agent",
  });
  assert.equal(declinedByAgent.status, 403);

  const revoked = await json(
    await harness.fetch(`${path}/revoke`, {
      body: { expectedRevision: status.revision },
      session: SESSION,
    }),
  );
  assert.equal(
    (revoked.result as { local: string }).local,
    "applied",
    "the administrator's revoke is the approval",
  );
});

test("a person can decline a pending revocation request", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const owner = human({ capabilities: ["executor", "reviewer", "admin"] });
  const { connectionRef } = await activeConnection(harness, owner);
  const path = `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}`;
  const missing = await harness.fetch(`${path}/revoke-decline`, {
    body: { expectedRevision: 1 },
    session: SESSION,
  });
  assert.equal(missing.status, 409);
  await harness.fetch(`${path}/revoke-request`, { body: {}, session: SESSION });
  const status = await json(await harness.fetch(path, { session: SESSION }));
  const declined = await json(
    await harness.fetch(`${path}/revoke-decline`, {
      body: { expectedRevision: status.revision },
      session: SESSION,
    }),
  );
  assert.equal(declined.lastOutcome, "revoke.declined");
  assert.equal(declined.lifecycle, "active");
});

test("declining a revocation request is an administrator's decision, under policy, on an open connection", async (t) => {
  let refuse = false;
  const harness = await createHarness({
    policy: (base) => ({
      ...base,
      authorize: (actor, subject, action) =>
        refuse && action === "revoke"
          ? false
          : base.authorize(actor, subject, action),
    }),
  });
  t.after(() => harness.close());
  const admin = human({ capabilities: ["executor", "reviewer", "admin"] });
  const { connectionRef } = await activeConnection(harness, admin);
  const path = `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}`;
  await harness.fetch(`${path}/revoke-request`, { body: {}, session: SESSION });
  const status = await json(await harness.fetch(path, { session: SESSION }));
  const decline = (session: string, revision = status.revision) =>
    harness.fetch(`${path}/revoke-decline`, {
      body: { expectedRevision: revision },
      session,
    });

  // The same person without administration can read the connection, and
  // still cannot clear the request before an administrator sees it.
  harness.register("member", human({ capabilities: ["executor"] }));
  assert.equal((await decline("member")).status, 403);
  // Nor can an administrator the host's policy refuses.
  refuse = true;
  assert.equal((await decline(SESSION)).status, 403);
  refuse = false;
  const pending = await json(await harness.fetch(path, { session: SESSION }));
  assert.equal(pending.lastOutcome, "revoke.requested");

  // A closed connection has nothing left to decline.
  const disconnected = await json(
    await harness.fetch(`${path}/disconnect`, {
      body: { expectedRevision: pending.revision, scope: "local" },
      session: SESSION,
    }),
  );
  const closed = await decline(
    SESSION,
    (disconnected.connection as { revision: number }).revision,
  );
  assert.equal(closed.status, 409);
});

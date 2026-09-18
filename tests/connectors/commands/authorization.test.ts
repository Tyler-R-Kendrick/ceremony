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
  ORIGIN,
  TENANT,
  type Harness,
} from "./harness.js";

/*
 * The adversarial half: forged identity fields, another subject's records,
 * stale revisions, a model claiming authority it does not have, shared-key
 * mode without privilege, a prohibited interruption, a replayed or
 * cross-session callback, an unapproved operation or target, and output a
 * model may not see. Each one asserts what the server did, not what the
 * request asked for.
 */

const SESSION = "human-session";

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function setup(
  harness: Harness,
  actor: ActorContext,
  session = SESSION,
  approvals: Record<string, unknown> = {},
) {
  harness.register(session, actor);
  const imported = await json(
    await harness.fetch("/api/v1/connectors/import", {
      body: {
        kind: "upload",
        mediaType: "application/json",
        text: FIXTURE_DOCUMENT(harness.provider.origin),
      },
      session,
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
          permittedTargets: [{ kind: "account", id: "acct-primary" }],
          ...approvals,
        },
      },
      session,
    }),
  );
  return { definitionRef, bindingRef: binding.bindingRef as string };
}

function operationRef(
  harness: Harness,
  bindingRef: string,
  nativeId: string,
): string {
  const binding = harness.definitions
    .bindings()
    .filter((item) => item.bindingRef === bindingRef)
    .sort((a, b) => a.revision - b.revision)
    .at(-1);
  const operation = binding?.operations.find(
    (item) => item.nativeId === nativeId,
  );
  if (!operation) throw new Error(`no approved operation ${nativeId}`);
  return operation.operationRef;
}

async function activeConnection(
  harness: Harness,
  actor: ActorContext,
  session = SESSION,
  approvals: Record<string, unknown> = {},
) {
  const { bindingRef } = await setup(harness, actor, session, approvals);
  const connected = await json(
    await harness.fetch("/api/v1/connectors/connections", {
      body: {
        bindingRef,
        intent: {
          profileId: "oauth",
          requestedPermissions: ["read", "write"],
        },
      },
      session,
    }),
  );
  const presentation = connected.presentation as { url: string };
  const callback = await completeOauthCallback(
    harness,
    session,
    presentation.url,
  );
  assert.equal(callback.status, 303);
  const status = await json(
    await harness.fetch(
      `/api/v1/connectors/connections/${encodeURIComponent(
        connected.connectionRef as string,
      )}`,
      { session },
    ),
  );
  assert.equal(status.lifecycle, "active");
  return {
    bindingRef,
    connectionRef: connected.connectionRef as string,
    status,
  };
}

test("AC-AUTH-01: a forged tenant, subject or session in a body grants nothing", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const actor = human();
  const { bindingRef } = await setup(harness, actor);

  const forged = await harness.fetch("/api/v1/connectors/connections", {
    body: {
      bindingRef,
      tenantId: "tenant-b",
      subjectId: "subject-victim",
      sessionId: "session-victim",
      capabilities: ["admin"],
      intent: { profileId: "oauth", requestedPermissions: ["read"] },
    },
    session: SESSION,
  });
  assert.equal(
    forged.status,
    400,
    "an unknown identity field is an invalid request, never an accepted one",
  );
  assert.equal((await json(forged)).error, "invalid-request");

  const accepted = await json(
    await harness.fetch("/api/v1/connectors/connections", {
      body: {
        bindingRef,
        intent: { profileId: "oauth", requestedPermissions: ["read"] },
      },
      session: SESSION,
    }),
  );
  const stored = harness.ports.inspect
    .connections()
    .find((entry) => entry.record.connectionRef === accepted.connectionRef);
  assert.equal(stored?.record.tenantId, TENANT);
  assert.equal(
    stored?.record.ownerId,
    actor.subjectId,
    "the owner comes from host authentication",
  );
  assert.equal(stored?.record.sessionId, actor.sessionId);
});

test("another subject's connection is not found, not denied", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const owner = human();
  const { connectionRef } = await activeConnection(harness, owner);

  const stranger = human({ subjectId: "subject-2", sessionId: "session-2" });
  harness.register("stranger", stranger);
  const probe = await harness.fetch(
    `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}`,
    { session: "stranger" },
  );
  assert.equal(probe.status, 404, "a foreign record leaks no existence");
  assert.equal((await json(probe)).error, "not-found");

  const missing = await harness.fetch(
    "/api/v1/connectors/connections/connection:does-not-exist",
    { session: "stranger" },
  );
  assert.equal(
    missing.status,
    404,
    "and a missing record answers identically",
  );
});

test("a stale expected revision conflicts instead of acting", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const actor = human();
  const { connectionRef, status } = await activeConnection(harness, actor);

  const stale = await harness.fetch(
    `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/disconnect`,
    {
      body: { expectedRevision: (status.revision as number) - 1, scope: "local" },
      session: SESSION,
    },
  );
  assert.equal(stale.status, 409);
  assert.equal((await json(stale)).error, "conflict");
  const after = await json(
    await harness.fetch(
      `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}`,
      { session: SESSION },
    ),
  );
  assert.equal(after.lifecycle, "active", "and the connection is untouched");
});

test("AC-AUTH-13: a model actor cannot set verified, approve, or switch account", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const owner = human();
  const { connectionRef, bindingRef, status } = await activeConnection(
    harness,
    owner,
  );
  const model = agent();
  await delegate(harness.store, model);
  harness.register("agent", model);

  // Claiming verification is not an operation at all: there is no route, no
  // field and no argument that sets it.
  const forged = await harness.fetch("/api/v1/connectors/connections", {
    body: {
      bindingRef,
      verified: true,
      lifecycle: "active",
      verification: { kinds: ["account-identity"] },
      intent: { profileId: "oauth", requestedPermissions: ["read"] },
    },
    session: "agent",
  });
  assert.equal(forged.status, 400);

  const switching = await harness.fetch(
    `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/reconnect`,
    {
      body: { expectedRevision: status.revision, accountSwitch: true },
      session: "agent",
    },
  );
  assert.equal(
    switching.status,
    403,
    "an account switch is an explicit human intent",
  );
  assert.equal((await json(switching)).detail, "account-switch.human-only");

  const approving = await harness.fetch("/api/v1/connectors/bindings", {
    body: {
      definitionRef: "definition:anything",
      adapterId: "fixture-http",
      approvals: { destinations: [], operations: [] },
    },
    session: "agent",
  });
  assert.equal(
    approving.status,
    403,
    "and approving a binding needs a reviewer capability the model lacks",
  );

  const after = await json(
    await harness.fetch(
      `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}`,
      { session: SESSION },
    ),
  );
  assert.equal(after.revision, status.revision, "nothing changed");
});

test("AC-AUTH-12: shared-key mode without ownership privilege is denied by the server", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const actor = human({ capabilities: ["executor", "author", "reviewer"] });
  const { bindingRef } = await setup(harness, actor);

  const shared = await harness.fetch("/api/v1/connectors/connections", {
    body: {
      bindingRef,
      ownerKind: "organization",
      intent: { profileId: "oauth", requestedPermissions: ["read"] },
    },
    session: SESSION,
  });
  assert.equal(shared.status, 403);
  assert.equal((await json(shared)).detail, "owner.kind");
  assert.equal(
    harness.ports.inspect.connections().length,
    0,
    "a radio button cannot create an organization-owned grant",
  );

  const publisher = human({
    subjectId: "subject-owner",
    sessionId: "session-owner",
    capabilities: ["executor", "author", "reviewer", "publisher"],
  });
  harness.register("publisher", publisher);
  const { bindingRef: ownerBinding } = await setup(
    harness,
    publisher,
    "publisher",
  );
  const allowed = await harness.fetch("/api/v1/connectors/connections", {
    body: {
      bindingRef: ownerBinding,
      ownerKind: "organization",
      intent: { profileId: "oauth", requestedPermissions: ["read"] },
    },
    session: "publisher",
  });
  assert.equal(
    allowed.status,
    201,
    "the same request from a privileged owner is allowed",
  );
});

test("AC-AUTH-16: prohibited interruption yields human-required, never a bypass", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const actor = human();
  const { bindingRef } = await setup(harness, actor);

  const connected = await json(
    await harness.fetch("/api/v1/connectors/connections", {
      body: {
        bindingRef,
        intent: {
          profileId: "oauth",
          requestedPermissions: ["read"],
          interruption: "none",
        },
      },
      session: SESSION,
    }),
  );
  assert.equal(connected.lifecycle, "human-required");
  assert.equal(connected.lastOutcome, "interruption.required");
  assert.equal(
    connected.handoff,
    undefined,
    "no handoff was issued at all, so nothing can be completed behind the person",
  );
  assert.equal(
    connected.presentation,
    undefined,
    "and no provider URL was produced",
  );
  assert.equal(
    harness.provider.received("GET", "/oauth/authorize").length,
    0,
    "the provider was never contacted",
  );
  assert.equal(harness.ports.inspect.handoffs().length, 0);
});

test("AC-AUTH-07: a callback is refused from another session, after a generation change, and after disconnect", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const actor = human();
  const { bindingRef } = await setup(harness, actor);

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
  const authorizationUrl = (connected.presentation as { url: string }).url;
  const redirect = await fetch(authorizationUrl, { redirect: "manual" });
  const location = new URL(redirect.headers.get("location")!);
  await redirect.body?.cancel().catch(() => {});
  const callbackPath = `${location.pathname}${location.search}`;

  const otherSession = human({
    subjectId: "subject-other",
    sessionId: "session-other",
  });
  harness.register("other", otherSession);
  const foreign = await harness.fetch(callbackPath, { session: "other" });
  assert.equal(foreign.status, 303);
  assert.equal(
    new URL(foreign.headers.get("location")!).searchParams.get("outcome"),
    "denied",
    "another subject in the same tenant is refused as the recipient",
  );

  const sameSubjectOtherSession = human({ sessionId: "session-elsewhere" });
  harness.register("elsewhere", sameSubjectOtherSession);
  const wrongSession = await harness.fetch(callbackPath, {
    session: "elsewhere",
  });
  assert.equal(
    new URL(wrongSession.headers.get("location")!).searchParams.get("outcome"),
    "denied",
    "the recipient must be the initiating session",
  );

  const before = await json(
    await harness.fetch(
      `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}`,
      { session: SESSION },
    ),
  );
  assert.equal(before.lifecycle, "authorization-required");

  // Disconnect, then deliver the callback the provider issued earlier.
  const disconnected = await harness.fetch(
    `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/disconnect`,
    {
      body: { expectedRevision: before.revision, scope: "local" },
      session: SESSION,
    },
  );
  assert.equal(disconnected.status, 200);
  const late = await harness.fetch(callbackPath, { session: SESSION });
  const outcome = new URL(late.headers.get("location")!).searchParams.get(
    "outcome",
  );
  assert.ok(
    ["conflict", "denied", "expired", "not-found"].includes(outcome ?? ""),
    `a delayed callback cannot reactivate a disconnected connection (got ${outcome})`,
  );
  const after = await json(
    await harness.fetch(
      `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}`,
      { session: SESSION },
    ),
  );
  assert.equal(after.lifecycle, "locally-disconnected");
  assert.equal(after.verification, undefined);
});

test("a callback code is one-use: a replay changes nothing", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const actor = human();
  const { bindingRef } = await setup(harness, actor);
  const connected = await json(
    await harness.fetch("/api/v1/connectors/connections", {
      body: {
        bindingRef,
        intent: { profileId: "oauth", requestedPermissions: ["read"] },
      },
      session: SESSION,
    }),
  );
  const redirect = await fetch((connected.presentation as { url: string }).url, {
    redirect: "manual",
  });
  const location = new URL(redirect.headers.get("location")!);
  await redirect.body?.cancel().catch(() => {});
  const callbackPath = `${location.pathname}${location.search}`;

  const first = await harness.fetch(callbackPath, { session: SESSION });
  assert.equal(
    new URL(first.headers.get("location")!).searchParams.get("outcome"),
    "active",
  );
  const state = await json(
    await harness.fetch(
      `/api/v1/connectors/connections/${encodeURIComponent(
        connected.connectionRef as string,
      )}`,
      { session: SESSION },
    ),
  );

  const replay = await harness.fetch(callbackPath, { session: SESSION });
  const outcome = new URL(replay.headers.get("location")!).searchParams.get(
    "outcome",
  );
  assert.ok(
    outcome === "conflict" || outcome === "expired",
    `the second delivery is refused (got ${outcome})`,
  );
  assert.equal(
    harness.provider.received("POST", "/oauth/token").length,
    1,
    "and the authorization code was exchanged exactly once",
  );
  const unchanged = await json(
    await harness.fetch(
      `/api/v1/connectors/connections/${encodeURIComponent(
        connected.connectionRef as string,
      )}`,
      { session: SESSION },
    ),
  );
  assert.equal(unchanged.revision, state.revision);
});

test("invoke refuses an unapproved operation and an unpermitted target", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const actor = human();
  const { connectionRef, bindingRef } = await activeConnection(
    harness,
    actor,
    SESSION,
    {
      operations: [
        { nativeId: "listItems", targetParameters: ["project"], consent: "none" },
      ],
      permittedTargets: [{ kind: "project", id: "alpha" }],
    },
  );

  const unapproved = await harness.fetch(
    `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/invoke`,
    {
      body: {
        operationRef: "operation:not-in-this-binding",
        input: {},
        commandId: "cmd-1",
      },
      session: SESSION,
    },
  );
  assert.equal(unapproved.status, 403);
  assert.equal((await json(unapproved)).detail, "operation.unapproved");

  const listItems = operationRef(harness, bindingRef, "listItems");
  const forbiddenTarget = await harness.fetch(
    `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/invoke`,
    {
      body: {
        operationRef: listItems,
        input: { project: "beta" },
        commandId: "cmd-2",
      },
      session: SESSION,
    },
  );
  assert.equal(forbiddenTarget.status, 403);
  assert.equal((await json(forbiddenTarget)).detail, "target.not-permitted");
  assert.equal(
    harness.provider.received("GET", "/v1/items").length,
    0,
    "no request reached the provider before the target check",
  );

  const permitted = await harness.fetch(
    `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/invoke`,
    {
      body: {
        operationRef: listItems,
        input: { project: "alpha" },
        commandId: "cmd-3",
      },
      session: SESSION,
    },
  );
  assert.equal((await json(permitted)).state, "complete");
});

test("an agent never receives personal or secret output unless policy allows it", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const owner = human();
  const { connectionRef, bindingRef } = await activeConnection(harness, owner);
  const model = agent();
  await delegate(harness.store, model);
  harness.register("agent", model);

  const createItem = operationRef(harness, bindingRef, "createItem");
  const refused = await harness.fetch(
    `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/invoke`,
    {
      body: {
        operationRef: createItem,
        input: { name: "agent-item" },
        commandId: "cmd-agent-1",
      },
      session: "agent",
    },
  );
  assert.equal(
    refused.status,
    403,
    "a personal-classified operation is refused for a model before it runs",
  );
  const withheld = await json(refused);
  assert.equal(withheld.error, "denied");
  assert.equal(withheld.detail, "output.classification");
  assert.equal(
    harness.provider.received("POST", "/v1/items").length,
    0,
    "and nothing was written upstream",
  );

  const listItems = operationRef(harness, bindingRef, "listItems");
  const allowed = await json(
    await harness.fetch(
      `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/invoke`,
      {
        body: { operationRef: listItems, input: {}, commandId: "cmd-agent-2" },
        session: "agent",
      },
    ),
  );
  assert.equal(allowed.state, "complete");
  assert.equal(allowed.outputClassification, "public");
  assert.ok(allowed.output, "public output is returned");
});

test("an agent status response carries no presentation material", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const owner = human();
  const { bindingRef } = await setup(harness, owner);
  const connected = await json(
    await harness.fetch("/api/v1/connectors/connections", {
      body: {
        bindingRef,
        intent: { profileId: "oauth", requestedPermissions: ["read"] },
      },
      session: SESSION,
    }),
  );
  assert.ok((connected.presentation as { url: string }).url);

  const model = agent();
  await delegate(harness.store, model);
  harness.register("agent", model);
  const seen = await json(
    await harness.fetch(
      `/api/v1/connectors/connections/${encodeURIComponent(
        connected.connectionRef as string,
      )}`,
      { session: "agent" },
    ),
  );
  assert.equal(seen.presentation, undefined);
  assert.deepEqual(
    seen.handoff,
    { kind: "provider-browser", state: "issued" },
    "a model learns that a person is needed, and nothing it could navigate to",
  );
  assert.equal(seen.displayName, undefined);
  assert.equal(seen.target, undefined);
  assert.ok(
    !JSON.stringify(seen).includes(harness.provider.origin),
    "the provider URL never appears in an agent projection",
  );
});

test("AC-AG-04: a stopped delegation is denied identically through HTTP and a direct call", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const owner = human();
  const { connectionRef, bindingRef } = await activeConnection(harness, owner);
  const model = agent();
  await delegate(harness.store, model);
  harness.register("agent", model);
  const listItems = operationRef(harness, bindingRef, "listItems");

  const running = await json(
    await harness.fetch(
      `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/invoke`,
      {
        body: { operationRef: listItems, input: {}, commandId: "cmd-live" },
        session: "agent",
      },
    ),
  );
  assert.equal(running.state, "complete", "a live delegation works");

  await delegate(harness.store, model, { stopped: true });

  const overHttp = await harness.fetch(
    `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/invoke`,
    {
      body: { operationRef: listItems, input: {}, commandId: "cmd-stopped-1" },
      session: "agent",
    },
  );
  assert.equal(overHttp.status, 403);
  const httpBody = await json(overHttp);

  const direct = await harness.service
    .invoke(model, connectionRef, {
      operationRef: listItems,
      input: {},
      commandId: "cmd-stopped-2",
    })
    .then(
      () => undefined,
      (error: unknown) => error as { code?: string; detail?: string },
    );
  assert.ok(direct, "the direct service call is refused too");
  assert.equal(
    direct.code,
    httpBody.error,
    "both transports report the same denial",
  );
  assert.equal(direct.detail, httpBody.detail);
  assert.equal(
    harness.provider.received("GET", "/v1/items").length,
    1,
    "only the pre-stop call reached the provider",
  );
});

test("mutations require the same-origin boundary", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const actor = human();
  const { bindingRef } = await setup(harness, actor);

  const crossOrigin = await harness.fetch("/api/v1/connectors/connections", {
    body: { bindingRef, intent: { requestedPermissions: [] } },
    session: SESSION,
    origin: "https://evil.example",
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await json(crossOrigin)).error, "denied");

  const noContentType = await harness.fetch("/api/v1/connectors/connections", {
    body: { bindingRef, intent: { requestedPermissions: [] } },
    session: SESSION,
    headers: { "content-type": "text/plain" },
  });
  assert.equal(noContentType.status, 400);
  assert.equal(harness.ports.inspect.connections().length, 0);
});

test("the callback return path is never taken from input", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const actor = human();
  harness.register(SESSION, actor);
  const hostile = await harness.fetch(
    "/api/v1/connectors/callback?state=unknown-state&redirect_uri=https%3A%2F%2Fevil.example%2Fsteal&return_to=%2F%2Fevil.example",
    { session: SESSION },
  );
  assert.equal(hostile.status, 303);
  const location = new URL(hostile.headers.get("location")!);
  assert.equal(location.origin, ORIGIN);
  assert.equal(location.pathname, "/connectors");
  assert.equal(location.searchParams.get("outcome"), "not-found");
  assert.equal(
    location.searchParams.get("redirect_uri"),
    null,
    "nothing from the query is copied into the return route",
  );
});

test("configuration drift blocks use until the connection is re-established", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const actor = human();
  const { connectionRef, bindingRef } = await activeConnection(harness, actor);
  const listItems = operationRef(harness, bindingRef, "listItems");

  harness.setConfiguration(actor, "FIXTURE_TOKEN", "changed");

  const blocked = await harness.fetch(
    `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/invoke`,
    {
      body: { operationRef: listItems, input: {}, commandId: "cmd-drift" },
      session: SESSION,
    },
  );
  assert.equal(blocked.status, 409);
  assert.equal((await json(blocked)).detail, "configuration.changed");
  const after = await json(
    await harness.fetch(
      `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}`,
      { session: SESSION },
    ),
  );
  assert.equal(
    after.lifecycle,
    "reconnect-required",
    "a stale 'connected' state does not survive a configuration change",
  );
  assert.equal(
    harness.provider.received("GET", "/v1/items").length,
    0,
    "and no call was made with evidence bound to the old configuration",
  );
});

test("AC-AUTH-09: reconnect returning a different account requires explicit intent", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const actor = human();
  const { connectionRef, status } = await activeConnection(harness, actor);
  assert.deepEqual(status.target, { kind: "account", id: "acct-primary" });

  // The provider now authorizes a different account.
  harness.provider.state.account = "acct-secondary";

  const reconnected = await json(
    await harness.fetch(
      `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/reconnect`,
      {
        body: { expectedRevision: status.revision, accountSwitch: false },
        session: SESSION,
      },
    ),
  );
  const callback = await completeOauthCallback(
    harness,
    SESSION,
    (reconnected.presentation as { url: string }).url,
  );
  assert.equal(
    new URL(callback.headers.get("location")!).searchParams.get("outcome"),
    "reconnect-required",
  );
  const after = await json(
    await harness.fetch(
      `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}`,
      { session: SESSION },
    ),
  );
  assert.equal(after.lastOutcome, "verification.account-changed");
  assert.deepEqual(
    after.target,
    { kind: "account", id: "acct-primary" },
    "the verified account is never silently replaced",
  );

  const switched = await json(
    await harness.fetch(
      `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/reconnect`,
      {
        body: { expectedRevision: after.revision, accountSwitch: true },
        session: SESSION,
      },
    ),
  );
  await completeOauthCallback(
    harness,
    SESSION,
    (switched.presentation as { url: string }).url,
  );
  const final = await json(
    await harness.fetch(
      `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}`,
      { session: SESSION },
    ),
  );
  assert.equal(final.lifecycle, "active");
  assert.deepEqual(
    final.target,
    { kind: "account", id: "acct-secondary" },
    "an explicit switch is honoured",
  );
});

test("AC-STATE-03: broker and upstream disconnect are distinct authorized intents", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const actor = human();
  const { connectionRef, status } = await activeConnection(harness, actor);

  const broker = await json(
    await harness.fetch(
      `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/disconnect`,
      {
        body: { expectedRevision: status.revision, scope: "broker" },
        session: SESSION,
      },
    ),
  );
  assert.deepEqual(broker.result, {
    local: "applied",
    broker: "unsupported",
    upstream: "not-attempted",
  });
  assert.equal(
    harness.provider.received("POST", "/v1/revoke").length,
    0,
    "an unsupported broker deletion is reported, never simulated",
  );
});

test("an upstream disconnect actually revokes, and is refused to a model", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const actor = human();
  const { connectionRef, status } = await activeConnection(harness, actor);

  const model = agent();
  await delegate(harness.store, model);
  harness.register("agent", model);
  const refused = await harness.fetch(
    `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/disconnect`,
    {
      body: { expectedRevision: status.revision, scope: "upstream" },
      session: "agent",
    },
  );
  assert.equal(refused.status, 403);
  assert.equal(harness.provider.received("POST", "/v1/revoke").length, 0);

  const applied = await json(
    await harness.fetch(
      `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/disconnect`,
      {
        body: { expectedRevision: status.revision, scope: "upstream" },
        session: SESSION,
      },
    ),
  );
  assert.equal(
    (applied.result as Record<string, string>).upstream,
    "applied",
  );
  assert.equal(harness.provider.received("POST", "/v1/revoke").length, 1);
  assert.equal(
    (applied.connection as Record<string, unknown>).lifecycle,
    "upstream-revoked",
  );
});

test("administrative revoke and delete are separated and admin-gated", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const actor = human();
  const { connectionRef, status } = await activeConnection(harness, actor);

  const nonAdmin = await harness.fetch(
    `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/revoke`,
    { body: { expectedRevision: status.revision }, session: SESSION },
  );
  assert.equal(nonAdmin.status, 403);

  const admin = human({ capabilities: ["executor", "admin"] });
  harness.register("admin", admin);
  const revoked = await json(
    await harness.fetch(
      `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/revoke`,
      { body: { expectedRevision: status.revision }, session: "admin" },
    ),
  );
  assert.equal((revoked.result as Record<string, string>).upstream, "applied");

  const connection = revoked.connection as Record<string, unknown>;
  const removed = await harness.fetch(
    `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/delete`,
    {
      body: { expectedRevision: connection.revision },
      session: "admin",
    },
  );
  assert.equal(removed.status, 200);
  assert.deepEqual(await json(removed), { deleted: true });
  const gone = await harness.fetch(
    `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}`,
    { session: "admin" },
  );
  assert.equal(gone.status, 404);
});

test("AC-UX-02: a retained drawer option is enforced by the server, not decoration", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const actor = human();
  const { bindingRef } = await setup(harness, actor);

  // Interruption policy, shared mode and target are the three drawer options
  // the browser retains; each one changes what the server actually does.
  const noInterruption = await json(
    await harness.fetch("/api/v1/connectors/connections", {
      body: {
        bindingRef,
        intent: { profileId: "oauth", requestedPermissions: [], interruption: "none" },
      },
      session: SESSION,
    }),
  );
  assert.equal(noInterruption.lifecycle, "human-required");

  const disallowedTarget = await harness.fetch(
    "/api/v1/connectors/connections",
    {
      body: {
        bindingRef,
        intent: {
          profileId: "oauth",
          requestedPermissions: [],
          target: { kind: "account", id: "someone-else" },
        },
      },
      session: SESSION,
    },
  );
  // The target is accepted as an intent, and then it must actually be proven.
  assert.equal(disallowedTarget.status, 201);
  const pendingTarget = await json(disallowedTarget);
  const callback = await completeOauthCallback(
    harness,
    SESSION,
    (pendingTarget.presentation as { url: string }).url,
  );
  assert.equal(
    new URL(callback.headers.get("location")!).searchParams.get("outcome"),
    "human-required",
    "an exact-account intent the evidence does not satisfy blocks the flow",
  );
  const state = await json(
    await harness.fetch(
      `/api/v1/connectors/connections/${encodeURIComponent(
        pendingTarget.connectionRef as string,
      )}`,
      { session: SESSION },
    ),
  );
  assert.equal(state.lastOutcome, "verification.target-unverified");
  assert.notEqual(state.lifecycle, "active");
});

test("the request budget is shared and subject-scoped", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const actor = human();
  harness.register(SESSION, actor);
  let limited = 0;
  for (let attempt = 0; attempt < 130; attempt++) {
    const response = await harness.fetch("/api/v1/connectors/catalog", {
      session: SESSION,
    });
    if (response.status === 429) limited++;
    else await response.body?.cancel().catch(() => {});
  }
  assert.ok(limited > 0, "the shared budget eventually refuses");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  completeOauthCallback,
  createHarness,
  FIXTURE_DOCUMENT,
  human,
  ORIGIN,
  type Harness,
} from "./harness.js";

/*
 * The whole public API, through HTTP, against a real provider on loopback:
 * catalog, import, review, approve, connect, callback, status, invoke read,
 * invoke write with consent, reconnect, disconnect. Every assertion is made
 * on what the route actually returned, and the provider fixture independently
 * records what it actually received.
 */

const SESSION = "human-session";

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function approvedBinding(harness: Harness, actor = human()) {
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
        operations: [
          "listItems",
          { nativeId: "createItem", consent: "confirm", replay: "upstream-idempotency-key" },
        ],
        profileId: "oauth",
        permittedTargets: [{ kind: "account", id: "acct-primary" }],
      },
    },
    session: SESSION,
  });
  assert.equal(binding.status, 201);
  const reference = await json(binding);
  return {
    definitionRef,
    bindingRef: reference.bindingRef as string,
    sourceRef: result.sourceRef as string,
  };
}

test("a connector reaches a verified, usable connection through the public API", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const actor = human();
  harness.register(SESSION, actor);

  const catalog = await harness.fetch("/api/v1/connectors/catalog", {
    session: SESSION,
  });
  assert.equal(catalog.status, 200);
  assert.equal(catalog.headers.get("cache-control"), "no-store");
  const entries = (await json(catalog)).entries as Array<
    Record<string, unknown>
  >;
  const entry = entries.find((item) => item.id === "fixture-http");
  assert.ok(entry, "the registered fixture adapter appears in the directory");
  assert.equal(
    entry.support,
    "fixture",
    "a fixture entry stays visibly separate from provider-backed integrations",
  );

  const { definitionRef, bindingRef } = await approvedBinding(harness, actor);

  const review = await harness.fetch(
    `/api/v1/connectors/definitions/${encodeURIComponent(definitionRef)}`,
    { session: SESSION },
  );
  assert.equal(review.status, 200);
  const reviewed = await json(review);
  assert.ok(reviewed.definition, "an author sees the normalized definition");
  assert.ok(reviewed.source, "and its provenance");
  assert.equal(
    (reviewed.source as Record<string, unknown>).artifactRef,
    undefined,
    "the protected raw artifact handle never leaves the server",
  );

  const listed = await harness.fetch("/api/v1/connectors/definitions", {
    session: SESSION,
  });
  const definitions = (await json(listed)).definitions as Array<
    Record<string, unknown>
  >;
  assert.equal(definitions.length, 1);
  assert.deepEqual(definitions[0]!.issues, {
    blocking: 0,
    warning: 0,
    info: 0,
  });

  const connected = await harness.fetch("/api/v1/connectors/connections", {
    body: {
      bindingRef,
      ownerKind: "user",
      intent: {
        profileId: "oauth",
        requestedPermissions: ["read", "write"],
        target: { kind: "account", id: "acct-primary" },
        accountSwitch: false,
        interruption: "allowed",
      },
    },
    session: SESSION,
  });
  assert.equal(connected.status, 201);
  const pending = await json(connected);
  assert.equal(pending.lifecycle, "authorization-required");
  const presentation = pending.presentation as { url?: string } | undefined;
  assert.ok(
    presentation?.url?.startsWith(`${harness.provider.origin}/oauth/authorize`),
    "the initiating human is shown the provider authorization URL",
  );
  const connectionRef = pending.connectionRef as string;

  assert.ok(presentation?.url);
  const callback = await completeOauthCallback(
    harness,
    SESSION,
    presentation.url,
  );
  assert.equal(callback.status, 303, "a callback is a top-level navigation");
  const location = new URL(callback.headers.get("location")!);
  assert.equal(
    location.origin,
    ORIGIN,
    "the return route is built from the deployment origin",
  );
  assert.equal(location.pathname, "/connectors");
  assert.equal(location.searchParams.get("outcome"), "active");

  const status = await harness.fetch(
    `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}`,
    { session: SESSION },
  );
  const active = await json(status);
  assert.equal(active.lifecycle, "active");
  assert.deepEqual(active.target, { kind: "account", id: "acct-primary" });
  assert.deepEqual(
    (active.verification as { kinds: string[] }).kinds.sort(),
    ["account-identity", "credential-accepted"],
    "evidence names what was actually observed",
  );

  const read = await harness.fetch(
    `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/invoke`,
    {
      body: {
        operationRef: bindingOperation(harness, bindingRef, "listItems"),
        input: { project: "alpha" },
        commandId: "cmd-read-1",
      },
      session: SESSION,
    },
  );
  assert.equal(read.status, 200);
  const readBody = await json(read);
  assert.equal(readBody.state, "complete");
  assert.equal(readBody.effect, "read");
  assert.deepEqual(
    (readBody.output as { items: Array<{ name: string }> }).items[0]!.name,
    "acct-primary:alpha",
    "the provider answered the approved read with the connection's own credential",
  );

  const writeRef = bindingOperation(harness, bindingRef, "createItem");
  const unconfirmed = await harness.fetch(
    `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/invoke`,
    {
      body: {
        operationRef: writeRef,
        input: { name: "first" },
        commandId: "cmd-write-1",
      },
      session: SESSION,
    },
  );
  const blocked = await json(unconfirmed);
  assert.equal(blocked.state, "human-required");
  assert.equal(blocked.code, "consent.required");
  assert.equal(
    harness.provider.writeCount("first"),
    0,
    "an unconfirmed write never reaches the provider",
  );

  const confirmed = await harness.fetch(
    `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/invoke`,
    {
      body: {
        operationRef: writeRef,
        input: { name: "first" },
        commandId: "cmd-write-2",
        confirm: true,
      },
      session: SESSION,
    },
  );
  const written = await json(confirmed);
  assert.equal(written.state, "complete");
  assert.equal(written.effect, "write");

  const repeated = await harness.fetch(
    `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/invoke`,
    {
      body: {
        operationRef: writeRef,
        input: { name: "first" },
        commandId: "cmd-write-2",
        confirm: true,
      },
      session: SESSION,
    },
  );
  const replay = await json(repeated);
  assert.equal(replay.replayed, true, "the journal answers a repeated command");
  assert.equal(
    harness.provider.requests.filter(
      (request) =>
        request.method === "POST" && request.url.pathname === "/v1/items",
    ).length,
    1,
    "and the provider saw exactly one write",
  );

  const current = await json(
    await harness.fetch(
      `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}`,
      { session: SESSION },
    ),
  );
  const reconnected = await harness.fetch(
    `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/reconnect`,
    {
      body: { expectedRevision: current.revision, accountSwitch: false },
      session: SESSION,
    },
  );
  assert.equal(reconnected.status, 200);
  const restarted = await json(reconnected);
  assert.equal(restarted.lifecycle, "authorization-required");
  assert.equal(
    restarted.generation,
    (current.generation as number) + 1,
    "reconnect advances the generation that fences older callbacks",
  );

  const afterReconnect = await json(
    await harness.fetch(
      `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}`,
      { session: SESSION },
    ),
  );
  const disconnected = await harness.fetch(
    `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/disconnect`,
    {
      body: { expectedRevision: afterReconnect.revision, scope: "local" },
      session: SESSION,
    },
  );
  assert.equal(disconnected.status, 200);
  const outcome = await json(disconnected);
  assert.deepEqual(
    (outcome.result as Record<string, unknown>),
    {
      local: "applied",
      broker: "not-attempted",
      upstream: "not-attempted",
    },
    "a local unlink attempts nothing upstream (AC-STATE-03)",
  );
  assert.equal(
    (outcome.connection as Record<string, unknown>).lifecycle,
    "locally-disconnected",
  );
  assert.equal(
    harness.provider.received("POST", "/v1/revoke").length,
    0,
    "and the provider was never asked to revoke",
  );
});

test("an api-key profile completes through the private input handoff", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const actor = human();
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
  const binding = await json(
    await harness.fetch("/api/v1/connectors/bindings", {
      body: {
        definitionRef: (imported.definitions as string[])[0],
        adapterId: "fixture-http",
        approvals: {
          destinations: [harness.provider.origin],
          operations: ["listItems"],
          profileId: "api-key",
        },
      },
      session: SESSION,
    }),
  );
  const connected = await json(
    await harness.fetch("/api/v1/connectors/connections", {
      body: {
        bindingRef: binding.bindingRef,
        intent: { profileId: "api-key", requestedPermissions: ["read"] },
      },
      session: SESSION,
    }),
  );
  assert.equal(connected.lifecycle, "human-required");
  const handoff = connected.handoff as { handoffRef: string; kind: string };
  assert.equal(handoff.kind, "private-collector");
  assert.equal(
    (connected.presentation as { url?: string }).url,
    undefined,
    "a private collector shows instructions, never a navigable URL",
  );

  const completed = await json(
    await harness.fetch(
      `/api/v1/connectors/connections/${encodeURIComponent(
        connected.connectionRef as string,
      )}/handoffs/${encodeURIComponent(handoff.handoffRef)}/input`,
      { body: { values: { apiKey: "fixture-api-key" } }, session: SESSION },
    ),
  );
  assert.equal(completed.lifecycle, "active");
  assert.deepEqual(completed.target, { kind: "account", id: "acct-primary" });
  assert.ok(
    !JSON.stringify(completed).includes("fixture-api-key"),
    "the submitted key never appears in a response",
  );
});

test("a rejected api key leaves the connection unverified", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const actor = human();
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
  const binding = await json(
    await harness.fetch("/api/v1/connectors/bindings", {
      body: {
        definitionRef: (imported.definitions as string[])[0],
        adapterId: "fixture-http",
        approvals: {
          destinations: [harness.provider.origin],
          operations: ["listItems"],
          profileId: "api-key",
        },
      },
      session: SESSION,
    }),
  );
  const connected = await json(
    await harness.fetch("/api/v1/connectors/connections", {
      body: {
        bindingRef: binding.bindingRef,
        intent: { profileId: "api-key", requestedPermissions: ["read"] },
      },
      session: SESSION,
    }),
  );
  const handoff = connected.handoff as { handoffRef: string };
  const refused = await json(
    await harness.fetch(
      `/api/v1/connectors/connections/${encodeURIComponent(
        connected.connectionRef as string,
      )}/handoffs/${encodeURIComponent(handoff.handoffRef)}/input`,
      { body: { values: { apiKey: "wrong-key" } }, session: SESSION },
    ),
  );
  assert.notEqual(refused.lifecycle, "active");
  assert.equal(refused.lastOutcome, "credential.rejected");
  assert.equal(refused.verification, undefined);
});

/** Reads the operation reference the review assigned to a native operation. */
function bindingOperation(
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

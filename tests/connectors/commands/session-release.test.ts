import assert from "node:assert/strict";
import test from "node:test";
import type {
  AdapterCallContext,
  ConnectorAdapter,
  SessionRelease,
} from "../../../src/server/connectors/adapter.js";
import {
  releaseSession,
  SESSION_RELEASE_TIMEOUT_MS,
} from "../../../src/server/connectors/commands/session-release.js";
import {
  createHarness,
  FIXTURE_DOCUMENT,
  human,
  type Harness,
} from "./harness.js";
import { hold } from "../doubles/interleave.js";

/*
 * Ending a held sign-in at the provider is something the command layer asks of
 * an adapter and then reports, without letting anything the adapter does
 * change what the disconnect does: it may answer, throw, hang or answer
 * nonsense, and the caller gets a value-blind outcome in each case.
 */

const SECRET = "vtok_dummy_marker_0123456789abcdef";
const ctx = {} as AdapterCallContext;
const adapterWith = (
  releaseSession?: ConnectorAdapter["releaseSession"],
): ConnectorAdapter =>
  ({ id: "x", ...(releaseSession ? { releaseSession } : {}) }) as never;

test("an adapter with no session to end is not asked, and nothing is reported", async () => {
  assert.equal(await releaseSession(undefined, ctx), undefined);
  assert.equal(await releaseSession(adapterWith(), ctx), undefined);
});

test("what the adapter reports is what is reported", async () => {
  for (const answer of [
    { revoked: true, reason: "oauth.revoke.applied" },
    { revoked: false, reason: "oauth.revoke.refused" },
    { revoked: "unavailable", reason: "oauth.revoke.no-endpoint" },
  ] as const)
    assert.deepEqual(
      await releaseSession(
        adapterWith(async () => answer),
        ctx,
      ),
      answer,
    );
});

test("an adapter that throws is reported as failed, and none of what it threw is kept", async () => {
  const outcome = await releaseSession(
    adapterWith(async () => {
      throw new Error(`provider said ${SECRET}`);
    }),
    ctx,
  );
  assert.deepEqual(outcome, {
    revoked: false,
    reason: "session.release.failed",
  });
  assert.equal(JSON.stringify(outcome).includes(SECRET), false);
});

test("an adapter that never answers is reported as timed out at the bound", async () => {
  const started = Date.now();
  const outcome = await releaseSession(
    adapterWith(() => new Promise<SessionRelease>(() => {})),
    ctx,
    { timeoutMs: 50 },
  );
  assert.deepEqual(outcome, {
    revoked: false,
    reason: "session.release.timeout",
  });
  assert.ok(Date.now() - started < 2_000);
  assert.ok(SESSION_RELEASE_TIMEOUT_MS <= 10_000, "a disconnect waits briefly");
});

test("a session another local connection still shares is not asked about, and the report says so", async () => {
  let asked = 0;
  const adapter = adapterWith(async () => {
    asked++;
    return { revoked: true, reason: "oauth.revoke.applied" };
  });
  assert.deepEqual(
    await releaseSession(adapter, ctx, { sharedWith: ["connection:other"] }),
    { revoked: "unavailable", reason: "session.shared-grant" },
  );
  assert.equal(asked, 0, "the provider was not contacted");
  assert.deepEqual(await releaseSession(adapter, ctx, { sharedWith: [] }), {
    revoked: true,
    reason: "oauth.revoke.applied",
  });
  assert.equal(asked, 1, "the last holder's disconnect does ask");
});

test("an answer outside the schema a person reads is replaced, not passed on", async () => {
  for (const answer of [
    { revoked: "yes", reason: "oauth.revoke.applied" },
    { revoked: true, reason: `token ${SECRET}` },
    { revoked: true, reason: "oauth.revoke.applied", token: SECRET },
    { revoked: true },
    undefined,
    SECRET,
  ]) {
    const outcome = await releaseSession(
      adapterWith(async () => answer as never),
      ctx,
    );
    assert.deepEqual(outcome, {
      revoked: false,
      reason: "session.release.invalid",
    });
    assert.equal(JSON.stringify(outcome).includes(SECRET), false);
  }
});

// -------------------------------------------------- through the HTTP route

const SESSION = "human-session";
const json = async (response: Response) =>
  (await response.json()) as Record<string, any>;

async function activeApiKeyConnection(
  harness: Harness,
  session = SESSION,
  person = human(),
) {
  harness.register(session, person);
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
  const binding = await json(
    await harness.fetch("/api/v1/connectors/bindings", {
      body: {
        definitionRef: imported.definitions[0],
        adapterId: "fixture-http",
        approvals: {
          destinations: [harness.provider.origin],
          operations: ["listItems"],
          profileId: "api-key",
        },
      },
      session,
    }),
  );
  const connected = await json(
    await harness.fetch("/api/v1/connectors/connections", {
      body: {
        bindingRef: binding.bindingRef,
        intent: { profileId: "api-key", requestedPermissions: ["read"] },
      },
      session,
    }),
  );
  const active = await json(
    await harness.fetch(
      `/api/v1/connectors/connections/${encodeURIComponent(connected.connectionRef)}/handoffs/${encodeURIComponent(connected.handoff.handoffRef)}/input`,
      { body: { values: { apiKey: "fixture-api-key" } }, session },
    ),
  );
  assert.equal(active.lifecycle, "active");
  return active;
}

const disconnectPath = (connectionRef: string) =>
  `/api/v1/connectors/connections/${encodeURIComponent(connectionRef)}/disconnect`;

test("a local disconnect reports the adapter's release on the route, and an upstream one does not ask for it", async (t) => {
  let asked = 0;
  const harness = await createHarness({
    adapter: {
      releaseSession: async () => {
        asked++;
        return { revoked: true, reason: "fixture.release.ended" };
      },
    },
  });
  t.after(() => harness.close());
  const first = await activeApiKeyConnection(harness);
  const local = await json(
    await harness.fetch(disconnectPath(first.connectionRef), {
      body: { expectedRevision: first.revision, scope: "local" },
      session: SESSION,
    }),
  );
  assert.deepEqual(local.result, {
    local: "applied",
    broker: "not-attempted",
    upstream: "not-attempted",
    release: { revoked: true, reason: "fixture.release.ended" },
  });
  assert.equal(local.connection.lifecycle, "locally-disconnected");
  assert.equal(asked, 1);

  const second = await activeApiKeyConnection(harness);
  const upstream = await json(
    await harness.fetch(disconnectPath(second.connectionRef), {
      body: { expectedRevision: second.revision, scope: "upstream" },
      session: SESSION,
    }),
  );
  assert.equal(upstream.result.release, undefined);
  assert.equal(upstream.result.upstream, "applied");
  assert.equal(
    asked,
    1,
    "the upstream scope asked the adapter to end the grant, not to release",
  );
});

test("an adapter whose release throws cannot stop the disconnect or leak what it threw", async (t) => {
  const harness = await createHarness({
    adapter: {
      releaseSession: async () => {
        throw new Error(`provider said ${SECRET}`);
      },
    },
  });
  t.after(() => harness.close());
  const active = await activeApiKeyConnection(harness);
  const response = await harness.fetch(disconnectPath(active.connectionRef), {
    body: { expectedRevision: active.revision, scope: "local" },
    session: SESSION,
  });
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.connection.lifecycle, "locally-disconnected");
  assert.deepEqual(body.result.release, {
    revoked: false,
    reason: "session.release.failed",
  });
  assert.equal(JSON.stringify(body).includes(SECRET), false);
});

test("an adapter with nothing to release leaves the route's answer as it was", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const active = await activeApiKeyConnection(harness);
  const body = await json(
    await harness.fetch(disconnectPath(active.connectionRef), {
      body: { expectedRevision: active.revision, scope: "local" },
      session: SESSION,
    }),
  );
  assert.deepEqual(body.result, {
    local: "applied",
    broker: "not-attempted",
    upstream: "not-attempted",
  });
});

/** Two people on one binding and one account, so one upstream grant is listed by both connections. */
async function twoHolders(harness: Harness) {
  const first = await activeApiKeyConnection(harness);
  const second = await activeApiKeyConnection(
    harness,
    "second-session",
    human({ subjectId: "subject-2", sessionId: "second-session" }),
  );
  return { first, second };
}

for (const [who, closesFirst] of [
  ["newer", "second"],
  ["older", "first"],
] as const)
  test(`while another local connection shares the grant the ${who} holder's local disconnect leaves the provider alone, and the last holder's ends it`, async (t) => {
    let asked = 0;
    const harness = await createHarness({
      adapter: {
        releaseSession: async () => {
          asked++;
          return { revoked: true, reason: "fixture.release.ended" };
        },
      },
    });
    t.after(() => harness.close());
    const holders = await twoHolders(harness);
    const leaving = holders[closesFirst];
    const staying = holders[closesFirst === "first" ? "second" : "first"];
    const sessionOf = (view: typeof leaving) =>
      view === holders.first ? SESSION : "second-session";

    const shared = await json(
      await harness.fetch(disconnectPath(leaving.connectionRef), {
        body: { expectedRevision: leaving.revision, scope: "local" },
        session: sessionOf(leaving),
      }),
    );
    assert.equal(shared.connection.lifecycle, "locally-disconnected");
    assert.deepEqual(shared.result.sharedWith, [staying.connectionRef]);
    assert.deepEqual(shared.result.release, {
      revoked: "unavailable",
      reason: "session.shared-grant",
    });
    assert.equal(asked, 0, "the other holder's sign-in was not ended");

    const last = await json(
      await harness.fetch(disconnectPath(staying.connectionRef), {
        body: { expectedRevision: staying.revision, scope: "local" },
        session: sessionOf(staying),
      }),
    );
    assert.equal(last.result.sharedWith, undefined);
    assert.deepEqual(last.result.release, {
      revoked: true,
      reason: "fixture.release.ended",
    });
    assert.equal(asked, 1);
  });

test("two holders of one grant disconnecting at the same moment do not both leave the provider alone", async (t) => {
  let asked = 0;
  const harness = await createHarness({
    adapter: {
      releaseSession: async () => {
        asked++;
        return { revoked: true, reason: "fixture.release.ended" };
      },
    },
  });
  t.after(() => harness.close());
  const { first, second } = await twoHolders(harness);
  // The first has read who else holds the grant and is about to fence; the
  // second runs to its end in that window.
  const fencing = hold(harness.ports.connections, "advanceGeneration");
  const leavingFirst = harness.fetch(disconnectPath(first.connectionRef), {
    body: { expectedRevision: first.revision, scope: "local" },
    session: SESSION,
  });
  await fencing.reached;
  const out = await json(
    await harness.fetch(disconnectPath(second.connectionRef), {
      body: { expectedRevision: second.revision, scope: "local" },
      session: "second-session",
    }),
  );
  fencing.release();
  const done = await json(await leavingFirst);

  assert.equal(out.connection.lifecycle, "locally-disconnected");
  assert.equal(done.connection.lifecycle, "locally-disconnected");
  assert.ok(
    asked >= 1,
    "the last of the two to leave asked the provider to end the session",
  );
});

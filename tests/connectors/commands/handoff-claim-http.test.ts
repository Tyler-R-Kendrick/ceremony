import assert from "node:assert/strict";
import test from "node:test";
import {
  createHarness,
  FIXTURE_DOCUMENT,
  human,
  type Harness,
} from "./harness.js";

/*
 * The handoff claim is the command layer's, so it holds for every connector
 * and over the real route, not only for the AWS choice that exposed it. Here
 * the connector is the fixture API-key one: a private collector takes a key,
 * the adapter checks it with the provider, and two keys sent at once must not
 * both be worked.
 */

const SESSION = "human-session";
const json = async (response: Response) =>
  (await response.json()) as Record<string, any>;

async function pendingKeyHandoff(harness: Harness) {
  harness.register(SESSION, human());
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
        definitionRef: imported.definitions[0],
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
  return {
    connectionRef: connected.connectionRef as string,
    handoffRef: connected.handoff.handoffRef as string,
    revision: connected.revision as number,
  };
}

const submit = (
  harness: Harness,
  pending: { connectionRef: string; handoffRef: string },
  apiKey: string,
) =>
  harness.fetch(
    `/api/v1/connectors/connections/${encodeURIComponent(pending.connectionRef)}/handoffs/${encodeURIComponent(pending.handoffRef)}/input`,
    { body: { values: { apiKey } }, session: SESSION },
  );

/** Holds back the first settlement of a handoff, so the other submission is met while it is being worked. */
function holdFirstSettlement(harness: Harness) {
  const real = harness.ports.handoffs.complete.bind(harness.ports.handoffs);
  const gate = Promise.withResolvers<void>();
  let settling = 0;
  harness.ports.handoffs.complete = async (...args) => {
    settling += 1;
    if (settling === 1) await gate.promise;
    return real(...args);
  };
  return {
    release: () => gate.resolve(),
    restore: () => (harness.ports.handoffs.complete = real),
  };
}

const keyChecks = (harness: Harness) =>
  harness.provider.requests.filter(
    (request) => request.url.pathname === "/v1/account",
  );

test("two different keys sent at once over the route: one is worked, the other is refused as already claimed", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const pending = await pendingKeyHandoff(harness);
  const hold = holdFirstSettlement(harness);
  t.after(hold.restore);

  const first = submit(harness, pending, "fixture-api-key");
  const second = submit(harness, pending, "another-api-key");
  // The refusal does not wait for the run it lost to.
  const refused = await second;
  hold.release();
  const worked = await first;

  assert.equal(worked.status, 200);
  assert.equal((await json(worked)).lifecycle, "active");
  assert.equal(refused.status, 409);
  const body = await json(refused);
  assert.equal(body.error, "conflict");
  assert.equal(body.detail, "handoff.already-claimed");
  assert.equal(JSON.stringify(body).includes("another-api-key"), false);
  assert.equal(keyChecks(harness).length, 1, "the provider saw one key");

  // The refused submission wrote nothing to the connection.
  const view = await json(
    await harness.fetch(
      `/api/v1/connectors/connections/${encodeURIComponent(pending.connectionRef)}`,
      { session: SESSION },
    ),
  );
  assert.equal(view.lifecycle, "active");
  assert.equal(view.lastOutcome, "authorization.complete");
});

test("the same key sent twice at once over the route is answered twice from one run", async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const pending = await pendingKeyHandoff(harness);

  const [one, two] = await Promise.all([
    submit(harness, pending, "fixture-api-key"),
    submit(harness, pending, "fixture-api-key"),
  ]);

  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  const [a, b] = [await json(one), await json(two)];
  assert.equal(a.lifecycle, "active");
  // The same connection as the run left it (only the read's own timestamp differs).
  const { updatedAt: _a, ...left } = a;
  const { updatedAt: _b, ...answered } = b;
  void _a;
  void _b;
  assert.deepEqual(answered, left);
  assert.equal(keyChecks(harness).length, 1, "one check, not two");
});

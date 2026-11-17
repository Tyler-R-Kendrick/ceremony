// Ties CeremonySteps.tla to the real controller.
//
// The model takes ten checks in the code as given (the names in `Checks` in
// CeremonySteps.tla), the table in actionsFor, and one adapter call in flight
// at a time. Each test below shows one of these on the real
// CeremonyController. The request-human test shows the fix for finding F1;
// the two retry-clears-outcome tests show the fix for finding F2.
//
// Run from the repo root:
//   node --import tsx --test verification/ceremony-steps/conformance.test.ts
// verification/ceremony-steps/check.sh runs it after the model check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { actionsFor, steps } from "../../src/core/schema.js";
import {
  CeremonyController,
  type AdapterUpdate,
  type AuthAdapter,
} from "../../src/server/controller.js";
import {
  createProtocolAdapter,
  MemoryCredentialStore,
} from "../../src/server/adapters.js";

const manifest = {
  id: "provider",
  name: "Provider",
  description: "A provider used only by this check.",
  methods: [
    {
      id: "oauth",
      label: "Sign in",
      kind: "oauth-code" as const,
      fields: [],
      scopes: [],
      templateId: "oauth-code",
    },
    {
      id: "anonymous",
      label: "Anonymous",
      kind: "authmd-anonymous" as const,
      fields: [],
      claimFields: [],
      scopes: [],
      templateId: "authmd-anonymous",
    },
  ],
};
const redirect: AdapterUpdate = {
  step: "redirect",
  authorizationUrl: "https://provider.example/authorize",
};
const complete: AdapterUpdate = {
  step: "complete",
  outcome: { connectionRef: "ref", ownership: "authenticated", scopes: [] },
};
const callbackUrl = new URL("https://host.example/callback?code=c&state=s");

function harness(overrides: Partial<AuthAdapter> = {}) {
  let now = 1_000_000;
  const controller = new CeremonyController(
    [
      {
        manifest,
        createAdapter: () => ({
          begin: async () => redirect,
          submit: async () => complete,
          callback: async () => complete,
          poll: async () => undefined,
          cancel() {},
          ...overrides,
        }),
      },
    ],
    new Map(),
    () => now,
  );
  const act = (id: string, action: string, revision: number) =>
    controller.act("alice", id, { action, revision });
  return {
    controller,
    act,
    start: () => controller.start("alice", "provider", "oauth"),
    read: (id: string) => controller.read("alice", id),
    wait: (ms: number) => {
      now += ms;
    },
    pastTheDeadline: () => {
      now += 600_001;
    },
  };
}

test("revision-check: an action with an old revision changes nothing (controller.ts:557)", async () => {
  const h = harness();
  const first = h.start();
  const second = await h.act(first.id, "begin", first.revision);
  await assert.rejects(h.act(first.id, "cancel", first.revision), /stale/);
  assert.deepEqual(await h.read(first.id), second);
});

test("busy-check: no action is accepted while an adapter call is in flight (controller.ts:557)", async () => {
  const pending = Promise.withResolvers<AdapterUpdate>();
  const h = harness({ begin: () => pending.promise });
  const first = h.start();
  const beginning = h.act(first.id, "begin", first.revision);
  await assert.rejects(h.act(first.id, "cancel", first.revision), /stale/);
  pending.resolve(redirect);
  assert.equal((await beginning).step, "redirect");
});

test("offered-check: an action the step does not offer changes nothing (controller.ts:562)", async () => {
  const h = harness();
  const first = h.start();
  assert.deepEqual(first.actions, ["begin", "cancel"]);
  await assert.rejects(
    h.act(first.id, "finish", first.revision),
    /not allowed/,
  );
  assert.deepEqual(await h.read(first.id), first);
});

test("one call in flight: a callback or a second poll does not start while one is in flight (controller.ts:463, :675)", async () => {
  // The controller reaches the adapter in the same synchronous stretch as the
  // request, so the counts are known as soon as each call returns its promise.
  let callbacks = 0;
  const returning = Promise.withResolvers<AdapterUpdate>();
  const h = harness({
    callback: () => {
      callbacks++;
      return returning.promise;
    },
  });
  const first = h.start();
  const atProvider = await h.act(first.id, "begin", first.revision);
  const firstCallback = h.controller.callback("alice", first.id, callbackUrl);
  const secondCallback = h.controller
    .callback("alice", first.id, callbackUrl)
    .then(
      () => "accepted",
      () => "refused",
    );
  assert.equal(callbacks, 1);
  returning.resolve(complete);
  assert.equal(await secondCallback, "refused");
  assert.equal((await firstCallback).revision, atProvider.revision + 1);

  let polls = 0;
  const polling = Promise.withResolvers<AdapterUpdate | undefined>();
  const waiting = harness({
    begin: async () => ({
      step: "waiting",
      verificationUri: "https://provider.example/verify",
      userCode: "1234",
    }),
    poll: () => {
      polls++;
      return polling.promise;
    },
  });
  const started = waiting.start();
  await waiting.act(started.id, "begin", started.revision);
  const firstRead = waiting.read(started.id);
  // Past the one-second throttle on polls, so only `busy` holds the second read back.
  waiting.wait(1500);
  const secondRead = waiting.read(started.id);
  assert.equal(polls, 1);
  polling.resolve(undefined);
  await Promise.all([firstRead, secondRead]);
});

test("actionsFor is the table the model's ActionsFor has (schema.ts:317-344)", () => {
  const table: Record<string, [string[], string[]]> = {
    intro: [["begin", "cancel"], ["begin", "cancel"]],
    input: [["submit", "cancel"], ["submit", "cancel"]],
    claim: [["submit", "cancel"], ["submit", "cancel"]],
    redirect: [["cancel"], ["cancel"]],
    waiting: [["cancel"], ["cancel"]],
    anonymous: [["finish", "claim", "cancel"], ["finish", "claim", "cancel"]],
    complete: [[], ["claim"]],
    error: [["retry", "cancel"], ["finish", "claim", "cancel"]],
    expired: [["retry", "cancel"], ["finish", "claim", "cancel"]],
    cancelled: [["retry"], ["retry"]],
  };
  assert.deepEqual(Object.keys(table).sort(), [...steps].sort());
  for (const step of steps) {
    assert.deepEqual(actionsFor(step, false), table[step]![0], step);
    assert.deepEqual(actionsFor(step, true), table[step]![1], `${step}, anonymous`);
  }
});

test("end-exemption: complete and cancelled never expire (controller.ts:325)", async () => {
  const h = harness();
  const first = h.start();
  const cancelled = await h.act(first.id, "cancel", first.revision);
  h.pastTheDeadline();
  assert.deepEqual(await h.read(first.id), cancelled);

  const second = harness();
  const started = second.start();
  await second.act(started.id, "begin", started.revision);
  const connected = await second.controller.callback("alice", started.id, callbackUrl);
  assert.equal(connected.step, "complete");
  second.pastTheDeadline();
  assert.deepEqual(await second.read(started.id), connected);
});

test("expired-guard-on-error: an adapter error that lands after expiry is dropped (controller.ts:715)", async () => {
  const pending = Promise.withResolvers<AdapterUpdate>();
  const h = harness({ begin: () => pending.promise });
  const first = h.start();
  const beginning = h.act(first.id, "begin", first.revision);
  h.pastTheDeadline();
  const expired = await h.read(first.id);
  assert.equal(expired.step, "expired");
  pending.reject(new Error("Attempt cancelled"));
  assert.deepEqual(await beginning, expired);
});

test("expired-guard: an adapter answer that lands after expiry is dropped (controller.ts:692)", async () => {
  const pending = Promise.withResolvers<AdapterUpdate>();
  const h = harness({ begin: () => pending.promise });
  const first = h.start();
  const beginning = h.act(first.id, "begin", first.revision);
  h.pastTheDeadline();
  const expired = await h.read(first.id);
  assert.equal(expired.step, "expired");
  pending.resolve(complete);
  assert.deepEqual(await beginning, expired);
});

test("callback-guard: a callback outside the redirect step changes nothing (controller.ts:675)", async () => {
  const h = harness();
  const first = h.start();
  const atProvider = await h.act(first.id, "begin", first.revision);
  const cancelled = await h.act(first.id, "cancel", atProvider.revision);
  assert.equal(cancelled.step, "cancelled");
  await assert.rejects(
    h.controller.callback("alice", first.id, callbackUrl),
    /stale or already consumed/,
  );
  assert.deepEqual(await h.read(first.id), cancelled);
});

test("revision-bump and retry-keeps-revision: every change adds one, retry included (controller.ts:358, :632)", async () => {
  const h = harness();
  const first = h.start();
  assert.equal(first.revision, 0);
  const atProvider = await h.act(first.id, "begin", first.revision);
  assert.equal(atProvider.revision, 1);
  const cancelled = await h.act(first.id, "cancel", atProvider.revision);
  assert.equal(cancelled.revision, 2);
  const again = await h.act(first.id, "retry", cancelled.revision);
  assert.equal(again.step, "intro");
  assert.equal(again.revision, 3);
});

test("retry-after-cancel: the cancelled step offers retry (schema.ts:322-323)", async () => {
  const h = harness();
  const first = h.start();
  const cancelled = await h.act(first.id, "cancel", first.revision);
  assert.deepEqual(cancelled.actions, ["retry"]);
});

// F1, fixed. A requestHuman answer is applied only while the snapshot is not
// expired, as run() does for every other adapter answer (controller.ts:692).
test("request-human expired-guard: a requestHuman answer that lands after expiry is dropped, one that lands in time is applied (finding F1)", async () => {
  const late = Promise.withResolvers<AdapterUpdate>();
  const h = harness({ requestHuman: () => late.promise });
  const first = h.start();
  const atProvider = await h.act(first.id, "begin", first.revision);
  assert.ok(atProvider.actions.includes("request-human"));
  const asking = h.act(first.id, "request-human", atProvider.revision);
  h.pastTheDeadline();
  const expired = await h.read(first.id);
  assert.equal(expired.step, "expired");
  late.resolve({ ...redirect, message: "Human assistance requested." });
  assert.deepEqual(await asking, expired);
  assert.deepEqual(await h.read(first.id), expired);

  const inTime = harness({
    requestHuman: async () => ({
      ...redirect,
      message: "Human assistance requested.",
    }),
  });
  const started = inTime.start();
  const redirected = await inTime.act(started.id, "begin", started.revision);
  const answered = await inTime.act(
    started.id,
    "request-human",
    redirected.revision,
  );
  assert.equal(answered.step, "redirect");
  assert.equal(answered.message, "Human assistance requested.");
  assert.equal(answered.revision, redirected.revision + 1);
});

// F2, fixed. Retry starts a new attempt with a new adapter, so it drops the
// outcome an earlier attempt obtained, unless that outcome is already claimed
// (decision D1).
test("retry-clears-outcome: retry after a cancelled anonymous attempt starts with no outcome, and cancel then shows cancelled (finding F2)", async () => {
  const issuer = "https://provider.example";
  const realFetch = globalThis.fetch;
  let registrations = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith("/identity")) {
      registrations++;
      return Response.json({
        identity_assertion: "assertion",
        claim_token: `claim-${registrations}`,
        claim_token_expires: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    if (url.endsWith("/token"))
      return Response.json({
        access_token: "anonymous-token",
        token_type: "bearer",
        scope: "",
      });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  try {
    const controller = new CeremonyController([
      {
        manifest,
        createAdapter: ({ method }) =>
          createProtocolAdapter(
            method,
            {
              issuer,
              clientId: "client",
              authorizationEndpoint: `${issuer}/authorize`,
              tokenEndpoint: `${issuer}/token`,
              deviceEndpoint: `${issuer}/device`,
              resource: `${issuer}/resource`,
              callbackUrl: "https://host.example/callback",
              credentialEndpoint: `${issuer}/credential`,
              identityEndpoint: `${issuer}/identity`,
              claimEndpoint: `${issuer}/claim`,
            },
            new MemoryCredentialStore(),
          ),
      },
    ]);
    const act = (action: string, revision: number) =>
      controller.act("alice", snapshot.id, { action, revision });
    let snapshot = controller.start("alice", "provider", "anonymous");
    snapshot = await act("begin", snapshot.revision);
    assert.equal(snapshot.step, "anonymous", snapshot.message);
    const cancelledRef = snapshot.outcome?.connectionRef;
    snapshot = await act("cancel", snapshot.revision);
    assert.equal(snapshot.step, "cancelled");
    assert.ok(cancelledRef);
    const cancelledRevision = snapshot.revision;
    snapshot = await act("retry", snapshot.revision);
    assert.equal(snapshot.step, "intro");
    assert.equal(snapshot.revision, cancelledRevision + 1);
    assert.equal(snapshot.outcome, undefined);
    assert.deepEqual(snapshot.actions, ["begin", "cancel"]);
    snapshot = await act("cancel", snapshot.revision);
    assert.equal(snapshot.step, "cancelled");
    assert.equal(snapshot.outcome, undefined);
    assert.deepEqual(snapshot.actions, ["retry"]);
    snapshot = await act("retry", snapshot.revision);
    assert.equal(snapshot.step, "intro");
    assert.equal(snapshot.outcome, undefined);
    snapshot = await act("begin", snapshot.revision);
    assert.equal(snapshot.step, "anonymous", snapshot.message);
    assert.equal(registrations, 2);
    assert.ok(snapshot.outcome?.connectionRef);
    assert.notEqual(snapshot.outcome.connectionRef, cancelledRef);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("retry-clears-outcome: retry from error drops an authenticated outcome and keeps a claimed one (finding F2, decision D1)", async () => {
  for (const ownership of ["authenticated", "claimed"] as const) {
    const outcome = { connectionRef: `ref-${ownership}`, ownership, scopes: [] };
    const h = harness({
      begin: async () => ({
        step: "error",
        message: "The provider refused.",
        outcome,
      }),
    });
    const first = h.start();
    const failed = await h.act(first.id, "begin", first.revision);
    assert.equal(failed.step, "error", ownership);
    assert.deepEqual(failed.outcome, outcome, ownership);
    assert.deepEqual(failed.actions, ["retry", "cancel"], ownership);
    const again = await h.act(first.id, "retry", failed.revision);
    assert.equal(again.step, "intro", ownership);
    assert.equal(again.revision, failed.revision + 1, ownership);
    assert.deepEqual(again.actions, ["begin", "cancel"], ownership);
    if (ownership === "claimed") {
      assert.deepEqual(again.outcome, outcome, ownership);
    } else {
      assert.equal(again.outcome, undefined, ownership);
      const cancelled = await h.act(first.id, "cancel", again.revision);
      assert.equal(cancelled.step, "cancelled", ownership);
      assert.equal(cancelled.outcome, undefined, ownership);
    }
  }
});

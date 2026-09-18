import assert from "node:assert/strict";
import test from "node:test";
import {
  attachHandoffPort,
  classifyHandoff,
  composedHandoffHooks,
  createHandoffWaits,
  handoffEventSchema,
  handoffReplyMessageSchema,
  mintHandoffRef,
  offerHandoff,
  subscribeHandoffs,
  type HandoffEvent,
  type HandoffPort,
  type HandoffResolution,
} from "../src/browser-login/handoffs.js";
import {
  matchTemplate,
  type Observation,
} from "../src/browser-login/templates.js";

const identifier = "00000000-0000-4000-8000-000000000001";
const password = "00000000-0000-4000-8000-000000000002";
const submit = "00000000-0000-4000-8000-000000000003";
const form = "00000000-0000-4000-8000-000000000004";
function page(overrides: Partial<Observation> = {}): Observation {
  return {
    document: "00000000-0000-4000-8000-000000000005",
    origin: "https://owned.example",
    challenge: false,
    passkey: false,
    controls: [
      {
        ref: identifier,
        kind: "identifier",
        label: "Username",
        form,
        recipient: "https://owned.example/login",
      },
      {
        ref: password,
        kind: "password",
        label: "Password",
        form,
        recipient: "https://owned.example/login",
      },
      {
        ref: submit,
        kind: "submit",
        label: "Sign in",
        form,
        recipient: "https://owned.example/login",
      },
    ],
    ...overrides,
  };
}

const runId = "11111111-1111-4111-8111-111111111111";
function event(overrides: Partial<HandoffEvent> = {}): HandoffEvent {
  return handoffEventSchema.parse({
    kind: "handoff",
    handoffRef: mintHandoffRef(),
    runId,
    reason: "passkey-required",
    origin: "https://owned.example",
    attempt: 1,
    ...overrides,
  });
}

/** A resolver channel. Only its identity matters to an assignment. */
function resolver(): HandoffPort {
  return {
    postMessage() {},
    disconnect() {},
    onMessage: { addListener() {} },
    onDisconnect: { addListener() {} },
  };
}

function reply(handoffRef: string, resolution: HandoffResolution, run = runId) {
  return handoffReplyMessageSchema.parse({
    type: "ceremony.resolve-handoff",
    handoffRef,
    runId: run,
    resolution,
  });
}

/** Records the single outcome an attempt is allowed to produce. */
function attempt(waits: ReturnType<typeof createHandoffWaits>, run = runId) {
  const handoffRef = mintHandoffRef();
  const outcomes: HandoffResolution[] = [];
  return {
    handoffRef,
    outcomes,
    open(resolvers: HandoffPort[]) {
      waits.open({
        handoffRef,
        runId: run,
        resolvers,
        finish: (value) => outcomes.push(value),
      });
      return this;
    },
  };
}

test("classification prefers passkey-only pages, then challenge", () => {
  assert.equal(classifyHandoff(page()), undefined);
  assert.equal(classifyHandoff(page({ passkey: true })), undefined);
  assert.equal(
    matchTemplate(page({ passkey: true }))?.mapping.password,
    password,
  );
  assert.equal(classifyHandoff(page({ challenge: true })), "human-challenge");
  const passkeyOnly = page({
    passkey: true,
    controls: page().controls.filter((control) => control.kind !== "password"),
  });
  assert.equal(classifyHandoff(passkeyOnly), "passkey-required");
  assert.equal(matchTemplate(passkeyOnly)?.mapping.password, undefined);
  assert.equal(matchTemplate(page({ challenge: true })), undefined);
});

test("handoff events exclude extra fields and require an admitted origin", () => {
  assert.equal(
    handoffEventSchema.safeParse({
      ...event(),
      password: "secret",
    }).success,
    false,
  );
  assert.equal(
    handoffEventSchema.safeParse({
      ...event(),
      origin: "https://owned.example/login?code=secret",
    }).success,
    false,
  );
});

test("offerHandoff treats missing, invalid, and throwing resolvers as unavailable", async () => {
  const seen: HandoffEvent[] = [];
  assert.equal(await offerHandoff(event()), "unavailable");
  assert.equal(
    await offerHandoff(event(), {
      onHandoff(item) {
        seen.push(item);
        throw new Error("observer");
      },
      resolveHandoff: () => "completed",
    }),
    "completed",
  );
  assert.equal(seen.length, 1);
  assert.equal(
    await offerHandoff(event(), { resolveHandoff: () => "declined" }),
    "declined",
  );
  assert.equal(
    await offerHandoff(event(), {
      resolveHandoff: () => "nope" as "completed",
    }),
    "unavailable",
  );
  assert.equal(
    await offerHandoff(event(), {
      resolveHandoff: () => {
        throw new Error("resolver");
      },
    }),
    "unavailable",
  );
});

test("subscribers let an owning app complete a passkey without a default hang", async () => {
  const stop = subscribeHandoffs({
    resolveHandoff: async (item) =>
      item.reason === "passkey-required" ? "completed" : "unavailable",
  });
  try {
    assert.equal(
      await offerHandoff(event(), composedHandoffHooks()),
      "completed",
    );
    assert.equal(
      await offerHandoff(
        event({ reason: "human-challenge" }),
        composedHandoffHooks(),
      ),
      "unavailable",
    );
  } finally {
    stop();
  }
  assert.equal(
    await offerHandoff(event(), composedHandoffHooks()),
    "unavailable",
  );
});

test("an extension port replies with the in-page resolver outcome", async () => {
  const replies: unknown[] = [];
  const listeners: Array<(message: unknown) => void> = [];
  const port: HandoffPort = {
    postMessage(message) {
      replies.push(message);
    },
    disconnect() {},
    onMessage: {
      addListener(listener) {
        listeners.push(listener);
      },
    },
    onDisconnect: { addListener() {} },
  };
  const stopPort = attachHandoffPort(port);
  const stop = subscribeHandoffs({
    resolveHandoff: () => "declined",
  });
  const asked = event();
  try {
    listeners[0]!({ type: "ceremony.handoff", event: asked });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(replies, [
      {
        type: "ceremony.resolve-handoff",
        handoffRef: asked.handoffRef,
        runId: asked.runId,
        resolution: "declined",
      },
    ]);
    assert.equal(handoffReplyMessageSchema.safeParse(replies[0]).success, true);
  } finally {
    stop();
    stopPort();
  }
});

test("an attempt reference is required of every published handoff and every reply", () => {
  const { handoffRef, ...withoutRef } = event();
  assert.equal(handoffRef.startsWith("bhof_"), true);
  assert.equal(handoffEventSchema.safeParse(withoutRef).success, false);
  assert.equal(
    handoffEventSchema.safeParse({ ...withoutRef, handoffRef: runId }).success,
    false,
  );
  assert.equal(
    handoffReplyMessageSchema.safeParse({
      type: "ceremony.resolve-handoff",
      runId,
      resolution: "completed",
    }).success,
    false,
  );
});

test("HOF-STALE: a reply to an abandoned attempt cannot settle the next attempt", () => {
  const waits = createHandoffWaits();
  const a = resolver();
  const first = attempt(waits).open([a]);
  // The first ask expires on its own timer; the run then asks again.
  waits.settle(first.handoffRef, "unavailable");
  const second = attempt(waits).open([a]);
  assert.deepEqual(first.outcomes, ["unavailable"]);
  assert.equal(waits.reply(a, reply(first.handoffRef, "completed")), false);
  assert.deepEqual(second.outcomes, []);
  assert.equal(waits.pending(second.handoffRef), true);
  // The live attempt is still answerable by the resolver that holds it.
  assert.equal(waits.reply(a, reply(second.handoffRef, "completed")), true);
  assert.deepEqual(second.outcomes, ["completed"]);
});

test("HOF-PORT: an allowlisted port that was not assigned the attempt cannot settle it", () => {
  const waits = createHandoffWaits();
  const a = resolver();
  const b = resolver();
  const first = attempt(waits).open([a]);
  waits.settle(first.handoffRef, "unavailable");
  const second = attempt(waits).open([a]);
  for (const resolution of ["completed", "declined", "unavailable"] as const)
    assert.equal(waits.reply(b, reply(second.handoffRef, resolution)), false);
  // The assigned resolver quoting the attempt under a run that does not own it
  // is a mismatched pair, not a decision.
  assert.equal(
    waits.reply(
      a,
      reply(
        second.handoffRef,
        "completed",
        "33333333-3333-4333-8333-333333333333",
      ),
    ),
    false,
  );
  assert.deepEqual(second.outcomes, []);
  assert.equal(waits.pending(second.handoffRef), true);
  // B never joined the wait, so A alone still decides and still counts as
  // present: an intruder's message must not have consumed the assignment.
  assert.equal(waits.reply(a, reply(second.handoffRef, "declined")), true);
  assert.deepEqual(second.outcomes, ["declined"]);
});

test("HOF-DUP: racing, duplicated and disconnecting resolvers yield one outcome", () => {
  const waits = createHandoffWaits();
  const a = resolver();
  const b = resolver();
  const raced = attempt(waits).open([a, b]);
  assert.equal(waits.reply(a, reply(raced.handoffRef, "completed")), true);
  assert.equal(waits.reply(b, reply(raced.handoffRef, "declined")), false);
  assert.equal(waits.reply(a, reply(raced.handoffRef, "completed")), false);
  waits.dropPort(b);
  waits.settle(raced.handoffRef, "unavailable");
  assert.deepEqual(raced.outcomes, ["completed"]);

  // One resolver leaving is not an answer while another can still give one.
  const partial = attempt(waits).open([a, b]);
  waits.dropPort(a);
  assert.deepEqual(partial.outcomes, []);
  assert.equal(waits.reply(a, reply(partial.handoffRef, "completed")), false);
  waits.dropPort(b);
  assert.deepEqual(partial.outcomes, ["unavailable"]);
  assert.equal(waits.size, 0);

  // Every assigned resolver declaring itself unavailable is unavailable once.
  const none = attempt(waits).open([a, b]);
  assert.equal(waits.reply(a, reply(none.handoffRef, "unavailable")), false);
  assert.deepEqual(none.outcomes, []);
  assert.equal(waits.reply(b, reply(none.handoffRef, "unavailable")), true);
  assert.deepEqual(none.outcomes, ["unavailable"]);

  // An attempt nobody was assigned cannot wait for an answer that cannot come.
  const unassigned = attempt(waits).open([]);
  assert.deepEqual(unassigned.outcomes, ["unavailable"]);
});

test("an expired attempt's timer cannot settle the attempt that replaced it", () => {
  const waits = createHandoffWaits();
  const a = resolver();
  const first = attempt(waits).open([a]);
  // The timer registered for the first ask fires late, after the second exists.
  const expireFirst = () => waits.settle(first.handoffRef, "unavailable");
  const second = attempt(waits).open([a]);
  // A run waits on one ask at a time, so the replaced one is already retired.
  assert.equal(waits.pending(first.handoffRef), false);
  assert.deepEqual(first.outcomes, ["unavailable"]);
  expireFirst();
  assert.deepEqual(second.outcomes, []);
  assert.equal(waits.pending(second.handoffRef), true);
  // Retired once, not once per late timer.
  assert.deepEqual(first.outcomes, ["unavailable"]);
});

test("an outcome is delivered once even when settling re-enters the registry", () => {
  const waits = createHandoffWaits();
  const a = resolver();
  const handoffRef = mintHandoffRef();
  const outcomes: HandoffResolution[] = [];
  let reentered = false;
  waits.open({
    handoffRef,
    runId,
    resolvers: [a],
    finish: (value) => {
      outcomes.push(value);
      if (reentered) return;
      reentered = true;
      // A clearTimeout that races its own timer, or a disconnect triggered by
      // resuming the run, lands here while the outcome is being delivered.
      assert.equal(waits.settle(handoffRef, "completed"), false);
      assert.equal(waits.reply(a, reply(handoffRef, "completed")), false);
      waits.dropPort(a);
      waits.abandonRun(runId, "unavailable");
    },
  });
  assert.equal(waits.reply(a, reply(handoffRef, "declined")), true);
  assert.deepEqual(outcomes, ["declined"]);
  assert.equal(waits.size, 0);
});

test("cancellation settles the pending attempt and no later reply revives it", () => {
  const waits = createHandoffWaits();
  const a = resolver();
  const other = "22222222-2222-4222-8222-222222222222";
  const mine = attempt(waits).open([a]);
  const theirs = attempt(waits, other).open([a]);
  waits.abandonRun(runId, "unavailable");
  assert.deepEqual(mine.outcomes, ["unavailable"]);
  // Cancelling one run says nothing about another run's ask.
  assert.deepEqual(theirs.outcomes, []);
  // A `completed` arriving after cancellation is what would resume a reserved
  // submission, so the settled attempt must stay settled.
  assert.equal(waits.reply(a, reply(mine.handoffRef, "completed")), false);
  assert.deepEqual(mine.outcomes, ["unavailable"]);
  waits.abandonRun(runId, "unavailable");
  assert.deepEqual(mine.outcomes, ["unavailable"]);
  assert.equal(waits.pending(mine.handoffRef), false);
});

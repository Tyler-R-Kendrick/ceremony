import assert from "node:assert/strict";
import test from "node:test";
import {
  handoffEventSchema,
  offerHandoff,
  type HandoffEvent,
} from "../src/core/browser-contracts.js";
import {
  attachHandoffPort,
  classifyHandoff,
  composedHandoffHooks,
  subscribeHandoffs,
  type HandoffPort,
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

function event(overrides: Partial<HandoffEvent> = {}): HandoffEvent {
  return handoffEventSchema.parse({
    kind: "handoff",
    runId: "11111111-1111-4111-8111-111111111111",
    reason: "passkey-required",
    origin: "https://owned.example",
    attempt: 1,
    ...overrides,
  });
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
  try {
    listeners[0]!({ type: "ceremony.handoff", event: event() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(replies, [
      {
        type: "ceremony.resolve-handoff",
        runId: event().runId,
        resolution: "declined",
      },
    ]);
  } finally {
    stop();
    stopPort();
  }
});

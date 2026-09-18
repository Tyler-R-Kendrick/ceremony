import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type { InvokeResult } from "../../../src/server/connectors/adapter.js";
import type { A2aDelegationOutput } from "../../../src/server/connectors/providers/a2a/index.js";
import {
  CREDENTIAL,
  SKILL,
  activeConnection,
  harness,
  otherActor,
  stringsIn,
  summarizeOperation,
} from "./harness.js";
import { fixtureActor } from "../doubles/ports.js";

const output = (result: InvokeResult) => result.output as A2aDelegationOutput;

test("AG-02: a configured delegation starts a task on the 1.0 wire and reports it by an owner-bound reference", async () => {
  const kit = await harness();
  try {
    const connection = await activeConnection(kit.ports, kit.binding);
    const result = await kit.adapter.delegate!(kit.context({ connection }), {
      action: "start",
      skill: SKILL,
      input: { text: "Summarize the quarterly report." },
      commandId: "cmd-1",
    });
    assert.equal(kit.double.violations.length, 0, kit.double.violations.join("; "));
    assert.equal(result.state, "complete");
    assert.equal(result.effect, "write");
    assert.equal(result.outputClassification, "personal");

    const view = output(result);
    assert.match(view.taskRef, /^a2atask:[a-f0-9]{64}$/);
    assert.equal(view.state, "completed");
    assert.equal(view.artifacts.length, 1);

    // The upstream task id never travels back to the caller.
    const upstream = kit.double.tasks()[0]!;
    assert.doesNotMatch(stringsIn(view).join(" "), new RegExp(upstream.id));
    // Nor does the credential, anywhere.
    assert.doesNotMatch(stringsIn(view).join(" "), new RegExp(CREDENTIAL));

    // The agent double saw the specification's own method name and envelope.
    assert.deepEqual(
      kit.double.rpcCalls.map((call) => call.method),
      ["SendMessage"],
    );
    const sent = kit.double.requests.at(-1)!;
    assert.equal(sent.headers.authorization, `Bearer ${CREDENTIAL}`);

    // The effect was journaled before the call and completed after it.
    const [journalled] = kit.ports.inspect.effects();
    assert.equal(journalled?.intent.operation, "a2a.start:a2a.summarize");
    assert.equal(journalled?.outcome?.status, "applied");
  } finally {
    await kit.close();
  }
});

test("AG-02: the 0.3 profile speaks its own wire and is never mixed with 1.0", async () => {
  const kit = await harness({ double: { profile: "0.3" } });
  try {
    const connection = await activeConnection(kit.ports, kit.binding);
    const result = await kit.adapter.delegate!(kit.context({ connection }), {
      action: "start",
      skill: SKILL,
      input: { text: "Summarize." },
      commandId: "cmd-0.3",
    });
    assert.equal(kit.double.violations.length, 0, kit.double.violations.join("; "));
    assert.equal(result.state, "complete");
    assert.deepEqual(
      kit.double.rpcCalls.map((call) => call.method),
      ["message/send"],
    );
    const body = JSON.parse(kit.double.requests.at(-1)!.body.toString("utf8"));
    assert.equal(body.params.message.role, "user");
    assert.equal(body.params.message.parts[0].kind, "text");
    assert.equal(body.params.configuration.blocking, false);
    assert.ok(!("returnImmediately" in body.params.configuration));
  } finally {
    await kit.close();
  }
});

test("AG-02: an input-required task suspends, resumes on the same reference and then settles", async () => {
  const kit = await harness({ double: { script: { [SKILL]: "input-required" } } });
  try {
    const connection = await activeConnection(kit.ports, kit.binding);
    const started = await kit.adapter.delegate!(kit.context({ connection }), {
      action: "start",
      skill: SKILL,
      input: { text: "Summarize." },
      commandId: "cmd-1",
    });
    assert.equal(started.state, "human-required");
    const view = output(started);
    assert.equal(view.state, "input-required");
    assert.equal(view.awaiting, "input");
    assert.equal(view.prompt, "Which section should I summarize?");

    const status = await kit.adapter.delegate!(kit.context({ connection }), {
      action: "status",
      skill: SKILL,
      input: {},
      taskRef: view.taskRef,
      commandId: "cmd-2",
    });
    assert.equal(output(status).state, "input-required");
    assert.equal(status.effect, "read");

    const answered = await kit.adapter.delegate!(kit.context({ connection }), {
      action: "input",
      skill: SKILL,
      input: { text: "The summary section." },
      taskRef: view.taskRef,
      commandId: "cmd-3",
    });
    assert.equal(answered.state, "complete");
    assert.equal(output(answered).taskRef, view.taskRef);
    assert.equal(kit.double.violations.length, 0, kit.double.violations.join("; "));

    // The continuation carried the upstream task id, which the caller never held.
    const followUp = kit.double.rpcCalls.at(-1)!.params as {
      message: { taskId?: string };
    };
    assert.equal(followUp.message.taskId, kit.double.tasks()[0]!.id);
  } finally {
    await kit.close();
  }
});

test("AG-02: only skills the binding approved may be delegated, whatever the card advertises", async () => {
  const kit = await harness({
    double: { skills: [{ id: "summarize", name: "Summarize" }, { id: "wire-money", name: "Wire money" }] },
  });
  try {
    const connection = await activeConnection(kit.ports, kit.binding);
    for (const [skill, detail] of [
      ["wire-money", "a2a.skill.unapproved"],
      ["summarize.", "a2a.skill.unapproved"],
    ] as const)
      await assert.rejects(
        kit.adapter.delegate!(kit.context({ connection }), {
          action: "start",
          skill,
          input: { text: "go" },
          commandId: `cmd-${skill}`,
        }),
        (error: unknown) =>
          error instanceof ConnectorError &&
          error.code === "denied" &&
          error.detail === detail,
      );
    assert.equal(kit.double.rpcCalls.length, 0, "nothing was sent");
  } finally {
    await kit.close();
  }
});

test("AG-02: an approved skill whose operation is not a matching delegated route is refused", async () => {
  const kit = await harness({
    binding: {
      operations: [
        { ...summarizeOperation, transport: { kind: "delegated", route: "a2a-skill:other" } },
      ],
    },
  });
  try {
    const connection = await activeConnection(kit.ports, kit.binding);
    await assert.rejects(
      kit.adapter.delegate!(kit.context({ connection }), {
        action: "start",
        skill: SKILL,
        input: { text: "go" },
        commandId: "cmd-1",
      }),
      (error: unknown) =>
        error instanceof ConnectorError && error.detail === "a2a.operation.route",
    );
  } finally {
    await kit.close();
  }
});

test("AC-AG-02: cancelling one task never reaches another principal's task", async () => {
  const kit = await harness({ double: { script: { [SKILL]: "input-required" } } });
  try {
    const mine = await activeConnection(kit.ports, kit.binding);
    const theirs = await activeConnection(kit.ports, kit.binding, {
      connectionRef: "conn:a2a-2",
      ownerId: otherActor.subjectId,
    });
    const started = await kit.adapter.delegate!(kit.context({ connection: mine }), {
      action: "start",
      skill: SKILL,
      input: { text: "Mine." },
      commandId: "cmd-mine",
    });
    const theirStart = await kit.adapter.delegate!(
      kit.context({ connection: theirs, actor: otherActor }),
      {
        action: "start",
        skill: SKILL,
        input: { text: "Theirs." },
        commandId: "cmd-theirs",
      },
    );
    const mineRef = output(started).taskRef;
    const theirRef = output(theirStart).taskRef;
    assert.notEqual(mineRef, theirRef);

    // The other principal holds my reference and tries to cancel with it.
    await assert.rejects(
      kit.adapter.delegate!(kit.context({ connection: theirs, actor: otherActor }), {
        action: "cancel",
        skill: SKILL,
        input: {},
        taskRef: mineRef,
        commandId: "cmd-cross",
      }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "not-found" &&
        error.detail === "a2a.task.unknown",
    );
    // Even with the right connection record but the wrong actor.
    await assert.rejects(
      kit.adapter.delegate!(kit.context({ connection: mine, actor: otherActor }), {
        action: "cancel",
        skill: SKILL,
        input: {},
        taskRef: mineRef,
        commandId: "cmd-cross-2",
      }),
      (error: unknown) => error instanceof ConnectorError && error.code === "denied",
    );

    // Neither task was cancelled upstream.
    assert.deepEqual(
      kit.double.tasks().map((task) => task.state),
      ["input-required", "input-required"],
    );
    assert.ok(!kit.double.rpcCalls.some((call) => call.method === "CancelTask"));

    // The owner can still cancel their own, and only their own, task.
    const cancelled = await kit.adapter.delegate!(kit.context({ connection: mine }), {
      action: "cancel",
      skill: SKILL,
      input: {},
      taskRef: mineRef,
      commandId: "cmd-cancel",
    });
    assert.equal(output(cancelled).state, "canceled");
    assert.deepEqual(
      kit.double.tasks().map((task) => task.state),
      ["canceled", "input-required"],
    );
  } finally {
    await kit.close();
  }
});

test("AC-AG-02: a continuation after the connection generation advances is fenced and not sent", async () => {
  const kit = await harness({ double: { script: { [SKILL]: "input-required" } } });
  try {
    const connection = await activeConnection(kit.ports, kit.binding);
    const started = await kit.adapter.delegate!(kit.context({ connection }), {
      action: "start",
      skill: SKILL,
      input: { text: "Summarize." },
      commandId: "cmd-1",
    });
    const taskRef = output(started).taskRef;
    const before = kit.double.rpcCalls.length;
    const reconnected = { ...connection, generation: 1 };
    for (const action of ["status", "input", "cancel"] as const)
      await assert.rejects(
        kit.adapter.delegate!(
          kit.context({ connection: reconnected, generation: 1 }),
          {
            action,
            skill: SKILL,
            input: { text: "still here?" },
            taskRef,
            commandId: `cmd-${action}`,
          },
        ),
        (error: unknown) =>
          error instanceof ConnectorError &&
          error.code === "conflict" &&
          error.detail === "a2a.task.generation",
      );
    assert.equal(kit.double.rpcCalls.length, before, "nothing was sent upstream");
  } finally {
    await kit.close();
  }
});

test("AG-02: a repeated start with the same command id returns the journaled outcome instead of a second task", async () => {
  const kit = await harness();
  try {
    const connection = await activeConnection(kit.ports, kit.binding);
    const request = {
      action: "start" as const,
      skill: SKILL,
      input: { text: "Summarize." },
      commandId: "cmd-same",
    };
    const first = await kit.adapter.delegate!(kit.context({ connection }), request);
    assert.equal(first.state, "complete");
    const second = await kit.adapter.delegate!(kit.context({ connection }), request);
    assert.equal(second.state, "complete");
    assert.equal(second.code, "a2a.effect.already-applied");
    assert.equal(kit.double.tasks().length, 1, "no second task was created");
  } finally {
    await kit.close();
  }
});

test("AG-02: a lost response on a delegation is uncertain, not a failure to retry", async () => {
  const kit = await harness();
  try {
    const connection = await activeConnection(kit.ports, kit.binding);
    const failing: typeof fetch = async () => {
      throw new Error("connection reset");
    };
    const result = await kit.adapter.delegate!(
      kit.context({ connection, fetch: failing }),
      { action: "start", skill: SKILL, input: { text: "go" }, commandId: "cmd-lost" },
    );
    assert.equal(result.state, "indeterminate");
    assert.equal(result.code, "a2a.transport.lost-response");
    const [journalled] = kit.ports.inspect.effects();
    assert.equal(journalled?.outcome?.status, "indeterminate");
  } finally {
    await kit.close();
  }
});

test("AG-02: output and artifact policy decide what the caller sees, and a rejected task is denied", async () => {
  const quiet = await harness({
    binding: { outputPolicy: "none" },
    double: { script: { [SKILL]: "input-required" } },
  });
  try {
    const connection = await activeConnection(quiet.ports, quiet.binding);
    const started = await quiet.adapter.delegate!(quiet.context({ connection }), {
      action: "start",
      skill: SKILL,
      input: { text: "go" },
      commandId: "cmd-1",
    });
    // The agent's own words are withheld; the fact that it is waiting is not.
    assert.equal(output(started).prompt, undefined);
    assert.equal(output(started).awaiting, "input");
  } finally {
    await quiet.close();
  }

  const inline = await harness({ binding: { artifactPolicy: "inline-text" } });
  try {
    const connection = await activeConnection(inline.ports, inline.binding);
    const done = await inline.adapter.delegate!(inline.context({ connection }), {
      action: "start",
      skill: SKILL,
      input: { text: "go" },
      commandId: "cmd-1",
    });
    assert.equal(
      output(done).artifacts[0]?.parts[0]?.text,
      "The document says three things.",
    );
  } finally {
    await inline.close();
  }

  const refused = await harness({ double: { script: { [SKILL]: "reject" } } });
  try {
    const connection = await activeConnection(refused.ports, refused.binding);
    const result = await refused.adapter.delegate!(refused.context({ connection }), {
      action: "start",
      skill: SKILL,
      input: { text: "go" },
      commandId: "cmd-1",
    });
    assert.equal(result.state, "denied");
    assert.equal(output(result).state, "rejected");
  } finally {
    await refused.close();
  }
});

test("AG-02: an inactive connection, a foreign binding and oversized input are refused before anything is sent", async () => {
  const kit = await harness();
  try {
    const inactive = await activeConnection(kit.ports, kit.binding, {
      lifecycle: "reconnect-required",
    });
    await assert.rejects(
      kit.adapter.delegate!(kit.context({ connection: inactive }), {
        action: "start",
        skill: SKILL,
        input: { text: "go" },
        commandId: "cmd-1",
      }),
      (error: unknown) =>
        error instanceof ConnectorError && error.detail === "a2a.connection.inactive",
    );
    const connection = await activeConnection(kit.ports, kit.binding);
    await assert.rejects(
      kit.adapter.delegate!(kit.context({ connection }), {
        action: "start",
        skill: SKILL,
        input: { text: "x".repeat(9000) },
        commandId: "cmd-2",
      }),
      /Too big|too_big|invalid/i,
    );
    // A caller cannot slip transport details in beside the text.
    await assert.rejects(
      kit.adapter.delegate!(kit.context({ connection }), {
        action: "start",
        skill: SKILL,
        input: { text: "go", url: "https://elsewhere.invalid" },
        commandId: "cmd-3",
      }),
      /unrecognized|invalid/i,
    );
    assert.equal(kit.double.rpcCalls.length, 0);
  } finally {
    await kit.close();
  }
});

test("AG-02: an agent that answers without a task leaves nothing to poll or cancel", async () => {
  const kit = await harness({ double: { script: { [SKILL]: "message-only" } } });
  try {
    const connection = await activeConnection(kit.ports, kit.binding);
    const result = await kit.adapter.delegate!(kit.context({ connection }), {
      action: "start",
      skill: SKILL,
      input: { text: "go" },
      commandId: "cmd-1",
    });
    assert.equal(result.state, "complete");
    assert.equal(result.code, "a2a.message.no-task");
    assert.equal(output(result).taskRef, "");
    assert.equal(kit.ports.inspect.handoffs().length, 0);
  } finally {
    await kit.close();
  }
});

test("AG-02: a task reference is protected material, so the upstream id is not recoverable from it", async () => {
  const kit = await harness();
  try {
    const connection = await activeConnection(kit.ports, kit.binding);
    const started = await kit.adapter.delegate!(kit.context({ connection }), {
      action: "start",
      skill: SKILL,
      input: { text: "go" },
      commandId: "cmd-1",
    });
    const [handoff] = kit.ports.inspect.handoffs();
    assert.ok(handoff);
    assert.equal(handoff.intent, "a2a.task");
    assert.equal(handoff.correlationKey, output(started).taskRef);
    // The upstream id lives only in the handoff's protected material.
    assert.equal(handoff.private.taskId, kit.double.tasks()[0]!.id);
    assert.ok(!output(started).taskRef.includes(handoff.private.taskId!));
  } finally {
    await kit.close();
  }
});

test("AG-02: a delegation for a connection that is not this actor's is refused", async () => {
  const kit = await harness();
  try {
    const connection = await activeConnection(kit.ports, kit.binding, {
      ownerId: "somebody-else",
    });
    await assert.rejects(
      kit.adapter.delegate!(kit.context({ connection, actor: fixtureActor }), {
        action: "start",
        skill: SKILL,
        input: { text: "go" },
        commandId: "cmd-1",
      }),
      (error: unknown) =>
        error instanceof ConnectorError && error.detail === "a2a.connection.owner",
    );
  } finally {
    await kit.close();
  }
});

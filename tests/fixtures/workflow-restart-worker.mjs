import { createWorld } from "@workflow/world-local";
import { setWorld } from "@workflow/core/runtime";
import { start, getRun, resumeHook } from "workflow/api";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Actual installed local carrier and generated production handlers. No workflow
// mocks, replacement step handlers, or in-memory state transferred between PIDs.
const world = createWorld({
  dataDir: process.env.CEREMONY_RESTART_DATA,
  recoverActiveRuns: true,
});
// Test-only scheduling fault: hold the actual compiled handler, not its results.
// Workflow 5 has no separate step queue: one combined handler on the workflow
// prefix replays the run and executes its steps, so holding that handler is
// what holds the next real step. Hook acceptance happens in `resumeHook`,
// outside the handler, so a wake can still be delivered while it is held.
let stepGate = Promise.resolve();
let releaseSteps;
let handler;
world.registerHandler("__wkf_workflow_", async (request) => {
  await stepGate;
  handler ??= (
    await import(
      pathToFileURL(join(process.env.CEREMONY_RESTART_BUNDLES, "combined.mjs"))
        .href
    )
  ).POST;
  return handler(request);
});
setWorld(world);
await world.start();
process.send({ ready: true, pid: process.pid });
process.on("message", async (message) => {
  try {
    let result;
    if (message.action === "start") {
      const run = await start({ workflowId: message.workflowId }, [
        message.runId,
        message.sessionId,
      ]);
      result = { workflowRunId: run.runId };
    } else if (message.action === "checkpoint") {
      const events = await world.events.list({
        runId: message.workflowRunId,
        pagination: { limit: 1000 },
        resolveData: "none",
      });
      result = {
        completedSteps: events.data.filter(
          (event) => event.eventType === "step_completed",
        ).length,
      };
    } else if (message.action === "resume") {
      await resumeHook(`ceremony-agent:${message.runId}`, { wake: true });
      result = { accepted: true };
    } else if (message.action === "pause-steps") {
      stepGate = new Promise((resolve) => {
        releaseSteps = resolve;
      });
      result = { paused: true };
    } else if (message.action === "release-steps") {
      releaseSteps?.();
      result = { released: true };
    } else if (message.action === "result") {
      result = { value: await getRun(message.workflowRunId).returnValue };
    } else if (message.action === "close") {
      await world.close();
      process.send({ id: message.id, result: { closed: true } });
      process.disconnect();
      return;
    } else throw new Error("unknown-operation");
    process.send({ id: message.id, result });
  } catch {
    process.send({
      id: message.id,
      errorCode: "WORKFLOW_WORKER_OPERATION_FAILED",
    });
  }
});

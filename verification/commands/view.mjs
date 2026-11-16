// The words the chart and the report use for verification/commands/Commands.tla.
// With one command id (Lifecycle.cfg) the chart is the life of that command.
// With more (Commands.cfg) each chart state names every command and the step.

export const title = "One command for one step of a run";

const inFlight = (worker) => worker === "admitted" || worker === "ran";

const stepRecord = {
  pending: "step not started",
  complete: "step complete and verified",
  waiting: "step waiting for a person or a check",
  failed: "step failed, open to a new command",
  exhausted: "step failed, no attempt left",
  uncertain: "step uncertain",
};

const life = (v, c) => {
  const command = v.cmd[c];
  const worker = v.worker[c];
  if (command === "none")
    return inFlight(worker) ? "Handler work with nothing saved" : "Not sent";
  if (command === "running") {
    if (inFlight(worker)) {
      if (v.lease !== c) return "Worker still going, its lease gone";
      return worker === "admitted"
        ? "Admitted: intent saved, handler not called"
        : "Result in hand, not recorded";
    }
    if (v.runStatus === "cancelled")
      return "Stuck: on record as running, run cancelled";
    if (v.runStatus === "complete")
      return "Stuck: on record as running, run complete";
    return "On record as running, no worker left";
  }
  if (command === "complete") {
    if (v.node === "complete") return "Recorded complete";
    return v.rejected.includes(c)
      ? "Recorded complete, step rejected later"
      : "Recorded complete, but the step no longer is";
  }
  if (command === "uncertain") {
    if (v.node !== "uncertain") return "Uncertain, but the step is open again";
    return v.outbox.includes(c)
      ? "Marked uncertain, reconciliation queued"
      : "Recorded uncertain by its worker";
  }
  if (command === "waiting") return "Recorded waiting for a person or a check";
  return "Recorded failed";
};

const ids = (v) => Object.keys(v.cmd).sort();

// With several commands, an unrecorded command also says whether its handler
// was called: that decides whether a second call is a repeat.
const called = (v, c) =>
  v.cmd[c] === "running" && v.calls[c] > 0 ? ", handler was called" : "";

export const state = (v) => {
  const commands = ids(v);
  if (commands.length === 1) return life(v, commands[0]);
  return [
    ...commands.map((c) => `${c}: ${life(v, c)}${called(v, c)}`),
    stepRecord[v.node],
  ].join(" / ");
};

export const group = (v) => {
  const commands = ids(v);
  if (commands.length !== 1) return undefined;
  const c = commands[0];
  if (v.cmd[c] === "none") return "idle";
  if (v.cmd[c] !== "running") return "recorded";
  return inFlight(v.worker[c]) ? "working" : "recovery";
};

export const colors = {
  idle: "tan",
  working: "blue",
  recovery: "orange",
  recorded: "purple",
};

// The command a step is about: the one whose record or worker changed.
const subject = (from, to) =>
  ids(from).find(
    (c) => from.cmd[c] !== to.cmd[c] || from.worker[c] !== to.worker[c],
  );

const named = (from, to) => {
  const c = subject(from, to);
  return ids(from).length === 1 || c === undefined ? "" : ` (${c})`;
};

const recorded = {
  complete: "complete",
  waiting: "waiting",
  failed: "failed",
  uncertain: "uncertain",
};

export const step = (action, from, to) => {
  const who = named(from, to);
  const c = subject(from, to);
  switch (action) {
    case "Admit":
      return `a caller sends the command${who}`;
    case "CallHandler":
      return `the handler is called and returns${who}`;
    case "HandlerNotCalled":
      return `the call is stopped before the handler${who}`;
    case "WorkerLost":
      return to.runStatus === "cancelled"
        ? `the worker ends without recording${who} [run cancelled]`
        : `the worker dies${who}`;
    case "CommitRefused":
      return to.runStatus === "cancelled"
        ? `the worker ends without recording${who} [run cancelled]`
        : `the late result is refused${who}`;
    case "Commit":
      return `the result is recorded as ${recorded[to.cmd[c]]}${who}`;
    case "Takeover":
      return to.cmd[c] === "uncertain"
        ? `the same id is sent again: marked uncertain${who}`
        : `the same id is sent again: a new worker starts${who}`;
    case "LeaseExpires":
      return "the lease runs out";
    case "CancelRun":
      return "the run is cancelled";
    case "RevalidateStart":
      return "revalidation takes the lease";
    case "RevalidateFinish":
      if (from.node === to.node && from.runRev === to.runRev)
        return "revalidation rejects nothing";
      return from.node === "complete"
        ? "revalidation rejects this step or an earlier one"
        : "revalidation rejects an earlier step";
    case "RevalidationAbandoned":
      return "revalidation gives up";
    default:
      return null;
  }
};

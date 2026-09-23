import { Worker } from "node:worker_threads";

/*
 * Runs one entry of an operation pack's handler bundle in isolation.
 *
 * Containment is the worker, not the `vm` context. `node:vm` is not a
 * security boundary: code in a context that can reach any object from the
 * realm that created it can climb to that realm's `Function` and run with
 * its authority. So the bundle runs in a fresh worker thread (its own heap,
 * with `resourceLimits`, an empty environment and no inherited execArgv),
 * inside a context created from a null-prototype object with string and
 * WebAssembly code generation off, and the host terminates the worker at the
 * deadline whatever it is doing.
 *
 * The one rule the bootstrap below keeps is that only primitives cross into
 * or out of the context. Inputs arrive as JSON text parsed inside the
 * context; results and requests leave as JSON text; the one worker function
 * the context holds (`send`) is captured in a closure the bundle cannot
 * name, checks that every argument is a primitive before touching it, and
 * never returns or throws anything. Nothing the bundle can reach therefore
 * belongs to the worker realm. As a second line, the bootstrap drops the
 * worker realm's `require` and `process` globals before the bundle runs, so
 * even an escape into the worker realm finds no module loader there; the
 * worker is still a thread of the host process, so that is defence in depth,
 * not a boundary, and a pack's publisher key is what the host trusts.
 */

/** CommonJS source of the worker. Kept as text so it runs untransformed. */
const WORKER_SOURCE = String.raw`"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
for (const name of ["require", "module", "exports", "__filename", "__dirname"])
  try { delete globalThis[name]; } catch {}
try {
  Object.defineProperty(globalThis, "process", { value: undefined, configurable: false, writable: false });
} catch {}
const { source, entry, operation, input, outputChars } = workerData;
let finished = false;
const finish = (message) => {
  if (finished) return;
  finished = true;
  parentPort.postMessage(message);
};
function send(kind, id, text) {
  if (typeof kind !== "string" || typeof id !== "number" || typeof text !== "string") return;
  if (kind === "request") parentPort.postMessage({ kind: "request", id, text });
  else if (kind === "done")
    finish(text.length > outputChars ? { kind: "error", reason: "output-too-large" } : { kind: "done", text });
  else if (kind === "error")
    finish({ kind: "error", reason: text === "missing-entry" ? "missing-entry" : "handler-error" });
}
const context = vm.createContext(Object.create(null), {
  name: "operation-pack",
  codeGeneration: { strings: false, wasm: false },
});
const SETUP = ${"`"}(function (send) {
  "use strict";
  const parse = JSON.parse, stringify = JSON.stringify, own = Object.prototype.hasOwnProperty;
  const call = Reflect.apply, freeze = Object.freeze, P = Promise, E = Error;
  const pending = new Map();
  const get = Map.prototype.get, set = Map.prototype.set, remove = Map.prototype.delete;
  let next = 0;
  const ceremony = freeze({
    fetch: freeze(function fetch(request) {
      return new P(function (resolve, reject) {
        let text;
        try { text = stringify(request); } catch (error) { reject(new E("invalid-request")); return; }
        if (typeof text !== "string") { reject(new E("invalid-request")); return; }
        const id = ++next;
        call(set, pending, [id, { resolve, reject }]);
        send("request", id, text);
      });
    }),
  });
  function settle(id, ok, text) {
    const waiter = call(get, pending, [id]);
    if (!waiter) return;
    call(remove, pending, [id]);
    if (ok) waiter.resolve(parse(text));
    else waiter.reject(new E(text));
  }
  function start(entry, name, inputText) {
    let table;
    try { table = typeof operations === "object" && operations !== null ? operations : undefined; } catch (error) {}
    const operation = table && call(own, table, [name]) ? table[name] : undefined;
    const handler = operation && typeof operation[entry] === "function" ? operation[entry] : undefined;
    if (!handler) { send("error", 0, "missing-entry"); return; }
    new P(function (resolve) { resolve(call(handler, undefined, [parse(inputText), ceremony])); }).then(
      function (value) {
        let text;
        try { text = stringify(value === undefined ? null : value); } catch (error) { send("error", 0, ""); return; }
        send("done", 0, typeof text === "string" ? text : "null");
      },
      function () { send("error", 0, ""); },
    );
  }
  return freeze({ start, settle });
})${"`"};
let start, settle;
try {
  const bridge = new vm.Script(SETUP).runInContext(context)(send);
  start = bridge.start;
  settle = bridge.settle;
  new vm.Script(source, { filename: "operation-pack.js" }).runInContext(context, { timeout: workerData.timeoutMs });
} catch {
  finish({ kind: "error", reason: "handler-error" });
}
if (!finished) {
  parentPort.on("message", (message) => {
    if (message && message.kind === "settle" && typeof message.id === "number" && typeof message.text === "string")
      try { settle(message.id, message.ok === true, message.text); } catch {}
  });
  try { start(entry, operation, input); } catch { finish({ kind: "error", reason: "handler-error" }); }
}
`;

export type SandboxFailure =
  | "timeout"
  | "memory"
  | "crashed"
  | "aborted"
  | "handler-error"
  | "missing-entry"
  | "output-too-large";
export type SandboxOutcome =
  { kind: "done"; text: string } | { kind: "error"; reason: SandboxFailure };
/** What the host answers a request with: JSON text, or a fixed refusal code. */
export type SandboxReply =
  { ok: true; text: string } | { ok: false; code: string };

export interface SandboxRun {
  source: string;
  entry: "run" | "verify";
  operation: string;
  /** JSON text of the entry's first argument. */
  input: string;
  timeoutMs: number;
  memoryMb: number;
  outputBytes: number;
  signal: AbortSignal;
  /** Serves one `ceremony.fetch` call; the argument is the handler's JSON. */
  request(text: string): Promise<SandboxReply>;
}

/**
 * Run the entry and settle once: with the handler's JSON result, or with
 * why it produced none. Never rejects, and never carries a handler's own
 * error text, stack or console output back to the host.
 */
export function runInSandbox(run: SandboxRun): Promise<SandboxOutcome> {
  return new Promise((resolve) => {
    if (run.signal.aborted) {
      resolve({ kind: "error", reason: "aborted" });
      return;
    }
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        source: run.source,
        entry: run.entry,
        operation: run.operation,
        input: run.input,
        outputChars: run.outputBytes,
        timeoutMs: run.timeoutMs,
      },
      env: {},
      argv: [],
      execArgv: [],
      stdout: true,
      stderr: true,
      trackUnmanagedFds: true,
      resourceLimits: {
        maxOldGenerationSizeMb: run.memoryMb,
        maxYoungGenerationSizeMb: Math.max(2, Math.floor(run.memoryMb / 4)),
        codeRangeSizeMb: 16,
        stackSizeMb: 2,
      },
    });
    // Whatever the worker writes is discarded, never relayed into host logs.
    worker.stdout.resume();
    worker.stderr.resume();
    let settled = false;
    const settle = (outcome: SandboxOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      run.signal.removeEventListener("abort", abort);
      void worker.terminate();
      resolve(outcome);
    };
    const timer = setTimeout(
      () => settle({ kind: "error", reason: "timeout" }),
      run.timeoutMs,
    );
    const abort = () => settle({ kind: "error", reason: "aborted" });
    run.signal.addEventListener("abort", abort, { once: true });
    worker.on("message", (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const { kind, id, text, reason } = message as Record<string, unknown>;
      if (
        kind === "request" &&
        typeof id === "number" &&
        typeof text === "string"
      ) {
        void run
          .request(text)
          .catch((): SandboxReply => ({ ok: false, code: "unavailable" }))
          .then((reply) => {
            if (settled) return;
            worker.postMessage({
              kind: "settle",
              id,
              ok: reply.ok,
              text: reply.ok ? reply.text : reply.code,
            });
          });
      } else if (kind === "done" && typeof text === "string")
        settle(
          Buffer.byteLength(text) > run.outputBytes
            ? { kind: "error", reason: "output-too-large" }
            : { kind: "done", text },
        );
      else if (kind === "error")
        settle({
          kind: "error",
          reason:
            reason === "missing-entry" || reason === "output-too-large"
              ? reason
              : "handler-error",
        });
    });
    worker.on("error", (error: Error & { code?: string }) =>
      settle({
        kind: "error",
        reason:
          error.code === "ERR_WORKER_OUT_OF_MEMORY" ? "memory" : "crashed",
      }),
    );
    worker.on("exit", () => settle({ kind: "error", reason: "crashed" }));
  });
}

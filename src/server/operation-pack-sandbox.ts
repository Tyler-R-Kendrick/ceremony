import {
  spawn,
  type ChildProcess,
  type Serializable,
} from "node:child_process";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";

/*
 * Runs one entry of an operation pack's handler bundle in isolation.
 *
 * Containment is the worker (or child process), not the `vm` context.
 * `node:vm` is not a security boundary: code in a context that can reach any
 * object from the realm that created it can climb to that realm's `Function`
 * and run with its authority. So the bundle runs in a fresh worker thread
 * (its own heap, with `resourceLimits`, an empty environment and no inherited
 * execArgv) or, in `process` isolation, a fresh Node process under the
 * permission model; inside either, in a context created from a
 * null-prototype object with string and WebAssembly code generation off; and
 * the host kills it at the deadline whatever it is doing.
 *
 * The one rule the bootstrap below keeps is that only primitives cross into
 * or out of the context. Inputs arrive as JSON text parsed inside the
 * context; results and requests leave as JSON text; the one host-realm
 * function the context holds (`send`) is captured in a closure the bundle
 * cannot name and takes only primitive arguments. Context code reaches it
 * only through `relay`, which wraps every call in a try/catch, so a host
 * throw — a stack overflow raised while entering `send` at the edge, for
 * one — is swallowed and turned into a context-realm rejection, never handed
 * back as a value whose constructor chain would give the bundle the outer
 * realm's `Function`. Nothing the bundle can reach therefore belongs to the
 * outer realm. Code generation from strings is off in the context, so even a
 * leaked outer-realm `Function` could not run a string there; the worker
 * realm cannot have that flag set (`--disallow-code-generation-from-strings`
 * is rejected in a Worker's `execArgv`), which is why not leaking the object
 * in the first place is the guarantee, and `process` isolation adds the flag
 * for the child's own realm. As a further line, the bootstrap
 * drops the outer realm's `require`, `process` and `fetch` globals before the
 * bundle runs, so even an escape finds no module loader there. In worker
 * isolation the worker is still a thread of the host process, so that is
 * defence in depth, not a boundary; `process` isolation adds an OS process
 * and the permission model (see `processIsolationArguments`).
 */

/**
 * The shared core: `boot(data, post, listen)` sets up the context, evaluates
 * the bundle and runs one entry. `data` is `{ source, entry, operation,
 * input, outputChars, timeoutMs }`; `post` sends one message to the host;
 * `listen` subscribes to the host's replies. Kept as text so it runs
 * untransformed by any build step.
 */
const CORE = String.raw`
function boot(data, post, listen) {
  const vm = loadVm();
  const { source, entry, operation, input, outputChars, timeoutMs } = data;
  let finished = false;
  const finish = (message) => {
    if (finished) return;
    finished = true;
    post(message);
  };
  function send(kind, id, text) {
    if (typeof kind !== "string" || typeof id !== "number" || typeof text !== "string") return;
    if (kind === "request") post({ kind: "request", id, text });
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
    const call = Reflect.apply, freeze = Object.freeze, keys = Object.keys, P = Promise, E = Error;
    const pending = new Map();
    const get = Map.prototype.get, set = Map.prototype.set, remove = Map.prototype.delete;
    let next = 0;
    // The one call from context code into the host. A host throw here (a
    // stack overflow raised inside 'send' at the edge, say) would otherwise
    // become the outer-realm error the bundle catches, handing it that
    // realm's Function. Every host call goes through this guard, so a host
    // throw is swallowed and only false, never a host object, crosses back.
    function relay(kind, id, text) {
      try { send(kind, id, text); return true; } catch (error) { return false; }
    }
    const ceremony = freeze({
      fetch: freeze(function fetch(request) {
        return new P(function (resolve, reject) {
          let text;
          try { text = stringify(request); } catch (error) { reject(new E("invalid-request")); return; }
          if (typeof text !== "string") { reject(new E("invalid-request")); return; }
          const id = ++next;
          call(set, pending, [id, { resolve, reject }]);
          if (!relay("request", id, text)) {
            call(remove, pending, [id]);
            reject(new E("request-failed"));
          }
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
    function table() {
      try { return typeof operations === "object" && operations !== null ? operations : undefined; } catch (error) { return undefined; }
    }
    function start(entry, name, inputText) {
      const operations = table();
      if (entry === "exports") {
        const found = {};
        if (operations)
          for (const key of keys(operations).slice(0, 64)) {
            const value = operations[key];
            found[key] = {
              run: Boolean(value) && typeof value.run === "function",
              verify: Boolean(value) && typeof value.verify === "function",
            };
          }
        relay("done", 0, stringify(found));
        return;
      }
      const operation = operations && call(own, operations, [name]) ? operations[name] : undefined;
      const handler = operation && typeof operation[entry] === "function" ? operation[entry] : undefined;
      if (!handler) { relay("error", 0, "missing-entry"); return; }
      new P(function (resolve) { resolve(call(handler, undefined, [parse(inputText), ceremony])); }).then(
        function (value) {
          let text;
          try { text = stringify(value === undefined ? null : value); } catch (error) { relay("error", 0, ""); return; }
          relay("done", 0, typeof text === "string" ? text : "null");
        },
        function () { relay("error", 0, ""); },
      );
    }
    return freeze({ start, settle });
  })${"`"};
  let start, settle;
  try {
    const bridge = new vm.Script(SETUP).runInContext(context)(send);
    start = bridge.start;
    settle = bridge.settle;
    new vm.Script(source, { filename: "operation-pack.js" }).runInContext(context, { timeout: timeoutMs });
  } catch {
    finish({ kind: "error", reason: "handler-error" });
  }
  if (finished) return;
  listen((message) => {
    if (message && message.kind === "settle" && typeof message.id === "number" && typeof message.text === "string")
      try { settle(message.id, message.ok === true, message.text); } catch {}
  });
  try { start(entry, operation, input); } catch { finish({ kind: "error", reason: "handler-error" }); }
}
`;

/** Drops the outer realm's loader and ambient globals once the bootstrap holds what it needs. */
const STRIP = String.raw`
for (const name of ["require", "module", "exports", "__filename", "__dirname", "fetch", "WebSocket", "EventSource"])
  try { delete globalThis[name]; } catch {}
try {
  Object.defineProperty(globalThis, "process", { value: undefined, configurable: false, writable: false });
} catch {}
`;

const WORKER_SOURCE = String.raw`"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const vmModule = require("node:vm");
const loadVm = () => vmModule;
${STRIP}
${CORE}
boot(workerData, (message) => parentPort.postMessage(message), (listener) => parentPort.on("message", listener));
`;

/**
 * The child process entry. The first IPC message carries the run; later ones
 * are the host's replies. `process.send` and `process.on` are bound before
 * `process` is removed from the child's global scope.
 */
const CHILD_SOURCE = String.raw`"use strict";
const vmModule = require("node:vm");
const loadVm = () => vmModule;
const post = process.send.bind(process);
const on = process.on.bind(process);
${STRIP}
${CORE}
let booted = false;
const listeners = [];
on("message", (message) => {
  if (booted) {
    for (const listener of listeners) listener(message);
    return;
  }
  booted = true;
  boot(message, post, (listener) => listeners.push(listener));
});
`;

/**
 * Node flags for `process` isolation. `--permission` turns on the permission
 * model; with no `--allow-fs-read`, `--allow-fs-write`,
 * `--allow-child-process`, `--allow-worker`, `--allow-addons` or
 * `--allow-wasi`, the child can read and write no file, start no process or
 * worker, and load no native addon. The bundle arrives over IPC from bytes
 * the host already verified, so the child needs no filesystem read at all,
 * not even of the bundle (reading it again would also reopen the file after
 * its digest was checked). Node 22's permission model has no network
 * permission: `--allow-net` does not exist in this version, so sockets are
 * not restricted by it. What stands between a handler and the network is the
 * `vm` context and the stripped globals, as in worker isolation.
 */
export function processIsolationArguments(memoryMb: number): string[] {
  return [
    "--permission",
    "--disallow-code-generation-from-strings",
    `--max-old-space-size=${memoryMb}`,
  ];
}

export type SandboxFailure =
  | "timeout"
  | "memory"
  | "crashed"
  | "aborted"
  | "busy"
  | "handler-error"
  | "missing-entry"
  | "output-too-large";
export type SandboxOutcome =
  { kind: "done"; text: string } | { kind: "error"; reason: SandboxFailure };
/** What the host answers a request with: JSON text, or a fixed refusal code. */
export type SandboxReply =
  { ok: true; text: string } | { ok: false; code: string };
export type SandboxIsolation = "worker" | "process";

/**
 * Bounds how many sandboxes run at once across every pack a host loaded.
 * Excess invocations wait in a bounded queue for a bounded time; past either
 * bound they are refused as `busy`, which the operation reports as
 * `unavailable`, rather than starting another worker or process.
 */
export class OperationPackLimiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  readonly maxConcurrent: number;
  readonly queueTimeoutMs: number;
  readonly maxQueued: number;
  constructor(
    options: {
      maxConcurrent?: number;
      queueTimeoutMs?: number;
      maxQueued?: number;
    } = {},
  ) {
    this.maxConcurrent =
      options.maxConcurrent ?? Math.max(1, Math.min(8, availableParallelism()));
    this.queueTimeoutMs = options.queueTimeoutMs ?? 5_000;
    this.maxQueued = options.maxQueued ?? 256;
    if (
      !Number.isInteger(this.maxConcurrent) ||
      this.maxConcurrent < 1 ||
      !Number.isInteger(this.maxQueued) ||
      this.maxQueued < 0 ||
      !(this.queueTimeoutMs >= 0)
    )
      throw new Error("Invalid operation pack concurrency");
  }
  /** Sandboxes running now. */
  get running(): number {
    return this.active;
  }
  /** A release function, or why no slot was granted. */
  async acquire(
    signal: AbortSignal,
  ): Promise<(() => void) | "busy" | "aborted"> {
    if (signal.aborted) return "aborted";
    if (this.active < this.maxConcurrent) return this.grant();
    if (this.waiting.length >= this.maxQueued) return "busy";
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        resolve(this.grant());
      };
      const leave = (reason: "busy" | "aborted") => {
        const index = this.waiting.indexOf(wake);
        if (index >= 0) this.waiting.splice(index, 1);
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        resolve(reason);
      };
      const abort = () => leave("aborted");
      const timer = setTimeout(() => leave("busy"), this.queueTimeoutMs);
      signal.addEventListener("abort", abort, { once: true });
      this.waiting.push(wake);
    });
  }
  private grant(): () => void {
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiting.shift()?.();
    };
  }
}

export interface SandboxRun {
  source: string;
  /** `exports` reports which operations the bundle defines, and runs nothing. */
  entry: "run" | "verify" | "exports";
  operation: string;
  /** JSON text of the entry's first argument. */
  input: string;
  timeoutMs: number;
  memoryMb: number;
  outputBytes: number;
  signal: AbortSignal;
  isolation: SandboxIsolation;
  limiter: OperationPackLimiter;
  /** Serves one `ceremony.fetch` call; the argument is the handler's JSON. */
  request(text: string): Promise<SandboxReply>;
}

type Channel = {
  send(message: Record<string, unknown>): void;
  kill(): void;
};

function startWorker(
  run: SandboxRun,
  data: Record<string, unknown>,
  onMessage: (message: unknown) => void,
  onFailure: (reason: SandboxFailure) => void,
): Channel {
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: data,
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
  worker.on("message", onMessage);
  worker.on("error", (error: Error & { code?: string }) =>
    onFailure(error.code === "ERR_WORKER_OUT_OF_MEMORY" ? "memory" : "crashed"),
  );
  worker.on("exit", () => onFailure("crashed"));
  return {
    send: (message) => worker.postMessage(message),
    kill: () => void worker.terminate(),
  };
}

function startProcess(
  run: SandboxRun,
  data: Record<string, unknown>,
  onMessage: (message: unknown) => void,
  onFailure: (reason: SandboxFailure) => void,
): Channel {
  // No shell, no inherited environment or flags; output is discarded and
  // the only channel is JSON over IPC.
  const child: ChildProcess = spawn(
    process.execPath,
    [...processIsolationArguments(run.memoryMb), "-e", CHILD_SOURCE],
    {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
      env: {},
      windowsHide: true,
    },
  );
  child.on("message", onMessage);
  child.on("error", () => onFailure("crashed"));
  child.on("exit", () => onFailure("crashed"));
  child.send(data);
  return {
    send: (message) => {
      if (child.connected) child.send(message as Serializable);
    },
    kill: () => void child.kill("SIGKILL"),
  };
}

/**
 * Run the entry and settle once: with the handler's JSON result, or with
 * why it produced none. Never rejects, and never carries a handler's own
 * error text, stack or console output back to the host.
 */
export async function runInSandbox(run: SandboxRun): Promise<SandboxOutcome> {
  const slot = await run.limiter.acquire(run.signal);
  if (slot === "busy" || slot === "aborted")
    return { kind: "error", reason: slot };
  try {
    return await new Promise<SandboxOutcome>((resolve) => {
      let settled = false;
      let channel: Channel | undefined;
      const settle = (outcome: SandboxOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        run.signal.removeEventListener("abort", abort);
        channel?.kill();
        resolve(outcome);
      };
      const timer = setTimeout(
        () => settle({ kind: "error", reason: "timeout" }),
        run.timeoutMs,
      );
      const abort = () => settle({ kind: "error", reason: "aborted" });
      run.signal.addEventListener("abort", abort, { once: true });
      const onMessage = (message: unknown) => {
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
              channel?.send({
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
      };
      const data = {
        source: run.source,
        entry: run.entry,
        operation: run.operation,
        input: run.input,
        outputChars: run.outputBytes,
        timeoutMs: run.timeoutMs,
      };
      const failure = (reason: SandboxFailure) =>
        settle({ kind: "error", reason });
      channel = (run.isolation === "process" ? startProcess : startWorker)(
        run,
        data,
        onMessage,
        failure,
      );
      if (settled) channel.kill();
    });
  } finally {
    slot();
  }
}

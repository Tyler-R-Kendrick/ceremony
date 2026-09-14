import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { HumanParticipationResult } from "../src/server/browser-driver.js";
import { accountProviders } from "../scripts/gallery-accounts.js";
import { openBrowserSession } from "./browser-session.js";
import { runAgentCeremony } from "./agent-run.js";

/**
 * One run of the agent, as a card sees it.
 *
 * A run is started with a POST and watched over a stream: every step, the
 * browser it is using, each output as it is produced, and every question. The
 * questions come back through their own POSTs — a code, a credential, or the
 * word that a person has finished taking over — and the answer goes into the
 * agent's browser and nowhere else. Outputs travel as references; the value
 * is redeemed once, by the session that started the run.
 */

interface Emitted {
  event: string;
  data: unknown;
}

interface AgentRun {
  owner: string;
  startedAt: number;
  buffer: Emitted[];
  listeners: Set<(entry: Emitted) => void>;
  ask: { resolve(value: string): void } | undefined;
  human: { resolve(result: HumanParticipationResult): void } | undefined;
  secrets: Map<string, string>;
  finished: boolean;
  close?: () => Promise<void>;
}

const startSchema = z.object({
  provider: z.string().min(1).max(40),
  email: z.string().max(320).optional(),
});
const answerSchema = z.object({ value: z.string().min(1).max(4096) });
const humanSchema = z.object({ result: z.enum(["completed", "declined"]) });
const redeemSchema = z.object({ ref: z.string().min(1).max(64) });

/** How long a question waits for a person before the run gives up on it. */
const ASK_TIMEOUT_MS = 10 * 60_000;
/** How long a finished run stays readable. */
const RUN_TTL_MS = 30 * 60_000;

class RouteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 16_384) throw new RouteError(413, "Too large");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RouteError(400, "Invalid JSON");
  }
}

function reply(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

export function createAgentRoutes(options: { issuer: string }) {
  const runs = new Map<string, AgentRun>();

  const emit = (run: AgentRun, event: string, data: unknown) => {
    const entry = { event, data };
    run.buffer.push(entry);
    for (const listener of run.listeners) listener(entry);
  };
  const finish = (run: AgentRun, data: unknown) => {
    emit(run, "done", data);
    run.finished = true;
    for (const listener of run.listeners)
      listener({ event: "end", data: null });
    run.listeners.clear();
    void run.close?.().catch(() => {});
  };
  const sweep = () => {
    const now = Date.now();
    for (const [id, run] of runs)
      if (run.finished && now - run.startedAt > RUN_TTL_MS) runs.delete(id);
  };

  const start = (owner: string, providerId: string, email?: string) => {
    const provider = accountProviders.find(
      (candidate) => candidate.manifest.id === providerId,
    );
    if (!provider) throw new RouteError(404, "Unknown provider");
    const id = randomUUID();
    const run: AgentRun = {
      owner,
      startedAt: Date.now(),
      buffer: [],
      listeners: new Set(),
      ask: undefined,
      human: undefined,
      secrets: new Map(),
      finished: false,
    };
    runs.set(id, run);
    void (async () => {
      try {
        const session = await openBrowserSession();
        run.close = () => session.close();
        const report = await runAgentCeremony({
          provider,
          issuer: options.issuer,
          session,
          ...(email ? { email } : {}),
          onStep: (step) => emit(run, "step", step),
          onSession: (info) => emit(run, "session", info),
          onPhase: (phase) => emit(run, "phase", { phase }),
          onOutput: (output) => {
            const ref = `ref_${randomBytes(12).toString("hex")}`;
            run.secrets.set(ref, output.value);
            emit(run, "output", {
              name: output.name,
              label: output.label,
              ref,
            });
          },
          ask: (role, prompt) =>
            new Promise<string>((resolve, reject) => {
              const timer = setTimeout(() => {
                run.ask = undefined;
                reject(new Error(`Nobody supplied the ${role}`));
              }, ASK_TIMEOUT_MS);
              timer.unref();
              run.ask = {
                resolve: (value) => {
                  clearTimeout(timer);
                  run.ask = undefined;
                  resolve(value);
                },
              };
              emit(run, "ask", { role, prompt });
            }),
          takeOver: (input) =>
            new Promise<HumanParticipationResult>((resolve) => {
              const timer = setTimeout(() => {
                run.human = undefined;
                resolve("unavailable");
              }, ASK_TIMEOUT_MS);
              timer.unref();
              run.human = {
                resolve: (result) => {
                  clearTimeout(timer);
                  run.human = undefined;
                  resolve(result);
                },
              };
              emit(run, "handoff", input);
            }),
        });
        finish(run, {
          identity: report.identity,
          status: report.result.status,
          ...(report.result.status === "blocked"
            ? { reason: report.result.reason }
            : {}),
          steps: report.result.steps,
          handoffs: report.result.handoffs,
          evidence: report.evidence,
        });
      } catch (error) {
        finish(run, {
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return id;
  };

  const owned = (id: string, owner: string): AgentRun => {
    const run = runs.get(id);
    if (!run || run.owner !== owner) throw new RouteError(404, "No such run");
    return run;
  };

  /** Answers whether the request was one of these routes. */
  return async function handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    owner: string,
  ): Promise<boolean> {
    const match =
      /^\/api\/live\/agent(?:\/([a-f0-9-]{36})\/(events|answer|human|redeem))?$/.exec(
        url.pathname,
      );
    if (!match) return false;
    sweep();
    try {
      const [, id, route] = match;
      if (!id) {
        if (request.method !== "POST") throw new RouteError(405, "POST only");
        const body = startSchema.parse(await readJson(request));
        reply(response, 201, { id: start(owner, body.provider, body.email) });
        return true;
      }
      const run = owned(id, owner);
      if (route === "events") {
        if (request.method !== "GET") throw new RouteError(405, "GET only");
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-content-type-options": "nosniff",
        });
        const send = ({ event, data }: Emitted) => {
          response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          if (event === "end") response.end();
        };
        for (const entry of run.buffer) send(entry);
        if (run.finished) {
          send({ event: "end", data: null });
          return true;
        }
        run.listeners.add(send);
        request.on("close", () => run.listeners.delete(send));
        return true;
      }
      if (request.method !== "POST") throw new RouteError(405, "POST only");
      const body = await readJson(request);
      if (route === "answer") {
        // The value goes to the run and nowhere else: not logged, not echoed,
        // not put on the stream.
        const { value } = answerSchema.parse(body);
        if (!run.ask) throw new RouteError(409, "Nothing was asked");
        run.ask.resolve(value);
        reply(response, 202, {});
        return true;
      }
      if (route === "human") {
        const { result } = humanSchema.parse(body);
        if (!run.human) throw new RouteError(409, "Nobody was asked");
        run.human.resolve(result);
        reply(response, 202, {});
        return true;
      }
      const { ref } = redeemSchema.parse(body);
      const value = run.secrets.get(ref);
      if (value === undefined) throw new RouteError(404, "No such reference");
      run.secrets.delete(ref);
      reply(response, 200, { value });
      return true;
    } catch (error) {
      if (error instanceof RouteError)
        reply(response, error.status, { error: error.message });
      else if (error instanceof z.ZodError)
        reply(response, 400, { error: "Invalid request" });
      else reply(response, 500, { error: "Agent route failed" });
      return true;
    }
  };
}

import { createHash } from "node:crypto";
import { ToolLoopAgent, stepCountIs, tool, type LanguageModel } from "ai";
import { z } from "zod";
import type { ActorContext } from "../../core/operation-contracts.js";
import type { ProtectedCommandService } from "../commands.js";
import {
  PersistenceConflict,
  type AsyncCeremonyStore,
} from "../persistence/index.js";
import { AuthorizationError, requireCapability } from "../identity.js";
import { validateAgentText } from "./model.js";

export type AgentStatus =
  | "idle"
  | "running"
  | "awaiting-human"
  | "complete"
  | "stopped"
  | "unavailable"
  | "budget-exhausted"
  | "uncertain";
/**
 * What the model is told when a tool cannot do what it asked. Fixed codes only:
 * the underlying error message may name a provider, a store or a secret-bearing
 * input, and none of that belongs in model context.
 */
export type AgentToolError = "denied" | "invalid" | "conflict" | "transient";
/**
 * Where a person must continue a run the assistant cannot. Built from the same
 * positive-allowlist projection the model sees, plus a same-origin path to the
 * run owner's authenticated human route. The path carries no code, token or
 * query: opening it still requires the owner's own session, so holding the
 * descriptor grants nothing.
 */
export type AgentHandoff = {
  kind: "person";
  runId: string;
  nodeId: string;
  operationId: string;
  nodeState: string;
  reason:
    | "human-step"
    | "verification"
    | "uncertain-outcome"
    | "agent-request"
    | "no-progress";
  /** Present only while the node is awaiting a person; verification and uncertainty have no page to open. */
  path?: string;
};
export type AgentOutcome = { status: AgentStatus; handoff?: AgentHandoff };
type Turn = {
  calls: number;
  tools: number;
  status: AgentStatus;
  handoff?: AgentHandoff;
};
type Budget = {
  calls: number;
  tools: number;
  stopped: boolean;
  turns: Record<string, Turn>;
};
export type AgentCommandPort = Pick<
  ProtectedCommandService,
  "snapshot" | "advance"
>;
type RunView = Awaited<ReturnType<AgentCommandPort["snapshot"]>>;
export interface AgentCoordinatorOptions {
  /** Mount point of the teaching routes; the human route is `<prefix>/<provider>/<run>/human`, for the waiting step's provider. */
  humanRoutePrefix?: string;
}
const empty = (): Budget => ({ calls: 0, tools: 0, stopped: false, turns: {} });
const safeId = z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/);
const waitingStates = ["awaiting-human", "verifying", "uncertain"];
const toolNames = new Set(["advance", "snapshot", "request_human"]);

/** Exhaustive on purpose: an unrecognised failure is reported as transient, never echoed. */
function toolError(error: unknown): AgentToolError {
  if (error instanceof AuthorizationError)
    return error.code === "invalid_request"
      ? "invalid"
      : error.code === "rate_limited"
        ? "transient"
        : "denied";
  if (error instanceof z.ZodError) return "invalid";
  if (error instanceof PersistenceConflict) return "conflict";
  return "transient";
}
/**
 * Re-projects the port's snapshot field by field, so a port that returns more
 * than the allowlist cannot widen model context. Structural identifiers may
 * originate in an imported recipe; public shape alone is not classification.
 */
function project(run: RunView) {
  const view = {
    id: run.id,
    revision: run.revision,
    provider: run.provider,
    profile: run.profile,
    status: run.status,
    nodes: run.nodes.map((node) => ({
      id: node.id,
      operationId: node.operationId,
      operationVersion: node.operationVersion,
      state: node.state,
      verified: node.verified,
      // A step under another connector names whose context it runs in, and
      // so whose page a person uses for it.
      ...(node.provider !== undefined && node.profile !== undefined
        ? { provider: node.provider, profile: node.profile }
        : {}),
    })),
  };
  for (const value of [
    view.id,
    view.provider,
    view.profile,
    ...view.nodes.flatMap((node) => [
      node.id,
      node.operationId,
      node.operationVersion,
      ...(node.provider !== undefined ? [node.provider, node.profile!] : []),
    ]),
  ])
    validateAgentText(value);
  return view;
}
export class AgentCoordinator {
  private readonly humanRoutePrefix: string;
  constructor(
    readonly store: AsyncCeremonyStore,
    readonly commands: AgentCommandPort,
    readonly model?: LanguageModel,
    options: AgentCoordinatorOptions = {},
  ) {
    const prefix = options.humanRoutePrefix ?? "/api/v1/teaching";
    if (!/^(?:\/[A-Za-z0-9_.-]+)+$/.test(prefix))
      throw new Error("Invalid human route prefix");
    this.humanRoutePrefix = prefix;
  }
  private key(actor: ActorContext, runId: string) {
    return {
      tenant: actor.tenantId,
      kind: "budget" as const,
      id: `agent:${safeId.parse(runId)}`,
    };
  }
  private handoffFor(
    run: ReturnType<typeof project>,
    requested?: {
      reason: "agent-request" | "no-progress";
      nodeId?: string;
    },
  ): AgentHandoff | undefined {
    const node = requested?.nodeId
      ? run.nodes.find((candidate) => candidate.id === requested.nodeId)
      : (run.nodes.find((candidate) =>
          waitingStates.includes(candidate.state),
        ) ??
        (requested
          ? run.nodes.find((candidate) => !candidate.verified)
          : undefined));
    if (!node) return undefined;
    return {
      kind: "person",
      runId: run.id,
      nodeId: node.id,
      operationId: node.operationId,
      nodeState: node.state,
      reason:
        requested?.reason === "agent-request"
          ? "agent-request"
          : node.state === "awaiting-human"
            ? "human-step"
            : node.state === "verifying"
              ? "verification"
              : node.state === "uncertain"
                ? "uncertain-outcome"
                : "no-progress",
      ...(node.state === "awaiting-human"
        ? {
            // The waiting step's own provider: a step planned under another
            // connector waits on that provider's page, not the run's.
            path: `${this.humanRoutePrefix}/${encodeURIComponent(node.provider ?? run.provider)}/${encodeURIComponent(run.id)}/human`,
          }
        : {}),
    };
  }
  async status(actor: ActorContext, runId: string, turnId?: string) {
    const run = await this.commands.snapshot(actor, runId);
    const budget = await this.store.transaction((tx) =>
      tx.get<Budget>(this.key(actor, runId)),
    );
    const turn =
      budget?.value.turns[
        turnId ?? Object.keys(budget?.value.turns ?? {}).at(-1) ?? ""
      ];
    const status =
      run.status === "cancelled" || budget?.value.stopped
        ? ("stopped" as const)
        : run.status === "complete"
          ? ("complete" as const)
          : (turn?.status ?? ("idle" as const));
    return {
      status,
      calls: budget?.value.calls ?? 0,
      tools: budget?.value.tools ?? 0,
      ...((status === "awaiting-human" || status === "uncertain") &&
      turn?.handoff
        ? { handoff: turn.handoff }
        : {}),
    };
  }
  async stop(actor: ActorContext, runId: string) {
    requireCapability(actor, "executor");
    await this.commands.snapshot(actor, runId);
    await this.store.transaction(async (tx) => {
      const key = this.key(actor, runId),
        prior = await tx.get<Budget>(key);
      await tx.put(
        key,
        { ...(prior?.value ?? empty()), stopped: true },
        prior?.revision ?? null,
      );
    });
  }
  private async update(
    actor: ActorContext,
    runId: string,
    turnId: string,
    calls: number,
    tools: number,
    status?: AgentStatus,
    handoff?: AgentHandoff,
  ) {
    const admitted = await this.store.transaction(async (tx) => {
      const key = this.key(actor, runId),
        prior = await tx.get<Budget>(key);
      const value = prior?.value ?? empty();
      const turn: Turn = value.turns[turnId] ?? {
        calls: 0,
        tools: 0,
        status: "idle",
      };
      if (value.stopped) throw new Error("stopped");
      if (status === "running" && turn.status !== "idle")
        throw new Error("uncertain");
      const exceeded =
        value.calls + calls > 16 ||
        value.tools + tools > 64 ||
        turn.tools + tools > 8 ||
        Object.keys(value.turns).length > 64;
      if (!exceeded) value.calls += calls;
      // Count every emitted request, including rejected over-budget batches. No tool executes them.
      value.tools += tools;
      if (!exceeded) turn.calls += calls;
      turn.tools += tools;
      if (exceeded) turn.status = "budget-exhausted";
      else if (status) {
        turn.status = status;
        if (handoff) turn.handoff = handoff;
        else delete turn.handoff;
      }
      value.turns[turnId] = turn;
      await tx.put(key, value, prior?.revision ?? null);
      return !exceeded;
    });
    if (!admitted) throw new Error("budget-exhausted");
  }
  /** Receives no narration, secret fields, URLs, broker handles or user-authored transcript. */
  async turn(
    actor: ActorContext,
    runId: string,
    turnId: string,
  ): Promise<AgentStatus> {
    return (await this.turnOutcome(actor, runId, turnId)).status;
  }
  /**
   * The same turn, returning the person-bound handoff when it ends waiting on
   * someone. Workflow history keeps using `turn`, which records only the enum.
   */
  async turnOutcome(
    actor: ActorContext,
    runId: string,
    turnId: string,
  ): Promise<AgentOutcome> {
    safeId.parse(turnId);
    requireCapability(actor, "executor");
    const initial = await this.commands.snapshot(actor, runId);
    if (initial.status === "complete") return { status: "complete" };
    if (initial.status === "cancelled") return { status: "stopped" };
    const existing = await this.status(actor, runId, turnId);
    if (existing.status === "stopped") return { status: "stopped" };
    if (initial.nodes.some((node) => waitingStates.includes(node.state))) {
      const handoff = this.handoffFor(project(initial));
      await this.update(actor, runId, turnId, 0, 0, "awaiting-human", handoff);
      return { status: "awaiting-human", ...(handoff ? { handoff } : {}) };
    }
    if (!this.model) return { status: "unavailable" };
    if (existing.status !== "idle")
      return existing.status === "running"
        ? { status: "uncertain" }
        : {
            status: existing.status,
            ...("handoff" in existing ? { handoff: existing.handoff } : {}),
          };
    try {
      await this.update(actor, runId, turnId, 0, 0, "running");
    } catch {
      return { status: "uncertain" };
    }
    // Tools mutate this from closures, which control-flow narrowing cannot see.
    let terminal = "idle" as AgentStatus;
    let handoff: AgentHandoff | undefined;
    // Every tool rechecks the durable stop flag and budget before it acts.
    const admit = async () => {
      if (terminal !== "idle") return false;
      await this.update(actor, runId, turnId, 0, 0);
      return true;
    };
    // Calls emitted in one step run one at a time, in emission order, so a
    // wait reached by one call is seen by the next rather than raced.
    let queue: Promise<unknown> = Promise.resolve();
    const serially = <T>(work: () => Promise<T>): Promise<T> => {
      const next = queue.then(work);
      queue = next.catch(() => undefined);
      return next;
    };
    const agent = new ToolLoopAgent({
      model: this.model,
      maxRetries: 0,
      maxOutputTokens: 1000,
      instructions:
        "Complete the already-authorized connection using only the provided tools. Use exact pending node IDs and the revision from state. Tool errors are fixed codes: after denied or invalid do not repeat the same call; after conflict or transient re-read state before any retry. Call request_human for a node that needs the person or that you cannot advance. Stop at any human wait, verification wait, uncertainty, or completion. Never infer permission or invent inputs.",
      tools: {
        advance: tool({
          description:
            "Advance a registered node using server-pinned authorized bindings. Human waits are not approvals.",
          inputSchema: z.strictObject({
            nodeId: safeId,
            expectedRevision: z.number().int().min(1),
          }),
          execute: (input, options) =>
            serially(async () => {
              if (!(await admit())) return { error: "turn-ended" as const };
              const commandId = `agent:${createHash("sha256")
                .update(JSON.stringify([runId, turnId, options.toolCallId]))
                .digest("hex")}`;
              let result;
              try {
                result = await this.commands.advance(
                  { ...actor, actorKind: "agent" },
                  runId,
                  input.nodeId,
                  input.expectedRevision,
                  commandId,
                );
              } catch (error) {
                return { error: toolError(error) };
              }
              if (
                result.state === "awaiting-human" ||
                result.state === "verifying"
              )
                terminal = "awaiting-human";
              if (result.state === "uncertain") terminal = "uncertain";
              if (
                (await this.commands.snapshot(actor, runId)).status ===
                "complete"
              )
                terminal = "complete";
              return {
                state: result.state,
                verified: result.verified,
                revision: result.revision,
              };
            }),
        }),
        snapshot: tool({
          description:
            "Read the current run state: node IDs, operations, states, verification and revision. Read-only.",
          inputSchema: z.strictObject({}),
          execute: () =>
            serially(async () => {
              if (!(await admit())) return { error: "turn-ended" as const };
              return {
                run: project(await this.commands.snapshot(actor, runId)),
              };
            }),
        }),
        request_human: tool({
          description:
            "Hand an unverified node to the person who owns this run and end the turn. Grants nothing and approves nothing.",
          inputSchema: z.strictObject({ nodeId: safeId }),
          execute: (input) =>
            serially(async () => {
              if (!(await admit())) return { error: "turn-ended" as const };
              const run = project(await this.commands.snapshot(actor, runId));
              if (
                !run.nodes.some(
                  (node) => node.id === input.nodeId && !node.verified,
                )
              )
                return { error: "invalid" as const };
              handoff = this.handoffFor(run, {
                reason: "agent-request",
                nodeId: input.nodeId,
              });
              terminal = "awaiting-human";
              return { state: "awaiting-human" as const, handoff: "recorded" };
            }),
        }),
      },
      prepareStep: async ({ steps }) => {
        await this.update(actor, runId, turnId, 1, 0);
        const run = project(await this.commands.snapshot(actor, runId));
        // Only coordinator-built tool outputs and fixed codes carry forward.
        // A rejected call's error (bad input, invented tool) is never echoed,
        // nor is an invented tool name.
        const results = (steps.at(-1)?.content ?? []).flatMap<{
          tool: string;
          output?: unknown;
          error?: string;
        }>((part) =>
          part.type === "tool-result"
            ? [
                {
                  tool: part.toolName,
                  output:
                    part.toolName === "snapshot" ? "current" : part.output,
                },
              ]
            : part.type === "tool-error"
              ? [
                  {
                    tool: toolNames.has(part.toolName)
                      ? part.toolName
                      : "unknown",
                    error: "invalid",
                  },
                ]
              : [],
        );
        return {
          messages: [
            {
              role: "user" as const,
              content: JSON.stringify({ run, results }),
            },
          ],
        };
      },
      onLanguageModelCallEnd: async (event) => {
        await this.update(
          actor,
          runId,
          turnId,
          0,
          event.content.filter((part) => part.type === "tool-call").length,
        );
      },
      stopWhen: [stepCountIs(8), () => terminal !== "idle"],
      telemetry: { isEnabled: false },
    });
    try {
      await agent.generate({
        prompt: "Connect this service using the trusted current state.",
        abortSignal: AbortSignal.timeout(30000),
      });
      const final = project(await this.commands.snapshot(actor, runId));
      if (final.status === "complete") {
        terminal = "complete";
        handoff = undefined;
      }
      if (terminal === "idle") terminal = "awaiting-human";
      if (terminal === "awaiting-human" || terminal === "uncertain")
        handoff ??= this.handoffFor(final, { reason: "no-progress" });
    } catch {
      handoff = undefined;
      const state = (await this.status(actor, runId, turnId)).status;
      terminal =
        state === "stopped" || state === "budget-exhausted"
          ? state
          : "unavailable";
    }
    if (terminal !== "stopped" && terminal !== "budget-exhausted")
      await this.update(actor, runId, turnId, 0, 0, terminal, handoff);
    return { status: terminal, ...(handoff ? { handoff } : {}) };
  }
}

import { createHash } from "node:crypto";
import { ToolLoopAgent, stepCountIs, tool, type LanguageModel } from "ai";
import { z } from "zod";
import type { ActorContext } from "../../core/operation-contracts.js";
import type { ProtectedCommandService } from "../commands.js";
import type { AsyncCeremonyStore } from "../persistence/index.js";
import { requireCapability } from "../identity.js";

export type AgentStatus =
  | "idle"
  | "running"
  | "awaiting-human"
  | "complete"
  | "stopped"
  | "unavailable"
  | "budget-exhausted"
  | "uncertain";
type Budget = {
  calls: number;
  tools: number;
  stopped: boolean;
  turns: Record<string, { calls: number; tools: number; status: AgentStatus }>;
};
export type AgentCommandPort = Pick<
  ProtectedCommandService,
  "snapshot" | "advance"
>;
const empty = (): Budget => ({ calls: 0, tools: 0, stopped: false, turns: {} });
const safeId = z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/);
export class AgentCoordinator {
  constructor(
    readonly store: AsyncCeremonyStore,
    readonly commands: AgentCommandPort,
    readonly model?: LanguageModel,
  ) {}
  private key(actor: ActorContext, runId: string) {
    return {
      tenant: actor.tenantId,
      kind: "budget" as const,
      id: `agent:${safeId.parse(runId)}`,
    };
  }
  async status(actor: ActorContext, runId: string, turnId: string) {
    await this.commands.snapshot(actor, runId);
    const budget = await this.store.transaction((tx) =>
      tx.get<Budget>(this.key(actor, runId)),
    );
    return {
      status: budget?.value.stopped
        ? ("stopped" as const)
        : (budget?.value.turns[turnId]?.status ?? ("idle" as const)),
      calls: budget?.value.calls ?? 0,
      tools: budget?.value.tools ?? 0,
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
  ) {
    const admitted = await this.store.transaction(async (tx) => {
      const key = this.key(actor, runId),
        prior = await tx.get<Budget>(key);
      const value = prior?.value ?? empty();
      const turn = value.turns[turnId] ?? {
        calls: 0,
        tools: 0,
        status: "idle" as AgentStatus,
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
      else if (status) turn.status = status;
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
    safeId.parse(turnId);
    requireCapability(actor, "executor");
    const initial = await this.commands.snapshot(actor, runId);
    if (initial.status === "complete") return "complete";
    if (initial.status === "cancelled") return "stopped";
    const existing = await this.status(actor, runId, turnId);
    if (existing.status === "stopped") return "stopped";
    if (
      initial.nodes.some((node) =>
        ["awaiting-human", "verifying", "uncertain"].includes(node.state),
      )
    )
      return "awaiting-human";
    if (!this.model) return "unavailable";
    if (existing.status !== "idle")
      return existing.status === "running" ? "uncertain" : existing.status;
    try {
      await this.update(actor, runId, turnId, 0, 0, "running");
    } catch {
      return "uncertain";
    }
    let terminal: AgentStatus = "idle";
    const agent = new ToolLoopAgent({
      model: this.model,
      maxRetries: 0,
      maxOutputTokens: 1000,
      instructions:
        "Complete the already-authorized connection using only advance. Use exact pending node IDs and revision from state. Stop at any human wait, verification wait, uncertainty, or completion. Never infer permission or invent inputs.",
      tools: {
        advance: tool({
          description:
            "Advance a registered node using server-pinned authorized bindings. Human waits are not approvals.",
          inputSchema: z.strictObject({
            nodeId: safeId,
            expectedRevision: z.number().int().min(1),
          }),
          execute: async (input, options) => {
            if (terminal !== "idle")
              return { state: "awaiting-human", verified: false };
            await this.update(actor, runId, turnId, 0, 0);
            const commandId = `agent:${createHash("sha256")
              .update(JSON.stringify([runId, turnId, options.toolCallId]))
              .digest("hex")}`;
            try {
              const result = await this.commands.advance(
                { ...actor, actorKind: "agent" },
                runId,
                input.nodeId,
                input.expectedRevision,
                commandId,
              );
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
            } catch {
              return { state: "denied", verified: false };
            }
          },
        }),
      },
      prepareStep: async () => {
        await this.update(actor, runId, turnId, 1, 0);
        const snapshot = await this.commands.snapshot(actor, runId);
        return {
          messages: [
            { role: "user" as const, content: JSON.stringify(snapshot) },
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
      const snapshot = await this.commands.snapshot(actor, runId);
      if (snapshot.status === "complete") terminal = "complete";
      if (terminal === "idle") terminal = "awaiting-human";
    } catch {
      const state = (await this.status(actor, runId, turnId)).status;
      terminal =
        state === "stopped" || state === "budget-exhausted"
          ? state
          : "unavailable";
    }
    if (terminal !== "stopped" && terminal !== "budget-exhausted")
      await this.update(actor, runId, turnId, 0, 0, terminal);
    return terminal;
  }
}

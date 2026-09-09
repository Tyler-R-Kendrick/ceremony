import { z } from "zod";
import type { CeremonyTool } from "./webmcp.js";

const safeState = z.strictObject({
  id: z.string().max(120),
  revision: z.number().int().positive(),
  provider: z.string().max(100),
  profile: z.string().max(100),
  status: z.enum(["active", "cancelled", "complete"]),
  nodes: z
    .array(
      z.strictObject({
        id: z.string().max(120),
        operationId: z.string().max(100),
        operationVersion: z.string().max(30),
        state: z.enum([
          "pending",
          "running",
          "complete",
          "awaiting-human",
          "verifying",
          "uncertain",
          "failed",
        ]),
        verified: z.boolean(),
      }),
    )
    .max(32),
});
export type ConnectionState = z.infer<typeof safeState>;
export interface ProtectedConnectionTransport {
  connect?(): Promise<ConnectionState>;
  snapshot(): Promise<ConnectionState>;
  advance(
    nodeId: string,
    revision: number,
    commandId: string,
  ): Promise<ConnectionState>;
  cancel(revision: number): Promise<ConnectionState>;
}
/** Same definitions for native WebMCP and in-app registries; all authority remains on the server. */
export function createConnectionTools(
  prefix: string,
  transport: ProtectedConnectionTransport,
): CeremonyTool[] {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(prefix))
    throw new Error("Invalid tool prefix");
  const definitions = [
    {
      action: "connect",
      schema: z.strictObject({}),
      description:
        "Connect using the authenticated host context. Missing setup or consent returns a human blocker.",
    },
    {
      action: "snapshot",
      schema: z.strictObject({}),
      description: "Read trusted connection status without provider polling.",
    },
    {
      action: "advance",
      schema: z.strictObject({
        nodeId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.:-]{0,95}$/),
        revision: z.number().int().positive(),
        commandId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.:-]{0,95}$/),
      }),
      description:
        "Advance an authorized registered node with its server-owned bindings. Human consent and verification cannot be supplied as arguments.",
    },
    {
      action: "cancel",
      schema: z.strictObject({ revision: z.number().int().positive() }),
      description:
        "Cancel local connection work. Does not revoke upstream access.",
    },
  ] as const;
  return definitions.map((definition) => ({
    name: `${prefix}_${definition.action}`,
    description: definition.description,
    inputSchema: z.toJSONSchema(definition.schema),
    annotations: {
      readOnlyHint: definition.action === "snapshot",
      consequentialHint: definition.action !== "snapshot",
      untrustedContentHint: false,
    },
    execute: async (input, options) => {
      try {
        options?.signal.throwIfAborted();
        const parsed = definition.schema.parse(input);
        let state: ConnectionState;
        if (definition.action === "connect" && transport.connect)
          state = await transport.connect();
        else if (definition.action === "snapshot")
          state = await transport.snapshot();
        else if (
          "nodeId" in parsed &&
          typeof parsed.nodeId === "string" &&
          typeof parsed.revision === "number" &&
          typeof parsed.commandId === "string"
        )
          state = await transport.advance(
            parsed.nodeId,
            parsed.revision,
            parsed.commandId,
          );
        else if ("revision" in parsed && typeof parsed.revision === "number")
          state = await transport.cancel(parsed.revision);
        else throw new Error("Invalid command");
        options?.signal.throwIfAborted();
        return { ok: true, state: safeState.parse(state) };
      } catch {
        return { ok: false, error: "denied-or-unavailable" };
      }
    },
  }));
}

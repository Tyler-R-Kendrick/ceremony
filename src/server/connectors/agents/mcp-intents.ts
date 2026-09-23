import type { McpServer } from "@modelcontextprotocol/server";
import type { ActorContext } from "../../../core/operation-contracts.js";
import { explainConnectorError } from "../errors.js";
import {
  agentIntentInputs,
  createAgentConnectorIntents,
  type AgentConnectorDependencies,
  type AgentIntent,
  type AgentIntentName,
} from "./intents.js";

/*
 * The seven safe connector intents on the existing Ceremony MCP server.
 *
 * This is additive twice over. The five ceremony tools are untouched, and so
 * are the four connector tools the MCP swarm already registers
 * (`connector_catalog`, `connector_status`, `connector_connect`,
 * `connector_invoke`): any intent whose name the caller reports as taken is
 * skipped rather than re-registered, so mounting this beside them adds
 * `connector_list`, `connector_inspect`, `connector_operations`,
 * `connector_reconnect` and `connector_disconnect` and changes nothing else.
 * Mounted without them, `connector_status` and `connector_connect` are the
 * intents' own. A name is skipped only when something really holds it: a
 * tool skipped for a neighbour that was never mounted is simply missing.
 *
 * The rules are the same two as everywhere on that server: the actor comes
 * from the host's `authenticate` path and never from an argument, and nothing
 * a model can read carries a credential, a destination or a handoff URL.
 */

export type AgentIntentContext = {
  /** The actor for the current request, resolved by the host's authenticate path. */
  actor(): ActorContext | undefined;
  onerror?(error: Error): void;
  /**
   * Names already registered on this server; those intents are skipped. The
   * caller says what it mounted, and nothing else is assumed to be present.
   */
  taken?: readonly string[];
};

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function refusal(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

/**
 * Registers the intents this server does not already offer. Returns the names
 * it added, so a deployment can report its tool surface without guessing.
 */
export function registerAgentConnectorTools(
  server: McpServer,
  deps: AgentConnectorDependencies,
  context: AgentIntentContext,
  options: { prefix?: string; intents?: readonly AgentIntentName[] } = {},
): string[] {
  const taken = new Set(context.taken ?? []);
  const wanted = options.intents;
  const intents = createAgentConnectorIntents(deps, {
    ...(options.prefix ? { prefix: options.prefix } : {}),
  }).filter(
    (intent) =>
      !taken.has(intent.name) &&
      (wanted === undefined || wanted.includes(intent.intent)),
  );
  const added: string[] = [];
  for (const intent of intents) {
    registerOne(server, intent, context);
    added.push(intent.name);
  }
  return added;
}

function registerOne(
  server: McpServer,
  intent: AgentIntent,
  context: AgentIntentContext,
): void {
  server.registerTool(
    intent.name,
    {
      description: intent.description,
      inputSchema: agentIntentInputs[intent.intent],
      annotations: {
        readOnlyHint: intent.readOnly,
        // Only disconnect removes anything. Connect and reconnect add or
        // restore access, which a client should still confirm, but they are
        // not destructive.
        destructiveHint: intent.intent === "disconnect",
      },
    },
    async (input: unknown) => {
      const actor = context.actor();
      if (!actor) return refusal("Sign in to the ceremony application first.");
      try {
        return text(await intent.run(actor, input ?? {}));
      } catch (error) {
        context.onerror?.(
          error instanceof Error ? error : new Error(String(error)),
        );
        return refusal(explainConnectorError(error).message);
      }
    },
  );
}

/** The intent names this module adds beside the four connector tools already present. */
export const agentConnectorToolNames = [
  "connector_list",
  "connector_inspect",
  "connector_operations",
  "connector_reconnect",
  "connector_disconnect",
] as const;

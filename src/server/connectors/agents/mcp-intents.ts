import type { McpServer } from "@modelcontextprotocol/server";
import type { ActorContext } from "../../../core/operation-contracts.js";
import { explainConnectorError } from "../errors.js";
import { connectorHandoffViews } from "../mcp/server-tools.js";
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
 * This is additive twice over. The ceremony tools are untouched, and so are
 * the connector tools the host may already have registered
 * (`connector_catalog`, `connector_status`, `connector_connect`,
 * `connector_invoke`, and `connector_verify` and `connector_revoke_request`
 * where offered): any intent whose name the caller reports as taken is
 * skipped rather than re-registered, so mounting this beside them adds
 * `connector_list`, `connector_inspect`, `connector_operations`,
 * `connector_reconnect` and `connector_disconnect` and changes nothing else.
 * Mounted without them, `connector_status` and `connector_connect` are the
 * intents' own. A name is skipped only when something really holds it: a
 * tool skipped for a neighbour that was never mounted is simply missing.
 *
 * The rules are the same two as everywhere on that server: the actor comes
 * from the host's `authenticate` path and never from an argument, and nothing
 * a model can read carries a credential, a destination or a provider link.
 * A handoff that waits on a person gains the same `path` the connector tools
 * give it, the owner's page for that connection in this application, so an
 * assistant that reconnects through an intent is not left with only
 * "waiting".
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
  /** Same-origin mount of the owner's connection page; defaults to `/connectors`. */
  humanRoute?: string;
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
  const { handoffView } = connectorHandoffViews(context.humanRoute);
  const added: string[] = [];
  for (const intent of intents) {
    registerOne(server, intent, context, handoffView);
    added.push(intent.name);
  }
  return added;
}

type HandoffView = ReturnType<typeof connectorHandoffViews>["handoffView"];

type ProjectedConnection = {
  connectionRef: string;
  handoff?: { kind: string; state: string };
};

/** Adds the owner's page path to a projected connection's waiting handoff. */
function withPersonPath(value: unknown, view: HandoffView): unknown {
  const one = (connection: ProjectedConnection) =>
    connection.handoff
      ? { ...connection, ...view(connection.connectionRef, connection.handoff) }
      : connection;
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.connections))
    return {
      ...record,
      connections: (record.connections as ProjectedConnection[]).map(one),
    };
  if (typeof record.connectionRef === "string" && record.handoff)
    return one(record as ProjectedConnection);
  return value;
}

function registerOne(
  server: McpServer,
  intent: AgentIntent,
  context: AgentIntentContext,
  handoffView: HandoffView,
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
        return text(
          withPersonPath(await intent.run(actor, input ?? {}), handoffView),
        );
      } catch (error) {
        context.onerror?.(
          error instanceof Error ? error : new Error(String(error)),
        );
        return refusal(explainConnectorError(error).message);
      }
    },
  );
}

/** The intent names this module adds beside the connector tools, when those are present. */
export const agentConnectorToolNames = [
  "connector_list",
  "connector_inspect",
  "connector_operations",
  "connector_reconnect",
  "connector_disconnect",
] as const;

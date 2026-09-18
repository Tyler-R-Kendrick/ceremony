import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  agentConnectorProjection,
  publicCatalogProjection,
  type CatalogEntry,
  type ConnectionSummary,
  type ConnectorHandoffSummary,
} from "../../../core/connectors/index.js";
import type { ActorContext } from "../../../core/operation-contracts.js";
import { explainConnectorError } from "../errors.js";

/*
 * Connector tools on the existing Ceremony MCP server.
 *
 * These four tools are added beside the five that were already there; nothing
 * about those changes. They obey the same two rules as the rest of that file:
 * the actor comes from the host's `authenticate` path and never from an
 * argument, and nothing a model can read carries a credential, a destination
 * or a handoff URL. `connector_connect` returns the kind and state of a
 * handoff so an assistant can tell a person that their attention is needed;
 * where to go is shown to that person by the application, through the human
 * projection, and never here.
 */

export type ConnectorConnectInput = {
  connectorId: string;
  /** Explicit intent to replace a verified account; never inferred. */
  accountSwitch?: boolean;
  /** Policy constraint from the caller; "none" can only yield human-required. */
  interruption?: "allowed" | "none";
};

export type ConnectorInvokeInput = {
  connectionRef: string;
  operationRef: string;
  input: unknown;
  commandId: string;
};

export type ConnectorInvokeOutput = {
  state: "complete" | "failed" | "indeterminate" | "human-required" | "denied";
  outputClassification: "public" | "personal" | "secret";
  effect: "read" | "write" | "unknown";
  /** Present only when the operation's output classification permits a model to see it. */
  output?: unknown;
  code?: string;
  handoff?: { kind: ConnectorHandoffSummary["kind"]; state: ConnectorHandoffSummary["state"] };
};

export type ConnectorConnectOutput = {
  connectionRef: string;
  lifecycle: ConnectionSummary["lifecycle"];
  handoff?: { kind: ConnectorHandoffSummary["kind"]; state: ConnectorHandoffSummary["state"] };
};

/**
 * What the command layer must provide. Every method takes the authenticated
 * actor as its first argument: this module has no other way to name one, and
 * the service is expected to re-check capability, ownership, generation and
 * policy itself rather than trusting that these tools did.
 */
export interface ConnectorToolDependencies {
  catalog(actor: ActorContext): Promise<CatalogEntry[]>;
  status(actor: ActorContext, connectionRef: string): Promise<ConnectionSummary | undefined>;
  connect(actor: ActorContext, input: ConnectorConnectInput): Promise<ConnectorConnectOutput>;
  invoke(actor: ActorContext, input: ConnectorInvokeInput): Promise<ConnectorInvokeOutput>;
}

export interface ConnectorToolContext {
  /** The actor for the current request, resolved by the host's authenticate path. */
  actor(): ActorContext | undefined;
  onerror?(error: Error): void;
}

const identifier = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]*$/);

export const connectorToolInputs = {
  catalog: z.strictObject({}),
  status: z.strictObject({ connectionRef: identifier }),
  connect: z.strictObject({
    connectorId: identifier.describe("A connector this deployment offers, from connector_catalog."),
    accountSwitch: z
      .boolean()
      .optional()
      .describe("Only when a person has said they want to change the connected account."),
    interruption: z.enum(["allowed", "none"]).optional(),
  }),
  invoke: z.strictObject({
    connectionRef: identifier,
    operationRef: identifier.describe("An approved operation of this connection's binding."),
    input: z.unknown(),
    commandId: identifier.describe("Your own id for this attempt, so a retry is not a second attempt."),
  }),
} as const;

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

function refusal(message: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: message }] };
}

/**
 * Registers the connector tools on an existing server. The five ceremony
 * tools are untouched; this only adds.
 */
export function registerConnectorServerTools(
  server: McpServer,
  deps: ConnectorToolDependencies,
  context: ConnectorToolContext,
): void {
  const run = async <T>(operate: (actor: ActorContext) => Promise<T>) => {
    const actor = context.actor();
    if (!actor) return refusal("Sign in to the ceremony application first.");
    try {
      return text(await operate(actor));
    } catch (error) {
      context.onerror?.(error instanceof Error ? error : new Error(String(error)));
      return refusal(explainConnectorError(error).message);
    }
  };

  server.registerTool(
    "connector_catalog",
    {
      description:
        "List the connectors this deployment offers, with how each is supported, what configuration it needs and how strong the evidence for it is.",
      inputSchema: connectorToolInputs.catalog,
    },
    async () =>
      await run(async (actor) => ({
        connectors: (await deps.catalog(actor)).map((entry) => publicCatalogProjection(entry)),
      })),
  );

  server.registerTool(
    "connector_status",
    {
      description:
        "Read the state of one connection: its lifecycle, whether it is verified and whether a person is being waited on. Never returns credentials or links.",
      inputSchema: connectorToolInputs.status,
    },
    async (input) =>
      await run(async (actor) => {
        const checked = connectorToolInputs.status.parse(input);
        const summary = await deps.status(actor, checked.connectionRef);
        return summary ? agentConnectorProjection(summary) : { connection: "not-found" };
      }),
  );

  server.registerTool(
    "connector_connect",
    {
      description:
        "Start connecting a service. If a person must take part, this says so and what kind of step it is; the application shows them where to go. This tool never returns a link or a code.",
      inputSchema: connectorToolInputs.connect,
    },
    async (input) =>
      await run(async (actor) => {
        const checked = connectorToolInputs.connect.parse(input);
        const outcome = await deps.connect(actor, {
          connectorId: checked.connectorId,
          ...(checked.accountSwitch === undefined ? {} : { accountSwitch: checked.accountSwitch }),
          ...(checked.interruption === undefined ? {} : { interruption: checked.interruption }),
        });
        // A positive allowlist: whatever the service returns, only these three
        // facts leave, and the handoff contributes its kind and state alone.
        return {
          connectionRef: outcome.connectionRef,
          lifecycle: outcome.lifecycle,
          ...(outcome.handoff
            ? { handoff: { kind: outcome.handoff.kind, state: outcome.handoff.state } }
            : {}),
        };
      }),
  );

  server.registerTool(
    "connector_invoke",
    {
      description:
        "Run one approved operation on one approved connection. The server decides what the operation may touch; naming a URL, a header or a credential here is not possible.",
      inputSchema: connectorToolInputs.invoke,
    },
    async (input) =>
      await run(async (actor) => {
        const checked = connectorToolInputs.invoke.parse(input);
        const outcome = await deps.invoke(actor, {
          connectionRef: checked.connectionRef,
          operationRef: checked.operationRef,
          input: checked.input,
          commandId: checked.commandId,
        });
        return {
          state: outcome.state,
          effect: outcome.effect,
          outputClassification: outcome.outputClassification,
          // Output reaches the model only when the binding classified it
          // public. Personal and secret results exist, and are readable by the
          // person in the application, but are withheld from this transport.
          ...(outcome.state === "complete" && outcome.outputClassification === "public"
            ? { output: outcome.output }
            : outcome.state === "complete"
              ? { output: "withheld-by-policy" }
              : {}),
          ...(outcome.code ? { code: outcome.code } : {}),
          ...(outcome.handoff
            ? { handoff: { kind: outcome.handoff.kind, state: outcome.handoff.state } }
            : {}),
        };
      }),
  );
}

export const connectorServerToolNames = [
  "connector_catalog",
  "connector_status",
  "connector_connect",
  "connector_invoke",
] as const;

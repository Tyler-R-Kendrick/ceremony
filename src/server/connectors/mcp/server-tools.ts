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
 * These tools are added beside the five that were already there; nothing
 * about those changes. They obey the same two rules as the rest of that file:
 * the actor comes from the host's `authenticate` path and never from an
 * argument, and nothing a model can read carries a credential, a destination,
 * a provider URL or a code.
 *
 * A handoff that waits on a person carries a `path`: the same-origin path to
 * the connection in this application, the page the owner already uses. It
 * holds no token, code, state or provider URL, only the connection reference
 * the assistant already has, and opening it still requires the owner's own
 * session, so holding it grants nothing. The provider page, device code or
 * private form is shown to that person there, through the human projection.
 *
 * Revocation is a person's decision. `connector_revoke_request` only puts the
 * request in front of an administrator; nothing is revoked by this tool.
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
  handoff?: {
    kind: ConnectorHandoffSummary["kind"];
    state: ConnectorHandoffSummary["state"];
  };
  /**
   * Set by the service only when a person consented, on the binding, that an
   * assistant may read personal output. Secret output has no such consent.
   */
  agentOutputConsent?: "personal";
};

export type ConnectorRevocationRequestOutput = {
  connectionRef: string;
  revocation: "pending-approval";
  requestedAt: string;
};

export type ConnectorConnectOutput = {
  connectionRef: string;
  lifecycle: ConnectionSummary["lifecycle"];
  handoff?: {
    kind: ConnectorHandoffSummary["kind"];
    state: ConnectorHandoffSummary["state"];
  };
};

/**
 * What the command layer must provide. Every method takes the authenticated
 * actor as its first argument: this module has no other way to name one, and
 * the service is expected to re-check capability, ownership, generation and
 * policy itself rather than trusting that these tools did.
 */
export interface ConnectorToolDependencies {
  catalog(actor: ActorContext): Promise<CatalogEntry[]>;
  status(
    actor: ActorContext,
    connectionRef: string,
  ): Promise<ConnectionSummary | undefined>;
  connect(
    actor: ActorContext,
    input: ConnectorConnectInput,
  ): Promise<ConnectorConnectOutput>;
  invoke(
    actor: ActorContext,
    input: ConnectorInvokeInput,
  ): Promise<ConnectorInvokeOutput>;
  /** Fresh evidence for an existing grant (`ConnectorCommandService.verify`); never a way to obtain one. */
  verify?(
    actor: ActorContext,
    connectionRef: string,
  ): Promise<ConnectionSummary | undefined>;
  /** Queues a revocation for a person to approve (`ConnectorCommandService.requestRevocation`). */
  requestRevocation?(
    actor: ActorContext,
    connectionRef: string,
  ): Promise<ConnectorRevocationRequestOutput>;
}

export interface ConnectorToolContext {
  /** The actor for the current request, resolved by the host's authenticate path. */
  actor(): ActorContext | undefined;
  onerror?(error: Error): void;
  /**
   * Same-origin path of the application page that shows one connection to its
   * owner; `?connection=<ref>` selects it. Defaults to `/connectors`, where the
   * connector callback already returns people.
   */
  humanRoute?: string;
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
    connectorId: identifier.describe(
      "A connector this deployment offers, from connector_catalog.",
    ),
    accountSwitch: z
      .boolean()
      .optional()
      .describe(
        "Only when a person has said they want to change the connected account.",
      ),
    interruption: z.enum(["allowed", "none"]).optional(),
  }),
  invoke: z.strictObject({
    connectionRef: identifier,
    operationRef: identifier.describe(
      "An approved operation of this connection's binding.",
    ),
    input: z.unknown(),
    commandId: identifier.describe(
      "Your own id for this attempt, so a retry is not a second attempt.",
    ),
  }),
  verify: z.strictObject({ connectionRef: identifier }),
  revokeRequest: z.strictObject({ connectionRef: identifier }),
} as const;

const waiting = new Set<string>(["issued", "waiting"]);

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
 * Registers the connector tools on an existing server. The five ceremony
 * tools are untouched; this only adds.
 */
export function registerConnectorServerTools(
  server: McpServer,
  deps: ConnectorToolDependencies,
  context: ConnectorToolContext,
): void {
  const route = context.humanRoute ?? "/connectors";
  if (!/^(?:\/[A-Za-z0-9_.-]+)+$/.test(route))
    throw new Error("Invalid connector human route");
  /** The owner's page for this connection. No code, token, state or provider URL. */
  const personPath = (connectionRef: string) =>
    `${route}?${new URLSearchParams({ connection: connectionRef })}`;
  /** Kind and state always; the person-bound path only while a person is actually awaited. */
  const handoffView = (
    connectionRef: string,
    handoff: { kind: string; state: string } | undefined,
  ) =>
    handoff
      ? {
          handoff: {
            kind: handoff.kind,
            state: handoff.state,
            ...(waiting.has(handoff.state)
              ? { path: personPath(connectionRef) }
              : {}),
          },
        }
      : {};
  const run = async <T>(operate: (actor: ActorContext) => Promise<T>) => {
    const actor = context.actor();
    if (!actor) return refusal("Sign in to the ceremony application first.");
    try {
      return text(await operate(actor));
    } catch (error) {
      context.onerror?.(
        error instanceof Error ? error : new Error(String(error)),
      );
      return refusal(explainConnectorError(error).message);
    }
  };

  server.registerTool(
    "connector_catalog",
    {
      description:
        "List the connectors this deployment offers, with how each is supported, what configuration it needs and how strong the evidence for it is.",
      inputSchema: connectorToolInputs.catalog,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      await run(async (actor) => ({
        connectors: (await deps.catalog(actor)).map((entry) =>
          publicCatalogProjection(entry),
        ),
      })),
  );

  server.registerTool(
    "connector_status",
    {
      description:
        "Read the state of one connection: its lifecycle, whether it is verified and whether a person is being waited on (with the path of the owner's page for it). Never returns credentials, codes or provider links.",
      inputSchema: connectorToolInputs.status,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) =>
      await run(async (actor) => {
        const checked = connectorToolInputs.status.parse(input);
        const summary = await deps.status(actor, checked.connectionRef);
        if (!summary) return { connection: "not-found" };
        const view = agentConnectorProjection(summary);
        return { ...view, ...handoffView(view.connectionRef, view.handoff) };
      }),
  );

  server.registerTool(
    "connector_connect",
    {
      description:
        "Start connecting a service. If a person must take part, this says so, what kind of step it is, and the path of the owner's own page for this connection in this application, where they continue. This tool never returns a provider link, a code or a credential.",
      inputSchema: connectorToolInputs.connect,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) =>
      await run(async (actor) => {
        const checked = connectorToolInputs.connect.parse(input);
        const outcome = await deps.connect(actor, {
          connectorId: checked.connectorId,
          ...(checked.accountSwitch === undefined
            ? {}
            : { accountSwitch: checked.accountSwitch }),
          ...(checked.interruption === undefined
            ? {}
            : { interruption: checked.interruption }),
        });
        // A positive allowlist: whatever the service returns, only these
        // facts leave. The handoff contributes its kind and state, and while a
        // person is awaited, the path of the owner's page built here from the
        // connection reference, never anything the service or provider said.
        return {
          connectionRef: outcome.connectionRef,
          lifecycle: outcome.lifecycle,
          ...handoffView(outcome.connectionRef, outcome.handoff),
        };
      }),
  );

  server.registerTool(
    "connector_invoke",
    {
      description:
        "Run one approved operation on one approved connection. The server decides what the operation may touch; naming a URL, a header or a credential here is not possible. Personal output is returned only where a person consented on the binding; secret output never is.",
      inputSchema: connectorToolInputs.invoke,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
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
          // Output reaches the model when the binding classified it public,
          // or personal with a person's explicit consent on the binding.
          // Secret results exist, and are readable by the person in the
          // application, but never leave through this transport.
          ...(outcome.state === "complete" && modelMaySee(outcome)
            ? { output: outcome.output }
            : outcome.state === "complete"
              ? { output: "withheld-by-policy" }
              : {}),
          ...(outcome.state === "complete" &&
          outcome.outputClassification === "personal" &&
          modelMaySee(outcome)
            ? { agentOutputConsent: "personal" as const }
            : {}),
          ...(outcome.code ? { code: outcome.code } : {}),
          ...handoffView(checked.connectionRef, outcome.handoff),
        };
      }),
  );

  const verify = deps.verify;
  if (verify)
    server.registerTool(
      "connector_verify",
      {
        description:
          "Check that an existing connection still works, with fresh evidence from the provider. This never obtains a new grant; if a person must act, the result says so.",
        inputSchema: connectorToolInputs.verify,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (input) =>
        await run(async (actor) => {
          const checked = connectorToolInputs.verify.parse(input);
          const summary = await verify(actor, checked.connectionRef);
          if (!summary) return { connection: "not-found" };
          const view = agentConnectorProjection(summary);
          return { ...view, ...handoffView(view.connectionRef, view.handoff) };
        }),
    );

  const requestRevocation = deps.requestRevocation;
  if (requestRevocation)
    server.registerTool(
      "connector_revoke_request",
      {
        description:
          "Ask a person to revoke a connection's access at the provider. This revokes nothing: an administrator decides, on the connection's page in this application. Use it when a person asked you to, or when access should end.",
        inputSchema: connectorToolInputs.revokeRequest,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (input) =>
        await run(async (actor) => {
          const checked = connectorToolInputs.revokeRequest.parse(input);
          const outcome = await requestRevocation(actor, checked.connectionRef);
          return {
            connectionRef: outcome.connectionRef,
            revocation: "pending-approval" as const,
            requestedAt: outcome.requestedAt,
            approval: {
              kind: "person" as const,
              path: personPath(outcome.connectionRef),
            },
          };
        }),
    );
}

/** Public always; personal only under the binding's owner consent; secret never. */
function modelMaySee(outcome: ConnectorInvokeOutput) {
  return (
    outcome.outputClassification === "public" ||
    (outcome.outputClassification === "personal" &&
      outcome.agentOutputConsent === "personal")
  );
}

export const connectorServerToolNames = [
  "connector_catalog",
  "connector_status",
  "connector_connect",
  "connector_invoke",
  "connector_verify",
  "connector_revoke_request",
] as const;

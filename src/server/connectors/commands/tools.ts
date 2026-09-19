import { z } from "zod";
import type { ActorContext } from "../../../core/operation-contracts.js";
import type { CatalogEntry } from "../../../core/connectors/index.js";
import {
  INVOKE_INPUT_LIMITS,
  commandIdSchema,
  connectInputSchema,
  referenceSchema,
} from "./inputs.js";
import type {
  ConnectionView,
  ConnectorCommandService,
  InvokeResponse,
} from "./service.js";
import { boundedJsonGuard } from "../../../core/connectors/index.js";

/*
 * What a tool transport (MCP, WebMCP, HTTP tool routes) needs from the
 * command layer. Each function takes the authenticated actor and untrusted
 * arguments; the arguments never name a tenant, subject, session, URL or
 * credential. A tool result never carries presentation material, whatever
 * the actor kind: a person continues a handoff in the application, not by
 * pasting a URL out of a chat.
 */

export const connectorToolInputs = {
  status: z.strictObject({ connectionRef: referenceSchema }),
  connect: connectInputSchema,
  invoke: z.strictObject({
    connectionRef: referenceSchema,
    operationRef: referenceSchema,
    input: z
      .preprocess(
        boundedJsonGuard(INVOKE_INPUT_LIMITS),
        z.record(z.string().min(1).max(120), z.unknown()),
      )
      .default({}),
    commandId: commandIdSchema,
  }),
} as const;

export type ToolConnectionView =
  | Omit<Extract<ConnectionView, { displayName: string }>, "presentation">
  | Exclude<ConnectionView, { displayName: string }>;
export type ToolInvokeResponse = Omit<InvokeResponse, "presentation">;

export interface ConnectorToolDependencies {
  catalog(actor: ActorContext): Promise<CatalogEntry[]>;
  list(actor: ActorContext): Promise<ToolConnectionView[]>;
  status(actor: ActorContext, input: unknown): Promise<ToolConnectionView>;
  connect(actor: ActorContext, input: unknown): Promise<ToolConnectionView>;
  invoke(actor: ActorContext, input: unknown): Promise<ToolInvokeResponse>;
}

function withoutPresentation(view: ConnectionView): ToolConnectionView {
  if ("presentation" in view) {
    const { presentation: _presentation, ...rest } = view;
    void _presentation;
    return rest;
  }
  return view;
}

export function connectorToolDependencies(
  service: ConnectorCommandService,
): ConnectorToolDependencies {
  return {
    catalog: (actor) => service.catalog(actor),
    list: async (actor) =>
      (await service.listConnections(actor)).map(withoutPresentation),
    status: async (actor, input) => {
      const { connectionRef } = connectorToolInputs.status.parse(input);
      return withoutPresentation(await service.status(actor, connectionRef));
    },
    connect: async (actor, input) =>
      withoutPresentation(
        await service.connect(actor, connectorToolInputs.connect.parse(input)),
      ),
    invoke: async (actor, input) => {
      const { connectionRef, ...rest } =
        connectorToolInputs.invoke.parse(input);
      const { presentation: _presentation, ...response } = await service.invoke(
        actor,
        connectionRef,
        rest,
      );
      void _presentation;
      return response;
    },
  };
}

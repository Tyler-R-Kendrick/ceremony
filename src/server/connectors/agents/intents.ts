import { z } from "zod";
import {
  agentConnectorProjection,
  agentDefinitionProjection,
  connectorReferenceSchema,
  type ConnectionSummary,
  type NormalizedDefinition,
} from "../../../core/connectors/index.js";
import type { ActorContext } from "../../../core/operation-contracts.js";
import type { BoundOperation } from "../binding.js";
import { ConnectorError } from "../errors.js";

/*
 * AG-03: the safe connector intents an assistant may reach.
 *
 * Seven intents, one definition, every transport. An intent takes the
 * authenticated actor and untrusted arguments; the arguments never name a
 * tenant, a subject, a session, a URL, a header, a credential, an owner or a
 * destination, and no result carries presentation material — no link, no
 * device code, no configuration value, no upstream prose. A person continues
 * a handoff in the application; an assistant is told only that a person is
 * being waited on and what kind of step it is.
 *
 * Connections leave through `agentConnectorProjection` and definitions
 * through `agentDefinitionProjection`. Approved operations have no core
 * projection of their own because a binding is server state, so they leave
 * through the positive allowlist below: the policy facts a caller needs to
 * choose an operation, and nothing about how it is carried out.
 */

/**
 * A reference this deployment issued. The core alphabet admits `:` and `/`
 * because upstream identifiers do, which also admits a string shaped like a
 * URL; a reference is never a location, so anything carrying a scheme, an
 * authority or a dot segment is refused here rather than handed to a lookup.
 */
const identifier = connectorReferenceSchema
  .refine((value) => !value.includes("//"), "A reference is not a URL")
  .refine(
    (value) => !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value),
    "A reference is not a URL",
  );

export const agentIntentInputs = {
  list: z.strictObject({}),
  inspect: z.strictObject({ definitionRef: identifier }),
  status: z.strictObject({ connectionRef: identifier }),
  connect: z.strictObject({
    bindingRef: identifier.describe(
      "A binding this deployment approved, from the connector catalog.",
    ),
    accountSwitch: z
      .boolean()
      .optional()
      .describe(
        "Only when a person has said they want to change the connected account.",
      ),
    interruption: z.enum(["allowed", "none"]).optional(),
  }),
  operations: z.strictObject({ connectionRef: identifier }),
  reconnect: z.strictObject({
    connectionRef: identifier,
    expectedRevision: z.number().int().positive(),
    accountSwitch: z.boolean().optional(),
    interruption: z.enum(["allowed", "none"]).optional(),
  }),
  disconnect: z.strictObject({
    connectionRef: identifier,
    expectedRevision: z.number().int().positive(),
  }),
} as const;

export type AgentIntentName = keyof typeof agentIntentInputs;

/** What an assistant may know about an approved operation. */
export type AgentOperationView = {
  operationRef: string;
  effect: BoundOperation["effect"];
  outputClassification: BoundOperation["outputClassification"];
  cost: BoundOperation["cost"];
  consent: BoundOperation["consent"];
  replay: BoundOperation["replay"];
  /** Parameter names that select a target the connection must be permitted to touch. */
  targetParameters: string[];
  description?: string;
};

/**
 * A positive allowlist over one approved operation. Transport kind, method,
 * path template, tool name, destination id and authentication profile are all
 * absent by construction: a caller names an operation, never a way of
 * performing one.
 */
export function agentOperationProjection(
  operation: BoundOperation,
): AgentOperationView {
  return {
    operationRef: operation.operationRef,
    effect: operation.effect,
    outputClassification: operation.outputClassification,
    cost: operation.cost,
    consent: operation.consent,
    replay: operation.replay,
    targetParameters: [...operation.targetParameters],
    ...(operation.description ? { description: operation.description } : {}),
  };
}

export type AgentDisconnectView = {
  local: string;
  broker: string;
  upstream: string;
  /** How many other local connections share the affected grant; never which ones. */
  sharedCount?: number;
};

/**
 * What the command layer must provide. Each method takes the authenticated
 * actor first: this module has no other way to name one, and the service is
 * expected to recheck capability, ownership, generation and policy itself
 * rather than trusting that these intents did.
 */
export interface AgentConnectorDependencies {
  list(actor: ActorContext): Promise<ConnectionSummary[]>;
  definition(
    actor: ActorContext,
    definitionRef: string,
  ): Promise<NormalizedDefinition | undefined>;
  status(
    actor: ActorContext,
    connectionRef: string,
  ): Promise<ConnectionSummary | undefined>;
  connect(
    actor: ActorContext,
    input: {
      bindingRef: string;
      accountSwitch?: boolean;
      interruption?: "allowed" | "none";
    },
  ): Promise<ConnectionSummary>;
  operations(
    actor: ActorContext,
    connectionRef: string,
  ): Promise<BoundOperation[]>;
  reconnect(
    actor: ActorContext,
    input: {
      connectionRef: string;
      expectedRevision: number;
      accountSwitch?: boolean;
      interruption?: "allowed" | "none";
    },
  ): Promise<ConnectionSummary>;
  disconnect(
    actor: ActorContext,
    input: { connectionRef: string; expectedRevision: number },
  ): Promise<{
    local: string;
    broker: string;
    upstream: string;
    sharedWith?: string[];
  }>;
}

export type AgentIntent = {
  name: string;
  intent: AgentIntentName;
  description: string;
  inputSchema: z.ZodType;
  /** Read intents never change anything; the rest are consequential by default. */
  readOnly: boolean;
  run(actor: ActorContext, input: unknown): Promise<unknown>;
};

const descriptions: Readonly<Record<AgentIntentName, string>> = Object.freeze({
  list: "List the connections this person already has, with what each one is and whether it is usable. Never returns credentials, links or account names.",
  inspect:
    "Describe one imported connector: its identity, the kinds of credential it declares, the capabilities it advertises and what is blocked. This is a description, not an approval to use anything.",
  status:
    "Read the state of one connection: its lifecycle, whether it is verified and whether a person is being waited on.",
  connect:
    "Start connecting using one approved binding. If a person must take part, this says so and what kind of step it is; the application shows them where to go. This never returns a link or a code.",
  operations:
    "List the operations this connection's binding approved, with the effect, cost, consent and replay policy the host set for each. Naming one of these is the only way to act.",
  reconnect:
    "Re-establish an expired or broken connection. This is not a way to change account: that needs a person to say so.",
  disconnect:
    "Disconnect locally. This does not delete anything upstream and does not revoke access that was already granted.",
});

/** The seven intents, ready for any transport to register. */
export function createAgentConnectorIntents(
  deps: AgentConnectorDependencies,
  options: { prefix?: string } = {},
): AgentIntent[] {
  const prefix = options.prefix ?? "connector";
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,64}$/.test(prefix))
    throw new ConnectorError("invalid-request", {
      detail: "agent.intent.prefix",
    });
  const name = (intent: AgentIntentName) => `${prefix}_${intent}`;
  const intent = (
    key: AgentIntentName,
    readOnly: boolean,
    run: (actor: ActorContext, input: unknown) => Promise<unknown>,
  ): AgentIntent => ({
    name: name(key),
    intent: key,
    description: descriptions[key],
    inputSchema: agentIntentInputs[key],
    readOnly,
    run,
  });
  return [
    intent("list", true, async (actor) => ({
      connections: (await deps.list(actor)).map((summary) =>
        agentConnectorProjection(summary),
      ),
    })),
    intent("inspect", true, async (actor, input) => {
      const checked = agentIntentInputs.inspect.parse(input);
      const definition = await deps.definition(actor, checked.definitionRef);
      return definition
        ? agentDefinitionProjection(definition)
        : { definition: "not-found" };
    }),
    intent("status", true, async (actor, input) => {
      const checked = agentIntentInputs.status.parse(input);
      const summary = await deps.status(actor, checked.connectionRef);
      return summary
        ? agentConnectorProjection(summary)
        : { connection: "not-found" };
    }),
    intent("connect", false, async (actor, input) => {
      const checked = agentIntentInputs.connect.parse(input);
      return agentConnectorProjection(
        await deps.connect(actor, {
          bindingRef: checked.bindingRef,
          ...(checked.accountSwitch === undefined
            ? {}
            : { accountSwitch: checked.accountSwitch }),
          ...(checked.interruption === undefined
            ? {}
            : { interruption: checked.interruption }),
        }),
      );
    }),
    intent("operations", true, async (actor, input) => {
      const checked = agentIntentInputs.operations.parse(input);
      const operations = await deps.operations(actor, checked.connectionRef);
      return {
        connectionRef: checked.connectionRef,
        operations: operations.map((operation) =>
          agentOperationProjection(operation),
        ),
      };
    }),
    intent("reconnect", false, async (actor, input) => {
      const checked = agentIntentInputs.reconnect.parse(input);
      return agentConnectorProjection(
        await deps.reconnect(actor, {
          connectionRef: checked.connectionRef,
          expectedRevision: checked.expectedRevision,
          ...(checked.accountSwitch === undefined
            ? {}
            : { accountSwitch: checked.accountSwitch }),
          ...(checked.interruption === undefined
            ? {}
            : { interruption: checked.interruption }),
        }),
      );
    }),
    intent("disconnect", false, async (actor, input) => {
      const checked = agentIntentInputs.disconnect.parse(input);
      const result = await deps.disconnect(actor, checked);
      // Which other connections share the grant is an ownership fact about
      // other records; the count is enough to say "this affects more".
      const view: AgentDisconnectView = {
        local: result.local,
        broker: result.broker,
        upstream: result.upstream,
        ...(result.sharedWith?.length
          ? { sharedCount: result.sharedWith.length }
          : {}),
      };
      return view;
    }),
  ];
}

export const agentIntentNames = Object.keys(
  agentIntentInputs,
) as AgentIntentName[];

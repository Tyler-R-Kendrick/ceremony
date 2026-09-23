import { z } from "zod";
import {
  handoffKindSchema,
  handoffStateSchema,
} from "../../core/connectors/index.js";
import type { ActorContext } from "../../core/operation-contracts.js";
import type { AsyncCeremonyStore } from "../persistence/index.js";
import {
  createConnectorRuntime,
  type ConnectorRuntime,
} from "../connectors/runtime.js";
import { createHostConfigurationPort } from "../connectors/state/configuration.js";
import { ConnectorError } from "../connectors/errors.js";
import { EventInbox } from "../connectors/events/inbox.js";
import { SubscriptionRegistry } from "../connectors/events/subscriptions.js";
import {
  createWebhookReceiver,
  registrySecretResolver,
} from "../connectors/events/receiver.js";
import type { ConnectorToolDependencies } from "../connectors/mcp/server-tools.js";
import type { AgentConnectorDependencies } from "../connectors/agents/intents.js";

/*
 * The connector runtime of the hosted deployment.
 *
 * It runs on the same PostgreSQL store as everything else: every connector
 * port is implemented over the shared encrypted record table, and each record
 * is keyed by the actor's tenant, so a claim-derived tenant is isolated here
 * exactly as it is for ceremony runs.
 *
 * Three things are decided from the protected environment and nowhere else:
 *
 * - **Configuration** adapters may read. Only names the operator listed in
 *   `CEREMONY_CONNECTOR_CONFIGURATION` are readable, from the host
 *   environment, and the revision is `CEREMONY_CONFIGURATION_VERSION`. A
 *   name under the `CEREMONY_` prefix is refused so no adapter can be
 *   pointed at the vault key, the database URL or the cron secret. Unlisted,
 *   every adapter that needs configuration reports itself unconfigured.
 * - **Events.** The webhook receiver is mounted only when
 *   `CEREMONY_CONNECTOR_EVENTS=enabled`. Signing secrets are not environment
 *   values: each approved subscription names its own secret in credential
 *   custody, per tenant, which one shared environment secret could not be.
 *   Without it the events route answers 404.
 * - **Network.** Public internet only, or loopback fixtures under the local
 *   test profile, never a choice a request can make.
 */

export interface HostedConnectors {
  runtime: ConnectorRuntime;
  /** The connector tools (catalog, status, connect, invoke, verify, revocation request) for the MCP endpoint. */
  tools: ConnectorToolDependencies;
  /** The safe intents (list, inspect, operations, reconnect, disconnect). */
  intents: AgentConnectorDependencies;
  /** Whether provider deliveries are accepted. */
  events: boolean;
}

const configurationNames = z
  .string()
  .max(4096)
  .transform((value) =>
    value
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  )
  .pipe(
    z
      .array(
        z
          .string()
          .regex(/^[A-Z][A-Z0-9_]{0,95}$/)
          .refine((name) => !name.startsWith("CEREMONY_")),
      )
      .max(100),
  );

export function createHostedConnectors(input: {
  env: NodeJS.ProcessEnv;
  origin: string;
  store: AsyncCeremonyStore;
  configurationVersion: string;
  testProfile: boolean;
}): HostedConnectors | undefined {
  const { env } = input;
  if (env.CEREMONY_CONNECTORS === "disabled") return undefined;
  const names = configurationNames.parse(
    env.CEREMONY_CONNECTOR_CONFIGURATION ?? "",
  );
  if (
    env.CEREMONY_CONNECTOR_EVENTS !== undefined &&
    !["enabled", "disabled"].includes(env.CEREMONY_CONNECTOR_EVENTS)
  )
    throw new Error("Invalid connector events configuration");
  const events = env.CEREMONY_CONNECTOR_EVENTS === "enabled";
  const configuration = createHostConfigurationPort({
    values: Object.fromEntries(names.map((name) => [name, env[name]])),
    names,
    revision: input.configurationVersion,
  });
  // Bound after the runtime exists: the receiver opens signing secrets
  // through the runtime's credential custody, and the runtime's route table
  // hands deliveries to the receiver.
  let receiver: ((request: Request) => Promise<Response>) | undefined;
  const runtime = createConnectorRuntime({
    origin: input.origin,
    store: input.store,
    network: {
      mode: input.testProfile ? "loopback-fixture" : "public",
      maxRedirects: 3,
      maxResponseBytes: 8 * 1024 * 1024,
      timeoutMs: 10_000,
    },
    configuration: () => configuration,
    ...(events ? { receiveEvent: ({ request }) => receiver!(request) } : {}),
  });
  if (events) {
    const subscriptions = new SubscriptionRegistry(input.store);
    receiver = createWebhookReceiver({
      resolveSecrets: registrySecretResolver({
        registry: subscriptions,
        credentials: runtime.ports.credentials,
      }),
      inbox: new EventInbox(input.store, { subscriptions }),
    });
  }
  return {
    runtime,
    tools: connectorTools(runtime),
    intents: runtime.agentDependencies,
    events,
  };
}

/**
 * The MCP connector tools over the command service.
 *
 * `connector_connect` names a connector, because that is what the catalog
 * lists; the service connects a reviewed binding. The name is resolved
 * against this tenant's approved bindings: a binding reference names itself,
 * and an adapter id names its binding only when exactly one is approved.
 * Anything else is refused rather than guessed, since picking one of several
 * bindings would choose a destination and a credential authority for the
 * person.
 */
function connectorTools(runtime: ConnectorRuntime): ConnectorToolDependencies {
  const intents = runtime.agentDependencies;
  const handoff = (value: { kind: string; state: string } | undefined) => {
    const kind = handoffKindSchema.safeParse(value?.kind);
    const state = handoffStateSchema.safeParse(value?.state);
    return kind.success && state.success
      ? { handoff: { kind: kind.data, state: state.data } }
      : {};
  };
  const binding = async (actor: ActorContext, connectorId: string) => {
    const approved = (await runtime.service.listBindings(actor)).filter(
      (item) => item.status === "approved",
    );
    const exact = approved.find((item) => item.bindingRef === connectorId);
    if (exact) return exact.bindingRef;
    const matching = approved.filter((item) => item.adapterId === connectorId);
    if (matching.length === 1) return matching[0]!.bindingRef;
    throw new ConnectorError(
      matching.length ? "invalid-request" : "not-found",
      {
        detail: matching.length ? "binding.ambiguous" : "binding.unknown",
      },
    );
  };
  return {
    catalog: (actor) => runtime.service.catalog(actor),
    status: (actor, connectionRef) => intents.status(actor, connectionRef),
    // A label is information beside the status, never a reason the status
    // read fails, so a refusal here reads as no label.
    supportLabel: (actor, connectionRef) =>
      runtime.service
        .connectionSupportLabel(actor, connectionRef)
        .catch(() => undefined),
    connect: async (actor, input) => {
      const summary = await intents.connect(actor, {
        bindingRef: await binding(actor, input.connectorId),
        ...(input.accountSwitch === undefined
          ? {}
          : { accountSwitch: input.accountSwitch }),
        ...(input.interruption === undefined
          ? {}
          : { interruption: input.interruption }),
      });
      return {
        connectionRef: summary.connectionRef,
        lifecycle: summary.lifecycle,
        ...handoff(summary.handoff),
      };
    },
    invoke: async (actor, input) => {
      const result = await runtime.service.invoke(actor, input.connectionRef, {
        operationRef: input.operationRef,
        input: input.input,
        commandId: input.commandId,
      });
      // The tool layer decides what the model may read; this passes only the
      // fields it looks at, and never output the service already withheld.
      return {
        state: result.state,
        effect: result.effect,
        outputClassification: result.outputClassification,
        ...(result.outputWithheld || !("output" in result)
          ? {}
          : { output: result.output }),
        ...(result.code ? { code: result.code } : {}),
        ...handoff(result.handoff),
      };
    },
    // Verification refreshes evidence for a grant that already exists, then
    // reports it through the same projection `status` uses.
    verify: async (actor, connectionRef) => {
      await runtime.service.verify(actor, connectionRef);
      return intents.status(actor, connectionRef);
    },
    // Only queues the request; revoking stays the admin's human-only action.
    requestRevocation: (actor, connectionRef) =>
      runtime.service.requestRevocation(actor, connectionRef),
  };
}

import type { AsyncCeremonyStore } from "../persistence/index.js";
import type { ActorContext } from "../../core/operation-contracts.js";
import {
  createConnectorRegistry,
  type ConnectorInventoryOptions,
} from "./adapters.js";
import type { ConnectorAdapterRegistry } from "./adapter.js";
import type { ConfigurationPort } from "./ports.js";
import { createConnectorPorts, type ConnectorPorts } from "./state/index.js";
import {
  defaultConnectorPolicy,
  type ConnectorPolicy,
} from "./commands/policy.js";
import {
  ConnectorCommandService,
  type ConfigurationWriter,
  type ConnectorImporter,
} from "./commands/service.js";
import {
  createConnectorHttp,
  type ConnectorEventReceiver,
  type ConnectorHttpHandler,
} from "./commands/http.js";
import {
  createAgentConnectorIntents,
  type AgentConnectorDependencies,
  type AgentIntent,
} from "./agents/intents.js";
import { createApprovedFetch, type NetworkPolicy } from "./import/network.js";

/*
 * One composition root for connector interoperability.
 *
 * Six things have to agree for a deployment to be honest: which adapters
 * exist, where their state lives, what policy admits, which fetcher may leave
 * the process, what the route table exposes and what an assistant may reach.
 * Composing them in six places is how they drift, and a drifted deployment is
 * exactly the "catalog of buttons that do not work" this work exists to
 * prevent. So they are composed here, once, from one store and one origin.
 *
 * Nothing here contacts a provider, reads a credential or starts a listener.
 * Building the runtime is pure apart from allocating dispatchers; every
 * request-scoped fact -- the actor, their configuration, their policy answer
 * -- is resolved per call, by the service, against the actor it was given.
 *
 * What this does NOT do, deliberately:
 *
 * - It does not choose a network policy for you. A deployment that reaches
 *   the public internet and one that may only reach loopback fixtures differ
 *   in exactly one field, and defaulting it would make a test harness and a
 *   production server look alike at the call site.
 * - It does not mount anything. `http` is a handler; where it hangs and which
 *   requests are authenticated before reaching it is the host's decision, and
 *   the three route groups have deliberately different boundary treatment.
 * - It does not register an event receiver unless the caller supplies one.
 *   An events mount point with no receiver answers 404, which is the honest
 *   answer for a deployment that has not accepted deliveries.
 */

export interface ConnectorRuntimeOptions {
  /** Exact trusted origin of this deployment; every callback and return path derives from it. */
  origin: string;
  /** Shared encrypted store: PostgreSQL in production, SQLite locally. */
  store: AsyncCeremonyStore;
  /**
   * What the approved fetcher may reach. Required: see the note above.
   * `mode: "loopback-fixture"` is for tests and never for a deployment.
   */
  network: NetworkPolicy;
  /** Private configuration bound to one actor; values never leave server code. */
  configuration(actor: ActorContext): ConfigurationPort;
  /** The private path configuration values take inbound. */
  configure?: ConfigurationWriter;
  /**
   * Host policy. The default admits a delegated agent only while its
   * delegation is live and restricts an agent to public output; a deployment
   * with organization owners or a destination allowlist supplies its own.
   */
  policy?: ConnectorPolicy | ((base: ConnectorPolicy) => ConnectorPolicy);
  /** Host capabilities and extra adapters; see `ConnectorInventoryOptions`. */
  inventory?: ConnectorInventoryOptions;
  /**
   * Format importers tried, in order, for an import that names no adapter
   * (OpenAPI, Arazzo, AsyncAPI ...). The service always supported them; the
   * runtime used to drop them, so a composed deployment could import only
   * through an adapter's own `import`.
   */
  importers?: readonly ConnectorImporter[];
  /** Where a completed callback sends the person; a path on this origin. */
  returnPath?: string;
  /** The events module's receiver; absent means the events mount answers 404. */
  receiveEvent?: ConnectorEventReceiver;
  rateLimit?: { limit: number; windowMs: number };
  /** Exact HTTPS origins the default policy admits beyond those a description declares. */
  destinations?: readonly string[];
  /** Exact HTTPS origins the default policy admits for a reviewed OAuth issuer policy, beyond those a description declares. */
  issuers?: readonly string[];
  callTimeoutMs?: number;
}

export interface ConnectorRuntime {
  registry: ConnectorAdapterRegistry;
  ports: ConnectorPorts;
  policy: ConnectorPolicy;
  service: ConnectorCommandService;
  /** The `/api/v1/connectors/*` route table, for the host to mount. */
  http: ConnectorHttpHandler;
  /** The unprojected seam an assistant's intents narrow; see `agentDependencies`. */
  agentDependencies: AgentConnectorDependencies;
  /** The seven safe intents, ready for any transport to register. */
  agentIntents: AgentIntent[];
  /** The approved fetcher, exposed so a host can prove nothing else leaves. */
  fetch: typeof fetch;
}

export function createConnectorRuntime(
  options: ConnectorRuntimeOptions,
): ConnectorRuntime {
  if (!URL.canParse(options.origin))
    throw new Error("Connector runtime origin must be a URL");
  if (new URL(options.origin).origin !== options.origin)
    throw new Error("Connector runtime origin must be an exact origin");

  const registry = createConnectorRegistry(options.inventory ?? {});
  const ports = createConnectorPorts(options.store);
  const approved = createApprovedFetch(options.network);
  // The approved fetcher is the only way out. Narrowing it to `typeof fetch`
  // here rather than at each call site means a module that wants a plain
  // `fetch` gets this one and cannot quietly fall back to the global.
  const fetcher = approved as unknown as typeof fetch;

  const base = defaultConnectorPolicy({
    store: options.store,
    ...(options.destinations ? { destinations: options.destinations } : {}),
    ...(options.issuers ? { issuers: options.issuers } : {}),
    ...(options.network.mode === "loopback-fixture"
      ? { loopbackFixtures: true }
      : {}),
  });
  const policy =
    typeof options.policy === "function"
      ? options.policy(base)
      : (options.policy ?? base);

  const service = new ConnectorCommandService({
    registry,
    ports,
    policy,
    fetch: fetcher,
    origin: options.origin,
    configuration: options.configuration,
    ...(options.configure ? { configure: options.configure } : {}),
    ...(options.importers ? { importers: options.importers } : {}),
    ...(options.callTimeoutMs === undefined
      ? {}
      : { callTimeoutMs: options.callTimeoutMs }),
  });

  const http = createConnectorHttp(service, {
    origin: options.origin,
    store: options.store,
    ...(options.returnPath ? { returnPath: options.returnPath } : {}),
    ...(options.receiveEvent ? { receiveEvent: options.receiveEvent } : {}),
    ...(options.rateLimit ? { rateLimit: options.rateLimit } : {}),
  });

  const agentDependencies = service.agentDependencies();
  return {
    registry,
    ports,
    policy,
    service,
    http,
    agentDependencies,
    agentIntents: createAgentConnectorIntents(agentDependencies),
    fetch: fetcher,
  };
}

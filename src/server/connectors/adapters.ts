import { ConnectorAdapterRegistry } from "./adapter.js";
import type { ConnectorAdapter } from "./adapter.js";

import { createOpenApiHttpAdapter } from "./formats/openapi/adapter.js";
import { createMicrosoftCustomConnectorAdapter } from "./formats/microsoft/adapter.js";
import { createCamelKameletAdapter } from "./formats/camel-kamelet/adapter.js";
import {
  createCatalogHttpAdapter,
  createProviderCatalogAdapters,
  type ProviderCatalogRegistration,
} from "./formats/provider-catalog/adapter.js";

import { createMcpRegistryAdapter } from "./registries/mcp/adapter.js";
import { createSmitheryRegistryAdapter } from "./registries/smithery/adapter.js";
import { createDockerMcpCatalogAdapter } from "./registries/docker/adapter.js";
import { createPulseMcpAdapter } from "./registries/pulsemcp/adapter.js";

import { createMcpRemoteAdapter } from "./mcp/adapter.js";
import { createVercelConnectAdapter } from "./providers/vercel/index.js";
import { createNangoAdapter } from "./providers/nango/index.js";
import { createPipedreamConnectAdapter } from "./providers/pipedream/index.js";
import { createComposioAdapter } from "./providers/composio/index.js";
import { createSmitheryConnectionsAdapter } from "./providers/smithery/connections.js";
import { createSupabaseManagementAdapter } from "./providers/supabase/management.js";
import { createSupabaseDataApiAdapter } from "./providers/supabase/data-api.js";
import { createSupabaseWrappersAdapter } from "./providers/supabase/wrappers.js";
import { createWorkOsPipesAdapter } from "./providers/workos/adapter.js";
import { createAuth0TokenVaultAdapter } from "./providers/auth0/adapter.js";
import { createAirbyteAdapter } from "./providers/airbyte/adapter.js";
import { createHasuraNdcAdapter } from "./providers/hasura-ndc/adapter.js";
import { createMergeAdapter } from "./providers/merge/adapter.js";
import { createAgentCoreGatewayAdapter } from "./providers/aws-agentcore/adapter.js";
import { createGoogleConnectorsAdapter } from "./providers/google-integration-connectors/adapter.js";
import { createDaprAdapter } from "./providers/dapr/adapter.js";
import { createOpenServiceBrokerAdapter } from "./providers/open-service-broker/adapter.js";
import { createA2aAdapter } from "./providers/a2a/index.js";

import type { ProjectSessionPort } from "./providers/supabase/data-api.js";
import type { ApprovedQueryPort } from "./providers/supabase/wrappers.js";
import type { WorkOsPrincipalPort } from "./providers/workos/ports.js";
import type { HostIdentityTokenPort } from "./providers/auth0/ports.js";

/*
 * One inventory, so that what a deployment can reach and what its directory
 * advertises cannot disagree.
 *
 * Two rules decide what is here.
 *
 * An adapter that needs nothing from the host is always registered. It still
 * shows as `unconfigured` in the directory until its configuration is
 * present, because "implemented" and "usable here" are different facts and
 * the catalog reports them separately.
 *
 * An adapter that cannot work without a host-supplied port is registered only
 * when that port is supplied. Registering it regardless would put a row in the
 * directory that fails the moment anyone uses it, which is exactly the
 * "catalog of nonfunctional buttons" this work exists to avoid. Its absence is
 * a deployment fact, not a missing implementation, and the evidence report
 * says so.
 *
 * Nothing here reads configuration or contacts a provider. Building the
 * inventory is pure; resolving what is configured happens per actor, later.
 */

/** Host capabilities that some adapters cannot be honest without. */
export interface ConnectorHostPorts {
  /** Verified Supabase project-user session; without it the Data API adapter has no caller identity. */
  supabaseSessions?: ProjectSessionPort;
  /** Parameterized, allowlisted foreign-table reads; never a SQL string. */
  supabaseQuery?: ApprovedQueryPort;
  /** Maps an authenticated owner to WorkOS identifiers and organization policy. */
  workOsPrincipals?: WorkOsPrincipalPort;
  /** Custody of the user's Auth0 tokens and the My Account API token. */
  auth0Identity?: HostIdentityTokenPort;
}

export interface ConnectorInventoryOptions {
  ports?: ConnectorHostPorts;
  /**
   * Adapters the deployment adds or substitutes, applied after the standard
   * set. A duplicate id is an error, not a silent replacement.
   */
  additional?: readonly ConnectorAdapter[];
  /**
   * Data-defined providers (catalog entries or a Nango providers.yaml). Each
   * becomes its own `catalog-<id>` connector, still a draft until a reviewer
   * approves a binding for it.
   */
  providerCatalog?: ProviderCatalogRegistration;
}

/**
 * Every adapter that needs nothing from the host.
 *
 * Each entry is a thunk so a construction failure names its own adapter
 * rather than aborting the whole inventory anonymously.
 */
const standardAdapters: readonly (() => ConnectorAdapter)[] = [
  // Descriptions compiled into HTTP operations.
  () => createOpenApiHttpAdapter(),
  () => createMicrosoftCustomConnectorAdapter(),
  () => createCamelKameletAdapter(),
  () => createCatalogHttpAdapter(),

  // Catalogs and registries: discovery and import, never execution.
  () => createMcpRegistryAdapter(),
  () => createSmitheryRegistryAdapter(),
  () => createDockerMcpCatalogAdapter(),
  () => createPulseMcpAdapter(),

  // Runtimes and brokers.
  () => createMcpRemoteAdapter(),
  () => createVercelConnectAdapter(),
  () => createNangoAdapter(),
  () => createPipedreamConnectAdapter(),
  () => createComposioAdapter(),
  () => createSmitheryConnectionsAdapter(),
  () => createSupabaseManagementAdapter(),

  // Data planes.
  () => createAirbyteAdapter(),
  () => createHasuraNdcAdapter(),
  () => createMergeAdapter(),

  // Configured cloud resources; absent credentials yield configuration-required.
  () => createAgentCoreGatewayAdapter(),
  () => createGoogleConnectorsAdapter(),

  // Bindings and agent surfaces.
  () => createDaprAdapter(),
  () => createOpenServiceBrokerAdapter(),
  () => createA2aAdapter(),
];

/** Build the registry this deployment will actually serve. */
export function createConnectorRegistry(
  options: ConnectorInventoryOptions = {},
): ConnectorAdapterRegistry {
  const registry = new ConnectorAdapterRegistry();
  for (const build of standardAdapters) registry.register(build());

  const ports = options.ports ?? {};
  // Registered only when the host can actually serve them; see the note above.
  if (ports.supabaseSessions)
    registry.register(
      createSupabaseDataApiAdapter({ sessions: ports.supabaseSessions }),
    );
  if (ports.supabaseQuery)
    registry.register(
      createSupabaseWrappersAdapter({ query: ports.supabaseQuery }),
    );
  if (ports.workOsPrincipals)
    registry.register(
      createWorkOsPipesAdapter({ principals: ports.workOsPrincipals }),
    );
  if (ports.auth0Identity)
    registry.register(
      createAuth0TokenVaultAdapter({ identity: ports.auth0Identity }),
    );

  for (const adapter of createProviderCatalogAdapters(options.providerCatalog))
    registry.register(adapter);
  for (const adapter of options.additional ?? []) registry.register(adapter);
  return registry;
}

/**
 * Which adapters this build can offer at all, and which of those need a host
 * port first. Reported by the evidence compiler so "not registered here" is
 * never mistaken for "not implemented".
 */
export function connectorInventoryShape(): {
  always: number;
  hostPortRequired: readonly {
    adapterId: string;
    port: keyof ConnectorHostPorts;
  }[];
} {
  return {
    always: standardAdapters.length,
    hostPortRequired: [
      { adapterId: "supabase-data-api", port: "supabaseSessions" },
      { adapterId: "supabase-wrappers", port: "supabaseQuery" },
      { adapterId: "workos-pipes", port: "workOsPrincipals" },
      { adapterId: "auth0-token-vault", port: "auth0Identity" },
    ],
  };
}

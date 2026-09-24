import { z } from "zod";
import { createCeremonyMcpHandler } from "../mcp.js";
import { createMcpIdentity } from "../mcp-identity.js";
import { getHostedRuntime, type HostedRuntime } from "./runtime.js";

/**
 * The deployed MCP endpoint.
 *
 * It is built from the same protected environment the browser server uses, so
 * a deployment cannot end up offering chat access under a different issuer or
 * against a different tenant than the web application it sits beside: tenant
 * and roles are mapped from the token's signed claims by the very tenancy
 * object the browser identity uses.
 *
 * Absent or invalid configuration yields no handler rather than an open one:
 * the route then answers 503 and no ceremony is reachable over MCP at all.
 */

export const MCP_PATH = "/mcp";

let instance: Promise<McpEndpoint | undefined> | undefined;

type McpEndpoint = Awaited<ReturnType<typeof createCeremonyMcpHandler>>;

export function getHostedMcp(): Promise<McpEndpoint | undefined> {
  return (instance ??= createHostedMcp().catch(() => {
    instance = undefined;
    return undefined;
  }));
}

export async function createHostedMcp(
  env: NodeJS.ProcessEnv = process.env,
  /** The runtime to serve; the process runtime when omitted. Tests pass their own. */
  hosted?: HostedRuntime,
): Promise<McpEndpoint | undefined> {
  const config = z
    .strictObject({
      origin: z.url(),
      issuer: z.url(),
    })
    .safeParse({
      origin: env.CEREMONY_PUBLIC_ORIGIN,
      issuer: env.CEREMONY_OIDC_ISSUER,
    });
  if (!config.success) return undefined;
  const resourceUrl = new URL(MCP_PATH, config.data.origin).href;
  const runtime = hosted ?? (await getHostedRuntime());
  const { tenancy, connectors } = runtime.hosted;
  const authenticate = await createMcpIdentity({
    issuer: config.data.issuer,
    audience: resourceUrl,
    // The same local fixture rule as the browser identity: only with both
    // test switches, and createMcpIdentity itself admits only 127.0.0.1.
    ...(env.NODE_ENV === "test" && env.CEREMONY_TEST_PROFILE === "true"
      ? { development: true }
      : {}),
    // Same rule as the browser adapter, through the same object: roles are
    // signed by the issuer, and a token that carries none is an executor and
    // nothing more. A token without a required tenant claim is refused.
    mapClaims: async (claims) => {
      const tenantId = tenancy.tenantFor(claims);
      const capabilities = tenancy.capabilitiesFor(claims);
      await tenancy.remember(runtime.store, tenantId);
      return { tenantId, subjectId: String(claims.sub), capabilities };
    },
  });
  return createCeremonyMcpHandler(runtime, {
    resourceUrl,
    issuer: config.data.issuer,
    authenticate,
    serverName: "Ceremony",
    /*
     * Connector tools, when this deployment composed a connector runtime.
     * Both halves: the connector tools (catalog, status, connect by
     * connector, invoke, verify, revocation request) and the intents (list,
     * inspect, operations, reconnect, disconnect). The service behind them receives the authenticated actor
     * and re-checks capability, ownership and policy itself.
     */
    ...(connectors
      ? { connectors: connectors.tools, connectorIntents: connectors.intents }
      : {}),
  });
}

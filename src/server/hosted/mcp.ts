import { z } from "zod";
import { createCeremonyMcpHandler } from "../mcp.js";
import { createMcpIdentity } from "../mcp-identity.js";
import { getHostedRuntime } from "./runtime.js";

/**
 * The deployed MCP endpoint.
 *
 * It is built from the same protected environment the browser server uses, so
 * a deployment cannot end up offering chat access under a different issuer or
 * against a different tenant than the web application it sits beside.
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
): Promise<McpEndpoint | undefined> {
  const config = z
    .strictObject({
      origin: z.url(),
      issuer: z.url(),
      tenant: z.string().min(1).max(100),
    })
    .safeParse({
      origin: env.CEREMONY_PUBLIC_ORIGIN,
      issuer: env.CEREMONY_OIDC_ISSUER,
      tenant: env.CEREMONY_TENANT_ID,
    });
  if (!config.success) return undefined;
  const resourceUrl = new URL(MCP_PATH, config.data.origin).href;
  const runtime = await getHostedRuntime();
  const authenticate = await createMcpIdentity({
    issuer: config.data.issuer,
    audience: resourceUrl,
    mapClaims: async (claims) => ({
      tenantId: config.data.tenant,
      subjectId: String(claims.sub),
      // Same rule as the browser adapter: roles are signed by the issuer, and
      // a token that carries none is an executor and nothing more.
      capabilities: z
        .array(z.enum(["author", "reviewer", "publisher", "executor", "admin"]))
        .max(5)
        .catch(["executor"])
        .parse(claims.ceremony_roles ?? ["executor"]),
    }),
  });
  return createCeremonyMcpHandler(runtime, {
    resourceUrl,
    issuer: config.data.issuer,
    authenticate,
    serverName: "Ceremony",
  });
}

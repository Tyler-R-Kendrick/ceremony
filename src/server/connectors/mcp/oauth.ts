import type {
  AdapterCallContext,
  AuthorizationStart,
  CompletionInput,
  CompletionResult,
} from "../adapter.js";
import {
  AUTHORIZATION_CODE_INTENT,
  beginAuthorizationCode,
  completeAuthorizationCode,
} from "../auth/authorization-code.js";
import {
  connectionCredentialScope,
  optionalIssuerPolicy,
  resolveConnectorOAuth,
  type ConnectorOAuthOptions,
} from "../auth/connector-oauth.js";
import type { IssuerPolicy } from "../auth/policy.js";
import type { RuntimeBinding } from "../binding.js";
import { ConnectorError } from "../errors.js";
import type { BeginMcpOAuth, McpOAuthRequest } from "./adapter.js";

/*
 * The default OAuth profile for OAuth-protected remote MCP servers, built on
 * the same grants every other connector uses. The server's challenge says
 * which authorization servers protect it and which resource to name; the host
 * says which issuer it trusts, how the client exists there and what may be
 * contacted, in the issuer policy pinned under the approved binding
 * (`settings.oauth`). Both have to agree: an issuer the server does not list
 * is not asked, and an issuer the host did not write a policy for is never
 * discovered from the server's metadata alone.
 *
 * Without a policy in the binding this answers `mcp.oauth.policy-missing`,
 * which is the honest state of a deployment nobody configured, rather than
 * guessing an issuer from a document the server controls.
 */

function policyOf(binding: RuntimeBinding): IssuerPolicy | undefined {
  return optionalIssuerPolicy(binding.settings["oauth"]);
}

/** The policy with its resource indicator fixed to the MCP endpoint's canonical resource. */
function forResource(policy: IssuerPolicy, resource: string): IssuerPolicy {
  if (policy.resource !== undefined && policy.resource !== resource)
    throw new ConnectorError("network-policy", {
      detail: "mcp.oauth.resource-mismatch",
    });
  return { ...policy, resource };
}

async function begin(
  ctx: AdapterCallContext,
  request: McpOAuthRequest,
  options: ConnectorOAuthOptions,
): Promise<AuthorizationStart> {
  const configured = policyOf(ctx.binding);
  if (!configured)
    return { kind: "unsupported", code: "mcp.oauth.policy-missing" };
  const advertised = request.challenge.metadata?.authorizationServers ?? [];
  // RFC 9728: the resource names its authorization servers. One the host
  // trusts but the server does not name would be asked for a token the
  // server never agreed to accept.
  if (advertised.length && !advertised.includes(configured.issuer))
    return { kind: "unsupported", code: "mcp.oauth.issuer-not-advertised" };
  const policy = forResource(configured, request.resource);
  const scopes = request.intent.requestedPermissions.length
    ? [...request.intent.requestedPermissions]
    : [...request.challenge.requestedScopes];
  const resolved = await resolveConnectorOAuth(ctx, policy, options, {
    scope: scopes.join(" "),
    publish: true,
  });
  return beginAuthorizationCode(ctx, {
    server: resolved.server,
    client: resolved.client,
    policy,
    scopes,
    ...(request.intent.profileId
      ? { profileId: request.intent.profileId }
      : {}),
  });
}

/**
 * Completes a provider redirect for an MCP connection. Returns undefined for
 * anything that is not this module's handoff, so the adapter's own completion
 * rules apply to it unchanged.
 */
export async function completeMcpOAuth(
  ctx: AdapterCallContext,
  input: CompletionInput,
  options: ConnectorOAuthOptions,
): Promise<CompletionResult | undefined> {
  const handoff = ctx.handoff;
  if (
    input.kind !== "redirect" ||
    !handoff ||
    handoff.intent !== AUTHORIZATION_CODE_INTENT
  )
    return undefined;
  const configured = policyOf(ctx.binding);
  const resource = handoff.private["resource"];
  if (!configured || !resource)
    throw new ConnectorError("conflict", {
      detail: "mcp.oauth.policy-changed",
    });
  const policy = forResource(configured, resource);
  const resolved = await resolveConnectorOAuth(ctx, policy, options);
  const result = await completeAuthorizationCode(ctx, {
    url: input.url,
    handoff,
    server: resolved.server,
    client: resolved.client,
    policy,
    scope: connectionCredentialScope(ctx),
  });
  // The grant settled the handoff itself for these outcomes.
  return ["complete", "denied", "expired"].includes(result.state)
    ? { ...result, handoffSettled: true }
    : result;
}

/** The default `beginOAuth` hook, over the host seams a deployment supplies. */
export function createMcpOAuth(
  options: ConnectorOAuthOptions = {},
): BeginMcpOAuth {
  return (ctx, request) => begin(ctx, request, options);
}

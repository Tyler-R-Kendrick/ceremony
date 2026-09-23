import type { AdapterCallContext } from "../adapter.js";
import { ConnectorError } from "../errors.js";
import type { CredentialScope } from "../ports.js";
import { callbackUri } from "./authorization-code.js";
import {
  resolveClientRegistration,
  type ClientMetadataArtifact,
  type ClientRegistrationStorePort,
  type ResolvedClient,
} from "./client.js";
import {
  resolveAuthorizationServer,
  type MetadataCache,
  type ResolvedAuthorizationServer,
} from "./discovery.js";
import { issuerPolicy, type IssuerPolicy } from "./policy.js";

/*
 * The seam between an adapter and the grants in this module. An adapter that
 * speaks HTTP to a protected API (OpenAPI, a remote MCP server) knows which
 * profile a binding approved; it should not also know how to discover an
 * issuer, pick a registration profile or find the host's callback route.
 * This resolves all of that from the host-written issuer policy pinned under
 * the approved binding -- never from the description, whose declared
 * endpoints are hints a reviewer may copy into policy, not places to call.
 *
 * The same resolution runs at every step of one attempt (begin, callback,
 * poll, refresh) and yields the same client each time, because every input to
 * it is host state: policy, configuration, stored registrations, origin.
 */

export type ConnectorOAuthOptions = {
  /** Where RFC 7591 registrations persist; without it dynamic registration is refused, never improvised. */
  registrations?: ClientRegistrationStorePort | undefined;
  /** Authorization server metadata cache shared across calls; per-tenant keyed. */
  metadataCache?: MetadataCache | undefined;
  /** Path of the host's provider callback route on its own origin. */
  callbackPath?: string | undefined;
  clientName?: string | undefined;
  /**
   * Serves a client ID metadata document at its client id before an
   * authorization begins. Without it, a policy that selects CIMD is refused:
   * an issuer would fetch a document nobody published.
   */
  publishClientMetadata?:
    | ((
        ctx: AdapterCallContext,
        artifact: ClientMetadataArtifact,
      ) => Promise<void>)
    | undefined;
};

export type ConnectorOAuth = {
  policy: IssuerPolicy;
  server: ResolvedAuthorizationServer;
  client: ResolvedClient;
};

/** Parses a host-written policy value; absent means this binding has no OAuth policy. */
export function optionalIssuerPolicy(raw: unknown): IssuerPolicy | undefined {
  if (raw === undefined) return undefined;
  return issuerPolicy(raw as Parameters<typeof issuerPolicy>[0]);
}

/**
 * Discovery and client resolution for one binding's issuer policy. The
 * redirect URI is the host's own callback route, built from its exact origin.
 * `publish` is set only where an authorization is about to begin: that is the
 * one moment a CIMD document must already be reachable.
 */
export async function resolveConnectorOAuth(
  ctx: AdapterCallContext,
  policy: IssuerPolicy,
  options: ConnectorOAuthOptions,
  extra: {
    grantTypes?: readonly string[] | undefined;
    scope?: string | undefined;
    publish?: boolean | undefined;
  } = {},
): Promise<ConnectorOAuth> {
  const server = await resolveAuthorizationServer(policy, {
    fetch: ctx.environment.fetch,
    signal: ctx.signal,
    now: ctx.environment.now,
    tenantId: ctx.actor.tenantId,
    ...(options.metadataCache ? { cache: options.metadataCache } : {}),
  });
  const client = await resolveClientRegistration({
    actor: ctx.actor,
    policy,
    server,
    redirectUri: callbackUri(ctx, options.callbackPath),
    hostOrigin: ctx.environment.origin,
    configuration: ctx.environment.configuration,
    fetch: ctx.environment.fetch,
    registrations: options.registrations,
    effects: ctx.environment.effects,
    signal: ctx.signal,
    now: ctx.environment.now,
    ...(extra.grantTypes ? { grantTypes: extra.grantTypes } : {}),
    ...(extra.scope !== undefined ? { scope: extra.scope } : {}),
    ...(options.clientName ? { clientName: options.clientName } : {}),
  });
  if (client.metadataDocument && extra.publish) {
    if (!options.publishClientMetadata)
      throw new ConnectorError("configuration-required", {
        detail: "oauth.cimd.publisher-missing",
      });
    await options.publishClientMetadata(ctx, client.metadataDocument);
  }
  return { policy, server, client };
}

/**
 * The configuration names a policy needs that are not present, for a
 * `configuration-required` answer that tells the owner what to set rather
 * than failing on the first missing value.
 */
export async function missingClientConfiguration(
  ctx: AdapterCallContext,
  policy: IssuerPolicy,
): Promise<string[]> {
  const names = [
    policy.registration.clientIdConfiguration,
    policy.registration.clientSecretConfiguration,
    policy.registration.privateKeyConfiguration,
  ].filter((name): name is string => name !== undefined);
  if (!names.length) return [];
  const present = await ctx.environment.configuration.present(names);
  return names.filter((name) => !present.has(name));
}

/** The custody scope of the calling connection, under the connection's own custody kind. */
export function connectionCredentialScope(
  ctx: AdapterCallContext,
): CredentialScope {
  const connection = ctx.connection;
  if (!connection)
    throw new ConnectorError("invalid-request", {
      detail: "oauth.connection-required",
    });
  return {
    tenantId: connection.tenantId,
    ownerKind: connection.ownerKind,
    ownerId: connection.ownerId,
    connectionRef: connection.connectionRef,
    bindingRef: connection.bindingRef,
    custody: connection.custody,
  };
}

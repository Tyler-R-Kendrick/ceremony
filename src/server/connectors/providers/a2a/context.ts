import { createHash } from "node:crypto";
import { canonicalConnectorJson } from "../../../../core/connectors/index.js";
import type { AdapterCallContext } from "../../adapter.js";
import type { ApprovedDestination } from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import type { ConnectionRecord, CredentialScope } from "../../ports.js";
import { A2aClient, type A2aCredential } from "./client.js";
import {
  A2A_ADAPTER_ID,
  a2aBindingSettingsSchema,
  type A2aBindingSettings,
} from "./schemas.js";

/*
 * Where an A2A call is allowed to happen.
 *
 * The binding names the agent, the destination, the path, the profile, the
 * credential configuration name and the exact list of skills a caller may
 * delegate. None of that can come from a request, from the agent's own card
 * or from anything a model said. The authority string identifies this exact
 * agent instance so two agents that share a display name never share a
 * connection, a credential or a cache.
 */

export type A2aAdapterOptions = {
  /**
   * Host policy for whether one authenticated actor may act for an owner kind.
   * Defaults to "a user acts for themselves"; organization and workload
   * owners require an explicit host mapping.
   */
  ownerMapping?: (
    actor: AdapterCallContext["actor"],
    ownerKind: ConnectionRecord["ownerKind"],
  ) => { ownerId: string } | undefined;
};

export type ResolvedA2a = {
  ctx: AdapterCallContext;
  settings: A2aBindingSettings;
  destination: ApprovedDestination;
  authority: string;
  client: A2aClient;
};

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** `a2a:<profile>:<origin>:<agent name>`; the exact agent instance a connection belongs to. */
export function authorityInstanceFor(
  profile: string,
  origin: string,
  agentName: string,
): string {
  return `a2a:${profile}:${origin}:${agentName}`.slice(0, 256);
}

export function credentialScope(
  ctx: AdapterCallContext,
  connection: ConnectionRecord,
): CredentialScope {
  return {
    tenantId: connection.tenantId,
    ownerKind: connection.ownerKind,
    ownerId: connection.ownerId,
    connectionRef: connection.connectionRef,
    bindingRef: connection.bindingRef,
    custody: "host-owned",
  };
}

export function requireConnection(ctx: AdapterCallContext): ConnectionRecord {
  const connection = ctx.connection;
  if (!connection)
    throw new ConnectorError("invalid-request", {
      detail: "a2a.connection.required",
    });
  if (connection.tenantId !== ctx.actor.tenantId)
    throw new ConnectorError("denied", { detail: "a2a.connection.tenant" });
  if (connection.ownerId !== ctx.actor.subjectId)
    throw new ConnectorError("denied", { detail: "a2a.connection.owner" });
  if (connection.generation !== ctx.generation)
    throw new ConnectorError("conflict", { detail: "a2a.connection.generation" });
  return connection;
}

/**
 * Reads the credential this deployment presents to the agent. For a stored
 * connection the material is opened inside custody; before a connection
 * exists (the first verification) it is read from private configuration. In
 * both cases the value is handed to one bounded request and never returned,
 * cached or logged.
 */
function credentialReader(
  ctx: AdapterCallContext,
  settings: A2aBindingSettings,
  connection: ConnectionRecord | undefined,
): () => Promise<A2aCredential> {
  return async () => {
    if (settings.security.kind === "none") return { kind: "none" };
    const name = settings.security.configurationName;
    if (!ctx.binding.configuration.includes(name))
      throw new ConnectorError("configuration-required", {
        detail: "a2a.binding.configuration",
      });
    const raw = connection?.credentialRef
      ? await ctx.environment.credentials.use(
          credentialScope(ctx, connection),
          connection.credentialRef,
          async (material) => material.credential,
        )
      : await ctx.environment.configuration.read(name);
    if (!raw)
      throw new ConnectorError("configuration-required", {
        detail: "a2a.configuration.credential",
      });
    return settings.security.kind === "http-bearer"
      ? { kind: "http-bearer", token: raw }
      : {
          kind: "api-key",
          headerName: settings.security.headerName,
          value: raw,
        };
  };
}

/**
 * Checks the binding is an approved A2A binding this actor may use and pins
 * the destination. A binding for another adapter, another tenant or one that
 * is not approved is refused before anything is read or sent.
 */
export function resolveA2a(ctx: AdapterCallContext): ResolvedA2a {
  const binding = ctx.binding;
  if (binding.adapterId !== A2A_ADAPTER_ID)
    throw new ConnectorError("denied", { detail: "a2a.binding.adapter" });
  if (binding.tenantId !== ctx.actor.tenantId)
    throw new ConnectorError("denied", { detail: "a2a.binding.tenant" });
  if (binding.status !== "approved")
    throw new ConnectorError("denied", { detail: "a2a.binding.not-approved" });
  const parsed = a2aBindingSettingsSchema.safeParse(binding.settings);
  if (!parsed.success)
    throw new ConnectorError("configuration-required", {
      detail: "a2a.binding.settings",
    });
  const settings = parsed.data;
  const destination = binding.destinations.find(
    (item) => item.id === settings.agent.destinationId,
  );
  if (!destination)
    throw new ConnectorError("network-policy", {
      detail: "a2a.destination.missing",
    });
  const authority = authorityInstanceFor(
    settings.agent.profile,
    destination.origin,
    settings.agent.name,
  );
  if (binding.authorityInstance !== authority)
    throw new ConnectorError("denied", { detail: "a2a.binding.authority" });
  const client = new A2aClient({
    fetch: ctx.environment.fetch,
    destination,
    rpcPath: settings.agent.rpcPath,
    profile: settings.agent.profile,
    credential: credentialReader(ctx, settings, ctx.connection),
    signal: ctx.signal,
    now: ctx.environment.now,
    deadlineMs: settings.deadlineMs,
    maxResponseBytes: settings.maxResponseBytes,
    ...(settings.agent.tenant === undefined
      ? {}
      : { tenant: settings.agent.tenant }),
  });
  return { ctx, settings, destination, authority, client };
}

/** A stable, bounded digest of an effect's identity; the input to the effect journal. */
export function effectDigest(value: unknown): string {
  return sha256(canonicalConnectorJson(value));
}

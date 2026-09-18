import { createHash, randomBytes } from "node:crypto";
import type { ActorContext } from "../../../../core/operation-contracts.js";
import type { OwnerKind } from "../../../../core/connectors/index.js";
import type { AdapterCallContext } from "../../adapter.js";
import type { ApprovedDestination } from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import type { ConnectionRecord, CredentialScope } from "../../ports.js";
import { CooldownRegistry, NangoApi } from "./api.js";
import {
  NANGO_CONFIGURATION_NAMES,
  nangoBindingSettingsSchema,
  nangoEnvironmentSchema,
  type NangoBindingSettings,
} from "./schemas.js";

/*
 * Everything a Nango call needs to know about where it is: the approved api
 * and connect destinations, the environment the key belongs to, the binding's
 * host-approved settings and the authority string that names this exact
 * broker instance. Ownership is derived from the authenticated actor through
 * the host's mapping; tags are computed from that and sent to Nango as
 * correlation aids. Nothing here reads a header, a cookie or an argument.
 */

export const NANGO_ADAPTER_ID = "nango";

export type OwnerMapping = (
  actor: ActorContext,
  ownerKind: OwnerKind,
) => { ownerId: string; organizationId?: string } | undefined;

export type NangoAdapterOptions = {
  /** Host policy mapping an authenticated actor to the owner of a connection; default: user → subject. */
  ownerMapping?: OwnerMapping;
  /** Resolves a broker connection id to the local connection that holds it (command layer lookup). */
  resolveConnection?: (lookup: {
    tenantId: string;
    authorityInstance: string;
    providerConfigKey: string;
    connectionId: string;
  }) => Promise<{ connectionRef: string; generation: number } | undefined>;
  /** Other local connections referencing the same broker connection; blocks broker deletion. */
  sharedReferences?: (lookup: {
    tenantId: string;
    authorityInstance: string;
    providerConfigKey: string;
    connectionId: string;
    excludeConnectionRef: string;
  }) => Promise<string[]>;
  /** Event inbox: true when this authority already processed the event id. */
  eventInbox?: { seen(authority: string, eventId: string, at: number): Promise<boolean> };
};

export type NangoRuntime = {
  options: NangoAdapterOptions;
  cooldown: CooldownRegistry;
  rate: RateWindowRegistry;
};

/** A per-connection, per-operation sliding minute window; bounded and tenant-scoped by key. */
export class RateWindowRegistry {
  private readonly windows = new Map<string, number[]>();
  take(key: string, perMinute: number, now: number): void {
    const recent = (this.windows.get(key) ?? []).filter(
      (at) => at > now - 60_000,
    );
    if (recent.length >= perMinute)
      throw new ConnectorError("rate-limited", {
        detail: "nango.operation.rate-limit",
      });
    recent.push(now);
    this.windows.set(key, recent);
    if (this.windows.size > 8192) {
      const first = this.windows.keys().next().value;
      if (first !== undefined) this.windows.delete(first);
    }
  }
}

export type Resolved = {
  ctx: AdapterCallContext;
  settings: NangoBindingSettings;
  api: ApprovedDestination;
  connect: ApprovedDestination | undefined;
  environment: string;
  /** `nango:<environment>:<api origin>`; the exact broker instance a connection belongs to. */
  authority: string;
  client: NangoApi;
};

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function authorityInstanceFor(environment: string, apiOrigin: string) {
  return `nango:${environment}:${apiOrigin}`;
}

/** Names present among the adapter's configuration, for readiness reports. */
export async function presentConfiguration(ctx: AdapterCallContext) {
  return ctx.environment.configuration.present(
    Object.values(NANGO_CONFIGURATION_NAMES),
  );
}

export function missingRequired(present: ReadonlySet<string>): string[] {
  return [
    NANGO_CONFIGURATION_NAMES.secretKey,
    NANGO_CONFIGURATION_NAMES.environment,
  ].filter((name) => !present.has(name));
}

const originOf = (value: string) => {
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  return url.origin === value ||
    (url.pathname === "/" && !url.search && !url.hash && url.origin + "/" === value)
    ? url.origin
    : undefined;
};

/**
 * Checks the binding is a Nango binding this actor may use, reads the
 * environment and host configuration, and pins the approved destinations. A
 * configured NANGO_HOST that disagrees with the approved `api` destination is
 * a policy failure, not a preference.
 */
export async function resolveNango(
  runtime: NangoRuntime,
  ctx: AdapterCallContext,
): Promise<Resolved> {
  const binding = ctx.binding;
  if (binding.adapterId !== NANGO_ADAPTER_ID)
    throw new ConnectorError("denied", { detail: "nango.binding.adapter" });
  if (binding.tenantId !== ctx.actor.tenantId)
    throw new ConnectorError("denied", { detail: "nango.binding.tenant" });
  if (binding.status !== "approved")
    throw new ConnectorError("denied", { detail: "nango.binding.not-approved" });
  const parsedSettings = nangoBindingSettingsSchema.safeParse(binding.settings);
  if (!parsedSettings.success)
    throw new ConnectorError("configuration-required", {
      detail: "nango.binding.settings",
    });
  const settings = parsedSettings.data;
  const api = binding.destinations.find((item) => item.id === "api");
  if (!api)
    throw new ConnectorError("network-policy", {
      detail: "nango.destination.api-missing",
    });
  const connect = binding.destinations.find((item) => item.id === "connect");
  const configuration = ctx.environment.configuration;
  const environmentValue = await configuration.read(
    NANGO_CONFIGURATION_NAMES.environment,
  );
  const environment = nangoEnvironmentSchema.safeParse(environmentValue);
  if (!environment.success)
    throw new ConnectorError("configuration-required", {
      detail: "nango.configuration.environment",
    });
  const host = await configuration.read(NANGO_CONFIGURATION_NAMES.host);
  if (host !== undefined && originOf(host) !== api.origin)
    throw new ConnectorError("network-policy", {
      detail: "nango.destination.host-mismatch",
    });
  const authority = authorityInstanceFor(environment.data, api.origin);
  const client = new NangoApi({
    fetch: ctx.environment.fetch,
    destination: api,
    secret: async () => {
      const secret = await configuration.read(NANGO_CONFIGURATION_NAMES.secretKey);
      if (!secret)
        throw new ConnectorError("configuration-required", {
          detail: "nango.configuration.secret-key",
        });
      return secret;
    },
    signal: ctx.signal,
    now: ctx.environment.now,
    cooldown: runtime.cooldown,
    cooldownKey: `${ctx.actor.tenantId}\n${authority}`,
  });
  return { ctx, settings, api, connect, environment: environment.data, authority, client };
}

/** The connection this call is about, checked against the binding, tenant and broker instance. */
export function requireConnection(resolved: Resolved): ConnectionRecord {
  const { ctx } = resolved;
  const connection = ctx.connection;
  if (!connection)
    throw new ConnectorError("invalid-request", { detail: "nango.connection.required" });
  if (
    connection.tenantId !== ctx.actor.tenantId ||
    connection.bindingRef !== ctx.binding.bindingRef ||
    connection.ecosystem !== "nango"
  )
    throw new ConnectorError("denied", { detail: "nango.connection.binding" });
  if (connection.generation !== ctx.generation)
    throw new ConnectorError("conflict", { detail: "nango.connection.generation" });
  return connection;
}

export type BrokerReference = {
  connectionId: string;
  providerConfigKey: string;
  provider: string;
  environment: string;
  authority: string;
};

/**
 * The upstream identity an active connection holds, read from the record's
 * external ids and checked field by field: same broker instance, same
 * integration unique key, same environment. A connection id that exists in
 * another integration or environment is another connection (AC-NG-04).
 */
export function brokerReference(resolved: Resolved): BrokerReference {
  const connection = requireConnection(resolved);
  const ids = connection.externalIds;
  const connectionId = ids.connectionId;
  const providerConfigKey = ids.providerConfigKey;
  const environment = ids.environment;
  if (!connectionId || !providerConfigKey || !environment)
    throw new ConnectorError("invalid-request", {
      detail: "nango.connection.unbound",
    });
  if (connection.authorityInstance !== resolved.authority)
    throw new ConnectorError("denied", { detail: "nango.connection.authority" });
  if (environment !== resolved.environment)
    throw new ConnectorError("denied", { detail: "nango.connection.environment" });
  if (providerConfigKey !== resolved.settings.integration.uniqueKey)
    throw new ConnectorError("denied", { detail: "nango.connection.integration" });
  return {
    connectionId,
    providerConfigKey,
    provider: ids.provider ?? resolved.settings.integration.provider,
    environment,
    authority: resolved.authority,
  };
}

export function credentialScope(
  ctx: AdapterCallContext,
  connection: ConnectionRecord,
): CredentialScope {
  return {
    tenantId: ctx.actor.tenantId,
    ownerKind: connection.ownerKind,
    ownerId: connection.ownerId,
    connectionRef: connection.connectionRef,
    bindingRef: ctx.binding.bindingRef,
    custody: "external-credential-broker",
  };
}

/** Owner identity as sent to the broker: a digest the host can recompute, never a raw subject. */
export function ownerDigest(tenantId: string, ownerKind: OwnerKind, ownerId: string) {
  return sha256(`nango-owner\n${tenantId}\n${ownerKind}\n${ownerId}`);
}
export function tenantDigest(tenantId: string) {
  return sha256(`nango-tenant\n${tenantId}`);
}

export const TAG_KEYS = Object.freeze({
  endUser: "end_user_id",
  organization: "organization_id",
  tenant: "ceremony_tenant",
  connection: "ceremony_connection",
  generation: "ceremony_generation",
  handoff: "ceremony_handoff",
  binding: "ceremony_binding",
});

export const defaultOwnerMapping: OwnerMapping = (actor, ownerKind) =>
  ownerKind === "user" ? { ownerId: actor.subjectId } : undefined;

/**
 * Tags derived from the authenticated actor and the host owner mapping only.
 * They reconcile Nango's webhooks with our records and are never evidence of
 * ownership on their own: a tag arriving in a payload is compared against
 * these values, not trusted for what it says.
 */
export function deriveTags(input: {
  runtime: NangoRuntime;
  ctx: AdapterCallContext;
  connection: ConnectionRecord;
  ownerKind: OwnerKind;
  nonce: string;
}): Record<string, string> {
  const { ctx, connection } = input;
  const mapping = (input.runtime.options.ownerMapping ?? defaultOwnerMapping)(
    ctx.actor,
    input.ownerKind,
  );
  if (!mapping)
    throw new ConnectorError("denied", { detail: "nango.owner.mapping-required" });
  if (connection.ownerKind !== input.ownerKind)
    throw new ConnectorError("denied", { detail: "nango.owner.kind-mismatch" });
  const tags: Record<string, string> = {
    [TAG_KEYS.endUser]: ownerDigest(ctx.actor.tenantId, input.ownerKind, mapping.ownerId),
    [TAG_KEYS.tenant]: tenantDigest(ctx.actor.tenantId),
    [TAG_KEYS.connection]: connection.connectionRef,
    [TAG_KEYS.generation]: String(ctx.generation),
    [TAG_KEYS.handoff]: input.nonce,
    [TAG_KEYS.binding]: ctx.binding.bindingRef,
  };
  if (mapping.organizationId)
    tags[TAG_KEYS.organization] = ownerDigest(
      ctx.actor.tenantId,
      "organization",
      mapping.organizationId,
    );
  return tags;
}

export function freshNonce(ctx: AdapterCallContext): string {
  const bytes = ctx.environment.random.bytes(24);
  return Buffer.from(bytes.byteLength === 24 ? bytes : randomBytes(24)).toString(
    "base64url",
  );
}

/** The deterministic correlation key of a reconnect handoff for one connection generation. */
export function reconnectCorrelationKey(connectionRef: string, generation: number) {
  return `nango-reconnect:${connectionRef}:${generation}`;
}

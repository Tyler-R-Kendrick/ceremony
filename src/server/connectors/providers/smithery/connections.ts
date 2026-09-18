import { z } from "zod";
import { canonicalDigest } from "../../../../core/connectors/identity.js";
import {
  boundOperation,
  destinationFor,
  type ApprovedDestination,
  type RuntimeBinding,
} from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import {
  capabilityStatus,
  type AdapterCallContext,
  type AuthorizationIntent,
  type AuthorizationStart,
  type CapabilityStatus,
  type CompletionInput,
  type CompletionResult,
  type ConnectorAdapter,
  type DisconnectResult,
  type DisconnectScope,
  type InvokeRequest,
  type InvokeResult,
  type VerificationClaim,
} from "../../adapter.js";
import {
  assertConnectionId,
  assertNamespace,
  readBoundedJson,
  segment,
  smitheryConnectionSchema,
  smitheryFailure,
  smitheryTokenSchema,
  smitheryUrl,
  SMITHERY_ADAPTER_VERSION,
  SMITHERY_API_KEY,
  SMITHERY_CONNECT_PROFILE,
  SMITHERY_ECOSYSTEM,
  type SmitheryConnection,
} from "../../registries/smithery/api.js";
import type { McpClientFactory } from "./ports.js";

/*
 * CAT-02: Smithery managed connections.
 *
 * Custody is external-execution-broker: the upstream credential lives inside
 * Smithery, is documented as write-only, and never reaches this process. What
 * this adapter holds is a namespace, a connection id and a short-lived scoped
 * service token minted for exactly that namespace and that connection's
 * metadata. The namespace and connection come from the reviewed binding, not
 * from a caller: a token that cannot reach the selected connection fails
 * closed, with no retry using the deployment's API key, no attempt to create a
 * namespace, and no substitution of another connection (AC-EXT-07).
 */

export const SMITHERY_CONNECTIONS_OPERATION = {
  upsert: "smithery.connections.upsert",
  get: "smithery.connections.get",
  delete: "smithery.connections.delete",
  token: "smithery.tokens.create",
} as const;

export const smitherySettingsSchema = z.strictObject({
  /** Host-approved namespace; never a caller argument. */
  namespace: z.string().min(1).max(128),
  /** Host-approved connection id within that namespace. */
  connectionId: z.string().min(1).max(128),
  /** The MCP server this connection targets, as Smithery accepts it. */
  mcpUrl: z.string().max(2048).optional(),
  server: z.string().max(255).optional(),
  /** Metadata the host attaches and scopes tokens by (for example a user id). */
  metadata: z.record(z.string().max(64), z.string().max(256)).optional(),
  /** Destination id of the namespace MCP endpoint inside the binding. */
  mcpDestinationId: z.string().max(96).optional(),
  displayName: z.string().max(200).optional(),
});
export type SmitherySettings = z.infer<typeof smitherySettingsSchema>;

export type SmitheryConnectionsOptions = {
  /** Supplied by the host; absent means runtime calls are unavailable. */
  mcpClient?: McpClientFactory;
  /** Token lifetime requested when minting a scoped service token. */
  tokenTtl?: string;
};

function settingsOf(binding: RuntimeBinding): SmitherySettings {
  const parsed = smitherySettingsSchema.safeParse(binding.settings);
  if (!parsed.success)
    throw new ConnectorError("configuration-required", {
      detail: "smithery.binding.settings",
    });
  const settings = parsed.data;
  assertNamespace(settings.namespace);
  assertConnectionId(settings.connectionId);
  // The binding's permitted targets are authoritative. An approved binding
  // that does not name this namespace cannot be used to reach it, and no code
  // path creates a namespace that is missing.
  const namespaces = binding.permittedTargets.filter(
    (target) => target.kind === "namespace",
  );
  if (
    namespaces.length &&
    !namespaces.some((target) => target.id === settings.namespace)
  )
    throw new ConnectorError("denied", {
      detail: "smithery.namespace.not-permitted",
    });
  const connections = binding.permittedTargets.filter(
    (target) => target.kind === "connection",
  );
  if (
    connections.length &&
    !connections.some((target) => target.id === settings.connectionId)
  )
    throw new ConnectorError("denied", {
      detail: "smithery.connection.not-permitted",
    });
  return settings;
}

function operationUrl(
  ctx: AdapterCallContext,
  operationRef: string,
  expect: "GET" | "PUT" | "POST" | "DELETE",
  suffix: string[],
): { url: URL; destination: ApprovedDestination } {
  const operation = boundOperation(ctx.binding, operationRef);
  if (!operation || operation.transport.kind !== "http")
    throw new ConnectorError("configuration-required", {
      detail: "smithery.operation.unbound",
    });
  if (operation.transport.method !== expect)
    throw new ConnectorError("invalid-request", {
      detail: "smithery.operation.method",
    });
  const destination = destinationFor(ctx.binding, operation);
  return {
    url: smitheryUrl(destination, operation.transport.pathTemplate, suffix),
    destination,
  };
}

async function apiKey(ctx: AdapterCallContext): Promise<string> {
  const value = await ctx.environment.configuration.read(SMITHERY_API_KEY);
  if (!value)
    throw new ConnectorError("configuration-required", {
      detail: "smithery.api-key.missing",
    });
  return value;
}

function privateUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 2048) return undefined;
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username || url.password) return undefined;
  return url.href;
}

function missingNames(connection: SmitheryConnection): string[] {
  if (connection.status.state !== "input_required") return [];
  const missing = connection.status.missing;
  return [
    ...(missing?.headers ?? []).map((name) => `header:${name}`),
    ...(missing?.query ?? []).map((name) => `query:${name}`),
  ].slice(0, 32);
}

export function createSmitheryConnectionsAdapter(
  options: SmitheryConnectionsOptions = {},
): ConnectorAdapter {
  const ttl = options.tokenTtl ?? "1h";

  async function readConnection(
    ctx: AdapterCallContext,
    settings: SmitherySettings,
  ): Promise<SmitheryConnection> {
    const { url } = operationUrl(ctx, SMITHERY_CONNECTIONS_OPERATION.get, "GET", [
      segment(settings.namespace),
      segment(settings.connectionId),
    ]);
    const response = await ctx.environment.fetch(url, {
      method: "GET",
      redirect: "error",
      signal: ctx.signal,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${await apiKey(ctx)}`,
      },
    });
    if (!response.ok) throw smitheryFailure(response.status);
    const parsed = smitheryConnectionSchema.safeParse(
      await readBoundedJson(response),
    );
    if (!parsed.success)
      throw new ConnectorError("upstream-rejected", {
        detail: "smithery.connection.unrecognized",
      });
    if (parsed.data.connectionId !== settings.connectionId)
      throw new ConnectorError("denied", {
        detail: "smithery.connection.substituted",
      });
    return parsed.data;
  }

  /**
   * Mints a service token scoped to this namespace, the `connections`
   * resource, the operations a runtime call needs and the binding's metadata.
   * A failure here is final: the deployment's API key is a backend credential
   * and is never used as the bearer of a runtime call.
   */
  async function mintToken(
    ctx: AdapterCallContext,
    settings: SmitherySettings,
    operations: Array<"read" | "write" | "execute">,
  ): Promise<string> {
    const { url } = operationUrl(
      ctx,
      SMITHERY_CONNECTIONS_OPERATION.token,
      "POST",
      [],
    );
    const response = await ctx.environment.fetch(url, {
      method: "POST",
      redirect: "error",
      signal: ctx.signal,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${await apiKey(ctx)}`,
      },
      body: JSON.stringify({
        policy: [
          {
            namespaces: settings.namespace,
            resources: "connections",
            operations,
            ...(settings.metadata ? { metadata: settings.metadata } : {}),
            ttl,
          },
        ],
      }),
    });
    if (!response.ok) throw smitheryFailure(response.status);
    const parsed = smitheryTokenSchema.safeParse(await readBoundedJson(response));
    if (!parsed.success)
      throw new ConnectorError("upstream-rejected", {
        detail: "smithery.token.unrecognized",
      });
    return parsed.data.token;
  }

  function claimsFor(
    ctx: AdapterCallContext,
    settings: SmitherySettings,
    connection: SmitheryConnection,
  ): VerificationClaim[] {
    const observedAt = new Date(ctx.environment.now()).toISOString();
    const base = {
      evidenceRef: `smithery:${settings.namespace}:${settings.connectionId}`.slice(
        0,
        200,
      ),
      issuer: "external-broker" as const,
      observedAt,
      verifierVersion: SMITHERY_ADAPTER_VERSION,
      bindingRevision: ctx.binding.revision,
      policyRevision: ctx.binding.policyRevision,
    };
    const claims: VerificationClaim[] = [
      {
        ...base,
        kind: "credential-accepted",
        target: { kind: "connection", id: settings.connectionId },
        limitations: [
          "Smithery reports that the managed connection is usable; the upstream credential is write-only and never reaches this deployment.",
          "A connected state is not evidence of which upstream account the credential belongs to.",
        ],
      },
    ];
    const serverName = connection.serverInfo?.name;
    if (serverName)
      claims.push({
        ...base,
        kind: "resource-access",
        target: { kind: "mcp-server", id: serverName },
        limitations: [
          "The MCP server identified itself during initialization; Smithery does not attest the upstream account behind it.",
        ],
      });
    return claims;
  }

  const adapter: ConnectorAdapter = {
    id: "smithery",
    ecosystem: SMITHERY_ECOSYSTEM,
    adapterVersion: SMITHERY_ADAPTER_VERSION,
    runtime: "hosted-server",
    displayName: "Smithery managed connection",
    description:
      "Creates and uses a Smithery-managed MCP connection. Credentials stay with Smithery; Ceremony holds a namespace, a connection id and short-lived scoped tokens.",
    service: "smithery",
    support: "provider-backed",
    custody: ["external-execution-broker"],
    configuration: [
      {
        name: SMITHERY_API_KEY,
        source: "session-environment",
        classification: "secret",
        required: true,
        description: "Backend Smithery API key; never sent to a browser.",
      },
    ],
    profiles: [SMITHERY_CONNECT_PROFILE, "external-broker"],
    capabilities(present: ReadonlySet<string>): CapabilityStatus[] {
      const configuration = present.has(SMITHERY_API_KEY) ? "ready" : "missing";
      const rows: CapabilityStatus[] = [];
      for (const dimension of [
        "configure",
        "authorize",
        "verify",
        "reconnect",
        "disconnect",
      ] as const)
        rows.push(
          capabilityStatus(adapter, {
            dimension,
            profile: SMITHERY_CONNECT_PROFILE,
            configuration,
            evidence: "protocol-fixture",
            limitations: [
              "Smithery states the connection's state; it exposes no upstream account identity.",
            ],
          }),
        );
      rows.push(
        options.mcpClient
          ? capabilityStatus(adapter, {
              dimension: "invoke",
              profile: SMITHERY_CONNECT_PROFILE,
              configuration,
              evidence: "protocol-fixture",
              limitations: [
                "Runtime calls go to the namespace MCP endpoint pinned by the binding, with a token scoped to this namespace and connection.",
              ],
            })
          : capabilityStatus(adapter, {
              dimension: "invoke",
              profile: SMITHERY_CONNECT_PROFILE,
              implementation: "unsupported",
              limitations: [
                "No MCP client is configured for this deployment, so approved remote execution is unavailable.",
              ],
            }),
      );
      rows.push(
        capabilityStatus(adapter, {
          dimension: "revoke",
          profile: SMITHERY_CONNECT_PROFILE,
          implementation: "unsupported",
          limitations: [
            "Deleting a Smithery connection ends the brokered session; it does not revoke the upstream provider's grant.",
          ],
        }),
      );
      for (const dimension of [
        "discover",
        "import",
        "events",
        "export",
        "delegate",
      ] as const)
        rows.push(
          capabilityStatus(adapter, {
            dimension,
            profile: SMITHERY_CONNECT_PROFILE,
            implementation: "unsupported",
            limitations: [
              dimension === "discover" || dimension === "import"
                ? "Catalog reading is the separate smithery-registry adapter."
                : "Not offered by Smithery's documented connection API.",
            ],
          }),
        );
      return rows;
    },

    async authorize(
      ctx: AdapterCallContext,
      intent: AuthorizationIntent,
    ): Promise<AuthorizationStart> {
      const settings = settingsOf(ctx.binding);
      if (intent.ownerKind !== "user" && intent.ownerKind !== "organization")
        return { kind: "unsupported", code: "smithery.owner-kind" };
      const { url } = operationUrl(
        ctx,
        SMITHERY_CONNECTIONS_OPERATION.upsert,
        "PUT",
        [segment(settings.namespace), segment(settings.connectionId)],
      );
      const body = {
        ...(settings.mcpUrl ? { mcpUrl: settings.mcpUrl } : {}),
        ...(settings.server ? { server: settings.server } : {}),
        ...(settings.displayName ? { name: settings.displayName } : {}),
        ...(settings.metadata ? { metadata: settings.metadata } : {}),
      };
      const digest = await canonicalDigest({
        operation: "smithery.connection.upsert",
        namespace: settings.namespace,
        connectionId: settings.connectionId,
        body,
      });
      const effect = await ctx.environment.effects.begin({
        actor: ctx.actor,
        bindingRef: ctx.binding.bindingRef,
        operation: "smithery.connection.upsert",
        digest,
      });
      let connection: SmitheryConnection;
      try {
        const response = await ctx.environment.fetch(url, {
          method: "PUT",
          redirect: "error",
          signal: ctx.signal,
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            authorization: `Bearer ${await apiKey(ctx)}`,
          },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          await ctx.environment.effects.complete(effect.effectRef, {
            status: response.status >= 500 ? "indeterminate" : "not-applied",
            at: ctx.environment.now(),
          });
          throw smitheryFailure(response.status);
        }
        const parsed = smitheryConnectionSchema.safeParse(
          await readBoundedJson(response),
        );
        if (!parsed.success)
          throw new ConnectorError("upstream-rejected", {
            detail: "smithery.connection.unrecognized",
          });
        connection = parsed.data;
        await ctx.environment.effects.complete(effect.effectRef, {
          status: "applied",
          at: ctx.environment.now(),
        });
      } catch (error) {
        if (error instanceof ConnectorError) throw error;
        await ctx.environment.effects.complete(effect.effectRef, {
          status: "indeterminate",
          at: ctx.environment.now(),
        });
        throw new ConnectorError("upstream-unavailable", {
          detail: "smithery.connection.upsert-failed",
        });
      }
      const state = connection.status.state;
      if (state === "connected") return { kind: "verify" };
      if (state === "auth_required") {
        if (intent.interruption === "none")
          return { kind: "human-required", code: "smithery.authorization" };
        const setupUrl =
          privateUrl(connection.status.setupUrl) ??
          privateUrl(connection.status.authorizationUrl);
        if (!setupUrl)
          return { kind: "human-required", code: "smithery.setup-url" };
        return {
          kind: "handoff",
          handoff: {
            kind: "provider-browser",
            presentation: "popup",
            expiresAt: ctx.environment.now() + 10 * 60 * 1000,
            intent: "smithery.connection.authorize",
            correlationKey: `smithery:${settings.namespace}:${settings.connectionId}`,
            // The setup link is protected transient material: it belongs to
            // the initiating human's own surface and to nothing else.
            private: { url: setupUrl },
          },
        };
      }
      if (state === "input_required")
        return {
          kind: "configuration-required",
          missing: missingNames(connection),
        };
      if (state === "error")
        return { kind: "human-required", code: "smithery.connection-error" };
      return { kind: "verify" };
    },

    async complete(
      ctx: AdapterCallContext,
      input: CompletionInput,
    ): Promise<CompletionResult> {
      if (input.kind === "redirect" || input.kind === "event")
        // A browser return is not authority: the broker's own state is.
        return this.verify!(ctx);
      if (input.kind === "input")
        return {
          state: "human-required",
          claims: [],
          code: "smithery.configuration-required",
        };
      return this.verify!(ctx);
    },

    async verify(ctx: AdapterCallContext): Promise<CompletionResult> {
      const settings = settingsOf(ctx.binding);
      const connection = await readConnection(ctx, settings);
      const externalIds = {
        namespace: settings.namespace,
        connectionId: connection.connectionId,
      };
      switch (connection.status.state) {
        case "connected":
          return {
            state: "complete",
            claims: claimsFor(ctx, settings, connection),
            externalIds,
            target: { kind: "connection", id: connection.connectionId },
          };
        case "auth_required":
          return {
            state: "pending",
            claims: [],
            externalIds,
            code: "smithery.authorization-required",
          };
        case "input_required":
          return {
            state: "human-required",
            claims: [],
            externalIds,
            code: "smithery.configuration-required",
          };
        case "disconnected":
          return {
            state: "pending",
            claims: [],
            externalIds,
            code: "smithery.disconnected",
          };
        default:
          return {
            state: "denied",
            claims: [],
            externalIds,
            code: "smithery.connection-error",
          };
      }
    },

    async reconnect(
      ctx: AdapterCallContext,
      intent: AuthorizationIntent,
    ): Promise<AuthorizationStart> {
      return this.authorize!(ctx, intent);
    },

    async invoke(
      ctx: AdapterCallContext,
      request: InvokeRequest,
    ): Promise<InvokeResult> {
      const settings = settingsOf(ctx.binding);
      const factory = options.mcpClient;
      if (!factory)
        throw new ConnectorError("unsupported", {
          detail: "smithery.mcp-client.missing",
        });
      const operation = boundOperation(ctx.binding, request.operationRef);
      if (!operation || operation.transport.kind !== "mcp-tool")
        throw new ConnectorError("denied", {
          detail: "smithery.operation.unapproved",
        });
      const destinationId = settings.mcpDestinationId ?? operation.destinationId;
      const destination = ctx.binding.destinations.find(
        (item) => item.id === destinationId,
      );
      if (!destination)
        throw new ConnectorError("configuration-required", {
          detail: "smithery.mcp-destination.unbound",
        });
      // The endpoint is the binding's approved origin plus the approved
      // namespace; no part of it comes from the caller or from Smithery.
      const endpoint = smitheryUrl(destination, "/", [
        segment(settings.namespace),
      ]);
      const token = await mintToken(ctx, settings, ["read", "execute"]);
      const digest = await canonicalDigest({
        operation: request.operationRef,
        namespace: settings.namespace,
        connectionId: settings.connectionId,
        input: request.input,
        commandId: request.commandId,
      });
      const effect = await ctx.environment.effects.begin({
        actor: ctx.actor,
        bindingRef: ctx.binding.bindingRef,
        operation: request.operationRef,
        digest,
        commandId: request.commandId,
      });
      if (effect.prior && effect.prior.status !== "indeterminate")
        return {
          state: effect.prior.status === "applied" ? "complete" : "failed",
          outputClassification: operation.outputClassification,
          effect: operation.effect,
          effectRef: effect.effectRef,
          ...(effect.prior.code ? { code: effect.prior.code } : {}),
        };
      const client = factory({
        endpoint,
        bearer: {
          async use<T>(work: (value: string) => Promise<T>): Promise<T> {
            return work(token);
          },
        },
        fetch: ctx.environment.fetch,
        ctx,
      });
      try {
        const outcome = await client.callTool({
          // Smithery's namespace endpoint prefixes tools with the connection id.
          name: `${settings.connectionId}.${operation.transport.toolName}`,
          arguments:
            request.input && typeof request.input === "object"
              ? (request.input as Record<string, unknown>)
              : {},
          effect: operation.effect,
          signal: ctx.signal,
        });
        if (outcome.kind === "complete") {
          await ctx.environment.effects.complete(effect.effectRef, {
            status: outcome.payload.isError ? "failed" : "applied",
            at: ctx.environment.now(),
          });
          return {
            state: outcome.payload.isError ? "failed" : "complete",
            output: outcome.payload.structuredContent ?? outcome.payload.content,
            outputClassification: operation.outputClassification,
            effect: operation.effect,
            effectRef: effect.effectRef,
          };
        }
        if (outcome.kind === "authorization-required") {
          await ctx.environment.effects.complete(effect.effectRef, {
            status: "not-applied",
            at: ctx.environment.now(),
          });
          return {
            state: "denied",
            outputClassification: operation.outputClassification,
            effect: operation.effect,
            code: "smithery.authorization-required",
            effectRef: effect.effectRef,
          };
        }
        if (outcome.kind === "input-required") {
          await ctx.environment.effects.complete(effect.effectRef, {
            status: "not-applied",
            at: ctx.environment.now(),
          });
          return {
            state: "human-required",
            outputClassification: operation.outputClassification,
            effect: operation.effect,
            code: "smithery.input-required",
            effectRef: effect.effectRef,
          };
        }
        const applied =
          outcome.kind === "failed" ? outcome.applied : ("unknown" as const);
        await ctx.environment.effects.complete(effect.effectRef, {
          status: applied === "no" ? "not-applied" : "indeterminate",
          at: ctx.environment.now(),
        });
        return {
          state: applied === "no" ? "failed" : "indeterminate",
          outputClassification: operation.outputClassification,
          effect: operation.effect,
          code: "smithery.tool-failed",
          effectRef: effect.effectRef,
        };
      } finally {
        client.close?.();
      }
    },

    async disconnect(
      ctx: AdapterCallContext,
      scope: DisconnectScope,
    ): Promise<DisconnectResult> {
      const settings = settingsOf(ctx.binding);
      const result: DisconnectResult = {
        local: "applied",
        broker: "not-attempted",
        // Smithery brokers the session; the upstream provider's grant is the
        // provider's own, and deleting a connection does not revoke it.
        upstream: "unsupported",
      };
      if (scope === "local") return result;
      const { url } = operationUrl(
        ctx,
        SMITHERY_CONNECTIONS_OPERATION.delete,
        "DELETE",
        [segment(settings.namespace), segment(settings.connectionId)],
      );
      const digest = await canonicalDigest({
        operation: "smithery.connection.delete",
        namespace: settings.namespace,
        connectionId: settings.connectionId,
      });
      const effect = await ctx.environment.effects.begin({
        actor: ctx.actor,
        bindingRef: ctx.binding.bindingRef,
        operation: "smithery.connection.delete",
        digest,
      });
      const response = await ctx.environment.fetch(url, {
        method: "DELETE",
        redirect: "error",
        signal: ctx.signal,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${await apiKey(ctx)}`,
        },
      });
      if (response.ok) {
        await ctx.environment.effects.complete(effect.effectRef, {
          status: "applied",
          at: ctx.environment.now(),
        });
        return { ...result, broker: "applied" };
      }
      if (response.status === 404) {
        await ctx.environment.effects.complete(effect.effectRef, {
          status: "not-applied",
          at: ctx.environment.now(),
        });
        return { ...result, broker: "not-attempted" };
      }
      await ctx.environment.effects.complete(effect.effectRef, {
        status: response.status >= 500 ? "indeterminate" : "failed",
        at: ctx.environment.now(),
      });
      return {
        ...result,
        broker: response.status >= 500 ? "indeterminate" : "failed",
      };
    },

    async revoke(ctx: AdapterCallContext): Promise<DisconnectResult> {
      const broker = await this.disconnect!(ctx, "broker");
      return { ...broker, upstream: "unsupported" };
    },
  };
  return adapter;
}

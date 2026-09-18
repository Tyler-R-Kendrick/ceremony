import { z } from "zod";
import {
  capabilityStatus,
  type AdapterCallContext,
  type CapabilityStatus,
  type CompletionResult,
  type ConfigurationRequirement,
  type ConnectorAdapter,
  type DiscoverInput,
  type DiscoverResult,
  type InvokeRequest,
  type InvokeResult,
} from "../../adapter.js";
import {
  boundOperation,
  destinationFor,
  destinationUrl,
  type ApprovedDestination,
  type BoundOperation,
} from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import { discoverNdc, NDC_IMPORTER, type NdcClient } from "./discover.js";
import {
  buildNdcMutationRequest,
  buildNdcQueryRequest,
  ndcMutationInputSchema,
  ndcPolicyFrom,
  ndcQueryInputSchema,
} from "./policy.js";
import {
  ndcCapabilitiesResponseSchema,
  ndcEndpoints,
  ndcMutationResponseSchema,
  ndcQueryResponseSchema,
  ndcSchemaResponseSchema,
  ndcVersionCompatible,
  NDC_PINNED_VERSION,
  NDC_PROFILE,
  type NdcCapabilities,
  type NdcSchemaResponse,
} from "./spec.js";

/*
 * The NDC adapter speaks the connector's own protocol. Custody is host-owned:
 * a connector is a service the deployment operates or is authorized to call,
 * and its service token (when one is configured) is used inside the credential
 * port and never surfaces.
 *
 * Policy is enforced before submission, not after: an unapproved field, a
 * predicate the connector's capabilities do not declare, a relationship the
 * binding did not name — each is refused with the connector untouched. There
 * is no fallback that "tries anyway" and interprets a 501.
 */

export const NDC_ADAPTER_VERSION = "2026.09.18";
export const ndcConfigurationNames = {
  serviceToken: "HASURA_NDC_SERVICE_TOKEN",
} as const;

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

const ndcConfiguration: readonly ConfigurationRequirement[] = [
  {
    name: ndcConfigurationNames.serviceToken,
    source: "host",
    classification: "secret",
    required: false,
    description:
      "Bearer token presented to the connector when the deployment protects it; connectors on a private network may need none.",
  },
];

export type HasuraNdcAdapterOptions = {
  adapterVersion?: string;
  requestTimeoutMs?: number;
  /** The specification version this host implements; default is the pinned 0.2.0 range. */
  requestedVersion?: string;
};

const reservedKeys = new Set(["__proto__", "prototype", "constructor"]);
function assertPlainJson(value: unknown, detail: string, depth = 0): void {
  if (depth > 128) throw new ConnectorError("invalid-request", { detail });
  if (Array.isArray(value)) {
    for (const item of value) assertPlainJson(item, detail, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new ConnectorError("invalid-request", { detail });
    for (const key of Object.keys(value)) {
      if (reservedKeys.has(key))
        throw new ConnectorError("invalid-request", { detail });
      assertPlainJson(
        (value as Record<string, unknown>)[key],
        detail,
        depth + 1,
      );
    }
  }
}

export function createHasuraNdcAdapter(
  options: HasuraNdcAdapterOptions = {},
): ConnectorAdapter {
  const adapterVersion = options.adapterVersion ?? NDC_ADAPTER_VERSION;
  const timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const requestedVersion = options.requestedVersion ?? NDC_PINNED_VERSION;

  const destination = (ctx: AdapterCallContext): ApprovedDestination => {
    const approved = ctx.binding.destinations.find(
      (item) => item.id === "connector",
    );
    if (!approved)
      throw new ConnectorError("denied", {
        detail: "ndc.destination.unapproved",
      });
    return approved;
  };

  const call = async (
    ctx: AdapterCallContext,
    input: { method: "GET" | "POST"; path: string; body?: unknown },
  ): Promise<{ status: number; body: unknown }> => {
    const approved = destination(ctx);
    const url = destinationUrl(approved, input.path);
    const token = await ctx.environment.configuration.read(
      ndcConfigurationNames.serviceToken,
    );
    const controller = new AbortController();
    const abort = () => controller.abort();
    ctx.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    let response: Response;
    try {
      response = await ctx.environment.fetch(url, {
        method: input.method,
        redirect: "error",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(input.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(input.body === undefined
          ? {}
          : { body: JSON.stringify(input.body) }),
      });
    } catch (error) {
      if (ctx.signal.aborted)
        throw new ConnectorError("cancelled", {
          detail: "ndc.request.cancelled",
        });
      throw new ConnectorError("upstream-unavailable", {
        detail: "ndc.request.failed",
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", abort);
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES)
      throw new ConnectorError("invalid-request", {
        detail: "ndc.response.too-large",
      });
    let body: unknown;
    if (text.length) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new ConnectorError("upstream-rejected", {
          detail: "ndc.response.invalid",
        });
      }
      assertPlainJson(body, "ndc.response.invalid");
    }
    return { status: response.status, body };
  };

  /** Status codes carry the spec's meaning; a 501 is a capability failure, never a retry. */
  const requireOk = (result: { status: number; body: unknown }): unknown => {
    if (result.status >= 200 && result.status < 300) return result.body;
    switch (result.status) {
      case 400:
        throw new ConnectorError("invalid-request", {
          detail: "ndc.upstream.bad-request",
        });
      case 403:
        throw new ConnectorError("denied", {
          detail: "ndc.upstream.forbidden",
        });
      case 409:
        throw new ConnectorError("conflict", {
          detail: "ndc.upstream.conflict",
        });
      case 422:
        throw new ConnectorError("invalid-request", {
          detail: "ndc.upstream.unprocessable",
        });
      case 501:
        throw new ConnectorError("unsupported", {
          detail: "ndc.upstream.capability",
        });
      case 502:
        throw new ConnectorError("upstream-unavailable", {
          detail: "ndc.upstream.gateway",
        });
      default:
        if (result.status >= 500)
          throw new ConnectorError("upstream-unavailable", {
            detail: "ndc.upstream.error",
          });
        throw new ConnectorError("upstream-rejected", {
          detail: "ndc.upstream.rejected",
        });
    }
  };

  const clientFor = (ctx: AdapterCallContext): NdcClient => ({
    capabilities: async () =>
      requireOk(
        await call(ctx, { method: "GET", path: ndcEndpoints.capabilities }),
      ),
    schema: async () =>
      requireOk(await call(ctx, { method: "GET", path: ndcEndpoints.schema })),
    health: async () => {
      const result = await call(ctx, {
        method: "GET",
        path: ndcEndpoints.health,
      });
      return { ok: result.status === 200 };
    },
  });

  /**
   * The connector's declarations for this call. They are re-read from the
   * approved binding's reviewed settings, never from the caller and never
   * cached across bindings: a capability set is part of what was approved.
   */
  const declarations = (
    ctx: AdapterCallContext,
  ): {
    capabilities: NdcCapabilities;
    schema: NdcSchemaResponse;
    version: string;
  } => {
    const reviewed = ctx.binding.settings["ndc.reviewed"];
    if (!reviewed || typeof reviewed !== "object")
      throw new ConnectorError("denied", { detail: "ndc.reviewed.absent" });
    const parsed = z
      .looseObject({
        version: z.string().min(1).max(64),
        capabilities: z.unknown(),
        schema: z.unknown(),
      })
      .safeParse(reviewed);
    if (!parsed.success)
      throw new ConnectorError("denied", { detail: "ndc.reviewed.invalid" });
    const capabilities =
      ndcCapabilitiesResponseSchema.shape.capabilities.safeParse(
        parsed.data.capabilities,
      );
    const schema = ndcSchemaResponseSchema.safeParse(parsed.data.schema);
    if (!capabilities.success || !schema.success)
      throw new ConnectorError("denied", { detail: "ndc.reviewed.invalid" });
    if (!ndcVersionCompatible(parsed.data.version, requestedVersion))
      throw new ConnectorError("unsupported", {
        detail: "ndc.version.incompatible",
      });
    return {
      capabilities: capabilities.data,
      schema: schema.data,
      version: parsed.data.version,
    };
  };

  const resolveOperation = (
    ctx: AdapterCallContext,
    operationRef: string,
    expect: "query" | "mutation",
  ): BoundOperation => {
    const bound = boundOperation(ctx.binding, operationRef);
    if (!bound)
      throw new ConnectorError("denied", {
        detail: "ndc.operation.unapproved",
      });
    if (bound.transport.kind !== "http")
      throw new ConnectorError("invalid-request", {
        detail: "ndc.operation.transport",
      });
    const expected =
      expect === "query" ? ndcEndpoints.query : ndcEndpoints.mutation;
    if (
      bound.transport.method !== "POST" ||
      bound.transport.pathTemplate !== expected
    )
      throw new ConnectorError("denied", {
        detail: "ndc.operation.transport-mismatch",
      });
    destinationFor(ctx.binding, bound);
    return bound;
  };

  const capabilities = (present: ReadonlySet<string>): CapabilityStatus[] => {
    void present;
    const self = { adapterVersion, runtime: "hosted-server" as const };
    return [
      capabilityStatus(self, {
        dimension: "discover",
        profile: NDC_PROFILE,
        evidence: "protocol-fixture",
      }),
      capabilityStatus(self, {
        dimension: "import",
        profile: NDC_PROFILE,
        evidence: "protocol-fixture",
      }),
      capabilityStatus(self, {
        dimension: "verify",
        profile: NDC_PROFILE,
        evidence: "protocol-fixture",
        limitations: [
          "Verification observes the connector's health, declared version and schema; it establishes no end-user data authorization.",
        ],
      }),
      capabilityStatus(self, {
        dimension: "invoke",
        profile: NDC_PROFILE,
        evidence: "protocol-fixture",
        limitations: [
          `Only the pinned specification range ^${requestedVersion} is executed.`,
          "Queries and mutations are built from the approved allowlist; no SQL or free-form predicate is accepted.",
        ],
      }),
      capabilityStatus(self, {
        dimension: "configure",
        profile: NDC_PROFILE,
        evidence: "unit",
      }),
      capabilityStatus(self, {
        dimension: "disconnect",
        profile: NDC_PROFILE,
        evidence: "unit",
        limitations: ["Local only; the connector holds no Ceremony state."],
      }),
      ...(
        [
          "authorize",
          "events",
          "reconnect",
          "revoke",
          "export",
          "delegate",
        ] as const
      ).map((dimension) =>
        capabilityStatus(self, {
          dimension,
          profile: NDC_PROFILE,
          implementation: "unsupported",
        }),
      ),
    ];
  };

  return {
    id: "hasura-ndc",
    ecosystem: "hasura-ndc",
    adapterVersion,
    runtime: "hosted-server",
    displayName: "Hasura Native Data Connector",
    description:
      "Discovers an NDC connector's capabilities and schema and executes policy-bound native queries and mutations, preserving the connector's own request shapes and version.",
    service: "hasura-ndc",
    support: "provider-backed",
    custody: ["host-owned"],
    configuration: ndcConfiguration,
    profiles: ["http-bearer"],
    capabilities,

    /** Lists the connector's collections, functions and procedures as discovered items. */
    async discover(
      ctx: AdapterCallContext,
      input: DiscoverInput,
    ): Promise<DiscoverResult> {
      const fetchedAt = ctx.environment.now();
      const discovery = await discoverNdc(clientFor(ctx), {
        requestedVersion,
        authorityNamespace: destination(ctx).origin,
      });
      const items = discovery.definition.capabilities.map((capability) => ({
        identity: {
          ecosystem: "hasura-ndc",
          authorityNamespace: destination(ctx).origin,
          nativeId: capability.nativeId,
          nativeVersion: discovery.version,
        },
        displayName: capability.label ?? capability.nativeId,
        description: capability.summary ?? `NDC ${capability.kind}`,
        provenance: { ndcVersion: discovery.version },
        status: "active" as const,
      }));
      return {
        items: input.limit ? items.slice(0, input.limit) : items,
        freshness: { fetchedAt, stale: false, source: "live" },
        issues: discovery.issues,
      };
    },

    /** Observes health, version compatibility and the declared schema; nothing more. */
    async verify(ctx: AdapterCallContext): Promise<CompletionResult> {
      const discovery = await discoverNdc(clientFor(ctx), {
        requestedVersion,
        authorityNamespace: destination(ctx).origin,
      });
      if (!discovery.versionCompatible)
        return {
          state: "denied",
          claims: [],
          code: "ndc.version.incompatible",
        };
      return {
        state: "complete",
        claims: [
          {
            kind: "resource-access",
            evidenceRef: `evidence:ndc:${ctx.environment.random.uuid()}`,
            issuer: "provider",
            target: { kind: "ndc-connector", id: destination(ctx).origin },
            observedAt: new Date(ctx.environment.now()).toISOString(),
            verifierVersion: adapterVersion,
            bindingRevision: ctx.binding.revision,
            policyRevision: ctx.binding.policyRevision,
            permissions: {
              requested: [],
              reported: discovery.declaredCapabilities,
              observed: [],
              semantics: "operations",
            },
            limitations: [
              "Declared capabilities are the connector's own statement, not observed behaviour.",
              "Establishes no authorization over the data the connector exposes.",
            ],
          },
        ],
        adapterState: {
          ndcVersion: discovery.version,
          collections: discovery.schema.collections.length,
        },
      };
    },

    /**
     * Executes one approved query or mutation. The operation's `effect`
     * decides which endpoint is used; a caller cannot turn a read into a
     * write by sending a different body, because the body is built here.
     */
    async invoke(
      ctx: AdapterCallContext,
      request: InvokeRequest,
    ): Promise<InvokeResult> {
      const { capabilities: declared, schema } = declarations(ctx);
      const policy = ndcPolicyFrom(ctx.binding.settings, request.operationRef);
      const isMutation = policy.kind === "procedure";
      const bound = resolveOperation(
        ctx,
        request.operationRef,
        isMutation ? "mutation" : "query",
      );
      if (isMutation && bound.effect === "read")
        throw new ConnectorError("denied", {
          detail: "ndc.operation.effect-mismatch",
        });

      if (!isMutation) {
        const input = ndcQueryInputSchema.parse(request.input);
        const body = buildNdcQueryRequest(
          { policy, capabilities: declared, schema },
          input,
        );
        const parsed = ndcQueryResponseSchema.safeParse(
          requireOk(
            await call(ctx, {
              method: "POST",
              path: ndcEndpoints.query,
              body,
            }),
          ),
        );
        if (!parsed.success)
          throw new ConnectorError("upstream-rejected", {
            detail: "ndc.query.response-invalid",
          });
        return {
          state: "complete",
          output: parsed.data,
          outputClassification: bound.outputClassification,
          effect: "read",
        };
      }

      const input = ndcMutationInputSchema.parse(request.input);
      const body = buildNdcMutationRequest(
        { policy, capabilities: declared, schema },
        input,
      );
      const journal = await ctx.environment.effects.begin({
        actor: ctx.actor,
        ...(ctx.connection
          ? { connectionRef: ctx.connection.connectionRef }
          : {}),
        bindingRef: ctx.binding.bindingRef,
        operation: `ndc.mutation.${policy.target}`,
        digest: JSON.stringify([request.operationRef, body, request.commandId]),
        commandId: request.commandId,
      });
      if (journal.prior)
        return {
          state:
            journal.prior.status === "applied"
              ? "complete"
              : journal.prior.status === "failed"
                ? "failed"
                : "indeterminate",
          outputClassification: bound.outputClassification,
          effect: "write",
          effectRef: journal.effectRef,
          ...(journal.prior.code ? { code: journal.prior.code } : {}),
        };
      try {
        const parsed = ndcMutationResponseSchema.safeParse(
          requireOk(
            await call(ctx, {
              method: "POST",
              path: ndcEndpoints.mutation,
              body,
            }),
          ),
        );
        if (!parsed.success)
          throw new ConnectorError("upstream-rejected", {
            detail: "ndc.mutation.response-invalid",
          });
        await ctx.environment.effects.complete(journal.effectRef, {
          status: "applied",
          at: ctx.environment.now(),
        });
        return {
          state: "complete",
          output: parsed.data,
          outputClassification: bound.outputClassification,
          effect: "write",
          effectRef: journal.effectRef,
        };
      } catch (error) {
        const uncertain =
          error instanceof ConnectorError &&
          (error.code === "upstream-unavailable" || error.code === "cancelled");
        await ctx.environment.effects.complete(journal.effectRef, {
          status: uncertain ? "indeterminate" : "failed",
          at: ctx.environment.now(),
          code: uncertain ? "ndc.mutation.uncertain" : "ndc.mutation.rejected",
        });
        if (uncertain)
          return {
            state: "indeterminate",
            outputClassification: bound.outputClassification,
            effect: "write",
            effectRef: journal.effectRef,
            code: "ndc.mutation.uncertain",
          };
        throw error;
      }
    },

    async disconnect(_ctx, scope) {
      return {
        local: scope === "local" ? "applied" : "not-attempted",
        broker: "unsupported",
        upstream: scope === "upstream" ? "unsupported" : "not-attempted",
      };
    },
  };
}

export { NDC_IMPORTER };

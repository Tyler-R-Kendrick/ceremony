import { z } from "zod";
import {
  capabilityStatus,
  type AdapterCallContext,
  type CapabilityStatus,
  type CompletionResult,
  type ConnectorAdapter,
  type DiscoverInput,
  type DiscoverResult,
  type ImportInput,
  type ImportOutcome,
  type InvokeRequest,
  type InvokeResult,
  type VerificationClaim,
} from "../../adapter.js";
import {
  boundOperation,
  destinationFor,
  destinationUrl,
  type BoundOperation,
} from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import {
  airbyteConfigurationNames,
  airbyteConfigurationRequirements,
  airbyteDestinationIds,
  airbyteTargetKinds,
  parseBoundedJson,
} from "./contracts.js";
import {
  airbyteJobTypes,
  airbyteOperation,
  airbyteTerminalJobStatuses,
  applicationTokenResponseSchema,
  connectionResponseSchema,
  jobResponseSchema,
  jobsResponseSchema,
  resolveAirbyteApiBase,
  sourceResponseSchema,
  streamPropertiesListSchema,
  AIRBYTE_API_PROFILE,
  type AirbyteJobResponse,
  type AirbyteOperationSpec,
} from "./api.js";
import {
  airbyteSyncModes,
  readAirbyteCatalog,
  AIRBYTE_PROTOCOL_PROFILE,
} from "./protocol.js";

/*
 * The Airbyte adapter delegates to an existing, configured deployment. It does
 * not run connectors, does not embed an ETL engine, and never writes a
 * checkpoint: the platform owns connection state, and the adapter reads it,
 * reports it and refuses to reinterpret it.
 *
 * Custody is host-owned: the deployment's API key or application credentials
 * belong to the host, are used only inside `credentials.use`, and never leave
 * the adapter. Every consequential job submission is journaled before the call
 * so an interrupted trigger becomes an indeterminate outcome to reconcile
 * rather than a silent duplicate sync.
 */

export const AIRBYTE_ADAPTER_VERSION = "2026.09.18";

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

const identifier = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\p{Cc}]+$/u);

const syncInputSchema = z
  .strictObject({
    connectionId: z.uuid(),
    /** Requested modes, checked against the connection's configured streams before submission. */
    streams: z
      .array(
        z.strictObject({
          name: identifier,
          syncMode: z.string().min(1).max(64),
        }),
      )
      .max(4096)
      .optional(),
  })
  .readonly();

const jobRefInputSchema = z
  .strictObject({ jobId: z.number().int().nonnegative() })
  .readonly();

const discoverInputSchema = z
  .strictObject({
    sourceId: z.uuid(),
    destinationId: z.uuid().optional(),
    ignoreCache: z.boolean().optional(),
  })
  .readonly();

const sourceInputSchema = z.strictObject({ sourceId: z.uuid() }).readonly();
const connectionInputSchema = z
  .strictObject({ connectionId: z.uuid() })
  .readonly();
const listJobsInputSchema = z
  .strictObject({
    connectionId: z.uuid(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .readonly();

export type AirbyteAdapterOptions = {
  adapterVersion?: string;
  /** Milliseconds a single upstream call may take; bounded and never caller-supplied. */
  requestTimeoutMs?: number;
};

type CallOptions = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string | string[] | number | boolean | undefined>;
  body?: unknown;
};

/** The sync modes the public API names, mapped to the protocol modes they imply. */
const apiSyncModeProtocol: Record<string, (typeof airbyteSyncModes)[number]> = {
  full_refresh_overwrite: "full_refresh",
  full_refresh_append: "full_refresh",
  incremental_append: "incremental",
  incremental_deduped_history: "incremental",
};

function detailFor(status: number): {
  code: ConnectorError["code"];
  detail: string;
} {
  if (status === 401)
    return {
      code: "unauthenticated",
      detail: "airbyte.upstream.unauthenticated",
    };
  if (status === 403)
    return { code: "denied", detail: "airbyte.upstream.denied" };
  if (status === 404)
    return { code: "not-found", detail: "airbyte.upstream.not-found" };
  if (status === 409)
    return { code: "conflict", detail: "airbyte.upstream.conflict" };
  if (status === 429)
    return { code: "rate-limited", detail: "airbyte.upstream.rate-limited" };
  if (status >= 500)
    return {
      code: "upstream-unavailable",
      detail: "airbyte.upstream.unavailable",
    };
  return { code: "upstream-rejected", detail: "airbyte.upstream.rejected" };
}

export function createAirbyteAdapter(
  options: AirbyteAdapterOptions = {},
): ConnectorAdapter {
  const adapterVersion = options.adapterVersion ?? AIRBYTE_ADAPTER_VERSION;
  const timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  const destination = (ctx: AdapterCallContext) => {
    const approved = ctx.binding.destinations.find(
      (item) => item.id === airbyteDestinationIds.api,
    );
    if (!approved)
      throw new ConnectorError("denied", {
        detail: "airbyte.destination.unapproved",
      });
    return approved;
  };

  /**
   * One bounded upstream call. The credential is resolved inside
   * `credentials.use`; the bearer value never leaves that callback, and the
   * response body is parsed under a byte ceiling with reserved keys refused.
   */
  const call = async (
    ctx: AdapterCallContext,
    input: CallOptions,
  ): Promise<{ status: number; body: unknown }> => {
    const approved = destination(ctx);
    const configured = await ctx.environment.configuration.read(
      airbyteConfigurationNames.apiUrl,
    );
    const { basePath } = resolveAirbyteApiBase(configured, approved);
    const url = destinationUrl(approved, `${basePath}${input.path}`);
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value))
        for (const item of value) url.searchParams.append(key, item);
      else url.searchParams.set(key, String(value));
    }
    const token = await accessToken(ctx);
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
          authorization: `Bearer ${token}`,
          accept: "application/json",
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
          detail: "airbyte.request.cancelled",
        });
      throw new ConnectorError("upstream-unavailable", {
        detail: "airbyte.request.failed",
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", abort);
    }
    const text = await response.text();
    const body =
      text.length === 0
        ? undefined
        : parseBoundedJson(text, "airbyte.response.invalid", MAX_BODY_BYTES);
    return { status: response.status, body };
  };

  /**
   * The bearer token for one call. When application credentials are
   * configured, the adapter mints a short-lived token through the documented
   * `POST /applications/token`; otherwise the configured API key is used
   * directly. Neither value is returned to any caller.
   */
  const accessToken = async (ctx: AdapterCallContext): Promise<string> => {
    const clientId = await ctx.environment.configuration.read(
      airbyteConfigurationNames.clientId,
    );
    const clientSecret = await ctx.environment.configuration.read(
      airbyteConfigurationNames.clientSecret,
    );
    if (!clientId || !clientSecret) {
      const key = await ctx.environment.configuration.read(
        airbyteConfigurationNames.apiKey,
      );
      if (!key)
        throw new ConnectorError("configuration-required", {
          detail: "airbyte.api-key.missing",
        });
      return key;
    }
    const approved = destination(ctx);
    const configured = await ctx.environment.configuration.read(
      airbyteConfigurationNames.apiUrl,
    );
    const { basePath } = resolveAirbyteApiBase(configured, approved);
    const url = destinationUrl(approved, `${basePath}/applications/token`);
    const controller = new AbortController();
    const abort = () => controller.abort();
    ctx.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    let response: Response;
    try {
      response = await ctx.environment.fetch(url, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          "grant-type": "client_credentials",
        }),
      });
    } catch (error) {
      throw new ConnectorError("upstream-unavailable", {
        detail: "airbyte.token.failed",
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", abort);
    }
    if (!response.ok)
      throw new ConnectorError(detailFor(response.status).code, {
        detail: "airbyte.token.rejected",
      });
    const parsed = applicationTokenResponseSchema.safeParse(
      parseBoundedJson(
        await response.text(),
        "airbyte.token.invalid",
        MAX_BODY_BYTES,
      ),
    );
    if (!parsed.success)
      throw new ConnectorError("upstream-rejected", {
        detail: "airbyte.token.invalid",
      });
    return parsed.data.access_token;
  };

  const requireOk = (result: { status: number; body: unknown }) => {
    if (result.status >= 200 && result.status < 300) return result.body;
    const { code, detail } = detailFor(result.status);
    throw new ConnectorError(code, { detail });
  };

  /** A bound operation must name an operation this adapter knows, with the documented transport. */
  const resolveOperation = (
    ctx: AdapterCallContext,
    operationRef: string,
  ): { bound: BoundOperation; spec: AirbyteOperationSpec } => {
    const bound = boundOperation(ctx.binding, operationRef);
    if (!bound)
      throw new ConnectorError("denied", {
        detail: "airbyte.operation.unapproved",
      });
    const spec = airbyteOperation(bound.nativeId);
    if (!spec)
      throw new ConnectorError("unsupported", {
        detail: "airbyte.operation.unknown",
      });
    if (bound.transport.kind !== "http")
      throw new ConnectorError("invalid-request", {
        detail: "airbyte.operation.transport",
      });
    if (
      bound.transport.method !== spec.method ||
      bound.transport.pathTemplate !== spec.pathTemplate
    )
      throw new ConnectorError("denied", {
        detail: "airbyte.operation.transport-mismatch",
      });
    destinationFor(ctx.binding, bound);
    return { bound, spec };
  };

  /** A target named in input must be one this connection's binding permits. */
  const assertTarget = (
    ctx: AdapterCallContext,
    kind: string,
    id: string,
  ): void => {
    const permitted = ctx.binding.permittedTargets.filter(
      (item) => item.kind === kind,
    );
    if (!permitted.length)
      throw new ConnectorError("denied", {
        detail: "airbyte.target.unpermitted",
      });
    if (!permitted.some((item) => item.id === id))
      throw new ConnectorError("denied", {
        detail: "airbyte.target.unpermitted",
      });
  };

  /**
   * Checks a requested sync mode against the connection's own configuration.
   * The Airbyte API names configured stream modes with its own vocabulary
   * (`incremental_append`, ...); a request for a mode the connection's stream
   * does not carry is rejected before any job is submitted (AC-EXT-13).
   */
  const assertRequestedModes = (
    connection: z.infer<typeof connectionResponseSchema>,
    requested: ReadonlyArray<{ name: string; syncMode: string }> | undefined,
  ): void => {
    if (!requested?.length) return;
    const configured = new Map(
      (connection.configurations?.streams ?? []).map((stream) => [
        stream.name,
        stream.syncMode,
      ]),
    );
    for (const item of requested) {
      if (!configured.has(item.name))
        throw new ConnectorError("invalid-request", {
          detail: "airbyte.stream.unconfigured",
        });
      if (!Object.hasOwn(apiSyncModeProtocol, item.syncMode))
        throw new ConnectorError("unsupported", {
          detail: "airbyte.sync-mode.unknown",
        });
      if (configured.get(item.name) !== item.syncMode)
        throw new ConnectorError("unsupported", {
          detail: "airbyte.sync-mode.unsupported",
        });
    }
  };

  const capabilities = (present: ReadonlySet<string>): CapabilityStatus[] => {
    const ready = airbyteConfigurationRequirements
      .filter((item) => item.required)
      .every((item) => present.has(item.name));
    const configuration = ready ? ("ready" as const) : ("missing" as const);
    const self = { adapterVersion, runtime: "hosted-server" as const };
    return [
      capabilityStatus(self, {
        dimension: "import",
        profile: AIRBYTE_PROTOCOL_PROFILE,
        configuration: "not-applicable",
        evidence: "protocol-fixture",
      }),
      capabilityStatus(self, {
        dimension: "discover",
        profile: AIRBYTE_API_PROFILE,
        configuration,
        evidence: "protocol-fixture",
        limitations: [
          "Schema discovery uses the documented public stream-properties endpoint; the deprecated Configuration API discover_schema is not called.",
        ],
      }),
      capabilityStatus(self, {
        dimension: "configure",
        profile: AIRBYTE_API_PROFILE,
        configuration,
        evidence: "protocol-fixture",
      }),
      capabilityStatus(self, {
        dimension: "verify",
        profile: AIRBYTE_API_PROFILE,
        configuration,
        evidence: "protocol-fixture",
        limitations: [
          "Source reachability is inferred from live schema discovery: the public API documents no source check_connection operation.",
        ],
      }),
      capabilityStatus(self, {
        dimension: "delegate",
        profile: AIRBYTE_API_PROFILE,
        configuration,
        evidence: "protocol-fixture",
        limitations: [
          "Only the documented job types sync and reset are submitted; the job type comes from the approved operation, never from input.",
        ],
      }),
      capabilityStatus(self, {
        dimension: "invoke",
        profile: AIRBYTE_API_PROFILE,
        configuration,
        evidence: "protocol-fixture",
        limitations: [
          "Invocation is limited to reading sources, connections, streams and jobs; records never flow through Ceremony.",
        ],
      }),
      capabilityStatus(self, {
        dimension: "authorize",
        profile: AIRBYTE_API_PROFILE,
        implementation: "unsupported",
      }),
      capabilityStatus(self, {
        dimension: "events",
        profile: AIRBYTE_API_PROFILE,
        implementation: "unsupported",
      }),
      capabilityStatus(self, {
        dimension: "reconnect",
        profile: AIRBYTE_API_PROFILE,
        implementation: "unsupported",
      }),
      capabilityStatus(self, {
        dimension: "revoke",
        profile: AIRBYTE_API_PROFILE,
        implementation: "unsupported",
      }),
      capabilityStatus(self, {
        dimension: "disconnect",
        profile: AIRBYTE_API_PROFILE,
        configuration: "not-applicable",
        evidence: "unit",
        limitations: [
          "Local disconnect only; the deployment's connection, credentials and state are untouched.",
        ],
      }),
      capabilityStatus(self, {
        dimension: "export",
        profile: AIRBYTE_PROTOCOL_PROFILE,
        implementation: "unsupported",
      }),
    ];
  };

  const claim = (
    ctx: AdapterCallContext,
    input: {
      kind: VerificationClaim["kind"];
      targetKind: string;
      targetId: string;
      limitations: string[];
      permissions?: VerificationClaim["permissions"];
    },
  ): VerificationClaim => ({
    kind: input.kind,
    evidenceRef: `evidence:airbyte:${ctx.environment.random.uuid()}`,
    issuer: "provider",
    target: { kind: input.targetKind, id: input.targetId },
    observedAt: new Date(ctx.environment.now()).toISOString(),
    verifierVersion: adapterVersion,
    bindingRevision: ctx.binding.revision,
    policyRevision: ctx.binding.policyRevision,
    ...(input.permissions ? { permissions: input.permissions } : {}),
    limitations: input.limitations,
  });

  return {
    id: "airbyte",
    ecosystem: "airbyte",
    adapterVersion,
    runtime: "hosted-server",
    displayName: "Airbyte",
    description:
      "Imports Airbyte catalogs and delegates check, discovery and sync/reset jobs to an existing Airbyte deployment, preserving stream state and identity.",
    service: "airbyte",
    support: "provider-backed",
    custody: ["host-owned"],
    configuration: airbyteConfigurationRequirements,
    profiles: ["http-bearer"],
    capabilities,

    async import(
      _ctx: AdapterCallContext,
      input: ImportInput,
    ): Promise<ImportOutcome> {
      if (input.bytes.byteLength > MAX_BODY_BYTES)
        throw new ConnectorError("invalid-request", {
          detail: "airbyte.import.too-large",
        });
      const value = parseBoundedJson(
        new TextDecoder().decode(input.bytes),
        "airbyte.import.invalid",
        MAX_BODY_BYTES,
      );
      const document = z
        .looseObject({
          spec: z.unknown().optional(),
          catalog: z.unknown(),
        })
        .safeParse(value);
      if (!document.success)
        throw new ConnectorError("invalid-request", {
          detail: "airbyte.import.shape",
        });
      const result = await readAirbyteCatalog(
        document.data.spec,
        document.data.catalog,
        {
          ...(input.identityHint ? { identity: input.identityHint } : {}),
        },
      );
      const digest = result.definition.normalizedDigest;
      return {
        source: {
          sourceRef: result.definition.sourceRef,
          identity: result.definition.identity,
          format: { name: "airbyte-catalog", version: "v0" },
          origin: input.origin,
          digest: { algorithm: "sha256", value: digest },
          byteLength: input.bytes.byteLength,
          mediaType: "application/json",
          capturedAt: new Date(0).toISOString(),
          adaptation: [],
          overlays: [],
        },
        definitions: [result.definition],
        issues: result.issues,
        executableCandidates: result.executableCandidates,
      };
    },

    /** Lists the deployment's connections, or the streams of a named source. */
    async discover(
      ctx: AdapterCallContext,
      input: DiscoverInput,
    ): Promise<DiscoverResult> {
      const sourceId = input.scope?.sourceId;
      const fetchedAt = ctx.environment.now();
      if (!sourceId)
        throw new ConnectorError("invalid-request", {
          detail: "airbyte.discover.scope",
        });
      assertTarget(ctx, airbyteTargetKinds.source, sourceId);
      const body = requireOk(
        await call(ctx, {
          method: "GET",
          path: "/streams",
          query: { sourceId, ignoreCache: input.refresh === true },
        }),
      );
      const parsed = streamPropertiesListSchema.safeParse(body);
      if (!parsed.success)
        throw new ConnectorError("upstream-rejected", {
          detail: "airbyte.streams.invalid",
        });
      return {
        items: parsed.data.map((stream) => ({
          identity: {
            ecosystem: "airbyte",
            authorityNamespace: sourceId,
            nativeId: stream.streamName,
            nativeVersion: "unversioned",
          },
          displayName: stream.streamName,
          description: `Airbyte stream; sync modes: ${(stream.syncModes ?? []).join(", ")}`,
          provenance: {
            sourceDefinedCursor: String(
              stream.sourceDefinedCursorField ?? false,
            ),
          },
          status: "active",
        })),
        freshness: {
          fetchedAt,
          stale: input.refresh !== true,
          source: "live",
        },
        issues: [],
      };
    },

    /**
     * Verifies the configured deployment can reach the source. The public API
     * has no `check_connection` operation, so a live (cache-bypassing) schema
     * discovery is used and the claim records exactly that limitation rather
     * than pretending a dedicated check ran.
     */
    async verify(ctx: AdapterCallContext): Promise<CompletionResult> {
      const sourceId = ctx.connection?.externalIds.sourceId;
      if (!sourceId)
        return {
          state: "pending",
          claims: [],
          code: "airbyte.verify.no-source",
        };
      assertTarget(ctx, airbyteTargetKinds.source, sourceId);
      const source = sourceResponseSchema.safeParse(
        requireOk(
          await call(ctx, { method: "GET", path: `/sources/${sourceId}` }),
        ),
      );
      if (!source.success)
        throw new ConnectorError("upstream-rejected", {
          detail: "airbyte.source.invalid",
        });
      const streams = streamPropertiesListSchema.safeParse(
        requireOk(
          await call(ctx, {
            method: "GET",
            path: "/streams",
            query: { sourceId, ignoreCache: true },
          }),
        ),
      );
      if (!streams.success)
        throw new ConnectorError("upstream-rejected", {
          detail: "airbyte.streams.invalid",
        });
      return {
        state: "complete",
        claims: [
          claim(ctx, {
            kind: "resource-access",
            targetKind: airbyteTargetKinds.source,
            targetId: source.data.sourceId,
            limitations: [
              "Reachability inferred from live schema discovery; the public API documents no source check_connection operation.",
              "Demonstrates the deployment reaching the source, not the permissions of any end user.",
            ],
            permissions: {
              requested: [],
              reported: [],
              observed: ["airbyte.streams.discover"],
              semantics: "operations",
            },
          }),
        ],
        externalIds: {
          sourceId: source.data.sourceId,
          workspaceId: source.data.workspaceId,
        },
        target: {
          kind: airbyteTargetKinds.source,
          id: source.data.sourceId,
        },
        adapterState: { streamCount: streams.data.length },
      };
    },

    /** Reads: sources, connections, streams and job status. Never records. */
    async invoke(
      ctx: AdapterCallContext,
      request: InvokeRequest,
    ): Promise<InvokeResult> {
      const { bound, spec } = resolveOperation(ctx, request.operationRef);
      if (spec.effect !== "read")
        throw new ConnectorError("invalid-request", {
          detail: "airbyte.operation.not-read",
        });
      switch (spec.pathTemplate) {
        case "/sources/{sourceId}": {
          const input = sourceInputSchema.parse(request.input);
          assertTarget(ctx, airbyteTargetKinds.source, input.sourceId);
          const body = requireOk(
            await call(ctx, {
              method: "GET",
              path: `/sources/${encodeURIComponent(input.sourceId)}`,
            }),
          );
          const parsed = sourceResponseSchema.safeParse(body);
          if (!parsed.success)
            throw new ConnectorError("upstream-rejected", {
              detail: "airbyte.source.invalid",
            });
          return {
            state: "complete",
            output: parsed.data,
            outputClassification: bound.outputClassification,
            effect: "read",
          };
        }
        case "/connections/{connectionId}": {
          const input = connectionInputSchema.parse(request.input);
          assertTarget(ctx, airbyteTargetKinds.connection, input.connectionId);
          const body = requireOk(
            await call(ctx, {
              method: "GET",
              path: `/connections/${encodeURIComponent(input.connectionId)}`,
            }),
          );
          const parsed = connectionResponseSchema.safeParse(body);
          if (!parsed.success)
            throw new ConnectorError("upstream-rejected", {
              detail: "airbyte.connection.invalid",
            });
          return {
            state: "complete",
            output: parsed.data,
            outputClassification: bound.outputClassification,
            effect: "read",
          };
        }
        case "/streams": {
          const input = discoverInputSchema.parse(request.input);
          assertTarget(ctx, airbyteTargetKinds.source, input.sourceId);
          const body = requireOk(
            await call(ctx, {
              method: "GET",
              path: "/streams",
              query: {
                sourceId: input.sourceId,
                ...(input.destinationId
                  ? { destinationId: input.destinationId }
                  : {}),
                ...(input.ignoreCache === undefined
                  ? {}
                  : { ignoreCache: input.ignoreCache }),
              },
            }),
          );
          const parsed = streamPropertiesListSchema.safeParse(body);
          if (!parsed.success)
            throw new ConnectorError("upstream-rejected", {
              detail: "airbyte.streams.invalid",
            });
          return {
            state: "complete",
            output: parsed.data,
            outputClassification: bound.outputClassification,
            effect: "read",
          };
        }
        case "/jobs/{jobId}": {
          const input = jobRefInputSchema.parse(request.input);
          const body = requireOk(
            await call(ctx, { method: "GET", path: `/jobs/${input.jobId}` }),
          );
          const parsed = jobResponseSchema.safeParse(body);
          if (!parsed.success)
            throw new ConnectorError("upstream-rejected", {
              detail: "airbyte.job.invalid",
            });
          assertTarget(
            ctx,
            airbyteTargetKinds.connection,
            parsed.data.connectionId,
          );
          return {
            state: "complete",
            output: parsed.data,
            outputClassification: bound.outputClassification,
            effect: "read",
          };
        }
        case "/jobs": {
          const input = listJobsInputSchema.parse(request.input);
          assertTarget(ctx, airbyteTargetKinds.connection, input.connectionId);
          const body = requireOk(
            await call(ctx, {
              method: "GET",
              path: "/jobs",
              query: {
                connectionId: input.connectionId,
                ...(input.limit === undefined ? {} : { limit: input.limit }),
              },
            }),
          );
          const parsed = jobsResponseSchema.safeParse(body);
          if (!parsed.success)
            throw new ConnectorError("upstream-rejected", {
              detail: "airbyte.jobs.invalid",
            });
          return {
            state: "complete",
            output: parsed.data,
            outputClassification: bound.outputClassification,
            effect: "read",
          };
        }
        default:
          throw new ConnectorError("unsupported", {
            detail: "airbyte.operation.unknown",
          });
      }
    },

    /**
     * Job delegation. `start` submits the job type fixed by the approved
     * operation, `status` reads it, `cancel` cancels it. A submission is
     * journaled before the call: a repeated digest returns the earlier
     * outcome instead of triggering a second sync, and an interrupted
     * submission is reported as indeterminate for reconciliation against the
     * connection's job list.
     */
    async delegate(ctx, request): Promise<InvokeResult> {
      const { bound, spec } = resolveOperation(ctx, request.skill);
      if (request.action === "status") {
        const input = jobRefInputSchema.parse(request.input);
        const parsed = jobResponseSchema.safeParse(
          requireOk(
            await call(ctx, { method: "GET", path: `/jobs/${input.jobId}` }),
          ),
        );
        if (!parsed.success)
          throw new ConnectorError("upstream-rejected", {
            detail: "airbyte.job.invalid",
          });
        assertTarget(
          ctx,
          airbyteTargetKinds.connection,
          parsed.data.connectionId,
        );
        return {
          state: airbyteTerminalJobStatuses.has(parsed.data.status)
            ? "complete"
            : "indeterminate",
          output: parsed.data,
          outputClassification: bound.outputClassification,
          effect: "read",
          code: `airbyte.job.${parsed.data.status}`,
        };
      }
      if (request.action === "cancel") {
        const input = jobRefInputSchema.parse(request.input);
        const current = jobResponseSchema.safeParse(
          requireOk(
            await call(ctx, { method: "GET", path: `/jobs/${input.jobId}` }),
          ),
        );
        if (!current.success)
          throw new ConnectorError("upstream-rejected", {
            detail: "airbyte.job.invalid",
          });
        assertTarget(
          ctx,
          airbyteTargetKinds.connection,
          current.data.connectionId,
        );
        const parsed = jobResponseSchema.safeParse(
          requireOk(
            await call(ctx, { method: "DELETE", path: `/jobs/${input.jobId}` }),
          ),
        );
        if (!parsed.success)
          throw new ConnectorError("upstream-rejected", {
            detail: "airbyte.job.invalid",
          });
        return {
          state: "complete",
          output: parsed.data,
          outputClassification: bound.outputClassification,
          effect: "write",
          code: `airbyte.job.${parsed.data.status}`,
        };
      }
      if (request.action === "input")
        throw new ConnectorError("unsupported", {
          detail: "airbyte.delegate.no-input",
        });

      // start
      if (!spec.jobType)
        throw new ConnectorError("invalid-request", {
          detail: "airbyte.operation.not-job",
        });
      const input = syncInputSchema.parse(request.input);
      assertTarget(ctx, airbyteTargetKinds.connection, input.connectionId);
      const connection = connectionResponseSchema.safeParse(
        requireOk(
          await call(ctx, {
            method: "GET",
            path: `/connections/${encodeURIComponent(input.connectionId)}`,
          }),
        ),
      );
      if (!connection.success)
        throw new ConnectorError("upstream-rejected", {
          detail: "airbyte.connection.invalid",
        });
      assertRequestedModes(connection.data, input.streams);

      const digest = JSON.stringify([
        spec.jobType,
        input.connectionId,
        request.commandId,
      ]);
      const journal = await ctx.environment.effects.begin({
        actor: ctx.actor,
        ...(ctx.connection
          ? { connectionRef: ctx.connection.connectionRef }
          : {}),
        bindingRef: ctx.binding.bindingRef,
        operation: `airbyte.job.${spec.jobType}`,
        digest,
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
      let job: AirbyteJobResponse;
      try {
        const parsed = jobResponseSchema.safeParse(
          requireOk(
            await call(ctx, {
              method: "POST",
              path: "/jobs",
              body: {
                connectionId: input.connectionId,
                jobType: spec.jobType,
              },
            }),
          ),
        );
        if (!parsed.success)
          throw new ConnectorError("upstream-rejected", {
            detail: "airbyte.job.invalid",
          });
        job = parsed.data;
      } catch (error) {
        const indeterminate =
          error instanceof ConnectorError &&
          (error.code === "upstream-unavailable" ||
            error.code === "cancelled" ||
            error.code === "indeterminate");
        await ctx.environment.effects.complete(journal.effectRef, {
          status: indeterminate ? "indeterminate" : "failed",
          at: ctx.environment.now(),
          code: indeterminate
            ? "airbyte.job.uncertain"
            : "airbyte.job.rejected",
        });
        if (indeterminate)
          return {
            state: "indeterminate",
            outputClassification: bound.outputClassification,
            effect: "write",
            effectRef: journal.effectRef,
            code: "airbyte.job.uncertain",
          };
        throw error;
      }
      await ctx.environment.effects.complete(journal.effectRef, {
        status: "applied",
        at: ctx.environment.now(),
        code: `airbyte.job.${job.status}`,
      });
      return {
        state: airbyteTerminalJobStatuses.has(job.status)
          ? "complete"
          : "indeterminate",
        output: job,
        outputClassification: bound.outputClassification,
        effect: "write",
        effectRef: journal.effectRef,
        code: `airbyte.job.${job.status}`,
      };
    },

    /** Local only: the deployment's connection, credentials and state are untouched. */
    async disconnect(_ctx, scope) {
      return {
        local: scope === "local" ? "applied" : "not-attempted",
        broker: "unsupported",
        upstream: scope === "upstream" ? "unsupported" : "not-attempted",
      };
    },
  };
}

export { airbyteJobTypes };

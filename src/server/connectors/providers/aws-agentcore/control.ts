import type { CompatibilityIssue } from "../../../../core/connectors/contracts.js";
import type { ApprovedDestination } from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import {
  DEFAULT_AGENTCORE_JSON_BOUNDS,
  parseBoundedJsonBytes,
  type JsonBounds,
} from "./json.js";
import {
  AGENTCORE_CONTROL_API_VERSION,
  awsErrorBodySchema,
  getGatewayResponseSchema,
  getGatewayTargetResponseSchema,
  gatewayIdentifierSchema,
  gatewaySummarySchema,
  listGatewayTargetsResponseSchema,
  listGatewaysResponseSchema,
  targetIdSchema,
  targetSummarySchema,
  type GatewaySummary,
  type GetGatewayResponse,
  type GetGatewayTargetResponse,
  type TargetSummary,
} from "./schemas.js";
import { signRequest, type AwsCredentials } from "./sigv4.js";

/*
 * A read-only client for the AgentCore control plane.
 *
 * Read-only is enforced, not merely intended: `request` accepts no method, no
 * body and no arbitrary path, and the four operations below are the whole
 * surface. Discovery and testing therefore cannot create a gateway, an IAM
 * role, a target or a resource policy, because there is no code path that
 * could send the request that would do so.
 *
 * Documented request lines, read 2026-09-18:
 *   GET /gateways/?maxResults=&nextToken=
 *   GET /gateways/{gatewayIdentifier}/
 *   GET /gateways/{gatewayIdentifier}/targets/?maxResults=&nextToken=
 *   GET /gateways/{gatewayIdentifier}/targets/{targetId}/
 */

export type AgentCoreControlLimits = {
  maxResults: number;
  maxPages: number;
  maxResponseBytes: number;
  requestTimeoutMs: number;
  json: JsonBounds;
};

export const DEFAULT_AGENTCORE_CONTROL_LIMITS: AgentCoreControlLimits =
  Object.freeze({
    maxResults: 100,
    maxPages: 20,
    maxResponseBytes: 4 * 1024 * 1024,
    requestTimeoutMs: 20_000,
    json: DEFAULT_AGENTCORE_JSON_BOUNDS,
  });

export type AgentCoreControlClientOptions = {
  /** Exact origin of the approved control-plane destination; never composed from a region string. */
  baseUrl: string;
  region: string;
  signingService: string;
  fetch: typeof fetch;
  /** Resolves the management credentials privately at call time; absence is configuration-required. */
  credentials: () => Promise<AwsCredentials | undefined>;
  now: () => number;
  limits?: Partial<AgentCoreControlLimits>;
  userAgent?: string;
};

/**
 * The control-plane region a destination implies. A host that pins the public
 * AWS endpoint has already chosen a region in the hostname; a binding that
 * claims a different one is a region confusion, not a preference.
 */
const publicControlHost =
  /^bedrock-agentcore-control\.([a-z0-9-]+)\.amazonaws\.com$/;

export function controlRegionForDestination(
  destination: ApprovedDestination,
  region: string,
): string {
  const host = new URL(destination.origin).hostname;
  const match = publicControlHost.exec(host);
  if (match && match[1] !== region)
    throw new ConnectorError("denied", { detail: "agentcore.region.mismatch" });
  return region;
}

/** Base URL of an approved destination: its exact origin and prefix, never caller input. */
export function controlBaseUrlForDestination(
  destination: ApprovedDestination,
): string {
  const prefix = (destination.pathPrefix ?? "").replace(/\/+$/, "");
  if (prefix.includes("//") || prefix.split("/").includes(".."))
    throw new ConnectorError("network-policy", {
      detail: "agentcore.base-url.invalid",
    });
  return `${destination.origin}${prefix}`;
}

function skipped(
  pointer: string,
  code: string,
  message: string,
): CompatibilityIssue {
  return {
    code,
    category: "structure",
    sourcePointer: pointer,
    dimension: "discover",
    disposition: "rejected",
    severity: "warning",
    executionImpact: "none",
    message,
  };
}

async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new ConnectorError("upstream-rejected", {
      detail: "agentcore.response.oversized",
    });
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ConnectorError("upstream-rejected", {
        detail: "agentcore.response.oversized",
      });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Maps an AWS failure to a sanitized code; the provider's own message never escapes. */
export function controlError(
  status: number,
  errorType: string | undefined,
): ConnectorError {
  const type = (errorType ?? "").split(":")[0]?.split("#").pop() ?? "";
  if (type === "ExpiredTokenException" || type === "ExpiredToken")
    return new ConnectorError("expired", {
      detail: "agentcore.credentials.expired",
    });
  if (
    type === "InvalidClientTokenId" ||
    type === "UnrecognizedClientException" ||
    type === "IncompleteSignatureException" ||
    type === "InvalidSignatureException"
  )
    return new ConnectorError("denied", {
      detail: "agentcore.credentials.rejected",
    });
  if (type === "AccessDeniedException" || status === 403)
    return new ConnectorError("denied", { detail: "agentcore.access-denied" });
  if (type === "ResourceNotFoundException" || status === 404)
    return new ConnectorError("not-found", { detail: "agentcore.not-found" });
  if (type === "ThrottlingException" || status === 429)
    return new ConnectorError("rate-limited", {
      detail: "agentcore.throttled",
    });
  if (status === 401)
    return new ConnectorError("denied", {
      detail: "agentcore.credentials.rejected",
    });
  if (status >= 500)
    return new ConnectorError("upstream-unavailable", {
      detail: "agentcore.upstream-status",
    });
  return new ConnectorError("upstream-rejected", {
    detail: "agentcore.bad-request",
  });
}

export type GatewayPage = {
  gateways: GatewaySummary[];
  nextToken?: string;
  issues: CompatibilityIssue[];
  fetchedAt: number;
};
export type TargetPage = {
  targets: TargetSummary[];
  nextToken?: string;
  issues: CompatibilityIssue[];
  fetchedAt: number;
};

export type AgentCoreControlClient = ReturnType<
  typeof createAgentCoreControlClient
>;

export function createAgentCoreControlClient(
  options: AgentCoreControlClientOptions,
) {
  const limits: AgentCoreControlLimits = {
    ...DEFAULT_AGENTCORE_CONTROL_LIMITS,
    ...options.limits,
  };
  if (
    !Number.isInteger(limits.maxResults) ||
    limits.maxResults < 1 ||
    limits.maxResults > 1000
  )
    throw new ConnectorError("invalid-request", {
      detail: "agentcore.max-results.invalid",
    });
  const base = options.baseUrl.replace(/\/+$/, "");

  /** The only way this module reaches the network: one signed GET, no body. */
  async function request(
    path: string,
    query: Record<string, string | undefined>,
    call: { signal?: AbortSignal },
  ): Promise<unknown> {
    const url = new URL(`${base}${path}`);
    for (const [name, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(name, value);
    const credentials = await options.credentials();
    if (!credentials)
      throw new ConnectorError("configuration-required", {
        detail: "agentcore.management-credentials.missing",
      });
    const signed = signRequest(
      { method: "GET", url, headers: { accept: "application/json" } },
      {
        region: options.region,
        service: options.signingService,
        credentials,
        now: options.now(),
      },
    );
    const headers: Record<string, string> = {
      ...signed.headers,
      accept: "application/json",
      "user-agent":
        options.userAgent ??
        `ceremony-connectors-aws-agentcore/${AGENTCORE_CONTROL_API_VERSION}`,
    };
    delete headers["host"];
    const timeout = AbortSignal.timeout(limits.requestTimeoutMs);
    const signal = call.signal
      ? AbortSignal.any([call.signal, timeout])
      : timeout;
    let response: Response;
    try {
      response = await options.fetch(url, {
        method: "GET",
        headers,
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (call.signal?.aborted) throw new ConnectorError("cancelled");
      if (timeout.aborted)
        throw new ConnectorError("upstream-unavailable", {
          detail: "agentcore.timeout",
          cause: error,
        });
      throw new ConnectorError("upstream-unavailable", {
        detail: "agentcore.network",
        cause: error,
      });
    }
    const bytes = await readBounded(response, limits.maxResponseBytes);
    if (!response.ok) {
      let errorType = response.headers.get("x-amzn-errortype") ?? undefined;
      if (!errorType && bytes.byteLength) {
        try {
          const body = awsErrorBodySchema.safeParse(
            parseBoundedJsonBytes(bytes, limits.json),
          );
          if (body.success) errorType = body.data.__type;
        } catch {
          errorType = undefined;
        }
      }
      throw controlError(response.status, errorType);
    }
    return parseBoundedJsonBytes(bytes, limits.json);
  }

  return {
    limits,
    async listGateways(
      input: { maxResults?: number; nextToken?: string },
      call: { signal?: AbortSignal } = {},
    ): Promise<GatewayPage> {
      const value = await request(
        "/gateways/",
        {
          maxResults: String(input.maxResults ?? limits.maxResults),
          ...(input.nextToken ? { nextToken: input.nextToken } : {}),
        },
        call,
      );
      const parsed = listGatewaysResponseSchema.safeParse(value);
      if (!parsed.success)
        throw new ConnectorError("upstream-rejected", {
          detail: "agentcore.list-gateways.shape",
        });
      const gateways: GatewaySummary[] = [];
      const issues: CompatibilityIssue[] = [];
      parsed.data.items.forEach((item, index) => {
        const row = gatewaySummarySchema.safeParse(item);
        if (row.success) gateways.push(row.data);
        else
          issues.push(
            skipped(
              `/items/${index}`,
              "agentcore.gateway.invalid",
              "A gateway summary did not match the documented shape and was skipped",
            ),
          );
      });
      return {
        gateways,
        ...(parsed.data.nextToken ? { nextToken: parsed.data.nextToken } : {}),
        issues,
        fetchedAt: options.now(),
      };
    },
    async getGateway(
      gatewayIdentifier: string,
      call: { signal?: AbortSignal } = {},
    ): Promise<GetGatewayResponse> {
      const id = gatewayIdentifierSchema.safeParse(gatewayIdentifier);
      if (!id.success)
        throw new ConnectorError("invalid-request", {
          detail: "agentcore.gateway-id.invalid",
        });
      const value = await request(`/gateways/${id.data}/`, {}, call);
      const parsed = getGatewayResponseSchema.safeParse(value);
      if (!parsed.success)
        throw new ConnectorError("upstream-rejected", {
          detail: "agentcore.get-gateway.shape",
        });
      return parsed.data;
    },
    async listGatewayTargets(
      gatewayIdentifier: string,
      input: { maxResults?: number; nextToken?: string },
      call: { signal?: AbortSignal } = {},
    ): Promise<TargetPage> {
      const id = gatewayIdentifierSchema.safeParse(gatewayIdentifier);
      if (!id.success)
        throw new ConnectorError("invalid-request", {
          detail: "agentcore.gateway-id.invalid",
        });
      const value = await request(
        `/gateways/${id.data}/targets/`,
        {
          maxResults: String(input.maxResults ?? limits.maxResults),
          ...(input.nextToken ? { nextToken: input.nextToken } : {}),
        },
        call,
      );
      const parsed = listGatewayTargetsResponseSchema.safeParse(value);
      if (!parsed.success)
        throw new ConnectorError("upstream-rejected", {
          detail: "agentcore.list-targets.shape",
        });
      const targets: TargetSummary[] = [];
      const issues: CompatibilityIssue[] = [];
      parsed.data.items.forEach((item, index) => {
        const row = targetSummarySchema.safeParse(item);
        if (row.success) targets.push(row.data);
        else
          issues.push(
            skipped(
              `/items/${index}`,
              "agentcore.target.invalid",
              "A gateway target summary did not match the documented shape and was skipped",
            ),
          );
      });
      return {
        targets,
        ...(parsed.data.nextToken ? { nextToken: parsed.data.nextToken } : {}),
        issues,
        fetchedAt: options.now(),
      };
    },
    async getGatewayTarget(
      gatewayIdentifier: string,
      targetId: string,
      call: { signal?: AbortSignal } = {},
    ): Promise<GetGatewayTargetResponse> {
      const id = gatewayIdentifierSchema.safeParse(gatewayIdentifier);
      const target = targetIdSchema.safeParse(targetId);
      if (!id.success || !target.success)
        throw new ConnectorError("invalid-request", {
          detail: "agentcore.target-id.invalid",
        });
      const value = await request(
        `/gateways/${id.data}/targets/${target.data}/`,
        {},
        call,
      );
      const parsed = getGatewayTargetResponseSchema.safeParse(value);
      if (!parsed.success)
        throw new ConnectorError("upstream-rejected", {
          detail: "agentcore.get-target.shape",
        });
      return parsed.data;
    },
  };
}

import { createHash, createHmac } from "node:crypto";
import {
  startHttpFixture,
  type FixtureReply,
  type RecordedRequest,
} from "./http-fixture.js";

/*
 * Loopback doubles of the two AWS surfaces this provider touches, written from
 * the published documentation rather than from the client under test:
 *
 * - The control plane, `bedrock-agentcore-control-2023-06-05`:
 *   `GET /gateways/`, `GET /gateways/{gatewayIdentifier}/`,
 *   `GET /gateways/{id}/targets/` and `GET /gateways/{id}/targets/{targetId}/`
 *   with `maxResults`/`nextToken` paging, `items`/`nextToken` responses and the
 *   documented exceptions (AccessDeniedException, ResourceNotFoundException,
 *   ThrottlingException, ValidationException) reported with `x-amzn-errortype`.
 *   (API reference pages retrieved 2026-09-18.)
 * - A gateway's MCP endpoint, revision 2026-07-28: `POST /mcp` with
 *   `Accept: application/json, text/event-stream`, `MCP-Protocol-Version`,
 *   `Mcp-Method`, the `_meta` version fields inside `params`, and the RFC 6750
 *   challenge the gateway returns when a token is missing or under-scoped.
 *   (gateway-using.html and gateway-using-mcp-list.html retrieved 2026-09-18.)
 *
 * The SigV4 verifier below is written from
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/create-signed-request.html
 * (retrieved 2026-09-18): it recomputes the canonical request, the string to
 * sign and the signature from what arrived on the wire and compares. It shares
 * no code with the signer it checks, so a signer that agrees with itself but
 * not with AWS still fails here.
 */

export type DoubleAwsIdentity = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** Answer every request from this identity with ExpiredTokenException. */
  expired?: boolean;
};

export type SignatureCheck =
  | { ok: true; accessKeyId: string; scope: string; signedHeaders: string[] }
  | { ok: false; errorType: string };

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function encodeSegment(segment: string): string {
  let out = "";
  for (const byte of Buffer.from(segment, "utf8")) {
    const char = String.fromCharCode(byte);
    out += /[A-Za-z0-9\-._~]/.test(char)
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** Independent SigV4 header verification. */
export function verifySignature(
  request: RecordedRequest,
  identities: readonly DoubleAwsIdentity[],
  expected: { region: string; service: string },
  body: string,
): SignatureCheck {
  const header = request.headers["authorization"];
  if (!header) return { ok: false, errorType: "MissingAuthenticationToken" };
  const parsed =
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
      header,
    );
  if (!parsed) return { ok: false, errorType: "IncompleteSignatureException" };
  const [, accessKeyId, date, region, service, signedHeaders, signature] =
    parsed as unknown as [string, string, string, string, string, string, string];
  const identity = identities.find((item) => item.accessKeyId === accessKeyId);
  if (!identity) return { ok: false, errorType: "UnrecognizedClientException" };
  if (identity.expired) return { ok: false, errorType: "ExpiredTokenException" };
  if (region !== expected.region || service !== expected.service)
    return { ok: false, errorType: "InvalidSignatureException" };
  const amzDate = request.headers["x-amz-date"];
  if (!amzDate || amzDate.slice(0, 8) !== date)
    return { ok: false, errorType: "InvalidSignatureException" };
  if (
    identity.sessionToken !== undefined &&
    request.headers["x-amz-security-token"] !== identity.sessionToken
  )
    return { ok: false, errorType: "InvalidSignatureException" };

  const names = signedHeaders.split(";");
  if (!names.includes("host") || !names.includes("x-amz-date"))
    return { ok: false, errorType: "IncompleteSignatureException" };
  const canonicalHeaders = names
    .map((name) => {
      const value =
        name === "host"
          ? (request.headers["host"] ?? request.url.host)
          : (request.headers[name] ?? "");
      return `${name}:${value.trim().replace(/\s+/g, " ")}\n`;
    })
    .join("");
  const canonicalPath = request.url.pathname
    .split("/")
    .map((segment, index) =>
      index === 0 ? "" : encodeSegment(decodeURIComponent(segment)),
    )
    .join("/");
  const query = [...request.url.searchParams]
    .map(([name, value]): [string, string] => [
      encodeSegment(name),
      encodeSegment(value),
    ])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const canonicalRequest = [
    request.method,
    canonicalPath,
    query,
    canonicalHeaders,
    signedHeaders,
    sha256Hex(body),
  ].join("\n");
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const key = hmac(
    hmac(hmac(hmac(`AWS4${identity.secretAccessKey}`, date), region), service),
    "aws4_request",
  );
  const computed = createHmac("sha256", key)
    .update(stringToSign, "utf8")
    .digest("hex");
  if (computed !== signature)
    return { ok: false, errorType: "InvalidSignatureException" };
  return { ok: true, accessKeyId, scope, signedHeaders: names };
}

export type DoubleGateway = {
  gatewayId: string;
  name: string;
  description?: string;
  status?: string;
  authorizerType?: string;
  protocolType?: string;
  gatewayUrl?: string;
  supportedVersions?: string[];
  discoveryUrl?: string;
  updatedAt?: string;
  /** Account id used only inside the fixture's ARN, to prove it never leaves the adapter. */
  accountId?: string;
  region?: string;
};

export type DoubleTarget = {
  targetId: string;
  name: string;
  description?: string;
  status?: string;
  targetConfiguration?: unknown;
  credentialProviderType?: string;
  privateEndpoint?: unknown;
};

export type ControlDoubleOptions = {
  identities: DoubleAwsIdentity[];
  region: string;
  service?: string;
  gateways: DoubleGateway[];
  targets?: Record<string, DoubleTarget[]>;
  /** Gateways the caller's identity may not read; answered with AccessDeniedException. */
  denied?: string[];
  pageSize?: number;
  throttleFirst?: boolean;
};

const errorReply = (status: number, errorType: string): FixtureReply => ({
  status,
  headers: { "x-amzn-errortype": `${errorType}:http://internal.amazon.com/` },
  body: { __type: errorType, message: "fixture rejection" },
});

export async function startAgentCoreControlDouble(
  options: ControlDoubleOptions,
) {
  const service = options.service ?? "bedrock-agentcore";
  const pageSize = options.pageSize ?? 50;
  const denied = new Set(options.denied ?? []);
  let throttled = false;
  const arnOf = (gateway: DoubleGateway) =>
    `arn:aws:bedrock-agentcore:${gateway.region ?? options.region}:${gateway.accountId ?? "123456789012"}:gateway/${gateway.gatewayId}`;

  const fixture = await startHttpFixture((request) => {
    if (request.method !== "GET")
      return errorReply(400, "ValidationException");
    const check = verifySignature(request, options.identities, {
      region: options.region,
      service,
    }, "");
    if (!check.ok)
      return errorReply(
        check.errorType === "ExpiredTokenException" ? 403 : 403,
        check.errorType,
      );
    if (options.throttleFirst && !throttled) {
      throttled = true;
      return errorReply(429, "ThrottlingException");
    }
    const path = request.url.pathname;
    const limit = Number(request.url.searchParams.get("maxResults") ?? pageSize);
    const cursor = request.url.searchParams.get("nextToken");

    if (path === "/gateways/") {
      const start = cursor ? Number(cursor) : 0;
      if (!Number.isInteger(start) || start < 0)
        return errorReply(400, "ValidationException");
      const slice = options.gateways.slice(start, start + limit);
      return {
        body: {
          items: slice.map((gateway) => ({
            gatewayId: gateway.gatewayId,
            name: gateway.name,
            ...(gateway.description ? { description: gateway.description } : {}),
            status: gateway.status ?? "READY",
            authorizerType: gateway.authorizerType ?? "CUSTOM_JWT",
            protocolType: gateway.protocolType ?? "MCP",
            createdAt: "2026-09-01T00:00:00Z",
            updatedAt: gateway.updatedAt ?? "2026-09-10T00:00:00Z",
          })),
          ...(start + slice.length < options.gateways.length
            ? { nextToken: String(start + slice.length) }
            : {}),
        },
      };
    }
    const gatewayMatch = /^\/gateways\/([^/]+)\/$/.exec(path);
    if (gatewayMatch) {
      const gateway = options.gateways.find(
        (item) => item.gatewayId === gatewayMatch[1],
      );
      if (!gateway) return errorReply(404, "ResourceNotFoundException");
      if (denied.has(gateway.gatewayId))
        return errorReply(403, "AccessDeniedException");
      return {
        body: {
          gatewayArn: arnOf(gateway),
          gatewayId: gateway.gatewayId,
          ...(gateway.gatewayUrl ? { gatewayUrl: gateway.gatewayUrl } : {}),
          name: gateway.name,
          ...(gateway.description ? { description: gateway.description } : {}),
          status: gateway.status ?? "READY",
          authorizerType: gateway.authorizerType ?? "CUSTOM_JWT",
          ...(gateway.discoveryUrl
            ? {
                authorizerConfiguration: {
                  customJWTAuthorizer: {
                    discoveryUrl: gateway.discoveryUrl,
                    allowedClients: ["fixture-client"],
                  },
                },
              }
            : {}),
          protocolType: gateway.protocolType ?? "MCP",
          protocolConfiguration: {
            mcp: {
              supportedVersions: gateway.supportedVersions ?? [
                "2026-07-28",
                "2025-11-25",
              ],
            },
          },
          roleArn: `arn:aws:iam::${gateway.accountId ?? "123456789012"}:role/fixture-gateway-role`,
          createdAt: "2026-09-01T00:00:00Z",
          updatedAt: gateway.updatedAt ?? "2026-09-10T00:00:00Z",
        },
      };
    }
    const targetsMatch = /^\/gateways\/([^/]+)\/targets\/$/.exec(path);
    if (targetsMatch) {
      const gatewayId = targetsMatch[1]!;
      if (denied.has(gatewayId)) return errorReply(403, "AccessDeniedException");
      const list = options.targets?.[gatewayId];
      if (!list) return errorReply(404, "ResourceNotFoundException");
      const start = cursor ? Number(cursor) : 0;
      const slice = list.slice(start, start + limit);
      return {
        body: {
          items: slice.map((target) => ({
            targetId: target.targetId,
            name: target.name,
            ...(target.description ? { description: target.description } : {}),
            status: target.status ?? "READY",
            targetType: "MCP",
            createdAt: "2026-09-01T00:00:00Z",
            updatedAt: "2026-09-10T00:00:00Z",
          })),
          ...(start + slice.length < list.length
            ? { nextToken: String(start + slice.length) }
            : {}),
        },
      };
    }
    const targetMatch = /^\/gateways\/([^/]+)\/targets\/([^/]+)\/$/.exec(path);
    if (targetMatch) {
      const gatewayId = targetMatch[1]!;
      if (denied.has(gatewayId)) return errorReply(403, "AccessDeniedException");
      const target = options.targets?.[gatewayId]?.find(
        (item) => item.targetId === targetMatch[2],
      );
      if (!target) return errorReply(404, "ResourceNotFoundException");
      const gateway = options.gateways.find(
        (item) => item.gatewayId === gatewayId,
      );
      return {
        body: {
          targetId: target.targetId,
          name: target.name,
          ...(target.description ? { description: target.description } : {}),
          status: target.status ?? "READY",
          protocolType: "MCP",
          ...(gateway ? { gatewayArn: arnOf(gateway) } : {}),
          ...(target.targetConfiguration
            ? { targetConfiguration: target.targetConfiguration }
            : {}),
          ...(target.credentialProviderType
            ? {
                credentialProviderConfigurations: [
                  { credentialProviderType: target.credentialProviderType },
                ],
              }
            : {}),
          ...(target.privateEndpoint
            ? { privateEndpoint: target.privateEndpoint }
            : {}),
          createdAt: "2026-09-01T00:00:00Z",
          updatedAt: "2026-09-10T00:00:00Z",
          lastSynchronizedAt: "2026-09-10T00:05:00Z",
        },
      };
    }
    return errorReply(404, "ResourceNotFoundException");
  });
  return {
    ...fixture,
    /** ARNs the fixture serves, so a test can assert none of them escaped. */
    accountNumbers: options.gateways.map(
      (gateway) => gateway.accountId ?? "123456789012",
    ),
  };
}

export type DoubleTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  /** Result for `tools/call`; a function may inspect the arguments it received. */
  call?: (args: Record<string, unknown>) => Record<string, unknown>;
};

export type GatewayDoubleFaults = {
  /** Drop the connection on the Nth tools/call (1-based) after reading the request. */
  dropCallAt?: number;
  /** Answer the Nth tools/call with HTTP 500. */
  failCallAt?: number;
  /** Answer the next tools/call with an `input_required` interim result. */
  inputRequired?: boolean;
  /** Advertise these scopes in the 401/403 challenge. */
  requiredScopes?: string[];
  /** Reject a valid token as under-scoped. */
  insufficientScope?: boolean;
};

export type GatewayDoubleOptions = {
  tools: DoubleTool[];
  /** Bearer tokens the gateway's inbound JWT authorizer accepts. */
  bearerTokens?: string[];
  /** Callers accepted for IAM inbound authorization. */
  sigv4Callers?: DoubleAwsIdentity[];
  sigv4?: { region: string; service: string };
  supportedVersions?: string[];
  pageSize?: number;
  faults?: GatewayDoubleFaults;
};

export async function startAgentCoreGatewayDouble(
  options: GatewayDoubleOptions,
) {
  const supported = options.supportedVersions ?? ["2026-07-28", "2025-11-25"];
  const pageSize = options.pageSize ?? 100;
  const faults = options.faults ?? {};
  let calls = 0;
  const seen: Array<{
    method: string;
    authorization: string;
    protocolVersion: string;
    mcpMethod: string;
    name?: string;
  }> = [];

  const challenge = (status: number, error?: string) => ({
    status,
    headers: {
      "www-authenticate": `Bearer realm="gateway"${
        error ? `, error="${error}"` : ""
      }, scope="${(faults.requiredScopes ?? ["gateway/invoke"]).join(" ")}", resource_metadata="/.well-known/oauth-protected-resource"`,
    },
    body: { message: "unauthorized" },
  });

  const fixture = await startHttpFixture((request, raw) => {
    if (request.method !== "POST" || request.url.pathname !== "/mcp")
      return { status: 404, body: { message: "not found" } };
    const accept = request.headers["accept"] ?? "";
    if (!accept.includes("application/json"))
      return { status: 406, body: { message: "accept" } };
    const protocolVersion = request.headers["mcp-protocol-version"] ?? "";
    if (!supported.includes(protocolVersion))
      return { status: 400, body: { message: "protocol version" } };
    const body = request.body.toString("utf8");
    let message: {
      jsonrpc?: string;
      id?: unknown;
      method?: string;
      params?: Record<string, unknown>;
    };
    try {
      message = JSON.parse(body) as typeof message;
    } catch {
      return { status: 400, body: { message: "json" } };
    }
    if (message.jsonrpc !== "2.0" || typeof message.method !== "string")
      return { status: 400, body: { message: "jsonrpc" } };
    if (protocolVersion === "2026-07-28") {
      if (request.headers["mcp-method"] !== message.method)
        return { status: 400, body: { message: "mcp-method header" } };
      const meta = message.params?.["_meta"] as
        | Record<string, unknown>
        | undefined;
      if (
        meta?.["io.modelcontextprotocol/protocolVersion"] !== "2026-07-28" ||
        typeof meta["io.modelcontextprotocol/clientInfo"] !== "object"
      )
        return { status: 400, body: { message: "_meta version fields" } };
    }

    const authorization = request.headers["authorization"] ?? "";
    if (options.sigv4Callers && options.sigv4) {
      const check = verifySignature(
        request,
        options.sigv4Callers,
        options.sigv4,
        body,
      );
      if (!check.ok) return challenge(401, "invalid_token");
    } else if (options.bearerTokens) {
      const token = /^Bearer (.+)$/.exec(authorization)?.[1];
      if (!token || !options.bearerTokens.includes(token))
        return challenge(401, "invalid_token");
      if (faults.insufficientScope) return challenge(403, "insufficient_scope");
    }
    seen.push({
      method: message.method,
      authorization,
      protocolVersion,
      mcpMethod: request.headers["mcp-method"] ?? "",
      ...(typeof message.params?.["name"] === "string"
        ? { name: message.params["name"] }
        : {}),
    });

    if (message.method === "tools/list") {
      const cursor = message.params?.["cursor"];
      const start = typeof cursor === "string" ? Number(cursor) : 0;
      if (!Number.isInteger(start) || start < 0)
        return { status: 400, body: { message: "cursor" } };
      const slice = options.tools.slice(start, start + pageSize);
      return {
        body: {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: slice.map((tool) => ({
              name: tool.name,
              ...(tool.description ? { description: tool.description } : {}),
              inputSchema: tool.inputSchema ?? {
                type: "object",
                properties: {},
              },
            })),
            ...(start + slice.length < options.tools.length
              ? { nextCursor: String(start + slice.length) }
              : {}),
          },
        },
      };
    }
    if (message.method === "tools/call") {
      calls++;
      if (faults.dropCallAt === calls) {
        raw.req.socket.destroy();
        return undefined;
      }
      if (faults.failCallAt === calls)
        return { status: 500, body: { message: "internal" } };
      const name = message.params?.["name"];
      const tool = options.tools.find((item) => item.name === name);
      if (!tool)
        return {
          body: {
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32602, message: "unknown tool" },
          },
        };
      if (faults.inputRequired)
        return {
          body: {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              resultType: "input_required",
              _meta: { "io.modelcontextprotocol/elicitation": { fields: [] } },
            },
          },
        };
      const args = (message.params?.["arguments"] ?? {}) as Record<
        string,
        unknown
      >;
      const result = tool.call?.(args) ?? {
        content: [{ type: "text", text: "ok" }],
      };
      return { body: { jsonrpc: "2.0", id: message.id, result } };
    }
    return {
      body: {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "method not found" },
      },
    };
  });
  return { ...fixture, seen, callCount: () => calls };
}

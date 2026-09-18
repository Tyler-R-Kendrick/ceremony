import { z } from "zod";
import { ConnectorError } from "../../errors.js";
import {
  DEFAULT_AGENTCORE_JSON_BOUNDS,
  parseBoundedJsonText,
  type JsonBounds,
} from "./json.js";
import {
  AGENTCORE_MCP_PROTOCOL_VERSION,
  AGENTCORE_SEARCH_TOOL,
} from "./schemas.js";
import { signRequest, type AwsCredentials } from "./sigv4.js";

/*
 * Invoking an AgentCore gateway over MCP, revision 2026-07-28.
 *
 * https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-using.html
 * and .../gateway-using-mcp-list.html (both retrieved 2026-09-18) document the
 * wire this client speaks: `POST /mcp` on the gateway endpoint, with
 * `Accept: application/json, text/event-stream`, an `Authorization` header
 * from the inbound authorization the gateway was configured with, the
 * `MCP-Protocol-Version` and `Mcp-Method` headers, and the `_meta` version
 * fields inside `params`. Revision 2026-07-28 is stateless: there is no
 * `initialize` handshake and no session to keep.
 *
 * The legacy revisions the gateway also accepts (2025-11-25 and earlier) use
 * the handshake and the open stream; this client refuses to speak them rather
 * than inventing a hybrid. A deployment that needs a legacy gateway binds it
 * through the MCP runtime client instead.
 *
 * The endpoint is `gatewayUrl` as `GetGateway` returned it, checked against an
 * approved destination. It is never composed from a gateway id and a region.
 */

export type GatewayAuthorization =
  | { kind: "bearer"; token: string }
  | {
      kind: "sigv4";
      credentials: AwsCredentials;
      region: string;
      service: string;
    }
  | { kind: "none" };

export type GatewayClientLimits = {
  maxResponseBytes: number;
  requestTimeoutMs: number;
  json: JsonBounds;
};

export const DEFAULT_GATEWAY_LIMITS: GatewayClientLimits = Object.freeze({
  maxResponseBytes: 4 * 1024 * 1024,
  requestTimeoutMs: 30_000,
  json: DEFAULT_AGENTCORE_JSON_BOUNDS,
});

export type GatewayClientOptions = {
  endpoint: URL;
  fetch: typeof fetch;
  now: () => number;
  /** Resolved per call so a token is never cached on the client. */
  authorization: () => Promise<GatewayAuthorization | undefined>;
  limits?: Partial<GatewayClientLimits>;
  clientInfo?: { name: string; version: string };
};

const toolSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(512)
    .regex(/^[^\p{Cc}]+$/u),
  title: z.string().max(200).optional(),
  description: z.string().max(4096).optional(),
  inputSchema: z.unknown().optional(),
  outputSchema: z.unknown().optional(),
  _meta: z.unknown().optional(),
});
export type GatewayTool = z.infer<typeof toolSchema>;

const listResultSchema = z.object({
  tools: z.array(z.unknown()).max(1000).default([]),
  nextCursor: z.string().min(1).max(2048).optional(),
});

const callResultSchema = z.object({
  content: z.array(z.unknown()).max(256).optional(),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
  /** Revision 2026-07-28 result discrimination; `input_required` is an interim result. */
  resultType: z.string().max(64).optional(),
  _meta: z.unknown().optional(),
});
export type GatewayCallResult = z.infer<typeof callResultSchema>;

const responseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string().max(200), z.number()]).optional(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.number().int(),
      message: z.string().max(4096).optional(),
      data: z.unknown().optional(),
    })
    .optional(),
});

/** Scopes a 401/403 challenge advertises, per RFC 6750 and the gateway's documented challenge. */
export function advertisedScopes(header: string | null): string[] {
  if (!header) return [];
  const match = /scope="([^"]{0,500})"/.exec(header);
  if (!match?.[1]) return [];
  return match[1]
    .split(" ")
    .filter((scope) => scope.length > 0 && /^[\x21-\x7e]{1,200}$/.test(scope))
    .slice(0, 32);
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ConnectorError("upstream-rejected", {
        detail: "agentcore.gateway.response.oversized",
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
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ConnectorError("upstream-rejected", {
      detail: "agentcore.gateway.encoding",
    });
  }
}

/** One JSON body, or the first `data:` event of a single-message stream. */
function messageFrom(contentType: string | null, text: string): string {
  if (!contentType?.includes("text/event-stream")) return text;
  for (const line of text.split(/\r?\n/))
    if (line.startsWith("data:")) return line.slice(5).trim();
  throw new ConnectorError("upstream-rejected", {
    detail: "agentcore.gateway.stream.empty",
  });
}

export class GatewayTransportUncertain extends Error {
  constructor(readonly detail: string) {
    super("Gateway call outcome is uncertain");
    this.name = "GatewayTransportUncertain";
  }
}

export type GatewayMcpClient = ReturnType<typeof createGatewayMcpClient>;

export function createGatewayMcpClient(options: GatewayClientOptions) {
  const limits: GatewayClientLimits = {
    ...DEFAULT_GATEWAY_LIMITS,
    ...options.limits,
  };
  const clientInfo = options.clientInfo ?? {
    name: "ceremony-connectors",
    version: "1.0.0",
  };

  async function call(
    method: "tools/list" | "tools/call",
    params: Record<string, unknown>,
    request: { id: string; signal?: AbortSignal },
  ): Promise<unknown> {
    const authorization = await options.authorization();
    if (!authorization)
      throw new ConnectorError("configuration-required", {
        detail: "agentcore.gateway.authorization.missing",
      });
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion":
            AGENTCORE_MCP_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientInfo": clientInfo,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    });
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": AGENTCORE_MCP_PROTOCOL_VERSION,
      "mcp-method": method,
    };
    if (authorization.kind === "bearer")
      headers["authorization"] = `Bearer ${authorization.token}`;
    else if (authorization.kind === "sigv4") {
      const signed = signRequest(
        {
          method: "POST",
          url: options.endpoint,
          headers: { "content-type": "application/json" },
          payload: body,
        },
        {
          region: authorization.region,
          service: authorization.service,
          credentials: authorization.credentials,
          now: options.now(),
        },
      );
      for (const [name, value] of Object.entries(signed.headers))
        if (name !== "host") headers[name] = value;
    }
    const timeout = AbortSignal.timeout(limits.requestTimeoutMs);
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeout])
      : timeout;
    let response: Response;
    try {
      response = await options.fetch(options.endpoint, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal,
      });
    } catch (error) {
      if (request.signal?.aborted) throw new ConnectorError("cancelled");
      /*
       * The request left this process. Whether the gateway applied it is
       * unknown, and only the caller's effect journal can decide what that
       * means; this client never reports a network failure as "not applied".
       */
      throw new GatewayTransportUncertain(
        timeout.aborted ? "agentcore.gateway.timeout" : "agentcore.gateway.network",
      );
    }
    const text = await readBoundedText(response, limits.maxResponseBytes);
    if (!response.ok) {
      const scopes = advertisedScopes(response.headers.get("www-authenticate"));
      if (response.status === 401)
        throw new ConnectorError("denied", {
          detail:
            scopes.length > 0
              ? "agentcore.gateway.scope-required"
              : "agentcore.gateway.unauthorized",
        });
      if (response.status === 403)
        throw new ConnectorError("denied", {
          detail:
            scopes.length > 0
              ? "agentcore.gateway.insufficient-scope"
              : "agentcore.gateway.forbidden",
        });
      if (response.status === 429)
        throw new ConnectorError("rate-limited", {
          detail: "agentcore.gateway.throttled",
        });
      if (response.status >= 500)
        throw new GatewayTransportUncertain("agentcore.gateway.upstream-status");
      throw new ConnectorError("upstream-rejected", {
        detail: "agentcore.gateway.rejected",
      });
    }
    const parsed = responseSchema.safeParse(
      parseBoundedJsonText(
        messageFrom(response.headers.get("content-type"), text),
        limits.json,
      ),
    );
    if (!parsed.success)
      throw new ConnectorError("upstream-rejected", {
        detail: "agentcore.gateway.message.shape",
      });
    if (parsed.data.error)
      throw new ConnectorError("upstream-rejected", {
        detail: "agentcore.gateway.tool-error",
      });
    if (parsed.data.result === undefined)
      throw new ConnectorError("upstream-rejected", {
        detail: "agentcore.gateway.message.empty",
      });
    return parsed.data.result;
  }

  return {
    limits,
    /** `tools/list` with the gateway's cursor pagination; the search tool is reported, never hidden. */
    async listTools(
      input: { cursor?: string; requestId: string },
      request: { signal?: AbortSignal } = {},
    ): Promise<{
      tools: GatewayTool[];
      nextCursor?: string;
      searchToolPresent: boolean;
      skipped: number;
    }> {
      const result = await call(
        "tools/list",
        input.cursor ? { cursor: input.cursor } : {},
        { id: input.requestId, ...(request.signal ? { signal: request.signal } : {}) },
      );
      const parsed = listResultSchema.safeParse(result);
      if (!parsed.success)
        throw new ConnectorError("upstream-rejected", {
          detail: "agentcore.gateway.tools-list.shape",
        });
      const tools: GatewayTool[] = [];
      let skipped = 0;
      for (const raw of parsed.data.tools) {
        const tool = toolSchema.safeParse(raw);
        if (tool.success) tools.push(tool.data);
        else skipped++;
      }
      return {
        tools,
        ...(parsed.data.nextCursor ? { nextCursor: parsed.data.nextCursor } : {}),
        searchToolPresent: tools.some(
          (tool) => tool.name === AGENTCORE_SEARCH_TOOL,
        ),
        skipped,
      };
    },
    async callTool(
      input: {
        name: string;
        arguments: Record<string, unknown>;
        requestId: string;
      },
      request: { signal?: AbortSignal } = {},
    ): Promise<GatewayCallResult> {
      const result = await call(
        "tools/call",
        { name: input.name, arguments: input.arguments },
        { id: input.requestId, ...(request.signal ? { signal: request.signal } : {}) },
      );
      const parsed = callResultSchema.safeParse(result);
      if (!parsed.success)
        throw new ConnectorError("upstream-rejected", {
          detail: "agentcore.gateway.tools-call.shape",
        });
      return parsed.data;
    },
  };
}

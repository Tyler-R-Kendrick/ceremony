import { ConnectorError } from "../../errors.js";
import type { AdapterCallContext } from "../../adapter.js";

/*
 * Outbound HTTP for the Auth0 adapter. Every request goes through the
 * environment's fetch with redirects refused and a bounded lifetime, and
 * every response body is read under a byte ceiling. Provider bodies are
 * parsed by the caller against a schema; they are never quoted in errors.
 */

export type WireResponse = {
  status: number;
  headers: Headers;
  body: Uint8Array;
};

export async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ConnectorError("upstream-rejected", {
        detail: "auth0.response.too-large",
      });
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function send(
  ctx: AdapterCallContext,
  url: URL,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string | Uint8Array;
  },
  limits: { timeoutMs: number; maxBytes: number },
): Promise<WireResponse> {
  let response: Response;
  try {
    response = await ctx.environment.fetch(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body as BodyInit }),
      redirect: "error",
      signal: AbortSignal.any([
        ctx.signal,
        AbortSignal.timeout(limits.timeoutMs),
      ]),
    });
  } catch (error) {
    if (ctx.signal.aborted)
      throw new ConnectorError("cancelled", { cause: error });
    if (error instanceof DOMException && error.name === "TimeoutError")
      throw new ConnectorError("upstream-unavailable", {
        detail: "auth0.timeout",
        cause: error,
      });
    throw new ConnectorError("upstream-unavailable", {
      detail: "auth0.unreachable",
      cause: error,
    });
  }
  const body = await readBounded(response, limits.maxBytes);
  return { status: response.status, headers: response.headers, body };
}

export function parseJson(body: Uint8Array): unknown {
  if (body.byteLength === 0) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
}

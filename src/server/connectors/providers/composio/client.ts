import { z } from "zod";
import type { AdapterCallContext } from "../../adapter.js";
import { destinationUrl, type ApprovedDestination } from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import { COMPOSIO_API_BASE } from "./wire.js";

/*
 * The wire layer.
 *
 * Every request goes to the binding's approved `api` destination through the
 * injected fetch with `redirect: "error"` and a bounded signal, carries the
 * project API key in the documented `x-api-key` header, and is read within a
 * byte limit. The key is read from the private configuration port for the
 * request that needs it and is never cached, returned, logged or attached to
 * anything but that one request. Responses become a status, headers and parsed
 * JSON; upstream text never becomes an error message, because a Composio error
 * body can quote the provider's response and a provider's response can quote a
 * credential.
 */

export const composioConfigurationNames = Object.freeze({
  apiKey: "COMPOSIO_API_KEY",
});

export type ComposioTimeouts = {
  read: number;
  write: number;
  execute: number;
};

export const defaultComposioTimeouts: ComposioTimeouts = Object.freeze({
  read: 15_000,
  write: 20_000,
  execute: 60_000,
});

const DEFAULT_BODY_LIMIT = 1024 * 1024;
const EXECUTE_BODY_LIMIT = 4 * 1024 * 1024;
const MAX_HOLD_SECONDS = 60;

const apiKeySchema = z
  .string()
  .min(1)
  .max(400)
  .regex(/^[^\p{Cc}\s]+$/u);

/** Process-local rate-limit state shared by every call of one adapter instance. */
export type ComposioShared = {
  holds: Map<string, number>;
  /** Reviewed tool schema checks, keyed by binding revision, slug and version. */
  toolChecks: Map<string, { at: number; digest: string; version: string }>;
};
export function createComposioShared(): ComposioShared {
  return { holds: new Map(), toolChecks: new Map() };
}

export type ComposioMethod = "GET" | "POST" | "PATCH" | "DELETE";

export type ComposioRequest = {
  method: ComposioMethod;
  /** Path below the API base, already percent-encoded, starting with `/`. */
  path: string;
  query?: Record<string, string | string[]>;
  body?: unknown;
  timeoutMs: number;
  /** A write whose lost response leaves the effect unknown. */
  consequential: boolean;
  bodyLimit?: number;
};

export type ComposioResponse = {
  status: number;
  headers: Headers;
  json: unknown;
  byteLength: number;
};

export function upstreamFailure(status: number): ConnectorError {
  if (status === 400)
    return new ConnectorError("upstream-rejected", {
      detail: "composio.request.rejected",
    });
  if (status === 401)
    return new ConnectorError("upstream-rejected", {
      detail: "composio.auth.rejected",
    });
  if (status === 403)
    return new ConnectorError("upstream-rejected", {
      detail: "composio.forbidden",
    });
  if (status === 404)
    return new ConnectorError("not-found", { detail: "composio.not-found" });
  if (status === 409)
    return new ConnectorError("conflict", { detail: "composio.conflict" });
  if (status === 429)
    return new ConnectorError("rate-limited", {
      detail: "composio.rate-limited",
    });
  if (status >= 500)
    return new ConnectorError("upstream-unavailable", {
      detail: "composio.unavailable",
    });
  return new ConnectorError("upstream-rejected", {
    detail: "composio.request.rejected",
  });
}

/** A 2xx body parsed against a documented shape; anything else is a sanitized failure. */
export function expectJson<T>(
  response: ComposioResponse,
  schema: z.ZodType<T>,
): T {
  if (response.status < 200 || response.status >= 300)
    throw upstreamFailure(response.status);
  const parsed = schema.safeParse(response.json);
  if (!parsed.success)
    throw new ConnectorError("upstream-rejected", {
      detail: "composio.response.malformed",
    });
  return parsed.data;
}

const tooLarge = () =>
  new ConnectorError("upstream-rejected", {
    detail: "composio.response.too-large",
  });

async function readBounded(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
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

export class ComposioClient {
  constructor(
    readonly ctx: AdapterCallContext,
    readonly base: string,
    private readonly shared: ComposioShared,
    readonly timeouts: ComposioTimeouts,
  ) {}

  /** The one network destination: the binding's approved `api` origin. */
  get destination(): ApprovedDestination {
    const destination = this.ctx.binding.destinations.find(
      (item) => item.id === "api",
    );
    if (!destination)
      throw new ConnectorError("network-policy", {
        detail: "composio.destination.missing",
      });
    return destination;
  }

  path(suffix: string): string {
    return `${this.base === COMPOSIO_API_BASE ? COMPOSIO_API_BASE : this.base}${suffix}`;
  }

  async send(request: ComposioRequest): Promise<ComposioResponse> {
    if (this.ctx.signal.aborted) throw new ConnectorError("cancelled");
    this.assertNotHeld();
    const url = this.url(request.path, request.query);
    const apiKey = await this.apiKey();
    const headers = new Headers({
      accept: "application/json",
      "x-api-key": apiKey,
    });
    let body: string | undefined;
    if (request.body !== undefined) {
      body = JSON.stringify(request.body);
      headers.set("content-type", "application/json");
    }
    const signal = AbortSignal.any([
      this.ctx.signal,
      AbortSignal.timeout(request.timeoutMs),
    ]);
    let response: Response;
    try {
      response = await this.ctx.environment.fetch(url, {
        method: request.method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "error",
        signal,
      });
    } catch (error) {
      throw this.lost(error, request.consequential);
    }
    if (response.status === 429) {
      this.hold(response.headers.get("retry-after"));
      await response.body?.cancel().catch(() => undefined);
      throw new ConnectorError("rate-limited", {
        detail: "composio.rate-limited",
      });
    }
    const limit =
      request.bodyLimit ??
      (request.timeoutMs >= this.timeouts.execute
        ? EXECUTE_BODY_LIMIT
        : DEFAULT_BODY_LIMIT);
    let bytes: Uint8Array;
    try {
      bytes = await readBounded(response, limit);
    } catch (error) {
      if (request.consequential)
        throw new ConnectorError("indeterminate", {
          detail: "composio.response.unreadable",
        });
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError("upstream-unavailable", {
        detail: "composio.response.unreadable",
      });
    }
    let json: unknown;
    const contentType = response.headers.get("content-type") ?? "";
    if (bytes.byteLength && /json/i.test(contentType)) {
      try {
        json = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new ConnectorError(
          request.consequential ? "indeterminate" : "upstream-rejected",
          { detail: "composio.response.malformed" },
        );
      }
    }
    return {
      status: response.status,
      headers: response.headers,
      json,
      byteLength: bytes.byteLength,
    };
  }

  private async apiKey(): Promise<string> {
    const value = await this.ctx.environment.configuration.read(
      composioConfigurationNames.apiKey,
    );
    const parsed = apiKeySchema.safeParse(value);
    if (!parsed.success)
      throw new ConnectorError("configuration-required", {
        detail: "composio.configuration.missing",
      });
    return parsed.data;
  }

  private url(path: string, query?: ComposioRequest["query"]): URL {
    let url: URL;
    try {
      url = destinationUrl(this.destination, path);
    } catch {
      throw new ConnectorError("network-policy", {
        detail: "composio.destination.path",
      });
    }
    for (const [name, value] of Object.entries(query ?? {}))
      for (const item of Array.isArray(value) ? value : [value])
        url.searchParams.append(name, item);
    return url;
  }

  private lost(error: unknown, consequential: boolean): ConnectorError {
    if (consequential)
      return new ConnectorError("indeterminate", {
        detail: "composio.transport.lost",
      });
    if (this.ctx.signal.aborted) return new ConnectorError("cancelled");
    const timedOut =
      error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    return new ConnectorError("upstream-unavailable", {
      detail: timedOut
        ? "composio.transport.timeout"
        : "composio.transport.failed",
    });
  }

  private holdKey(): string {
    return `${this.ctx.actor.tenantId} ${this.ctx.binding.bindingRef}`;
  }

  private assertNotHeld(): void {
    const key = this.holdKey();
    const until = this.shared.holds.get(key);
    if (until === undefined) return;
    if (until > this.ctx.environment.now())
      throw new ConnectorError("rate-limited", {
        detail: "composio.rate-limited.held",
      });
    this.shared.holds.delete(key);
  }

  private hold(retryAfter: string | null): void {
    const seconds =
      retryAfter && /^\d{1,6}$/.test(retryAfter) ? Number(retryAfter) : 10;
    this.shared.holds.set(
      this.holdKey(),
      this.ctx.environment.now() +
        Math.min(Math.max(seconds, 1), MAX_HOLD_SECONDS) * 1000,
    );
  }
}

export type ConfigurationReport = { missing: string[] };

/** Readiness of the one required configuration value; the value is never returned. */
export async function readComposioConfiguration(
  ctx: AdapterCallContext,
): Promise<ConfigurationReport> {
  const names = Object.values(composioConfigurationNames);
  const present = await ctx.environment.configuration.present(names);
  return { missing: names.filter((name) => !present.has(name)) };
}

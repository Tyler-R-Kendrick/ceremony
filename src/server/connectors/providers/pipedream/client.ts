import { z } from "zod";
import { encodePathSegment } from "../../../../core/connectors/index.js";
import type { AdapterCallContext } from "../../adapter.js";
import { destinationUrl, type ApprovedDestination } from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import type { CredentialMaterial, CredentialScope } from "../../ports.js";
import {
  pipedreamAuthorityInstance,
  pipedreamEnvironmentSchema,
  pipedreamProjectIdSchema,
  sha256Hex,
  type PipedreamEnvironment,
} from "./identity.js";
import { oauthTokenSchema } from "./wire.js";

/*
 * The wire layer. Every request goes to the binding's approved `api`
 * destination through the injected fetch with no redirects and a bounded
 * signal; every project-scoped request carries the configured environment
 * header; every authenticated request runs inside the custody port's `use`
 * with the project access token, which is minted through the documented
 * client-credentials grant, cached by reference only, rotated under a single
 * flight, and never returned to a caller. Responses are read within a byte
 * limit and reduced to a status, headers and parsed JSON; upstream text never
 * becomes an error message.
 */

export const pipedreamConfigurationNames = Object.freeze({
  projectId: "PIPEDREAM_PROJECT_ID",
  environment: "PIPEDREAM_ENVIRONMENT",
  clientId: "PIPEDREAM_CLIENT_ID",
  clientSecret: "PIPEDREAM_CLIENT_SECRET",
});

export type PipedreamConfig = {
  projectId: string;
  environment: PipedreamEnvironment;
  clientId: string;
};

export type PipedreamTimeouts = {
  token: number;
  read: number;
  write: number;
  proxy: number;
  action: number;
};

type TokenEntry = { ref: string; expiresAt: number };

/** Process-local caches shared by every call of one adapter instance; keyed per tenant and authority. */
export type PipedreamShared = {
  tokens: Map<string, TokenEntry>;
  minting: Map<string, Promise<TokenEntry>>;
  holds: Map<string, number>;
};
export function createPipedreamShared(): PipedreamShared {
  return { tokens: new Map(), minting: new Map(), holds: new Map() };
}

const TOKEN_REFRESH_MARGIN_MS = 60_000;
const TOKEN_EXPIRY_SKEW_MS = 30_000;
const DEFAULT_BODY_LIMIT = 1024 * 1024;
const MAX_HOLD_SECONDS = 60;
const clientIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\p{Cc}\s]+$/u);

export type ConfigurationReport =
  | { config: PipedreamConfig; missing: [] }
  | { config?: undefined; missing: string[] };

/** Reads the public configuration values; the client secret is only checked for presence here. */
export async function readPipedreamConfig(
  ctx: AdapterCallContext,
): Promise<ConfigurationReport> {
  const names = Object.values(pipedreamConfigurationNames);
  const present = await ctx.environment.configuration.present(names);
  const missing = names.filter((name) => !present.has(name));
  if (missing.length) return { missing };
  const configuration = ctx.environment.configuration;
  const [projectId, environment, clientId] = await Promise.all([
    configuration.read(pipedreamConfigurationNames.projectId),
    configuration.read(pipedreamConfigurationNames.environment),
    configuration.read(pipedreamConfigurationNames.clientId),
  ]);
  const project = pipedreamProjectIdSchema.safeParse(projectId);
  const env = pipedreamEnvironmentSchema.safeParse(environment);
  const client = clientIdSchema.safeParse(clientId);
  if (!project.success || !env.success || !client.success)
    throw new ConnectorError("configuration-required", {
      detail: "pipedream.configuration.invalid",
    });
  return {
    config: {
      projectId: project.data,
      environment: env.data,
      clientId: client.data,
    },
    missing: [],
  };
}

export type PipedreamMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type PipedreamRequest = {
  method: PipedreamMethod;
  /** Absolute path on the api destination, already percent-encoded. */
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Send x-pd-environment; every project-scoped endpoint needs it, /v1/connect/apps does not. */
  environment?: boolean;
  timeoutMs: number;
  /** A write whose lost response leaves the effect unknown. */
  consequential: boolean;
  bodyLimit?: number;
};

export type PipedreamResponse = {
  status: number;
  headers: Headers;
  json: unknown;
  text: string | undefined;
  byteLength: number;
};

type Wire = {
  method: PipedreamMethod;
  timeoutMs: number;
  consequential: boolean;
  bodyLimit: number;
};

class WorkFailure {
  constructor(readonly error: unknown) {}
}

export function upstreamFailure(status: number): ConnectorError {
  if (status === 401)
    return new ConnectorError("upstream-rejected", {
      detail: "pipedream.auth.rejected",
    });
  if (status === 403)
    return new ConnectorError("upstream-rejected", {
      detail: "pipedream.forbidden",
    });
  if (status === 404)
    return new ConnectorError("not-found", { detail: "pipedream.not-found" });
  if (status === 409)
    return new ConnectorError("conflict", { detail: "pipedream.conflict" });
  if (status === 429)
    return new ConnectorError("rate-limited", {
      detail: "pipedream.rate-limited",
    });
  if (status === 504)
    return new ConnectorError("upstream-unavailable", {
      detail: "pipedream.gateway-timeout",
    });
  if (status >= 500)
    return new ConnectorError("upstream-unavailable", {
      detail: "pipedream.unavailable",
    });
  return new ConnectorError("upstream-rejected", {
    detail: "pipedream.request.rejected",
  });
}

/** A 2xx body parsed against a documented shape; anything else is a sanitized failure. */
export function expectJson<T>(
  response: PipedreamResponse,
  schema: z.ZodType<T>,
): T {
  if (response.status < 200 || response.status >= 300)
    throw upstreamFailure(response.status);
  const parsed = schema.safeParse(response.json);
  if (!parsed.success)
    throw new ConnectorError("upstream-rejected", {
      detail: "pipedream.response.malformed",
    });
  return parsed.data;
}

const tooLarge = () =>
  new ConnectorError("upstream-rejected", {
    detail: "pipedream.response.too-large",
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

export class PipedreamClient {
  readonly authority: string;
  constructor(
    readonly ctx: AdapterCallContext,
    readonly config: PipedreamConfig,
    private readonly shared: PipedreamShared,
    readonly timeouts: PipedreamTimeouts,
  ) {
    this.authority = pipedreamAuthorityInstance(
      config.projectId,
      config.environment,
    );
  }

  /** The one network destination: the binding's approved `api` origin. */
  get destination(): ApprovedDestination {
    const destination = this.ctx.binding.destinations.find(
      (item) => item.id === "api",
    );
    if (!destination)
      throw new ConnectorError("network-policy", {
        detail: "pipedream.destination.missing",
      });
    return destination;
  }

  projectPath(suffix: string): string {
    return `/v1/connect/${encodePathSegment(this.config.projectId)}${suffix}`;
  }

  async send(request: PipedreamRequest): Promise<PipedreamResponse> {
    if (this.ctx.signal.aborted) throw new ConnectorError("cancelled");
    this.assertNotHeld();
    const url = this.url(request.path, request.query);
    const headers = new Headers({ accept: "application/json" });
    if (request.environment !== false)
      headers.set("x-pd-environment", this.config.environment);
    for (const [name, value] of Object.entries(request.headers ?? {}))
      headers.set(name, value);
    let body: string | undefined;
    if (request.body !== undefined) {
      body = JSON.stringify(request.body);
      headers.set("content-type", "application/json");
    }
    const wire: Wire = {
      method: request.method,
      timeoutMs: request.timeoutMs,
      consequential: request.consequential,
      bodyLimit: request.bodyLimit ?? DEFAULT_BODY_LIMIT,
    };
    let response = await this.withToken((token) =>
      this.transport(url, headers, body, wire, token),
    );
    if (response.status === 401) {
      // Rejected at authentication: nothing was applied, so one fresh token is safe.
      await this.forget();
      response = await this.withToken((token) =>
        this.transport(url, headers, body, wire, token),
      );
    }
    return response;
  }

  private url(path: string, query?: Record<string, string>): URL {
    let url: URL;
    try {
      url = destinationUrl(this.destination, path);
    } catch {
      throw new ConnectorError("network-policy", {
        detail: "pipedream.destination.path",
      });
    }
    for (const [name, value] of Object.entries(query ?? {}))
      url.searchParams.append(name, value);
    return url;
  }

  private async transport(
    url: URL,
    headers: Headers,
    body: string | undefined,
    wire: Wire,
    token?: string,
  ): Promise<PipedreamResponse> {
    const requestHeaders = new Headers(headers);
    if (token !== undefined)
      requestHeaders.set("authorization", `Bearer ${token}`);
    const signal = AbortSignal.any([
      this.ctx.signal,
      AbortSignal.timeout(wire.timeoutMs),
    ]);
    let response: Response;
    try {
      response = await this.ctx.environment.fetch(url, {
        method: wire.method,
        headers: requestHeaders,
        ...(body === undefined ? {} : { body }),
        redirect: "error",
        signal,
      });
    } catch (error) {
      throw this.lost(error, wire);
    }
    if (response.status === 429) {
      this.hold(response.headers.get("retry-after"));
      await response.body?.cancel().catch(() => undefined);
      throw new ConnectorError("rate-limited", {
        detail: "pipedream.rate-limited",
      });
    }
    let bytes: Uint8Array;
    try {
      bytes = await readBounded(response, wire.bodyLimit);
    } catch (error) {
      if (wire.consequential)
        throw new ConnectorError("indeterminate", {
          detail: "pipedream.response.unreadable",
        });
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError("upstream-unavailable", {
        detail: "pipedream.response.unreadable",
      });
    }
    const contentType = response.headers.get("content-type") ?? "";
    let json: unknown;
    let text: string | undefined;
    if (bytes.byteLength && /json/i.test(contentType)) {
      try {
        json = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new ConnectorError(
          wire.consequential ? "indeterminate" : "upstream-rejected",
          { detail: "pipedream.response.malformed" },
        );
      }
    } else if (bytes.byteLength && /^text\//i.test(contentType))
      text = new TextDecoder().decode(bytes);
    return {
      status: response.status,
      headers: response.headers,
      json,
      text,
      byteLength: bytes.byteLength,
    };
  }

  private lost(error: unknown, wire: Wire): ConnectorError {
    if (wire.consequential)
      return new ConnectorError("indeterminate", {
        detail: "pipedream.transport.lost",
      });
    if (this.ctx.signal.aborted) return new ConnectorError("cancelled");
    const timedOut =
      error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError");
    return new ConnectorError("upstream-unavailable", {
      detail: timedOut
        ? "pipedream.transport.timeout"
        : "pipedream.transport.failed",
    });
  }

  private holdKey(): string {
    return `${this.ctx.actor.tenantId} ${this.authority}`;
  }

  private assertNotHeld(): void {
    const key = this.holdKey();
    const until = this.shared.holds.get(key);
    if (until === undefined) return;
    if (until > this.ctx.environment.now())
      throw new ConnectorError("rate-limited", {
        detail: "pipedream.rate-limited.held",
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

  private tokenKey(): string {
    return [
      this.ctx.actor.tenantId,
      this.ctx.binding.bindingRef,
      this.config.projectId,
      this.config.environment,
      this.config.clientId,
    ].join(" ");
  }

  private tokenScope(): CredentialScope {
    return {
      tenantId: this.ctx.actor.tenantId,
      ownerKind: "workload",
      ownerId: `pipedream-project:${this.config.projectId}:${this.config.environment}`,
      connectionRef: `pipedream-project:${sha256Hex(this.tokenKey()).slice(0, 40)}`,
      bindingRef: this.ctx.binding.bindingRef,
      custody: "host-owned",
    };
  }

  private async forget(): Promise<void> {
    const key = this.tokenKey();
    const entry = this.shared.tokens.get(key);
    this.shared.tokens.delete(key);
    if (entry)
      await this.ctx.environment.credentials
        .revoke(this.tokenScope(), entry.ref)
        .catch(() => undefined);
  }

  private async withToken<T>(work: (token: string) => Promise<T>): Promise<T> {
    const key = this.tokenKey();
    const scope = this.tokenScope();
    let entry = this.shared.tokens.get(key);
    if (
      !entry ||
      entry.expiresAt - this.ctx.environment.now() < TOKEN_REFRESH_MARGIN_MS
    ) {
      let inflight = this.shared.minting.get(key);
      if (!inflight) {
        inflight = this.rotate(key, scope);
        this.shared.minting.set(key, inflight);
        inflight
          .finally(() => {
            if (this.shared.minting.get(key) === inflight)
              this.shared.minting.delete(key);
          })
          .catch(() => undefined);
      }
      entry = await inflight;
    }
    try {
      return await this.ctx.environment.credentials.use(
        scope,
        entry.ref,
        async (material) => {
          try {
            return await work(material.access_token ?? "");
          } catch (error) {
            throw new WorkFailure(error);
          }
        },
      );
    } catch (error) {
      if (error instanceof WorkFailure) throw error.error;
      // The reference is gone or stale in custody; the next call mints again.
      this.shared.tokens.delete(key);
      throw new ConnectorError("upstream-unavailable", {
        detail: "pipedream.token.unavailable",
      });
    }
  }

  private async rotate(
    key: string,
    scope: CredentialScope,
  ): Promise<TokenEntry> {
    const now = this.ctx.environment.now();
    const current = this.shared.tokens.get(key);
    if (current && current.expiresAt - now >= TOKEN_REFRESH_MARGIN_MS)
      return current;
    let entry: TokenEntry;
    if (current) {
      const rotated = await this.ctx.environment.credentials.refresh(
        scope,
        current.ref,
        () => this.mint(),
      );
      entry = { ref: rotated.ref, expiresAt: rotated.expiresAt ?? now };
    } else {
      const minted = await this.mint();
      const ref = await this.ctx.environment.credentials.store(
        scope,
        minted.material,
        { expiresAt: minted.expiresAt },
      );
      entry = { ref, expiresAt: minted.expiresAt };
    }
    this.shared.tokens.set(key, entry);
    return entry;
  }

  /** POST /v1/oauth/token with the documented client-credentials JSON body. */
  private async mint(): Promise<{
    material: CredentialMaterial;
    expiresAt: number;
  }> {
    const secret = await this.ctx.environment.configuration.read(
      pipedreamConfigurationNames.clientSecret,
    );
    if (!secret)
      throw new ConnectorError("configuration-required", {
        detail: "pipedream.configuration.missing",
      });
    const response = await this.transport(
      this.url("/v1/oauth/token"),
      new Headers({
        accept: "application/json",
        "content-type": "application/json",
      }),
      JSON.stringify({
        grant_type: "client_credentials",
        client_id: this.config.clientId,
        client_secret: secret,
      }),
      {
        method: "POST",
        timeoutMs: this.timeouts.token,
        consequential: false,
        bodyLimit: 64 * 1024,
      },
    );
    if (response.status !== 200)
      throw response.status === 400 ||
        response.status === 401 ||
        response.status === 403
        ? new ConnectorError("upstream-rejected", {
            detail: "pipedream.oauth.rejected",
          })
        : upstreamFailure(response.status);
    const parsed = oauthTokenSchema.safeParse(response.json);
    if (!parsed.success)
      throw new ConnectorError("upstream-rejected", {
        detail: "pipedream.oauth.malformed",
      });
    const now = this.ctx.environment.now();
    return {
      material: { access_token: parsed.data.access_token },
      expiresAt:
        now +
        Math.max(5_000, parsed.data.expires_in * 1000 - TOKEN_EXPIRY_SKEW_MS),
    };
  }
}

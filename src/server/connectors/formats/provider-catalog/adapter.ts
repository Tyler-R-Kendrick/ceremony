import { createHash } from "node:crypto";
import { z } from "zod";
import {
  canonicalConnectorJson,
  type CompatibilityIssue,
  type EvidenceLevel,
  type NormalizedDefinition,
  type SourceRecord,
} from "../../../../core/connectors/index.js";
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
  type ImportInput,
  type ImportOutcome,
  type InvokeRequest,
  type InvokeResult,
} from "../../adapter.js";
import {
  beginAuthorizationCode,
  callbackUri,
  completeAuthorizationCode,
  credentialAcceptedClaim,
  credentialScopeFor,
  grantClientCredentials,
  issuerPolicy,
  permissionRecord,
  refreshAccessToken,
  renewClientCredentials,
  resolveAuthorizationServer,
  resolveClientRegistration,
  type IssuerPolicy,
  type PermissionRecord,
  type ResolvedAuthorizationServer,
  type ResolvedClient,
} from "../../auth/index.js";
import {
  boundOperation,
  destinationFor,
  destinationUrl,
  type ApprovedDestination,
} from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import { parseBoundedDocument } from "../../import/parse.js";
import { beginAttempt } from "../../attempts.js";
import type { CredentialMaterial, CredentialScope } from "../../ports.js";
import { readBoundedBody, responseIsJson } from "../openapi/serialize.js";
import {
  CATALOG_ECOSYSTEM,
  CATALOG_IMPORTER_VERSION,
  CATALOG_SETTINGS,
  configurationFor,
  definitionFor,
  entryFromBinding,
  profileIdFor,
  proxyNativeId,
  PROXY_METHODS,
  reviewCatalogBinding,
  type ProxyMethod,
} from "./definition.js";
import { catalogIssue } from "./issues.js";
import { importNangoProviders } from "./nango.js";
import {
  catalogDocumentSchemaFor,
  clientConfigurationNames,
  entryDigest,
  firstCode,
  parseProviderCatalogEntry,
  PROVIDER_CATALOG_FORMAT,
  resolveUrlTemplate,
  resolveValueTemplate,
  type ParseOptions,
  type ProviderCatalogEntry,
  type ProviderCatalogEntryInput,
} from "./schema.js";

/*
 * The `catalog-http` adapter: one implementation for every data-defined
 * provider.
 *
 * It has two shapes. Unpinned (`catalog-http`), it imports catalog documents
 * and Nango `providers.yaml` files into draft definitions, and executes a
 * binding using the entry review approved into the binding's settings.
 * Pinned (`catalog-<id>`), it is one host-registered provider: the directory
 * shows it as its own connector, and at run time it executes the host's entry
 * and refuses a binding whose settings carry a different one.
 * Unpinned, the entry a binding carries is the one binding review copied from
 * the reviewed definition, and its OAuth origins were admitted by host issuer
 * policy for a person; a reviewer's own settings can supply neither.
 *
 * Either way the rules are those of every other adapter here:
 *
 * - Nothing is contacted without an approved binding. Authorization and token
 *   endpoints come from the reviewed entry, filled with per-connection values
 *   that are validated as DNS labels or URL tokens; the proxy reaches only a
 *   path under the binding's approved destination, and only when that
 *   destination's origin is the entry's declared proxy origin. There is no
 *   open proxy: a caller names a path, never a host.
 * - Credentials are read only inside `credentials.use` and rotated only
 *   inside `credentials.refresh`. What a callback returns never contains the
 *   material, and a provider response that echoes a credential back has that
 *   value redacted before it leaves the callback.
 * - OAuth goes through the shared engine in `auth/*`: authorization code with
 *   S256 PKCE, one-use codes journaled before exchange, client credentials,
 *   and renewal under the custody port's single-flight lock -- ahead of
 *   expiry, and once more when the provider refuses a presented token.
 *   The engine settles the authorization handoff itself, as it does for every
 *   other adapter, and says so (`handoffSettled`), so the command layer makes
 *   the one state transition and never a second.
 * - Support is reported as a fixture. The adapter is exercised against
 *   loopback protocol fixtures; that is not evidence any particular provider
 *   in a catalog works, and nothing here says it is.
 */

export const CATALOG_ADAPTER_ID = "catalog-http";
export const CATALOG_ADAPTER_VERSION = "1.0.0";
const HANDOFF_TTL_MS = 600_000;
const REFRESH_SKEW_MS = 60_000;
const MAX_DEFINITIONS_PER_IMPORT = 64;

export interface CatalogHttpAdapterOptions {
  /** Pin the adapter to one host-registered entry; its id becomes `catalog-<entry id>`. */
  entry?: ProviderCatalogEntryInput | ProviderCatalogEntry;
  /**
   * Admit loopback HTTP endpoints in entries (fixtures only). Execution also
   * requires the binding's destination to be a host-admitted loopback fixture.
   */
  allowLoopbackHttp?: boolean;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  maxImportBytes?: number;
  /** Evidence level this deployment has measured; defaults to protocol-fixture. */
  evidence?: EvidenceLevel;
}

const DEFAULTS = {
  requestTimeoutMs: 30_000,
  maxResponseBytes: 1024 * 1024,
  maxImportBytes: 4 * 1024 * 1024,
};

const profileKinds: Record<ProviderCatalogEntry["auth"]["mode"], string[]> = {
  "oauth2-authorization-code": ["oauth-authorization-code"],
  "oauth2-client-credentials": ["oauth-client-credentials"],
  "api-key": ["api-key"],
  basic: ["http-basic"],
  bearer: ["http-bearer"],
  none: ["none"],
  unsupported: [],
};

/** Material keys that are secrets; their values are redacted from any output. */
const SECRET_KEYS = new Set([
  "access_token",
  "refresh_token",
  "api_key",
  "password",
  "token",
]);

type AuthCode = Extract<
  ProviderCatalogEntry["auth"],
  { mode: "oauth2-authorization-code" }
>;
type ClientCredentials = Extract<
  ProviderCatalogEntry["auth"],
  { mode: "oauth2-client-credentials" }
>;

type OAuthContext = {
  policy: IssuerPolicy;
  server: ResolvedAuthorizationServer;
  /** The server description refresh requests use; differs only by token endpoint. */
  refreshServer: ResolvedAuthorizationServer;
  client: ResolvedClient;
  allowLoopbackHttp: boolean;
};

const proxyInputSchema = z.strictObject({
  /** A path under the provider's API base; never a URL, never a host. */
  path: z
    .string()
    .min(1)
    .max(2048)
    .regex(/^\/(?!\/)[A-Za-z0-9_~.\-/:@!$&'()*+,;=%]*$/),
  query: z
    .record(
      z.string().regex(/^[A-Za-z0-9_.[\]-]{1,64}$/),
      z.union([z.string().max(2048), z.number(), z.boolean()]),
    )
    .refine((value) => Object.keys(value).length <= 32, "Too many parameters")
    .optional(),
  body: z.unknown().optional(),
});

const credentialValue = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[^\p{Cc}]+$/u);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Replaces every occurrence of a secret value in strings of a JSON value. */
function redact(value: unknown, secrets: readonly string[]): unknown {
  if (!secrets.length) return value;
  if (typeof value === "string")
    return secrets.reduce(
      (text, secret) => text.split(secret).join("[redacted]"),
      value,
    );
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redact(key, secrets) as string,
        redact(item, secrets),
      ]),
    );
  return value;
}

/**
 * Every form in which this call could have sent the credential: each secret
 * value, and the exact forms `placeCredential` wrote -- the API key with its
 * prefix, and for Basic the username and the encoded `user:pass` pair, which
 * contains neither half verbatim.
 */
function secretsOf(
  entry: ProviderCatalogEntry,
  material: CredentialMaterial,
): string[] {
  const values = Object.entries(material)
    .filter(([key]) => SECRET_KEYS.has(key))
    .map(([, value]) => value);
  const auth = entry.auth;
  if (auth.mode === "api-key" && material["api_key"])
    values.push(`${auth.prefix}${material["api_key"]}`);
  if (auth.mode === "basic" && material["username"] !== undefined) {
    const username = material["username"];
    values.push(
      username,
      Buffer.from(`${username}:${material["password"] ?? ""}`, "utf8").toString(
        "base64",
      ),
    );
  }
  return [...new Set(values)]
    .filter((value) => value.length >= 4)
    .sort((a, b) => b.length - a.length);
}

export function createCatalogHttpAdapter(
  options: CatalogHttpAdapterOptions = {},
): ConnectorAdapter {
  const parseOptions: ParseOptions = {
    allowLoopbackHttp: options.allowLoopbackHttp ?? false,
  };
  const pinned = options.entry
    ? parseProviderCatalogEntry(options.entry, parseOptions)
    : undefined;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs;
  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULTS.maxResponseBytes;
  const maxImportBytes = options.maxImportBytes ?? DEFAULTS.maxImportBytes;
  const evidence = options.evidence ?? "protocol-fixture";
  const executable = !pinned || pinned.auth.mode !== "unsupported";

  function entryFor(ctx: AdapterCallContext): ProviderCatalogEntry {
    const approved = entryFromBinding(ctx.binding, parseOptions);
    if (pinned) {
      if (approved && entryDigest(approved) !== entryDigest(pinned))
        throw new ConnectorError("configuration-required", {
          detail: "catalog.binding.entry-differs",
        });
      return pinned;
    }
    if (!approved)
      throw new ConnectorError("configuration-required", {
        detail: "catalog.binding.entry-missing",
      });
    return approved;
  }

  /** Loopback HTTP needs both the host's opt-in and a destination host policy admitted as a fixture. */
  function loopbackAllowed(ctx: AdapterCallContext): boolean {
    return (
      parseOptions.allowLoopbackHttp === true &&
      ctx.binding.destinations.some(
        (destination) => destination.network === "loopback-fixture",
      )
    );
  }

  async function connectionValues(
    ctx: AdapterCallContext,
    entry: ProviderCatalogEntry,
  ): Promise<{ values: Record<string, string>; missing: string[] }> {
    const values: Record<string, string> = {};
    const missing: string[] = [];
    for (const field of entry.connectionConfig) {
      const value = await ctx.environment.configuration.read(
        field.configuration,
      );
      if (value === undefined || value === "")
        missing.push(field.configuration);
      else values[field.name] = value;
    }
    return { values, missing };
  }

  async function missingConfiguration(
    ctx: AdapterCallContext,
    entry: ProviderCatalogEntry,
  ): Promise<string[]> {
    const names = configurationFor(entry).map((item) => item.name);
    const present = await ctx.environment.configuration.present(names);
    return names.filter((name) => !present.has(name));
  }

  async function oauthContext(
    ctx: AdapterCallContext,
    entry: ProviderCatalogEntry,
    auth: AuthCode | ClientCredentials,
    values: Record<string, string>,
  ): Promise<OAuthContext> {
    const allowLoopbackHttp = loopbackAllowed(ctx);
    const resolve = (template: string) =>
      resolveUrlTemplate(entry, template, values, { allowLoopbackHttp }).url;
    const token = resolve(auth.tokenUrl);
    const authorization =
      auth.mode === "oauth2-authorization-code"
        ? resolve(auth.authorizationUrl)
        : undefined;
    const refresh =
      auth.mode === "oauth2-authorization-code" && auth.refreshUrl
        ? resolve(auth.refreshUrl)
        : undefined;
    const issuer =
      auth.mode === "oauth2-authorization-code" && auth.issuer
        ? auth.issuer
        : token.origin;
    const issuerOrigin = new URL(issuer).origin;
    const trustedOrigins = [
      ...new Set(
        [authorization, token, refresh]
          .filter((url): url is URL => url !== undefined)
          .map((url) => url.origin)
          .filter((origin) => origin !== issuerOrigin),
      ),
    ];
    const names = clientConfigurationNames(entry);
    const policy = issuerPolicy({
      issuer,
      discovery: "disabled",
      allowLoopbackHttp,
      trustedOrigins,
      acceptIssuerDeclaredOrigins: false,
      endpoints: {
        ...(authorization ? { authorization: authorization.href } : {}),
        token: token.href,
      },
      registration: {
        allowed: ["pre-registered"],
        ...(names.clientId ? { clientIdConfiguration: names.clientId } : {}),
        ...(names.clientSecret
          ? { clientSecretConfiguration: names.clientSecret }
          : {}),
        clientAuthentication: auth.tokenRequestAuth,
      },
    });
    const server = await resolveAuthorizationServer(policy, {
      fetch: ctx.environment.fetch,
      signal: ctx.signal,
    });
    const refreshServer: ResolvedAuthorizationServer = refresh
      ? {
          ...server,
          metadata: { ...server.metadata, token_endpoint: refresh.href },
        }
      : server;
    const client = await resolveClientRegistration({
      actor: ctx.actor,
      policy,
      server,
      redirectUri: callbackUri(ctx),
      hostOrigin: ctx.environment.origin,
      configuration: ctx.environment.configuration,
      fetch: ctx.environment.fetch,
      signal: ctx.signal,
      now: ctx.environment.now,
    });
    return { policy, server, refreshServer, client, allowLoopbackHttp };
  }

  function requestedScopes(
    auth: AuthCode | ClientCredentials,
    requested: readonly string[],
  ): string {
    const scopes = [...new Set([...auth.scopes, ...requested])];
    // An ID token names the account, and without discovery there are no
    // published keys to verify one against; so none is asked for.
    if (scopes.includes("openid"))
      throw new ConnectorError("unsupported", {
        detail: "catalog.scope.openid",
      });
    // The entry's defaults are the only scopes a reviewer saw; a caller may
    // name them, never add one.
    if (requested.some((scope) => !auth.scopes.includes(scope)))
      throw new ConnectorError("invalid-request", {
        detail: "catalog.scope.undeclared",
      });
    if (
      scopes.length > 64 ||
      scopes.some((scope) => !/^[^\s\p{Cc},]{1,200}$/u.test(scope))
    )
      throw new ConnectorError("invalid-request", {
        detail: "catalog.scope.invalid",
      });
    return scopes.join(auth.scopeSeparator);
  }

  function scopeFor(ctx: AdapterCallContext): CredentialScope {
    const connection = ctx.connection;
    if (!connection)
      throw new ConnectorError("invalid-request", {
        detail: "catalog.connection-required",
      });
    return credentialScopeFor(ctx, connection);
  }

  /** The approved destination for the entry's resolved proxy base, or a refusal. */
  function proxyTarget(
    ctx: AdapterCallContext,
    entry: ProviderCatalogEntry,
    values: Record<string, string>,
    destination?: ApprovedDestination,
  ): { base: URL; destination: ApprovedDestination } {
    if (!entry.proxy)
      throw new ConnectorError("unsupported", {
        detail: "catalog.proxy.undeclared",
      });
    const allowLoopbackHttp = loopbackAllowed(ctx);
    const base = resolveUrlTemplate(entry, entry.proxy.baseUrl, values, {
      allowLoopbackHttp,
    }).url;
    const chosen =
      destination ??
      ctx.binding.destinations.find((item) => item.origin === base.origin);
    // The reviewer approved an exact origin; the entry declared one. They
    // must be the same origin, or the proxy would be reaching somewhere
    // neither of them named.
    if (!chosen || chosen.origin !== base.origin)
      throw new ConnectorError("network-policy", {
        detail: "catalog.proxy.origin-mismatch",
      });
    if (chosen.network === "loopback-fixture" && !allowLoopbackHttp)
      throw new ConnectorError("network-policy", {
        detail: "catalog.proxy.loopback",
      });
    return { base, destination: chosen };
  }

  function proxyUrl(
    base: URL,
    destination: ApprovedDestination,
    path: string,
  ): URL {
    const basePath = base.pathname.replace(/\/+$/, "");
    if (
      /%2f|%5c|%2e/i.test(path) ||
      path.split("/").some((segment) => segment === "." || segment === "..")
    )
      throw new ConnectorError("invalid-request", {
        detail: "catalog.proxy.path",
      });
    let url: URL;
    try {
      url = destinationUrl(destination, `${basePath}${path}`);
    } catch (error) {
      throw new ConnectorError("network-policy", {
        detail: "catalog.proxy.path",
        cause: error,
      });
    }
    if (
      basePath &&
      !url.pathname.startsWith(`${basePath}/`) &&
      url.pathname !== basePath
    )
      throw new ConnectorError("network-policy", {
        detail: "catalog.proxy.path",
      });
    return url;
  }

  /** Default headers from the entry, filled with this connection's values. */
  function defaultHeaders(
    entry: ProviderCatalogEntry,
    values: Record<string, string>,
  ): Headers {
    const headers = new Headers();
    for (const [name, template] of Object.entries(entry.proxy?.headers ?? {}))
      headers.set(name, resolveValueTemplate(entry, template, values));
    return headers;
  }

  /** Puts the credential where the entry's auth mode says; nowhere else. */
  function placeCredential(
    entry: ProviderCatalogEntry,
    material: CredentialMaterial,
    headers: Headers,
    url: URL,
  ): void {
    const auth = entry.auth;
    const missing = () =>
      new ConnectorError("unauthenticated", {
        detail: "catalog.credential.missing",
      });
    switch (auth.mode) {
      case "oauth2-authorization-code":
      case "oauth2-client-credentials": {
        const token = material["access_token"];
        if (!token) throw missing();
        headers.set("authorization", `Bearer ${token}`);
        return;
      }
      case "bearer": {
        const token = material["token"];
        if (!token) throw missing();
        headers.set("authorization", `Bearer ${token}`);
        return;
      }
      case "api-key": {
        const key = material["api_key"];
        if (!key) throw missing();
        if (auth.placement === "header")
          headers.set(auth.name, `${auth.prefix}${key}`);
        else {
          if (url.searchParams.has(auth.name))
            throw new ConnectorError("invalid-request", {
              detail: "catalog.proxy.credential-parameter",
            });
          url.searchParams.set(auth.name, `${auth.prefix}${key}`);
        }
        return;
      }
      case "basic": {
        const username = material["username"];
        const password = material["password"] ?? "";
        if (username === undefined) throw missing();
        headers.set(
          "authorization",
          `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`,
        );
        return;
      }
      case "none":
        return;
      case "unsupported":
        throw new ConnectorError("unsupported", {
          detail: "catalog.auth-mode.unsupported",
        });
    }
  }

  /**
   * Refreshes an expiring credential before it is used. Authorization-code
   * grants go through the engine's single-flight refresh; client credentials
   * are simply requested again under the same lock. A grant with no refresh
   * is reported expired rather than presented and rejected upstream.
   */
  async function ensureFresh(
    ctx: AdapterCallContext,
    entry: ProviderCatalogEntry,
    values: Record<string, string>,
    scope: CredentialScope,
    ref: string,
  ): Promise<void> {
    const auth = entry.auth;
    if (
      auth.mode !== "oauth2-authorization-code" &&
      auth.mode !== "oauth2-client-credentials"
    )
      return;
    const described = await ctx.environment.credentials.describe(scope, ref);
    if (!described)
      throw new ConnectorError("unauthenticated", {
        detail: "catalog.credential.missing",
      });
    if (
      described.expiresAt === undefined ||
      described.expiresAt - ctx.environment.now() > REFRESH_SKEW_MS
    )
      return;
    // A worker that renewed while this one waited on the lock leaves nothing
    // to do: only a token still inside the skew is renewed.
    const stale = (current: Readonly<CredentialMaterial>) => {
      const held = Number(current["expires_at"]);
      return !(
        Number.isFinite(held) && held - ctx.environment.now() > REFRESH_SKEW_MS
      );
    };
    const context = await oauthContext(ctx, entry, auth, values);
    if (auth.mode === "oauth2-authorization-code") {
      if (!auth.refresh)
        throw new ConnectorError("expired", {
          detail: "catalog.credential.expired",
        });
      await refreshAccessToken(ctx, {
        server: context.refreshServer,
        client: context.client,
        policy: context.policy,
        credentialRef: ref,
        scope,
        stillStale: stale,
      });
      return;
    }
    await renewClientCredentials(ctx, {
      ...clientCredentialsInput(ctx, entry, auth, values, context),
      credentialRef: ref,
      stillStale: stale,
    });
  }

  /**
   * One renewal after the provider refused the token this call presented.
   * Custody's single-flight lock makes invocations refused together renew
   * once: a follower finds the held token is no longer the one refused and
   * presents nothing. False when this entry cannot renew (no refresh, not
   * OAuth, no refresh token held), so the caller keeps the refusal.
   */
  async function renewRefused(
    ctx: AdapterCallContext,
    entry: ProviderCatalogEntry,
    values: Record<string, string>,
    scope: CredentialScope,
    ref: string,
    refused: string,
  ): Promise<boolean> {
    const auth = entry.auth;
    const stillStale = (current: Readonly<CredentialMaterial>) =>
      sha256(current["access_token"] ?? "") === refused;
    if (auth.mode === "oauth2-client-credentials") {
      const context = await oauthContext(ctx, entry, auth, values);
      await renewClientCredentials(ctx, {
        ...clientCredentialsInput(ctx, entry, auth, values, context),
        credentialRef: ref,
        stillStale,
      });
      return true;
    }
    if (auth.mode !== "oauth2-authorization-code" || !auth.refresh)
      return false;
    const context = await oauthContext(ctx, entry, auth, values);
    try {
      await refreshAccessToken(ctx, {
        server: context.refreshServer,
        client: context.client,
        policy: context.policy,
        credentialRef: ref,
        scope,
        stillStale,
      });
    } catch (error) {
      if (
        error instanceof ConnectorError &&
        error.detail === "oauth.refresh.no-refresh-token"
      )
        return false;
      throw error;
    }
    return true;
  }

  /** The engine's client-credentials input for this entry and connection. */
  function clientCredentialsInput(
    ctx: AdapterCallContext,
    entry: ProviderCatalogEntry,
    auth: ClientCredentials,
    values: Record<string, string>,
    context: OAuthContext,
  ) {
    const requested = requestedScopes(auth, []);
    return {
      server: context.server,
      client: context.client,
      policy: context.policy,
      scopes: requested ? requested.split(auth.scopeSeparator) : [],
      scopeSeparator: auth.scopeSeparator,
      scope: scopeFor(ctx),
      parameters: tokenParameters(entry, auth, values),
    };
  }

  function tokenParameters(
    entry: ProviderCatalogEntry,
    auth: ClientCredentials,
    values: Record<string, string>,
  ): Record<string, string> {
    return Object.fromEntries(
      Object.entries(auth.tokenParams).map(([name, template]) => [
        name,
        resolveValueTemplate(entry, template, values),
      ]),
    );
  }

  /** One bounded request to the proxy destination, credential placed inside custody. */
  async function send(
    ctx: AdapterCallContext,
    entry: ProviderCatalogEntry,
    request: { method: string; url: URL; headers: Headers; body?: string },
    scope: CredentialScope | undefined,
    ref: string | undefined,
    read: (
      response: Response,
      secrets: readonly string[],
    ) => Promise<InvokeResult>,
    /** Receives a digest of the OAuth access token presented; never the token. */
    presented?: { digest?: string },
  ): Promise<InvokeResult> {
    const perform = async (material: CredentialMaterial | undefined) => {
      const url = new URL(request.url.href);
      const headers = new Headers(request.headers);
      if (material) placeCredential(entry, material, headers, url);
      if (presented && material?.["access_token"])
        presented.digest = sha256(material["access_token"]);
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        const response = await ctx.environment.fetch(url, {
          method: request.method,
          headers,
          ...(request.body === undefined ? {} : { body: request.body }),
          redirect: "error",
          signal: controller.signal,
        });
        return await read(response, material ? secretsOf(entry, material) : []);
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
      }
    };
    if (entry.auth.mode === "none") return perform(undefined);
    if (!scope || !ref)
      throw new ConnectorError("unauthenticated", {
        detail: "catalog.credential.missing",
      });
    return ctx.environment.credentials.use(scope, ref, perform);
  }

  /** A verification read, when the entry declares one, for collected credentials. */
  async function probe(
    ctx: AdapterCallContext,
    entry: ProviderCatalogEntry,
    values: Record<string, string>,
    scope: CredentialScope,
    ref: string,
  ): Promise<"accepted" | "rejected" | "inconclusive" | "unavailable"> {
    const verification = entry.proxy?.verification;
    if (!verification) return "unavailable";
    const { base, destination } = proxyTarget(ctx, entry, values);
    const url = proxyUrl(base, destination, verification.path);
    const headers = defaultHeaders(entry, values);
    headers.set("accept", "application/json");
    try {
      const result = await send(
        ctx,
        entry,
        { method: verification.method, url, headers },
        scope,
        ref,
        async (response) => {
          await response.body?.cancel().catch(() => {});
          return {
            state: response.ok ? "complete" : "failed",
            outputClassification: "public",
            effect: "read",
            code: String(response.status),
          };
        },
      );
      if (result.state === "complete") return "accepted";
      return result.code === "401" || result.code === "403"
        ? "rejected"
        : "inconclusive";
    } catch (error) {
      if (
        error instanceof ConnectorError &&
        error.code !== "upstream-unavailable"
      )
        throw error;
      return "inconclusive";
    }
  }

  function acceptedClaim(
    ctx: AdapterCallContext,
    entry: ProviderCatalogEntry,
    target: string,
    input: {
      requested?: string[];
      reported?: string[];
      validUntil?: number;
    } = {},
  ) {
    return credentialAcceptedClaim(ctx, {
      issuer: target,
      target: { kind: "http-destination", id: target },
      permissions: permissionRecord({
        requested: input.requested ?? [],
        reported: input.reported ?? [],
        source: input.reported?.length ? "token-response" : "none",
      }),
      ...(input.validUntil !== undefined
        ? { validUntil: input.validUntil }
        : {}),
      limitations: [
        `${entry.displayName} accepted the credential; that proves a grant to this client, not which account granted it.`.slice(
          0,
          500,
        ),
      ],
    });
  }

  async function authorize(
    ctx: AdapterCallContext,
    intent: AuthorizationIntent,
  ): Promise<AuthorizationStart> {
    const entry = entryFor(ctx);
    const auth = entry.auth;
    if (auth.mode === "unsupported")
      return { kind: "unsupported", code: "catalog.auth-mode.unsupported" };
    if (intent.profileId && intent.profileId !== profileIdFor(entry))
      return { kind: "unsupported", code: "catalog.profile.unknown" };
    const missing = await missingConfiguration(ctx, entry);
    if (missing.length) return { kind: "configuration-required", missing };
    const { values } = await connectionValues(ctx, entry);
    switch (auth.mode) {
      case "oauth2-authorization-code": {
        const context = await oauthContext(ctx, entry, auth, values);
        const scope = requestedScopes(auth, intent.requestedPermissions);
        const start = await beginAuthorizationCode(ctx, {
          server: context.server,
          client: context.client,
          policy: context.policy,
          // Joined here so a comma-separated provider gets its own spelling;
          // the engine sends one opaque scope value.
          scopes: scope ? [scope] : [],
          profileId: profileIdFor(entry),
          extraParameters: Object.fromEntries(
            Object.entries(auth.authorizationParams).map(([name, template]) => [
              name,
              resolveValueTemplate(entry, template, values),
            ]),
          ),
          expiresInMs: HANDOFF_TTL_MS,
        });
        if (start.kind !== "handoff") return start;
        const authorizationUrl = start.handoff.private["authorizationUrl"];
        return {
          kind: "handoff",
          handoff: {
            ...start.handoff,
            // The command layer presents `url` to the initiating human only.
            private: {
              ...start.handoff.private,
              ...(authorizationUrl ? { url: authorizationUrl } : {}),
            },
          },
        };
      }
      case "oauth2-client-credentials":
      case "none":
        return { kind: "verify" };
      case "api-key":
      case "basic":
      case "bearer": {
        const fields =
          auth.mode === "api-key"
            ? ["apiKey"]
            : auth.mode === "bearer"
              ? ["token"]
              : auth.passwordOptional
                ? ["username"]
                : ["username", "password"];
        return {
          kind: "handoff",
          handoff: {
            kind: "private-collector",
            presentation: "in-app",
            expiresAt: ctx.environment.now() + HANDOFF_TTL_MS,
            intent: "catalog.collect-credential",
            private: {
              instructions:
                `Enter the ${auth.mode === "basic" ? "username and password" : auth.mode === "bearer" ? "access token" : "API key"} issued by ${entry.displayName}.`.slice(
                  0,
                  500,
                ),
              fields: JSON.stringify(fields),
            },
          },
        };
      }
    }
  }

  async function completeCollected(
    ctx: AdapterCallContext,
    entry: ProviderCatalogEntry,
    values: Record<string, string>,
    input: Record<string, string>,
  ): Promise<CompletionResult> {
    const auth = entry.auth;
    const read = (name: string, optional = false): string | undefined => {
      const value = input[name];
      if (value === undefined || value === "") {
        if (optional) return undefined;
        throw new ConnectorError("invalid-request", {
          detail: "catalog.credential.missing",
        });
      }
      if (!credentialValue.safeParse(value).success)
        throw new ConnectorError("invalid-request", {
          detail: "catalog.credential.invalid",
        });
      return value;
    };
    let material: Record<string, string>;
    switch (auth.mode) {
      case "api-key":
        material = { api_key: read("apiKey")! };
        break;
      case "bearer":
        material = { token: read("token")! };
        break;
      case "basic": {
        const username = read("username")!;
        const password = read("password", auth.passwordOptional);
        if (username.includes(":"))
          throw new ConnectorError("invalid-request", {
            detail: "catalog.credential.invalid",
          });
        material = {
          username,
          ...(password !== undefined ? { password } : {}),
        };
        break;
      }
      default:
        return {
          state: "denied",
          claims: [],
          code: "catalog.input.unexpected",
        };
    }
    const scope = scopeFor(ctx);
    const credentialRef = await ctx.environment.credentials.store(
      scope,
      material,
    );
    const outcome = await probe(ctx, entry, values, scope, credentialRef);
    if (outcome === "rejected") {
      await ctx.environment.credentials
        .revoke(scope, credentialRef)
        .catch(() => {});
      return { state: "denied", claims: [], code: "credential.rejected" };
    }
    const target = entry.proxy
      ? proxyTarget(ctx, entry, values).base.origin
      : entry.id;
    return {
      state: "complete",
      claims: outcome === "accepted" ? [acceptedClaim(ctx, entry, target)] : [],
      credentialRef,
      adapterState: {
        mode: auth.mode,
        verification: outcome,
      },
    };
  }

  const adapter: ConnectorAdapter = {
    id: pinned ? `catalog-${pinned.id}` : CATALOG_ADAPTER_ID,
    ecosystem: CATALOG_ECOSYSTEM,
    adapterVersion: CATALOG_ADAPTER_VERSION,
    runtime: "hosted-server",
    displayName: pinned ? pinned.displayName : "Provider catalog (HTTP)",
    description: pinned
      ? (executable
          ? `${pinned.displayName}, defined as data in the provider catalog. Its declared endpoints are contacted only after binding review.`
          : `${pinned.displayName}, described in the provider catalog but not executable: ${pinned.auth.mode === "unsupported" ? pinned.auth.reason : ""}`
        ).slice(0, 500)
      : "Imports provider catalogs and Nango providers.yaml into draft connectors, and executes reviewed entries: OAuth authorization code and client credentials, API keys, Basic and bearer credentials, and an authenticated proxy to the approved origin.",
    service: pinned ? pinned.id : "provider-catalog",
    support: executable ? "fixture" : "catalog-only",
    custody: ["host-owned", "no-credential"],
    configuration: pinned ? configurationFor(pinned) : [],
    profiles: pinned
      ? profileKinds[pinned.auth.mode]
      : [
          "oauth-authorization-code",
          "oauth-client-credentials",
          "api-key",
          "http-basic",
          "http-bearer",
          "none",
        ],

    capabilities(present: ReadonlySet<string>): CapabilityStatus[] {
      const profile = pinned
        ? `provider-catalog:${pinned.auth.mode}`
        : "provider-catalog-v1";
      const required = adapter.configuration
        .filter((item) => item.required)
        .map((item) => item.name);
      const configuration: CapabilityStatus["configuration"] = !required.length
        ? "not-applicable"
        : required.every((name) => present.has(name))
          ? "ready"
          : "missing";
      const blocked = pinned?.auth.mode === "unsupported";
      const reason =
        pinned?.auth.mode === "unsupported"
          ? `Described only: ${pinned.auth.reason}`.slice(0, 500)
          : "";
      // A described-only provider is `catalog-only`, and a catalog-only row
      // implements nothing: every dimension says so, with the reason.
      const row = (
        dimension: CapabilityStatus["dimension"],
        limitations: string[],
        unsupported = false,
      ) =>
        capabilityStatus(adapter, {
          dimension,
          profile,
          ...(unsupported || blocked
            ? { implementation: "unsupported" as const }
            : { evidence }),
          ...(dimension === "authorize" || dimension === "configure"
            ? { configuration }
            : {}),
          limitations,
        });
      return [
        row(
          "discover",
          [
            "A catalog is imported as a document; there is no provider listing to discover.",
          ],
          true,
        ),
        row("import", [
          "Reads Ceremony provider catalogs and Nango providers.yaml; unsupported auth modes are kept as descriptions with a reason, never dropped.",
          "An import creates drafts only; every endpoint in them is contacted only after a reviewer approves a binding.",
        ]),
        row("configure", [
          "OAuth client ids and secrets, and per-connection values such as a subdomain, come from host configuration by name.",
        ]),
        row(
          "authorize",
          blocked
            ? [reason]
            : [
                "OAuth authorization code always sends S256 PKCE; endpoints come from the reviewed entry, never from discovery.",
                "Client credentials is a local grant request pending the shared engine's own.",
                "API keys, Basic and bearer credentials are collected through the private collector, never through model-visible input.",
              ],
          blocked,
        ),
        row(
          "verify",
          blocked
            ? [reason]
            : [
                "A collected credential is checked only when the entry declares a verification read; otherwise it is stored unverified.",
                "Acceptance proves a grant, not which account it belongs to.",
              ],
          blocked,
        ),
        row(
          "invoke",
          blocked
            ? [reason]
            : [
                "The proxy reaches a caller-named path under the approved destination only; the destination must be the entry's declared proxy origin.",
                "Expiring OAuth credentials are refreshed before use; a grant without refresh reports expiry.",
              ],
          blocked || (pinned !== undefined && !pinned.proxy),
        ),
        row("events", ["The catalog format declares no webhooks."], true),
        row(
          "reconnect",
          blocked
            ? [reason]
            : ["Reconnect repeats authorization under the current binding."],
          blocked,
        ),
        row("disconnect", [
          "Local disconnect only; a catalog entry declares no upstream unlink.",
        ]),
        row(
          "revoke",
          [
            "A catalog entry declares no revocation endpoint; upstream revocation is not attempted.",
          ],
          true,
        ),
        row(
          "export",
          ["Catalog entries are not exported by this adapter."],
          true,
        ),
        row("delegate", ["There is no third party to delegate to."], true),
      ];
    },

    // The entry is copied from the reviewed definition by binding review;
    // a reviewer's free-form settings cannot supply or replace it.
    reservedSettings: Object.values(CATALOG_SETTINGS),

    async reviewBinding(input) {
      return reviewCatalogBinding(input, {
        ...parseOptions,
        ...(pinned ? { pinned } : {}),
      });
    },

    async import(
      ctx: AdapterCallContext,
      input: ImportInput,
    ): Promise<ImportOutcome> {
      if (input.bytes.byteLength > maxImportBytes)
        throw new ConnectorError("invalid-request", {
          detail: "catalog.document.too-large",
        });
      const parsed = parseBoundedDocument(input.bytes, {
        mediaType: input.mediaType,
        limits: { maxBytes: maxImportBytes },
      });
      const document = parsed.value;
      const issues: CompatibilityIssue[] = [];
      let format: "provider-catalog" | "nango-providers";
      let found: Array<{
        entry: ProviderCatalogEntry;
        issues: CompatibilityIssue[];
      }>;
      if (
        document &&
        typeof document === "object" &&
        (document as Record<string, unknown>)["catalog"] ===
          PROVIDER_CATALOG_FORMAT
      ) {
        format = "provider-catalog";
        const read = catalogDocumentSchemaFor(parseOptions).safeParse(document);
        if (!read.success) {
          issues.push(
            catalogIssue({
              kind: "rejected",
              code: firstCode(read.error) ?? "catalog.document.invalid",
              pointer: "",
              category: "security",
              executionImpact: "blocks-definition",
              message:
                "The catalog document does not satisfy the catalog schema; nothing was imported.",
            }),
          );
          found = [];
        } else
          found = read.data.providers.map((entry) => ({ entry, issues: [] }));
      } else {
        format = "nango-providers";
        const read = importNangoProviders(
          document as Record<string, unknown>,
          parseOptions,
        );
        issues.push(...read.issues);
        found = read.providers.map((item) => ({
          entry: item.entry,
          issues: item.issues,
        }));
      }
      if (pinned) {
        const own = found.filter((item) => item.entry.id === pinned.id);
        found = own.filter(
          (item) => entryDigest(item.entry) === entryDigest(pinned),
        );
        if (!found.length)
          issues.push(
            catalogIssue({
              kind: "rejected",
              code: own.length
                ? "catalog.entry.differs-from-host"
                : "catalog.entry.absent",
              pointer: "",
              category: "policy",
              executionImpact: "blocks-definition",
              message:
                "This connector is pinned to the host's registered entry; the document does not contain that exact entry.",
            }),
          );
      }
      if (found.length > MAX_DEFINITIONS_PER_IMPORT) {
        issues.push(
          catalogIssue({
            kind: "warning",
            code: "catalog.import.truncated",
            pointer: "",
            message:
              "Only the first 64 providers became drafts; import a selection, or register the catalog with the host, for the rest.",
          }),
        );
        found = found.slice(0, MAX_DEFINITIONS_PER_IMPORT);
      }
      const namespace = format === "nango-providers" ? "nango" : "ceremony";
      const definitions: NormalizedDefinition[] = [];
      for (const item of found) {
        definitions.push(
          await definitionFor(item.entry, {
            authorityNamespace: namespace,
            issues: item.issues,
          }),
        );
        issues.push(...item.issues);
      }
      const outputDigest = sha256(
        canonicalConnectorJson(found.map((item) => item.entry)),
      );
      const sourceRef = `catalog:src:${parsed.digest.slice(0, 32)}`;
      const source: SourceRecord = {
        sourceRef,
        identity: {
          ecosystem: CATALOG_ECOSYSTEM,
          authorityNamespace: namespace,
          nativeId: pinned ? pinned.id : format,
          nativeVersion: `sha256:${parsed.digest.slice(0, 16)}`,
        },
        format: { name: format, version: "1" },
        origin: input.origin,
        digest: { algorithm: "sha256", value: parsed.digest },
        byteLength: input.bytes.byteLength,
        mediaType: input.mediaType || "application/yaml",
        capturedAt: new Date(ctx.environment.now()).toISOString(),
        adaptation: [
          {
            step: "provider-catalog-read",
            version: CATALOG_IMPORTER_VERSION,
            inputDigest: parsed.digest,
            outputDigest,
          },
        ],
        overlays: [],
      };
      const runnable = definitions.some(
        (definition) =>
          definition.capabilities.some((capability) =>
            capability.nativeId.startsWith("proxy."),
          ) && definition.authentication[0]?.kind !== "unsupported",
      );
      return {
        source,
        definitions,
        issues: issues.slice(0, 4096),
        // Candidates a reviewer may bind; import approves nothing.
        executableCandidates: runnable
          ? PROXY_METHODS.map((method) => proxyNativeId(method))
          : [],
      };
    },

    authorize,

    async reconnect(ctx, intent) {
      return authorize(ctx, intent);
    },

    async complete(
      ctx: AdapterCallContext,
      input: CompletionInput,
    ): Promise<CompletionResult> {
      const handoff = ctx.handoff;
      if (!handoff)
        return { state: "pending", claims: [], code: "handoff.unavailable" };
      const entry = entryFor(ctx);
      const auth = entry.auth;
      const { values, missing } = await connectionValues(ctx, entry);
      if (missing.length)
        return {
          state: "denied",
          claims: [],
          code: "configuration.missing",
        };
      if (input.kind === "poll" || input.kind === "event")
        return { state: "pending", claims: [], code: "authorization.pending" };
      if (input.kind === "input")
        return completeCollected(ctx, entry, values, input.values);
      if (auth.mode !== "oauth2-authorization-code")
        return {
          state: "denied",
          claims: [],
          code: "catalog.callback.unexpected",
        };
      const context = await oauthContext(ctx, entry, auth, values);
      const result = await completeAuthorizationCode(ctx, {
        url: input.url,
        handoff,
        server: context.server,
        client: context.client,
        policy: context.policy,
      });
      // The grant settled the handoff itself, under the generation fence,
      // for these outcomes; the command layer records it and moves on.
      return ["complete", "denied", "expired"].includes(result.state)
        ? { ...result, handoffSettled: true }
        : result;
    },

    async verify(ctx: AdapterCallContext): Promise<CompletionResult> {
      const entry = entryFor(ctx);
      const auth = entry.auth;
      const { values, missing } = await connectionValues(ctx, entry);
      if (missing.length)
        return { state: "pending", claims: [], code: "configuration.missing" };
      if (auth.mode === "unsupported")
        return {
          state: "denied",
          claims: [],
          code: "catalog.auth-mode.unsupported",
        };
      if (auth.mode === "none") return { state: "complete", claims: [] };
      if (auth.mode === "oauth2-client-credentials") {
        const context = await oauthContext(ctx, entry, auth, values);
        const input = clientCredentialsInput(ctx, entry, auth, values, context);
        let credentialRef = ctx.connection?.credentialRef;
        let permissions: PermissionRecord | undefined;
        let expiresAt: number | undefined;
        if (credentialRef) {
          // Verification re-runs the grant: a token proves the client is
          // still accepted only if the issuer just issued it.
          const renewed = await renewClientCredentials(ctx, {
            ...input,
            credentialRef,
          });
          credentialRef = renewed.credentialRef;
          expiresAt = renewed.expiresAt;
          permissions = renewed.permissions;
        } else {
          const granted = await grantClientCredentials(ctx, input);
          expiresAt = granted.expiresAt;
          permissions = granted.permissions;
          credentialRef = await ctx.environment.credentials.store(
            input.scope,
            granted.material,
            expiresAt !== undefined ? { expiresAt } : {},
          );
        }
        return {
          state: "complete",
          claims: [
            acceptedClaim(ctx, entry, context.server.issuer, {
              requested: permissions?.requested ?? input.scopes,
              reported: permissions?.reported ?? [],
              ...(expiresAt !== undefined ? { validUntil: expiresAt } : {}),
            }),
          ],
          credentialRef,
          adapterState: {
            mode: auth.mode,
            ...(expiresAt !== undefined ? { expiresAt } : {}),
          },
        };
      }
      const ref = ctx.connection?.credentialRef;
      if (!ref)
        return { state: "pending", claims: [], code: "catalog.no-credential" };
      const scope = scopeFor(ctx);
      // A token that is about to expire is refreshed before it is checked,
      // so verification reports the grant, not the clock.
      if (auth.mode === "oauth2-authorization-code")
        await ensureFresh(ctx, entry, values, scope, ref);
      const outcome = await probe(ctx, entry, values, scope, ref);
      if (outcome === "rejected")
        return { state: "denied", claims: [], code: "credential.rejected" };
      if (outcome !== "accepted")
        return { state: "pending", claims: [], code: "catalog.no-verifier" };
      return {
        state: "complete",
        claims: [
          acceptedClaim(
            ctx,
            entry,
            proxyTarget(ctx, entry, values).base.origin,
          ),
        ],
      };
    },

    async invoke(
      ctx: AdapterCallContext,
      request: InvokeRequest,
    ): Promise<InvokeResult> {
      const bound = boundOperation(ctx.binding, request.operationRef);
      if (!bound || bound.transport.kind !== "http")
        throw new ConnectorError("not-found", {
          detail: "catalog.operation-not-bound",
        });
      const method = bound.transport.method as ProxyMethod;
      if (
        !(PROXY_METHODS as readonly string[]).includes(method) ||
        bound.nativeId !== proxyNativeId(method)
      )
        throw new ConnectorError("conflict", {
          detail: "catalog.operation-mismatch",
        });
      const entry = entryFor(ctx);
      if (entry.auth.mode === "unsupported")
        throw new ConnectorError("unsupported", {
          detail: "catalog.auth-mode.unsupported",
        });
      const { values, missing } = await connectionValues(ctx, entry);
      if (missing.length)
        throw new ConnectorError("configuration-required", {
          detail: "catalog.connection-config.missing",
        });
      const parsedInput = proxyInputSchema.safeParse(request.input ?? {});
      if (!parsedInput.success)
        throw new ConnectorError("invalid-request", {
          detail: "catalog.proxy.input",
        });
      const input = parsedInput.data;
      if (method === "GET" && input.body !== undefined)
        throw new ConnectorError("invalid-request", {
          detail: "catalog.proxy.body-on-get",
        });
      const { base, destination } = proxyTarget(
        ctx,
        entry,
        values,
        destinationFor(ctx.binding, bound),
      );
      const url = proxyUrl(base, destination, input.path);
      for (const [name, value] of Object.entries(input.query ?? {}))
        url.searchParams.append(name, String(value));
      const headers = defaultHeaders(entry, values);
      headers.set("accept", "application/json");
      let body: string | undefined;
      if (input.body !== undefined) {
        body = JSON.stringify(input.body);
        if (Buffer.byteLength(body) > maxResponseBytes)
          throw new ConnectorError("invalid-request", {
            detail: "catalog.proxy.body-too-large",
          });
        headers.set("content-type", "application/json");
      }

      const scope = entry.auth.mode === "none" ? undefined : scopeFor(ctx);
      const ref = ctx.connection?.credentialRef;
      if (scope && !ref)
        throw new ConnectorError("unauthenticated", {
          detail: "catalog.credential.missing",
        });
      // Refresh happens before the effect is journaled: a refresh that fails
      // means the request was never sent, which is a different fact from an
      // upstream call whose outcome is unknown.
      if (scope && ref) await ensureFresh(ctx, entry, values, scope, ref);

      const presented: { digest?: string } = {};
      const attempt = async (): Promise<InvokeResult> => {
        // The digest identifies "the same effect": method, destination and
        // target, body. Credentials are deliberately not part of it.
        const digest = sha256(
          canonicalConnectorJson({
            method,
            destination: destination.id,
            target: `${url.pathname}${url.search}`,
            body: body ?? null,
          }),
        );
        // A read-only read is its own entry each time; anything else is an
        // attempt at one effect, and the attempt after a refusal that never
        // applied (the 401 a renewal cures included) is the next entry of it.
        const { effectRef, prior } = await beginAttempt(
          ctx.environment.effects,
          {
            actor: ctx.actor,
            ...(ctx.connection
              ? { connectionRef: ctx.connection.connectionRef }
              : {}),
            bindingRef: ctx.binding.bindingRef,
            operation: request.operationRef,
            digest,
            ...(request.idempotencyKey &&
            bound.replay === "upstream-idempotency-key"
              ? {
                  idempotency: {
                    key: request.idempotencyKey,
                    scope: destination.id,
                  },
                }
              : {}),
            commandId: request.commandId,
          },
          {
            mode:
              bound.replay === "read-only" ? "each-request" : "until-applied",
            random: ctx.environment.random,
          },
        );
        if (prior)
          return {
            state:
              prior.status === "applied" || prior.status === "reconciled"
                ? "complete"
                : prior.status === "indeterminate"
                  ? "indeterminate"
                  : "failed",
            outputClassification: bound.outputClassification,
            effect: bound.effect,
            ...(prior.code ? { code: prior.code } : {}),
            effectRef,
          };
        if (
          request.idempotencyKey &&
          bound.replay === "upstream-idempotency-key"
        )
          headers.set("idempotency-key", request.idempotencyKey);

        const finish = async (
          status: "applied" | "not-applied" | "failed" | "indeterminate",
          code?: string,
        ) =>
          ctx.environment.effects.complete(effectRef, {
            status,
            ...(code ? { code } : {}),
            at: ctx.environment.now(),
          });
        const outcome = (
          state: InvokeResult["state"],
          extra: Partial<InvokeResult> = {},
        ): InvokeResult => ({
          state,
          outputClassification: bound.outputClassification,
          effect: bound.effect,
          effectRef,
          ...extra,
        });

        try {
          return await send(
            ctx,
            entry,
            { method, url, headers, ...(body !== undefined ? { body } : {}) },
            scope,
            ref,
            async (response, secrets) => {
              const { bytes, exceeded } = await readBoundedBody(
                response,
                maxResponseBytes,
              );
              if (!response.ok) {
                const status = response.status;
                const rejected = status === 401 || status === 403;
                const code = rejected
                  ? "credential.rejected"
                  : status >= 500
                    ? "upstream-unavailable"
                    : "upstream-rejected";
                await finish(
                  status >= 500 ? "indeterminate" : "not-applied",
                  code,
                );
                // An error body can quote the request back, credential and all;
                // only the status leaves.
                return outcome(
                  status >= 500 && bound.effect !== "read"
                    ? "indeterminate"
                    : "failed",
                  { code, output: { status } },
                );
              }
              await finish(
                "applied",
                exceeded ? "catalog.response-too-large" : undefined,
              );
              if (exceeded)
                return outcome("failed", {
                  code: "catalog.response-too-large",
                  output: { status: response.status },
                });
              const contentType = response.headers.get("content-type");
              let payload: unknown;
              if (bytes.byteLength && responseIsJson(contentType)) {
                try {
                  payload = JSON.parse(
                    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
                  );
                } catch {
                  return outcome("failed", {
                    code: "catalog.response-not-json",
                    output: { status: response.status },
                  });
                }
              } else if (bytes.byteLength && /^text\//i.test(contentType ?? ""))
                payload = new TextDecoder("utf-8").decode(bytes);
              return outcome("complete", {
                output: redact(
                  {
                    status: response.status,
                    ...(payload !== undefined ? { body: payload } : {}),
                    ...(payload === undefined && bytes.byteLength
                      ? { bodyOmitted: "not-json-or-text" }
                      : {}),
                  },
                  secrets,
                ),
              });
            },
            presented,
          );
        } catch (error) {
          if (error instanceof ConnectorError) {
            await finish("not-applied", error.detail ?? error.code).catch(
              () => {},
            );
            throw error;
          }
          // No response: a write may still have landed upstream.
          const lost = bound.effect !== "read";
          await finish(
            lost ? "indeterminate" : "not-applied",
            "upstream-unavailable",
          );
          return outcome(lost ? "indeterminate" : "failed", {
            code: "upstream-unavailable",
          });
        }
      };

      const first = await attempt();
      const refused = presented.digest;
      if (first.code !== "credential.rejected" || !scope || !ref || !refused)
        return first;
      let renewed: boolean;
      try {
        renewed = await renewRefused(ctx, entry, values, scope, ref, refused);
      } catch {
        // The renewal's own code stays in the journal it wrote.
        return { ...first, code: "catalog.credential-renewal-failed" };
      }
      return renewed ? attempt() : first;
    },

    async disconnect(
      _ctx: AdapterCallContext,
      scope: "local" | "broker" | "upstream",
    ): Promise<DisconnectResult> {
      // Local custody is released by the command layer; a catalog entry names
      // no unlink endpoint, so nothing upstream is attempted or claimed.
      return {
        local: scope === "local" ? "applied" : "not-attempted",
        broker: "unsupported",
        upstream: "unsupported",
      };
    },

    async revoke(): Promise<DisconnectResult> {
      return {
        local: "not-attempted",
        broker: "unsupported",
        upstream: "unsupported",
      };
    },
  };
  return adapter;
}

export type ProviderCatalogRegistration = {
  /** Catalog entries the host vouches for; each becomes its own connector. */
  entries?: readonly (ProviderCatalogEntryInput | ProviderCatalogEntry)[];
  /** A Nango providers.yaml (or its JSON form); every provider in it becomes a connector. */
  nangoYaml?: string;
  /** Import only these Nango provider keys. */
  only?: readonly string[];
  /** Loopback fixtures only; see `CatalogHttpAdapterOptions.allowLoopbackHttp`. */
  allowLoopbackHttp?: boolean;
};

/**
 * One pinned adapter per host-registered provider. A described-only provider
 * is still registered, labelled `catalog-only` with its reason, so the
 * directory shows it honestly instead of hiding it. Each is a draft until a
 * reviewer approves a binding; registering it approves nothing.
 */
export function createProviderCatalogAdapters(
  registration: ProviderCatalogRegistration = {},
): ConnectorAdapter[] {
  const options = {
    allowLoopbackHttp: registration.allowLoopbackHttp ?? false,
  };
  const entries: Array<ProviderCatalogEntryInput | ProviderCatalogEntry> = [
    ...(registration.entries ?? []),
  ];
  if (registration.nangoYaml !== undefined)
    entries.push(
      ...importNangoProviders(registration.nangoYaml, {
        ...options,
        ...(registration.only ? { only: registration.only } : {}),
      }).providers.map((item) => item.entry),
    );
  return entries.map((entry) =>
    createCatalogHttpAdapter({ ...options, entry }),
  );
}

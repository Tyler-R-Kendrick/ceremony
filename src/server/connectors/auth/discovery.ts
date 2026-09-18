import * as oauth from "oauth4webapi";
import { ConnectorError } from "../errors.js";
import {
  allowedScheme,
  assertIssuerIdentifier,
  type IssuerPolicy,
} from "./policy.js";
import { boundedSignal, DEFAULT_TIMEOUT_MS } from "./wire.js";

/*
 * Discovery reads what an issuer or a resource publishes about itself and
 * decides how far that document may be trusted. Two rules do most of the work:
 * the `issuer` (or `resource`) inside the document must be byte-for-byte the
 * identifier the host configured, never a normalized or "close enough" form
 * (RFC 8414 §3.3, RFC 9728 §3.3, OpenID Discovery §4.3); and an endpoint is
 * used only when the host's policy admits its origin or the issuer's own
 * verified document declared it. Missing metadata is reported as missing, so
 * a caller falls back to configured endpoints deliberately and records that it
 * did, instead of guessing endpoints from an origin.
 *
 * Pinned: RFC 8414, RFC 9728, OpenID Connect Discovery 1.0, and the MCP
 * 2026-07-28 authorization specification's discovery order (path insertion
 * before path appending).
 */

export type MetadataDocumentKind =
  "oauth-authorization-server" | "openid-configuration";

export type DiscoveryOptions = {
  fetch: typeof fetch;
  allowLoopbackHttp?: boolean | undefined;
  signal?: AbortSignal | undefined;
  now?: (() => number) | undefined;
  /** Entries are keyed by tenant and issuer; two tenants never share one. */
  cache?: MetadataCache | undefined;
  tenantId?: string | undefined;
  /** Cache lifetime for a discovered document; clamped to [1 minute, 24 hours]. */
  ttlMs?: number | undefined;
  maxBytes?: number | undefined;
  timeoutMs?: number | undefined;
};

export type UnavailableReason = "not-found" | "network" | "malformed";

export type AuthorizationServerDiscovery =
  | {
      state: "discovered";
      issuer: string;
      metadata: oauth.AuthorizationServer;
      document: MetadataDocumentKind;
      url: string;
      fetchedAt: number;
      expiresAt: number;
      fromCache: boolean;
    }
  | {
      state: "unavailable";
      issuer: string;
      reason: UnavailableReason;
      retryable: boolean;
      attempted: string[];
    };

export type ProtectedResourceDiscovery =
  | {
      state: "discovered";
      resource: string;
      metadata: oauth.ResourceServer;
      /** Issuer identifiers the resource names, syntax-checked, not yet trusted. */
      authorizationServers: string[];
      url: string;
      fetchedAt: number;
    }
  | {
      state: "unavailable";
      resource: string;
      reason: UnavailableReason;
      retryable: boolean;
      attempted: string[];
    };

export type CachedMetadata = {
  document: MetadataDocumentKind;
  url: string;
  metadata: oauth.AuthorizationServer;
  fetchedAt: number;
  expiresAt: number;
};

export interface MetadataCache {
  get(key: string): CachedMetadata | undefined;
  set(key: string, value: CachedMetadata): void;
  delete(key: string): void;
}

const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 86_400_000;

/** A bounded in-process cache; entries expire by their own TTL and a hard ceiling. */
export function createMetadataCache(
  options: { maxEntries?: number; maxAgeMs?: number; now?: () => number } = {},
): MetadataCache & { readonly size: number } {
  const now = options.now ?? Date.now;
  const maxEntries = Math.max(1, Math.min(options.maxEntries ?? 256, 4096));
  const maxAgeMs = clampTtl(options.maxAgeMs ?? MAX_TTL_MS);
  const entries = new Map<string, CachedMetadata>();
  return {
    get size() {
      return entries.size;
    },
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      // Refresh recency for the eviction order.
      entries.delete(key);
      entries.set(key, entry);
      return entry;
    },
    set(key, value) {
      const expiresAt = Math.min(value.expiresAt, value.fetchedAt + maxAgeMs);
      entries.delete(key);
      entries.set(key, { ...value, expiresAt });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    delete(key) {
      entries.delete(key);
    },
  };
}

function clampTtl(value: number): number {
  if (!Number.isFinite(value)) return MIN_TTL_MS;
  return Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, value));
}

export function metadataCacheKey(
  tenantId: string | undefined,
  issuer: string,
): string {
  return `${tenantId ?? ""}#${tenantId?.length ?? 0}#${issuer}`;
}

/**
 * Where an issuer's metadata may live, in the order the MCP authorization
 * specification prescribes: RFC 8414 path insertion, OpenID path insertion,
 * then OpenID path appending; an issuer without a path has only the first two.
 */
export function metadataCandidates(
  issuer: URL,
): Array<{ document: MetadataDocumentKind; url: string }> {
  const path = issuer.pathname.replace(/\/$/, "");
  const origin = issuer.origin;
  if (path === "")
    return [
      {
        document: "oauth-authorization-server",
        url: `${origin}/.well-known/oauth-authorization-server`,
      },
      {
        document: "openid-configuration",
        url: `${origin}/.well-known/openid-configuration`,
      },
    ];
  return [
    {
      document: "oauth-authorization-server",
      url: `${origin}/.well-known/oauth-authorization-server${path}`,
    },
    {
      document: "openid-configuration",
      url: `${origin}/.well-known/openid-configuration${path}`,
    },
    {
      document: "openid-configuration",
      url: `${origin}${path}/.well-known/openid-configuration`,
    },
  ];
}

/** RFC 9728 §3.1: the well-known segment is inserted between host and path; a terminating slash is kept. */
export function protectedResourceMetadataUrl(resource: URL): string {
  if (resource.pathname === "/")
    return `${resource.origin}/.well-known/oauth-protected-resource`;
  return `${resource.origin}/.well-known/oauth-protected-resource${resource.pathname}`;
}

/** The `resource_metadata` parameter of a Bearer challenge (RFC 9728 §5.1), if present and well-formed. */
export function resourceMetadataFromChallenge(
  header: string | null | undefined,
): string | undefined {
  if (!header) return undefined;
  const match = /(?:^|[\s,])resource_metadata="([^"\\]{1,2048})"/.exec(header);
  const value = match?.[1];
  if (!value || !URL.canParse(value)) return undefined;
  return value;
}

type FetchedDocument =
  | { status: "ok"; text: string; json: Record<string, unknown> }
  | { status: "not-found" }
  | { status: "server-error" }
  | { status: "network" }
  | { status: "malformed" };

async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchJsonDocument(
  url: string,
  options: DiscoveryOptions,
): Promise<FetchedDocument> {
  const target = new URL(url);
  if (!allowedScheme(target, options.allowLoopbackHttp === true))
    throw new ConnectorError("network-policy", {
      detail: "oauth.metadata.scheme",
    });
  let response: Response;
  try {
    response = await options.fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: boundedSignal(
        options.signal,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ),
    });
  } catch (error) {
    if (options.signal?.aborted)
      throw new ConnectorError("cancelled", { cause: error });
    return { status: "network" };
  }
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel();
    return { status: "not-found" };
  }
  if (response.status === 429 || response.status >= 500) {
    await response.body?.cancel();
    return { status: "server-error" };
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    return { status: "malformed" };
  }
  const type = response.headers.get("content-type") ?? "";
  if (!/^application\/([a-z0-9.+-]+\+)?json\b/i.test(type.trim())) {
    await response.body?.cancel();
    return { status: "malformed" };
  }
  const text = await readBounded(response, options.maxBytes ?? 65_536);
  if (text === undefined) return { status: "malformed" };
  try {
    const json: unknown = JSON.parse(text);
    if (!json || typeof json !== "object" || Array.isArray(json))
      return { status: "malformed" };
    if (
      ["__proto__", "constructor", "prototype"].some((key) =>
        Object.hasOwn(json, key),
      )
    )
      return { status: "malformed" };
    return { status: "ok", text, json: json as Record<string, unknown> };
  } catch {
    return { status: "malformed" };
  }
}

/**
 * Authorization server metadata for one issuer. The document's `issuer` must
 * equal the configured identifier exactly; a document that names any other
 * issuer is refused, not adapted (issuer mix-up). Absence of metadata is a
 * result, not an error, so a caller can fall back to configured endpoints on
 * purpose and record that it did.
 */
export async function discoverAuthorizationServer(
  issuer: string,
  options: DiscoveryOptions,
): Promise<AuthorizationServerDiscovery> {
  const allowLoopbackHttp = options.allowLoopbackHttp === true;
  const issuerUrl = assertIssuerIdentifier(issuer, allowLoopbackHttp);
  const now = options.now ?? Date.now;
  const key = metadataCacheKey(options.tenantId, issuer);
  const cached = options.cache?.get(key);
  if (cached && cached.expiresAt > now())
    return {
      state: "discovered",
      issuer,
      metadata: cached.metadata,
      document: cached.document,
      url: cached.url,
      fetchedAt: cached.fetchedAt,
      expiresAt: cached.expiresAt,
      fromCache: true,
    };
  const attempted: string[] = [];
  let retryable = false;
  let malformed = false;
  for (const candidate of metadataCandidates(issuerUrl)) {
    attempted.push(candidate.url);
    const fetched = await fetchJsonDocument(candidate.url, options);
    if (fetched.status === "not-found") continue;
    if (fetched.status === "network" || fetched.status === "server-error") {
      retryable = true;
      continue;
    }
    if (fetched.status === "malformed") {
      malformed = true;
      continue;
    }
    // Exact comparison, as the protocol requires: no trailing-slash tolerance,
    // no case folding, no percent-decoding. Display canonicalization is a
    // different job and never weakens this check.
    if (fetched.json["issuer"] !== issuer)
      throw new ConnectorError("network-policy", {
        detail: "oauth.metadata.issuer-mismatch",
      });
    let metadata: oauth.AuthorizationServer;
    try {
      metadata = await oauth.processDiscoveryResponse(
        new URL(issuer),
        new Response(fetched.text, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    } catch {
      malformed = true;
      continue;
    }
    const fetchedAt = now();
    const expiresAt = fetchedAt + clampTtl(options.ttlMs ?? 3_600_000);
    options.cache?.set(key, {
      document: candidate.document,
      url: candidate.url,
      metadata,
      fetchedAt,
      expiresAt,
    });
    return {
      state: "discovered",
      issuer,
      metadata,
      document: candidate.document,
      url: candidate.url,
      fetchedAt,
      expiresAt,
      fromCache: false,
    };
  }
  return {
    state: "unavailable",
    issuer,
    reason: retryable ? "network" : malformed ? "malformed" : "not-found",
    retryable,
    attempted,
  };
}

/**
 * Protected resource metadata (RFC 9728). The `resource` value in the document
 * must equal the resource identifier exactly, which is what binds a document
 * found through a challenge hint to the resource that was actually contacted.
 */
export async function discoverProtectedResource(
  resource: string,
  options: DiscoveryOptions & { metadataUrl?: string | undefined },
): Promise<ProtectedResourceDiscovery> {
  const allowLoopbackHttp = options.allowLoopbackHttp === true;
  if (!URL.canParse(resource))
    throw new ConnectorError("invalid-request", {
      detail: "oauth.resource.invalid",
    });
  const resourceUrl = new URL(resource);
  if (
    resourceUrl.username ||
    resourceUrl.password ||
    resourceUrl.hash ||
    resourceUrl.search
  )
    throw new ConnectorError("invalid-request", {
      detail: "oauth.resource.invalid",
    });
  if (!allowedScheme(resourceUrl, allowLoopbackHttp))
    throw new ConnectorError("network-policy", {
      detail: "oauth.resource.scheme",
    });
  const candidates: string[] = [];
  if (options.metadataUrl !== undefined) {
    if (!URL.canParse(options.metadataUrl))
      throw new ConnectorError("invalid-request", {
        detail: "oauth.resource-metadata.invalid",
      });
    const hinted = new URL(options.metadataUrl);
    if (hinted.username || hinted.password || hinted.hash)
      throw new ConnectorError("invalid-request", {
        detail: "oauth.resource-metadata.invalid",
      });
    if (!allowedScheme(hinted, allowLoopbackHttp))
      throw new ConnectorError("network-policy", {
        detail: "oauth.resource-metadata.scheme",
      });
    candidates.push(hinted.href);
  } else candidates.push(protectedResourceMetadataUrl(resourceUrl));
  const now = options.now ?? Date.now;
  const attempted: string[] = [];
  let retryable = false;
  let malformed = false;
  for (const url of candidates) {
    attempted.push(url);
    const fetched = await fetchJsonDocument(url, options);
    if (fetched.status === "not-found") continue;
    if (fetched.status === "network" || fetched.status === "server-error") {
      retryable = true;
      continue;
    }
    if (fetched.status === "malformed") {
      malformed = true;
      continue;
    }
    if (fetched.json["resource"] !== resource)
      throw new ConnectorError("network-policy", {
        detail: "oauth.resource-metadata.resource-mismatch",
      });
    let metadata: oauth.ResourceServer;
    try {
      metadata = await oauth.processResourceDiscoveryResponse(
        resourceUrl,
        new Response(fetched.text, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    } catch {
      malformed = true;
      continue;
    }
    const authorizationServers: string[] = [];
    for (const server of metadata.authorization_servers ?? []) {
      if (typeof server !== "string" || !URL.canParse(server)) continue;
      const serverUrl = new URL(server);
      if (
        serverUrl.username ||
        serverUrl.password ||
        serverUrl.search ||
        serverUrl.hash ||
        !allowedScheme(serverUrl, allowLoopbackHttp)
      )
        continue;
      authorizationServers.push(server);
    }
    return {
      state: "discovered",
      resource,
      metadata,
      authorizationServers: authorizationServers.slice(0, 8),
      url,
      fetchedAt: now(),
    };
  }
  return {
    state: "unavailable",
    resource,
    reason: retryable ? "network" : malformed ? "malformed" : "not-found",
    retryable,
    attempted,
  };
}

export const endpointRoles = [
  "authorization",
  "token",
  "device-authorization",
  "jwks",
  "registration",
  "pushed-authorization",
  "introspection",
  "revocation",
  "userinfo",
] as const;
export type EndpointRole = (typeof endpointRoles)[number];
export type EndpointDeclaration = "issuer-metadata" | "configured";

const metadataKeys: Record<EndpointRole, string> = {
  authorization: "authorization_endpoint",
  token: "token_endpoint",
  "device-authorization": "device_authorization_endpoint",
  jwks: "jwks_uri",
  registration: "registration_endpoint",
  "pushed-authorization": "pushed_authorization_request_endpoint",
  introspection: "introspection_endpoint",
  revocation: "revocation_endpoint",
  userinfo: "userinfo_endpoint",
};
const configuredKeys: Record<
  EndpointRole,
  keyof IssuerPolicy["endpoints"] | undefined
> = {
  authorization: "authorization",
  token: "token",
  "device-authorization": "deviceAuthorization",
  jwks: "jwks",
  registration: "registration",
  "pushed-authorization": "pushedAuthorization",
  introspection: "introspection",
  revocation: "revocation",
  userinfo: undefined,
};

/**
 * Whether one endpoint may be contacted for this issuer. Same origin as the
 * issuer is accepted; a host-listed origin is accepted; an origin the issuer's
 * own verified metadata declared is accepted when policy says so, except for
 * registration, which creates clients and must sit on the issuer's origin or
 * on a listed one (AC-AUTH-17). A configured endpoint on a foreign origin that
 * nothing declared is refused. The value is returned verbatim.
 */
export function trustedEndpoint(
  role: EndpointRole,
  value: string | undefined,
  input: {
    issuer: string;
    declaredBy: EndpointDeclaration;
    policy: Pick<
      IssuerPolicy,
      "trustedOrigins" | "acceptIssuerDeclaredOrigins" | "allowLoopbackHttp"
    >;
  },
): string | undefined {
  if (value === undefined) return undefined;
  const refuse = (reason: string): never => {
    throw new ConnectorError("network-policy", {
      detail: `oauth.endpoint.${role}.${reason}`,
    });
  };
  if (typeof value !== "string" || !URL.canParse(value))
    return refuse("invalid");
  const url = new URL(value);
  if (url.username || url.password || url.hash) return refuse("invalid");
  if (!allowedScheme(url, input.policy.allowLoopbackHttp))
    return refuse("scheme");
  const issuerOrigin = new URL(input.issuer).origin;
  if (url.origin === issuerOrigin) return value;
  if (input.policy.trustedOrigins.includes(url.origin)) return value;
  if (
    input.declaredBy === "issuer-metadata" &&
    input.policy.acceptIssuerDeclaredOrigins &&
    role !== "registration"
  )
    return value;
  return refuse("foreign-origin");
}

export type ResolvedAuthorizationServer = {
  issuer: string;
  /** Endpoints here have passed the trust rules; refused ones are absent. */
  metadata: oauth.AuthorizationServer;
  source: "discovery" | "configured";
  discovery:
    AuthorizationServerDiscovery | { state: "disabled"; issuer: string };
  /** Endpoints removed from the document by the trust rules, by role and reason. */
  refused: Array<{ role: EndpointRole; detail: string }>;
  allowLoopbackHttp: boolean;
};

/**
 * Discovery plus policy: the server description every other function here
 * takes. Discovered endpoints must agree with any the host configured; a host
 * that pins the token endpoint and an issuer that publishes a different one
 * is a conflict to refuse, not a choice to make. Without discovery, configured
 * endpoints are used and the result says so.
 */
export async function resolveAuthorizationServer(
  policy: IssuerPolicy,
  options: Omit<DiscoveryOptions, "allowLoopbackHttp">,
): Promise<ResolvedAuthorizationServer> {
  assertIssuerIdentifier(policy.issuer, policy.allowLoopbackHttp);
  const discovery: ResolvedAuthorizationServer["discovery"] =
    policy.discovery === "disabled"
      ? { state: "disabled", issuer: policy.issuer }
      : await discoverAuthorizationServer(policy.issuer, {
          ...options,
          allowLoopbackHttp: policy.allowLoopbackHttp,
        });
  if (discovery.state === "unavailable" && policy.discovery === "required") {
    if (discovery.retryable)
      throw new ConnectorError("upstream-unavailable", {
        detail: "oauth.discovery.unavailable",
      });
    throw new ConnectorError("configuration-required", {
      detail:
        discovery.reason === "malformed"
          ? "oauth.discovery.malformed"
          : "oauth.discovery.not-found",
    });
  }
  const discovered =
    discovery.state === "discovered" ? discovery.metadata : undefined;
  const document: Record<string, unknown> = discovered ? { ...discovered } : {};
  document["issuer"] = policy.issuer;
  const refused: ResolvedAuthorizationServer["refused"] = [];
  for (const role of endpointRoles) {
    const key = metadataKeys[role];
    const configuredKey = configuredKeys[role];
    const fromDiscovery = discovered?.[key];
    const configured =
      configuredKey === undefined ? undefined : policy.endpoints[configuredKey];
    if (fromDiscovery !== undefined && typeof fromDiscovery !== "string")
      throw new ConnectorError("upstream-rejected", {
        detail: `oauth.endpoint.${role}.invalid`,
      });
    if (
      fromDiscovery !== undefined &&
      configured !== undefined &&
      fromDiscovery !== configured
    )
      throw new ConnectorError("network-policy", {
        detail: `oauth.endpoint.${role}.conflict`,
      });
    const candidate = fromDiscovery ?? configured;
    const declaredBy: EndpointDeclaration =
      fromDiscovery !== undefined ? "issuer-metadata" : "configured";
    delete document[key];
    if (candidate === undefined) continue;
    try {
      document[key] = trustedEndpoint(role, candidate, {
        issuer: policy.issuer,
        declaredBy,
        policy,
      });
    } catch (error) {
      if (!(error instanceof ConnectorError)) throw error;
      if (role === "authorization" || role === "token") throw error;
      refused.push({ role, detail: error.detail ?? "oauth.endpoint.refused" });
    }
  }
  if (
    document["authorization_endpoint"] === undefined &&
    document["token_endpoint"] === undefined &&
    document["device_authorization_endpoint"] === undefined
  )
    throw new ConnectorError("configuration-required", {
      detail: "oauth.endpoints.unknown",
    });
  return {
    issuer: policy.issuer,
    metadata: document as unknown as oauth.AuthorizationServer,
    source: discovered ? "discovery" : "configured",
    discovery,
    refused,
    allowLoopbackHttp: policy.allowLoopbackHttp,
  };
}

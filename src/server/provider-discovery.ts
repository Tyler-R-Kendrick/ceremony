import { z } from "zod";
import type { FlowKind } from "../core/schema.js";

import { publicNativeClients } from "./oauth-public-clients.js";
import { boundedText } from "./authorization.js";
import { loopbackAuthFetch, publicAuthFetch } from "./public-auth-fetch.js";

const wellKnown = [
  "/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-client",
  "/auth.md",
  "/openapi.json",
] as const;

export type DiscoveredAuth = {
  origin: string;
  documents: string[];
  methods: FlowKind[];
  openApiUrl?: string;
  searchUsed: boolean;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userinfoEndpoint?: string;
  revocationEndpoint?: string;
  deviceAuthorizationEndpoint?: string;
  registrationEndpoint?: string;
  clientId?: string;
  scopes?: string[];
  grantTypes: string[];
  issuer?: string;
  pushedAuthorizationRequestEndpoint?: string;
  requirePushedAuthorizationRequests?: boolean;
  clientIdMetadataDocumentSupported?: boolean;
  dpopRequired?: boolean;
  dpopSigningAlgorithms?: string[];
  assumed?: boolean;
  candidates?: string[];
  codeChallengeMethods?: string[];
  /** Metadata was unavailable, not evidence that the provider lacks OAuth. */
  retryable?: boolean;
};

export type ProviderSearch = (
  query: string,
) => Promise<Array<{ title: string; url: string }>>;

function publicOrigin(
  value: string,
  allowLoopback = false,
): string | undefined {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return;
    if (url.protocol === "https:") return url.origin;
    if (
      allowLoopback &&
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
      return url.origin;
  } catch {
    /* Invalid URL is not a crawl target. */
  }
}

export async function readAuthResponse(
  fetcher: typeof fetch,
  url: string,
  headers: HeadersInit = {
    accept: "application/json, text/plain, text/markdown",
  },
): Promise<{ status: number; type: string; body: string } | undefined> {
  for (let attempt = 0; attempt < 2; attempt++)
    try {
      const response = await fetcher(url, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
        headers,
      });
      const type = response.headers.get("content-type") ?? "";
      if (
        attempt === 0 &&
        (response.status === 429 || response.status >= 500)
      ) {
        const retry = response.headers.get("retry-after");
        const delay =
          retry === null
            ? 250
            : /^\d+$/.test(retry)
              ? Number(retry) * 1000
              : Date.parse(retry) - Date.now();
        // Long provider backoffs belong to a later human retry, not a blocked request.
        if (Number.isFinite(delay) && delay <= 1000) {
          await response.body?.cancel();
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, delay)),
          );
          continue;
        }
      }
      const body = await boundedText(response, 32_768);
      return { status: response.status, type, body };
    } catch {
      if (attempt === 0)
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
}

function httpsEndpoint(
  value: unknown,
  allowLoopback = false,
): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return;
    if (url.protocol === "https:") return url.href;
    if (
      allowLoopback &&
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
      return url.href;
  } catch {
    return;
  }
}

function endpointsFromMetadata(
  body: string,
  allowLoopback = false,
): Pick<
  DiscoveredAuth,
  | "methods"
  | "authorizationEndpoint"
  | "tokenEndpoint"
  | "userinfoEndpoint"
  | "revocationEndpoint"
  | "deviceAuthorizationEndpoint"
  | "registrationEndpoint"
  | "clientId"
  | "scopes"
  | "grantTypes"
  | "issuer"
  | "pushedAuthorizationRequestEndpoint"
  | "requirePushedAuthorizationRequests"
  | "clientIdMetadataDocumentSupported"
  | "dpopRequired"
  | "dpopSigningAlgorithms"
  | "codeChallengeMethods"
> {
  const kinds = new Set<FlowKind>();
  const grantTypes: string[] = [];
  try {
    const json = z
      .object({
        grant_types_supported: z.array(z.string()).max(32).default([]),
        authorization_endpoint: z.string().optional(),
        token_endpoint: z.string().optional(),
        userinfo_endpoint: z.string().optional(),
        revocation_endpoint: z.string().optional(),
        device_authorization_endpoint: z.string().optional(),
        registration_endpoint: z.string().optional(),
        client_id: z.string().min(8).max(2048).optional(),
        public_client_id: z.string().min(8).max(2048).optional(),
        issuer: z.string().optional(),
        pushed_authorization_request_endpoint: z.string().optional(),
        require_pushed_authorization_requests: z.boolean().optional(),
        client_id_metadata_document_supported: z.boolean().optional(),
        dpop_signing_alg_values_supported: z
          .array(z.string().min(1).max(32))
          .max(32)
          .optional(),
        scopes_supported: z.array(z.string()).max(32).default([]),
        code_challenge_methods_supported: z
          .array(z.string())
          .max(16)
          .optional(),
        authorization_servers: z.array(z.string()).max(8).optional(),
        openapi: z.string().optional(),
      })
      .passthrough()
      .parse(JSON.parse(body));
    const authorizationEndpoint = httpsEndpoint(
      json.authorization_endpoint,
      allowLoopback,
    );
    const tokenEndpoint = httpsEndpoint(json.token_endpoint, allowLoopback);
    const deviceAuthorizationEndpoint = httpsEndpoint(
      json.device_authorization_endpoint,
      allowLoopback,
    );
    const userinfoEndpoint = httpsEndpoint(
      json.userinfo_endpoint,
      allowLoopback,
    );
    const revocationEndpoint = httpsEndpoint(
      json.revocation_endpoint,
      allowLoopback,
    );
    const registrationEndpoint = httpsEndpoint(
      json.registration_endpoint,
      allowLoopback,
    );
    const clientId = json.client_id ?? json.public_client_id;
    const issuer = httpsEndpoint(json.issuer, allowLoopback);
    const pushedAuthorizationRequestEndpoint = httpsEndpoint(
      json.pushed_authorization_request_endpoint,
      allowLoopback,
    );
    if (authorizationEndpoint) kinds.add("oauth-code");
    if (deviceAuthorizationEndpoint) kinds.add("device");
    if (json.grant_types_supported.includes("password") && tokenEndpoint)
      kinds.add("form");
    grantTypes.push(...json.grant_types_supported);
    return {
      methods: [...kinds],
      grantTypes,
      ...(json.code_challenge_methods_supported
        ? { codeChallengeMethods: json.code_challenge_methods_supported }
        : {}),
      ...(authorizationEndpoint ? { authorizationEndpoint } : {}),
      ...(tokenEndpoint ? { tokenEndpoint } : {}),
      ...(userinfoEndpoint ? { userinfoEndpoint } : {}),
      ...(revocationEndpoint ? { revocationEndpoint } : {}),
      ...(deviceAuthorizationEndpoint ? { deviceAuthorizationEndpoint } : {}),
      ...(registrationEndpoint ? { registrationEndpoint } : {}),
      ...(clientId ? { clientId } : {}),
      ...(issuer ? { issuer } : {}),
      ...(pushedAuthorizationRequestEndpoint
        ? { pushedAuthorizationRequestEndpoint }
        : {}),
      ...(json.require_pushed_authorization_requests
        ? { requirePushedAuthorizationRequests: true }
        : {}),
      ...(json.client_id_metadata_document_supported
        ? { clientIdMetadataDocumentSupported: true }
        : {}),
      ...(json.dpop_signing_alg_values_supported
        ? { dpopSigningAlgorithms: json.dpop_signing_alg_values_supported }
        : {}),
      ...(json.scopes_supported.length
        ? { scopes: json.scopes_supported.slice(0, 16) }
        : {}),
    };
  } catch {
    const lower = body.toLowerCase();
    if (lower.includes("anonymous") && lower.includes("claim"))
      kinds.add("authmd-anonymous");
    else if (lower.includes("api key") || lower.includes("api-key"))
      kinds.add("api-key");
    return { methods: [...kinds], grantTypes };
  }
}

function validatedMetadata(
  body: string,
  authority: string,
  allowLoopback: boolean,
) {
  const parsed = endpointsFromMetadata(body, allowLoopback);
  if (
    parsed.issuer &&
    parsed.issuer !== authority &&
    parsed.issuer !== `${authority}/`
  )
    return undefined;
  return parsed;
}

/** Combine documents from one issuer, preserving first endpoint values. */
function mergeMetadata(
  found: DiscoveredAuth,
  parsed: ReturnType<typeof endpointsFromMetadata>,
): DiscoveredAuth {
  const {
    methods,
    grantTypes,
    requirePushedAuthorizationRequests,
    clientIdMetadataDocumentSupported,
    dpopRequired,
    ...fields
  } = parsed;
  return {
    ...fields,
    ...found,
    methods: [...new Set([...found.methods, ...methods])],
    grantTypes: [...new Set([...found.grantTypes, ...grantTypes])],
    ...(found.requirePushedAuthorizationRequests ||
    requirePushedAuthorizationRequests
      ? { requirePushedAuthorizationRequests: true }
      : {}),
    ...(found.clientIdMetadataDocumentSupported ||
    clientIdMetadataDocumentSupported
      ? { clientIdMetadataDocumentSupported: true }
      : {}),
    ...(found.dpopRequired || dpopRequired ? { dpopRequired: true } : {}),
  };
}

async function delegatedAuth(
  origin: string,
  servers: string[],
  fetcher: typeof fetch,
  allowLoopback: boolean,
): Promise<DiscoveredAuth> {
  const unavailable = emptyDiscovery(origin, false);
  for (const server of servers.slice(0, 2)) {
    const base = publicOrigin(server, allowLoopback);
    if (!base || server === origin) continue;
    const issuer = new URL(server);
    const authority = issuer.href;
    const issuerPath = issuer.pathname === "/" ? "" : issuer.pathname;
    const oauthMetadata = await readAuthResponse(
      fetcher,
      `${base}/.well-known/oauth-authorization-server${issuerPath}`,
    );
    const response =
      oauthMetadata?.status === 200
        ? oauthMetadata
        : await readAuthResponse(
            fetcher,
            `${authority.replace(/\/$/, "")}/.well-known/openid-configuration`,
          );
    if (!response || response.status === 429 || response.status >= 500)
      unavailable.retryable = true;
    if (!response || response.status !== 200) continue;
    const parsed = validatedMetadata(response.body, authority, allowLoopback);
    if (
      !parsed ||
      (!parsed.authorizationEndpoint && !parsed.deviceAuthorizationEndpoint)
    )
      continue;
    return {
      ...parsed,
      issuer: parsed.issuer ?? authority,
      origin,
      documents: [authority],
      searchUsed: false,
    };
  }
  return unavailable;
}

/** Bounded well-known crawl. Each selected OAuth flow belongs to one issuer. */
async function crawlOrigin(
  origin: string,
  fetcher: typeof fetch,
  allowLoopback = false,
): Promise<DiscoveredAuth> {
  let found = emptyDiscovery(origin, false);
  let openApiUrl: string | undefined;
  const responses = await Promise.all(
    wellKnown.map(
      async (path) =>
        [path, await readAuthResponse(fetcher, `${origin}${path}`)] as const,
    ),
  );
  const servers: string[] = [];
  for (const [path, response] of responses) {
    if (!response || response.status !== 200) continue;
    const jsonDoc = path.startsWith("/.well-known/");
    if (
      jsonDoc &&
      !response.type.includes("json") &&
      !response.body.trim().startsWith("{")
    )
      continue;
    found.documents.push(path);
    if (
      path === "/openapi.json" &&
      origin.startsWith("https:") &&
      response.body.includes('"openapi"')
    )
      openApiUrl = `${origin}${path}`;
    const parsed = validatedMetadata(response.body, origin, allowLoopback);
    if (!parsed) continue;
    found = mergeMetadata(found, parsed);
    if (path === "/.well-known/oauth-protected-resource") {
      try {
        const resource = z
          .object({
            authorization_servers: z.array(z.string()).max(8).optional(),
          })
          .parse(JSON.parse(response.body));
        servers.push(...(resource.authorization_servers ?? []));
      } catch {
        /* Invalid resource metadata does not grant delegation. */
      }
    }
  }
  if (!found.authorizationEndpoint && !found.deviceAuthorizationEndpoint) {
    const delegated = await delegatedAuth(
      origin,
      servers,
      fetcher,
      allowLoopback,
    );
    // Never blend a resource's token/client settings into another authorization server.
    if (
      delegated.authorizationEndpoint ||
      delegated.deviceAuthorizationEndpoint
    )
      found = {
        ...delegated,
        documents: [...found.documents, ...delegated.documents],
      };
    else if (delegated.retryable) found.retryable = true;
  }
  if (
    responses.some(
      ([, response]) =>
        !response || response.status === 429 || response.status >= 500,
    )
  )
    found.retryable = true;
  if (openApiUrl) found.openApiUrl = openApiUrl;
  const native = publicNativeClients[new URL(found.issuer ?? origin).origin];
  if (found.clientId === undefined && native) found.clientId = native.clientId;
  if (!found.scopes?.length && native?.scopes) found.scopes = native.scopes;
  return found;
}

function hostnameOf(value: string) {
  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function hostsRelated(left: string, right: string) {
  if (!left || !right) return false;
  if (
    left === right ||
    left.endsWith(`.${right}`) ||
    right.endsWith(`.${left}`)
  )
    return true;
  return false;
}

export function isProviderOwnedAuth(found: {
  origin: string;
  issuer?: string | undefined;
  authorizationEndpoint?: string | undefined;
  deviceAuthorizationEndpoint?: string | undefined;
  registrationEndpoint?: string | undefined;
}) {
  if (
    !found.authorizationEndpoint &&
    !found.deviceAuthorizationEndpoint &&
    !found.registrationEndpoint
  )
    return false;
  return hostsRelated(
    hostnameOf(found.issuer ?? found.origin),
    hostnameOf(found.origin),
  );
}

function scoreDiscovery(found: DiscoveredAuth, query?: string) {
  let score = 0;
  if (found.authorizationEndpoint) score += 4;
  if (found.deviceAuthorizationEndpoint) score += 2;
  if (found.clientIdMetadataDocumentSupported) score += 3;
  if (found.registrationEndpoint) score += 3;
  if (found.clientId) score += 2;
  if (found.documents.length) score += 1;
  if (isProviderOwnedAuth(found)) score += 5;
  const host = hostnameOf(found.origin);
  const slug = query?.toLowerCase().replace(/[^a-z0-9]+/g, "") ?? "";
  if (
    slug.length >= 2 &&
    (host.includes(slug) || host.replace(/\./g, "").includes(slug))
  )
    score += 2;
  return score;
}

function emptyDiscovery(origin: string, searchUsed: boolean): DiscoveredAuth {
  return {
    origin,
    documents: [],
    methods: [],
    grantTypes: [],
    searchUsed,
  };
}

export async function discoverProviderAuth(
  origins: string[],
  options: {
    fetch?: typeof fetch;
    search?: ProviderSearch;
    query?: string;
    allowLoopbackHttp?: boolean;
    onProgress?: (text: string) => void;
  } = {},
): Promise<DiscoveredAuth> {
  const fetcher =
    options.fetch ??
    (options.allowLoopbackHttp ? loopbackAuthFetch : publicAuthFetch);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const candidate of origins) {
    const origin = publicOrigin(candidate, options.allowLoopbackHttp);
    if (!origin || seen.has(origin)) continue;
    seen.add(origin);
    unique.push(origin);
  }
  type Hit = { found: DiscoveredAuth; promise: Promise<Hit> };
  const remaining = new Set<Promise<Hit>>();
  for (const origin of unique) {
    options.onProgress?.(`Trying ${origin}`);
    let promise!: Promise<Hit>;
    promise = crawlOrigin(origin, fetcher, options.allowLoopbackHttp).then(
      (found) => {
        if (found.documents.length)
          options.onProgress?.(
            `Found ${found.documents.join(", ")} at ${origin}`,
          );
        return { found, promise };
      },
    );
    remaining.add(promise);
  }
  const ranked: DiscoveredAuth[] = [];
  let retryable = false;
  while (remaining.size) {
    const hit = await Promise.race(remaining);
    remaining.delete(hit.promise);
    retryable ||= Boolean(hit.found.retryable);
    if (hit.found.documents.length) ranked.push(hit.found);
    if (isProviderOwnedAuth(hit.found)) {
      options.onProgress?.(
        `Using ${hit.found.origin} for ${hit.found.methods.join(", ") || "auth"}`,
      );
      return hit.found;
    }
  }
  ranked.sort(
    (left, right) =>
      scoreDiscovery(right, options.query) -
      scoreDiscovery(left, options.query),
  );
  if (ranked[0]) return ranked[0];
  if (!options.search || !options.query)
    return {
      ...emptyDiscovery(unique[0] ?? "", false),
      ...(retryable ? { retryable: true } : {}),
    };
  const hits = (
    await options.search(`${options.query} OAuth OpenID well-known`)
  ).slice(0, 5);
  for (const hit of hits) {
    const origin = publicOrigin(hit.url, options.allowLoopbackHttp);
    if (!origin || seen.has(origin)) continue;
    seen.add(origin);
    const found = await crawlOrigin(origin, fetcher, options.allowLoopbackHttp);
    if (found.documents.length) return { ...found, searchUsed: true };
  }
  return emptyDiscovery(unique[0] ?? "", true);
}

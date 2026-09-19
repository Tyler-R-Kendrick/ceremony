import { z } from "zod";
import { exchange } from "./http.js";
import type { ClientRegistrationMethod, McpLimits } from "./profiles.js";

/*
 * The MCP side of authorization: reading a 401/403 challenge, locating the
 * RFC 9728 protected resource metadata and validating it against the
 * resource this binding approved. Nothing here talks to an authorization
 * server; that is the OAuth profile's job. What leaves this module is a
 * challenge description the OAuth hook can act on, with every doubt listed.
 */

export type BearerChallengeParameters = {
  realm?: string;
  scope?: string;
  error?: string;
  error_description?: string;
  resource_metadata?: string;
  [name: string]: string | undefined;
};

/**
 * Parses the `Bearer` challenge out of a `WWW-Authenticate` header
 * (RFC 9110 §11.6.1 / RFC 6750 §3). Parameters may be tokens or quoted
 * strings; names compare case-insensitively. Returns undefined when no
 * well-formed Bearer challenge is present.
 */
export function parseBearerChallenge(
  header: string | null | undefined,
): BearerChallengeParameters | undefined {
  if (!header || header.length > 8192) return undefined;
  const match = /(?:^|,)\s*Bearer(?![^\s,])\s*/i.exec(header);
  if (!match) return undefined;
  let rest = header.slice(match.index + match[0].length);
  const params: BearerChallengeParameters = {};
  const parameter =
    /^\s*([A-Za-z0-9!#$%&'*+.^_`|~-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([A-Za-z0-9!#$%&'*+.^_`|~\/=-]+))\s*(,|$)/;
  let any = false;
  for (;;) {
    const part = parameter.exec(rest);
    if (!part) break;
    any = true;
    const name = part[1]!.toLowerCase();
    const value =
      part[2] !== undefined ? part[2].replace(/\\(.)/g, "$1") : part[3]!;
    if (!(name in params)) params[name] = value;
    rest = rest.slice(part[0].length);
    if (part[4] !== ",") break;
    // A following challenge (another scheme) ends this one's parameter list.
    if (
      /^\s*[A-Za-z0-9!#$%&'*+.^_`|~-]+\s+[A-Za-z0-9]/.test(rest) &&
      !/^\s*[^\s=]+\s*=/.test(rest)
    )
      break;
  }
  if (!any && rest.trim() !== "") return undefined;
  return params;
}

const httpsOrLoopback = (value: string): boolean => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    !url.username &&
    !url.password &&
    !url.hash &&
    (url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
  );
};

export const protectedResourceMetadataSchema = z.looseObject({
  resource: z.string().max(2048),
  authorization_servers: z.array(z.string().max(2048)).max(16),
  scopes_supported: z.array(z.string().min(1).max(200)).max(64).optional(),
  bearer_methods_supported: z.array(z.string().max(32)).max(8).optional(),
  resource_name: z.string().max(256).optional(),
  resource_documentation: z.string().max(2048).optional(),
  authorization_details_types_supported: z
    .array(z.string().max(120))
    .max(32)
    .optional(),
});

export type ProtectedResourceMetadata = {
  resource: string;
  authorizationServers: string[];
  scopesSupported: string[];
  bearerMethodsSupported: string[];
  resourceName?: string;
};

export type AuthorizationChallenge = {
  status: number;
  /** `invalid_token`, `insufficient_scope`, ... when the server said so. */
  error?: string;
  /** Scopes the challenge named; authoritative for the current operation. */
  challengeScopes: string[];
  /** Scopes to request next: the challenge scopes, else `scopes_supported`, else none. */
  requestedScopes: string[];
  /** Where the metadata was read from, when it was. */
  resourceMetadataUrl?: string;
  metadata?: ProtectedResourceMetadata;
  /** The RFC 8707 resource identifier this binding uses for the server. */
  canonicalResource: string;
  /** Client registration mechanisms the configured profile documents, in its priority order. */
  clientRegistration: readonly ClientRegistrationMethod[];
  /** Everything that stopped short of a clean discovery; the hook decides what to do. */
  issues: string[];
};

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/**
 * Turns a 401/403 response into a challenge description. The metadata URL is
 * taken from the header when present, otherwise the two well-known locations
 * are tried in the documented order; only the destination's own origin is
 * ever contacted, and metadata naming a different resource is not believed.
 */
export async function resolveAuthorizationChallenge(input: {
  response: { status: number; headers: Headers };
  endpoint: URL;
  canonicalResource: string;
  clientRegistration: readonly ClientRegistrationMethod[];
  fetch: typeof fetch;
  limits: McpLimits;
  signal?: AbortSignal;
}): Promise<AuthorizationChallenge> {
  const issues: string[] = [];
  const header = input.response.headers.get("www-authenticate");
  const challenge = parseBearerChallenge(header);
  if (header && !challenge) issues.push("challenge-malformed");
  if (!header) issues.push("challenge-missing");
  const challengeScopes = (challenge?.scope ?? "")
    .split(/\s+/)
    .filter((scope) => scope.length > 0 && scope.length <= 200)
    .slice(0, 64);

  const candidates: string[] = [];
  const advertised = challenge?.resource_metadata;
  if (advertised) {
    if (URL.canParse(advertised)) {
      const url = new URL(advertised);
      if (
        url.origin === input.endpoint.origin &&
        !url.username &&
        !url.password
      )
        candidates.push(url.href);
      else issues.push("metadata-origin-mismatch");
    } else issues.push("metadata-url-malformed");
  }
  const path = stripTrailingSlash(input.endpoint.pathname);
  if (path && path !== "/")
    candidates.push(
      `${input.endpoint.origin}/.well-known/oauth-protected-resource${path}`,
    );
  candidates.push(
    `${input.endpoint.origin}/.well-known/oauth-protected-resource`,
  );

  let metadata: ProtectedResourceMetadata | undefined;
  let resourceMetadataUrl: string | undefined;
  for (const candidate of [...new Set(candidates)]) {
    let reply;
    try {
      reply = await exchange(
        input.fetch,
        {
          url: new URL(candidate),
          method: "GET",
          headers: { accept: "application/json" },
          timeoutMs: input.limits.requestTimeoutMs,
          ...(input.signal ? { signal: input.signal } : {}),
        },
        input.limits,
      );
    } catch {
      issues.push("metadata-unavailable");
      continue;
    }
    if (reply.kind !== "json" || reply.status !== 200) {
      issues.push(
        reply.status === 404 ? "metadata-not-found" : "metadata-malformed",
      );
      continue;
    }
    const parsed = protectedResourceMetadataSchema.safeParse(reply.body);
    if (!parsed.success) {
      issues.push("metadata-malformed");
      continue;
    }
    if (
      stripTrailingSlash(parsed.data.resource) !==
      stripTrailingSlash(input.canonicalResource)
    ) {
      issues.push("metadata-resource-mismatch");
      continue;
    }
    const servers = parsed.data.authorization_servers.filter(httpsOrLoopback);
    if (servers.length !== parsed.data.authorization_servers.length)
      issues.push("metadata-authorization-server-rejected");
    if (!servers.length) {
      issues.push("metadata-no-authorization-server");
      continue;
    }
    metadata = {
      resource: parsed.data.resource,
      authorizationServers: servers,
      scopesSupported: parsed.data.scopes_supported ?? [],
      bearerMethodsSupported: parsed.data.bearer_methods_supported ?? [
        "header",
      ],
      ...(parsed.data.resource_name
        ? { resourceName: parsed.data.resource_name.replace(/\p{Cc}/gu, "") }
        : {}),
    };
    resourceMetadataUrl = candidate;
    break;
  }

  const requestedScopes = challengeScopes.length
    ? challengeScopes
    : (metadata?.scopesSupported ?? []);
  return {
    status: input.response.status,
    ...(challenge?.error ? { error: challenge.error.slice(0, 64) } : {}),
    challengeScopes,
    requestedScopes,
    ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
    ...(metadata ? { metadata } : {}),
    canonicalResource: input.canonicalResource,
    clientRegistration: input.clientRegistration,
    issues: [...new Set(issues)],
  };
}

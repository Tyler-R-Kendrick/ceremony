import { createHash, randomUUID } from "node:crypto";
import { startHttpFixture, type FixtureReply } from "./http-fixture.js";

/*
 * An independent double of api.supabase.com: Management OAuth plus the v1 REST
 * surface this repository binds. It is written from the documentation, not
 * from the adapter, and it enforces the documented contract rather than
 * accepting whatever arrives:
 *
 *   GET  /v1/oauth/authorize  client_id (uuid), response_type=code, redirect_uri,
 *                             state, code_challenge, code_challenge_method=S256,
 *                             organization_slug (optional). A request carrying the
 *                             deprecated `scope` parameter is recorded and rejected
 *                             here, because this host never sends it.
 *   POST /v1/oauth/token      application/x-www-form-urlencoded; authorization_code
 *                             and refresh_token grants; client authentication by
 *                             Basic header or by client_id/client_secret in the body;
 *                             {access_token, refresh_token, expires_in, token_type:"Bearer"}.
 *   POST /v1/oauth/revoke     application/json {client_id, client_secret, refresh_token} -> 204.
 *   GET  /v1/profile, /v1/organizations, /v1/organizations/{slug},
 *        /v1/organizations/{slug}/members, /v1/projects, /v1/projects/{ref}
 *                             bearer access token; scope-gated; 401/403/404/429 as documented.
 *
 * Response shapes follow https://api.supabase.com/api/v1-json (OpenAPI 3.0.0,
 * "Supabase API (v1)"), verified 2026-09-18.
 */

export type ManagementProject = {
  id: string;
  ref: string;
  organization_id: string;
  organization_slug: string;
  name: string;
  region: string;
  created_at: string;
  status: string;
  database: {
    host: string;
    version: string;
    postgres_engine: string;
    release_channel: string;
  };
};

export type ManagementOrganization = {
  id: string;
  slug: string;
  name: string;
  plan?: string;
  members?: Array<{
    user_id: string;
    user_name: string;
    email?: string;
    role_name?: string;
    mfa_enabled: boolean;
  }>;
};

export type ManagementGrant = {
  /** Scopes the OAuth app was registered with; the request never carries them. */
  scopes: string[];
  /** Project refs and organization slugs this grant may read. */
  projects: string[];
  organizations: string[];
  accountId: string;
  /** Omitting the scope member from the token response is a documented shape too. */
  reportScopeInTokenResponse?: boolean;
};

export type SupabaseManagementDoubleOptions = {
  clientId?: string;
  clientSecret?: string;
  redirectUris?: string[];
  projects?: ManagementProject[];
  organizations?: ManagementOrganization[];
  grant?: Partial<ManagementGrant>;
  accessTokenTtlSeconds?: number;
  /** Rotate the refresh token on every refresh, as a confidential client should expect. */
  rotateRefreshTokens?: boolean;
  /** Fail the next N token requests with a 503, to exercise indeterminate outcomes. */
  failTokenRequests?: number;
  /** Deny GET /v1/profile so the adapter must fall back to resource-access evidence. */
  denyProfile?: boolean;
  /** Answer every API request with 429 once the count is reached. */
  rateLimitAfter?: number;
};

export function managementProject(
  ref: string,
  organizationSlug: string,
  overrides: Partial<ManagementProject> = {},
): ManagementProject {
  return {
    id: `id-${ref}`,
    ref,
    organization_id: `org-id-${organizationSlug}`,
    organization_slug: organizationSlug,
    name: `Project ${ref.slice(0, 6)}`,
    region: "us-east-1",
    created_at: "2026-01-05T10:00:00.000Z",
    status: "ACTIVE_HEALTHY",
    database: {
      host: `db.${ref}.supabase.co`,
      version: "17.4.1",
      postgres_engine: "17",
      release_channel: "ga",
    },
    ...overrides,
  };
}

export function managementOrganization(
  slug: string,
  overrides: Partial<ManagementOrganization> = {},
): ManagementOrganization {
  return {
    id: `org-id-${slug}`,
    slug,
    name: `Organization ${slug}`,
    plan: "pro",
    members: [
      {
        user_id: "member-1",
        user_name: "Fixture Owner",
        email: "owner@example.test",
        role_name: "Owner",
        mfa_enabled: true,
      },
    ],
    ...overrides,
  };
}

const base64Url = (value: Buffer) => value.toString("base64url");
const s256 = (verifier: string) =>
  base64Url(createHash("sha256").update(verifier).digest());

type AuthorizationRecord = {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  organizationSlug?: string;
  used: boolean;
};

type TokenRecord = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  revoked: boolean;
};

export async function startSupabaseManagementDouble(
  options: SupabaseManagementDoubleOptions = {},
) {
  const clientId = options.clientId ?? "66666666-6666-4666-8666-666666666666";
  const clientSecret =
    options.clientSecret ?? "sb_secret_live_fixture_9f4d3a206b2e4a7e8c91";
  const redirectUris = new Set(options.redirectUris ?? []);
  const projects = [...(options.projects ?? [])];
  const organizations = [...(options.organizations ?? [])];
  const grant: ManagementGrant = {
    scopes: ["projects:read", "organizations:read"],
    projects: projects.map((project) => project.ref),
    organizations: organizations.map((organization) => organization.slug),
    accountId: "fixture-account-1",
    reportScopeInTokenResponse: true,
    ...options.grant,
  };
  const accessTokenTtlSeconds = options.accessTokenTtlSeconds ?? 86_400;
  const authorizations = new Map<string, AuthorizationRecord>();
  const tokens = new Map<string, TokenRecord>();
  const refreshIndex = new Map<string, string>();
  /** Every rejection the double made, so a test can assert *why* the fixture refused. */
  const rejections: Array<{ path: string; reason: string }> = [];
  const observed = {
    authorizeRequests: [] as URLSearchParams[],
    tokenBodies: [] as URLSearchParams[],
    tokenAuthHeaders: [] as string[],
    revokeBodies: [] as Record<string, unknown>[],
    apiAuthorizations: [] as string[],
    scopeParameterSeen: false,
    plainPkceSeen: false,
  };
  let failTokenRequests = options.failTokenRequests ?? 0;
  let apiCalls = 0;

  const reject = (path: string, reason: string, reply: FixtureReply) => {
    rejections.push({ path, reason });
    return reply;
  };

  const issueTokens = (): TokenRecord => {
    const record: TokenRecord = {
      accessToken: `sbp_oauth_access_${randomUUID().replace(/-/g, "")}`,
      refreshToken: `sbp_oauth_refresh_${randomUUID().replace(/-/g, "")}`,
      expiresAt: Date.now() + accessTokenTtlSeconds * 1000,
      revoked: false,
    };
    tokens.set(record.accessToken, record);
    refreshIndex.set(record.refreshToken, record.accessToken);
    return record;
  };

  const tokenResponse = (record: TokenRecord) => ({
    access_token: record.accessToken,
    refresh_token: record.refreshToken,
    expires_in: Math.max(
      1,
      Math.round((record.expiresAt - Date.now()) / 1000),
    ),
    token_type: "Bearer",
    ...(grant.reportScopeInTokenResponse
      ? { scope: grant.scopes.join(" ") }
      : {}),
  });

  /** Confidential client authentication: Basic header, or client_id/client_secret in the body. */
  const authenticateClient = (
    header: string | undefined,
    body: URLSearchParams,
  ): boolean => {
    if (header?.toLowerCase().startsWith("basic ")) {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      return (
        decodeURIComponent(decoded.slice(0, separator)) === clientId &&
        decodeURIComponent(decoded.slice(separator + 1)) === clientSecret
      );
    }
    return (
      body.get("client_id") === clientId &&
      body.get("client_secret") === clientSecret
    );
  };

  const bearerGrant = (
    path: string,
    authorization: string | undefined,
    scope: string,
  ): { error: FixtureReply } | { token: TokenRecord } => {
    apiCalls++;
    observed.apiAuthorizations.push(authorization ?? "");
    if (
      options.rateLimitAfter !== undefined &&
      apiCalls > options.rateLimitAfter
    )
      return {
        error: reject(path, "rate-limited", {
          status: 429,
          headers: { "x-ratelimit-limit": "120", "x-ratelimit-remaining": "0" },
          body: { message: "Rate limit exceeded" },
        }),
      };
    if (!authorization?.startsWith("Bearer "))
      return {
        error: reject(path, "missing-bearer", {
          status: 401,
          body: { message: "Unauthorized" },
        }),
      };
    const record = tokens.get(authorization.slice(7));
    if (!record || record.revoked)
      return {
        error: reject(path, "unknown-token", {
          status: 401,
          body: { message: "Unauthorized" },
        }),
      };
    if (record.expiresAt <= Date.now())
      return {
        error: reject(path, "token-expired", {
          status: 401,
          body: { message: "Unauthorized" },
        }),
      };
    if (!grant.scopes.includes(scope))
      return {
        error: reject(path, `missing-scope:${scope}`, {
          status: 403,
          body: { message: "Forbidden action" },
        }),
      };
    return { token: record };
  };

  const fixture = await startHttpFixture(async (request) => {
    const path = request.url.pathname;

    if (path === "/v1/oauth/authorize") {
      if (request.method !== "GET")
        return reject(path, "method", { status: 405, body: {} });
      const query = request.url.searchParams;
      observed.authorizeRequests.push(new URLSearchParams(query));
      if (query.has("scope")) {
        // Documented as deprecated: scopes are configured when the OAuth app is
        // created. A host that replays the old example is refused here.
        observed.scopeParameterSeen = true;
        return reject(path, "deprecated-scope-parameter", {
          status: 400,
          body: { error: "invalid_request", message: "scope is deprecated" },
        });
      }
      if (query.get("client_id") !== clientId)
        return reject(path, "unknown-client", {
          status: 401,
          body: { message: "Unauthorized" },
        });
      if (query.get("response_type") !== "code")
        return reject(path, "response-type", {
          status: 400,
          body: { error: "unsupported_response_type" },
        });
      const redirectUri = query.get("redirect_uri") ?? "";
      if (redirectUris.size && !redirectUris.has(redirectUri))
        return reject(path, "redirect-uri-not-registered", {
          status: 400,
          body: { error: "invalid_request" },
        });
      const state = query.get("state") ?? "";
      if (!state)
        return reject(path, "missing-state", {
          status: 400,
          body: { error: "invalid_request" },
        });
      if (redirectUri.length + state.length > 4096)
        return reject(path, "redirect-and-state-too-large", {
          status: 400,
          body: { error: "invalid_request" },
        });
      const method = query.get("code_challenge_method");
      const challenge = query.get("code_challenge") ?? "";
      if (method !== "S256" || !challenge) {
        if (method && method !== "S256") observed.plainPkceSeen = true;
        return reject(path, "pkce-required", {
          status: 400,
          body: { error: "invalid_request" },
        });
      }
      const code = `oauth_code_${randomUUID().replace(/-/g, "")}`;
      const organizationSlug = query.get("organization_slug");
      authorizations.set(code, {
        code,
        clientId,
        redirectUri,
        codeChallenge: challenge,
        ...(organizationSlug ? { organizationSlug } : {}),
        used: false,
      });
      const location = new URL(redirectUri);
      location.searchParams.set("code", code);
      location.searchParams.set("state", state);
      return { status: 302, headers: { location: location.href } };
    }

    if (path === "/v1/oauth/token") {
      if (request.method !== "POST")
        return reject(path, "method", { status: 405, body: {} });
      if (
        !(request.headers["content-type"] ?? "").startsWith(
          "application/x-www-form-urlencoded",
        )
      )
        return reject(path, "content-type", {
          status: 400,
          body: { error: "invalid_request" },
        });
      const body = new URLSearchParams(request.body.toString("utf8"));
      observed.tokenBodies.push(new URLSearchParams(body));
      observed.tokenAuthHeaders.push(request.headers.authorization ?? "");
      if (failTokenRequests > 0) {
        failTokenRequests--;
        return reject(path, "injected-failure", {
          status: 503,
          body: { message: "Service unavailable" },
        });
      }
      if (!authenticateClient(request.headers.authorization, body))
        return reject(path, "client-authentication", {
          status: 401,
          body: { error: "invalid_client" },
        });
      const grantType = body.get("grant_type");
      if (grantType === "authorization_code") {
        const record = authorizations.get(body.get("code") ?? "");
        if (!record)
          return reject(path, "unknown-code", {
            status: 401,
            body: { error: "invalid_grant" },
          });
        if (record.used) {
          // A replayed code invalidates the grant, as an authorization server should.
          for (const [accessToken, token] of tokens)
            if (accessToken) token.revoked = true;
          return reject(path, "code-replayed", {
            status: 401,
            body: { error: "invalid_grant" },
          });
        }
        if (body.get("redirect_uri") !== record.redirectUri)
          return reject(path, "redirect-uri-mismatch", {
            status: 401,
            body: { error: "invalid_grant" },
          });
        const verifier = body.get("code_verifier") ?? "";
        if (!verifier || s256(verifier) !== record.codeChallenge)
          return reject(path, "pkce-mismatch", {
            status: 401,
            body: { error: "invalid_grant" },
          });
        record.used = true;
        return { status: 200, body: tokenResponse(issueTokens()) };
      }
      if (grantType === "refresh_token") {
        const presented = body.get("refresh_token") ?? "";
        const accessToken = refreshIndex.get(presented);
        const current = accessToken ? tokens.get(accessToken) : undefined;
        if (!current || current.revoked)
          return reject(path, "unknown-refresh-token", {
            status: 401,
            body: { error: "invalid_grant" },
          });
        if (current.refreshToken !== presented)
          return reject(path, "rotated-refresh-token-replayed", {
            status: 401,
            body: { error: "invalid_grant" },
          });
        tokens.delete(current.accessToken);
        refreshIndex.delete(presented);
        const next = issueTokens();
        if (options.rotateRefreshTokens === false) {
          refreshIndex.delete(next.refreshToken);
          next.refreshToken = presented;
          refreshIndex.set(presented, next.accessToken);
        }
        return { status: 200, body: tokenResponse(next) };
      }
      return reject(path, "unsupported-grant-type", {
        status: 400,
        body: { error: "unsupported_grant_type" },
      });
    }

    if (path === "/v1/oauth/revoke") {
      if (request.method !== "POST")
        return reject(path, "method", { status: 405, body: {} });
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(request.body.toString("utf8")) as Record<
          string,
          unknown
        >;
      } catch {
        return reject(path, "body-not-json", {
          status: 400,
          body: { error: "invalid_request" },
        });
      }
      observed.revokeBodies.push(parsed);
      if (
        parsed.client_id !== clientId ||
        parsed.client_secret !== clientSecret
      )
        return reject(path, "client-authentication", {
          status: 401,
          body: { error: "invalid_client" },
        });
      const accessToken = refreshIndex.get(String(parsed.refresh_token ?? ""));
      const record = accessToken ? tokens.get(accessToken) : undefined;
      if (!record)
        return reject(path, "unknown-refresh-token", {
          status: 401,
          body: { error: "invalid_grant" },
        });
      record.revoked = true;
      return { status: 204 };
    }

    if (path === "/v1/profile") {
      const admitted = bearerGrant(path, request.headers.authorization, "projects:read");
      if ("error" in admitted) return admitted.error;
      if (options.denyProfile)
        return reject(path, "profile-denied", {
          status: 403,
          body: { message: "Forbidden action" },
        });
      return {
        status: 200,
        body: {
          gotrue_id: grant.accountId,
          primary_email: "owner@example.test",
          username: "fixture-owner",
        },
      };
    }

    if (path === "/v1/organizations") {
      const admitted = bearerGrant(
        path,
        request.headers.authorization,
        "organizations:read",
      );
      if ("error" in admitted) return admitted.error;
      return {
        status: 200,
        body: organizations
          .filter((organization) => grant.organizations.includes(organization.slug))
          .map((organization) => ({
            id: organization.id,
            slug: organization.slug,
            name: organization.name,
          })),
      };
    }

    const organizationMatch = /^\/v1\/organizations\/([^/]+)(\/members)?$/.exec(path);
    if (organizationMatch) {
      const admitted = bearerGrant(
        path,
        request.headers.authorization,
        "organizations:read",
      );
      if ("error" in admitted) return admitted.error;
      const slug = decodeURIComponent(organizationMatch[1]!);
      const organization = organizations.find((item) => item.slug === slug);
      if (!organization || !grant.organizations.includes(slug))
        return reject(path, "organization-not-granted", {
          status: 403,
          body: { message: "Forbidden action" },
        });
      if (organizationMatch[2])
        return { status: 200, body: organization.members ?? [] };
      return {
        status: 200,
        body: {
          id: organization.id,
          name: organization.name,
          ...(organization.plan ? { plan: organization.plan } : {}),
          opt_in_tags: [],
          allowed_release_channels: ["ga"],
        },
      };
    }

    if (path === "/v1/projects") {
      const admitted = bearerGrant(path, request.headers.authorization, "projects:read");
      if ("error" in admitted) return admitted.error;
      return {
        status: 200,
        body: projects.filter((project) => grant.projects.includes(project.ref)),
      };
    }

    const projectMatch = /^\/v1\/projects\/([^/]+)$/.exec(path);
    if (projectMatch) {
      const admitted = bearerGrant(path, request.headers.authorization, "projects:read");
      if ("error" in admitted) return admitted.error;
      const ref = decodeURIComponent(projectMatch[1]!);
      const project = projects.find((item) => item.ref === ref);
      if (!project)
        return reject(path, "project-not-found", {
          status: 404,
          body: { message: "Not found" },
        });
      if (!grant.projects.includes(ref))
        return reject(path, "project-not-granted", {
          status: 403,
          body: { message: "Forbidden action" },
        });
      return { status: 200, body: project };
    }

    return reject(path, "unknown-route", {
      status: 404,
      body: { message: "Not found" },
    });
  });

  return {
    origin: fixture.origin,
    clientId,
    clientSecret,
    projects,
    organizations,
    grant,
    observed,
    rejections,
    requests: fixture.requests,
    received: fixture.received,
    allowRedirectUri(value: string) {
      redirectUris.add(value);
    },
    /** Revokes as the dashboard would, without a request from the host. */
    revokeUpstream() {
      for (const token of tokens.values()) token.revoked = true;
    },
    expireAccessTokens() {
      for (const token of tokens.values()) token.expiresAt = Date.now() - 1000;
    },
    activeAccessTokens() {
      return [...tokens.values()].filter(
        (token) => !token.revoked && token.expiresAt > Date.now(),
      ).length;
    },
    close: fixture.close,
  };
}

export type SupabaseManagementDouble = Awaited<
  ReturnType<typeof startSupabaseManagementDouble>
>;

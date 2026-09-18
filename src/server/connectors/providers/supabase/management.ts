import * as oauth from "oauth4webapi";
import { z } from "zod";
import {
  encodePathSegment,
  type CompatibilityIssue,
} from "../../../../core/connectors/index.js";
import {
  capabilityStatus,
  type AdapterCallContext,
  type AuthorizationIntent,
  type CapabilityStatus,
  type CompletionInput,
  type CompletionResult,
  type ConfigurationRequirement,
  type ConnectorAdapter,
  type DiscoverInput,
  type DiscoveredItem,
  type DiscoverResult,
  type DisconnectResult,
  type DisconnectScope,
  type HandoffProposal,
  type InvokeRequest,
  type InvokeResult,
  type VerificationClaim,
} from "../../adapter.js";
import {
  boundOperation,
  destinationFor,
  destinationUrl,
  type ApprovedDestination,
} from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import type { CredentialMaterial, HandoffRecord } from "../../ports.js";
import {
  SUPABASE_ECOSYSTEM,
  SUPABASE_MANAGEMENT_API_ORIGIN,
  SUPABASE_SERVICE,
  assertCredentialKind,
  base64Url,
  boundedSignal,
  credentialScope,
  discardBody,
  isPermittedTarget,
  makeClaim,
  organizationSlugSchema,
  parseSupabaseTarget,
  pinnedDestination,
  projectRefSchema,
  readBoundedJson,
  requireConnection,
  safeText,
  sameTarget,
  sha256Hex,
  upstreamFailure,
  type SupabaseTarget,
} from "./common.js";
import {
  supersedeTarget,
  type SupabaseAuthorizationStart,
  type SupersedeReport,
} from "./lifecycle.js";

/*
 * Supabase Management OAuth (SB-01).
 *
 * Verified against https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration
 * and the vendor OpenAPI document (https://api.supabase.com/api/v1-json) on 2026-09-18:
 *
 *   GET  /v1/oauth/authorize  client_id, redirect_uri, response_type=code, state,
 *                             code_challenge, code_challenge_method=S256,
 *                             organization_slug (optional pre-selection).
 *                             `scope` is deprecated: scopes are configured on the
 *                             OAuth app, so this adapter never sends it.
 *   POST /v1/oauth/token      application/x-www-form-urlencoded; grant_type
 *                             authorization_code | refresh_token; client_id and
 *                             client_secret accepted in the body; response
 *                             {access_token, refresh_token?, expires_in, token_type:"Bearer"}
 *                             with no `scope` member.
 *   POST /v1/oauth/revoke     application/json {client_id, client_secret, refresh_token} -> 204.
 *   GET  /v1/organizations, /v1/organizations/{slug}, /v1/organizations/{slug}/members,
 *        /v1/projects, /v1/projects/{ref}, /v1/profile   (bearer; no pagination documented).
 *
 * The connection's target is one project or organization chosen by the human
 * from the inventory and checked against the binding's permitted targets. A
 * project user's session is a different credential kind and is refused here.
 */

export const SUPABASE_OAUTH_CLIENT_ID = "SUPABASE_OAUTH_CLIENT_ID";
export const SUPABASE_OAUTH_CLIENT_SECRET = "SUPABASE_OAUTH_CLIENT_SECRET";
export const SUPABASE_MANAGEMENT_ADAPTER_ID = "supabase-management";
export const SUPABASE_MANAGEMENT_PROFILE = "supabase-management-api-v1";
const ADAPTER_VERSION = "1.0.0";
const VERIFIER_VERSION = "supabase-management/1.0.0";
const OAUTH_INTENT = "supabase.management.oauth";
const TARGET_INTENT = "supabase.management.target-select";
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;

type ManagementOperationSpec = {
  method: "GET";
  pathTemplate: string;
  /** Documented OAuth scope guarding the endpoint; observed when the call succeeds. */
  scope: "projects:read" | "organizations:read";
  targetParameter?: { name: "ref" | "slug"; kind: SupabaseTarget["kind"] };
  minimumClassification: "public" | "personal";
};

/** Operation ids exactly as the vendor OpenAPI document names them; nothing else is bindable. */
export const supabaseManagementOperations: Record<
  string,
  ManagementOperationSpec
> = {
  "v1-list-all-projects": {
    method: "GET",
    pathTemplate: "/v1/projects",
    scope: "projects:read",
    minimumClassification: "personal",
  },
  "v1-get-project": {
    method: "GET",
    pathTemplate: "/v1/projects/{ref}",
    scope: "projects:read",
    targetParameter: { name: "ref", kind: "supabase-project" },
    minimumClassification: "personal",
  },
  "v1-list-all-organizations": {
    method: "GET",
    pathTemplate: "/v1/organizations",
    scope: "organizations:read",
    minimumClassification: "personal",
  },
  "v1-get-an-organization": {
    method: "GET",
    pathTemplate: "/v1/organizations/{slug}",
    scope: "organizations:read",
    targetParameter: { name: "slug", kind: "supabase-organization" },
    minimumClassification: "personal",
  },
  "v1-list-organization-members": {
    method: "GET",
    pathTemplate: "/v1/organizations/{slug}/members",
    scope: "organizations:read",
    targetParameter: { name: "slug", kind: "supabase-organization" },
    minimumClassification: "personal",
  },
};

const boundedString = (max: number) => z.string().max(max);
const projectSchema = z.object({
  ref: projectRefSchema,
  name: boundedString(256),
  organization_slug: organizationSlugSchema,
  region: boundedString(64),
  status: boundedString(32),
  created_at: boundedString(64),
});
const organizationSchema = z.object({
  slug: organizationSlugSchema,
  name: boundedString(256),
});
const organizationDetailSchema = z.object({
  name: boundedString(256),
  plan: boundedString(32).optional(),
  opt_in_tags: z.array(boundedString(64)).max(32).optional(),
  allowed_release_channels: z.array(boundedString(32)).max(16).optional(),
});
const memberSchema = z.object({
  user_id: boundedString(128),
  user_name: boundedString(256),
  email: boundedString(320).optional(),
  role_name: boundedString(64).optional(),
  mfa_enabled: z.boolean(),
});
const profileSchema = z.object({
  gotrue_id: z.string().min(1).max(128),
  primary_email: boundedString(320),
  username: boundedString(256),
});
const clientIdSchema = z.uuid();

export type SupabaseManagementOptions = {
  /** Path of the host route that receives the provider redirect; joined to the deployment origin only. */
  callbackPath?: string;
  handoffTtlMs?: number;
  requestTimeoutMs?: number;
  evidenceTtlMs?: number;
  /** Ceiling on inventory rows parsed from one listing response. */
  maxInventoryItems?: number;
  /** Refresh this long before the stored access token expires. */
  refreshSkewMs?: number;
};

type Verification = {
  claims: VerificationClaim[];
  externalIds: Record<string, string>;
  adapterState: Record<string, unknown>;
};

type ScopeReport = {
  reported: string[];
  semantics: "provider-scopes" | "unknown";
};

export interface SupabaseManagementAdapter extends ConnectorAdapter {
  authorize(
    ctx: AdapterCallContext,
    intent: AuthorizationIntent,
  ): Promise<SupabaseAuthorizationStart>;
  reconnect(
    ctx: AdapterCallContext,
    intent: AuthorizationIntent,
  ): Promise<SupabaseAuthorizationStart>;
  complete(
    ctx: AdapterCallContext,
    input: CompletionInput,
  ): Promise<CompletionResult>;
  verify(ctx: AdapterCallContext): Promise<CompletionResult>;
  discover(
    ctx: AdapterCallContext,
    input: DiscoverInput,
  ): Promise<DiscoverResult>;
  invoke(ctx: AdapterCallContext, request: InvokeRequest): Promise<InvokeResult>;
  disconnect(
    ctx: AdapterCallContext,
    scope: DisconnectScope,
  ): Promise<DisconnectResult>;
  revoke(ctx: AdapterCallContext): Promise<DisconnectResult>;
}

export function createSupabaseManagementAdapter(
  options: SupabaseManagementOptions = {},
): SupabaseManagementAdapter {
  const callbackPath =
    options.callbackPath ?? "/api/v1/connectors/supabase-management/callback";
  if (!/^\/[^\p{Cc}?#]*$/u.test(callbackPath))
    throw new Error("Callback path must be an absolute path");
  const handoffTtlMs = options.handoffTtlMs ?? 600_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  const evidenceTtlMs = options.evidenceTtlMs ?? 86_400_000;
  const maxInventoryItems = options.maxInventoryItems ?? 500;
  const refreshSkewMs = options.refreshSkewMs ?? 60_000;

  const configuration: ConfigurationRequirement[] = [
    {
      name: SUPABASE_OAUTH_CLIENT_ID,
      source: "host",
      classification: "public",
      required: true,
      description: "Client id of the Supabase OAuth app registered by the host",
    },
    {
      name: SUPABASE_OAUTH_CLIENT_SECRET,
      source: "host",
      classification: "secret",
      required: true,
      description:
        "Client secret of the Supabase OAuth app; used only for token and revoke requests",
    },
  ];

  const apiDestination = (ctx: AdapterCallContext): ApprovedDestination =>
    pinnedDestination(
      ctx.binding,
      "api",
      SUPABASE_MANAGEMENT_API_ORIGIN,
      "supabase.management",
    );

  const callbackUrl = (ctx: AdapterCallContext): URL => {
    const url = new URL(callbackPath, ctx.environment.origin);
    if (url.origin !== new URL(ctx.environment.origin).origin)
      throw new ConnectorError("invalid-request", {
        detail: "supabase.oauth.callback-origin-invalid",
      });
    return url;
  };

  const missingConfiguration = async (ctx: AdapterCallContext) => {
    const present = await ctx.environment.configuration.present([
      SUPABASE_OAUTH_CLIENT_ID,
      SUPABASE_OAUTH_CLIENT_SECRET,
    ]);
    return configuration
      .filter((item) => item.required && !present.has(item.name))
      .map((item) => item.name);
  };

  const readClientId = async (ctx: AdapterCallContext): Promise<string> => {
    const value = await ctx.environment.configuration.read(
      SUPABASE_OAUTH_CLIENT_ID,
    );
    const parsed = clientIdSchema.safeParse(value);
    if (!parsed.success)
      throw new ConnectorError("configuration-required", {
        detail: "supabase.oauth.client-id-invalid",
      });
    return parsed.data;
  };

  const readClientSecret = async (ctx: AdapterCallContext): Promise<string> => {
    const value = await ctx.environment.configuration.read(
      SUPABASE_OAUTH_CLIENT_SECRET,
    );
    if (!value || value.length > 4096)
      throw new ConnectorError("configuration-required", {
        detail: "supabase.oauth.client-secret-missing",
      });
    return value;
  };

  const authorizationServer = (
    destination: ApprovedDestination,
    clientId: string,
  ) => {
    const as: oauth.AuthorizationServer = {
      issuer: destination.origin,
      authorization_endpoint: destinationUrl(destination, "/v1/oauth/authorize")
        .href,
      token_endpoint: destinationUrl(destination, "/v1/oauth/token").href,
    };
    const client: oauth.Client = { client_id: clientId };
    return { as, client };
  };

  /** Every token-endpoint request goes through the environment fetch, never follows redirects and stays on the pinned origin. */
  const tokenRequestOptions = (
    ctx: AdapterCallContext,
    destination: ApprovedDestination,
  ) => ({
    [oauth.allowInsecureRequests]: destination.network === "loopback-fixture",
    [oauth.customFetch]: async (
      url: string,
      init: {
        method: string;
        headers: Record<string, string>;
        body?: URLSearchParams | string | undefined;
        signal?: AbortSignal | undefined;
      },
    ): Promise<Response> => {
      if (new URL(url).origin !== destination.origin)
        throw new ConnectorError("network-policy", {
          detail: "supabase.management.destination-not-pinned",
        });
      return ctx.environment.fetch(url, {
        method: init.method,
        headers: init.headers,
        ...(init.body === undefined ? {} : { body: init.body }),
        redirect: "error",
        signal: boundedSignal(ctx, requestTimeoutMs),
      });
    },
    signal: boundedSignal(ctx, requestTimeoutMs),
  });

  const getJson = async (
    ctx: AdapterCallContext,
    destination: ApprovedDestination,
    path: string,
    accessToken: string,
  ): Promise<unknown> => {
    const url = destinationUrl(destination, path);
    let response: Response;
    try {
      response = await ctx.environment.fetch(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
        },
        redirect: "error",
        signal: boundedSignal(ctx, requestTimeoutMs),
      });
    } catch (cause) {
      throw new ConnectorError("upstream-unavailable", {
        detail: "supabase.management.unreachable",
        cause,
      });
    }
    if (response.status !== 200) {
      await discardBody(response);
      throw upstreamFailure(response.status, "supabase.management");
    }
    return readBoundedJson(response, MAX_RESPONSE_BYTES, "supabase.management");
  };

  const boundedArray = <T extends z.ZodType>(
    item: T,
  ): z.ZodArray<T> => z.array(item).max(maxInventoryItems);

  const tokenMaterial = (
    token: oauth.TokenEndpointResponse,
    clientId: string,
    now: number,
  ): CredentialMaterial =>
    Object.freeze({
      kind: "management-access-token",
      access_token: token.access_token,
      ...(token.refresh_token ? { refresh_token: token.refresh_token } : {}),
      ...(typeof token.scope === "string" ? { scope: token.scope } : {}),
      token_type: "Bearer",
      client_id: clientId,
      issued_at: String(now),
    });

  const tokenExpiry = (
    token: oauth.TokenEndpointResponse,
    now: number,
  ): number | undefined =>
    typeof token.expires_in === "number" &&
    Number.isFinite(token.expires_in) &&
    token.expires_in > 0
      ? now + token.expires_in * 1000
      : undefined;

  const scopeReport = (material: CredentialMaterial): ScopeReport =>
    typeof material.scope === "string"
      ? {
          reported: material.scope.split(" ").filter(Boolean).slice(0, 64),
          semantics: "provider-scopes",
        }
      : { reported: [], semantics: "unknown" };

  const scopeLimitations = (report: ScopeReport): string[] => [
    "Scopes are fixed at OAuth app registration; the request carries no scope parameter",
    ...(report.semantics === "unknown"
      ? [
          "The token response carries no scope member; granted scopes are unknown until a call observes them",
        ]
      : []),
  ];

  /**
   * Refreshes the stored token under the custody single-flight when it is
   * about to expire. A rejected refresh means the grant is gone (expired or
   * revoked by the user); the connection must be reconnected.
   */
  const ensureFresh = async (
    ctx: AdapterCallContext,
    connectionRef: string,
    credentialRef: string,
  ): Promise<void> => {
    const scope = credentialScope(ctx, connectionRef);
    const described = await ctx.environment.credentials.describe(
      scope,
      credentialRef,
    );
    if (!described)
      throw new ConnectorError("human-required", {
        detail: "supabase.management.authorization-required",
      });
    if (
      described.expiresAt === undefined ||
      described.expiresAt - refreshSkewMs > ctx.environment.now()
    )
      return;
    const destination = apiDestination(ctx);
    const clientId = await readClientId(ctx);
    const secret = await readClientSecret(ctx);
    const { as, client } = authorizationServer(destination, clientId);
    await ctx.environment.credentials.refresh(
      scope,
      credentialRef,
      async (current) => {
        assertCredentialKind(current, "management-access-token");
        if (current.client_id !== clientId)
          throw new ConnectorError("expired", {
            detail: "supabase.oauth.client-changed",
          });
        const refreshToken = current.refresh_token;
        if (!refreshToken)
          throw new ConnectorError("expired", {
            detail: "supabase.oauth.refresh-unavailable",
          });
        // The same refresh token is never sent twice: a lost outcome means the
        // token may have rotated upstream, and only a new grant is safe.
        const effect = await ctx.environment.effects.begin({
          actor: ctx.actor,
          connectionRef,
          bindingRef: ctx.binding.bindingRef,
          operation: "supabase.management.oauth.refresh",
          digest: sha256Hex(`${credentialRef}:${sha256Hex(refreshToken)}`),
        });
        if (effect.prior)
          throw new ConnectorError("expired", {
            detail: "supabase.oauth.refresh-indeterminate",
          });
        let token: oauth.TokenEndpointResponse;
        try {
          const response = await oauth.refreshTokenGrantRequest(
            as,
            client,
            oauth.ClientSecretPost(secret),
            refreshToken,
            tokenRequestOptions(ctx, destination),
          );
          token = await oauth.processRefreshTokenResponse(as, client, response);
        } catch (cause) {
          if (
            cause instanceof oauth.ResponseBodyError ||
            cause instanceof oauth.WWWAuthenticateChallengeError
          ) {
            await ctx.environment.effects.complete(effect.effectRef, {
              status: "failed",
              code: "supabase.oauth.refresh-rejected",
              at: ctx.environment.now(),
            });
            throw new ConnectorError("expired", {
              detail: "supabase.oauth.refresh-rejected",
              cause,
            });
          }
          await ctx.environment.effects.complete(effect.effectRef, {
            status: "indeterminate",
            code: "supabase.oauth.refresh-indeterminate",
            at: ctx.environment.now(),
          });
          throw new ConnectorError("upstream-unavailable", {
            detail: "supabase.oauth.refresh-unavailable",
            cause,
          });
        }
        const now = ctx.environment.now();
        await ctx.environment.effects.complete(effect.effectRef, {
          status: "applied",
          at: now,
        });
        const expiresAt = tokenExpiry(token, now);
        return {
          material: tokenMaterial(
            {
              ...token,
              // Rotation when the provider rotates; the previous refresh token stays valid otherwise.
              refresh_token: token.refresh_token ?? refreshToken,
              ...(token.scope === undefined && current.scope
                ? { scope: current.scope }
                : {}),
            },
            clientId,
            now,
          ),
          ...(expiresAt === undefined ? {} : { expiresAt }),
        };
      },
    );
  };

  /** Runs work with the management access token; refuses any other credential kind before a request exists. */
  const withManagementToken = async <T>(
    ctx: AdapterCallContext,
    work: (accessToken: string, material: CredentialMaterial) => Promise<T>,
  ): Promise<T> => {
    const connection = requireConnection(ctx);
    const credentialRef = connection.credentialRef;
    if (!credentialRef)
      throw new ConnectorError("human-required", {
        detail: "supabase.management.authorization-required",
      });
    await ensureFresh(ctx, connection.connectionRef, credentialRef);
    return ctx.environment.credentials.use(
      credentialScope(ctx, connection.connectionRef),
      credentialRef,
      async (material) => {
        assertCredentialKind(material, "management-access-token");
        const token = material.access_token;
        if (!token)
          throw new ConnectorError("expired", {
            detail: "supabase.management.credential-empty",
          });
        return work(token, material);
      },
    );
  };

  const hasStoredCredential = async (
    ctx: AdapterCallContext,
  ): Promise<boolean> => {
    const connection = ctx.connection;
    if (!connection?.credentialRef) return false;
    const described = await ctx.environment.credentials.describe(
      credentialScope(ctx, connection.connectionRef),
      connection.credentialRef,
    );
    return described !== undefined;
  };

  /** The token holder's identity when the API exposes it; a denied profile read is a recorded limitation, not a failure. */
  const accountIdentity = async (
    ctx: AdapterCallContext,
    destination: ApprovedDestination,
    accessToken: string,
  ): Promise<{
    claim?: VerificationClaim;
    externalIds: Record<string, string>;
    limitation?: string;
  }> => {
    try {
      const profile = profileSchema.parse(
        await getJson(ctx, destination, "/v1/profile", accessToken),
      );
      return {
        claim: makeClaim(ctx, {
          kind: "account-identity",
          target: { kind: "supabase-account", id: profile.gotrue_id },
          verifierVersion: VERIFIER_VERSION,
          validForMs: evidenceTtlMs,
          limitations: [
            "Identity of the dashboard user who granted the OAuth app; not a project user",
          ],
        }),
        externalIds: { accountId: profile.gotrue_id },
      };
    } catch (error) {
      if (
        error instanceof ConnectorError &&
        (error.code === "denied" || error.code === "not-found")
      )
        return {
          externalIds: {},
          limitation:
            "Token holder identity unavailable: GET /v1/profile was not permitted for this grant",
        };
      if (error instanceof z.ZodError)
        return {
          externalIds: {},
          limitation:
            "Token holder identity unavailable: GET /v1/profile returned an unexpected shape",
        };
      throw error;
    }
  };

  /** Verifies the chosen target with the given token: the observation names the exact project or organization. */
  const verifyTargetWithToken = async (
    ctx: AdapterCallContext,
    destination: ApprovedDestination,
    accessToken: string,
    target: SupabaseTarget,
    scopes: ScopeReport,
  ): Promise<Verification> => {
    const claims: VerificationClaim[] = [];
    const externalIds: Record<string, string> = {};
    const adapterState: Record<string, unknown> = {};
    const identity = await accountIdentity(ctx, destination, accessToken);
    if (identity.claim) claims.push(identity.claim);
    Object.assign(externalIds, identity.externalIds);
    const limitations = identity.limitation ? [identity.limitation] : [];
    if (target.kind === "supabase-project") {
      let project: z.infer<typeof projectSchema>;
      try {
        project = projectSchema.parse(
          await getJson(
            ctx,
            destination,
            `/v1/projects/${encodePathSegment(target.id)}`,
            accessToken,
          ),
        );
      } catch (error) {
        if (error instanceof z.ZodError)
          throw new ConnectorError("upstream-rejected", {
            detail: "supabase.management.project-shape",
          });
        throw error;
      }
      if (project.ref !== target.id)
        throw new ConnectorError("denied", {
          detail: "supabase.target.mismatch",
        });
      claims.push(
        makeClaim(ctx, {
          kind: "resource-access",
          target: { kind: "supabase-project", id: project.ref },
          verifierVersion: VERIFIER_VERSION,
          validForMs: evidenceTtlMs,
          permissions: {
            requested: [],
            reported: scopes.reported,
            observed: ["projects:read"],
            semantics: scopes.semantics,
          },
          limitations: [
            ...scopeLimitations(scopes),
            ...limitations,
            "Read access to project metadata observed; no write scope demonstrated",
          ],
        }),
      );
      externalIds.projectRef = project.ref;
      externalIds.organizationSlug = project.organization_slug;
      adapterState.organizationSlug = project.organization_slug;
      adapterState.projectStatus = safeText(project.status, 32);
      adapterState.region = safeText(project.region, 64);
    } else {
      let organizations: z.infer<typeof organizationSchema>[];
      try {
        organizations = boundedArray(organizationSchema).parse(
          await getJson(ctx, destination, "/v1/organizations", accessToken),
        );
      } catch (error) {
        if (error instanceof z.ZodError)
          throw new ConnectorError("upstream-rejected", {
            detail: "supabase.management.organization-shape",
          });
        throw error;
      }
      const organization = organizations.find(
        (item) => item.slug === target.id,
      );
      if (!organization)
        throw new ConnectorError("denied", {
          detail: "supabase.target.unavailable",
        });
      claims.push(
        makeClaim(ctx, {
          kind: "resource-access",
          target: { kind: "supabase-organization", id: organization.slug },
          verifierVersion: VERIFIER_VERSION,
          validForMs: evidenceTtlMs,
          permissions: {
            requested: [],
            reported: scopes.reported,
            observed: ["organizations:read"],
            semantics: scopes.semantics,
          },
          limitations: [
            ...scopeLimitations(scopes),
            ...limitations,
            "Membership of the organization observed through the listing; role not established",
          ],
        }),
      );
      externalIds.organizationSlug = organization.slug;
      adapterState.organizationSlug = organization.slug;
    }
    adapterState.verifiedAt = ctx.environment.now();
    return { claims, externalIds, adapterState };
  };

  const credentialAcceptedClaim = (
    ctx: AdapterCallContext,
    clientId: string,
    scopes: ScopeReport,
  ): VerificationClaim =>
    makeClaim(ctx, {
      kind: "credential-accepted",
      target: { kind: "supabase-oauth-app", id: clientId },
      verifierVersion: VERIFIER_VERSION,
      validForMs: evidenceTtlMs,
      permissions: {
        requested: [],
        reported: scopes.reported,
        observed: [],
        semantics: scopes.semantics,
      },
      limitations: [
        ...scopeLimitations(scopes),
        "An issued token proves the code exchange, not access to any target",
      ],
    });

  const resolveRequestedTarget = (
    ctx: AdapterCallContext,
    intent: AuthorizationIntent,
  ): SupabaseTarget | undefined => {
    if (intent.target) {
      const target = parseSupabaseTarget(intent.target);
      if (!target)
        throw new ConnectorError("invalid-request", {
          detail: "supabase.target.invalid",
        });
      if (!isPermittedTarget(ctx.binding, target))
        throw new ConnectorError("denied", {
          detail: "supabase.target.not-permitted",
        });
      return target;
    }
    const permitted = ctx.binding.permittedTargets
      .map((item) => parseSupabaseTarget(item))
      .filter((item): item is SupabaseTarget => item !== undefined);
    return permitted.length === 1 ? permitted[0] : undefined;
  };

  const targetSelectionHandoff = (
    ctx: AdapterCallContext,
    target: SupabaseTarget | undefined,
    accountSwitch: boolean,
  ): HandoffProposal => ({
    kind: "input-required",
    presentation: "in-app",
    intent: TARGET_INTENT,
    expiresAt: ctx.environment.now() + handoffTtlMs,
    correlationKey: `supabase-target:${ctx.environment.random.uuid()}`,
    private: {
      ...(target ? { target_kind: target.kind, target_id: target.id } : {}),
      account_switch: String(accountSwitch),
    },
  });

  const oauthHandoff = async (
    ctx: AdapterCallContext,
    input: {
      clientId: string;
      destination: ApprovedDestination;
      target: SupabaseTarget | undefined;
      mode: "connect" | "reconnect";
      accountSwitch: boolean;
    },
  ): Promise<HandoffProposal> => {
    const state = base64Url(ctx.environment.random.bytes(32));
    const verifier = base64Url(ctx.environment.random.bytes(32));
    const challenge = await oauth.calculatePKCECodeChallenge(verifier);
    const redirectUri = callbackUrl(ctx).href;
    // Documented ceiling: redirect_uri and state together stay under 4 kB.
    if (redirectUri.length + state.length > 4096)
      throw new ConnectorError("invalid-request", {
        detail: "supabase.oauth.redirect-too-long",
      });
    const url = destinationUrl(input.destination, "/v1/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: input.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      ...(input.target?.kind === "supabase-organization"
        ? { organization_slug: input.target.id }
        : {}),
    }).toString();
    return {
      kind: "provider-browser",
      presentation: "popup",
      intent: OAUTH_INTENT,
      expiresAt: ctx.environment.now() + handoffTtlMs,
      correlationKey: state,
      private: {
        url: url.href,
        state,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        client_id: input.clientId,
        mode: input.mode,
        account_switch: String(input.accountSwitch),
        ...(input.target
          ? { target_kind: input.target.kind, target_id: input.target.id }
          : {}),
      },
    };
  };

  const start = async (
    ctx: AdapterCallContext,
    intent: AuthorizationIntent,
    mode: "connect" | "reconnect",
  ): Promise<SupabaseAuthorizationStart> => {
    if (intent.ownerKind !== "user")
      return { kind: "unsupported", code: "supabase.owner-kind.unsupported" };
    const missing = await missingConfiguration(ctx);
    if (missing.length) return { kind: "configuration-required", missing };
    const clientId = await readClientId(ctx);
    const destination = apiDestination(ctx);
    const requested = resolveRequestedTarget(ctx, intent);
    const current = parseSupabaseTarget(ctx.connection?.target);
    let supersedes: SupersedeReport | undefined;
    if (current && requested && !sameTarget(current, requested)) {
      if (!intent.accountSwitch)
        return {
          kind: "human-required",
          code: "supabase.target.switch-requires-intent",
        };
      supersedes = await supersedeTarget(ctx, "supabase.target.changed");
    }
    const target = requested ?? current;
    if (mode === "connect" && (await hasStoredCredential(ctx)))
      return {
        kind: "handoff",
        handoff: targetSelectionHandoff(ctx, target, intent.accountSwitch),
        ...(supersedes ? { supersedes } : {}),
      };
    if (mode === "reconnect" && ctx.connection && !supersedes)
      await ctx.environment.handoffs.cancelAll(
        ctx.connection.connectionRef,
        "supabase.reconnect",
      );
    return {
      kind: "handoff",
      handoff: await oauthHandoff(ctx, {
        clientId,
        destination,
        target,
        mode,
        accountSwitch: intent.accountSwitch,
      }),
      ...(supersedes ? { supersedes } : {}),
    };
  };

  const privateTarget = (
    record: HandoffRecord,
  ): SupabaseTarget | undefined =>
    record.private.target_kind && record.private.target_id
      ? parseSupabaseTarget({
          kind: record.private.target_kind,
          id: record.private.target_id,
        })
      : undefined;

  const completeRedirect = async (
    ctx: AdapterCallContext,
    url: URL,
  ): Promise<CompletionResult> => {
    const expected = callbackUrl(ctx);
    // Exact return route: origin and path are compared before the state index is consulted.
    if (url.origin !== expected.origin || url.pathname !== expected.pathname)
      throw new ConnectorError("denied", {
        detail: "supabase.oauth.callback-route-mismatch",
      });
    const states = url.searchParams.getAll("state");
    const state = states[0];
    if (states.length !== 1 || !state || !STATE_PATTERN.test(state))
      throw new ConnectorError("denied", {
        detail: "supabase.oauth.state-invalid",
      });
    const record = await ctx.environment.handoffs.resolveCorrelation(
      ctx.actor.tenantId,
      state,
    );
    if (
      !record ||
      record.kind !== "provider-browser" ||
      record.intent !== OAUTH_INTENT ||
      record.subjectId !== ctx.actor.subjectId ||
      record.sessionId !== ctx.actor.sessionId ||
      record.bindingRef !== ctx.binding.bindingRef ||
      (ctx.connection && record.connectionRef !== ctx.connection.connectionRef)
    )
      throw new ConnectorError("denied", {
        detail: "supabase.oauth.handoff-mismatch",
      });
    if (record.generation !== ctx.generation)
      throw new ConnectorError("denied", {
        detail: "supabase.handoff.stale-generation",
      });
    if (record.state !== "issued" && record.state !== "waiting")
      return {
        state: "denied",
        claims: [],
        code: "supabase.oauth.callback-replayed",
      };
    const now = ctx.environment.now();
    if (record.expiresAt <= now) {
      await ctx.environment.handoffs.complete(
        record.handoffRef,
        ctx.generation,
        "expired",
      );
      return {
        state: "expired",
        claims: [],
        code: "supabase.oauth.handoff-expired",
      };
    }
    const priv = record.private;
    if (
      priv.state !== state ||
      priv.redirect_uri !== expected.href ||
      !priv.code_verifier ||
      !priv.client_id
    )
      throw new ConnectorError("denied", {
        detail: "supabase.oauth.handoff-corrupt",
      });
    const clientId = await readClientId(ctx);
    if (clientId !== priv.client_id) {
      // The app registration changed after the handoff was issued; the code belongs to the old client.
      await ctx.environment.handoffs.complete(
        record.handoffRef,
        ctx.generation,
        "superseded",
      );
      return {
        state: "denied",
        claims: [],
        code: "supabase.oauth.client-changed",
      };
    }
    const destination = apiDestination(ctx);
    const { as, client } = authorizationServer(destination, clientId);
    let parameters: URLSearchParams;
    try {
      parameters = oauth.validateAuthResponse(as, client, url, state);
    } catch (error) {
      await ctx.environment.handoffs.complete(
        record.handoffRef,
        ctx.generation,
        "denied",
      );
      return {
        state: "denied",
        claims: [],
        code:
          error instanceof oauth.AuthorizationResponseError
            ? "supabase.oauth.authorization-denied"
            : "supabase.oauth.callback-invalid",
      };
    }
    const code = parameters.get("code") ?? "";
    const effect = await ctx.environment.effects.begin({
      actor: ctx.actor,
      connectionRef: record.connectionRef,
      bindingRef: ctx.binding.bindingRef,
      operation: "supabase.management.oauth.exchange",
      digest: sha256Hex(`${record.handoffRef}:${sha256Hex(code)}`),
    });
    if (effect.prior) {
      await ctx.environment.handoffs.complete(
        record.handoffRef,
        ctx.generation,
        "completed",
      );
      return {
        state: "indeterminate",
        claims: [],
        code: "supabase.oauth.exchange-indeterminate",
      };
    }
    const secret = await readClientSecret(ctx);
    let token: oauth.TokenEndpointResponse;
    try {
      const response = await oauth.authorizationCodeGrantRequest(
        as,
        client,
        oauth.ClientSecretPost(secret),
        parameters,
        expected.href,
        priv.code_verifier,
        tokenRequestOptions(ctx, destination),
      );
      token = await oauth.processAuthorizationCodeResponse(
        as,
        client,
        response,
      );
    } catch (error) {
      const rejected =
        error instanceof oauth.ResponseBodyError ||
        error instanceof oauth.WWWAuthenticateChallengeError;
      const malformed =
        error instanceof oauth.OperationProcessingError ||
        error instanceof oauth.UnsupportedOperationError;
      await ctx.environment.effects.complete(effect.effectRef, {
        status: rejected || malformed ? "failed" : "indeterminate",
        code: rejected
          ? "supabase.oauth.exchange-rejected"
          : malformed
            ? "supabase.oauth.token-response-invalid"
            : "supabase.oauth.exchange-indeterminate",
        at: ctx.environment.now(),
      });
      await ctx.environment.handoffs.complete(
        record.handoffRef,
        ctx.generation,
        rejected || malformed ? "denied" : "completed",
      );
      return {
        state: rejected || malformed ? "denied" : "indeterminate",
        claims: [],
        code: rejected
          ? "supabase.oauth.exchange-rejected"
          : malformed
            ? "supabase.oauth.token-response-invalid"
            : "supabase.oauth.exchange-indeterminate",
      };
    }
    const issuedAt = ctx.environment.now();
    const material = tokenMaterial(token, clientId, issuedAt);
    const expiresAt = tokenExpiry(token, issuedAt);
    const scopes = scopeReport(material);
    const accepted = credentialAcceptedClaim(ctx, clientId, scopes);
    const target =
      privateTarget(record) ??
      (priv.mode === "reconnect"
        ? parseSupabaseTarget(ctx.connection?.target)
        : undefined);
    let verification: Verification | undefined;
    if (target) {
      try {
        verification = await verifyTargetWithToken(
          ctx,
          destination,
          token.access_token,
          target,
          scopes,
        );
      } catch (error) {
        if (
          error instanceof ConnectorError &&
          ["denied", "not-found", "expired"].includes(error.code)
        ) {
          // The grant exists but does not reach the intended target: the new
          // token is not stored, so a different account cannot silently replace
          // the verified one.
          await ctx.environment.effects.complete(effect.effectRef, {
            status: "applied",
            code: "supabase.target.unavailable",
            at: ctx.environment.now(),
          });
          await ctx.environment.handoffs.complete(
            record.handoffRef,
            ctx.generation,
            "denied",
          );
          return {
            state: "denied",
            claims: [accepted],
            code:
              priv.mode === "reconnect"
                ? "supabase.reconnect.target-unavailable"
                : "supabase.target.unavailable",
          };
        }
        throw error;
      }
    }
    const scope = credentialScope(ctx, record.connectionRef);
    const credentialRef = await ctx.environment.credentials.store(
      scope,
      material,
      {
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(ctx.connection?.credentialRef
          ? { replaces: ctx.connection.credentialRef }
          : {}),
      },
    );
    await ctx.environment.effects.complete(effect.effectRef, {
      status: "applied",
      at: ctx.environment.now(),
    });
    await ctx.environment.handoffs.complete(
      record.handoffRef,
      ctx.generation,
      "completed",
    );
    if (verification && target)
      return {
        state: "complete",
        claims: [accepted, ...verification.claims],
        credentialRef,
        externalIds: verification.externalIds,
        target,
        adapterState: verification.adapterState,
      };
    return {
      state: "human-required",
      claims: [accepted],
      credentialRef,
      code: "supabase.target.selection-required",
      handoff: targetSelectionHandoff(ctx, undefined, false),
    };
  };

  const completeInput = async (
    ctx: AdapterCallContext,
    values: Record<string, string>,
  ): Promise<CompletionResult> => {
    const connection = requireConnection(ctx);
    const summary = connection.handoff;
    if (!summary)
      throw new ConnectorError("invalid-request", {
        detail: "supabase.handoff.missing",
      });
    const record = await ctx.environment.handoffs.present(
      ctx.actor,
      summary.handoffRef,
    );
    if (
      !record ||
      record.kind !== "input-required" ||
      record.intent !== TARGET_INTENT ||
      record.connectionRef !== connection.connectionRef ||
      record.bindingRef !== ctx.binding.bindingRef
    )
      throw new ConnectorError("denied", {
        detail: "supabase.handoff.mismatch",
      });
    if (record.generation !== ctx.generation)
      throw new ConnectorError("denied", {
        detail: "supabase.handoff.stale-generation",
      });
    if (record.state !== "issued" && record.state !== "waiting")
      return {
        state: "denied",
        claims: [],
        code: "supabase.target.selection-replayed",
      };
    if (record.expiresAt <= ctx.environment.now()) {
      await ctx.environment.handoffs.complete(
        record.handoffRef,
        ctx.generation,
        "expired",
      );
      return {
        state: "expired",
        claims: [],
        code: "supabase.target.selection-expired",
      };
    }
    const proposed = privateTarget(record);
    const submitted =
      values.targetKind !== undefined || values.targetId !== undefined
        ? parseSupabaseTarget({ kind: values.targetKind, id: values.targetId })
        : undefined;
    if (
      (values.targetKind !== undefined || values.targetId !== undefined) &&
      !submitted
    )
      throw new ConnectorError("invalid-request", {
        detail: "supabase.target.invalid",
      });
    if (proposed && submitted && !sameTarget(proposed, submitted))
      throw new ConnectorError("denied", {
        detail: "supabase.target.mismatch",
      });
    const target = proposed ?? submitted;
    if (!target)
      return {
        state: "human-required",
        claims: [],
        code: "supabase.target.selection-required",
      };
    if (!isPermittedTarget(ctx.binding, target))
      throw new ConnectorError("denied", {
        detail: "supabase.target.not-permitted",
      });
    const current = parseSupabaseTarget(connection.target);
    if (
      current &&
      !sameTarget(current, target) &&
      record.private.account_switch !== "true"
    )
      throw new ConnectorError("denied", {
        detail: "supabase.target.switch-requires-intent",
      });
    const destination = apiDestination(ctx);
    let verification: Verification;
    try {
      verification = await withManagementToken(ctx, (token, material) =>
        verifyTargetWithToken(
          ctx,
          destination,
          token,
          target,
          scopeReport(material),
        ),
      );
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "expired")
        return {
          state: "expired",
          claims: [],
          code: "supabase.management.access-rejected",
        };
      if (
        error instanceof ConnectorError &&
        (error.code === "denied" || error.code === "not-found")
      ) {
        await ctx.environment.handoffs.complete(
          record.handoffRef,
          ctx.generation,
          "denied",
        );
        return {
          state: "denied",
          claims: [],
          code: "supabase.target.unavailable",
        };
      }
      throw error;
    }
    await ctx.environment.handoffs.complete(
      record.handoffRef,
      ctx.generation,
      "completed",
    );
    return {
      state: "complete",
      claims: verification.claims,
      ...(connection.credentialRef
        ? { credentialRef: connection.credentialRef }
        : {}),
      externalIds: verification.externalIds,
      target,
      adapterState: verification.adapterState,
    };
  };

  const projectItem = (
    ctx: AdapterCallContext,
    project: z.infer<typeof projectSchema>,
  ): DiscoveredItem => ({
    identity: {
      ecosystem: SUPABASE_ECOSYSTEM,
      authorityNamespace: project.organization_slug,
      nativeId: project.ref,
      nativeVersion: SUPABASE_MANAGEMENT_PROFILE,
    },
    displayName: safeText(project.name, 200) || project.ref,
    description: `Project ${project.ref} in organization ${project.organization_slug}`,
    provenance: {
      kind: "supabase-project",
      organizationSlug: project.organization_slug,
      region: safeText(project.region, 64),
      status: safeText(project.status, 32),
      permitted: String(
        isPermittedTarget(ctx.binding, {
          kind: "supabase-project",
          id: project.ref,
        }),
      ),
    },
    status: project.status === "REMOVED" ? "deleted" : "active",
  });

  const organizationItem = (
    ctx: AdapterCallContext,
    organization: z.infer<typeof organizationSchema>,
  ): DiscoveredItem => ({
    identity: {
      ecosystem: SUPABASE_ECOSYSTEM,
      authorityNamespace: "",
      nativeId: organization.slug,
      nativeVersion: SUPABASE_MANAGEMENT_PROFILE,
    },
    displayName: safeText(organization.name, 200) || organization.slug,
    description: `Organization ${organization.slug}`,
    provenance: {
      kind: "supabase-organization",
      permitted: String(
        isPermittedTarget(ctx.binding, {
          kind: "supabase-organization",
          id: organization.slug,
        }),
      ),
    },
    status: "active",
  });

  const inventoryIssue = (
    pointer: string,
    code: string,
    severity: "info" | "warning",
    message: string,
  ): CompatibilityIssue => ({
    code,
    category: "structure",
    sourcePointer: pointer,
    dimension: "discover",
    disposition: "adapted",
    severity,
    executionImpact: "none",
    message,
  });

  const adapter: SupabaseManagementAdapter = {
    id: SUPABASE_MANAGEMENT_ADAPTER_ID,
    ecosystem: SUPABASE_ECOSYSTEM,
    adapterVersion: ADAPTER_VERSION,
    runtime: "hosted-server",
    displayName: "Supabase Management API",
    description:
      "Management OAuth for a dashboard user: choose one project or organization, read its inventory. Separate from project users and from the hosted MCP server.",
    service: SUPABASE_SERVICE,
    support: "provider-backed",
    custody: ["host-owned"],
    configuration,
    profiles: ["oauth-authorization-code", SUPABASE_MANAGEMENT_PROFILE],
    capabilities(present: ReadonlySet<string>): CapabilityStatus[] {
      const ready =
        present.has(SUPABASE_OAUTH_CLIENT_ID) &&
        present.has(SUPABASE_OAUTH_CLIENT_SECRET)
          ? "ready"
          : "missing";
      const row = (
        dimension: CapabilityStatus["dimension"],
        input: Partial<
          Pick<
            CapabilityStatus,
            "implementation" | "configuration" | "limitations" | "profile"
          >
        > = {},
      ) =>
        capabilityStatus(adapter, {
          dimension,
          profile: input.profile ?? SUPABASE_MANAGEMENT_PROFILE,
          implementation: input.implementation ?? "implemented",
          configuration:
            input.configuration ??
            (input.implementation === "unsupported" ? "not-applicable" : ready),
          evidence:
            input.implementation === "unsupported"
              ? "not-tested"
              : "protocol-fixture",
          limitations: input.limitations ?? [],
        });
      return [
        row("discover", {
          limitations: [
            "No server pagination is documented for the listings; one bounded response is windowed",
          ],
        }),
        row("import", { implementation: "unsupported" }),
        row("configure", { profile: "oauth-authorization-code" }),
        row("authorize", {
          profile: "oauth-authorization-code",
          limitations: [
            "Scopes are fixed at OAuth app registration; the deprecated scope request parameter is never sent",
            "User-owned grants only; organization-owned connections need host organization identity",
          ],
        }),
        row("verify", {
          limitations: [
            "Account identity comes from GET /v1/profile when the grant permits it; otherwise resource access only",
          ],
        }),
        row("invoke", {
          limitations: [
            "Read-only management operations: list or get projects and organizations, list organization members",
          ],
        }),
        row("events", { implementation: "unsupported" }),
        row("reconnect", { profile: "oauth-authorization-code" }),
        row("disconnect"),
        row("revoke", {
          limitations: [
            "POST /v1/oauth/revoke needs the stored refresh token; without it the user revokes the app in the Supabase dashboard",
          ],
        }),
        row("export", { implementation: "unsupported" }),
        row("delegate", { implementation: "unsupported" }),
      ];
    },
    authorize: (ctx, intent) => start(ctx, intent, "connect"),
    reconnect: (ctx, intent) => start(ctx, intent, "reconnect"),
    async complete(ctx, input) {
      if (input.kind === "redirect") return completeRedirect(ctx, input.url);
      if (input.kind === "input") return completeInput(ctx, input.values);
      if (input.kind === "poll")
        return {
          state: "pending",
          claims: [],
          code: "supabase.oauth.awaiting-callback",
        };
      throw new ConnectorError("unsupported", {
        detail: "supabase.management.event-completion",
      });
    },
    async verify(ctx) {
      const connection = requireConnection(ctx);
      const target = parseSupabaseTarget(connection.target);
      if (!target)
        return {
          state: "human-required",
          claims: [],
          code: "supabase.target.selection-required",
          handoff: targetSelectionHandoff(ctx, undefined, false),
        };
      const destination = apiDestination(ctx);
      try {
        const verification = await withManagementToken(
          ctx,
          (token, material) =>
            verifyTargetWithToken(
              ctx,
              destination,
              token,
              target,
              scopeReport(material),
            ),
        );
        return {
          state: "complete",
          claims: verification.claims,
          ...(connection.credentialRef
            ? { credentialRef: connection.credentialRef }
            : {}),
          externalIds: verification.externalIds,
          target,
          adapterState: verification.adapterState,
        };
      } catch (error) {
        if (error instanceof ConnectorError && error.code === "expired")
          return {
            state: "expired",
            claims: [],
            code: "supabase.management.access-rejected",
          };
        if (
          error instanceof ConnectorError &&
          (error.code === "denied" || error.code === "not-found")
        )
          return {
            state: "denied",
            claims: [],
            code: "supabase.target.unavailable",
          };
        throw error;
      }
    },
    async discover(ctx, input) {
      const kinds = z
        .enum(["supabase-project", "supabase-organization"])
        .optional()
        .parse(input.scope?.kind);
      const wanted = new Set(
        kinds ? [kinds] : ["supabase-project", "supabase-organization"],
      );
      const destination = apiDestination(ctx);
      const issues: CompatibilityIssue[] = [];
      const items = await withManagementToken(ctx, async (token) => {
        const collected: DiscoveredItem[] = [];
        if (wanted.has("supabase-organization")) {
          const raw = await getJson(
            ctx,
            destination,
            "/v1/organizations",
            token,
          );
          const rows = z.array(z.unknown()).parse(raw);
          if (rows.length > maxInventoryItems)
            issues.push(
              inventoryIssue(
                "/v1/organizations",
                "supabase.management.inventory-truncated",
                "warning",
                "Organization listing exceeded the inventory ceiling; later rows were not read",
              ),
            );
          for (const row of rows.slice(0, maxInventoryItems)) {
            const parsed = organizationSchema.safeParse(row);
            if (parsed.success)
              collected.push(organizationItem(ctx, parsed.data));
          }
        }
        if (wanted.has("supabase-project")) {
          const raw = await getJson(ctx, destination, "/v1/projects", token);
          const rows = z.array(z.unknown()).parse(raw);
          if (rows.length > maxInventoryItems)
            issues.push(
              inventoryIssue(
                "/v1/projects",
                "supabase.management.inventory-truncated",
                "warning",
                "Project listing exceeded the inventory ceiling; later rows were not read",
              ),
            );
          for (const row of rows.slice(0, maxInventoryItems)) {
            const parsed = projectSchema.safeParse(row);
            if (parsed.success) collected.push(projectItem(ctx, parsed.data));
          }
        }
        return collected;
      });
      issues.push(
        inventoryIssue(
          "/v1/projects",
          "supabase.management.no-server-pagination",
          "info",
          "The Management API documents no pagination for these listings; the cursor windows one bounded response",
        ),
      );
      const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
      const offset = z.coerce
        .number()
        .int()
        .min(0)
        .max(100_000)
        .parse(input.cursor ?? 0);
      const page = items.slice(offset, offset + limit);
      return {
        items: page,
        ...(offset + limit < items.length
          ? { nextCursor: String(offset + limit) }
          : {}),
        freshness: {
          fetchedAt: ctx.environment.now(),
          stale: false,
          source: "live",
        },
        issues,
      };
    },
    async invoke(ctx, request) {
      const operation = boundOperation(ctx.binding, request.operationRef);
      if (!operation)
        throw new ConnectorError("not-found", {
          detail: "supabase.operation.unknown",
        });
      const spec = Object.hasOwn(
        supabaseManagementOperations,
        operation.nativeId,
      )
        ? supabaseManagementOperations[operation.nativeId]
        : undefined;
      if (!spec)
        throw new ConnectorError("unsupported", {
          detail: "supabase.management.operation-unsupported",
        });
      if (
        operation.transport.kind !== "http" ||
        operation.transport.method !== spec.method ||
        operation.transport.pathTemplate !== spec.pathTemplate
      )
        throw new ConnectorError("denied", {
          detail: "supabase.binding.transport-mismatch",
        });
      if (operation.effect !== "read")
        throw new ConnectorError("denied", {
          detail: "supabase.binding.effect-mismatch",
        });
      if (
        operation.outputClassification === "public" &&
        spec.minimumClassification === "personal"
      )
        throw new ConnectorError("denied", {
          detail: "supabase.binding.classification-too-low",
        });
      const destination = apiDestination(ctx);
      if (destinationFor(ctx.binding, operation).id !== destination.id)
        throw new ConnectorError("network-policy", {
          detail: "supabase.management.destination-not-pinned",
        });
      const connection = requireConnection(ctx);
      const target = parseSupabaseTarget(connection.target);
      if (!target)
        throw new ConnectorError("human-required", {
          detail: "supabase.target.selection-required",
        });
      const organizationOfTarget =
        target.kind === "supabase-organization"
          ? target.id
          : typeof connection.state.organizationSlug === "string"
            ? connection.state.organizationSlug
            : undefined;
      let path = spec.pathTemplate;
      if (spec.targetParameter) {
        const { name, kind } = spec.targetParameter;
        if (!operation.targetParameters.includes(name))
          throw new ConnectorError("denied", {
            detail: "supabase.binding.target-parameter-undeclared",
          });
        const input = z
          .strictObject({
            [name]:
              kind === "supabase-project"
                ? projectRefSchema
                : organizationSlugSchema,
          })
          .parse(request.input ?? {});
        const value = input[name] as string;
        const inScope =
          kind === target.kind
            ? value === target.id
            : kind === "supabase-organization"
              ? value === organizationOfTarget
              : true; // A project under an organization target is checked after the read.
        if (!inScope)
          throw new ConnectorError("denied", {
            detail: "supabase.target.out-of-scope",
          });
        path = spec.pathTemplate.replace(
          `{${name}}`,
          encodePathSegment(value),
        );
      }
      const raw = await withManagementToken(ctx, (token) =>
        getJson(ctx, destination, path, token),
      );
      let output: unknown;
      try {
        switch (operation.nativeId) {
          case "v1-list-all-projects":
            output = boundedArray(projectSchema)
              .parse(raw)
              .filter((project) =>
                target.kind === "supabase-project"
                  ? project.ref === target.id
                  : project.organization_slug === target.id,
              )
              .map((project) => ({
                ref: project.ref,
                name: safeText(project.name, 256),
                organizationSlug: project.organization_slug,
                region: safeText(project.region, 64),
                status: safeText(project.status, 32),
                createdAt: safeText(project.created_at, 64),
              }));
            break;
          case "v1-get-project": {
            const project = projectSchema.parse(raw);
            if (
              target.kind === "supabase-organization" &&
              project.organization_slug !== target.id
            )
              throw new ConnectorError("denied", {
                detail: "supabase.target.out-of-scope",
              });
            output = {
              ref: project.ref,
              name: safeText(project.name, 256),
              organizationSlug: project.organization_slug,
              region: safeText(project.region, 64),
              status: safeText(project.status, 32),
              createdAt: safeText(project.created_at, 64),
            };
            break;
          }
          case "v1-list-all-organizations":
            output = boundedArray(organizationSchema)
              .parse(raw)
              .filter((organization) =>
                organizationOfTarget
                  ? organization.slug === organizationOfTarget
                  : false,
              )
              .map((organization) => ({
                slug: organization.slug,
                name: safeText(organization.name, 256),
              }));
            break;
          case "v1-get-an-organization": {
            const organization = organizationDetailSchema.parse(raw);
            output = {
              slug: organizationOfTarget,
              name: safeText(organization.name, 256),
              ...(organization.plan
                ? { plan: safeText(organization.plan, 32) }
                : {}),
            };
            break;
          }
          case "v1-list-organization-members":
            output = boundedArray(memberSchema)
              .parse(raw)
              .map((member) => ({
                userId: safeText(member.user_id, 128),
                userName: safeText(member.user_name, 256),
                ...(member.email ? { email: safeText(member.email, 320) } : {}),
                ...(member.role_name
                  ? { roleName: safeText(member.role_name, 64) }
                  : {}),
                mfaEnabled: member.mfa_enabled,
              }));
            break;
          default:
            throw new ConnectorError("unsupported", {
              detail: "supabase.management.operation-unsupported",
            });
        }
      } catch (error) {
        if (error instanceof z.ZodError)
          throw new ConnectorError("upstream-rejected", {
            detail: "supabase.management.response-shape",
          });
        throw error;
      }
      return {
        state: "complete",
        output,
        outputClassification: operation.outputClassification,
        effect: "read",
      };
    },
    async disconnect(ctx, scope) {
      if (scope === "broker")
        return {
          local: "not-attempted",
          broker: "unsupported",
          upstream: "not-attempted",
        };
      if (scope === "upstream") return adapter.revoke(ctx);
      const connection = requireConnection(ctx);
      await ctx.environment.handoffs.cancelAll(
        connection.connectionRef,
        "supabase.disconnect",
      );
      if (connection.credentialRef)
        await ctx.environment.credentials.revoke(
          credentialScope(ctx, connection.connectionRef),
          connection.credentialRef,
        );
      return {
        local: "applied",
        broker: "not-attempted",
        upstream: "not-attempted",
      };
    },
    async revoke(ctx) {
      const connection = requireConnection(ctx);
      await ctx.environment.handoffs.cancelAll(
        connection.connectionRef,
        "supabase.revoke",
      );
      const scope = credentialScope(ctx, connection.connectionRef);
      const credentialRef = connection.credentialRef;
      if (!credentialRef)
        return {
          local: "applied",
          broker: "not-attempted",
          upstream: "not-attempted",
        };
      const destination = apiDestination(ctx);
      let upstream: DisconnectResult["upstream"] = "not-attempted";
      try {
        upstream = await ctx.environment.credentials.use(
          scope,
          credentialRef,
          async (material): Promise<DisconnectResult["upstream"]> => {
            assertCredentialKind(material, "management-access-token");
            const refreshToken = material.refresh_token;
            // POST /v1/oauth/revoke requires the refresh token; a grant without one
            // (jwt-bearer) is documented as not revocable through the API.
            if (!refreshToken) return "unsupported";
            const clientId = await readClientId(ctx);
            const secret = await readClientSecret(ctx);
            const effect = await ctx.environment.effects.begin({
              actor: ctx.actor,
              connectionRef: connection.connectionRef,
              bindingRef: ctx.binding.bindingRef,
              operation: "supabase.management.oauth.revoke",
              digest: sha256Hex(
                `${connection.connectionRef}:${ctx.generation}:${credentialRef}`,
              ),
            });
            if (effect.prior)
              return effect.prior.status === "applied"
                ? "applied"
                : "indeterminate";
            let response: Response;
            try {
              response = await ctx.environment.fetch(
                destinationUrl(destination, "/v1/oauth/revoke"),
                {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    accept: "application/json",
                  },
                  body: JSON.stringify({
                    client_id: clientId,
                    client_secret: secret,
                    refresh_token: refreshToken,
                  }),
                  redirect: "error",
                  signal: boundedSignal(ctx, requestTimeoutMs),
                },
              );
            } catch {
              await ctx.environment.effects.complete(effect.effectRef, {
                status: "indeterminate",
                at: ctx.environment.now(),
              });
              return "indeterminate";
            }
            await discardBody(response);
            const applied = response.status === 204 || response.status === 200;
            await ctx.environment.effects.complete(effect.effectRef, {
              status: applied ? "applied" : "failed",
              at: ctx.environment.now(),
            });
            return applied ? "applied" : "failed";
          },
        );
      } catch (error) {
        if (error instanceof ConnectorError && error.code === "denied")
          throw error;
        upstream = "failed";
      }
      await ctx.environment.credentials.revoke(scope, credentialRef);
      return { local: "applied", broker: "not-attempted", upstream };
    },
  };
  return adapter;
}

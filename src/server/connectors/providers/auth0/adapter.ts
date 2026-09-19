import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose";
import {
  canonicalDigest,
  type OwnerKind,
} from "../../../../core/connectors/index.js";
import {
  boundOperation,
  destinationFor,
  destinationUrl,
  type ApprovedDestination,
  type BoundOperation,
  type RuntimeBinding,
} from "../../binding.js";
import { ConnectorError } from "../../errors.js";
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
  type DisconnectScope,
  type DiscoverResult,
  type InvokeRequest,
  type InvokeResult,
  type VerificationClaim,
} from "../../adapter.js";
import type { CredentialScope } from "../../ports.js";
import { parseJson, send } from "./http.js";
import type {
  HeldToken,
  HostIdentityTokenPort,
  HostSubjectToken,
} from "./ports.js";
import {
  AUTH0_ACCOUNTS_PATH,
  AUTH0_ADAPTER_ID,
  AUTH0_ADAPTER_VERSION,
  AUTH0_COMPLETE_PATH,
  AUTH0_CONNECTIONS_PATH,
  AUTH0_CONNECT_PATH,
  AUTH0_DEFAULT_RETURN_PATH,
  AUTH0_DESTINATION_ID,
  AUTH0_EXCHANGE_ACTION,
  AUTH0_INVENTORY_ACTION,
  AUTH0_JWKS_PATH,
  AUTH0_TOKEN_PATH,
  AUTH0_TOKEN_VAULT_GRANT,
  auth0AccountsResponseSchema,
  auth0CompleteResponseSchema,
  auth0ConnectResponseSchema,
  auth0ConnectionsResponseSchema,
  auth0DeniedErrors,
  auth0ErrorSchema,
  auth0ExchangeResponseSchema,
  auth0JwksSchema,
  auth0Profiles,
  auth0ReconnectErrors,
  auth0SettingsSchema,
  tenantIssuer,
  type Auth0Settings,
} from "./wire.js";

/*
 * Auth0 Token Vault.
 *
 * Auth0 keeps the upstream provider's access and refresh tokens; this adapter
 * exchanges a token the host already holds for the user — an Auth0 refresh
 * token or an Auth0 access token — for a short-lived provider token that goes
 * straight into custody. Custody is therefore `external-credential-broker`
 * throughout: Auth0 remains the holder of record, and what this deployment
 * keeps is a short-lived, scoped copy for the operation it was fetched for.
 *
 * The exchange is bound on five axes before the subject token leaves custody:
 * the configured tenant issuer (exact, never canonicalized for display), the
 * subject-token types the binding permits, the upstream connection the binding
 * names, the Auth0 subject the connection was established for, and — for an
 * access-token exchange — the audience that token was issued for. A token that
 * is valid for another tenant, another person or another API is refused here,
 * before it is presented to anything (AC-AUTH-05, AC-EXT-06). Claims are
 * verified against the tenant's published keys with `jose`; nothing is decoded
 * and believed.
 *
 * Sources (retrieved 2026-09-18):
 *   https://auth0.com/docs/secure/tokens/token-vault
 *   https://auth0.com/docs/secure/tokens/token-vault/configure-token-vault
 *   https://auth0.com/docs/secure/tokens/token-vault/refresh-token-exchange-with-token-vault
 *   https://auth0.com/docs/secure/tokens/token-vault/access-token-exchange-with-token-vault
 *   https://auth0.com/docs/secure/tokens/token-vault/privileged-worker-token-exchange-with-token-vault
 *   https://auth0.com/docs/secure/tokens/token-vault/connected-accounts-for-token-vault
 *   https://auth0.com/docs/oas/myaccount/myaccount-api-oas.json (My Account API 1.0)
 */

export interface Auth0TokenVaultAdapterOptions {
  /** Host custody of the user's Auth0 tokens and the My Account API token. */
  identity: HostIdentityTokenPort;
  returnPath?: string;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  handoffSeconds?: number;
  /** How long a fetched JWKS may be reused; the tenant rotates keys on its own schedule. */
  jwksTtlMs?: number;
}

const CONFIGURATION = Object.freeze([
  {
    name: "AUTH0_DOMAIN",
    source: "session-environment" as const,
    classification: "public" as const,
    required: true,
    description: "Auth0 tenant domain; the only source of the tenant origin.",
  },
  {
    name: "AUTH0_CLIENT_ID",
    source: "session-environment" as const,
    classification: "public" as const,
    required: true,
    description: "Client id registered with the Token Vault grant.",
  },
  {
    name: "AUTH0_CLIENT_SECRET",
    source: "session-environment" as const,
    classification: "secret" as const,
    required: true,
    description: "Client secret used to authenticate the token exchange.",
  },
]);
const configurationNames = CONFIGURATION.map((item) => item.name);

const domainPattern = /^[a-z0-9.-]+(?::\d{2,5})?$/i;

type Resolved = {
  settings: Auth0Settings;
  destination: ApprovedDestination;
  origin: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
};

function settingsFor(binding: RuntimeBinding): Auth0Settings {
  const parsed = auth0SettingsSchema.safeParse(binding.settings);
  if (!parsed.success)
    throw new ConnectorError("invalid-request", {
      detail: "auth0.settings.invalid",
    });
  if (binding.custody !== "external-credential-broker")
    throw new ConnectorError("denied", { detail: "auth0.custody.mismatch" });
  if (
    binding.profileId !== undefined &&
    binding.profileId !== auth0Profiles.tokenVault
  )
    throw new ConnectorError("denied", { detail: "auth0.profile.mismatch" });
  return parsed.data;
}

export function createAuth0TokenVaultAdapter(
  options: Auth0TokenVaultAdapterOptions,
): ConnectorAdapter {
  const returnPath = options.returnPath ?? AUTH0_DEFAULT_RETURN_PATH;
  const timeoutMs = options.requestTimeoutMs ?? 20_000;
  const maxBytes = options.maxResponseBytes ?? 256 * 1024;
  const handoffSeconds = options.handoffSeconds ?? 900;
  const jwksTtlMs = options.jwksTtlMs ?? 300_000;
  const jwksCache = new Map<
    string,
    { fetchedAt: number; keys: ReturnType<typeof createLocalJWKSet> }
  >();

  /**
   * The tenant origin comes from configuration and nowhere else, and the
   * binding's approved destination has to be exactly it. A binding that names
   * another origin is a policy failure, not a redirect to follow.
   */
  async function resolve(ctx: AdapterCallContext): Promise<Resolved> {
    const settings = settingsFor(ctx.binding);
    const present =
      await ctx.environment.configuration.present(configurationNames);
    if (configurationNames.some((name) => !present.has(name)))
      throw new ConnectorError("configuration-required", {
        detail: "auth0.configuration.missing",
      });
    const domain = await ctx.environment.configuration.read("AUTH0_DOMAIN");
    const clientId =
      await ctx.environment.configuration.read("AUTH0_CLIENT_ID");
    const clientSecret = await ctx.environment.configuration.read(
      "AUTH0_CLIENT_SECRET",
    );
    if (!domain || !clientId || !clientSecret)
      throw new ConnectorError("configuration-required", {
        detail: "auth0.configuration.missing",
      });
    if (!domainPattern.test(domain))
      throw new ConnectorError("invalid-request", {
        detail: "auth0.domain.invalid",
      });
    const destination = ctx.binding.destinations.find(
      (item) => item.id === AUTH0_DESTINATION_ID,
    );
    if (!destination)
      throw new ConnectorError("network-policy", {
        detail: "auth0.destination.unapproved",
      });
    const expected =
      destination.network === "loopback-fixture"
        ? `http://${domain}`
        : `https://${domain}`;
    if (destination.origin !== expected)
      throw new ConnectorError("network-policy", {
        detail: "auth0.destination.mismatch",
      });
    return {
      settings,
      destination,
      origin: destination.origin,
      issuer: tenantIssuer(destination.origin),
      clientId,
      clientSecret,
    };
  }

  async function jwks(ctx: AdapterCallContext, resolved: Resolved) {
    const cached = jwksCache.get(resolved.origin);
    if (cached && ctx.environment.now() - cached.fetchedAt < jwksTtlMs)
      return cached.keys;
    const response = await send(
      ctx,
      destinationUrl(resolved.destination, AUTH0_JWKS_PATH),
      { method: "GET", headers: { accept: "application/json" } },
      { timeoutMs, maxBytes },
    );
    if (response.status !== 200)
      throw new ConnectorError("upstream-unavailable", {
        detail: "auth0.jwks.unavailable",
      });
    const parsed = auth0JwksSchema.safeParse(parseJson(response.body));
    if (!parsed.success)
      throw new ConnectorError("upstream-rejected", {
        detail: "auth0.jwks.unreadable",
      });
    const keys = createLocalJWKSet(
      parsed.data as unknown as Parameters<typeof createLocalJWKSet>[0],
    );
    jwksCache.set(resolved.origin, {
      fetchedAt: ctx.environment.now(),
      keys,
    });
    return keys;
  }

  const looksLikeJwt = (value: string) =>
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(value);

  /**
   * Verifies an Auth0-issued JWT against the tenant's published keys, with the
   * issuer, audience and subject the binding expects. Anything that does not
   * verify is refused; nothing is read out of an unverified token.
   */
  async function verifyTenantJwt(
    ctx: AdapterCallContext,
    resolved: Resolved,
    token: string,
    expected: { audience?: string; subject?: string },
  ): Promise<void> {
    const keys = await jwks(ctx, resolved);
    try {
      await jwtVerify(token, keys, {
        issuer: resolved.issuer,
        ...(expected.audience ? { audience: expected.audience } : {}),
        ...(expected.subject ? { subject: expected.subject } : {}),
      });
    } catch {
      throw new ConnectorError("denied", { detail: "auth0.token.unverified" });
    }
  }

  /**
   * Everything the binding requires of the subject token before it is sent:
   * a permitted type, the connection's expected Auth0 subject, and for an
   * access token the audience the binding approved. A JWT is verified against
   * the tenant keys rather than decoded.
   */
  async function assertSubjectToken(
    ctx: AdapterCallContext,
    resolved: Resolved,
    held: HostSubjectToken,
  ): Promise<void> {
    if (!resolved.settings.subjectTokenTypes.includes(held.tokenType))
      throw new ConnectorError("denied", {
        detail: "auth0.subject-token.type",
      });
    if (held.expiresAt !== undefined && held.expiresAt <= ctx.environment.now())
      throw new ConnectorError("expired", {
        detail: "auth0.subject-token.expired",
      });
    const expectedSubject = ctx.connection?.externalIds.auth0Subject;
    if (expectedSubject && expectedSubject !== held.subject)
      throw new ConnectorError("denied", {
        detail: "auth0.subject.mismatch",
      });
    if (held.tokenType === "urn:ietf:params:oauth:token-type:access_token") {
      // An access token is only usable here when it was issued for the API this
      // binding approved. A token the same person holds for another API is a
      // different authority (AC-AUTH-05).
      if (!resolved.settings.expectedAudience)
        throw new ConnectorError("denied", {
          detail: "auth0.audience.unbound",
        });
      if (held.audience !== resolved.settings.expectedAudience)
        throw new ConnectorError("denied", {
          detail: "auth0.audience.mismatch",
        });
      await held.use(async (token) => {
        if (!looksLikeJwt(token))
          throw new ConnectorError("denied", {
            detail: "auth0.subject-token.opaque",
          });
        await verifyTenantJwt(ctx, resolved, token, {
          audience: resolved.settings.expectedAudience!,
          subject: held.subject,
        });
      });
    }
  }

  function form(values: Record<string, string | undefined>): string {
    const body = new URLSearchParams();
    for (const [name, value] of Object.entries(values))
      if (value !== undefined) body.set(name, value);
    return body.toString();
  }

  async function beginEffect(
    ctx: AdapterCallContext,
    operation: string,
    payload: unknown,
    commandId?: string,
  ) {
    return ctx.environment.effects.begin({
      actor: ctx.actor,
      ...(ctx.connection
        ? { connectionRef: ctx.connection.connectionRef }
        : {}),
      bindingRef: ctx.binding.bindingRef,
      operation,
      digest: await canonicalDigest(payload),
      ...(commandId ? { commandId } : {}),
    });
  }

  async function subjectTokenFor(
    ctx: AdapterCallContext,
    ownerKind: OwnerKind,
    ownerId: string,
  ): Promise<HostSubjectToken> {
    const held = await options.identity.subjectToken({
      actor: ctx.actor,
      tenantId: ctx.binding.tenantId,
      ownerKind,
      ownerId,
      ...(ctx.connection
        ? { connectionRef: ctx.connection.connectionRef }
        : {}),
    });
    if (!held)
      throw new ConnectorError("denied", {
        detail: "auth0.subject-token.absent",
      });
    return held;
  }

  async function myAccountToken(
    ctx: AdapterCallContext,
    ownerKind: OwnerKind,
    ownerId: string,
  ): Promise<HeldToken> {
    const held = await options.identity.myAccountToken?.({
      actor: ctx.actor,
      tenantId: ctx.binding.tenantId,
      ownerKind,
      ownerId,
      ...(ctx.connection
        ? { connectionRef: ctx.connection.connectionRef }
        : {}),
    });
    if (!held)
      throw new ConnectorError("configuration-required", {
        detail: "auth0.my-account.unavailable",
      });
    return held;
  }

  /** Reads this user's linked accounts, optionally narrowed to the bound connection. */
  async function listAccounts(
    ctx: AdapterCallContext,
    resolved: Resolved,
    token: HeldToken,
    connection?: string,
  ) {
    const url = destinationUrl(resolved.destination, AUTH0_ACCOUNTS_PATH);
    if (connection) url.searchParams.set("connection", connection);
    const response = await token.use((value) =>
      send(
        ctx,
        url,
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${value}`,
            accept: "application/json",
          },
        },
        { timeoutMs, maxBytes },
      ),
    );
    if (response.status === 401 || response.status === 403)
      throw new ConnectorError("denied", { detail: "auth0.my-account.denied" });
    if (response.status === 429)
      throw new ConnectorError("rate-limited", { detail: "auth0.throttled" });
    if (response.status !== 200)
      throw new ConnectorError(
        response.status >= 500 ? "upstream-unavailable" : "upstream-rejected",
        { detail: "auth0.accounts.rejected" },
      );
    const parsed = auth0AccountsResponseSchema.safeParse(
      parseJson(response.body),
    );
    if (!parsed.success)
      throw new ConnectorError("upstream-rejected", {
        detail: "auth0.accounts.unreadable",
      });
    return parsed.data;
  }

  function claimFor(
    ctx: AdapterCallContext,
    resolved: Resolved,
    account: {
      id: string;
      connection: string;
      scopes?: string[] | undefined;
    },
    subject: string,
  ): VerificationClaim {
    const observedAt = new Date(ctx.environment.now()).toISOString();
    return {
      kind: "account-identity",
      evidenceRef: `evidence:auth0:${account.id}`,
      issuer: "external-broker",
      target: { kind: "connected-account", id: account.id },
      observedAt,
      validUntil: new Date(
        ctx.environment.now() + resolved.settings.verificationTtlSeconds * 1000,
      ).toISOString(),
      verifierVersion: AUTH0_ADAPTER_VERSION,
      bindingRevision: ctx.binding.revision,
      policyRevision: ctx.binding.policyRevision,
      permissions: {
        requested: [...resolved.settings.connectScopes],
        reported: [...(account.scopes ?? [])],
        observed: [],
        semantics: "provider-scopes",
      },
      limitations: [
        `Auth0 reports this account for subject ${subject} on connection ${account.connection}; the upstream provider was not contacted by this deployment.`,
        "Scopes are the ones Auth0 recorded at link time, not an observation of what the upstream token can do.",
      ],
    };
  }

  /* --------------------------------------------------------------- linking */

  async function startConnect(
    ctx: AdapterCallContext,
    intent: AuthorizationIntent,
  ): Promise<AuthorizationStart> {
    const resolved = await resolve(ctx);
    if (intent.ownerKind !== "user")
      // Auth0 stores a connected account on the individual user's profile;
      // organizations set the session context and do not own the account.
      throw new ConnectorError("unsupported", {
        detail: "auth0.owner.unsupported",
      });
    if (intent.interruption === "none")
      return { kind: "human-required", code: "auth0.connect.attended" };
    const token = await myAccountToken(
      ctx,
      intent.ownerKind,
      ctx.connection?.ownerId ?? ctx.actor.subjectId,
    );
    const state = `auth0:${ctx.environment.random.uuid()}`;
    const redirectUri = new URL(returnPath, ctx.environment.origin).href;
    const body: Record<string, unknown> = {
      connection: resolved.settings.connection,
      redirect_uri: redirectUri,
      state,
    };
    if (resolved.settings.connectScopes.length)
      body.scopes = [...resolved.settings.connectScopes];
    const effect = await beginEffect(ctx, "auth0.connected-account.connect", {
      connection: resolved.settings.connection,
      state,
    });
    const response = await token.use((value) =>
      send(
        ctx,
        destinationUrl(resolved.destination, AUTH0_CONNECT_PATH),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${value}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(body),
        },
        { timeoutMs, maxBytes },
      ),
    );
    if (response.status !== 200 && response.status !== 201) {
      await ctx.environment.effects.complete(effect.effectRef, {
        status: "not-applied",
        at: ctx.environment.now(),
      });
      if (response.status === 401 || response.status === 403)
        throw new ConnectorError("denied", {
          detail: "auth0.my-account.denied",
        });
      throw new ConnectorError(
        response.status >= 500 ? "upstream-unavailable" : "upstream-rejected",
        { detail: "auth0.connect.rejected" },
      );
    }
    const parsed = auth0ConnectResponseSchema.safeParse(
      parseJson(response.body),
    );
    if (!parsed.success) {
      await ctx.environment.effects.complete(effect.effectRef, {
        status: "failed",
        at: ctx.environment.now(),
      });
      throw new ConnectorError("upstream-rejected", {
        detail: "auth0.connect.unreadable",
      });
    }
    const connectUri = new URL(parsed.data.connect_uri);
    if (connectUri.origin !== resolved.origin)
      throw new ConnectorError("denied", {
        detail: "auth0.connect.foreign-origin",
      });
    connectUri.searchParams.set("ticket", parsed.data.connect_params.ticket);
    await ctx.environment.effects.complete(effect.effectRef, {
      status: "applied",
      at: ctx.environment.now(),
    });
    return {
      kind: "handoff",
      handoff: {
        kind: "provider-browser",
        presentation: "popup",
        expiresAt:
          ctx.environment.now() +
          Math.min(parsed.data.expires_in, handoffSeconds) * 1000,
        intent: "auth0.connected-account.link",
        correlationKey: state,
        // The ticket and the session identifier are protected transient
        // material: they complete the link exactly once, for this person.
        private: {
          url: connectUri.href,
          authSession: parsed.data.auth_session,
          redirectUri,
          connection: resolved.settings.connection,
          accountSwitch: intent.accountSwitch ? "true" : "false",
        },
      },
    };
  }

  async function completeConnect(
    ctx: AdapterCallContext,
    url: URL,
  ): Promise<CompletionResult> {
    const resolved = await resolve(ctx);
    const handoff = ctx.handoff;
    const state = url.searchParams.get("state");
    if (!handoff || !state || handoff.correlationKey !== state)
      return {
        state: "denied",
        claims: [],
        code: "auth0.callback.correlation",
      };
    if (handoff.generation !== ctx.generation)
      return { state: "denied", claims: [], code: "auth0.callback.stale" };
    const connectCode = url.searchParams.get("connect_code");
    if (!connectCode)
      return {
        state: "pending",
        claims: [],
        code: "auth0.callback.incomplete",
      };
    const ownerId = ctx.connection?.ownerId ?? ctx.actor.subjectId;
    const token = await myAccountToken(ctx, "user", ownerId);
    const effect = await beginEffect(ctx, "auth0.connected-account.complete", {
      authSession: handoff.private.authSession,
      connectCode,
    });
    if (effect.prior && effect.prior.status === "applied")
      // A connect code is single use; a second delivery of the same callback
      // is the earlier outcome, never a second link.
      return { state: "complete", claims: [], code: "auth0.callback.replayed" };
    const response = await token.use((value) =>
      send(
        ctx,
        destinationUrl(resolved.destination, AUTH0_COMPLETE_PATH),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${value}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            auth_session: handoff.private.authSession,
            connect_code: connectCode,
            redirect_uri: handoff.private.redirectUri,
          }),
        },
        { timeoutMs, maxBytes },
      ),
    );
    if (response.status === 409) {
      await ctx.environment.effects.complete(effect.effectRef, {
        status: "not-applied",
        at: ctx.environment.now(),
      });
      return { state: "denied", claims: [], code: "auth0.callback.conflict" };
    }
    if (response.status !== 200 && response.status !== 201) {
      await ctx.environment.effects.complete(effect.effectRef, {
        status: "not-applied",
        at: ctx.environment.now(),
      });
      return { state: "denied", claims: [], code: "auth0.connect.rejected" };
    }
    const parsed = auth0CompleteResponseSchema.safeParse(
      parseJson(response.body),
    );
    if (!parsed.success) {
      await ctx.environment.effects.complete(effect.effectRef, {
        status: "failed",
        at: ctx.environment.now(),
      });
      throw new ConnectorError("upstream-rejected", {
        detail: "auth0.connect.unreadable",
      });
    }
    // The link is only usable if it is on the connection this binding names:
    // a link established for another provider is not this connection.
    if (parsed.data.connection !== resolved.settings.connection) {
      await ctx.environment.effects.complete(effect.effectRef, {
        status: "not-applied",
        at: ctx.environment.now(),
      });
      return { state: "denied", claims: [], code: "auth0.connection.mismatch" };
    }
    await ctx.environment.effects.complete(effect.effectRef, {
      status: "applied",
      at: ctx.environment.now(),
    });
    const held = await subjectTokenFor(ctx, "user", ownerId);
    return {
      state: "complete",
      claims: [claimFor(ctx, resolved, parsed.data, held.subject)],
      externalIds: {
        connectedAccountId: parsed.data.id,
        auth0Connection: parsed.data.connection,
        auth0Subject: held.subject,
      },
      target: { kind: "connected-account", id: parsed.data.id },
      adapterState: {
        accessType: parsed.data.access_type ?? "unknown",
        scopes: [...(parsed.data.scopes ?? [])],
      },
    };
  }

  /* -------------------------------------------------------------- exchange */

  function mapExchangeFailure(
    status: number,
    payload: unknown,
  ):
    { kind: "human"; code: string } | { kind: "error"; error: ConnectorError } {
    const parsed = auth0ErrorSchema.safeParse(payload);
    const code = parsed.success ? (parsed.data.error ?? "") : "";
    if (status === 429)
      return {
        kind: "error",
        error: new ConnectorError("rate-limited", {
          detail: "auth0.throttled",
        }),
      };
    if (status >= 500)
      return {
        kind: "error",
        error: new ConnectorError("upstream-unavailable", {
          detail: "auth0.unavailable",
        }),
      };
    if (code === "unsupported_grant_type")
      // The tenant does not offer this exchange. That is a configuration fact
      // to report, not something to retry with a different grant.
      return {
        kind: "error",
        error: new ConnectorError("unsupported", {
          detail: "auth0.grant.unsupported",
        }),
      };
    if (code === "mfa_required")
      return { kind: "human", code: "auth0.mfa-required" };
    if (auth0ReconnectErrors.has(code))
      return { kind: "human", code: "auth0.reconnect-required" };
    if (auth0DeniedErrors.has(code))
      return {
        kind: "error",
        error: new ConnectorError("denied", {
          detail: "auth0.client.rejected",
        }),
      };
    if (status === 401 || status === 403)
      // Auth0 documents a 401 when it cannot find the user or the connected
      // account for this connection: the person has to link it again.
      return { kind: "human", code: "auth0.reconnect-required" };
    return {
      kind: "error",
      error: new ConnectorError("upstream-rejected", {
        detail: "auth0.exchange.rejected",
      }),
    };
  }

  async function exchange(
    ctx: AdapterCallContext,
    resolved: Resolved,
    operation: BoundOperation,
    request: InvokeRequest,
  ): Promise<InvokeResult> {
    if (!ctx.connection)
      throw new ConnectorError("invalid-request", {
        detail: "auth0.connection.required",
      });
    const connectedAccountId = ctx.connection.externalIds.connectedAccountId;
    if (!connectedAccountId)
      // Account selection is explicit: without an approved linked account
      // there is nothing to exchange for.
      return {
        state: "human-required",
        outputClassification: "public",
        effect: "read",
        code: "auth0.account.unselected",
      };
    const boundConnection = ctx.connection.externalIds.auth0Connection;
    if (boundConnection && boundConnection !== resolved.settings.connection)
      throw new ConnectorError("denied", {
        detail: "auth0.connection.mismatch",
      });
    const held = await subjectTokenFor(
      ctx,
      ctx.connection.ownerKind,
      ctx.connection.ownerId,
    );
    await assertSubjectToken(ctx, resolved, held);
    const loginHint =
      resolved.settings.useLoginHint &&
      typeof ctx.connection.state.loginHint === "string"
        ? ctx.connection.state.loginHint
        : undefined;
    const effect = await beginEffect(
      ctx,
      "auth0.token-vault.exchange",
      {
        connection: resolved.settings.connection,
        subject: held.subject,
        subjectTokenType: held.tokenType,
        requestedTokenType: resolved.settings.requestedTokenType,
        connectedAccountId,
        scope: resolved.settings.requestedScopes.join(" "),
      },
      request.commandId,
    );
    const body = form({
      grant_type: AUTH0_TOKEN_VAULT_GRANT,
      client_id: resolved.clientId,
      client_secret: resolved.clientSecret,
      subject_token_type: held.tokenType,
      requested_token_type: resolved.settings.requestedTokenType,
      connection: resolved.settings.connection,
      ...(resolved.settings.requestedScopes.length
        ? { scope: resolved.settings.requestedScopes.join(" ") }
        : {}),
      ...(loginHint ? { login_hint: loginHint } : {}),
    });
    const response = await held.use((token) =>
      send(
        ctx,
        destinationUrl(resolved.destination, AUTH0_TOKEN_PATH),
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body: `${body}&subject_token=${encodeURIComponent(token)}`,
        },
        { timeoutMs, maxBytes },
      ),
    );
    const payload = parseJson(response.body);
    if (response.status !== 200) {
      await ctx.environment.effects.complete(effect.effectRef, {
        status: "not-applied",
        code: "rejected",
        at: ctx.environment.now(),
      });
      const mapped = mapExchangeFailure(response.status, payload);
      if (mapped.kind === "error") throw mapped.error;
      return {
        state: "human-required",
        outputClassification: "public",
        effect: "read",
        code: mapped.code,
        effectRef: effect.effectRef,
      };
    }
    const parsed = auth0ExchangeResponseSchema.safeParse(payload);
    if (!parsed.success) {
      await ctx.environment.effects.complete(effect.effectRef, {
        status: "failed",
        at: ctx.environment.now(),
      });
      throw new ConnectorError("upstream-rejected", {
        detail: "auth0.exchange.unreadable",
      });
    }
    if (
      parsed.data.issued_token_type &&
      parsed.data.issued_token_type !== resolved.settings.requestedTokenType
    ) {
      await ctx.environment.effects.complete(effect.effectRef, {
        status: "not-applied",
        at: ctx.environment.now(),
      });
      throw new ConnectorError("upstream-rejected", {
        detail: "auth0.exchange.token-type",
      });
    }
    // The upstream provider's token is usually opaque. When it is a JWS that
    // claims this tenant as issuer, it is verified against the tenant keys
    // rather than decoded and believed; a forgery is refused here.
    //
    // "Claims this tenant" means the `iss` claim, not merely the presence of a
    // `kid`. Token Vault federates providers whose own access tokens are JWTs
    // signed by that provider (Entra, for instance), and every such token
    // carries a `kid`: checking for one sent correct exchanges to the tenant's
    // JWKS, where they cannot verify, and reported them as forgeries. `iss` is
    // read from the still-unverified token for this routing decision alone —
    // a token that does claim the tenant has to verify before anything is
    // believed, and one that claims another issuer is stored with
    // `tokenClaimsVerified: false`, which is the honest statement that this
    // adapter observed nothing about its signature.
    let verified = false;
    if (looksLikeJwt(parsed.data.access_token)) {
      let claimsTenant = false;
      try {
        claimsTenant =
          decodeJwt(parsed.data.access_token).iss === resolved.issuer;
      } catch {
        claimsTenant = false;
      }
      if (claimsTenant) {
        try {
          await verifyTenantJwt(ctx, resolved, parsed.data.access_token, {
            subject: held.subject,
          });
        } catch (error) {
          // The exchange happened upstream and its journal entry was opened
          // before the call, so this exit completes it like the neighbouring
          // ones: the tenant issued a token, nothing was applied here, and a
          // `begin` with no outcome would leave the effect to reconcile
          // forever.
          await ctx.environment.effects.complete(effect.effectRef, {
            status: "not-applied",
            code: "unverified",
            at: ctx.environment.now(),
          });
          throw error;
        }
        verified = true;
      }
    }
    const expiresAt =
      ctx.environment.now() +
      (parsed.data.expires_in ?? resolved.settings.tokenLeaseSeconds) * 1000;
    const scope: CredentialScope = {
      tenantId: ctx.binding.tenantId,
      ownerKind: ctx.connection.ownerKind,
      ownerId: ctx.connection.ownerId,
      connectionRef: ctx.connection.connectionRef,
      bindingRef: ctx.binding.bindingRef,
      custody: "external-credential-broker",
    };
    const credentialRef = await ctx.environment.credentials.store(
      scope,
      { access_token: parsed.data.access_token },
      {
        expiresAt,
        ...(ctx.connection.credentialRef
          ? { replaces: ctx.connection.credentialRef }
          : {}),
      },
    );
    await ctx.environment.effects.complete(effect.effectRef, {
      status: "applied",
      at: ctx.environment.now(),
    });
    return {
      state: "complete",
      output: {
        credentialRef,
        expiresAt: new Date(expiresAt).toISOString(),
        connection: resolved.settings.connection,
        connectedAccountId,
        scopes: (parsed.data.scope ?? "").split(" ").filter(Boolean),
        tokenClaimsVerified: verified,
      },
      outputClassification: operation.outputClassification,
      effect: "read",
      effectRef: effect.effectRef,
    };
  }

  /* -------------------------------------------------------------- adapter */

  const adapter: ConnectorAdapter = {
    id: AUTH0_ADAPTER_ID,
    ecosystem: "auth0",
    adapterVersion: AUTH0_ADAPTER_VERSION,
    runtime: "hosted-server",
    displayName: "Auth0 Token Vault",
    description:
      "Link external provider accounts to an Auth0 user and exchange a host-held Auth0 token for a short-lived provider token kept in custody.",
    service: "auth0-token-vault",
    support: "provider-backed",
    custody: ["external-credential-broker"],
    configuration: CONFIGURATION,
    profiles: ["external-broker", auth0Profiles.tokenVault],
    capabilities(present) {
      const configuration = configurationNames.every((name) =>
        present.has(name),
      )
        ? ("ready" as const)
        : ("missing" as const);
      const profile = auth0Profiles.tokenVault;
      const rows: CapabilityStatus[] = [
        capabilityStatus(adapter, {
          dimension: "authorize",
          profile,
          configuration,
          evidence: "protocol-fixture",
          limitations: [
            "Linking uses the My Account API Connected Accounts flow and needs a host-held token with the Connected Accounts scopes.",
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "verify",
          profile,
          configuration,
          evidence: "protocol-fixture",
          limitations: [
            "Evidence is Auth0's record of the linked account; the upstream provider is not contacted.",
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "invoke",
          profile,
          configuration,
          evidence: "protocol-fixture",
          limitations: [
            "The exchanged provider token is short-lived and stays in custody; it is never returned to a caller.",
            "Auth0 does not rotate the upstream refresh token on this deployment's behalf beyond the documented exchange.",
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "discover",
          profile,
          configuration,
          evidence: "protocol-fixture",
          limitations: [
            "Lists this user's linked accounts and available connections; it imports no definition.",
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "reconnect",
          profile,
          configuration,
          evidence: "protocol-fixture",
          limitations: [],
        }),
        capabilityStatus(adapter, {
          dimension: "disconnect",
          profile,
          configuration,
          evidence: "protocol-fixture",
          limitations: [
            "Deleting the connected account removes Auth0's stored tokens; it does not revoke the grant at the provider.",
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "configure",
          profile,
          configuration,
          evidence: "unit",
          limitations: [],
        }),
      ];
      for (const dimension of [
        "import",
        "events",
        "export",
        "delegate",
        "revoke",
      ] as const)
        rows.push(
          capabilityStatus(adapter, {
            dimension,
            profile,
            implementation: "unsupported",
            limitations:
              dimension === "revoke"
                ? [
                    "Auth0 documents no operation that revokes the upstream grant at the external provider.",
                  ]
                : [],
          }),
        );
      return rows;
    },

    async discover(ctx): Promise<DiscoverResult> {
      const resolved = await resolve(ctx);
      const ownerId = ctx.connection?.ownerId ?? ctx.actor.subjectId;
      const token = await myAccountToken(ctx, "user", ownerId);
      const connectionsResponse = await token.use((value) =>
        send(
          ctx,
          destinationUrl(resolved.destination, AUTH0_CONNECTIONS_PATH),
          {
            method: "GET",
            headers: {
              authorization: `Bearer ${value}`,
              accept: "application/json",
            },
          },
          { timeoutMs, maxBytes },
        ),
      );
      if (connectionsResponse.status !== 200)
        throw new ConnectorError(
          connectionsResponse.status >= 500
            ? "upstream-unavailable"
            : "upstream-rejected",
          { detail: "auth0.connections.rejected" },
        );
      const connections = auth0ConnectionsResponseSchema.safeParse(
        parseJson(connectionsResponse.body),
      );
      if (!connections.success)
        throw new ConnectorError("upstream-rejected", {
          detail: "auth0.connections.unreadable",
        });
      const accounts = await listAccounts(ctx, resolved, token);
      const linked = new Map(
        accounts.accounts.map((account) => [account.connection, account]),
      );
      return {
        items: connections.data.connections.map((connection) => ({
          identity: {
            ecosystem: "auth0",
            authorityNamespace: resolved.issuer,
            nativeId: connection.name,
            nativeVersion: AUTH0_ADAPTER_VERSION,
          },
          displayName: connection.name,
          description: connection.strategy ?? "",
          provenance: {
            strategy: connection.strategy ?? "unknown",
            linked: linked.has(connection.name) ? "true" : "false",
            ...(linked.get(connection.name)?.id
              ? { connectedAccountId: linked.get(connection.name)!.id }
              : {}),
          },
          status: "active" as const,
        })),
        freshness: {
          fetchedAt: ctx.environment.now(),
          stale: false,
          source: "live",
        },
        issues: [],
      };
    },

    async authorize(ctx, intent) {
      const resolved = await resolve(ctx);
      // Selecting an already-linked account is an explicit, host-approved act:
      // the named account must be one this binding permits, and it must exist
      // on the bound connection for this user.
      if (intent.target && !intent.accountSwitch) {
        if (
          !ctx.binding.permittedTargets.some(
            (target) =>
              target.kind === intent.target!.kind &&
              target.id === intent.target!.id,
          )
        )
          throw new ConnectorError("denied", {
            detail: "auth0.account.not-permitted",
          });
        const ownerId = ctx.connection?.ownerId ?? ctx.actor.subjectId;
        const token = await myAccountToken(ctx, intent.ownerKind, ownerId);
        const accounts = await listAccounts(
          ctx,
          resolved,
          token,
          resolved.settings.connection,
        );
        const chosen = accounts.accounts.find(
          (account) => account.id === intent.target!.id,
        );
        if (!chosen)
          throw new ConnectorError("not-found", {
            detail: "auth0.account.unknown",
          });
        return { kind: "verify" };
      }
      return startConnect(ctx, intent);
    },

    async reconnect(ctx, intent) {
      return startConnect(ctx, intent);
    },

    async complete(ctx, input: CompletionInput) {
      if (input.kind === "redirect") return completeConnect(ctx, input.url);
      if (input.kind === "poll") return adapter.verify!(ctx);
      return {
        state: "pending",
        claims: [],
        code: "auth0.unsupported-completion",
      };
    },

    async verify(ctx): Promise<CompletionResult> {
      const resolved = await resolve(ctx);
      const ownerId = ctx.connection?.ownerId ?? ctx.actor.subjectId;
      const ownerKind = ctx.connection?.ownerKind ?? "user";
      const held = await subjectTokenFor(ctx, ownerKind, ownerId);
      const expectedSubject = ctx.connection?.externalIds.auth0Subject;
      if (expectedSubject && expectedSubject !== held.subject)
        return { state: "denied", claims: [], code: "auth0.subject-changed" };
      const token = await myAccountToken(ctx, ownerKind, ownerId);
      const accounts = await listAccounts(
        ctx,
        resolved,
        token,
        resolved.settings.connection,
      );
      const selected = ctx.connection?.externalIds.connectedAccountId;
      const account = selected
        ? accounts.accounts.find((item) => item.id === selected)
        : accounts.accounts.length === 1
          ? accounts.accounts[0]
          : undefined;
      if (!account)
        return {
          state: selected ? "denied" : "human-required",
          claims: [],
          code: selected
            ? "auth0.account.removed"
            : accounts.accounts.length > 1
              ? "auth0.account.selection-required"
              : "auth0.account.unlinked",
        };
      if (account.connection !== resolved.settings.connection)
        return {
          state: "denied",
          claims: [],
          code: "auth0.connection.mismatch",
        };
      return {
        state: "complete",
        claims: [claimFor(ctx, resolved, account, held.subject)],
        externalIds: {
          connectedAccountId: account.id,
          auth0Connection: account.connection,
          auth0Subject: held.subject,
        },
        target: { kind: "connected-account", id: account.id },
        adapterState: {
          accessType: account.access_type ?? "unknown",
          scopes: [...(account.scopes ?? [])],
        },
      };
    },

    async invoke(ctx, request: InvokeRequest): Promise<InvokeResult> {
      const operation = boundOperation(ctx.binding, request.operationRef);
      if (!operation)
        throw new ConnectorError("not-found", {
          detail: "auth0.operation.unknown",
        });
      destinationFor(ctx.binding, operation);
      const resolved = await resolve(ctx);
      if (operation.transport.kind !== "broker-action")
        throw new ConnectorError("denied", {
          detail: "auth0.operation.transport",
        });
      if (operation.transport.action === AUTH0_INVENTORY_ACTION) {
        const ownerId = ctx.connection?.ownerId ?? ctx.actor.subjectId;
        const token = await myAccountToken(
          ctx,
          ctx.connection?.ownerKind ?? "user",
          ownerId,
        );
        const accounts = await listAccounts(
          ctx,
          resolved,
          token,
          resolved.settings.connection,
        );
        return {
          state: "complete",
          output: {
            accounts: accounts.accounts.map((account) => ({
              id: account.id,
              connection: account.connection,
              accessType: account.access_type ?? "unknown",
              scopes: [...(account.scopes ?? [])],
              ...(account.created_at ? { createdAt: account.created_at } : {}),
            })),
            selected: ctx.connection?.externalIds.connectedAccountId ?? null,
          },
          outputClassification: operation.outputClassification,
          effect: "read",
        };
      }
      if (operation.transport.action !== AUTH0_EXCHANGE_ACTION)
        throw new ConnectorError("denied", {
          detail: "auth0.operation.unsupported-action",
        });
      return exchange(ctx, resolved, operation, request);
    },

    async disconnect(ctx, scope: DisconnectScope): Promise<DisconnectResult> {
      if (scope === "local")
        return {
          local: "applied",
          broker: "not-attempted",
          upstream: "not-attempted",
        };
      if (scope === "upstream")
        return {
          local: "not-attempted",
          broker: "not-attempted",
          upstream: "unsupported",
        };
      const resolved = await resolve(ctx);
      const accountId = ctx.connection?.externalIds.connectedAccountId;
      if (!accountId)
        return {
          local: "applied",
          broker: "not-attempted",
          upstream: "unsupported",
        };
      const ownerId = ctx.connection?.ownerId ?? ctx.actor.subjectId;
      const token = await myAccountToken(
        ctx,
        ctx.connection?.ownerKind ?? "user",
        ownerId,
      );
      const effect = await beginEffect(ctx, "auth0.connected-account.delete", {
        accountId,
      });
      const response = await token.use((value) =>
        send(
          ctx,
          destinationUrl(
            resolved.destination,
            `${AUTH0_ACCOUNTS_PATH}/${encodeURIComponent(accountId)}`,
          ),
          {
            method: "DELETE",
            headers: {
              authorization: `Bearer ${value}`,
              accept: "application/json",
            },
          },
          { timeoutMs, maxBytes },
        ),
      );
      const applied = response.status === 204 || response.status === 200;
      await ctx.environment.effects.complete(effect.effectRef, {
        status: applied ? "applied" : "failed",
        at: ctx.environment.now(),
      });
      return {
        local: "applied",
        broker: applied ? "applied" : "failed",
        // Auth0 deletes its stored tokens; the grant at the external provider
        // is the provider's to revoke.
        upstream: "unsupported",
      };
    },

    async revoke(): Promise<DisconnectResult> {
      return {
        local: "not-attempted",
        broker: "not-attempted",
        upstream: "unsupported",
      };
    },
  };

  return adapter;
}

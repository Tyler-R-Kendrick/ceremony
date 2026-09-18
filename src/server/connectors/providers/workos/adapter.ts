import {
  canonicalDigest,
  encodePathSegment,
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
  type DiscoverInput,
  type DiscoverResult,
  type HandoffProposal,
  type InvokeRequest,
  type InvokeResult,
  type VerificationClaim,
} from "../../adapter.js";
import type { CredentialScope } from "../../ports.js";
import { parseJson, send } from "./http.js";
import type { WorkOsPrincipal, WorkOsPrincipalPort } from "./ports.js";
import {
  WORKOS_ADAPTER_ID,
  WORKOS_ADAPTER_VERSION,
  WORKOS_CREDENTIALS_ACTION,
  WORKOS_DEFAULT_RETURN_PATH,
  WORKOS_DESTINATION_ID,
  WORKOS_RETURN_CORRELATION_PARAMETER,
  workOsAuthorizeResponseSchema,
  workOsConnectedAccountSchema,
  workOsDataProviderListSchema,
  workOsPipesProfiles,
  workOsRelayErrorSchema,
  workOsRelayInputSchema,
  workOsSettingsSchema,
  workOsVendResponseSchema,
  type WorkOsConnectedAccount,
  type WorkOsConnectionOwner,
  type WorkOsSettings,
} from "./wire.js";

/*
 * WorkOS Pipes.
 *
 * Pipes is a broker with two genuinely different custody stories, and this
 * adapter keeps them apart rather than treating one as a fallback for the
 * other. In *credential* mode the documented token endpoint vends the user's
 * provider access token, which goes straight into host custody and is used
 * only for operations this binding approved; that binding's custody is
 * `external-credential-broker`. In *relay* mode WorkOS makes the provider call
 * itself and the token never enters this process; that binding's custody is
 * `external-execution-broker`, the adapter never calls the token endpoint, and
 * the request it forwards is the one the bound operation describes — never a
 * host, header or URL a caller supplied. A binding whose settings and custody
 * disagree is refused: a relay deployment that cannot reach WorkOS does not
 * quietly start copying credentials instead.
 *
 * The other thing Pipes gets to decide, and Ceremony does not accept from a
 * request, is *who* the connection belongs to. WorkOS user and organization
 * ids come from a host port keyed by tenant, owner kind and owner id, and an
 * organization-scoped connection additionally needs host policy to say this
 * actor may act for that organization. An `organizationId` in a tool argument
 * or a tag is not an organization grant.
 *
 * Sources (retrieved 2026-09-18):
 *   https://workos.com/docs/pipes
 *   https://workos.com/docs/reference/pipes            (access token, vend credentials)
 *   https://workos.com/docs/reference/pipes/connected-account
 *   https://workos.com/docs/reference/pipes/provider
 *   https://workos.com/docs/pipes/relay
 *   https://workos.com/docs/pipes/organization-scoped-providers
 */

export interface WorkOsPipesAdapterOptions {
  /** Host mapping from an authenticated owner to WorkOS identifiers and organization policy. */
  principals: WorkOsPrincipalPort;
  /** Path the host mounts for the post-authorization return; default `/api/v1/connectors/workos/return`. */
  returnPath?: string;
  /** Per-request ceiling; the relay's own upstream timeout is 30 seconds. */
  requestTimeoutMs?: number;
  /** Ceiling on a WorkOS control-plane response body. */
  maxResponseBytes?: number;
  /** Seconds a connect handoff stays open. */
  handoffSeconds?: number;
}

const CONFIGURATION = Object.freeze([
  {
    name: "WORKOS_API_KEY",
    source: "session-environment" as const,
    classification: "secret" as const,
    required: true,
    description: "WorkOS environment API key used for every Pipes call.",
  },
  {
    name: "WORKOS_CLIENT_ID",
    source: "session-environment" as const,
    classification: "public" as const,
    required: true,
    description: "WorkOS client id identifying the environment.",
  },
]);

const configurationNames = CONFIGURATION.map((item) => item.name);

type ResolvedContext = {
  settings: WorkOsSettings;
  apiKey: string;
  clientId: string;
  destination: ApprovedDestination;
  principal: WorkOsPrincipal;
  connectionOwner: WorkOsConnectionOwner;
};

const authorityInstance = (clientId: string) => `workos:${clientId}`;

/** The mode a binding's custody commits it to; a mismatch is a policy failure, not a preference. */
function assertMode(binding: RuntimeBinding, settings: WorkOsSettings): void {
  const expected =
    settings.mode === "credentials"
      ? "external-credential-broker"
      : "external-execution-broker";
  if (binding.custody !== expected)
    throw new ConnectorError("denied", {
      detail: "workos.mode.custody-mismatch",
    });
  const profile =
    settings.mode === "credentials"
      ? workOsPipesProfiles.credentials
      : workOsPipesProfiles.relay;
  if (binding.profileId !== undefined && binding.profileId !== profile)
    throw new ConnectorError("denied", { detail: "workos.mode.profile" });
}

function settingsFor(binding: RuntimeBinding): WorkOsSettings {
  const parsed = workOsSettingsSchema.safeParse(binding.settings);
  if (!parsed.success)
    throw new ConnectorError("invalid-request", {
      detail: "workos.settings.invalid",
    });
  assertMode(binding, parsed.data);
  if (parsed.data.mode === "relay" && !parsed.data.relay)
    throw new ConnectorError("invalid-request", {
      detail: "workos.settings.relay-missing",
    });
  return parsed.data;
}

function destination(binding: RuntimeBinding): ApprovedDestination {
  const approved = binding.destinations.find(
    (item) => item.id === WORKOS_DESTINATION_ID,
  );
  if (!approved)
    throw new ConnectorError("network-policy", {
      detail: "workos.destination.unapproved",
    });
  return approved;
}

/** A loopback fixture destination may answer over plain HTTP; nothing else may. */
function assertPresentableUrl(
  value: string,
  approved: ApprovedDestination,
): string {
  if (!URL.canParse(value))
    throw new ConnectorError("upstream-rejected", {
      detail: "workos.authorization-url.invalid",
    });
  const url = new URL(value);
  const loopback =
    approved.network === "loopback-fixture" &&
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" && !loopback)
  )
    throw new ConnectorError("upstream-rejected", {
      detail: "workos.authorization-url.unsafe",
    });
  return url.href;
}

export function createWorkOsPipesAdapter(
  options: WorkOsPipesAdapterOptions,
): ConnectorAdapter {
  const returnPath = options.returnPath ?? WORKOS_DEFAULT_RETURN_PATH;
  const timeoutMs = options.requestTimeoutMs ?? 20_000;
  const maxBytes = options.maxResponseBytes ?? 256 * 1024;
  const handoffSeconds = options.handoffSeconds ?? 900;

  async function resolve(
    ctx: AdapterCallContext,
    ownerKind: OwnerKind,
    ownerId?: string,
  ): Promise<ResolvedContext> {
    const settings = settingsFor(ctx.binding);
    const present =
      await ctx.environment.configuration.present(configurationNames);
    const missing = configurationNames.filter((name) => !present.has(name));
    if (missing.length)
      throw new ConnectorError("configuration-required", {
        detail: "workos.configuration.missing",
      });
    const apiKey = await ctx.environment.configuration.read("WORKOS_API_KEY");
    const clientId =
      await ctx.environment.configuration.read("WORKOS_CLIENT_ID");
    if (!apiKey || !clientId)
      throw new ConnectorError("configuration-required", {
        detail: "workos.configuration.missing",
      });
    if (ownerKind === "workload")
      throw new ConnectorError("unsupported", {
        detail: "workos.owner.workload",
      });
    const principal = await options.principals.resolve({
      actor: ctx.actor,
      tenantId: ctx.binding.tenantId,
      ownerKind,
      ...(ownerId === undefined ? {} : { ownerId }),
    });
    if (!principal)
      throw new ConnectorError("denied", { detail: "workos.principal.absent" });
    // An organization connection is a different grant with a different owner.
    // It exists only when the host both knows the organization and says this
    // actor may act for it; neither is inferable from a request field.
    if (ownerKind === "organization") {
      if (!principal.organizationId)
        throw new ConnectorError("denied", {
          detail: "workos.organization.unmapped",
        });
      if (principal.organizationConnection !== "permitted")
        throw new ConnectorError("denied", {
          detail: "workos.organization.not-permitted",
        });
    }
    return {
      settings,
      apiKey,
      clientId,
      destination: destination(ctx.binding),
      principal,
      connectionOwner: ownerKind === "organization" ? "organization" : "user",
    };
  }

  const controlHeaders = (apiKey: string) => ({
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
    accept: "application/json",
  });

  /** Body shared by the vend and connected-account calls; the owner decides which ids travel. */
  function ownerBody(resolved: ResolvedContext): Record<string, unknown> {
    const body: Record<string, unknown> = {
      user_id: resolved.principal.userId,
    };
    if (resolved.principal.organizationId)
      body.organization_id = resolved.principal.organizationId;
    if (resolved.connectionOwner === "organization")
      body.connection_owner = "organization";
    if (resolved.settings.multipleConnections)
      body.supports_multiple_connections = true;
    return body;
  }

  function accountPath(resolved: ResolvedContext, slug: string): string {
    return resolved.connectionOwner === "organization"
      ? `/organizations/${encodePathSegment(
          resolved.principal.organizationId!,
        )}/connected_accounts/${encodePathSegment(slug)}`
      : `/user_management/users/${encodePathSegment(
          resolved.principal.userId,
        )}/connected_accounts/${encodePathSegment(slug)}`;
  }

  async function readConnectedAccount(
    ctx: AdapterCallContext,
    resolved: ResolvedContext,
  ): Promise<WorkOsConnectedAccount | undefined> {
    const url = destinationUrl(
      resolved.destination,
      accountPath(resolved, resolved.settings.provider),
    );
    if (
      resolved.connectionOwner === "user" &&
      resolved.principal.organizationId
    )
      url.searchParams.set(
        "organization_id",
        resolved.principal.organizationId,
      );
    if (resolved.settings.multipleConnections)
      url.searchParams.set("supports_multiple_connections", "true");
    const response = await send(
      ctx,
      url,
      { method: "GET", headers: controlHeaders(resolved.apiKey) },
      { timeoutMs, maxBytes },
    );
    if (response.status === 404) return undefined;
    if (response.status === 429)
      throw new ConnectorError("rate-limited", { detail: "workos.throttled" });
    if (response.status >= 500)
      throw new ConnectorError("upstream-unavailable", {
        detail: "workos.unavailable",
      });
    if (response.status !== 200)
      throw new ConnectorError("upstream-rejected", {
        detail: "workos.account.rejected",
      });
    const parsed = workOsConnectedAccountSchema.safeParse(
      parseJson(response.body),
    );
    if (!parsed.success)
      throw new ConnectorError("upstream-rejected", {
        detail: "workos.account.unreadable",
      });
    return parsed.data;
  }

  /**
   * Evidence from a connected account. WorkOS reports `account_identifier` and
   * `account_display_name` only for some providers; without an identifier the
   * broker has shown that *a* connection exists, not *which* account it is, so
   * the claim says exactly that instead of being relabelled account identity.
   */
  function claimsFor(
    ctx: AdapterCallContext,
    resolved: ResolvedContext,
    account: WorkOsConnectedAccount,
  ): { claims: VerificationClaim[]; target: { kind: string; id: string } } {
    const observedAt = new Date(ctx.environment.now()).toISOString();
    const identified = Boolean(account.account_identifier);
    const target = identified
      ? { kind: "provider-account", id: account.account_identifier! }
      : { kind: "broker-connection", id: account.id };
    const limitations = [
      "WorkOS reports the connection; the provider account was not independently verified by this deployment.",
    ];
    if (!identified)
      limitations.push(
        "This provider exposes no account identifier through Pipes, so the exact upstream account is unknown.",
      );
    const claim: VerificationClaim = {
      kind: identified ? "account-identity" : "ownership-claimed",
      evidenceRef: `evidence:workos:${account.id}`,
      issuer: "external-broker",
      target,
      observedAt,
      validUntil: new Date(
        ctx.environment.now() + resolved.settings.verificationTtlSeconds * 1000,
      ).toISOString(),
      verifierVersion: WORKOS_ADAPTER_VERSION,
      bindingRevision: ctx.binding.revision,
      policyRevision: ctx.binding.policyRevision,
      permissions: {
        requested: [],
        reported: [...(account.scopes ?? [])],
        observed: [],
        semantics: "provider-scopes",
      },
      limitations,
    };
    return { claims: [claim], target };
  }

  /** Same-account check: a reconnect that lands on another account needs explicit intent. */
  function accountChanged(
    ctx: AdapterCallContext,
    account: WorkOsConnectedAccount,
  ): boolean {
    const known = ctx.connection?.externalIds.connectedAccountId;
    return Boolean(known && known !== account.id);
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

  async function startAuthorization(
    ctx: AdapterCallContext,
    intent: AuthorizationIntent,
    purpose: "connect" | "reconnect",
  ): Promise<AuthorizationStart> {
    const resolved = await resolve(
      ctx,
      intent.ownerKind,
      ctx.connection?.ownerId,
    );
    // A connect flow is a browser flow. A policy that forbids interrupting the
    // person ends the attempt here; it never selects a quieter, wider route.
    if (intent.interruption === "none")
      return { kind: "human-required", code: "workos.authorization.attended" };
    const correlationKey = `workos:${ctx.environment.random.uuid()}`;
    const returnTo = new URL(returnPath, ctx.environment.origin);
    returnTo.searchParams.set(
      WORKOS_RETURN_CORRELATION_PARAMETER,
      correlationKey,
    );
    const body: Record<string, unknown> = {
      user_id: resolved.principal.userId,
      return_to: returnTo.href,
    };
    if (resolved.principal.organizationId)
      body.organization_id = resolved.principal.organizationId;
    if (resolved.connectionOwner === "organization")
      body.connection_owner = "organization";
    const url = destinationUrl(
      resolved.destination,
      `/data-integrations/${encodePathSegment(
        resolved.settings.provider,
      )}/authorize`,
    );
    const effect = await beginEffect(ctx, "workos.pipes.authorize", {
      provider: resolved.settings.provider,
      owner: resolved.connectionOwner,
      userId: resolved.principal.userId,
      organizationId: resolved.principal.organizationId ?? null,
      correlationKey,
    });
    const response = await send(
      ctx,
      url,
      {
        method: "POST",
        headers: controlHeaders(resolved.apiKey),
        body: JSON.stringify(body),
      },
      { timeoutMs, maxBytes },
    );
    if (response.status === 429) {
      await ctx.environment.effects.complete(effect.effectRef, {
        status: "not-applied",
        code: "rate-limited",
        at: ctx.environment.now(),
      });
      throw new ConnectorError("rate-limited", { detail: "workos.throttled" });
    }
    if (response.status < 200 || response.status >= 300) {
      await ctx.environment.effects.complete(effect.effectRef, {
        status: "not-applied",
        code: "rejected",
        at: ctx.environment.now(),
      });
      throw new ConnectorError(
        response.status >= 500 ? "upstream-unavailable" : "upstream-rejected",
        { detail: "workos.authorize.rejected" },
      );
    }
    const parsed = workOsAuthorizeResponseSchema.safeParse(
      parseJson(response.body),
    );
    if (!parsed.success) {
      await ctx.environment.effects.complete(effect.effectRef, {
        status: "failed",
        at: ctx.environment.now(),
      });
      throw new ConnectorError("upstream-rejected", {
        detail: "workos.authorize.unreadable",
      });
    }
    const authorizationUrl = assertPresentableUrl(
      parsed.data.url,
      resolved.destination,
    );
    await ctx.environment.effects.complete(effect.effectRef, {
      status: "applied",
      at: ctx.environment.now(),
    });
    const handoff: HandoffProposal = {
      kind: "provider-browser",
      presentation: "popup",
      expiresAt: ctx.environment.now() + handoffSeconds * 1000,
      intent: `workos.pipes.${purpose}`,
      correlationKey,
      // Protected: the destination URL is shown only to the initiating human
      // through the human projection, never to a model or an export.
      private: {
        url: authorizationUrl,
        provider: resolved.settings.provider,
        connectionOwner: resolved.connectionOwner,
        accountSwitch: intent.accountSwitch ? "true" : "false",
      },
    };
    return { kind: "handoff", handoff };
  }

  async function authoritativeState(
    ctx: AdapterCallContext,
    allowAccountSwitch: boolean,
  ): Promise<CompletionResult> {
    const resolved = await resolve(
      ctx,
      ctx.connection?.ownerKind ?? "user",
      ctx.connection?.ownerId,
    );
    const account = await readConnectedAccount(ctx, resolved);
    if (!account)
      return { state: "pending", claims: [], code: "workos.not-installed" };
    if (account.state === "needs_reauthorization")
      return {
        state: "human-required",
        claims: [],
        code: "workos.needs-reauthorization",
      };
    if (account.state !== "connected")
      return { state: "pending", claims: [], code: "workos.state-unknown" };
    // Ownership is checked against what was asked for, not against what came
    // back: an organization's shared connection returned on a user lookup is
    // still the organization's grant, and a user's connection is never
    // presented as an organization's.
    const returnedOrganization = account.organization_id ?? undefined;
    const ownedByPerson = Boolean(account.user_id);
    if (
      returnedOrganization !== resolved.principal.organizationId ||
      ownedByPerson !== (resolved.connectionOwner === "user")
    )
      return { state: "denied", claims: [], code: "workos.owner-mismatch" };
    if (!allowAccountSwitch && accountChanged(ctx, account))
      return { state: "denied", claims: [], code: "workos.account-changed" };
    const { claims, target } = claimsFor(ctx, resolved, account);
    return {
      state: "complete",
      claims,
      externalIds: {
        connectedAccountId: account.id,
        workosUserId: resolved.principal.userId,
        ...(resolved.principal.organizationId
          ? { workosOrganizationId: resolved.principal.organizationId }
          : {}),
        provider: resolved.settings.provider,
      },
      target,
      adapterState: {
        connectionOwner: resolved.connectionOwner,
        scopes: [...(account.scopes ?? [])],
        authMethod: account.auth_method ?? "unknown",
      },
    };
  }

  /* ---------------------------------------------------------------- invoke */

  async function vendCredential(
    ctx: AdapterCallContext,
    resolved: ResolvedContext,
    operation: BoundOperation,
    request: InvokeRequest,
  ): Promise<InvokeResult> {
    if (!ctx.connection)
      throw new ConnectorError("invalid-request", {
        detail: "workos.connection.required",
      });
    const endpoint =
      resolved.settings.credentialEndpoint === "credentials"
        ? "credentials"
        : "token";
    const url = destinationUrl(
      resolved.destination,
      `/data-integrations/${encodePathSegment(
        resolved.settings.provider,
      )}/${endpoint}`,
    );
    const body = ownerBody(resolved);
    const connectedAccountId = ctx.connection.externalIds.connectedAccountId;
    if (resolved.settings.multipleConnections && connectedAccountId)
      body.connected_account_id = connectedAccountId;
    const effect = await beginEffect(
      ctx,
      "workos.pipes.vend",
      { provider: resolved.settings.provider, endpoint, body },
      request.commandId,
    );
    const response = await send(
      ctx,
      url,
      {
        method: "POST",
        headers: controlHeaders(resolved.apiKey),
        body: JSON.stringify(body),
      },
      { timeoutMs, maxBytes },
    );
    const finish = async (
      status: "applied" | "not-applied" | "failed",
      code?: string,
    ) => {
      await ctx.environment.effects.complete(effect.effectRef, {
        status,
        ...(code ? { code } : {}),
        at: ctx.environment.now(),
      });
    };
    if (response.status === 429) {
      await finish("not-applied", "rate-limited");
      throw new ConnectorError("rate-limited", { detail: "workos.throttled" });
    }
    if (response.status < 200 || response.status >= 300) {
      await finish("not-applied", "rejected");
      throw new ConnectorError(
        response.status >= 500 ? "upstream-unavailable" : "upstream-rejected",
        { detail: "workos.vend.rejected" },
      );
    }
    const parsed = workOsVendResponseSchema.safeParse(parseJson(response.body));
    if (!parsed.success) {
      await finish("failed");
      throw new ConnectorError("upstream-rejected", {
        detail: "workos.vend.unreadable",
      });
    }
    // A 200 is not a credential. `active: false` is the documented way WorkOS
    // says the person has to go and connect or reconnect, and it maps to human
    // participation, never to an empty-but-successful token.
    if (parsed.data.active === false) {
      await finish("not-applied", "inactive");
      const reason = parsed.data.error ?? "unknown";
      if (reason === "account_selection_required")
        return {
          state: "denied",
          outputClassification: "public",
          effect: "read",
          code: "workos.account-selection-required",
          effectRef: effect.effectRef,
        };
      return {
        state: "human-required",
        outputClassification: "public",
        effect: "read",
        code:
          reason === "needs_reauthorization"
            ? "workos.needs-reauthorization"
            : reason === "not_installed"
              ? "workos.not-installed"
              : "workos.inactive",
        effectRef: effect.effectRef,
      };
    }
    const material =
      "access_token" in parsed.data
        ? parsed.data.access_token
        : parsed.data.credential;
    const value =
      "access_token" in material ? material.access_token : material.value;
    const expiresAt = material.expires_at
      ? Date.parse(material.expires_at)
      : ctx.environment.now() + resolved.settings.credentialLeaseSeconds * 1000;
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
      {
        access_token: value,
        ...("auth_method" in material && material.auth_method
          ? { auth_method: material.auth_method }
          : {}),
      },
      {
        expiresAt,
        ...(ctx.connection.credentialRef
          ? { replaces: ctx.connection.credentialRef }
          : {}),
      },
    );
    await finish("applied");
    // The token itself stays in custody. What the caller learns is that a
    // usable credential exists, when it expires and which scopes are missing.
    return {
      state: "complete",
      output: {
        credentialRef,
        expiresAt: new Date(expiresAt).toISOString(),
        scopes: [...(material.scopes ?? [])],
        missingScopes: [...(material.missing_scopes ?? [])],
      },
      outputClassification: operation.outputClassification,
      effect: "read",
      effectRef: effect.effectRef,
    };
  }

  function relayTarget(
    ctx: AdapterCallContext,
    resolved: ResolvedContext,
    operation: BoundOperation,
    input: unknown,
  ): { url: URL; headers: Record<string, string>; body?: string } {
    if (operation.transport.kind !== "http")
      throw new ConnectorError("invalid-request", {
        detail: "workos.relay.transport",
      });
    const parsedInput = workOsRelayInputSchema.safeParse(input);
    if (!parsedInput.success)
      throw new ConnectorError("invalid-request", {
        detail: "workos.relay.input",
      });
    const supplied = parsedInput.data ?? {};
    const parameters = supplied.parameters ?? {};
    // The path is the bound operation's template. A parameter that selects a
    // target must be one this connection is permitted to touch; nothing else
    // about the request comes from the caller.
    const path = operation.transport.pathTemplate.replace(
      /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g,
      (_match, name: string) => {
        const value = parameters[name];
        if (value === undefined)
          throw new ConnectorError("invalid-request", {
            detail: "workos.relay.parameter-missing",
          });
        if (operation.targetParameters.includes(name)) {
          const permitted = ctx.binding.permittedTargets.some(
            (target) => target.id === value,
          );
          if (!permitted)
            throw new ConnectorError("denied", {
              detail: "workos.target.not-permitted",
            });
        }
        return encodePathSegment(value);
      },
    );
    const relay = resolved.settings.relay!;
    const headers: Record<string, string> = {
      authorization: `Bearer ${resolved.apiKey}`,
      accept: "application/json",
      "x-relay-user": resolved.principal.userId,
      "x-relay-provider": resolved.settings.provider,
    };
    // Documented exact-match rule: the organization header is present for an
    // organization-scoped connection and absent otherwise. A mismatch in
    // either direction is a 402, not a wider lookup.
    if (resolved.connectionOwner === "organization")
      headers["x-relay-organization"] = resolved.principal.organizationId!;
    let url: URL;
    if (relay.routing === "url") {
      if (!relay.upstreamOrigin)
        throw new ConnectorError("invalid-request", {
          detail: "workos.relay.upstream-missing",
        });
      url = destinationUrl(resolved.destination, "/relay");
      const upstream = new URL(path, relay.upstreamOrigin);
      if (upstream.origin !== relay.upstreamOrigin)
        throw new ConnectorError("denied", {
          detail: "workos.relay.upstream-escape",
        });
      for (const [name, value] of Object.entries(supplied.query ?? {}))
        upstream.searchParams.set(name, value);
      headers["x-relay-url"] = upstream.href;
    } else {
      url = destinationUrl(
        resolved.destination,
        `/relay/${encodePathSegment(resolved.settings.provider)}${path}`,
      );
      for (const [name, value] of Object.entries(supplied.query ?? {}))
        url.searchParams.set(name, value);
    }
    let body: string | undefined;
    if (
      supplied.body !== undefined &&
      operation.transport.method !== "GET" &&
      operation.transport.method !== "HEAD"
    ) {
      body = JSON.stringify(supplied.body);
      headers["content-type"] = "application/json";
    }
    return { url, headers, ...(body === undefined ? {} : { body }) };
  }

  async function relayInvoke(
    ctx: AdapterCallContext,
    resolved: ResolvedContext,
    operation: BoundOperation,
    request: InvokeRequest,
  ): Promise<InvokeResult> {
    if (operation.transport.kind !== "http")
      throw new ConnectorError("invalid-request", {
        detail: "workos.relay.transport",
      });
    const target = relayTarget(ctx, resolved, operation, request.input);
    const relay = resolved.settings.relay!;
    if (request.idempotencyKey) {
      if (
        operation.replay !== "upstream-idempotency-key" ||
        !relay.idempotencyHeader
      )
        throw new ConnectorError("invalid-request", {
          detail: "workos.relay.idempotency-unsupported",
        });
      target.headers[relay.idempotencyHeader.toLowerCase()] =
        request.idempotencyKey;
    }
    const effect = await beginEffect(
      ctx,
      `workos.relay:${operation.operationRef}`,
      {
        provider: resolved.settings.provider,
        method: operation.transport.method,
        url: target.url.href,
        relayUrl: target.headers["x-relay-url"] ?? null,
        user: resolved.principal.userId,
        organization: resolved.principal.organizationId ?? null,
        body: target.body ?? null,
      },
      request.commandId,
    );
    // A repeated digest means this exact call was already made. Only a
    // genuinely read-only operation may simply be made again.
    if (effect.prior && operation.replay !== "read-only")
      return {
        state:
          effect.prior.status === "applied"
            ? "complete"
            : effect.prior.status === "not-applied"
              ? "failed"
              : "indeterminate",
        outputClassification: operation.outputClassification,
        effect: operation.effect,
        code: "workos.relay.replayed",
        effectRef: effect.effectRef,
      };
    let response;
    try {
      response = await send(
        ctx,
        target.url,
        {
          method: operation.transport.method,
          headers: target.headers,
          ...(target.body === undefined ? {} : { body: target.body }),
        },
        { timeoutMs, maxBytes: relay.maxResponseBytes },
      );
    } catch (error) {
      // The provider may already have acted. Only a read may be called a
      // clean failure; anything else needs reconciliation.
      const indeterminate = operation.effect !== "read";
      await ctx.environment.effects.complete(effect.effectRef, {
        status: indeterminate ? "indeterminate" : "failed",
        at: ctx.environment.now(),
      });
      if (indeterminate)
        return {
          state: "indeterminate",
          outputClassification: operation.outputClassification,
          effect: operation.effect,
          code: "workos.relay.uncertain",
          effectRef: effect.effectRef,
        };
      throw error;
    }
    const upstreamStatus = response.headers.get("x-relay-upstream-status");
    const payload = parseJson(response.body);
    if (!upstreamStatus) {
      const relayError = workOsRelayErrorSchema.safeParse(payload);
      const code = relayError.success ? relayError.data.code : undefined;
      if (response.status === 402) {
        await ctx.environment.effects.complete(effect.effectRef, {
          status: "not-applied",
          code: "authorization-required",
          at: ctx.environment.now(),
        });
        const link = relayError.success
          ? (relayError.data.authorization_url ?? undefined)
          : undefined;
        const handoff: HandoffProposal | undefined = link
          ? {
              kind: "provider-browser",
              presentation: "popup",
              expiresAt: ctx.environment.now() + handoffSeconds * 1000,
              intent: "workos.pipes.reconnect",
              correlationKey: `workos:${ctx.environment.random.uuid()}`,
              private: {
                url: assertPresentableUrl(link, resolved.destination),
                provider: resolved.settings.provider,
                connectionOwner: resolved.connectionOwner,
                accountSwitch: "false",
              },
            }
          : undefined;
        return {
          state: "human-required",
          outputClassification: "public",
          effect: operation.effect,
          code: "workos.relay.authorization-required",
          ...(handoff ? { handoff } : {}),
          effectRef: effect.effectRef,
        };
      }
      await ctx.environment.effects.complete(effect.effectRef, {
        status: response.status >= 500 ? "indeterminate" : "not-applied",
        at: ctx.environment.now(),
      });
      if (response.status === 401)
        throw new ConnectorError("denied", {
          detail: "workos.relay.key-rejected",
        });
      if (response.status === 429)
        throw new ConnectorError("rate-limited", {
          detail: "workos.throttled",
        });
      if (response.status === 404)
        throw new ConnectorError("unsupported", {
          detail:
            code === "relay-provider-not-configured"
              ? "workos.relay.not-configured"
              : "workos.relay.provider-unknown",
        });
      if (response.status === 502)
        throw new ConnectorError(
          code === "relay-credential-error"
            ? "upstream-rejected"
            : "upstream-unavailable",
          { detail: "workos.relay.upstream" },
        );
      throw new ConnectorError("invalid-request", {
        detail: "workos.relay.rejected",
      });
    }
    const status = Number(upstreamStatus);
    const ok = status >= 200 && status < 300;
    await ctx.environment.effects.complete(effect.effectRef, {
      status: ok ? "applied" : "not-applied",
      at: ctx.environment.now(),
    });
    return {
      state: ok ? "complete" : "failed",
      output: {
        status,
        body: payload ?? new TextDecoder().decode(response.body).slice(0, 4096),
      },
      outputClassification: operation.outputClassification,
      effect: operation.effect,
      ...(ok ? {} : { code: "workos.relay.provider-error" }),
      effectRef: effect.effectRef,
    };
  }

  const adapter: ConnectorAdapter = {
    id: WORKOS_ADAPTER_ID,
    ecosystem: "workos",
    adapterVersion: WORKOS_ADAPTER_VERSION,
    runtime: "hosted-server",
    displayName: "WorkOS Pipes",
    description:
      "Connect third-party accounts through WorkOS Pipes, either vending a provider token into host custody or relaying approved requests through WorkOS.",
    service: "workos-pipes",
    support: "provider-backed",
    custody: ["external-credential-broker", "external-execution-broker"],
    configuration: CONFIGURATION,
    profiles: [
      "external-broker",
      workOsPipesProfiles.credentials,
      workOsPipesProfiles.relay,
    ],
    capabilities(present) {
      const configuration = configurationNames.every((name) =>
        present.has(name),
      )
        ? ("ready" as const)
        : ("missing" as const);
      const rows: CapabilityStatus[] = [];
      for (const profile of [
        workOsPipesProfiles.credentials,
        workOsPipesProfiles.relay,
      ]) {
        for (const dimension of [
          "authorize",
          "verify",
          "reconnect",
          "disconnect",
        ] as const)
          rows.push(
            capabilityStatus(adapter, {
              dimension,
              profile,
              configuration,
              evidence: "protocol-fixture",
            }),
          );
      }
      rows.push(
        capabilityStatus(adapter, {
          dimension: "discover",
          profile: workOsPipesProfiles.credentials,
          configuration,
          evidence: "protocol-fixture",
          limitations: [
            "Lists the providers configured for the environment and the owner's connection state; it imports no definition.",
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "invoke",
          profile: workOsPipesProfiles.credentials,
          configuration,
          evidence: "protocol-fixture",
          limitations: [
            "Credential mode vends a provider token into host custody; it never calls a caller-selected host.",
            "WorkOS owns refresh for OAuth connections; this adapter re-vends rather than refreshing upstream.",
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "invoke",
          profile: workOsPipesProfiles.relay,
          configuration,
          evidence: "protocol-fixture",
          limitations: [
            "Relay mode forwards only the request the bound operation describes; no provider credential enters this process.",
            "Relay is in early access at WorkOS and must be enabled for the environment.",
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "revoke",
          profile: workOsPipesProfiles.credentials,
          implementation: "unsupported",
          limitations: [
            "WorkOS documents that deleting a connected account does not revoke access at the provider.",
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "import",
          profile: workOsPipesProfiles.credentials,
          implementation: "unsupported",
          limitations: ["Pipes publishes no importable connector description."],
        }),
        capabilityStatus(adapter, {
          dimension: "events",
          profile: workOsPipesProfiles.credentials,
          implementation: "unsupported",
          limitations: [
            "No Pipes connection-lifecycle webhook profile is documented for this adapter version.",
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "export",
          profile: workOsPipesProfiles.credentials,
          implementation: "unsupported",
          limitations: [],
        }),
        capabilityStatus(adapter, {
          dimension: "delegate",
          profile: workOsPipesProfiles.relay,
          implementation: "unsupported",
          limitations: [
            "Relay proxies one approved HTTP request; it delegates no task or workflow.",
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "configure",
          profile: workOsPipesProfiles.credentials,
          configuration,
          evidence: "unit",
          limitations: [],
        }),
      );
      return rows;
    },

    async discover(
      ctx: AdapterCallContext,
      input: DiscoverInput,
    ): Promise<DiscoverResult> {
      const ownerKind: OwnerKind =
        input.scope?.ownerKind === "organization" ? "organization" : "user";
      const resolved = await resolve(ctx, ownerKind);
      const path =
        resolved.connectionOwner === "organization"
          ? `/organizations/${encodePathSegment(
              resolved.principal.organizationId!,
            )}/data_providers`
          : `/user_management/users/${encodePathSegment(
              resolved.principal.userId,
            )}/data_providers`;
      const url = destinationUrl(resolved.destination, path);
      if (
        resolved.connectionOwner === "user" &&
        resolved.principal.organizationId
      )
        url.searchParams.set(
          "organization_id",
          resolved.principal.organizationId,
        );
      if (resolved.settings.multipleConnections)
        url.searchParams.set("supports_multiple_connections", "true");
      const response = await send(
        ctx,
        url,
        { method: "GET", headers: controlHeaders(resolved.apiKey) },
        { timeoutMs, maxBytes },
      );
      if (response.status !== 200)
        throw new ConnectorError(
          response.status >= 500 ? "upstream-unavailable" : "upstream-rejected",
          { detail: "workos.discover.rejected" },
        );
      const parsed = workOsDataProviderListSchema.safeParse(
        parseJson(response.body),
      );
      if (!parsed.success)
        throw new ConnectorError("upstream-rejected", {
          detail: "workos.discover.unreadable",
        });
      return {
        items: parsed.data.data.map((provider) => ({
          identity: {
            ecosystem: "workos",
            authorityNamespace: authorityInstance(resolved.clientId),
            nativeId: provider.slug,
            nativeVersion: WORKOS_ADAPTER_VERSION,
          },
          displayName: provider.name,
          description: provider.description ?? "",
          provenance: {
            connectionOwner: provider.connection_owner ?? "user",
            state: provider.connected_account?.state ?? "not-installed",
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
      return startAuthorization(ctx, intent, "connect");
    },

    async reconnect(ctx, intent) {
      if (!ctx.connection)
        throw new ConnectorError("invalid-request", {
          detail: "workos.connection.required",
        });
      return startAuthorization(ctx, intent, "reconnect");
    },

    async complete(
      ctx: AdapterCallContext,
      input: CompletionInput,
    ): Promise<CompletionResult> {
      // A return navigation is a hint that it is worth asking WorkOS again. It
      // is not evidence: the correlation must match the pending handoff, and
      // the answer comes from the connected-account record either way.
      if (input.kind === "redirect") {
        const correlation = input.url.searchParams.get(
          WORKOS_RETURN_CORRELATION_PARAMETER,
        );
        if (
          !ctx.handoff ||
          !correlation ||
          ctx.handoff.correlationKey !== correlation
        )
          return {
            state: "denied",
            claims: [],
            code: "workos.callback.correlation",
          };
        if (ctx.handoff.generation !== ctx.generation)
          return { state: "denied", claims: [], code: "workos.callback.stale" };
      }
      if (input.kind === "input" || input.kind === "event")
        return {
          state: "pending",
          claims: [],
          code: "workos.unsupported-completion",
        };
      const allowSwitch = ctx.handoff?.private.accountSwitch === "true";
      return authoritativeState(ctx, allowSwitch);
    },

    async verify(ctx) {
      return authoritativeState(ctx, false);
    },

    async invoke(
      ctx: AdapterCallContext,
      request: InvokeRequest,
    ): Promise<InvokeResult> {
      const operation = boundOperation(ctx.binding, request.operationRef);
      if (!operation)
        throw new ConnectorError("not-found", {
          detail: "workos.operation.unknown",
        });
      destinationFor(ctx.binding, operation);
      const resolved = await resolve(
        ctx,
        ctx.connection?.ownerKind ?? "user",
        ctx.connection?.ownerId,
      );
      if (resolved.settings.mode === "credentials") {
        if (
          operation.transport.kind !== "broker-action" ||
          operation.transport.action !== WORKOS_CREDENTIALS_ACTION
        )
          throw new ConnectorError("denied", {
            detail: "workos.operation.mode-mismatch",
          });
        return vendCredential(ctx, resolved, operation, request);
      }
      if (operation.transport.kind !== "http")
        throw new ConnectorError("denied", {
          detail: "workos.operation.mode-mismatch",
        });
      return relayInvoke(ctx, resolved, operation, request);
    },

    async disconnect(
      ctx: AdapterCallContext,
      scope: DisconnectScope,
    ): Promise<DisconnectResult> {
      if (scope === "local")
        return {
          local: "applied",
          broker: "not-attempted",
          upstream: "not-attempted",
        };
      if (scope === "upstream")
        // Documented: deleting the connected account removes WorkOS's stored
        // tokens and does not revoke the grant at the provider.
        return {
          local: "not-attempted",
          broker: "not-attempted",
          upstream: "unsupported",
        };
      const resolved = await resolve(
        ctx,
        ctx.connection?.ownerKind ?? "user",
        ctx.connection?.ownerId,
      );
      const url = destinationUrl(
        resolved.destination,
        accountPath(resolved, resolved.settings.provider),
      );
      const connectedAccountId = ctx.connection?.externalIds.connectedAccountId;
      if (resolved.settings.multipleConnections && connectedAccountId)
        url.searchParams.set("connected_account_id", connectedAccountId);
      const effect = await beginEffect(ctx, "workos.pipes.disconnect", {
        provider: resolved.settings.provider,
        owner: resolved.connectionOwner,
        connectedAccountId: connectedAccountId ?? null,
      });
      const response = await send(
        ctx,
        url,
        { method: "DELETE", headers: controlHeaders(resolved.apiKey) },
        { timeoutMs, maxBytes },
      );
      const applied = response.status === 204 || response.status === 200;
      const gone = response.status === 404;
      await ctx.environment.effects.complete(effect.effectRef, {
        status: applied || gone ? "applied" : "failed",
        at: ctx.environment.now(),
      });
      return {
        local: "applied",
        broker: applied || gone ? "applied" : "failed",
        upstream: "unsupported",
      };
    },

    async revoke(): Promise<DisconnectResult> {
      // There is no documented Pipes operation that revokes the grant at the
      // provider. Saying so is the deliverable; pretending otherwise is not.
      return {
        local: "not-attempted",
        broker: "not-attempted",
        upstream: "unsupported",
      };
    },
  };

  return adapter;
}

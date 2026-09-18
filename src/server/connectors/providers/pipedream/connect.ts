import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  canonicalConnectorJson,
  encodePathSegment,
} from "../../../../core/connectors/index.js";
import type {
  AuthorizationIntent,
  AuthorizationStart,
  CompletionInput,
  CompletionResult,
  VerificationClaim,
} from "../../adapter.js";
import { ConnectorError } from "../../errors.js";
import type { HandoffRecord } from "../../ports.js";
import { expectJson, upstreamFailure } from "./client.js";
import {
  connectionScope,
  deploymentOrigin,
  guardConnection,
  type PipedreamCall,
} from "./context.js";
import {
  pipedreamAccountIdSchema,
  pipedreamConnectTokenSchema,
  pipedreamTenantRoute,
  sha256Hex,
} from "./identity.js";
import {
  accountSchema,
  connectTokenSchema,
  CONNECT_TOKEN_MAX_LIFETIME_MS,
  type PipedreamAccount,
} from "./wire.js";

/*
 * Managed auth (PD-02). The adapter creates a connect token bound to the
 * host-derived external user, restricted to the deployment origin, with
 * return routes on the deployment origin; the token and the Connect Link are
 * private handoff material. Nothing that comes back from the browser or from
 * the unsigned connection webhook is believed: the redirect must carry the
 * handoff's own state, the webhook hint must carry the documented connect
 * token correlation, and in both cases the connection is completed only by a
 * trusted server query that finds an account for this external user and this
 * app. A second account for the same app never replaces a bound one without
 * an explicit account-switch intent.
 */

export const PIPEDREAM_PROFILE_ID = "pipedream-connect";
export const ACCOUNT_TARGET_KIND = "pipedream-account";
export const APP_TARGET_KIND = "pipedream-app";
/** Clock skew tolerated between token issue and the broker's account timestamps. */
const FRESHNESS_SKEW_MS = 5 * 60 * 1000;

const denied = (detail: string) => new ConnectorError("denied", { detail });

export type AccountView = {
  id: string;
  externalId: string;
  app: string;
  appName: string;
  healthy: boolean;
  dead: boolean;
  createdAt: number;
  updatedAt: number;
  scopes: string[];
  expiresAt?: number;
  oauthAppId?: string;
};

export function accountView(raw: PipedreamAccount): AccountView {
  const created = Date.parse(raw.created_at);
  const updated = raw.updated_at ? Date.parse(raw.updated_at) : Number.NaN;
  const createdAt = Number.isFinite(created) ? created : 0;
  const expires = raw.expires_at ? Date.parse(raw.expires_at) : Number.NaN;
  return {
    id: raw.id,
    externalId: raw.external_id,
    app: raw.app.name_slug,
    appName: raw.app.name,
    healthy: raw.healthy === true,
    dead: raw.dead === true,
    createdAt,
    updatedAt: Number.isFinite(updated) ? updated : createdAt,
    scopes: (raw.authorized_scopes ?? [])
      .filter((scope) => scope.length > 0 && scope.length <= 200)
      .slice(0, 64),
    ...(Number.isFinite(expires) ? { expiresAt: expires } : {}),
    ...(raw.app.id ? { oauthAppId: raw.app.id } : {}),
  };
}

const wrappedAccountSchema = z.looseObject({ data: accountSchema });
const wrappedAccountsSchema = z.looseObject({ data: z.array(accountSchema) });

/** The retrieve endpoint is documented bare; a data wrapper is tolerated. */
function unwrapAccount(json: unknown): AccountView {
  const wrapped = wrappedAccountSchema.safeParse(json);
  if (wrapped.success) return accountView(wrapped.data.data);
  const bare = accountSchema.safeParse(json);
  if (bare.success) return accountView(bare.data);
  throw new ConnectorError("upstream-rejected", {
    detail: "pipedream.response.malformed",
  });
}

function unwrapAccounts(json: unknown): AccountView[] {
  const bare = z.array(accountSchema).safeParse(json);
  if (bare.success) return bare.data.map(accountView);
  const wrapped = wrappedAccountsSchema.safeParse(json);
  if (wrapped.success) return wrapped.data.data.map(accountView);
  throw new ConnectorError("upstream-rejected", {
    detail: "pipedream.response.malformed",
  });
}

function constantEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function connectLink(call: PipedreamCall, raw: string): string {
  if (!URL.canParse(raw))
    throw new ConnectorError("upstream-rejected", {
      detail: "pipedream.connect-link.malformed",
    });
  const url = new URL(raw);
  const allowed = new Set([
    ...call.options.connectLinkOrigins,
    ...(call.settings.connectLinkOrigin
      ? [call.settings.connectLinkOrigin]
      : []),
  ]);
  if (!allowed.has(url.origin) || url.username || url.password || url.hash)
    throw new ConnectorError("upstream-rejected", {
      detail: "pipedream.connect-link.origin",
    });
  // The documented Connect Link takes the app as a query parameter; the binding's app, never input.
  url.searchParams.set("app", call.settings.app);
  return url.href;
}

export async function pipedreamAuthorize(
  call: PipedreamCall,
  intent: AuthorizationIntent,
  mode: "authorize" | "reconnect",
): Promise<AuthorizationStart> {
  const { ctx, settings, config } = call;
  if (intent.profileId !== undefined && intent.profileId !== PIPEDREAM_PROFILE_ID)
    return { kind: "unsupported", code: "pipedream.profile.unknown" };
  if (ctx.connection) guardConnection(call);
  else if (mode === "reconnect")
    throw new ConnectorError("not-found", {
      detail: "pipedream.connection.missing",
    });
  let requestedAccountId: string | undefined;
  if (intent.target) {
    if (intent.target.kind === APP_TARGET_KIND) {
      if (intent.target.id !== settings.app)
        throw denied("pipedream.app.mismatch");
    } else if (intent.target.kind === ACCOUNT_TARGET_KIND) {
      const id = pipedreamAccountIdSchema.safeParse(intent.target.id);
      if (!id.success)
        throw new ConnectorError("invalid-request", {
          detail: "pipedream.account.invalid",
        });
      requestedAccountId = id.data;
    } else return { kind: "unsupported", code: "pipedream.target.unsupported" };
  }
  if (intent.interruption === "none")
    return { kind: "human-required", code: "pipedream.connect.human-required" };
  const bound = ctx.connection?.externalIds.accountId;
  if (
    requestedAccountId &&
    bound &&
    requestedAccountId !== bound &&
    !intent.accountSwitch
  )
    return { kind: "human-required", code: "pipedream.account.switch-required" };

  const origin = deploymentOrigin(ctx.environment.origin);
  const state = Buffer.from(ctx.environment.random.bytes(32)).toString(
    "base64url",
  );
  const returnUrl = (outcome: "success" | "error") => {
    const url = new URL(call.options.returnPath, origin);
    url.searchParams.set("state", state);
    url.searchParams.set("outcome", outcome);
    return url.href;
  };
  const webhookUri =
    call.options.connectionWebhookPath === undefined
      ? undefined
      : new URL(
          `${call.options.connectionWebhookPath.replace(/\/+$/, "")}/${pipedreamTenantRoute(ctx.actor.tenantId)}`,
          origin,
        ).href;
  const now = ctx.environment.now();
  const effect = await ctx.environment.effects.begin({
    actor: ctx.actor,
    ...(ctx.connection ? { connectionRef: ctx.connection.connectionRef } : {}),
    bindingRef: ctx.binding.bindingRef,
    operation: "pipedream.connect.token",
    digest: sha256Hex(
      canonicalConnectorJson({
        tenantId: ctx.actor.tenantId,
        externalUserId: call.externalUserId,
        app: settings.app,
        environment: config.environment,
        projectId: config.projectId,
        state,
      }),
    ),
  });
  let data: z.infer<typeof connectTokenSchema>;
  try {
    const response = await call.client.send({
      method: "POST",
      path: call.client.projectPath("/tokens"),
      body: {
        external_user_id: call.externalUserId,
        allowed_origins: [origin],
        success_redirect_uri: returnUrl("success"),
        error_redirect_uri: returnUrl("error"),
        ...(webhookUri ? { webhook_uri: webhookUri } : {}),
      },
      timeoutMs: call.options.timeouts.write,
      consequential: true,
    });
    data = expectJson(response, connectTokenSchema);
  } catch (error) {
    await ctx.environment.effects.complete(effect.effectRef, {
      status:
        error instanceof ConnectorError && error.code === "indeterminate"
          ? "indeterminate"
          : "failed",
      ...(error instanceof ConnectorError ? { code: error.code } : {}),
      at: ctx.environment.now(),
    });
    throw error;
  }
  await ctx.environment.effects.complete(effect.effectRef, {
    status: "applied",
    at: ctx.environment.now(),
  });
  const link = connectLink(call, data.connect_link_url);
  const upstreamExpiry = Date.parse(data.expires_at);
  const expiresAt = Math.min(
    Number.isFinite(upstreamExpiry) && upstreamExpiry > now
      ? upstreamExpiry
      : now + CONNECT_TOKEN_MAX_LIFETIME_MS,
    now + CONNECT_TOKEN_MAX_LIFETIME_MS,
  );
  return {
    kind: "handoff",
    handoff: {
      kind: "connect-widget",
      presentation: "popup",
      expiresAt,
      intent: mode === "reconnect" ? "pipedream.reconnect" : "pipedream.connect",
      // The routing index holds a digest, not the token: correlation needs to
      // recognise a completion, not to be able to complete one.
      correlationKey: sha256Hex(data.token),
      private: {
        connectToken: data.token,
        connectLinkUrl: link,
        returnState: state,
        app: settings.app,
        externalUserId: call.externalUserId,
        environment: config.environment,
        projectId: config.projectId,
        accountSwitch: intent.accountSwitch ? "true" : "false",
        issuedAt: String(now),
        ...(bound ? { boundAccountId: bound } : {}),
        ...(requestedAccountId ? { requestedAccountId } : {}),
      },
    },
  };
}

async function loadHandoff(
  call: PipedreamCall,
  input: CompletionInput,
): Promise<HandoffRecord> {
  const { ctx } = call;
  const connection = guardConnection(call);
  let record: HandoffRecord | undefined;
  if (input.kind === "input") {
    const token = pipedreamConnectTokenSchema.safeParse(
      input.values.connect_token,
    );
    if (!token.success) throw denied("pipedream.handoff.correlation");
    record = await ctx.environment.handoffs.resolveCorrelation(
      ctx.actor.tenantId,
      sha256Hex(token.data),
    );
  } else {
    const summary = connection.handoff;
    if (!summary)
      throw new ConnectorError("invalid-request", {
        detail: "pipedream.handoff.none",
      });
    record = await ctx.environment.handoffs.present(
      ctx.actor,
      summary.handoffRef,
    );
  }
  if (
    !record ||
    record.tenantId !== ctx.actor.tenantId ||
    record.connectionRef !== connection.connectionRef ||
    record.bindingRef !== ctx.binding.bindingRef
  )
    throw denied("pipedream.handoff.owner");
  if (record.generation !== ctx.generation)
    throw denied("pipedream.handoff.stale");
  if (record.expiresAt > ctx.environment.now()) {
    if (record.state !== "issued" && record.state !== "waiting")
      throw new ConnectorError("expired", {
        detail: "pipedream.handoff.consumed",
      });
  }
  const material = record.private;
  if (material.externalUserId !== call.externalUserId)
    throw denied("pipedream.external-user.mismatch");
  if (material.app !== call.settings.app) throw denied("pipedream.app.mismatch");
  if (
    material.environment !== call.config.environment ||
    material.projectId !== call.config.projectId
  )
    throw denied("pipedream.environment.mismatch");
  return record;
}

async function settle(
  call: PipedreamCall,
  record: HandoffRecord,
  state: "denied" | "expired",
): Promise<void> {
  try {
    await call.ctx.environment.handoffs.complete(
      record.handoffRef,
      call.ctx.generation,
      state,
    );
  } catch {
    // Already settled by an earlier completion; nothing to reopen.
  }
}

type Decision =
  | { kind: "bind"; account: AccountView }
  | { kind: "pending" }
  | { kind: "selection-required" }
  | { kind: "switch-required" };

async function fetchAccount(
  call: PipedreamCall,
  accountId: string,
): Promise<AccountView | undefined> {
  const response = await call.client.send({
    method: "GET",
    path: call.client.projectPath(
      `/accounts/${encodePathSegment(accountId)}`,
    ),
    timeoutMs: call.options.timeouts.read,
    consequential: false,
  });
  if (response.status === 404) return undefined;
  if (response.status < 200 || response.status >= 300)
    throw upstreamFailure(response.status);
  return unwrapAccount(response.json);
}

function ownAccount(call: PipedreamCall, account: AccountView): boolean {
  return (
    account.externalId === call.externalUserId &&
    account.app === call.settings.app
  );
}

function decideBound(
  record: HandoffRecord,
  account: AccountView,
): Decision {
  const bound = record.private.boundAccountId;
  if (bound && bound !== account.id && record.private.accountSwitch !== "true")
    return { kind: "switch-required" };
  return { kind: "bind", account };
}

/** The webhook hint named an account: fetch it and believe only what the trusted query says. */
async function decideByHint(
  call: PipedreamCall,
  record: HandoffRecord,
  hint: string,
): Promise<Decision> {
  const account = await fetchAccount(call, hint);
  if (!account || !ownAccount(call, account))
    throw denied("pipedream.account.mismatch");
  const requested = record.private.requestedAccountId;
  if (requested && requested !== account.id)
    throw denied("pipedream.account.mismatch");
  return decideBound(record, account);
}

/** No hint: list this external user's accounts for the app and look for what the handoff produced. */
async function decideByListing(
  call: PipedreamCall,
  record: HandoffRecord,
): Promise<Decision> {
  const response = await call.client.send({
    method: "GET",
    path: call.client.projectPath(
      `/users/${encodePathSegment(call.externalUserId)}/accounts`,
    ),
    query: { app: call.settings.app },
    timeoutMs: call.options.timeouts.read,
    consequential: false,
  });
  if (response.status < 200 || response.status >= 300)
    throw upstreamFailure(response.status);
  const accounts = unwrapAccounts(response.json).filter((account) =>
    ownAccount(call, account),
  );
  const requested = record.private.requestedAccountId;
  if (requested) {
    const match = accounts.find((account) => account.id === requested);
    return match ? decideBound(record, match) : { kind: "pending" };
  }
  const issuedAt = Number(record.private.issuedAt) || record.issuedAt;
  const fresh = accounts.filter(
    (account) =>
      Math.max(account.createdAt, account.updatedAt) >=
      issuedAt - FRESHNESS_SKEW_MS,
  );
  const bound = record.private.boundAccountId;
  if (bound) {
    // A connection that already names an account only ever reconnects that
    // account. Any other account the handoff produced is a replacement, and a
    // replacement needs an explicit human account-switch intent.
    const others = fresh.filter((account) => account.id !== bound);
    if (!others.length) {
      const same = fresh.find((account) => account.id === bound);
      return same ? { kind: "bind", account: same } : { kind: "pending" };
    }
    if (record.private.accountSwitch !== "true")
      return { kind: "switch-required" };
    return others.length === 1
      ? { kind: "bind", account: others[0]! }
      : { kind: "selection-required" };
  }
  if (fresh.length === 1) return decideBound(record, fresh[0]!);
  if (fresh.length > 1) return { kind: "selection-required" };
  return { kind: "pending" };
}

function accountClaims(
  call: PipedreamCall,
  account: AccountView,
  observedAt: number,
): VerificationClaim[] {
  const base = {
    evidenceRef: `pipedream:${account.id}:${observedAt}`,
    issuer: "external-broker" as const,
    target: { kind: ACCOUNT_TARGET_KIND, id: account.id },
    observedAt: new Date(observedAt).toISOString(),
    verifierVersion: call.adapterVersion,
    bindingRevision: call.ctx.binding.revision,
    policyRevision: call.ctx.binding.policyRevision,
  };
  const claims: VerificationClaim[] = [
    {
      ...base,
      kind: "account-identity",
      permissions: {
        requested: [],
        reported: account.scopes,
        observed: [],
        semantics: account.scopes.length ? "provider-scopes" : "unknown",
      },
      limitations: [
        "Identity is the broker's account record for the host-derived external user; the provider account was not queried by Ceremony.",
        `App identity is the configured slug ${call.settings.app}; display names are not compared.`,
      ],
    },
  ];
  if (account.healthy && !account.dead)
    claims.push({
      ...base,
      evidenceRef: `${base.evidenceRef}:health`,
      kind: "credential-accepted",
      ...(account.expiresAt !== undefined && account.expiresAt > observedAt
        ? { validUntil: new Date(account.expiresAt).toISOString() }
        : {}),
      limitations: [
        "Broker-reported health flag; no Ceremony request used the credential.",
      ],
    });
  return claims;
}

function completion(
  call: PipedreamCall,
  account: AccountView,
  observedAt: number,
  extra: { credentialRef?: string; code?: string; state: "complete" | "human-required" },
): CompletionResult {
  return {
    state: extra.state,
    claims: accountClaims(call, account, observedAt),
    ...(extra.credentialRef ? { credentialRef: extra.credentialRef } : {}),
    externalIds: {
      accountId: account.id,
      externalUserId: call.externalUserId,
      app: call.settings.app,
      projectId: call.config.projectId,
      environment: call.config.environment,
      ...(account.oauthAppId ? { oauthAppId: account.oauthAppId } : {}),
    },
    target: { kind: ACCOUNT_TARGET_KIND, id: account.id },
    ...(extra.code ? { code: extra.code } : {}),
    adapterState: {
      pipedream: {
        app: call.settings.app,
        projectId: call.config.projectId,
        environment: call.config.environment,
        accountHealthy: account.healthy && !account.dead,
        verifiedAt: new Date(observedAt).toISOString(),
      },
    },
  };
}

async function bind(
  call: PipedreamCall,
  record: HandoffRecord,
  account: AccountView,
  previousRef: string | undefined,
): Promise<CompletionResult> {
  const { ctx } = call;
  try {
    await ctx.environment.handoffs.complete(
      record.handoffRef,
      ctx.generation,
      "completed",
    );
  } catch {
    throw new ConnectorError("expired", {
      detail: "pipedream.handoff.consumed",
    });
  }
  const credentialRef = await ctx.environment.credentials.store(
    connectionScope(ctx, "external-credential-broker"),
    {
      accountId: account.id,
      externalUserId: call.externalUserId,
      projectId: call.config.projectId,
      environment: call.config.environment,
      app: call.settings.app,
    },
    previousRef ? { replaces: previousRef } : {},
  );
  return completion(call, account, ctx.environment.now(), {
    credentialRef,
    state: "complete",
  });
}

export async function pipedreamComplete(
  call: PipedreamCall,
  input: CompletionInput,
): Promise<CompletionResult> {
  const { ctx } = call;
  if (input.kind === "event")
    // Connection webhooks are unsigned; they arrive as hints (`input`), never as verified events.
    throw new ConnectorError("unsupported", {
      detail: "pipedream.complete.event",
    });
  const connection = guardConnection(call);
  const record = await loadHandoff(call, input);
  if (record.expiresAt <= ctx.environment.now()) {
    await settle(call, record, "expired");
    return { state: "expired", claims: [], code: "pipedream.handoff.expired" };
  }
  let hint: string | undefined;
  if (input.kind === "redirect") {
    const url = input.url;
    if (
      url.origin !== deploymentOrigin(ctx.environment.origin) ||
      url.pathname !== call.options.returnPath
    )
      throw denied("pipedream.return.origin");
    const states = url.searchParams.getAll("state");
    if (
      states.length !== 1 ||
      !constantEquals(states[0]!, record.private.returnState ?? "")
    )
      throw denied("pipedream.return.state");
    if (url.searchParams.get("outcome") === "error") {
      await settle(call, record, "denied");
      return { state: "denied", claims: [], code: "pipedream.connect.error" };
    }
  } else if (input.kind === "input") {
    if (
      !constantEquals(
        sha256Hex(input.values.connect_token ?? ""),
        record.correlationKey ?? "",
      ) ||
      !constantEquals(
        input.values.connect_token ?? "",
        record.private.connectToken ?? "",
      )
    )
      throw denied("pipedream.handoff.correlation");
    if (input.values.event === "CONNECTION_ERROR") {
      await settle(call, record, "denied");
      return { state: "denied", claims: [], code: "pipedream.connect.error" };
    }
    if (input.values.account_id !== undefined) {
      const parsed = pipedreamAccountIdSchema.safeParse(
        input.values.account_id,
      );
      if (!parsed.success) throw denied("pipedream.account.mismatch");
      hint = parsed.data;
    }
  }
  const decision = hint
    ? await decideByHint(call, record, hint)
    : await decideByListing(call, record);
  switch (decision.kind) {
    case "pending":
      return { state: "pending", claims: [], code: "pipedream.connect.pending" };
    case "selection-required":
      return {
        state: "human-required",
        claims: [],
        code: "pipedream.account.selection-required",
      };
    case "switch-required":
      await settle(call, record, "denied");
      return {
        state: "denied",
        claims: [],
        code: "pipedream.account.switch-required",
      };
    case "bind":
      return bind(call, record, decision.account, connection.credentialRef);
  }
}

/** Re-reads the bound account through custody and reports what the broker says now. */
export async function pipedreamVerify(
  call: PipedreamCall,
): Promise<CompletionResult> {
  const { ctx } = call;
  const connection = guardConnection(call);
  const boundId = connection.externalIds.accountId;
  if (!connection.credentialRef || !boundId)
    return { state: "pending", claims: [], code: "pipedream.connection.unbound" };
  const looked = await ctx.environment.credentials.use(
    connectionScope(ctx, "external-credential-broker"),
    connection.credentialRef,
    async (material) => {
      if (material.accountId !== boundId) return { kind: "mismatch" as const };
      const account = await fetchAccount(call, boundId);
      return account
        ? { kind: "account" as const, account }
        : { kind: "missing" as const };
    },
  );
  if (looked.kind === "mismatch") throw denied("pipedream.credential.mismatch");
  if (looked.kind === "missing")
    return { state: "expired", claims: [], code: "pipedream.account.missing" };
  if (!ownAccount(call, looked.account))
    throw denied("pipedream.account.mismatch");
  const observedAt = ctx.environment.now();
  if (looked.account.dead || !looked.account.healthy)
    return completion(call, looked.account, observedAt, {
      state: "human-required",
      code: "pipedream.account.unhealthy",
    });
  return completion(call, looked.account, observedAt, { state: "complete" });
}

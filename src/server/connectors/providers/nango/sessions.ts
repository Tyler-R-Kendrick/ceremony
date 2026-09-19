import {
  canonicalConnectorJson,
  type VerificationClaim,
} from "../../../../core/connectors/index.js";
import type {
  AdapterCallContext,
  AuthorizationIntent,
  AuthorizationStart,
  CompletionInput,
  CompletionResult,
} from "../../adapter.js";
import { boundOperation } from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import type {
  ConnectionRecord,
  HandoffRecord,
  VerifiedEventEnvelope,
} from "../../ports.js";
import {
  brokerReference,
  credentialScope,
  deriveTags,
  freshNonce,
  missingRequired,
  presentConfiguration,
  reconnectCorrelationKey,
  requireConnection,
  resolveNango,
  sha256,
  TAG_KEYS,
  tenantDigest,
  type BrokerReference,
  type NangoRuntime,
  type Resolved,
} from "./context.js";
import { contractFor, executeOperation, readPointer } from "./invoke.js";
import {
  authorizationIntentSchema,
  authWebhookSchema,
  NANGO_PROFILE_IDS,
  NANGO_SESSION_TTL_MS,
  type NangoConnectionListItem,
} from "./schemas.js";

/*
 * NG-02: connect and reconnect sessions. The adapter asks Nango for a
 * short-lived session restricted to the one integration the binding names,
 * tagged with values derived from the authenticated actor, and hands the
 * token and link to the command layer as protected handoff material. Nothing
 * a browser or model sends back completes the handoff: completion reads the
 * authoritative connection list (and, for reconnects, an HMAC-verified
 * override webhook), fenced by the connection generation and the one-use
 * handoff completion.
 */

export const NANGO_ADAPTER_VERSION = "1.0.0";
const NANGO_CONNECTION_TARGET = "nango-connection";

const parseIso = (value: string | undefined) => {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : undefined;
};

const hasAuthError = (item: NangoConnectionListItem) =>
  (item.errors ?? []).some((error) => error.type === "auth");

function parseIntent(intent: AuthorizationIntent) {
  const parsed = authorizationIntentSchema.safeParse(intent);
  if (!parsed.success)
    throw new ConnectorError("invalid-request", {
      detail: "nango.intent.invalid",
    });
  const knownProfiles: readonly string[] = Object.values(NANGO_PROFILE_IDS);
  if (parsed.data.profileId && !knownProfiles.includes(parsed.data.profileId))
    throw new ConnectorError("invalid-request", {
      detail: "nango.intent.profile",
    });
  return parsed.data;
}

async function currentListItem(
  resolved: Resolved,
  connectionId: string,
): Promise<NangoConnectionListItem | undefined> {
  const list = await resolved.client.listConnections({ connectionId });
  return list.connections.find(
    (item) =>
      item.connection_id === connectionId &&
      item.provider_config_key === resolved.settings.integration.uniqueKey,
  );
}

/** Starts a connect (mode "connect") or reconnect (mode "reconnect") session. */
export async function authorizeNango(
  runtime: NangoRuntime,
  ctx: AdapterCallContext,
  intent: AuthorizationIntent,
  mode: "connect" | "reconnect",
): Promise<AuthorizationStart> {
  const parsed = parseIntent(intent);
  const present = await presentConfiguration(ctx);
  const missing = missingRequired(present);
  if (missing.length) return { kind: "configuration-required", missing };
  const resolved = await resolveNango(runtime, ctx);
  const connection = requireConnection(resolved);
  if (parsed.ownerKind === "workload")
    return { kind: "unsupported", code: "nango.owner.workload" };
  if (parsed.interruption === "none")
    return { kind: "human-required", code: "nango.connect.human-required" };
  if (!resolved.connect)
    throw new ConnectorError("network-policy", {
      detail: "nango.destination.connect-missing",
    });
  const nonce = freshNonce(ctx);
  const tags = deriveTags({
    runtime,
    ctx,
    connection,
    ownerKind: parsed.ownerKind,
    nonce,
  });
  const override = resolved.settings.webhookUrlOverride;
  const webhook = override ? { webhook_url_override: override.url } : {};
  const integration = resolved.settings.integration.uniqueKey;
  const now = ctx.environment.now();
  let reference: BrokerReference | undefined;
  let priorAuthError = false;
  if (mode === "reconnect") {
    reference = brokerReference(resolved);
    const item = await currentListItem(resolved, reference.connectionId);
    if (!item)
      throw new ConnectorError("not-found", {
        detail: "nango.connection.missing",
      });
    priorAuthError = hasAuthError(item);
  }
  const journal = await ctx.environment.effects.begin({
    actor: ctx.actor,
    connectionRef: connection.connectionRef,
    bindingRef: ctx.binding.bindingRef,
    operation:
      mode === "connect" ? "nango.connect.session" : "nango.reconnect.session",
    digest: sha256(
      canonicalConnectorJson({
        tenant: ctx.actor.tenantId,
        connection: connection.connectionRef,
        generation: ctx.generation,
        nonce,
      }),
    ),
  });
  let session;
  try {
    session =
      mode === "connect"
        ? await resolved.client.createConnectSession({
            tags,
            allowed_integrations: [integration],
            ...webhook,
          })
        : await resolved.client.createReconnectSession({
            connection_id: reference!.connectionId,
            integration_id: integration,
            tags,
            ...webhook,
          });
  } catch (error) {
    await ctx.environment.effects.complete(journal.effectRef, {
      status: "failed",
      code:
        error instanceof ConnectorError
          ? (error.detail ?? error.code)
          : "nango.session.error",
      at: ctx.environment.now(),
    });
    throw error;
  }
  await ctx.environment.effects.complete(journal.effectRef, {
    status: "applied",
    at: ctx.environment.now(),
  });
  const documented = parseIso(session.data.expires_at);
  const expiresAt = Math.min(
    documented ?? Number.POSITIVE_INFINITY,
    now + NANGO_SESSION_TTL_MS,
  );
  if (expiresAt <= now)
    throw new ConnectorError("upstream-rejected", {
      detail: "nango.session.expired-on-issue",
    });
  const link = session.data.connect_link;
  const linkOk =
    link !== undefined &&
    URL.canParse(link) &&
    new URL(link).origin === resolved.connect.origin &&
    !new URL(link).username &&
    !new URL(link).hash;
  return {
    kind: "handoff",
    handoff: {
      kind: "connect-widget",
      presentation: resolved.settings.presentation,
      expiresAt,
      intent: mode === "connect" ? "nango.connect" : "nango.reconnect",
      correlationKey:
        mode === "connect"
          ? nonce
          : reconnectCorrelationKey(connection.connectionRef, ctx.generation),
      private: {
        token: session.data.token,
        expiresAt: new Date(expiresAt).toISOString(),
        ...(linkOk ? { connectLink: link } : {}),
        connectOrigin: resolved.connect.origin,
        apiOrigin: resolved.api.origin,
        integration,
        nonce,
        mode,
        ownerKind: parsed.ownerKind,
        accountSwitch: String(parsed.accountSwitch),
        priorAuthError: String(priorAuthError),
        requestedPermissions: JSON.stringify(parsed.requestedPermissions),
        ...(parsed.target ? { target: JSON.stringify(parsed.target) } : {}),
      },
    },
  };
}

type Finalize = {
  item: NangoConnectionListItem;
  mode: "connect" | "reconnect";
  handoff: HandoffRecord | undefined;
  handoffRef: string | undefined;
};

function claim(
  resolved: Resolved,
  input: {
    kind: VerificationClaim["kind"];
    issuer: VerificationClaim["issuer"];
    target: VerificationClaim["target"];
    requested?: string[];
    limitations: string[];
  },
): VerificationClaim {
  const { ctx } = resolved;
  return {
    kind: input.kind,
    evidenceRef: `nango:evidence:${ctx.environment.random.uuid()}`,
    issuer: input.issuer,
    target: input.target,
    observedAt: new Date(ctx.environment.now()).toISOString(),
    verifierVersion: NANGO_ADAPTER_VERSION,
    bindingRevision: ctx.binding.revision,
    policyRevision: ctx.binding.policyRevision,
    permissions: {
      requested: input.requested ?? [],
      reported: [],
      observed: [],
      semantics: "unknown",
    },
    limitations: input.limitations,
  };
}

const existenceLimitations = [
  "Nango reports that the connection exists in this integration and environment and whether credential refresh failed; it does not report the provider account identity.",
  "Requested permissions are not sent to Nango; scopes are configured on the integration in Nango.",
];

/** Runs the binding's verification operation, when one is approved, and reads the account identity from its output. */
async function observeAccount(
  resolved: Resolved,
  reference: BrokerReference,
): Promise<{ kind: string; id: string } | undefined> {
  const verification = resolved.settings.verification;
  if (!verification) return undefined;
  const operation = boundOperation(
    resolved.ctx.binding,
    verification.operationRef,
  );
  if (
    !operation ||
    operation.transport.kind !== "http" ||
    operation.effect !== "read" ||
    operation.replay !== "read-only"
  )
    throw new ConnectorError("configuration-required", {
      detail: "nango.verification.operation",
    });
  const outcome = await executeOperation(
    resolved,
    reference,
    operation,
    contractFor(resolved, operation),
    {},
  );
  if (outcome.status < 200 || outcome.status >= 300)
    throw new ConnectorError("upstream-rejected", {
      detail: "nango.verification.failed",
    });
  const id = readPointer(outcome.output, verification.identityPointer);
  if (!id || id.length > 512 || /[\p{Cc}]/u.test(id))
    throw new ConnectorError("upstream-rejected", {
      detail: "nango.verification.identity",
    });
  return { kind: verification.targetKind, id };
}

async function finalize(
  resolved: Resolved,
  connection: ConnectionRecord,
  input: Finalize,
): Promise<CompletionResult> {
  const { ctx } = resolved;
  const item = input.item;
  const reference: BrokerReference = {
    connectionId: item.connection_id,
    providerConfigKey: item.provider_config_key,
    provider: item.provider,
    environment: resolved.environment,
    authority: resolved.authority,
  };
  const externalIds = {
    connectionId: item.connection_id,
    providerConfigKey: item.provider_config_key,
    provider: item.provider,
    environment: resolved.environment,
    nangoInternalId: String(item.id),
  };
  const priv = input.handoff?.private ?? {};
  const requested = (() => {
    try {
      const value: unknown = JSON.parse(priv.requestedPermissions ?? "[]");
      return Array.isArray(value)
        ? value.filter((v) => typeof v === "string").slice(0, 64)
        : [];
    } catch {
      return [];
    }
  })();
  const intendedTarget = (() => {
    try {
      return priv.target
        ? (JSON.parse(priv.target) as { kind: string; id: string })
        : undefined;
    } catch {
      return undefined;
    }
  })();
  const claims: VerificationClaim[] = [
    claim(resolved, {
      kind: "credential-accepted",
      issuer: "external-broker",
      target: { kind: NANGO_CONNECTION_TARGET, id: item.connection_id },
      requested,
      limitations: existenceLimitations,
    }),
  ];
  const deny = async (code: string): Promise<CompletionResult> => {
    if (input.handoffRef)
      await ctx.environment.handoffs
        .complete(input.handoffRef, ctx.generation, "denied")
        .catch(() => undefined);
    return { state: "denied", claims, externalIds, code };
  };
  let observed: { kind: string; id: string } | undefined;
  if (resolved.settings.verification) {
    observed = await observeAccount(resolved, reference);
    claims.push(
      claim(resolved, {
        kind: "account-identity",
        issuer: "provider",
        target: observed!,
        requested,
        limitations: [
          "Observed through the Nango proxy with the approved verification operation.",
        ],
      }),
    );
  }
  if (intendedTarget) {
    if (!observed) return deny("nango.verify.account-evidence-insufficient");
    if (
      observed.kind !== intendedTarget.kind ||
      observed.id !== intendedTarget.id
    )
      return deny("nango.verify.account-mismatch");
  }
  if (
    input.mode === "reconnect" &&
    observed &&
    connection.target &&
    (connection.target.kind !== observed.kind ||
      connection.target.id !== observed.id) &&
    priv.accountSwitch !== "true"
  )
    return deny("nango.verify.account-switch-required");
  if (input.handoffRef) {
    try {
      await ctx.environment.handoffs.complete(
        input.handoffRef,
        ctx.generation,
        "completed",
      );
    } catch {
      return {
        state: "complete",
        claims: [],
        code: "nango.handoff.already-completed",
      };
    }
  }
  const scope = credentialScope(ctx, connection);
  const material = {
    connectionId: item.connection_id,
    providerConfigKey: item.provider_config_key,
    environment: resolved.environment,
    authority: resolved.authority,
  };
  const credentialRef =
    input.mode === "reconnect" && connection.credentialRef
      ? connection.credentialRef
      : await ctx.environment.credentials.store(scope, material);
  return {
    state: "complete",
    claims,
    credentialRef,
    externalIds,
    target: observed ?? {
      kind: NANGO_CONNECTION_TARGET,
      id: item.connection_id,
    },
    adapterState: {
      nango: {
        connectionId: item.connection_id,
        provider: item.provider,
        mode: input.mode,
        verifiedAt: new Date(ctx.environment.now()).toISOString(),
      },
    },
  };
}

const pending = (code: string): CompletionResult => ({
  state: "pending",
  claims: [],
  code,
});

async function pollCompletion(
  runtime: NangoRuntime,
  resolved: Resolved,
  connection: ConnectionRecord,
): Promise<CompletionResult> {
  const { ctx } = resolved;
  const summary = connection.handoff;
  if (!summary) return pending("nango.complete.no-handoff");
  if (summary.state === "completed")
    return { state: "complete", claims: [], code: "nango.complete.already" };
  if (summary.state === "denied")
    return { state: "denied", claims: [], code: "nango.complete.denied" };
  if (summary.state === "cancelled" || summary.state === "superseded")
    return {
      state: "denied",
      claims: [],
      code: `nango.complete.${summary.state}`,
    };
  if (summary.generation !== ctx.generation)
    return { state: "expired", claims: [], code: "nango.handoff.stale" };
  const now = ctx.environment.now();
  const record =
    ctx.actor.actorKind === "human"
      ? await ctx.environment.handoffs.present(ctx.actor, summary.handoffRef)
      : undefined;
  if (summary.state === "expired" || Date.parse(summary.expiresAt) <= now) {
    await ctx.environment.handoffs
      .complete(summary.handoffRef, ctx.generation, "expired")
      .catch(() => undefined);
    return { state: "expired", claims: [], code: "nango.session.expired" };
  }
  const mode =
    record?.private.mode === "reconnect" ||
    (record === undefined && connection.externalIds.connectionId !== undefined)
      ? "reconnect"
      : "connect";
  void runtime;
  if (mode === "connect") {
    const list = await resolved.client.listConnections({
      tags: {
        [TAG_KEYS.connection]: connection.connectionRef,
        [TAG_KEYS.generation]: String(ctx.generation),
        [TAG_KEYS.tenant]: tenantDigest(ctx.actor.tenantId),
      },
    });
    const matches = list.connections.filter(
      (item) =>
        item.provider_config_key === resolved.settings.integration.uniqueKey &&
        item.tags?.[TAG_KEYS.connection] === connection.connectionRef &&
        item.tags?.[TAG_KEYS.generation] === String(ctx.generation),
    );
    if (matches.length === 0) return pending("nango.verify.pending");
    if (matches.length > 1)
      return {
        state: "indeterminate",
        claims: [],
        code: "nango.verify.ambiguous",
      };
    return finalize(resolved, connection, {
      item: matches[0]!,
      mode: "connect",
      handoff: record,
      handoffRef: summary.handoffRef,
    });
  }
  const reference = brokerReference(resolved);
  const item = await currentListItem(resolved, reference.connectionId);
  if (!item)
    return { state: "expired", claims: [], code: "nango.connection.missing" };
  if (record?.private.priorAuthError === "true" && !hasAuthError(item))
    return finalize(resolved, connection, {
      item,
      mode: "reconnect",
      handoff: record,
      handoffRef: summary.handoffRef,
    });
  return pending("nango.reconnect.awaiting-event");
}

async function eventCompletion(
  resolved: Resolved,
  connection: ConnectionRecord,
  event: VerifiedEventEnvelope,
): Promise<CompletionResult> {
  const { ctx } = resolved;
  if (event.authority !== resolved.authority)
    return { state: "denied", claims: [], code: "nango.event.authority" };
  if (event.verification.method !== "vendor-signature")
    return { state: "denied", claims: [], code: "nango.event.unverified" };
  const payload = authWebhookSchema.safeParse(event.payload);
  if (!payload.success) return pending("nango.event.not-completion");
  const body = payload.data;
  if (body.providerConfigKey !== resolved.settings.integration.uniqueKey)
    return {
      state: "denied",
      claims: [],
      code: "nango.event.integration-mismatch",
    };
  if (
    body.environment &&
    body.environment.toLowerCase() !== resolved.environment
  )
    return {
      state: "denied",
      claims: [],
      code: "nango.event.environment-mismatch",
    };
  if (body.operation === "creation") {
    const nonce = body.tags?.[TAG_KEYS.handoff];
    if (!nonce) return pending("nango.event.no-correlation");
    const record = await ctx.environment.handoffs.resolveCorrelation(
      ctx.actor.tenantId,
      nonce,
    );
    if (
      !record ||
      record.tenantId !== ctx.actor.tenantId ||
      record.connectionRef !== connection.connectionRef ||
      record.bindingRef !== ctx.binding.bindingRef
    )
      return {
        state: "denied",
        claims: [],
        code: "nango.event.correlation-mismatch",
      };
    if (record.generation !== ctx.generation)
      return { state: "expired", claims: [], code: "nango.handoff.stale" };
    if (
      body.tags?.[TAG_KEYS.connection] !== connection.connectionRef ||
      body.tags?.[TAG_KEYS.tenant] !== tenantDigest(ctx.actor.tenantId)
    )
      return { state: "denied", claims: [], code: "nango.event.tag-mismatch" };
    if (record.state !== "issued" && record.state !== "waiting")
      return record.state === "completed"
        ? { state: "complete", claims: [], code: "nango.event.duplicate" }
        : {
            state: record.state === "expired" ? "expired" : "denied",
            claims: [],
            code: `nango.handoff.${record.state}`,
          };
    if (record.expiresAt <= ctx.environment.now()) {
      await ctx.environment.handoffs
        .complete(record.handoffRef, ctx.generation, "expired")
        .catch(() => undefined);
      return { state: "expired", claims: [], code: "nango.session.expired" };
    }
    if (!body.success) {
      await ctx.environment.handoffs
        .complete(record.handoffRef, ctx.generation, "denied")
        .catch(() => undefined);
      return { state: "denied", claims: [], code: "nango.connect.failed" };
    }
    const list = await resolved.client.listConnections({
      connectionId: body.connectionId,
      tags: { [TAG_KEYS.handoff]: nonce },
    });
    const matches = list.connections.filter(
      (item) =>
        item.connection_id === body.connectionId &&
        item.provider_config_key === resolved.settings.integration.uniqueKey &&
        item.tags?.[TAG_KEYS.handoff] === nonce,
    );
    if (matches.length !== 1) return pending("nango.verify.pending");
    return finalize(resolved, connection, {
      item: matches[0]!,
      mode: "connect",
      handoff: record,
      handoffRef: record.handoffRef,
    });
  }
  if (body.operation === "override") {
    const reference = brokerReference(resolved);
    if (body.connectionId !== reference.connectionId)
      return {
        state: "denied",
        claims: [],
        code: "nango.event.connection-mismatch",
      };
    const record = await ctx.environment.handoffs.resolveCorrelation(
      ctx.actor.tenantId,
      reconnectCorrelationKey(connection.connectionRef, ctx.generation),
    );
    if (!record || record.connectionRef !== connection.connectionRef)
      return {
        state: "denied",
        claims: [],
        code: "nango.event.correlation-mismatch",
      };
    if (record.state !== "issued" && record.state !== "waiting")
      return record.state === "completed"
        ? { state: "complete", claims: [], code: "nango.event.duplicate" }
        : {
            state: "denied",
            claims: [],
            code: `nango.handoff.${record.state}`,
          };
    // A reconnect handoff expires exactly like a connect one, and the deadline
    // has to be read here rather than trusted to the stored state: nothing
    // marks a record expired merely because time passed, so an overdue record
    // still reads "issued" when the correlation is resolved. Without this the
    // signed webhook would bind the connection on a handoff the human was no
    // longer meant to be able to finish, which is the one thing the deadline
    // exists to prevent.
    if (record.expiresAt <= ctx.environment.now()) {
      await ctx.environment.handoffs
        .complete(record.handoffRef, ctx.generation, "expired")
        .catch(() => undefined);
      return { state: "expired", claims: [], code: "nango.session.expired" };
    }
    if (!body.success) {
      await ctx.environment.handoffs
        .complete(record.handoffRef, ctx.generation, "denied")
        .catch(() => undefined);
      return { state: "denied", claims: [], code: "nango.reconnect.failed" };
    }
    const item = await currentListItem(resolved, reference.connectionId);
    if (!item)
      return { state: "expired", claims: [], code: "nango.connection.missing" };
    if (hasAuthError(item)) return pending("nango.reconnect.auth-error");
    return finalize(resolved, connection, {
      item,
      mode: "reconnect",
      handoff: record,
      handoffRef: record.handoffRef,
    });
  }
  return pending("nango.event.not-completion");
}

export async function completeNango(
  runtime: NangoRuntime,
  ctx: AdapterCallContext,
  input: CompletionInput,
): Promise<CompletionResult> {
  const resolved = await resolveNango(runtime, ctx);
  const connection = requireConnection(resolved);
  switch (input.kind) {
    case "redirect":
      return pending("nango.complete.redirect-not-evidence");
    case "input":
      return pending("nango.complete.input-unsupported");
    case "poll":
      return pollCompletion(runtime, resolved, connection);
    case "event":
      return eventCompletion(resolved, connection, input.event);
  }
}

/** Re-verifies an existing connection against the authoritative list and the optional verification operation. */
export async function verifyNango(
  runtime: NangoRuntime,
  ctx: AdapterCallContext,
): Promise<CompletionResult> {
  const resolved = await resolveNango(runtime, ctx);
  const connection = requireConnection(resolved);
  const reference = brokerReference(resolved);
  const item = await currentListItem(resolved, reference.connectionId);
  if (!item)
    return { state: "expired", claims: [], code: "nango.connection.missing" };
  if (hasAuthError(item))
    return {
      state: "human-required",
      claims: [],
      code: "nango.connection.auth-error",
    };
  const claims: VerificationClaim[] = [
    claim(resolved, {
      kind: "credential-accepted",
      issuer: "external-broker",
      target: { kind: NANGO_CONNECTION_TARGET, id: item.connection_id },
      limitations: existenceLimitations,
    }),
  ];
  let observed: { kind: string; id: string } | undefined;
  if (resolved.settings.verification) {
    observed = await observeAccount(resolved, reference);
    if (
      connection.target &&
      (connection.target.kind !== observed!.kind ||
        connection.target.id !== observed!.id)
    )
      return {
        state: "denied",
        claims,
        code: "nango.verify.account-switch-required",
      };
    claims.push(
      claim(resolved, {
        kind: "account-identity",
        issuer: "provider",
        target: observed!,
        limitations: [
          "Observed through the Nango proxy with the approved verification operation.",
        ],
      }),
    );
  }
  return {
    state: "complete",
    claims,
    externalIds: {
      connectionId: item.connection_id,
      providerConfigKey: item.provider_config_key,
      provider: item.provider,
      environment: resolved.environment,
      nangoInternalId: String(item.id),
    },
    target: observed ?? {
      kind: NANGO_CONNECTION_TARGET,
      id: item.connection_id,
    },
  };
}

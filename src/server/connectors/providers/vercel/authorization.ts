import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  canonicalConnectorJson,
  evidenceTargetSchema,
  measureJsonValue,
  nativeIdentifierSchema,
  verificationClaimSchema,
} from "../../../../core/index.js";
import type {
  AdapterCallContext,
  AuthorizationIntent,
  AuthorizationStart,
  CompletionInput,
  CompletionResult,
  DisconnectResult,
  DisconnectScope,
  HandoffProposal,
  InvokeRequest,
  InvokeResult,
} from "../../adapter.js";
import type {
  EvidenceTargetInput,
  OwnerKind,
  VerificationClaim,
} from "../../adapter-types.js";
import { destinationFor, type BoundOperation } from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import type { ConnectionRecord, HandoffRecord } from "../../ports.js";
import {
  callVercel,
  operationUrl,
  readBounded,
  VERCEL_REQUEST_TIMEOUT_MS,
} from "./client.js";
import {
  connectAuthorizeResponseSchema,
  connectTokenResponseSchema,
  requireTarget,
  vercelConfigurationNames,
  vercelDestinationIds,
  vercelProfile,
  vercelSettings,
  vercelTargetKinds,
  type ConnectSubject,
  type ConnectTokenResponse,
  type VercelProfile,
  type VercelSettings,
} from "./contracts.js";
import {
  configuredTeamId,
  providerTokenScope,
  resolveCredential,
  type WorkloadTokenSource,
} from "./credentials.js";
import {
  deleteUnsharedConnector,
  effectDigest,
  unlinkOwnProject,
  type ManagementOptions,
} from "./management.js";

/*
 * The authorization leg. A profile the host approved names the connector,
 * the subject kind, the installation semantics and the scopes; the
 * authenticated actor supplies the identity behind a `user` or `jwt-bearer`
 * subject; the workload credential authenticates every call. What comes back
 * from Vercel is either private handoff material (URL, verifier, request id)
 * or a provider token that goes straight into custody. Completion is never
 * inferred from a redirect: the redirect is correlated and then the token
 * endpoint decides.
 */

export type AuthorizationOptions = ManagementOptions & {
  workloadToken?: WorkloadTokenSource;
  verifierVersion: string;
};

const HANDOFF_MAX_MS = 24 * 3_600_000;
const DEFAULT_VALIDITY_BUFFER_MS = 30_000;

export const vercelConnectionStateSchema = z.object({
  vercel: z.object({
    profileId: z.string().min(1).max(96),
    subjectType: z.enum(["app", "user", "jwt-bearer"]),
    scopes: z.array(z.string().min(1).max(200)).max(64),
    connectorUid: z.string().min(1).max(512),
    connectorId: z.string().min(1).max(512),
    connectorType: z.string().min(1).max(64),
    installationId: z.string().max(512).optional(),
    tenantId: z.string().max(512).optional(),
    externalSubject: z.string().max(512).optional(),
    authorizationId: z.string().max(512).optional(),
    tokenGroupId: z.string().max(512).optional(),
    expiresAt: z.number().int().nonnegative(),
    target: evidenceTargetSchema,
    identityKnown: z.boolean(),
    intentTarget: evidenceTargetSchema.optional(),
  }),
});
export type VercelConnectionState = z.infer<
  typeof vercelConnectionStateSchema
>["vercel"];

export function connectionState(
  ctx: AdapterCallContext,
): VercelConnectionState | undefined {
  const parsed = vercelConnectionStateSchema.safeParse(ctx.connection?.state);
  return parsed.success ? parsed.data.vercel : undefined;
}

function requireConnection(ctx: AdapterCallContext): ConnectionRecord {
  if (!ctx.connection)
    throw new ConnectorError("invalid-request", {
      detail: "vercel.connection.required",
    });
  return ctx.connection;
}

const subset = (inner: readonly string[], outer: readonly string[]) =>
  inner.every((item) => outer.includes(item));

function ownerKindsFor(profile: VercelProfile): OwnerKind[] {
  switch (profile.subject.type) {
    case "app":
      return ["workload", "organization"];
    case "user":
      return ["user"];
    case "jwt-bearer":
      return profile.subject.sub === "tenant"
        ? ["organization", "workload"]
        : ["user"];
  }
}

/** The Connect subject for the authenticated actor; never taken from arguments. */
export function subjectFor(
  ctx: AdapterCallContext,
  profile: VercelProfile,
): ConnectSubject {
  const qualified = `${ctx.actor.tenantId}:${ctx.actor.subjectId}`;
  const subject = profile.subject;
  if (subject.type === "app") return { type: "app" };
  if (subject.type === "user")
    return {
      type: "user",
      id: subject.identity === "subject" ? ctx.actor.subjectId : qualified,
      ...(subject.issuer ? { issuer: subject.issuer } : {}),
    };
  return {
    type: "jwt-bearer",
    sub:
      subject.sub === "tenant"
        ? ctx.actor.tenantId
        : subject.sub === "subject"
          ? ctx.actor.subjectId
          : qualified,
    ...(subject.iss ? { iss: subject.iss } : {}),
    ...(subject.aud ? { aud: subject.aud } : {}),
    ...(subject.additionalClaims
      ? { additionalClaims: subject.additionalClaims }
      : {}),
  };
}

/** Requested scopes are the profile's, or an explicit subset of them; nothing outside. */
export function requestedScopes(
  profile: VercelProfile,
  requested: readonly string[],
): string[] {
  if (!requested.length) return [...profile.scopes];
  const approved = new Set(profile.scopes);
  for (const scope of requested)
    if (!approved.has(scope))
      throw new ConnectorError("denied", { detail: "vercel.scopes.not-approved" });
  return [...new Set(requested)];
}

const targetKinds = new Set([
  "provider-user",
  "provider-installation",
  "provider-tenant",
  "federated-subject",
  "vercel-connector",
]);

/** Every target the plan names must be permitted by the binding; checked before any network call. */
export function policyChecks(
  ctx: AdapterCallContext,
  settings: VercelSettings,
  profile: VercelProfile,
  intent: { ownerKind?: OwnerKind; target?: EvidenceTargetInput },
): void {
  const binding = ctx.binding;
  requireTarget(
    binding,
    vercelTargetKinds.project,
    settings.project.id,
    "vercel.project.not-permitted",
  );
  requireTarget(
    binding,
    vercelTargetKinds.environment,
    settings.project.environment,
    "vercel.environment.not-permitted",
  );
  requireTarget(
    binding,
    vercelTargetKinds.connector,
    profile.connector,
    "vercel.connector.not-permitted",
  );
  if (
    profile.installation.mode === "installation-aware" &&
    profile.installation.installationId !== undefined
  )
    requireTarget(
      binding,
      vercelTargetKinds.installation,
      profile.installation.installationId,
      "vercel.installation.not-permitted",
    );
  if (intent.ownerKind && !ownerKindsFor(profile).includes(intent.ownerKind))
    throw new ConnectorError("denied", {
      detail: "vercel.subject.owner-kind-mismatch",
    });
  if (intent.target) {
    if (!targetKinds.has(intent.target.kind))
      throw new ConnectorError("denied", { detail: "vercel.target.unsupported" });
    if (
      intent.target.kind === "provider-installation" &&
      profile.installation.mode === "installation-aware" &&
      profile.installation.installationId !== undefined &&
      profile.installation.installationId !== intent.target.id
    )
      throw new ConnectorError("denied", { detail: "vercel.target.not-permitted" });
  }
}

function tokenBody(
  profile: VercelProfile,
  subject: ConnectSubject,
  scopes: readonly string[],
): Record<string, unknown> {
  return {
    subject,
    ...(profile.installation.mode === "installation-aware" &&
    profile.installation.installationId !== undefined
      ? { installationId: profile.installation.installationId }
      : {}),
    scopes: [...scopes],
    ...(profile.resources ? { resources: [...profile.resources] } : {}),
    ...(profile.audience ? { audience: [...profile.audience] } : {}),
    ...(profile.authorizationDetails
      ? { authorizationDetails: profile.authorizationDetails }
      : {}),
    ...(profile.validityBufferMs !== undefined
      ? { validityBufferMs: profile.validityBufferMs }
      : {}),
  };
}

type Plan = { profile: VercelProfile; subject: ConnectSubject; scopes: string[] };

/**
 * POST /v1/connect/token/{connector} with the workload credential. The token
 * request is journaled (Vercel bills per token request) and its response is
 * validated against the documented schema before anything reads it.
 */
export async function acquireToken(
  ctx: AdapterCallContext,
  settings: VercelSettings,
  plan: Plan,
  options: AuthorizationOptions,
): Promise<ConnectTokenResponse> {
  const credential = await resolveCredential(ctx, "workload", settings, options);
  const teamId = await configuredTeamId(ctx);
  const body = tokenBody(plan.profile, plan.subject, plan.scopes);
  const begun = await ctx.environment.effects.begin({
    actor: ctx.actor,
    ...(ctx.connection ? { connectionRef: ctx.connection.connectionRef } : {}),
    bindingRef: ctx.binding.bindingRef,
    operation: "vercel.connect.token",
    digest: effectDigest({
      connector: plan.profile.connector,
      body,
      generation: ctx.generation,
      nonce: ctx.environment.random.uuid(),
    }),
  });
  try {
    const reply = await callVercel(ctx, {
      operation: "connect.token",
      credential,
      teamId,
      params: { connector: plan.profile.connector },
      body,
      schema: connectTokenResponseSchema,
    });
    const response = reply.body;
    if (!response)
      throw new ConnectorError("upstream-rejected", {
        detail: "vercel.response.invalid",
      });
    if (
      response.connector.uid !== plan.profile.connector &&
      response.connector.id !== plan.profile.connector
    )
      throw new ConnectorError("upstream-rejected", {
        detail: "vercel.connector.mismatch",
      });
    if (response.expiresAt <= ctx.environment.now())
      throw new ConnectorError("expired", {
        detail: "vercel.token.expired-on-issue",
      });
    const wanted =
      plan.profile.installation.mode === "installation-aware"
        ? plan.profile.installation.installationId
        : undefined;
    if (
      wanted !== undefined &&
      wanted !== "*" &&
      response.installationId !== undefined &&
      response.installationId !== wanted
    )
      throw new ConnectorError("upstream-rejected", {
        detail: "vercel.installation.mismatch",
      });
    await ctx.environment.effects.complete(begun.effectRef, {
      status: "applied",
      at: ctx.environment.now(),
    });
    return response;
  } catch (error) {
    const uncertain =
      !(error instanceof ConnectorError) ||
      ["upstream-unavailable", "cancelled"].includes(error.code);
    await ctx.environment.effects.complete(begun.effectRef, {
      status: uncertain ? "indeterminate" : "failed",
      at: ctx.environment.now(),
      ...(error instanceof ConnectorError ? { code: error.code } : {}),
    });
    throw error;
  }
}

export type Verification = {
  claims: VerificationClaim[];
  target: EvidenceTargetInput;
  identityKnown: boolean;
  limitations: string[];
};

const evidenceRef = (kind: string, seed: string) =>
  `vercel.${kind}.${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`;

/**
 * What a token response proves. Vercel reports the provider-side subject,
 * installation and tenant when it knows them; it never reports granted
 * scopes, so `reported` stays empty and says so. A `user` subject is a
 * provider user, a `jwt-bearer` subject a federated subject and an `app`
 * subject an installation or tenant; none of them is ever relabelled as
 * another.
 */
export function verificationFor(
  ctx: AdapterCallContext,
  profile: VercelProfile,
  response: {
    tokenId?: string;
    expiresAt: number;
    connector: { uid: string; id: string };
    installationId?: string | undefined;
    tenantId?: string | undefined;
    externalSubject?: string | undefined;
  },
  scopes: readonly string[],
  verifierVersion: string,
): Verification {
  const now = ctx.environment.now();
  const observedAt = new Date(now).toISOString();
  const validUntil =
    response.expiresAt > now
      ? new Date(response.expiresAt).toISOString()
      : undefined;
  const identifier = (value: string | undefined) =>
    value !== undefined && nativeIdentifierSchema.safeParse(value).success
      ? value
      : undefined;
  const kind = profile.subject.type;
  let target: EvidenceTargetInput | undefined;
  const limitations: string[] = [
    "provider-reported scopes are not returned by Vercel Connect",
  ];
  if (kind === "user" && identifier(response.externalSubject))
    target = { kind: "provider-user", id: response.externalSubject! };
  else if (kind === "jwt-bearer" && identifier(response.externalSubject))
    target = { kind: "federated-subject", id: response.externalSubject! };
  else if (kind === "app" && identifier(response.installationId))
    target = { kind: "provider-installation", id: response.installationId! };
  else if (kind === "app" && identifier(response.tenantId))
    target = { kind: "provider-tenant", id: response.tenantId! };
  const identityKnown = target !== undefined;
  if (!target) {
    target = { kind: "vercel-connector", id: response.connector.uid };
    limitations.push("account identity unknown");
  }
  const seed = `${response.tokenId ?? response.connector.id}:${response.expiresAt}`;
  const base = {
    issuer: "external-broker" as const,
    target,
    observedAt,
    ...(validUntil ? { validUntil } : {}),
    verifierVersion,
    bindingRevision: ctx.binding.revision,
    policyRevision: ctx.binding.policyRevision,
  };
  const claims: VerificationClaim[] = [
    verificationClaimSchema.parse({
      ...base,
      kind: "credential-accepted",
      evidenceRef: evidenceRef("credential-accepted", seed),
      permissions: {
        requested: [...scopes],
        reported: [],
        observed: [],
        semantics: "provider-scopes",
      },
      limitations,
    }),
  ];
  if (identityKnown)
    claims.push(
      verificationClaimSchema.parse({
        ...base,
        kind: "account-identity",
        evidenceRef: evidenceRef("account-identity", seed),
        limitations: [
          "identity reported by Vercel Connect, not observed at the provider",
        ],
      }),
    );
  return { claims, target, identityKnown, limitations };
}

type Judgement =
  | { state: "ok" }
  | { state: "human-required" | "denied"; code: string };

/**
 * An exact-account intent needs an identity that matches; a previously
 * verified account must not change without explicit account-switch intent;
 * and a broker success that exposes no identity is never relabelled as
 * exact-account verification.
 */
export function judgeIdentity(input: {
  intentTarget: EvidenceTargetInput | undefined;
  previous: VercelConnectionState | undefined;
  verification: Verification;
  accountSwitch: boolean;
}): Judgement {
  const { intentTarget, previous, verification, accountSwitch } = input;
  const same = (a: EvidenceTargetInput, b: EvidenceTargetInput) =>
    a.kind === b.kind && a.id === b.id;
  if (intentTarget) {
    if (!verification.identityKnown)
      return { state: "human-required", code: "vercel.identity.unverifiable" };
    if (!same(intentTarget, verification.target))
      return { state: "denied", code: "vercel.identity.mismatch" };
  }
  if (previous?.identityKnown && !accountSwitch) {
    if (!verification.identityKnown)
      return { state: "human-required", code: "vercel.identity.unverifiable" };
    if (!same(previous.target, verification.target))
      return { state: "denied", code: "vercel.identity.changed" };
  }
  return { state: "ok" };
}

function stateFor(
  profileId: string,
  profile: VercelProfile,
  response: ConnectTokenResponse,
  scopes: readonly string[],
  verification: Verification,
  intentTarget: EvidenceTargetInput | undefined,
): { vercel: VercelConnectionState } {
  return {
    vercel: {
      profileId,
      subjectType: profile.subject.type,
      scopes: [...scopes],
      connectorUid: response.connector.uid,
      connectorId: response.connector.id,
      connectorType: response.connector.type,
      ...(response.installationId !== undefined
        ? { installationId: response.installationId }
        : {}),
      ...(response.tenantId !== undefined ? { tenantId: response.tenantId } : {}),
      ...(response.externalSubject !== undefined
        ? { externalSubject: response.externalSubject }
        : {}),
      ...(response.authorizationId !== undefined
        ? { authorizationId: response.authorizationId }
        : {}),
      ...(response.tokenGroupId !== undefined
        ? { tokenGroupId: response.tokenGroupId }
        : {}),
      expiresAt: response.expiresAt,
      target: verification.target,
      identityKnown: verification.identityKnown,
      ...(intentTarget ? { intentTarget } : {}),
    },
  };
}

function externalIds(response: ConnectTokenResponse): Record<string, string> {
  const ids: Record<string, string> = {
    connectorId: response.connector.id,
    connectorUid: response.connector.uid,
  };
  if (response.installationId !== undefined)
    ids["installationId"] = response.installationId;
  if (response.tenantId !== undefined) ids["tenantId"] = response.tenantId;
  if (response.externalSubject !== undefined)
    ids["externalSubject"] = response.externalSubject;
  if (response.authorizationId !== undefined)
    ids["authorizationId"] = response.authorizationId;
  if (response.tokenGroupId !== undefined)
    ids["tokenGroupId"] = response.tokenGroupId;
  return ids;
}

async function storeProviderToken(
  ctx: AdapterCallContext,
  ownerKind: OwnerKind,
  response: ConnectTokenResponse,
  replaces: string | undefined,
): Promise<string> {
  return ctx.environment.credentials.store(
    providerTokenScope(ctx, ownerKind),
    { token: response.token, tokenId: response.tokenId },
    { expiresAt: response.expiresAt, ...(replaces ? { replaces } : {}) },
  );
}

/** Maps a token-endpoint failure onto a completion state; anything else propagates. */
function completionFromFailure(
  error: unknown,
): CompletionResult | undefined {
  if (!(error instanceof ConnectorError)) return undefined;
  if (error.detail === "vercel.user-authorization-required")
    return { state: "pending", claims: [], code: "vercel.authorization.pending" };
  if (error.detail === "vercel.installation-required")
    return {
      state: "human-required",
      claims: [],
      code: "vercel.installation-required",
    };
  if (error.detail === "vercel.no-valid-token")
    return { state: "denied", claims: [], code: "vercel.grant.unavailable" };
  // A deployment whose project link is missing, or whose environment the link
  // omits, is a recoverable state for this connection - not an adapter fault,
  // and never a reason to try a different credential.
  if (error.detail === "vercel.project.not-linked")
    return { state: "denied", claims: [], code: "vercel.project.not-linked" };
  if (error.detail === "vercel.environment.not-enabled")
    return {
      state: "denied",
      claims: [],
      code: "vercel.environment.not-enabled",
    };
  return undefined;
}

// ---------------------------------------------------------------------------
// authorize / reconnect
// ---------------------------------------------------------------------------

function trustedAuthorizationUrl(
  ctx: AdapterCallContext,
  value: string,
): URL {
  if (!URL.canParse(value))
    throw new ConnectorError("upstream-rejected", {
      detail: "vercel.authorization.url-untrusted",
    });
  const url = new URL(value);
  const api = ctx.binding.destinations.find(
    (item) => item.id === vercelDestinationIds.api,
  );
  const loopback =
    api?.network === "loopback-fixture" &&
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" && !loopback)
  )
    throw new ConnectorError("upstream-rejected", {
      detail: "vercel.authorization.url-untrusted",
    });
  return url;
}

export async function authorizeStart(
  ctx: AdapterCallContext,
  intent: AuthorizationIntent,
  options: AuthorizationOptions,
  mode: "authorize" | "reconnect",
): Promise<AuthorizationStart> {
  const settings = vercelSettings(ctx.binding);
  const { id: profileId, profile } = vercelProfile(
    settings,
    intent.profileId ?? ctx.binding.profileId,
  );
  policyChecks(ctx, settings, profile, {
    ownerKind: intent.ownerKind,
    ...(intent.target ? { target: intent.target } : {}),
  });
  const scopes = requestedScopes(profile, intent.requestedPermissions);
  const missing = new Set<string>();
  const present = await ctx.environment.configuration.present([
    vercelConfigurationNames.teamId,
    vercelConfigurationNames.workloadToken,
  ]);
  if (!present.has(vercelConfigurationNames.teamId))
    missing.add(vercelConfigurationNames.teamId);
  if (
    !present.has(vercelConfigurationNames.workloadToken) &&
    !(await options.workloadToken?.(ctx))
  )
    missing.add(vercelConfigurationNames.workloadToken);
  if (missing.size)
    return { kind: "configuration-required", missing: [...missing] };
  await configuredTeamId(ctx);

  // App subjects have no consent leg: verification acquires the token.
  if (profile.subject.type === "app") return { kind: "verify" };
  if (intent.interruption === "none")
    return { kind: "human-required", code: "vercel.consent-required" };

  const previous = mode === "reconnect" ? connectionState(ctx) : undefined;
  const label =
    mode === "authorize"
      ? "authorize"
      : intent.accountSwitch
        ? "account-switch"
        : previous && !subset(scopes, previous.scopes)
          ? "escalation"
          : "reconnect";
  if (mode === "reconnect" && ctx.connection)
    await ctx.environment.handoffs.cancelAll(
      ctx.connection.connectionRef,
      "vercel.connect.reconnect",
    );

  const credential = await resolveCredential(ctx, "workload", settings, options);
  const teamId = await configuredTeamId(ctx);
  const state = Buffer.from(ctx.environment.random.bytes(32)).toString(
    "base64url",
  );
  const returnUrl = new URL(settings.returnPath, ctx.environment.origin);
  if (returnUrl.origin !== ctx.environment.origin)
    throw new ConnectorError("configuration-required", {
      detail: "vercel.return.origin-mismatch",
    });
  returnUrl.searchParams.set("state", state);
  const body = {
    ...tokenBody(profile, subjectFor(ctx, profile), scopes),
    returnUrl: returnUrl.href,
    ...(profile.prompt ? { prompt: profile.prompt } : {}),
    ...(profile.expiresInMs !== undefined
      ? { expiresInMs: profile.expiresInMs }
      : {}),
    ...(profile.presentation === "second-device" ? { deviceCode: true } : {}),
  };
  delete (body as Record<string, unknown>)["validityBufferMs"];
  const begun = await ctx.environment.effects.begin({
    actor: ctx.actor,
    ...(ctx.connection ? { connectionRef: ctx.connection.connectionRef } : {}),
    bindingRef: ctx.binding.bindingRef,
    operation: "vercel.connect.authorize",
    digest: effectDigest({ connector: profile.connector, body, state }),
  });
  let response;
  try {
    const reply = await callVercel(ctx, {
      operation: "connect.authorize",
      credential,
      teamId,
      params: { connector: profile.connector },
      body,
      schema: connectAuthorizeResponseSchema,
    });
    response = reply.body;
    if (!response)
      throw new ConnectorError("upstream-rejected", {
        detail: "vercel.response.invalid",
      });
    await ctx.environment.effects.complete(begun.effectRef, {
      status: "applied",
      at: ctx.environment.now(),
    });
  } catch (error) {
    await ctx.environment.effects.complete(begun.effectRef, {
      status:
        error instanceof ConnectorError &&
        !["upstream-unavailable", "cancelled"].includes(error.code)
          ? "failed"
          : "indeterminate",
      at: ctx.environment.now(),
    });
    throw error;
  }
  if (
    response.connector.uid !== profile.connector &&
    response.connector.id !== profile.connector
  )
    throw new ConnectorError("upstream-rejected", {
      detail: "vercel.connector.mismatch",
    });
  const now = ctx.environment.now();
  if (response.expiresAt <= now + 1_000)
    throw new ConnectorError("expired", {
      detail: "vercel.authorization.expired-on-issue",
    });
  const url = trustedAuthorizationUrl(ctx, response.url);
  const deviceCode =
    profile.presentation === "second-device" ? response.deviceCode : undefined;
  const handoff: HandoffProposal = {
    kind: deviceCode ? "device-code" : "provider-browser",
    presentation:
      profile.presentation === "second-device"
        ? "second-device"
        : (profile.presentation ?? "popup"),
    expiresAt: Math.min(response.expiresAt, now + HANDOFF_MAX_MS),
    intent: `vercel.connect.${label}`,
    correlationKey: response.request,
    private: {
      url: url.href,
      verifier: response.verifier,
      request: response.request,
      state,
      expiresAt: String(response.expiresAt),
      profileId,
      scopes: scopes.join(" "),
      label,
      ...(intent.target ? { target: JSON.stringify(intent.target) } : {}),
      ...(deviceCode ? { userCode: deviceCode } : {}),
    },
  };
  return { kind: "handoff", handoff };
}

// ---------------------------------------------------------------------------
// complete
// ---------------------------------------------------------------------------

async function locateHandoff(
  ctx: AdapterCallContext,
  input: CompletionInput,
): Promise<HandoffRecord | undefined> {
  const ref = ctx.connection?.handoff?.handoffRef;
  if (ref) {
    const record = await ctx.environment.handoffs.present(ctx.actor, ref);
    if (record) return record;
  }
  if (input.kind === "redirect") {
    const request = input.url.searchParams.get("request");
    if (request && input.url.searchParams.getAll("request").length === 1)
      return ctx.environment.handoffs.resolveCorrelation(
        ctx.actor.tenantId,
        request,
      );
  }
  return undefined;
}

const safeEqual = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

function checkReturn(
  ctx: AdapterCallContext,
  settings: VercelSettings,
  url: URL,
  expectedState: string | undefined,
): "ok" | "untrusted" | "state-mismatch" | "denied" {
  if (url.origin !== ctx.environment.origin || url.pathname !== settings.returnPath)
    return "untrusted";
  const states = url.searchParams.getAll("state");
  if (
    states.length !== 1 ||
    !expectedState ||
    !states[0] ||
    !safeEqual(states[0], expectedState)
  )
    return "state-mismatch";
  return url.searchParams.get("error") ? "denied" : "ok";
}

async function settle(
  ctx: AdapterCallContext,
  handoff: HandoffRecord,
  state: "completed" | "denied" | "expired",
): Promise<boolean> {
  try {
    await ctx.environment.handoffs.complete(
      handoff.handoffRef,
      ctx.generation,
      state,
    );
    return true;
  } catch {
    return false;
  }
}

function parseTarget(value: string | undefined): EvidenceTargetInput | undefined {
  if (!value) return undefined;
  try {
    const parsed = evidenceTargetSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export async function completeAuthorization(
  ctx: AdapterCallContext,
  input: CompletionInput,
  options: AuthorizationOptions,
): Promise<CompletionResult> {
  const connection = requireConnection(ctx);
  const settings = vercelSettings(ctx.binding);
  if (input.kind === "input")
    return { state: "human-required", claims: [], code: "vercel.input.unsupported" };
  const handoff = await locateHandoff(ctx, input);
  if (!handoff)
    return { state: "pending", claims: [], code: "vercel.handoff.unresolved" };
  if (
    handoff.connectionRef !== connection.connectionRef ||
    handoff.tenantId !== ctx.actor.tenantId ||
    handoff.subjectId !== ctx.actor.subjectId ||
    handoff.bindingRef !== ctx.binding.bindingRef
  )
    return { state: "denied", claims: [], code: "vercel.handoff.foreign" };
  if (handoff.generation !== ctx.generation)
    return { state: "denied", claims: [], code: "vercel.handoff.stale-generation" };
  const now = ctx.environment.now();
  const issuedExpiry = Number(handoff.private["expiresAt"]);
  // Expiry is decided before anything else a stale record could look like:
  // a store that marks an overdue handoff expired must not read as a denial.
  if (
    handoff.state === "expired" ||
    handoff.expiresAt <= now ||
    (Number.isFinite(issuedExpiry) && issuedExpiry <= now)
  ) {
    await settle(ctx, handoff, "expired");
    return { state: "expired", claims: [], code: "vercel.authorization.expired" };
  }
  if (handoff.state !== "issued" && handoff.state !== "waiting")
    return {
      state: "denied",
      claims: [],
      code:
        handoff.state === "completed"
          ? "vercel.handoff.consumed"
          : `vercel.handoff.${handoff.state}`,
    };
  const { id: profileId, profile } = vercelProfile(
    settings,
    handoff.private["profileId"],
  );
  const intentTarget = parseTarget(handoff.private["target"]);
  policyChecks(ctx, settings, profile, {
    ownerKind: connection.ownerKind,
    ...(intentTarget ? { target: intentTarget } : {}),
  });
  if (input.kind === "redirect") {
    const verdict = checkReturn(ctx, settings, input.url, handoff.private["state"]);
    if (verdict === "denied") {
      await settle(ctx, handoff, "denied");
      return { state: "denied", claims: [], code: "vercel.authorization.denied" };
    }
    if (verdict !== "ok")
      return { state: "denied", claims: [], code: `vercel.return.${verdict}` };
  }
  if (input.kind === "event" && !input.event.authority.startsWith("vercel-connect"))
    return { state: "denied", claims: [], code: "vercel.event.authority-mismatch" };

  const scopes = (handoff.private["scopes"] ?? "").split(" ").filter(Boolean);
  let response: ConnectTokenResponse;
  try {
    response = await acquireToken(
      ctx,
      settings,
      { profile, subject: subjectFor(ctx, profile), scopes },
      options,
    );
  } catch (error) {
    const mapped = completionFromFailure(error);
    if (!mapped) throw error;
    if (mapped.state === "denied") await settle(ctx, handoff, "denied");
    return mapped;
  }
  const verification = verificationFor(
    ctx,
    profile,
    response,
    scopes,
    options.verifierVersion,
  );
  const judgement = judgeIdentity({
    intentTarget,
    previous: connectionState(ctx),
    verification,
    accountSwitch: handoff.private["label"] === "account-switch",
  });
  if (judgement.state !== "ok") {
    if (judgement.state === "denied") await settle(ctx, handoff, "denied");
    return { state: judgement.state, claims: verification.claims, code: judgement.code };
  }
  if (!(await settle(ctx, handoff, "completed")))
    return { state: "denied", claims: [], code: "vercel.handoff.consumed" };
  const credentialRef = await storeProviderToken(
    ctx,
    connection.ownerKind,
    response,
    connection.credentialRef,
  );
  return {
    state: "complete",
    claims: verification.claims,
    credentialRef,
    externalIds: externalIds(response),
    target: verification.target,
    adapterState: stateFor(
      profileId,
      profile,
      response,
      scopes,
      verification,
      intentTarget,
    ),
  };
}

// ---------------------------------------------------------------------------
// verify (and refresh)
// ---------------------------------------------------------------------------

function verificationFromState(
  ctx: AdapterCallContext,
  profile: VercelProfile,
  previous: VercelConnectionState,
  verifierVersion: string,
): Verification {
  return verificationFor(
    ctx,
    profile,
    {
      expiresAt: previous.expiresAt,
      connector: { uid: previous.connectorUid, id: previous.connectorId },
      ...(previous.installationId !== undefined
        ? { installationId: previous.installationId }
        : {}),
      ...(previous.tenantId !== undefined ? { tenantId: previous.tenantId } : {}),
      ...(previous.externalSubject !== undefined
        ? { externalSubject: previous.externalSubject }
        : {}),
    },
    previous.scopes,
    verifierVersion,
  );
}

/** Policy that must hold every time a connection is used, not only when it was made. */
function revalidate(
  ctx: AdapterCallContext,
  settings: VercelSettings,
  previous: VercelConnectionState,
  ownerKind: OwnerKind,
): { profile: VercelProfile; profileId: string } | CompletionResult {
  const { id: profileId, profile } = vercelProfile(settings, previous.profileId);
  policyChecks(ctx, settings, profile, { ownerKind });
  if (
    previous.connectorUid !== profile.connector &&
    previous.connectorId !== profile.connector
  )
    return { state: "human-required", claims: [], code: "vercel.connector.changed" };
  if (!subset(profile.scopes, previous.scopes))
    return { state: "human-required", claims: [], code: "vercel.scopes.escalation" };
  return { profile, profileId };
}

class JudgementError extends Error {
  constructor(readonly judgement: Exclude<Judgement, { state: "ok" }>) {
    super(judgement.code);
  }
}

export async function verifyConnection(
  ctx: AdapterCallContext,
  options: AuthorizationOptions,
): Promise<CompletionResult> {
  const connection = requireConnection(ctx);
  const settings = vercelSettings(ctx.binding);
  const previous = connectionState(ctx);
  const now = ctx.environment.now();
  if (!previous) {
    const { id: profileId, profile } = vercelProfile(settings, ctx.binding.profileId);
    policyChecks(ctx, settings, profile, { ownerKind: connection.ownerKind });
    const scopes = [...profile.scopes];
    let response: ConnectTokenResponse;
    try {
      response = await acquireToken(
        ctx,
        settings,
        { profile, subject: subjectFor(ctx, profile), scopes },
        options,
      );
    } catch (error) {
      const mapped = completionFromFailure(error);
      if (!mapped) throw error;
      return mapped.state === "pending"
        ? { state: "human-required", claims: [], code: "vercel.consent-required" }
        : mapped;
    }
    const verification = verificationFor(ctx, profile, response, scopes, options.verifierVersion);
    const credentialRef = await storeProviderToken(
      ctx,
      connection.ownerKind,
      response,
      connection.credentialRef,
    );
    return {
      state: "complete",
      claims: verification.claims,
      credentialRef,
      externalIds: externalIds(response),
      target: verification.target,
      adapterState: stateFor(profileId, profile, response, scopes, verification, undefined),
    };
  }
  const checked = revalidate(ctx, settings, previous, connection.ownerKind);
  if ("state" in checked) return checked;
  const { profile, profileId } = checked;
  const buffer = profile.validityBufferMs ?? DEFAULT_VALIDITY_BUFFER_MS;
  const scope = providerTokenScope(ctx, connection.ownerKind);
  const ref = connection.credentialRef;
  const described = ref
    ? await ctx.environment.credentials.describe(scope, ref)
    : undefined;
  if (ref && described && (described.expiresAt ?? Infinity) > now + buffer) {
    const verification = verificationFromState(ctx, profile, previous, options.verifierVersion);
    return {
      state: "complete",
      claims: verification.claims,
      credentialRef: ref,
      target: verification.target,
    };
  }
  let response: ConnectTokenResponse | undefined;
  let verification: Verification | undefined;
  const work = async () => {
    const acquired = await acquireToken(
      ctx,
      settings,
      { profile, subject: subjectFor(ctx, profile), scopes: previous.scopes },
      options,
    );
    const verified = verificationFor(ctx, profile, acquired, previous.scopes, options.verifierVersion);
    const judgement = judgeIdentity({
      intentTarget: previous.intentTarget,
      previous,
      verification: verified,
      accountSwitch: false,
    });
    if (judgement.state !== "ok") throw new JudgementError(judgement);
    response = acquired;
    verification = verified;
    return {
      material: { token: acquired.token, tokenId: acquired.tokenId },
      expiresAt: acquired.expiresAt,
    };
  };
  try {
    const stored =
      ref && described
        ? await ctx.environment.credentials.refresh(scope, ref, work)
        : undefined;
    if (!stored) {
      await work();
      const credentialRef = await storeProviderToken(
        ctx,
        connection.ownerKind,
        response!,
        ref,
      );
      return {
        state: "complete",
        claims: verification!.claims,
        credentialRef,
        externalIds: externalIds(response!),
        target: verification!.target,
        adapterState: stateFor(profileId, profile, response!, previous.scopes, verification!, previous.intentTarget),
      };
    }
    if (!response || !verification) {
      // Another worker refreshed first; the committed credential is current
      // and this connection's recorded verification still describes it.
      const derived = verificationFromState(ctx, profile, previous, options.verifierVersion);
      return { state: "complete", claims: derived.claims, credentialRef: stored.ref, target: derived.target };
    }
    return {
      state: "complete",
      claims: verification.claims,
      credentialRef: stored.ref,
      externalIds: externalIds(response),
      target: verification.target,
      adapterState: stateFor(profileId, profile, response, previous.scopes, verification, previous.intentTarget),
    };
  } catch (error) {
    if (error instanceof JudgementError)
      return { state: error.judgement.state, claims: verification?.claims ?? [], code: error.judgement.code };
    const mapped = completionFromFailure(error);
    if (mapped) return mapped.state === "pending" ? { state: "human-required", claims: [], code: "vercel.consent-required" } : mapped;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// disconnect / revoke
// ---------------------------------------------------------------------------

function connectorFor(ctx: AdapterCallContext, settings: VercelSettings): string {
  return (
    connectionState(ctx)?.connectorUid ??
    vercelProfile(settings, ctx.binding.profileId).profile.connector
  );
}

async function revokeLocal(ctx: AdapterCallContext, connection: ConnectionRecord, reason: string) {
  await ctx.environment.handoffs.cancelAll(connection.connectionRef, reason);
  if (connection.credentialRef)
    await ctx.environment.credentials.revoke(
      providerTokenScope(ctx, connection.ownerKind),
      connection.credentialRef,
    );
}

export async function disconnectConnection(
  ctx: AdapterCallContext,
  scope: DisconnectScope,
  options: AuthorizationOptions,
): Promise<DisconnectResult> {
  const connection = requireConnection(ctx);
  const settings = vercelSettings(ctx.binding);
  const connector = connectorFor(ctx, settings);
  if (scope === "local") {
    await revokeLocal(ctx, connection, "vercel.disconnect.local");
    return { local: "applied", broker: "not-attempted", upstream: "not-attempted" };
  }
  const shared = (projects: string[]) =>
    projects.length
      ? { sharedWith: projects.map((projectId) => `vercel-project:${projectId}`) }
      : {};
  if (scope === "broker") {
    const outcome = await unlinkOwnProject(ctx, connector, options);
    await revokeLocal(ctx, connection, "vercel.disconnect.broker");
    return {
      local: "applied",
      broker: outcome.applied ? "applied" : "not-attempted",
      upstream: "not-attempted",
      ...shared(outcome.sharedWith),
    };
  }
  const outcome = await deleteUnsharedConnector(ctx, connector, options);
  if (!outcome.applied)
    return {
      local: "not-attempted",
      broker: "not-attempted",
      upstream: "not-attempted",
      ...shared(outcome.sharedWith),
    };
  await revokeLocal(ctx, connection, "vercel.disconnect.upstream");
  return { local: "applied", broker: "applied", upstream: "applied" };
}

export async function revokeGrant(
  ctx: AdapterCallContext,
  options: AuthorizationOptions,
): Promise<DisconnectResult> {
  const connection = requireConnection(ctx);
  const settings = vercelSettings(ctx.binding);
  if (settings.revocation !== "sdk-observed-endpoint") {
    await revokeLocal(ctx, connection, "vercel.revoke.local");
    return { local: "applied", broker: "unsupported", upstream: "unsupported" };
  }
  const previous = connectionState(ctx);
  const { profile } = vercelProfile(settings, previous?.profileId ?? ctx.binding.profileId);
  policyChecks(ctx, settings, profile, { ownerKind: connection.ownerKind });
  const credential = await resolveCredential(ctx, "workload", settings, options);
  const teamId = await configuredTeamId(ctx);
  const body = {
    subject: subjectFor(ctx, profile),
    ...(profile.installation.mode === "installation-aware" &&
    profile.installation.installationId !== undefined
      ? { installationId: profile.installation.installationId }
      : {}),
  };
  const begun = await ctx.environment.effects.begin({
    actor: ctx.actor,
    connectionRef: connection.connectionRef,
    bindingRef: ctx.binding.bindingRef,
    operation: "vercel.connect.tokens.revoke",
    digest: effectDigest({ connector: profile.connector, body, generation: ctx.generation }),
  });
  if (begun.prior?.status === "applied") {
    await revokeLocal(ctx, connection, "vercel.revoke");
    return { local: "applied", broker: "applied", upstream: "indeterminate" };
  }
  try {
    await callVercel(ctx, {
      operation: "connect.tokens.revoke",
      credential,
      teamId,
      params: { connector: profile.connector },
      body,
      schema: z.unknown(),
    });
    await ctx.environment.effects.complete(begun.effectRef, { status: "applied", at: ctx.environment.now() });
  } catch (error) {
    await ctx.environment.effects.complete(begun.effectRef, { status: "indeterminate", at: ctx.environment.now() });
    if (error instanceof ConnectorError && error.code === "not-found") {
      await revokeLocal(ctx, connection, "vercel.revoke");
      return { local: "applied", broker: "applied", upstream: "indeterminate" };
    }
    return { local: "not-attempted", broker: "indeterminate", upstream: "indeterminate" };
  }
  await revokeLocal(ctx, connection, "vercel.revoke");
  // Vercel calls the provider's revocation endpoint only when the provider
  // declares one; the response does not say which happened.
  return { local: "applied", broker: "applied", upstream: "indeterminate" };
}

// ---------------------------------------------------------------------------
// provider calls with the custody token
// ---------------------------------------------------------------------------

const providerCallInputSchema = z.strictObject({
  path: z
    .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/), z.string().min(1).max(512))
    .refine((value) => Object.keys(value).length <= 16)
    .optional(),
  query: z
    .record(z.string().min(1).max(64), z.string().max(1024))
    .refine((value) => Object.keys(value).length <= 32)
    .optional(),
  body: z.unknown().refine((value) => value === undefined || measureJsonValue(value).ok).optional(),
});

const OUTPUT_TEXT_LIMIT = 65_536;

export async function invokeProviderOperation(
  ctx: AdapterCallContext,
  request: InvokeRequest,
  bound: BoundOperation,
  options: AuthorizationOptions,
): Promise<InvokeResult> {
  const base = { outputClassification: bound.outputClassification, effect: bound.effect };
  const connection = requireConnection(ctx);
  const settings = vercelSettings(ctx.binding);
  const previous = connectionState(ctx);
  if (!previous || !connection.credentialRef)
    return { state: "human-required", code: "vercel.authorization.required", ...base };
  const checked = revalidate(ctx, settings, previous, connection.ownerKind);
  if ("state" in checked)
    return { state: "human-required", code: checked.code ?? "vercel.policy.changed", ...base };
  const { profile } = checked;
  if (bound.transport.kind !== "http")
    throw new ConnectorError("unsupported", { detail: "vercel.operation.transport-unsupported" });
  const destination = destinationFor(ctx.binding, bound);
  if (
    destination.id === vercelDestinationIds.api ||
    destination.id === vercelDestinationIds.oidc
  )
    throw new ConnectorError("invalid-request", { detail: "vercel.operation.destination-reserved" });
  const parsed = providerCallInputSchema.safeParse(request.input ?? {});
  if (!parsed.success)
    throw new ConnectorError("invalid-request", { detail: "vercel.input.invalid" });
  const input = parsed.data;
  for (const name of bound.targetParameters) {
    const value = input.path?.[name] ?? input.query?.[name];
    if (value === undefined)
      throw new ConnectorError("denied", { detail: "vercel.target.missing" });
    if (!ctx.binding.permittedTargets.some((target) => target.kind === name && target.id === value))
      throw new ConnectorError("denied", { detail: "vercel.target.not-permitted" });
  }
  const url = operationUrl(destination, bound.transport.pathTemplate, (name) => {
    const value = input.path?.[name];
    if (value === undefined)
      throw new ConnectorError("invalid-request", {
        detail: "vercel.path.parameter-missing",
      });
    return value;
  });
  for (const [name, value] of Object.entries(input.query ?? {}))
    url.searchParams.set(name, value);
  const body = input.body === undefined ? undefined : JSON.stringify(input.body);
  const scope = providerTokenScope(ctx, connection.ownerKind);
  const ref = connection.credentialRef;
  const buffer = profile.validityBufferMs ?? DEFAULT_VALIDITY_BUFFER_MS;
  const reacquire = async () => {
    const acquired = await acquireToken(
      ctx,
      settings,
      { profile, subject: subjectFor(ctx, profile), scopes: previous.scopes },
      options,
    );
    const verified = verificationFor(ctx, profile, acquired, previous.scopes, options.verifierVersion);
    const judgement = judgeIdentity({ intentTarget: previous.intentTarget, previous, verification: verified, accountSwitch: false });
    if (judgement.state !== "ok") throw new JudgementError(judgement);
    return { material: { token: acquired.token, tokenId: acquired.tokenId }, expiresAt: acquired.expiresAt };
  };
  const ensureFresh = async () => {
    const described = await ctx.environment.credentials.describe(scope, ref);
    if (!described) throw new ConnectorError("human-required", { detail: "vercel.authorization.required" });
    if ((described.expiresAt ?? Infinity) <= ctx.environment.now() + buffer)
      await ctx.environment.credentials.refresh(scope, ref, reacquire);
  };
  const send = () =>
    ctx.environment.credentials.use(scope, ref, async (material) => {
      const headers = new Headers({ accept: "application/json", authorization: `Bearer ${material["token"] ?? ""}` });
      if (body !== undefined) headers.set("content-type", "application/json");
      return ctx.environment.fetch(url, {
        method: bound.transport.kind === "http" ? bound.transport.method : "GET",
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "error",
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(VERCEL_REQUEST_TIMEOUT_MS)]),
      });
    });

  let effectRef: string | undefined;
  if (bound.effect !== "read") {
    const begun = await ctx.environment.effects.begin({
      actor: ctx.actor,
      connectionRef: connection.connectionRef,
      bindingRef: ctx.binding.bindingRef,
      operation: request.operationRef,
      digest: effectDigest({ operationRef: request.operationRef, url: url.href, body, commandId: request.commandId }),
      commandId: request.commandId,
      ...(request.idempotencyKey && bound.replay === "upstream-idempotency-key"
        ? { idempotency: { key: request.idempotencyKey, scope: destination.origin } }
        : {}),
    });
    effectRef = begun.effectRef;
    if (begun.prior) {
      if (begun.prior.status === "applied" || begun.prior.status === "reconciled")
        return { state: "complete", code: "vercel.effect.already-applied", effectRef, ...base };
      return { state: "indeterminate", code: "vercel.effect.indeterminate", effectRef, ...base };
    }
  }
  const outcome = async (status: "applied" | "failed" | "indeterminate", code?: string) => {
    if (effectRef)
      await ctx.environment.effects.complete(effectRef, { status, at: ctx.environment.now(), ...(code ? { code } : {}) });
  };
  try {
    await ensureFresh();
    let response = await send();
    if (response.status === 401 && bound.replay === "read-only") {
      await response.body?.cancel();
      await ctx.environment.credentials.refresh(scope, ref, reacquire);
      response = await send();
    }
    const text = await readBounded(response);
    if (!response.ok) {
      await response.body?.cancel();
      await outcome("failed", `status-${response.status}`);
      return {
        state: response.status === 401 || response.status === 403 ? "denied" : "failed",
        code: `vercel.provider.status-${response.status}`,
        ...(effectRef ? { effectRef } : {}),
        ...base,
      };
    }
    let output: unknown = undefined;
    if (text) {
      const contentType = response.headers.get("content-type") ?? "";
      if (/json/i.test(contentType)) {
        try {
          const json: unknown = JSON.parse(text);
          if (!measureJsonValue(json).ok)
            throw new ConnectorError("upstream-rejected", { detail: "vercel.provider.output-too-large" });
          output = json;
        } catch (error) {
          if (error instanceof ConnectorError) throw error;
          output = undefined;
        }
      } else output = text.slice(0, OUTPUT_TEXT_LIMIT);
    }
    await outcome("applied");
    return { state: "complete", ...(output !== undefined ? { output } : {}), ...(effectRef ? { effectRef } : {}), ...base };
  } catch (error) {
    if (error instanceof JudgementError) {
      await outcome("failed", error.judgement.code);
      return { state: error.judgement.state, code: error.judgement.code, ...(effectRef ? { effectRef } : {}), ...base };
    }
    const mapped = completionFromFailure(error);
    if (mapped) {
      await outcome("failed", mapped.code);
      return { state: "human-required", code: mapped.code ?? "vercel.authorization.required", ...(effectRef ? { effectRef } : {}), ...base };
    }
    await outcome(
      !(error instanceof ConnectorError) || ["upstream-unavailable", "cancelled"].includes(error.code)
        ? "indeterminate"
        : "failed",
    );
    if (
      effectRef &&
      (!(error instanceof ConnectorError) || ["upstream-unavailable", "cancelled"].includes(error.code))
    )
      return { state: "indeterminate", code: "vercel.effect.indeterminate", effectRef, ...base };
    throw error;
  }
}

/** Canonical JSON of what a token request would carry; exposed for tests and audits. */
export function tokenRequestDigest(ctx: AdapterCallContext, profile: VercelProfile, scopes: readonly string[]): string {
  return createHash("sha256")
    .update(canonicalConnectorJson(tokenBody(profile, subjectFor(ctx, profile), scopes)))
    .digest("hex");
}

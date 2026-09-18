import { verificationClaimSchema } from "../../../core/connectors/index.js";
import type { VerificationClaim } from "../adapter-types.js";
import type { AdapterCallContext } from "../adapter.js";
import { ConnectorError } from "../errors.js";

/*
 * Permissions are three different facts kept apart: what Ceremony asked for,
 * what the provider said it granted, and what has actually been observed to
 * work. A provider that returns no scope tells us nothing, so the record says
 * "unknown" rather than copying the request into the grant; a broker that
 * ignores a downscoping request and grants more is recorded as such, because
 * from then on Ceremony's operation policy, not the token, is the effective
 * limit. Any increase over a reviewed request goes back to review before
 * credentials or effects are used (AC-AUTH-10, AC-AUTH-11).
 */

export const OAUTH_VERIFIER_VERSION = "connectors-auth-1.0.0";

export type PermissionRecord = NonNullable<VerificationClaim["permissions"]>;
export type PermissionSource = "token-response" | "introspection" | "none";

function bounded(items: readonly string[]): string[] {
  return [
    ...new Set(
      items.filter(
        (item) =>
          typeof item === "string" && item.length > 0 && item.length <= 200,
      ),
    ),
  ].slice(0, 64);
}

/** Requested versus provider-reported permissions; observed starts empty and is filled by verifiers. */
export function permissionRecord(input: {
  requested: readonly string[];
  reported?: readonly string[] | undefined;
  source: PermissionSource;
}): PermissionRecord {
  const requested = bounded(input.requested);
  const reported = input.source === "none" ? [] : bounded(input.reported ?? []);
  return {
    requested,
    reported,
    observed: [],
    semantics: reported.length ? "provider-scopes" : "unknown",
  };
}

export type ScopeEnforcement = {
  /**
   * broker-enforced: the provider granted no more than requested, so the token
   * itself bounds access. ceremony-enforced: the provider granted more than
   * requested, so only Ceremony's operation policy keeps use within the
   * request. unknown: the provider reported nothing.
   */
  enforcement: "broker-enforced" | "ceremony-enforced" | "unknown";
  excess: string[];
  missing: string[];
};

export function scopeEnforcement(
  permissions: Pick<PermissionRecord, "requested" | "reported" | "semantics">,
): ScopeEnforcement {
  if (permissions.semantics === "unknown" || !permissions.reported.length)
    return { enforcement: "unknown", excess: [], missing: [] };
  const requested = new Set(permissions.requested);
  const reported = new Set(permissions.reported);
  const excess = [...reported].filter((scope) => !requested.has(scope));
  const missing = [...requested].filter((scope) => !reported.has(scope));
  return {
    enforcement: excess.length ? "ceremony-enforced" : "broker-enforced",
    excess,
    missing,
  };
}

export type EscalationReview = {
  decision: "no-baseline" | "unchanged" | "narrowed" | "review-required";
  added: string[];
  removed: string[];
  /** The permissions the previous review covered. */
  baseline: string[];
};

/**
 * Compares a new request against the previously reviewed one. The baseline is
 * what was *requested* at review time, not what the provider happened to
 * grant: a grant wider than the review does not silently widen the review.
 */
export function reviewPermissionEscalation(
  previous: Pick<VerificationClaim, "permissions"> | undefined,
  requested: readonly string[],
): EscalationReview {
  const wanted = bounded(requested);
  if (!previous?.permissions)
    return {
      decision: "no-baseline",
      added: wanted,
      removed: [],
      baseline: [],
    };
  const baseline = bounded(previous.permissions.requested);
  const base = new Set(baseline);
  const want = new Set(wanted);
  const added = wanted.filter((scope) => !base.has(scope));
  const removed = baseline.filter((scope) => !want.has(scope));
  return {
    decision: added.length
      ? "review-required"
      : removed.length
        ? "narrowed"
        : "unchanged",
    added,
    removed,
    baseline,
  };
}

/** RFC 8707: the resource indicator goes on the authorization request and on every token request. */
export function resourceParameters(
  resource: string | undefined,
): Record<string, string> {
  return resource === undefined ? {} : { resource };
}

/** RFC 9396 authorization details, serialized once and only when each entry names a type. */
export function authorizationDetailsParameter(
  details: readonly Record<string, unknown>[] | undefined,
): Record<string, string> {
  if (!details || details.length === 0) return {};
  if (details.length > 16)
    throw new ConnectorError("invalid-request", {
      detail: "oauth.authorization-details.size",
    });
  for (const entry of details)
    if (typeof entry["type"] !== "string" || !entry["type"])
      throw new ConnectorError("invalid-request", {
        detail: "oauth.authorization-details.type",
      });
  return { authorization_details: JSON.stringify(details) };
}

/** Granted authorization details, reported as `authorization_details:<type>` entries. */
export function reportedAuthorizationDetails(details: unknown): string[] {
  if (!Array.isArray(details)) return [];
  const types: string[] = [];
  for (const entry of details.slice(0, 64))
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as { type?: unknown }).type === "string"
    )
      types.push(`authorization_details:${(entry as { type: string }).type}`);
  return types;
}

const iso = (at: number) => new Date(at).toISOString();

/**
 * The claim a successful token issuance supports: the issuer accepted this
 * client's grant. It deliberately does not say which account granted it; that
 * is a separate claim from a separate observation.
 */
export function credentialAcceptedClaim(
  ctx: AdapterCallContext,
  input: {
    issuer: string;
    permissions: PermissionRecord;
    validUntil?: number | undefined;
    target?: { kind: string; id: string } | undefined;
    limitations?: readonly string[] | undefined;
  },
): VerificationClaim {
  const observedAt = ctx.environment.now();
  return verificationClaimSchema.parse({
    kind: "credential-accepted",
    evidenceRef: `evidence:oauth:${ctx.environment.random.uuid()}`,
    issuer: "provider",
    target: input.target ?? { kind: "oauth-issuer", id: input.issuer },
    observedAt: iso(observedAt),
    ...(input.validUntil !== undefined && input.validUntil > observedAt
      ? { validUntil: iso(input.validUntil) }
      : {}),
    verifierVersion: OAUTH_VERIFIER_VERSION,
    bindingRevision: ctx.binding.revision,
    policyRevision: ctx.binding.policyRevision,
    permissions: input.permissions,
    limitations: [
      ...(input.limitations ?? [
        "A token the issuer accepted proves a grant to this client, not which account granted it.",
      ]),
    ],
  });
}

/** An issuer-asserted subject (ID token `sub`, exchanged-token `sub`); an identifier, not a chosen account. */
export function accountIdentityClaim(
  ctx: AdapterCallContext,
  input: {
    issuer: string;
    subject: string;
    subjectKind?: string | undefined;
    validUntil?: number | undefined;
    limitations?: readonly string[] | undefined;
  },
): VerificationClaim {
  const observedAt = ctx.environment.now();
  return verificationClaimSchema.parse({
    kind: "account-identity",
    evidenceRef: `evidence:oauth:${ctx.environment.random.uuid()}`,
    issuer: "provider",
    target: { kind: input.subjectKind ?? "oauth-subject", id: input.subject },
    observedAt: iso(observedAt),
    ...(input.validUntil !== undefined && input.validUntil > observedAt
      ? { validUntil: iso(input.validUntil) }
      : {}),
    verifierVersion: OAUTH_VERIFIER_VERSION,
    bindingRevision: ctx.binding.revision,
    policyRevision: ctx.binding.policyRevision,
    limitations: [
      ...(input.limitations ?? [
        `Subject asserted by ${input.issuer}; it identifies the issuer's account, not a Ceremony owner.`,
      ]),
    ],
  });
}

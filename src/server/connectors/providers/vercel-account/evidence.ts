import { z } from "zod";
import type { AdapterCallContext } from "../../adapter.js";
import type { VerificationClaim } from "../../adapter-types.js";
import {
  accountIdentityClaim,
  credentialAcceptedClaim,
  permissionRecord,
  splitScope,
} from "../../auth/index.js";
import { issuerPolicyFromBinding } from "../../auth/policy.js";
import { verificationClaimSchema } from "../../../../core/connectors/index.js";
import { ConnectorError } from "../../errors.js";
import type { AccountTeam, AccountUser } from "./client.js";
import {
  VERCEL_ACCOUNT_ADAPTER_ID,
  VERCEL_ACCOUNT_ADAPTER_VERSION,
  vercelAccountSettings,
  vercelAccountTargetKinds,
} from "./contracts.js";

/*
 * What a Vercel account connection says about itself: who signed in, which
 * team it is for, and the claims that rest on what Vercel answered. The
 * identifiers are in the connection's state, never in custody, and a caller is
 * told them; the token that makes them true is neither.
 */

export const ACCOUNT_STATE_KEY = "vercelAccount";

const REPORTED_SCOPE_LIMIT = 16;
const REPORTED_SCOPE_LENGTH = 200;

const accountStateSchema = z.object({
  userId: z.string().min(1).max(256),
  teamId: z.string().min(1).max(256),
  slug: z.string().min(1).max(256),
  expiresAt: z.number().int().nonnegative().optional(),
  /**
   * The scopes Vercel reported granting at sign-in. They are a permission
   * list, not a credential, and live here rather than behind custody: a scope
   * read back out of the credential record would be refused by custody's
   * check that a callback's result holds nothing the record holds, which any
   * single-scope grant trips. A refresh cannot widen a grant, so what the
   * sign-in reported stays what the connection holds.
   */
  reported: z
    .array(z.string().min(1).max(REPORTED_SCOPE_LENGTH))
    .max(REPORTED_SCOPE_LIMIT)
    .default([]),
});
export type BoundAccount = z.infer<typeof accountStateSchema>;

/** Scopes as the state keeps them: bounded, so one odd answer cannot make the state unreadable. */
export function storedScopes(reported: readonly string[]): string[] {
  return reported
    .filter(
      (scope) => scope.length > 0 && scope.length <= REPORTED_SCOPE_LENGTH,
    )
    .slice(0, REPORTED_SCOPE_LIMIT);
}

/** The user and team this connection is bound to, from its own state. */
export function boundAccount(ctx: AdapterCallContext): BoundAccount {
  const parsed = accountStateSchema.safeParse(
    ctx.connection?.state[ACCOUNT_STATE_KEY],
  );
  if (!parsed.success)
    throw new ConnectorError("conflict", {
      detail: `${VERCEL_ACCOUNT_ADAPTER_ID}.team.not-bound`,
    });
  return parsed.data;
}

/**
 * The user a connection was first bound to, if it was. Read leniently: it is
 * a comparison for a new sign-in, not a claim about this one.
 */
export function priorUserId(ctx: AdapterCallContext): string | undefined {
  const parsed = accountStateSchema.safeParse(
    ctx.connection?.state[ACCOUNT_STATE_KEY],
  );
  return parsed.success ? parsed.data.userId : undefined;
}

/** Whether the person asked, in so many words, for a different account than the one held. */
export function accountSwitchRequested(ctx: AdapterCallContext): boolean {
  const intent = ctx.connection?.state["intent"] as
    { accountSwitch?: unknown } | undefined;
  return intent?.accountSwitch === true;
}

export function teamTarget(team: Pick<AccountTeam, "id">) {
  return { kind: vercelAccountTargetKinds.team, id: team.id };
}

export function claimsFor(
  ctx: AdapterCallContext,
  input: {
    user: Pick<AccountUser, "id">;
    team: Pick<AccountTeam, "id">;
    reported: string[];
    validUntil?: number | undefined;
  },
): VerificationClaim[] {
  const settings = vercelAccountSettings(ctx.binding);
  const issuer = issuerPolicyFromBinding(ctx.binding).issuer;
  const now = ctx.environment.now();
  const base = {
    issuer: "provider" as const,
    observedAt: new Date(now).toISOString(),
    ...(input.validUntil !== undefined && input.validUntil > now
      ? { validUntil: new Date(input.validUntil).toISOString() }
      : {}),
    verifierVersion: VERCEL_ACCOUNT_ADAPTER_VERSION,
    bindingRevision: ctx.binding.revision,
    policyRevision: ctx.binding.policyRevision,
  };
  const evidenceRef = (kind: string) =>
    `evidence:vercel-account:${kind}:${ctx.environment.random.uuid()}`;
  return [
    credentialAcceptedClaim(ctx, {
      issuer,
      permissions: permissionRecord({
        requested: settings.scopes,
        reported: input.reported.flatMap((scope) => splitScope(scope)),
        source: input.reported.length ? "token-response" : "none",
      }),
      validUntil: input.validUntil,
      target: teamTarget(input.team),
      limitations: [
        "Vercel reports granted scopes, not the team permissions the account holds; the API permissions behind a team are in private beta",
      ],
    }),
    accountIdentityClaim(ctx, {
      issuer,
      subject: input.user.id,
      subjectKind: vercelAccountTargetKinds.user,
      validUntil: input.validUntil,
      limitations: ["User reported by GET /v2/user for this sign-in"],
    }),
    verificationClaimSchema.parse({
      ...base,
      kind: "resource-access",
      evidenceRef: evidenceRef("team"),
      target: teamTarget(input.team),
      limitations: [
        "The team appeared in GET /v2/teams for this token; what the account may do in it is not observed",
      ],
    }),
  ];
}

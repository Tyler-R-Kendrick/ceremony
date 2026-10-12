import { verificationClaimSchema } from "../../../../core/connectors/index.js";
import type { AdapterCallContext } from "../../adapter.js";
import type {
  EvidenceTargetInput,
  VerificationClaim,
} from "../../adapter-types.js";
import {
  AWS_IDENTITY_CENTER_ADAPTER_VERSION,
  awsSettings,
  awsTargetKinds,
  roleTargetId,
} from "./contracts.js";

/*
 * What a bound role proves, and what it does not. The Portal issued
 * credentials for this account and role to the person who signed in; STS has
 * not been asked who they are, and AWS reports no granted scopes. The claims
 * say exactly that, so a caller cannot read more into "connected".
 */

export type BoundRole = {
  accountId: string;
  roleName: string;
  /** Epoch milliseconds at which the role credentials stop being valid. */
  expiresAt: number;
};

export function accountTarget(accountId: string): EvidenceTargetInput {
  return { kind: awsTargetKinds.account, id: accountId };
}

export function roleTarget(role: BoundRole): EvidenceTargetInput {
  return {
    kind: awsTargetKinds.role,
    id: roleTargetId(role.accountId, role.roleName),
  };
}

export function roleClaims(
  ctx: AdapterCallContext,
  role: BoundRole,
): VerificationClaim[] {
  const settings = awsSettings(ctx.binding);
  const now = ctx.environment.now();
  const base = {
    issuer: "provider" as const,
    observedAt: new Date(now).toISOString(),
    validUntil: new Date(role.expiresAt).toISOString(),
    verifierVersion: AWS_IDENTITY_CENTER_ADAPTER_VERSION,
    bindingRevision: ctx.binding.revision,
    policyRevision: ctx.binding.policyRevision,
  };
  const evidenceRef = (kind: string) =>
    `evidence:aws-identity-center:${kind}:${ctx.environment.random.uuid()}`;
  return [
    verificationClaimSchema.parse({
      ...base,
      kind: "credential-accepted",
      evidenceRef: evidenceRef("credential"),
      target: roleTarget(role),
      permissions: {
        requested: [...settings.scopes],
        reported: [],
        observed: [],
        semantics: "provider-scopes",
      },
      limitations: [
        "AWS reports no granted scopes for an IAM Identity Center session",
        "Role credentials are temporary and are renewed from the sign-in session",
      ],
    }),
    verificationClaimSchema.parse({
      ...base,
      kind: "account-identity",
      evidenceRef: evidenceRef("account"),
      target: accountTarget(role.accountId),
      limitations: [
        "Account reported by the AWS access portal for this sign-in; STS was not asked who holds the credentials",
      ],
    }),
    verificationClaimSchema.parse({
      ...base,
      kind: "resource-access",
      evidenceRef: evidenceRef("role"),
      target: roleTarget(role),
      limitations: [
        "The portal issued credentials for this role; what the role may do is its permission set's, not observed here",
      ],
    }),
  ];
}

import type { AdapterCallContext } from "../../adapter.js";
import type { OwnerKind } from "../../adapter-types.js";
import { ConnectorError } from "../../errors.js";
import type { CredentialScope } from "../../ports.js";
import {
  requireTarget,
  vercelConfigurationNames,
  vercelTargetKinds,
  type VercelCredentialRole,
  type VercelSettings,
} from "./contracts.js";

/*
 * Two credentials, two legs, no crossing. The management token administers
 * connectors and project links for the team; the workload identity is what a
 * deployment presents to obtain provider tokens. They live under different
 * custody scopes, are handed around as branded handles, and every request
 * declares which role it needs, so a management token cannot be spent as a
 * workload credential (or the reverse) by construction — a mismatch is a
 * policy failure before any bearer header is built.
 */

const roleBrand: unique symbol = Symbol("vercel-credential-role");

export type RoleCredential<R extends VercelCredentialRole> = {
  readonly [roleBrand]: R;
  readonly role: R;
  readonly scope: CredentialScope;
  readonly ref: string;
};
export type ManagementCredential = RoleCredential<"management">;
export type WorkloadCredential = RoleCredential<"workload">;

/** A host hook that supplies the deployment's workload identity (for example the OIDC token). */
export type WorkloadTokenSource = (
  ctx: AdapterCallContext,
) => Promise<string | undefined>;

// Bearer tokens are printable ASCII without whitespace; anything else is a
// configuration mistake, not a credential.
const bearerShape = /^[\x21-\x7e]{16,8192}$/;
const teamIdShape = /^[A-Za-z0-9_-]{1,128}$/;

/** The configured team id, which the binding must also name as a permitted target. */
export async function configuredTeamId(
  ctx: AdapterCallContext,
): Promise<string> {
  const value = await ctx.environment.configuration.read(
    vercelConfigurationNames.teamId,
  );
  if (!value || !teamIdShape.test(value))
    throw new ConnectorError("configuration-required", {
      detail: "vercel.team.unconfigured",
    });
  requireTarget(
    ctx.binding,
    vercelTargetKinds.team,
    value,
    "vercel.team.not-permitted",
  );
  return value;
}

const resolved = new WeakMap<
  AdapterCallContext,
  Map<VercelCredentialRole, RoleCredential<VercelCredentialRole>>
>();

export function credentialRole(
  credential: unknown,
): VercelCredentialRole | undefined {
  if (typeof credential !== "object" || credential === null) return undefined;
  const role = (credential as { [roleBrand]?: unknown })[roleBrand];
  return role === "management" || role === "workload" ? role : undefined;
}

/**
 * Materializes the credential for one role inside custody and returns its
 * handle. The value itself is read once from configuration (or the host's
 * workload identity hook) and written straight into the custody port; from
 * then on it is only ever visible inside `use` callbacks.
 */
export async function resolveCredential<R extends VercelCredentialRole>(
  ctx: AdapterCallContext,
  role: R,
  settings: VercelSettings,
  options: { workloadToken?: WorkloadTokenSource } = {},
): Promise<RoleCredential<R>> {
  const perContext =
    resolved.get(ctx) ??
    new Map<VercelCredentialRole, RoleCredential<VercelCredentialRole>>();
  resolved.set(ctx, perContext);
  const cached = perContext.get(role);
  if (cached) return cached as RoleCredential<R>;
  const teamId = await configuredTeamId(ctx);
  const value =
    role === "workload"
      ? ((await options.workloadToken?.(ctx)) ??
        (await ctx.environment.configuration.read(
          vercelConfigurationNames.workloadToken,
        )))
      : await ctx.environment.configuration.read(
          vercelConfigurationNames.managementToken,
        );
  if (!value || !bearerShape.test(value))
    throw new ConnectorError("configuration-required", {
      detail:
        role === "workload"
          ? "vercel.workload.unconfigured"
          : "vercel.management.unconfigured",
    });
  const scope: CredentialScope =
    role === "workload"
      ? {
          tenantId: ctx.actor.tenantId,
          ownerKind: "workload",
          ownerId: `vercel-workload:${teamId}:${settings.project.id}:${settings.project.environment}`,
          connectionRef: `vercel-workload@${ctx.binding.bindingRef}`,
          bindingRef: ctx.binding.bindingRef,
          custody: "host-owned",
        }
      : {
          tenantId: ctx.actor.tenantId,
          ownerKind: "organization",
          ownerId: `vercel-team:${teamId}`,
          connectionRef: `vercel-management@${ctx.binding.bindingRef}`,
          bindingRef: ctx.binding.bindingRef,
          custody: "host-owned",
        };
  const ref = await ctx.environment.credentials.store(scope, { token: value });
  const credential = Object.freeze({
    [roleBrand]: role,
    role,
    scope,
    ref,
  }) as RoleCredential<R>;
  perContext.set(role, credential);
  return credential;
}

/**
 * Runs `work` with the bearer value of a credential whose role is `expected`.
 * The brand check is the runtime half of the type-level separation: a handle
 * of the other role is refused here even if a caller defeated the types.
 */
export async function withBearer<T, R extends VercelCredentialRole>(
  ctx: AdapterCallContext,
  credential: RoleCredential<R>,
  expected: R,
  work: (bearer: string) => Promise<T>,
): Promise<T> {
  if (credentialRole(credential) !== expected || credential.role !== expected)
    throw new ConnectorError("denied", {
      detail: "vercel.credential.role-mismatch",
    });
  return ctx.environment.credentials.use(
    credential.scope,
    credential.ref,
    async (material) => {
      const token = material["token"];
      if (!token)
        throw new ConnectorError("configuration-required", {
          detail: "vercel.credential.empty",
        });
      return work(token);
    },
  );
}

/** Configuration names absent from `present`, for readiness reports. */
export function missingConfiguration(
  present: ReadonlySet<string>,
  names: readonly string[],
): string[] {
  return names.filter((name) => !present.has(name));
}

/**
 * Custody scope of the provider token Vercel Connect vends for a connection.
 * It is broker-vended material: Vercel holds the refresh token, Ceremony holds
 * the short-lived access token under external-credential-broker custody, and
 * only the connection's owner kind and identity can open it.
 */
export function providerTokenScope(
  ctx: AdapterCallContext,
  ownerKind: OwnerKind,
): CredentialScope {
  const connectionRef = ctx.connection?.connectionRef;
  if (!connectionRef)
    throw new ConnectorError("invalid-request", {
      detail: "vercel.connection.required",
    });
  return {
    tenantId: ctx.actor.tenantId,
    ownerKind,
    ownerId:
      ownerKind === "user"
        ? ctx.actor.subjectId
        : ownerKind === "organization"
          ? ctx.actor.tenantId
          : `vercel-workload@${ctx.binding.bindingRef}`,
    connectionRef,
    bindingRef: ctx.binding.bindingRef,
    custody: "external-credential-broker",
  };
}

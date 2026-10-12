import type {
  AdapterCallContext,
  CompletionResult,
  HandoffProposal,
} from "../../adapter.js";
import {
  assertHandoffCurrent,
  inputRequiredHandoff,
} from "../../auth/index.js";
import { ConnectorError } from "../../errors.js";
import {
  AWS_IDENTITY_CENTER_ADAPTER_ID,
  accountIdSchema,
  awsSettings,
  awsTargetKinds,
  permitsTarget,
  permittedAccounts,
  permittedRoles,
  roleNameSchema,
  roleTargetId,
  SELECTION_TTL_MS,
} from "./contracts.js";
import { roleClaims, roleTarget } from "./evidence.js";
import {
  rotateSession,
  sessionScope,
  withSession,
  type SessionMaterial,
} from "./material.js";
import {
  listAccountRoles,
  listAccounts,
  getRoleCredentials,
  roleExpiry,
} from "./portal.js";
import { currentAccessToken } from "./refresh.js";

/*
 * Choosing what the sign-in is for. IAM Identity Center signs a person in to
 * every account they hold; a connection is for one account and one role, and
 * the person picks them after approving, from what the portal says they hold.
 * The binding fixes which accounts are reachable at all, and the caller's
 * intent may narrow that further. When exactly one account and one role are
 * left there is nothing to choose and the connection binds to it, as the AWS
 * CLI does; otherwise a person is asked, and no value they type is believed
 * until the portal lists the role under that account.
 */

export const SELECT_ROLE_INTENT = "aws-identity-center.select-role";
export const SELECTION_FIELDS = ["accountId", "roleName"] as const;
const INSTRUCTIONS_LIMIT = 440;
/** A presentation carries at most 500 characters. */
const PRESENTATION_LIMIT = 500;
const MAX_CHOICES = 40;

const code = (suffix: string) => `${AWS_IDENTITY_CENTER_ADAPTER_ID}.${suffix}`;

type Choice = {
  accountId: string;
  accountName: string | undefined;
  roles: string[];
};

type Plan =
  | { kind: "none" }
  | { kind: "single"; accountId: string; roleName: string }
  | { kind: "choose"; choices: Choice[]; truncated: boolean };

/** What the caller's intent asked for, when it named a target. */
function intendedTarget(
  ctx: AdapterCallContext,
): { accountId: string; roleName?: string } | undefined {
  const intent = ctx.connection?.state["intent"] as
    { target?: { kind?: string; id?: string } } | undefined;
  const target = intent?.target;
  if (!target?.id) return undefined;
  if (target.kind === awsTargetKinds.account) return { accountId: target.id };
  if (target.kind !== awsTargetKinds.role) return undefined;
  const at = target.id.indexOf(":");
  return at > 0
    ? { accountId: target.id.slice(0, at), roleName: target.id.slice(at + 1) }
    : undefined;
}

function allowedRoles(
  ctx: AdapterCallContext,
  accountId: string,
  roles: string[],
) {
  const restricted = permittedRoles(ctx.binding);
  const intended = intendedTarget(ctx);
  return roles.filter(
    (role) =>
      (!restricted || restricted.includes(roleTargetId(accountId, role))) &&
      (intended?.roleName === undefined ||
        (intended.accountId === accountId && intended.roleName === role)),
  );
}

async function planChoice(
  ctx: AdapterCallContext,
  accessToken: string,
): Promise<Plan> {
  const permitted = new Set(permittedAccounts(ctx.binding));
  const intended = intendedTarget(ctx);
  const listing = await listAccounts(ctx, accessToken);
  const accounts = listing.items.filter(
    (account) =>
      permitted.has(account.accountId) &&
      (intended === undefined || intended.accountId === account.accountId),
  );
  if (!accounts.length) return { kind: "none" };
  if (accounts.length === 1) {
    const account = accounts[0]!;
    const roles = allowedRoles(
      ctx,
      account.accountId,
      (await listAccountRoles(ctx, accessToken, account.accountId)).items,
    );
    if (!roles.length) return { kind: "none" };
    if (roles.length === 1)
      return {
        kind: "single",
        accountId: account.accountId,
        roleName: roles[0]!,
      };
    return {
      kind: "choose",
      choices: [
        {
          accountId: account.accountId,
          accountName: account.accountName,
          roles,
        },
      ],
      truncated: listing.truncated,
    };
  }
  return {
    kind: "choose",
    choices: accounts.slice(0, MAX_CHOICES).map((account) => ({
      accountId: account.accountId,
      accountName: account.accountName,
      roles: [],
    })),
    truncated: listing.truncated || accounts.length > MAX_CHOICES,
  };
}

/** One line a person can read; free text from the portal is cleaned of control characters. */
function describeChoices(choices: Choice[], truncated: boolean): string {
  const clean = (value: string) => value.replace(/\p{Cc}/gu, " ").trim();
  const lead = "Enter the account id and the role name to use: ";
  const parts: string[] = [];
  let length = lead.length;
  for (const choice of choices) {
    const name = choice.accountName ? ` ${clean(choice.accountName)}` : "";
    const roles = choice.roles.length ? ` (${choice.roles.join(", ")})` : "";
    const part = `${choice.accountId}${name}${roles}`;
    if (length + part.length + 2 > INSTRUCTIONS_LIMIT) {
      truncated = true;
      break;
    }
    parts.push(part);
    length += part.length + 2;
  }
  return `${lead}${parts.join("; ")}${truncated ? "; more are available" : ""}.`.slice(
    0,
    PRESENTATION_LIMIT,
  );
}

function selectionHandoff(
  ctx: AdapterCallContext,
  ref: string,
  plan: Extract<Plan, { kind: "choose" }>,
): HandoffProposal {
  const proposal = inputRequiredHandoff({
    expiresAt: ctx.environment.now() + SELECTION_TTL_MS,
    intent: SELECT_ROLE_INTENT,
    fields: SELECTION_FIELDS,
  });
  return {
    ...proposal,
    private: {
      ...proposal.private,
      sessionRef: ref,
      instructions: describeChoices(plan.choices, plan.truncated),
    },
  };
}

async function discard(ctx: AdapterCallContext, ref: string): Promise<void> {
  await ctx.environment.credentials
    .revoke(sessionScope(ctx), ref)
    .catch(() => {});
}

/**
 * The person approved the sign-in and the tokens are held. List what they
 * hold, then either bind the one choice there is or ask for one.
 */
export async function continueAfterSignIn(
  ctx: AdapterCallContext,
  ref: string,
): Promise<CompletionResult> {
  const plan = await withSession(ctx, ref, (material) =>
    planChoice(ctx, material.accessToken!),
  );
  if (plan.kind === "none") {
    await discard(ctx, ref);
    return {
      state: "denied",
      claims: [],
      code: code("selection.nothing-permitted"),
      handoffSettled: true,
    };
  }
  if (plan.kind === "single")
    return bindRole(ctx, ref, plan.accountId, plan.roleName, true);
  return {
    state: "human-required",
    claims: [],
    code: code("selection.required"),
    handoff: selectionHandoff(ctx, ref, plan),
    handoffSettled: true,
  };
}

/** The person's choice, validated against the binding and then against the portal. */
export async function completeSelection(
  ctx: AdapterCallContext,
  values: Record<string, string>,
): Promise<CompletionResult> {
  const handoff = ctx.handoff;
  if (!handoff || handoff.intent !== SELECT_ROLE_INTENT)
    throw new ConnectorError("invalid-request", {
      detail: "oauth.handoff.kind",
    });
  const ref = handoff.private["sessionRef"];
  if (!ref)
    throw new ConnectorError("invalid-request", {
      detail: "oauth.handoff.private-missing",
    });
  if (assertHandoffCurrent(ctx, handoff) === "expired") {
    await discard(ctx, ref);
    return { state: "expired", claims: [], code: code("selection.expired") };
  }
  const names = Object.keys(values).sort();
  if (names.join() !== [...SELECTION_FIELDS].sort().join())
    throw new ConnectorError("invalid-request", {
      detail: code("selection.fields"),
    });
  const accountId = accountIdSchema.safeParse(values["accountId"]);
  const roleName = roleNameSchema.safeParse(values["roleName"]);
  if (!accountId.success || !roleName.success)
    throw new ConnectorError("invalid-request", {
      detail: code("selection.shape"),
    });
  if (!permitsTarget(ctx.binding, awsTargetKinds.account, accountId.data))
    throw new ConnectorError("denied", {
      detail: code("account.not-permitted"),
    });
  if (allowedRoles(ctx, accountId.data, [roleName.data]).length !== 1)
    throw new ConnectorError("denied", { detail: code("role.not-permitted") });
  return bindRole(ctx, ref, accountId.data, roleName.data, false);
}

/**
 * Binds the connection to one account and role: the portal must list the role
 * under the account, then GetRoleCredentials issues its credentials, which go
 * into custody with the rest of the sign-in and nowhere else.
 */
export async function bindRole(
  ctx: AdapterCallContext,
  ref: string,
  accountId: string,
  roleName: string,
  handoffSettled: boolean,
): Promise<CompletionResult> {
  const next = await rotateSession(ctx, ref, async (current) => {
    const withToken = await currentAccessToken(ctx, current);
    const roles = await listAccountRoles(
      ctx,
      withToken.accessToken!,
      accountId,
    );
    if (!roles.items.includes(roleName))
      throw new ConnectorError("invalid-request", {
        detail: code("role.unassigned"),
      });
    const credentials = await getRoleCredentials(
      ctx,
      withToken.accessToken!,
      accountId,
      roleName,
    );
    const bound: SessionMaterial = {
      ...withToken,
      phase: "role-bound",
      role: {
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
        expiresAt: roleExpiry(ctx, credentials),
      },
    };
    return bound;
  });
  const role = { accountId, roleName, expiresAt: next.expiresAt };
  return {
    state: "complete",
    claims: roleClaims(ctx, role),
    credentialRef: next.ref,
    target: roleTarget(role),
    adapterState: {
      aws: {
        accountId,
        roleName,
        region: awsSettings(ctx.binding).region,
        expiresAt: next.expiresAt,
      },
    },
    ...(handoffSettled ? { handoffSettled: true } : {}),
  };
}

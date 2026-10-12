import type {
  AdapterCallContext,
  AuthorizationIntent,
  AuthorizationStart,
  CompletionResult,
  HandoffProposal,
} from "../../adapter.js";
import type { VerificationClaim } from "../../adapter-types.js";
import {
  assertHandoffCurrent,
  beginDeviceAuthorization,
  DEVICE_CODE_INTENT,
  inputRequiredHandoff,
  pollDeviceAuthorization,
  splitScope,
  type DevicePollState,
} from "../../auth/index.js";
import type { ConnectorOAuthOptions } from "../../auth/connector-oauth.js";
import { issuerPolicyFromBinding } from "../../auth/policy.js";
import { displayText } from "../../display-text.js";
import { ConnectorError } from "../../errors.js";
import {
  accountApiDestination,
  listTeams,
  readUser,
  type AccountTeam,
  type AccountUser,
} from "./client.js";
import {
  permittedTeams,
  SELECTION_TTL_MS,
  VERCEL_ACCOUNT_ADAPTER_ID,
  VERCEL_DEVICE_GRANT,
  vercelAccountSettings,
  vercelAccountTargetKinds,
} from "./contracts.js";
import {
  ACCOUNT_STATE_KEY,
  accountSwitchRequested,
  claimsFor,
  priorUserId,
  storedScopes,
  teamTarget,
} from "./evidence.js";
import {
  ensureFresh,
  resolveOrMissing,
  resolveSignIn,
  sessionScope,
  withBearer,
} from "./session.js";

/*
 * The ceremony: Vercel's device authorization grant, then a choice of team.
 * The grant is the one every other device flow here runs (`connectors/auth`),
 * so the person sees the same link and code and nothing else; this module adds
 * only what Vercel's account has that a bare token does not: who signed in,
 * which teams they belong to, and which of those the host lets this
 * connection be for. A person who belongs to exactly one permitted team is
 * not asked; otherwise the choice is theirs and is checked against Vercel's
 * own list, not believed.
 */

export const SELECT_TEAM_INTENT = "vercel-account.select-team";
const INSTRUCTIONS_LIMIT = 440;
const PRESENTATION_LIMIT = 500;

const code = (suffix: string) => `${VERCEL_ACCOUNT_ADAPTER_ID}.${suffix}`;

export type TeamPlan =
  | { kind: "none" }
  | { kind: "single"; team: AccountTeam }
  | { kind: "choose"; teams: AccountTeam[]; truncated: boolean };

export async function beginSignIn(
  ctx: AdapterCallContext,
  intent: Pick<AuthorizationIntent, "ownerKind">,
  options: ConnectorOAuthOptions,
): Promise<AuthorizationStart> {
  const settings = vercelAccountSettings(ctx.binding);
  if (intent.ownerKind !== "user")
    return { kind: "unsupported", code: code("owner-kind") };
  if (!permittedTeams(ctx.binding).length)
    return { kind: "unsupported", code: code("targets-missing") };
  accountApiDestination(ctx);
  const policy = issuerPolicyFromBinding(ctx.binding);
  const resolved = await resolveOrMissing(ctx, options, {
    grantTypes: [VERCEL_DEVICE_GRANT],
    scope: settings.scopes.join(" "),
  });
  if ("missing" in resolved)
    return { kind: "configuration-required", missing: resolved.missing };
  return beginDeviceAuthorization(ctx, {
    server: resolved.server,
    client: resolved.client,
    policy,
    scopes: settings.scopes,
  });
}

export function devicePollState(
  ctx: AdapterCallContext,
): DevicePollState | undefined {
  const raw = ctx.connection?.state["devicePoll"];
  if (!raw || typeof raw !== "object") return undefined;
  const { interval, nextPollAt } = raw as Record<string, unknown>;
  if (
    typeof interval !== "number" ||
    typeof nextPollAt !== "number" ||
    !Number.isFinite(interval) ||
    !Number.isFinite(nextPollAt)
  )
    return undefined;
  return { interval, nextPollAt };
}

/** A grant that settled its own handoff says so, so the command layer does not settle it twice. */
function settled(result: CompletionResult): CompletionResult {
  return ["complete", "denied", "expired"].includes(result.state)
    ? { ...result, handoffSettled: true }
    : result;
}

export async function pollSignIn(
  ctx: AdapterCallContext,
  options: ConnectorOAuthOptions,
): Promise<CompletionResult> {
  const handoff = ctx.handoff;
  if (!handoff || handoff.intent !== DEVICE_CODE_INTENT)
    throw new ConnectorError("invalid-request", {
      detail: "oauth.handoff.kind",
    });
  const oauth = await resolveSignIn(ctx, options);
  const result = settled(
    await pollDeviceAuthorization(ctx, {
      handoff,
      server: oauth.server,
      client: oauth.client,
      policy: oauth.policy,
      poll: devicePollState(ctx),
      scope: sessionScope(ctx),
    }),
  );
  if (result.state !== "complete" || !result.credentialRef) return result;
  // The device code is spent and its handoff settled. If what follows fails,
  // the token must not be left in custody with nothing pointing at it.
  try {
    return await continueAfterSignIn(ctx, result);
  } catch (error) {
    await discard(ctx, result.credentialRef);
    throw error;
  }
}

/** What the caller's intent asked for, when it named a team. */
function intendedTeam(ctx: AdapterCallContext): string | undefined {
  const intent = ctx.connection?.state["intent"] as
    { target?: { kind?: string; id?: string } } | undefined;
  return intent?.target?.kind === vercelAccountTargetKinds.team
    ? intent.target.id
    : undefined;
}

export function planTeams(
  ctx: AdapterCallContext,
  listing: { teams: AccountTeam[]; truncated: boolean },
): TeamPlan {
  const permitted = new Set(permittedTeams(ctx.binding));
  const wanted = intendedTeam(ctx);
  const teams = listing.teams.filter(
    (team) =>
      permitted.has(team.id) && (wanted === undefined || team.id === wanted),
  );
  // "Exactly one" is a claim about the whole list; a listing that was cut off
  // is a part of it, so the person is asked.
  if (!teams.length) return { kind: "none" };
  if (teams.length === 1 && !listing.truncated)
    return { kind: "single", team: teams[0]! };
  return { kind: "choose", teams, truncated: listing.truncated };
}

function describeTeams(teams: AccountTeam[], truncated: boolean): string {
  const clean = displayText;
  const lead = "Enter the team slug to use: ";
  const parts: string[] = [];
  let length = lead.length;
  for (const team of teams) {
    const part = `${clean(team.slug)} (${team.id})`;
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
  plan: Extract<TeamPlan, { kind: "choose" }>,
  reported: string[],
): HandoffProposal {
  const proposal = inputRequiredHandoff({
    expiresAt: ctx.environment.now() + SELECTION_TTL_MS,
    intent: SELECT_TEAM_INTENT,
    fields: ["team"],
  });
  return {
    ...proposal,
    private: {
      ...proposal.private,
      sessionRef: ref,
      reported: reported.join(" "),
      instructions: describeTeams(plan.teams, plan.truncated),
    },
  };
}

async function discard(ctx: AdapterCallContext, ref: string): Promise<void> {
  await ctx.environment.credentials
    .revoke(sessionScope(ctx), ref)
    .catch(() => {});
}

/** The scopes Vercel reported granting, carried from the grant's own claim. */
function reportedScopes(claims: VerificationClaim[]): string[] {
  return (
    claims.find((claim) => claim.kind === "credential-accepted")?.permissions
      ?.reported ?? []
  ).slice(0, 16);
}

async function continueAfterSignIn(
  ctx: AdapterCallContext,
  grant: CompletionResult,
): Promise<CompletionResult> {
  const ref = grant.credentialRef!;
  const reported = reportedScopes(grant.claims);
  const listed = await withBearer(ctx, ref, async (bearer) => ({
    user: await readUser(ctx, bearer),
    listing: await listTeams(ctx, bearer),
  }));
  const plan = planTeams(ctx, listed.listing);
  if (plan.kind === "none") {
    await discard(ctx, ref);
    return {
      state: "denied",
      claims: [],
      // A cut-off listing cannot say there is nothing: only that none was found.
      code: code(
        listed.listing.truncated
          ? "selection.listing-incomplete"
          : "selection.nothing-permitted",
      ),
      handoffSettled: true,
    };
  }
  if (plan.kind === "single")
    return bindTeam(ctx, ref, listed.user, plan.team, reported, true);
  return {
    state: "human-required",
    claims: [],
    code: code("selection.required"),
    handoff: selectionHandoff(ctx, ref, plan, reported),
    handoffSettled: true,
  };
}

/** The person's choice: an id or a slug, checked against Vercel's own list and the binding. */
export async function completeSelection(
  ctx: AdapterCallContext,
  values: Record<string, string>,
  options: ConnectorOAuthOptions,
): Promise<CompletionResult> {
  const handoff = ctx.handoff;
  if (!handoff || handoff.intent !== SELECT_TEAM_INTENT)
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
  const names = Object.keys(values);
  const entered = values["team"]?.trim();
  if (names.length !== 1 || !entered || entered.length > 256)
    throw new ConnectorError("invalid-request", {
      detail: code("selection.fields"),
    });
  await ensureFresh(ctx, ref, options);
  const listed = await withBearer(ctx, ref, async (bearer) => ({
    user: await readUser(ctx, bearer),
    listing: await listTeams(ctx, bearer),
  }));
  // An id is exact; a slug is what a person usually types. If one team's slug
  // is spelled like another's id, the id wins, so a pick means one team.
  const team =
    listed.listing.teams.find((candidate) => candidate.id === entered) ??
    listed.listing.teams.find((candidate) => candidate.slug === entered);
  if (!team)
    throw new ConnectorError("invalid-request", {
      detail: code("team.unknown"),
    });
  const plan = planTeams(ctx, { teams: [team], truncated: false });
  if (plan.kind !== "single")
    throw new ConnectorError("denied", { detail: code("team.not-permitted") });
  return bindTeam(
    ctx,
    ref,
    listed.user,
    team,
    splitScope(handoff.private["reported"]),
    false,
  );
}

/** Binds the connection to one team: the sign-in's record stays the connection's credential. */
export async function bindTeam(
  ctx: AdapterCallContext,
  ref: string,
  user: AccountUser,
  team: AccountTeam,
  reported: string[],
  handoffSettled: boolean,
): Promise<CompletionResult> {
  // The command layer compares the team a connection is for. A different
  // person approving into the same team is the same team, so the user is
  // compared here: a switch of account is something a person asks for.
  const prior = priorUserId(ctx);
  if (
    prior !== undefined &&
    prior !== user.id &&
    !accountSwitchRequested(ctx)
  ) {
    await discard(ctx, ref);
    return {
      state: "denied",
      claims: [],
      code: code("user.changed"),
      ...(handoffSettled ? { handoffSettled: true } : {}),
    };
  }
  const described = await ctx.environment.credentials.describe(
    sessionScope(ctx),
    ref,
  );
  return {
    state: "complete",
    claims: claimsFor(ctx, {
      user,
      team,
      reported,
      validUntil: described?.expiresAt,
    }),
    credentialRef: ref,
    target: teamTarget(team),
    adapterState: {
      [ACCOUNT_STATE_KEY]: {
        userId: user.id,
        teamId: team.id,
        slug: team.slug,
        reported: storedScopes(reported),
        ...(described?.expiresAt !== undefined
          ? { expiresAt: described.expiresAt }
          : {}),
      },
    },
    ...(handoffSettled ? { handoffSettled: true } : {}),
  };
}

import type { z } from "zod";
import type { AdapterCallContext } from "../../adapter.js";
import { destinationUrl, type ApprovedDestination } from "../../binding.js";
import { readBoundedBody } from "../../bounded-body.js";
import { ConnectorError } from "../../errors.js";
import {
  apiFailure,
  MAX_TEAM_PAGES,
  TEAMS_PAGE_SIZE,
  teamsResponseSchema,
  userResponseSchema,
  VERCEL_ACCOUNT_REQUEST_TIMEOUT_MS,
  VERCEL_ACCOUNT_RESPONSE_LIMIT_BYTES,
  VERCEL_API_ORIGIN,
  vercelAccountDestinationIds,
  vercelAccountSettings,
} from "./contracts.js";

/*
 * The calls that follow a sign-in: who signed in (GET /v2/user) and which
 * teams they belong to (GET /v2/teams). One way to make them: the destination
 * comes from the binding, the bearer only from inside a custody callback, and
 * a failure is a status turned into a fixed code, never Vercel's words.
 */

export function accountApiDestination(
  ctx: AdapterCallContext,
): ApprovedDestination {
  const destination = ctx.binding.destinations.find(
    (item) => item.id === vercelAccountDestinationIds.api,
  );
  if (!destination)
    throw new ConnectorError("network-policy", {
      detail: "vercel-account.destination.api-missing",
    });
  // A public destination is api.vercel.com and nothing else, so a binding
  // cannot send the person's bearer to another host.
  if (
    destination.network === "public" &&
    (destination.origin !== VERCEL_API_ORIGIN ||
      (destination.pathPrefix !== undefined && destination.pathPrefix !== "/"))
  )
    throw new ConnectorError("network-policy", {
      detail: "vercel-account.destination.api-host",
    });
  return destination;
}

async function get<T>(
  ctx: AdapterCallContext,
  bearer: string,
  path: string,
  query: Record<string, string | number | undefined>,
  schema: z.ZodType<T>,
): Promise<T> {
  const url = destinationUrl(accountApiDestination(ctx), path);
  for (const [name, value] of Object.entries(query))
    if (value !== undefined) url.searchParams.set(name, String(value));
  const timeout =
    vercelAccountSettings(ctx.binding).requestTimeoutMs ??
    VERCEL_ACCOUNT_REQUEST_TIMEOUT_MS;
  let response: Response;
  try {
    response = await ctx.environment.fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${bearer}`,
      },
      redirect: "error",
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(timeout)]),
    });
  } catch (error) {
    if (ctx.signal.aborted)
      throw new ConnectorError("cancelled", { cause: error });
    throw new ConnectorError("upstream-unavailable", {
      detail: "vercel-account.network",
      cause: error,
    });
  }
  const text = await readBoundedBody(
    response,
    VERCEL_ACCOUNT_RESPONSE_LIMIT_BYTES,
    "vercel-account.response.too-large",
  );
  if (!response.ok) throw apiFailure(response.status);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success)
    throw new ConnectorError("upstream-rejected", {
      detail: "vercel-account.api.invalid-response",
    });
  return parsed.data;
}

export type AccountUser = {
  id: string;
  email?: string | undefined;
  name?: string | null | undefined;
  username?: string | undefined;
};

export async function readUser(
  ctx: AdapterCallContext,
  bearer: string,
): Promise<AccountUser> {
  return (await get(ctx, bearer, "/v2/user", {}, userResponseSchema)).user;
}

export type AccountTeam = {
  id: string;
  slug: string;
  name?: string | null | undefined;
};

/**
 * Every page, bounded, as a set. `truncated` says the listing is not known to
 * be whole: a later page was left unread, or a page added no team not already
 * seen (the same page again, which a server that is not advancing answers) and
 * reading on would only repeat it.
 */
export async function listTeams(
  ctx: AdapterCallContext,
  bearer: string,
): Promise<{ teams: AccountTeam[]; truncated: boolean }> {
  const teams: AccountTeam[] = [];
  const seen = new Set<string>();
  let until: number | undefined;
  for (let page = 0; page < MAX_TEAM_PAGES; page++) {
    const body = await get(
      ctx,
      bearer,
      "/v2/teams",
      { limit: TEAMS_PAGE_SIZE, until },
      teamsResponseSchema,
    );
    let added = 0;
    for (const team of body.teams) {
      if (seen.has(team.id)) continue;
      seen.add(team.id);
      teams.push(team);
      added += 1;
    }
    const next = body.pagination?.next;
    if (next === undefined || next === null) return { teams, truncated: false };
    if (added === 0) return { teams, truncated: true };
    until = next;
  }
  return { teams, truncated: true };
}

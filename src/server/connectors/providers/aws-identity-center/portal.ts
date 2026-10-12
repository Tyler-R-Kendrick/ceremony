import { z } from "zod";
import type { AdapterCallContext } from "../../adapter.js";
import { ConnectorError } from "../../errors.js";
import { callAws } from "./client.js";
import {
  accountsResponseSchema,
  MAX_PORTAL_PAGES,
  PORTAL_PAGE_SIZE,
  portalFailure,
  roleCredentialsResponseSchema,
  rolesResponseSchema,
  type RoleCredentialsWire,
} from "./contracts.js";

/*
 * The AWS access portal operations, from the Portal API Reference. Each takes
 * the IAM Identity Center access token in `x-amz-sso_bearer_token`; callers
 * pass it from inside a custody callback and nothing here keeps it. A failed
 * call becomes a fixed code by status, because the reference documents the
 * statuses and not a body.
 */

const TOKEN_HEADER = "x-amz-sso_bearer_token";

export type PortalAccount = {
  accountId: string;
  accountName?: string | undefined;
  emailAddress?: string | undefined;
};

async function portalGet<T>(
  ctx: AdapterCallContext,
  accessToken: string,
  path: string,
  query: Record<string, string | number | undefined>,
  schema: z.ZodType<T>,
): Promise<T> {
  const reply = await callAws(ctx, {
    role: "portal",
    method: "GET",
    path,
    query,
    headers: { [TOKEN_HEADER]: accessToken },
    schema,
  });
  if (!reply.ok) throw portalFailure(reply.status);
  return reply.body;
}

/** Every page, up to a bound; `truncated` says a later page was left unread. */
async function pages<T>(
  fetchPage: (
    nextToken: string | undefined,
  ) => Promise<{ items: T[]; nextToken: string | null | undefined }>,
): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  let nextToken: string | undefined;
  for (let page = 0; page < MAX_PORTAL_PAGES; page++) {
    const result = await fetchPage(nextToken);
    items.push(...result.items);
    if (!result.nextToken) return { items, truncated: false };
    nextToken = result.nextToken;
  }
  return { items, truncated: true };
}

export function listAccounts(
  ctx: AdapterCallContext,
  accessToken: string,
): Promise<{ items: PortalAccount[]; truncated: boolean }> {
  return pages(async (nextToken) => {
    const body = await portalGet(
      ctx,
      accessToken,
      "/assignment/accounts",
      { max_result: PORTAL_PAGE_SIZE, next_token: nextToken },
      accountsResponseSchema,
    );
    return { items: body.accountList, nextToken: body.nextToken };
  });
}

export async function listAccountRoles(
  ctx: AdapterCallContext,
  accessToken: string,
  accountId: string,
): Promise<{ items: string[]; truncated: boolean }> {
  return pages(async (nextToken) => {
    const body = await portalGet(
      ctx,
      accessToken,
      "/assignment/roles",
      {
        account_id: accountId,
        max_result: PORTAL_PAGE_SIZE,
        next_token: nextToken,
      },
      rolesResponseSchema,
    );
    // A role the portal lists under another account is not this account's.
    return {
      items: body.roleList
        .filter(
          (role) =>
            role.accountId === undefined || role.accountId === accountId,
        )
        .map((role) => role.roleName),
      nextToken: body.nextToken,
    };
  });
}

/** Credentials are validated here; the caller stores them and returns nothing that contains them. */
export async function getRoleCredentials(
  ctx: AdapterCallContext,
  accessToken: string,
  accountId: string,
  roleName: string,
): Promise<RoleCredentialsWire> {
  const body = await portalGet(
    ctx,
    accessToken,
    "/federation/credentials",
    { account_id: accountId, role_name: roleName },
    roleCredentialsResponseSchema,
  );
  return body.roleCredentials;
}

/**
 * Role credentials last one to twelve hours (the permission set's session
 * duration), and `expiration` is read as epoch milliseconds. A value that
 * cannot be a credential lifetime on that reading is refused rather than
 * stored with a guessed unit.
 */
export function roleExpiry(
  ctx: AdapterCallContext,
  credentials: RoleCredentialsWire,
): number {
  const now = ctx.environment.now();
  const remaining = credentials.expiration - now;
  if (remaining < 60_000 || remaining > 13 * 3_600_000)
    throw new ConnectorError("upstream-rejected", {
      detail: "aws-identity-center.role.expiration",
    });
  return credentials.expiration;
}

export async function logout(
  ctx: AdapterCallContext,
  accessToken: string,
): Promise<boolean> {
  const reply = await callAws(ctx, {
    role: "portal",
    method: "POST",
    path: "/logout",
    headers: { [TOKEN_HEADER]: accessToken },
    schema: z.undefined(),
  });
  return reply.ok;
}

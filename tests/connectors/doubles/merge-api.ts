import { startHttpFixture } from "./http-fixture.js";

/*
 * An independent double of the Merge Unified API, written from
 * https://docs.merge.dev (retrieved 2026-09-18) and not from the adapter.
 * Documented routes only:
 *
 *   POST /api/integrations/create-link-token          -> { link_token, integration_name, magic_link_url? }
 *   GET  /api/integrations/account-token/{public}     -> { account_token, integration, id }
 *   GET  /api/{category}/v1/linked-accounts           -> { next, previous, results }
 *   GET  /api/{category}/v1/account-details           -> LinkedAccount details
 *   GET  /api/{category}/v1/{model}                   -> { next, previous, results }
 *   GET  /api/{category}/v1/{model}/meta/post         -> { request_schema, status, ... }
 *   POST /api/{category}/v1/passthrough               -> { method, path, status, response, ... }
 *   POST /api/{category}/v1/delete-account            -> {}
 *
 * The double enforces the documented authentication rules independently:
 * `Authorization: Bearer <api key>` on everything, and `X-Account-Token` in
 * addition on every end-user-scoped route. Two linked accounts are modelled
 * with genuinely different available fields and supported operations, which is
 * how account-specific availability is observed rather than assumed.
 */

export type MergeDoubleAccount = {
  accountToken: string;
  publicToken?: string;
  id: string;
  category: string;
  integration: {
    name: string;
    slug: string;
    categories?: string[];
    passthrough_available?: boolean;
  };
  status: "COMPLETE" | "INCOMPLETE" | "RELINK_NEEDED" | "IDLE";
  statusDetail?: string;
  accountType?: "PRODUCTION" | "TEST";
  endUserOriginId: string;
  endUserOrganizationName?: string;
  endUserEmailAddress?: string;
  completedAt?: string;
  /** Rows this account returns per model; field presence differs per account. */
  models?: Record<string, Array<Record<string, unknown>>>;
  /** The /meta/post response per model; absent means the model is unsupported here. */
  meta?: Record<string, Record<string, unknown>>;
  /** Upstream responses this account's passthrough answers, keyed "METHOD path". */
  passthrough?: Record<string, { status: number; response: unknown }>;
};

export type MergeDoubleOptions = {
  apiKey?: string;
  accounts?: MergeDoubleAccount[];
  /** Link tokens minted, keyed by the end_user_origin_id they were requested for. */
  linkToken?: string;
  magicLinkUrl?: string;
  failPassthrough?: { times: number; status: number };
};

type Json = Record<string, unknown>;

export async function startMergeApiDouble(options: MergeDoubleOptions = {}) {
  const apiKey = options.apiKey ?? "merge-api-key";
  const accounts = options.accounts ?? [];
  const byToken = new Map(accounts.map((account) => [account.accountToken, account]));
  const byPublicToken = new Map(
    accounts
      .filter((account) => account.publicToken)
      .map((account) => [account.publicToken!, account]),
  );
  const linkTokenRequests: Json[] = [];
  const deletedAccounts: string[] = [];
  let remainingPassthroughFailures = options.failPassthrough?.times ?? 0;

  const accountOf = (request: { headers: Record<string, string> }) => {
    const token = request.headers["x-account-token"];
    return token ? byToken.get(token) : undefined;
  };

  const linkedAccountBody = (account: MergeDoubleAccount) => ({
    id: account.id,
    integration: account.integration,
    integration_name: account.integration.name,
    category: account.category,
    status: account.status,
    status_detail: account.statusDetail ?? null,
    end_user_origin_id: account.endUserOriginId,
    end_user_organization_name: account.endUserOrganizationName ?? "Acme",
    end_user_email_address: account.endUserEmailAddress ?? "user@example.test",
    subdomain: null,
    webhook_listener_url: `https://api.merge.dev/api/integrations/webhook-listener/${account.id}`,
    is_duplicate: false,
    account_type: account.accountType ?? "PRODUCTION",
    completed_at: account.completedAt ?? "2026-09-01T00:00:00Z",
  });

  const fixture = await startHttpFixture((request) => {
    if (request.headers.authorization !== `Bearer ${apiKey}`)
      return { status: 401, body: { error: "unauthorized" } };
    const path = request.url.pathname;
    const method = request.method;

    if (method === "POST" && path === "/api/integrations/create-link-token") {
      const body = JSON.parse(request.body.toString("utf8") || "{}") as Json;
      if (
        typeof body.end_user_origin_id !== "string" ||
        typeof body.end_user_organization_name !== "string" ||
        typeof body.end_user_email_address !== "string" ||
        !Array.isArray(body.categories)
      )
        return { status: 400, body: { error: "missing required fields" } };
      linkTokenRequests.push(body);
      return {
        body: {
          link_token: options.linkToken ?? "link-token-1",
          integration_name: "HR System",
          ...(body.should_create_magic_link_url
            ? { magic_link_url: options.magicLinkUrl ?? "https://link.merge.dev/magic/abc" }
            : {}),
        },
      };
    }

    const exchange = /^\/api\/integrations\/account-token\/([^/]+)$/.exec(path);
    if (method === "GET" && exchange) {
      const account = byPublicToken.get(decodeURIComponent(exchange[1] ?? ""));
      if (!account) return { status: 404, body: { error: "not_found" } };
      return {
        body: {
          account_token: account.accountToken,
          integration: account.integration,
          id: account.id,
        },
      };
    }

    const scoped = /^\/api\/([a-z]+)\/v1\/(.+)$/.exec(path);
    if (!scoped) return undefined;
    const [, category, rest] = scoped as unknown as [string, string, string];

    if (method === "GET" && rest === "linked-accounts") {
      // Documented as API-key only; an account token is not required here.
      const originId = request.url.searchParams.get("end_user_origin_id");
      const status = request.url.searchParams.get("status");
      const results = accounts.filter(
        (account) =>
          account.category === category &&
          (!originId || account.endUserOriginId === originId) &&
          (!status || account.status === status) &&
          !deletedAccounts.includes(account.id),
      );
      return {
        body: { next: null, previous: null, results: results.map(linkedAccountBody) },
      };
    }

    const account = accountOf(request);
    if (!account) return { status: 400, body: { error: "account token required" } };
    if (account.category !== category)
      return { status: 404, body: { error: "not_found" } };
    if (deletedAccounts.includes(account.id))
      return { status: 404, body: { error: "not_found" } };

    if (method === "GET" && rest === "account-details")
      return {
        body: {
          id: account.id,
          integration: account.integration.name,
          integration_slug: account.integration.slug,
          category: account.category,
          end_user_origin_id: account.endUserOriginId,
          end_user_organization_name: account.endUserOrganizationName ?? "Acme",
          end_user_email_address: account.endUserEmailAddress ?? "user@example.test",
          status: account.status,
          webhook_listener_url: `https://api.merge.dev/api/integrations/webhook-listener/${account.id}`,
          is_duplicate: false,
          account_type: account.accountType ?? "PRODUCTION",
          completed_at: account.completedAt ?? "2026-09-01T00:00:00Z",
        },
      };

    if (method === "POST" && rest === "delete-account") {
      deletedAccounts.push(account.id);
      return { body: {} };
    }

    if (method === "POST" && rest === "passthrough") {
      if (remainingPassthroughFailures > 0) {
        remainingPassthroughFailures--;
        return {
          status: options.failPassthrough?.status ?? 503,
          body: { error: "unavailable" },
        };
      }
      if (account.integration.passthrough_available === false)
        return { status: 400, body: { error: "passthrough not available" } };
      const body = JSON.parse(request.body.toString("utf8") || "{}") as Json;
      if (typeof body.method !== "string" || typeof body.path !== "string")
        return { status: 400, body: { error: "method and path are required" } };
      const key = `${body.method} ${String(body.path).split("?")[0]}`;
      const canned = account.passthrough?.[key];
      if (!canned) return { status: 404, body: { error: "no upstream route" } };
      return {
        body: {
          method: body.method,
          path: body.path,
          status: canned.status,
          response: canned.response,
          response_type: "JSON",
          response_headers: {},
          headers: {},
        },
      };
    }

    const meta = /^([a-z-]+)\/meta\/post$/.exec(rest);
    if (method === "GET" && meta) {
      const model = meta[1]!;
      const declared = account.meta?.[model];
      if (!declared)
        return { status: 404, body: { error: "model not supported for this account" } };
      return { body: declared };
    }

    if (method === "GET" && /^[a-z-]+$/.test(rest)) {
      const rows = account.models?.[rest];
      if (!rows)
        return { status: 404, body: { error: "model not supported for this account" } };
      const pageSize = Number(request.url.searchParams.get("page_size") ?? rows.length);
      return {
        body: {
          next: null,
          previous: null,
          results: rows.slice(0, Number.isFinite(pageSize) ? pageSize : rows.length),
        },
      };
    }
    return undefined;
  });

  return {
    ...fixture,
    apiKey,
    linkTokenRequests,
    deletedAccounts,
    accounts,
    passthroughRequests(category: string) {
      return fixture
        .received("POST", `/api/${category}/v1/passthrough`)
        .map((request) => ({
          headers: request.headers,
          body: JSON.parse(request.body.toString("utf8")) as Json,
        }));
    },
  };
}

import { randomUUID } from "node:crypto";
import { startHttpFixture, type RecordedRequest } from "./http-fixture.js";

/*
 * An independent double of the Composio platform API, written from the
 * published documentation (https://docs.composio.dev, retrieved 2026-09-18)
 * and NOT from the adapter under test. It asserts the documented request
 * contract itself — the `x-api-key` project key, the exact paths under
 * `/api/v3`, the documented query parameter names, the required body fields of
 * `POST /connected_accounts` and `POST /tools/execute/{tool_slug}` — and
 * answers with the documented response envelopes. When a request violates the
 * contract the double answers the way the documentation says the API answers
 * (400/401/404), so a wrong adapter fails here rather than being quietly
 * accommodated.
 *
 * Documented surface implemented:
 *   GET    /api/v3/toolkits                             { items, next_cursor, ... }
 *   GET    /api/v3/toolkits/{slug}                      toolkit
 *   GET    /api/v3/auth_configs                         { items, ... }
 *   GET    /api/v3/connected_accounts                   { items, ... }
 *   POST   /api/v3/connected_accounts                   201 { id, status, redirect_url }
 *   GET    /api/v3/connected_accounts/{nanoid}          connected account
 *   DELETE /api/v3/connected_accounts/{nanoid}          204
 *   GET    /api/v3/tools                                { items, ... }
 *   GET    /api/v3/tools/{tool_slug}?version=           tool
 *   POST   /api/v3/tools/execute/{tool_slug}            { data, error, successful, log_id }
 *   POST   /api/v3/tool_router/session                  201 { session_id, mcp, tool_router_tools, ... }
 *   POST   /api/v3/tool_router/session/{id}/execute     { data, error, log_id }
 *   POST   /api/v3/tool_router/session/{id}/execute_meta same envelope
 */

export type DoubleToolkit = {
  slug: string;
  name: string;
  enabled?: boolean;
  composio_managed_auth_schemes?: string[];
  auth_config_details?: Array<{
    mode: string;
    name?: string;
    required_scopes?: string[];
  }>;
  meta?: {
    description?: string;
    toolkit_version?: string;
    tools_count?: number;
  };
};

export type DoubleAuthConfig = {
  id: string;
  name?: string;
  status?: string;
  auth_scheme: string;
  is_composio_managed?: boolean;
  is_disabled?: boolean;
  toolkit: { slug: string };
  restrict_to_following_tools?: string[];
  /** Documented field; a double that never returns it cannot prove it stays out of projections. */
  credentials?: Record<string, unknown>;
};

export type DoubleAccount = {
  id: string;
  user_id: string;
  status: string;
  toolkit: { slug: string };
  auth_config: { id: string; auth_scheme?: string; is_disabled?: boolean };
  state?: { authScheme?: string; val?: Record<string, unknown> };
  created_at?: string;
  updated_at?: string;
  status_reason?: string | null;
  is_disabled?: boolean;
};

export type DoubleTool = {
  slug: string;
  name?: string;
  description?: string;
  version: string;
  available_versions?: string[];
  input_parameters?: Record<string, unknown>;
  output_parameters?: Record<string, unknown>;
  scopes?: string[];
  no_auth?: boolean;
  deprecated?: { is_deprecated?: boolean };
  toolkit?: { slug: string };
};

export type ExecuteHandler = (input: {
  toolSlug: string;
  userId: string;
  connectedAccountId: string;
  version: string | undefined;
  arguments: Record<string, unknown>;
}) =>
  | {
      status?: number;
      data?: unknown;
      error?: string | null;
      successful?: boolean;
    }
  | undefined;

export type ComposioDoubleOptions = {
  /** The project API key the double accepts; anything else is 401, as documented. */
  apiKey: string;
  base?: string;
  toolkits?: DoubleToolkit[];
  authConfigs?: DoubleAuthConfig[];
  accounts?: DoubleAccount[];
  tools?: DoubleTool[];
  /** Tools the created session advertises; defaults to the requested toolkit's tools. */
  sessionToolRouterTools?: string[];
  execute?: ExecuteHandler;
  /**
   * The hosted authorization URL `POST /connected_accounts` answers with.
   * Composio chooses this URL, so a double that can only ever return its own
   * origin cannot show what happens when the answer names somewhere else.
   */
  hostedRedirectUrl?: string;
  /** Force a session execute to answer 404 once, to exercise stale-session recovery. */
  staleSessionOnce?: boolean;
};

export type ComposioDouble = Awaited<ReturnType<typeof startComposioDouble>>;

const json = (status: number, body: unknown) => ({
  status,
  body: body as never,
});
const badRequest = (error: string) => json(400, { error });
const notFound = () => json(404, { error: "not_found" });

function readJson(
  request: RecordedRequest,
): Record<string, unknown> | undefined {
  if (!request.body.length) return undefined;
  try {
    const value: unknown = JSON.parse(request.body.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function page(items: unknown[]) {
  return {
    items,
    next_cursor: null,
    total_pages: 1,
    current_page: 1,
    total_items: items.length,
  };
}

/** Documented multi-value filters arrive as repeated query parameters. */
function values(url: URL, name: string): string[] {
  return url.searchParams.getAll(name).flatMap((value) => value.split(","));
}

export async function startComposioDouble(options: ComposioDoubleOptions) {
  const base = options.base ?? "/api/v3";
  const toolkits = [...(options.toolkits ?? [])];
  const authConfigs = [...(options.authConfigs ?? [])];
  const accounts = [...(options.accounts ?? [])];
  const tools = [...(options.tools ?? [])];
  const sessions = new Map<
    string,
    { userId: string; toolkits: string[]; accounts: Record<string, string> }
  >();
  let staleSessionArmed = options.staleSessionOnce === true;
  /** Set once the loopback server is listening; the handler runs only after that. */
  let origin = "";
  /** Every created connected account and the callback URL it was created with. */
  const created: Array<{
    id: string;
    callbackUrl: string;
    authConfigId: string;
  }> = [];

  const fixture = await startHttpFixture((request) => {
    const url = request.url;
    if (!url.pathname.startsWith(`${base}/`))
      return json(404, { error: "unknown_base_path" });
    // Every documented endpoint authenticates with the project API key header.
    if (request.headers["x-api-key"] !== options.apiKey)
      return json(401, { error: "invalid_api_key" });
    if (
      (request.method === "POST" || request.method === "PATCH") &&
      request.body.length &&
      !(request.headers["content-type"] ?? "").includes("application/json")
    )
      return badRequest("expected_json_body");
    const path = url.pathname.slice(base.length);
    const segments = path.split("/").filter(Boolean).map(decodeURIComponent);

    if (request.method === "GET" && path === "/toolkits")
      return json(200, page(toolkits));

    if (
      request.method === "GET" &&
      segments[0] === "toolkits" &&
      segments.length === 2
    ) {
      const toolkit = toolkits.find((item) => item.slug === segments[1]);
      return toolkit ? json(200, toolkit) : notFound();
    }

    if (request.method === "GET" && path === "/auth_configs") {
      const slugs = values(url, "toolkit_slug");
      return json(
        200,
        page(
          authConfigs.filter(
            (config) => !slugs.length || slugs.includes(config.toolkit.slug),
          ),
        ),
      );
    }

    if (request.method === "GET" && path === "/connected_accounts") {
      const userIds = values(url, "user_ids");
      const slugs = values(url, "toolkit_slugs");
      const configIds = values(url, "auth_config_ids");
      const statuses = values(url, "statuses");
      return json(
        200,
        page(
          accounts.filter(
            (account) =>
              (!userIds.length || userIds.includes(account.user_id)) &&
              (!slugs.length || slugs.includes(account.toolkit.slug)) &&
              (!configIds.length ||
                configIds.includes(account.auth_config.id)) &&
              (!statuses.length || statuses.includes(account.status)),
          ),
        ),
      );
    }

    if (request.method === "POST" && path === "/connected_accounts") {
      const body = readJson(request);
      const authConfig = body?.auth_config as { id?: unknown } | undefined;
      const connection = body?.connection as
        Record<string, unknown> | undefined;
      if (typeof authConfig?.id !== "string")
        return badRequest("auth_config.id is required");
      const config = authConfigs.find((item) => item.id === authConfig.id);
      if (!config) return notFound();
      if (typeof connection?.user_id !== "string" || !connection.user_id)
        return badRequest("connection.user_id is required");
      const state = connection.state as Record<string, unknown> | undefined;
      if (!state || typeof state.authScheme !== "string" || !state.val)
        return badRequest("connection.state.authScheme and val are required");
      const callbackUrl = connection.callback_url;
      if (typeof callbackUrl !== "string" || !URL.canParse(callbackUrl))
        return badRequest("connection.callback_url must be a URL");
      const id = `ca_${randomUUID().replaceAll("-", "").slice(0, 22)}`;
      accounts.push({
        id,
        user_id: connection.user_id,
        status: "INITIATED",
        toolkit: { slug: config.toolkit.slug },
        auth_config: { id: config.id, auth_scheme: config.auth_scheme },
      });
      created.push({ id, callbackUrl, authConfigId: config.id });
      const redirect = new URL(`${origin}/hosted/authorize`);
      redirect.searchParams.set("connected_account_id", id);
      const hosted = options.hostedRedirectUrl ?? redirect.toString();
      return json(201, {
        id,
        connectionData: { authScheme: config.auth_scheme, val: {} },
        status: "INITIATED",
        redirect_url: hosted,
        redirect_uri: hosted,
      });
    }

    if (segments[0] === "connected_accounts" && segments.length === 2) {
      const account = accounts.find((item) => item.id === segments[1]);
      if (request.method === "GET")
        return account ? json(200, account) : notFound();
      if (request.method === "DELETE") {
        if (!account) return notFound();
        account.status = "DELETED";
        return { status: 204 };
      }
    }

    if (request.method === "GET" && path === "/tools") {
      const slug = url.searchParams.get("toolkit_slug");
      return json(
        200,
        page(
          tools.filter(
            (tool) => !slug || (tool.toolkit?.slug ?? slug) === slug,
          ),
        ),
      );
    }

    if (
      request.method === "GET" &&
      segments[0] === "tools" &&
      segments.length === 2
    ) {
      const tool = tools.find((item) => item.slug === segments[1]);
      if (!tool) return notFound();
      // The documented `version` query parameter selects a served version. The
      // double answers with the tool's own `version` and `available_versions`
      // whatever was asked for, so the caller — not this double — is the one
      // that has to notice a pinned version the toolkit no longer serves.
      return json(200, tool);
    }

    if (
      request.method === "POST" &&
      segments[0] === "tools" &&
      segments[1] === "execute" &&
      segments.length === 3
    ) {
      const toolSlug = segments[2]!;
      const body = readJson(request);
      if (typeof body?.user_id !== "string")
        return badRequest("user_id is required");
      if (typeof body.connected_account_id !== "string")
        return badRequest("connected_account_id is required");
      const account = accounts.find(
        (item) => item.id === body.connected_account_id,
      );
      if (!account) return notFound();
      if (account.user_id !== body.user_id)
        return json(403, { error: "account_not_owned_by_user" });
      if (account.status !== "ACTIVE")
        return json(200, {
          data: {},
          error: "connected account is not ACTIVE",
          successful: false,
          log_id: `log_${randomUUID()}`,
        });
      const custom = options.execute?.({
        toolSlug,
        userId: body.user_id,
        connectedAccountId: body.connected_account_id,
        version: typeof body.version === "string" ? body.version : undefined,
        arguments:
          (body.arguments as Record<string, unknown> | undefined) ?? {},
      });
      if (custom?.status && custom.status !== 200)
        return json(custom.status, { error: custom.error ?? "failed" });
      return json(200, {
        data: custom?.data ?? { ok: true, tool: toolSlug },
        error: custom?.error ?? null,
        successful: custom?.successful ?? true,
        session_info: null,
        log_id: `log_${randomUUID()}`,
      });
    }

    if (request.method === "POST" && path === "/tool_router/session") {
      const body = readJson(request);
      if (typeof body?.user_id !== "string")
        return badRequest("user_id is required");
      const requested = Array.isArray(body.toolkits)
        ? body.toolkits.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      const sessionId = `trs_${randomUUID().replaceAll("-", "")}`;
      sessions.set(sessionId, {
        userId: body.user_id,
        toolkits: requested,
        accounts:
          (body.connected_accounts as Record<string, string> | undefined) ?? {},
      });
      const advertised =
        options.sessionToolRouterTools ??
        tools
          .filter((tool) => requested.includes(tool.toolkit?.slug ?? ""))
          .map((tool) => tool.slug);
      return json(201, {
        session_id: sessionId,
        mcp: { type: "http", url: `${origin}/mcp/${sessionId}` },
        tool_router_tools: advertised,
        config: { user_id: body.user_id },
        config_version: 1,
        warnings: [],
      });
    }

    if (
      request.method === "POST" &&
      segments[0] === "tool_router" &&
      segments[1] === "session" &&
      segments.length === 4 &&
      (segments[3] === "execute" || segments[3] === "execute_meta")
    ) {
      const sessionId = segments[2]!;
      if (staleSessionArmed) {
        staleSessionArmed = false;
        return json(404, { error: "session_not_found" });
      }
      const session = sessions.get(sessionId);
      if (!session) return notFound();
      const body = readJson(request);
      if (typeof body?.tool_slug !== "string")
        return badRequest("tool_slug is required");
      const custom = options.execute?.({
        toolSlug: body.tool_slug,
        userId: session.userId,
        connectedAccountId:
          typeof body.account === "string" ? body.account : "",
        version: undefined,
        arguments:
          (body.arguments as Record<string, unknown> | undefined) ?? {},
      });
      if (custom?.status && custom.status !== 200)
        return json(custom.status, { error: custom.error ?? "failed" });
      return json(200, {
        data: custom?.data ?? { ok: true, tool: body.tool_slug },
        error: custom?.error ?? null,
        log_id: `log_${randomUUID()}`,
      });
    }

    return notFound();
  });

  origin = fixture.origin;

  return {
    origin: fixture.origin,
    base,
    requests: fixture.requests,
    received: fixture.received,
    accounts,
    authConfigs,
    tools,
    toolkits,
    created,
    sessions,
    /** The account a hosted authorization created, as Composio would after the user finished. */
    setStatus(accountId: string, status: string) {
      const account = accounts.find((item) => item.id === accountId);
      if (!account) throw new Error(`unknown account ${accountId}`);
      account.status = status;
    },
    addAccount(account: DoubleAccount) {
      accounts.push(account);
      return account;
    },
    async close() {
      await fixture.close();
    },
  };
}

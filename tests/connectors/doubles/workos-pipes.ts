import { randomUUID } from "node:crypto";
import {
  startHttpFixture,
  type FixtureReply,
  type RecordedRequest,
} from "./http-fixture.js";

/*
 * An independent WorkOS Pipes double.
 *
 * It is written from the published contract, not from the adapter: the request
 * assertions below (method, path, `Authorization: Bearer`, JSON body fields,
 * relay control headers) are what the documentation says WorkOS receives, and
 * the responses are the documented shapes. If the adapter stops sending what
 * the docs describe, this fixture answers with the documented error instead of
 * quietly agreeing with it.
 *
 * Contract sources, retrieved 2026-09-18:
 *   https://workos.com/docs/reference/pipes           — POST /data-integrations/{slug}/token,
 *                                                       POST /data-integrations/{slug}/credentials
 *   https://workos.com/docs/reference/pipes/connected-account
 *                                                     — POST /data-integrations/{slug}/authorize,
 *                                                       GET/DELETE …/connected_accounts/{slug}
 *   https://workos.com/docs/reference/pipes/provider  — GET …/data_providers
 *   https://workos.com/docs/pipes/relay               — https://api.workos.com/relay, X-Relay-*,
 *                                                       402 relay_authorization_required,
 *                                                       X-Relay-Upstream-Status
 */

export type WorkOsAccountState = "connected" | "needs_reauthorization";

export type WorkOsConnectionSeed = {
  /** Provider slug, e.g. "github". */
  provider: string;
  userId: string;
  organizationId?: string;
  /** Which connection this is: the user's own, or the organization's shared one. */
  owner?: "user" | "organization";
  state?: WorkOsAccountState;
  scopes?: string[];
  missingScopes?: string[];
  accountIdentifier?: string;
  accountDisplayName?: string;
  accessToken?: string;
  /** ISO 8601; omitted means the documented "no expiry" case. */
  expiresAt?: string;
  authMethod?: "oauth" | "api_key" | "client_credentials";
};

type Connection = WorkOsConnectionSeed & {
  id: string;
  owner: "user" | "organization";
  state: WorkOsAccountState;
};

export type WorkOsUpstreamHandler = (input: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
  /** The credential relay injected on the caller's behalf; the client never sees it. */
  injectedToken: string | undefined;
  connection: Connection | undefined;
}) => {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
};

export type WorkOsPipesDoubleOptions = {
  apiKey: string;
  connections?: WorkOsConnectionSeed[];
  /** Providers the environment has configured, for the data-providers listing. */
  providers?: Array<{
    slug: string;
    name: string;
    description?: string;
    connectionOwner?: "user" | "organization";
  }>;
  /** Users the environment knows; an unknown X-Relay-User is a documented 400. */
  knownUsers?: string[];
  /** What the relay's upstream answers once a credential was resolved. */
  upstream?: WorkOsUpstreamHandler;
  /** An authorization_url for the 402 body; `null` reproduces the documented API-key case. */
  authorizationUrl?: string | null;
  /** Force `/token` and `/credentials` to report the documented inactive reasons. */
  inactive?: Record<string, "not_installed" | "needs_reauthorization" | "account_selection_required">;
};

const json = (status: number, body: unknown): FixtureReply => ({
  status,
  body: body as Record<string, unknown>,
});

function key(
  provider: string,
  owner: "user" | "organization",
  userId: string,
  organizationId: string | undefined,
): string {
  return owner === "organization"
    ? `org:${organizationId}:${provider}`
    : `user:${userId}:${organizationId ?? ""}:${provider}`;
}

export async function startWorkOsPipesDouble(
  options: WorkOsPipesDoubleOptions,
) {
  const connections = new Map<string, Connection>();
  const knownUsers = new Set(options.knownUsers ?? []);
  for (const seed of options.connections ?? []) {
    const owner = seed.owner ?? "user";
    const connection: Connection = {
      ...seed,
      owner,
      id: `data_installation_${randomUUID().replace(/-/g, "").slice(0, 26)}`,
      state: seed.state ?? "connected",
    };
    connections.set(
      key(seed.provider, owner, seed.userId, seed.organizationId),
      connection,
    );
    knownUsers.add(seed.userId);
  }
  /** Authorization links this double handed out, keyed by the opaque id in the URL. */
  const authorizations = new Map<
    string,
    { provider: string; userId: string; organizationId?: string; owner: string; returnTo?: string }
  >();

  const accountBody = (connection: Connection) => ({
    object: "connected_account",
    id: connection.id,
    user_id: connection.owner === "organization" ? null : connection.userId,
    organization_id: connection.organizationId ?? null,
    connection_role: "compatibility",
    account_identifier: connection.accountIdentifier ?? null,
    account_display_name: connection.accountDisplayName ?? null,
    scopes: connection.scopes ?? [],
    auth_method: connection.authMethod ?? "oauth",
    api_key_last_4: null,
    state: connection.state,
    created_at: "2026-01-16T14:20:00.000Z",
    updated_at: "2026-01-16T14:20:00.000Z",
  });

  const fixture = await startHttpFixture((request: RecordedRequest): FixtureReply => {
    const path = request.url.pathname;
    const authorization = request.headers.authorization ?? "";
    // Every documented Pipes call authenticates with the environment API key.
    if (authorization !== `Bearer ${options.apiKey}`)
      return json(401, {
        code: "unauthorized",
        message: "Invalid API key",
      });
    const bodyText = request.body.toString("utf8");
    let body: Record<string, unknown> = {};
    if (bodyText) {
      try {
        body = JSON.parse(bodyText) as Record<string, unknown>;
      } catch {
        return json(400, { code: "invalid_body" });
      }
    }

    /* ------------------------------------------------ authorization URL */
    const authorize = /^\/data-integrations\/([^/]+)\/authorize$/.exec(path);
    if (authorize && request.method === "POST") {
      const provider = decodeURIComponent(authorize[1]!);
      const userId = body.user_id;
      if (typeof userId !== "string" || !userId)
        return json(422, { code: "user_id_required" });
      const owner = typeof body.connection_owner === "string" ? body.connection_owner : "user";
      if (owner === "organization" && typeof body.organization_id !== "string")
        return json(422, { code: "organization_id_required" });
      const id = randomUUID().replace(/-/g, "").slice(0, 24);
      authorizations.set(id, {
        provider,
        userId,
        owner,
        ...(typeof body.organization_id === "string"
          ? { organizationId: body.organization_id }
          : {}),
        ...(typeof body.return_to === "string" ? { returnTo: body.return_to } : {}),
      });
      return json(200, {
        url: `${fixture.origin}/data-integrations/${id}/authorize-redirect`,
      });
    }

    /* ------------------------------------------------- connected account */
    const userAccount =
      /^\/user_management\/users\/([^/]+)\/connected_accounts\/([^/]+)$/.exec(
        path,
      );
    const orgAccount =
      /^\/organizations\/([^/]+)\/connected_accounts\/([^/]+)$/.exec(path);
    if (userAccount || orgAccount) {
      const owner = orgAccount ? "organization" : "user";
      const provider = decodeURIComponent(
        (orgAccount ?? userAccount)![2]!,
      );
      const principal = decodeURIComponent((orgAccount ?? userAccount)![1]!);
      const organizationId = orgAccount
        ? principal
        : (request.url.searchParams.get("organization_id") ?? undefined);
      const lookup = key(
        provider,
        owner,
        orgAccount ? "" : principal,
        organizationId,
      );
      const connection = connections.get(lookup);
      if (request.method === "GET") {
        if (!connection)
          return json(404, { code: "not_found", message: "No connected account" });
        return json(200, accountBody(connection));
      }
      if (request.method === "DELETE") {
        if (!connection) return json(404, { code: "not_found" });
        connections.delete(lookup);
        return { status: 204 };
      }
      return json(405, { code: "method_not_allowed" });
    }

    /* ----------------------------------------------- token / credentials */
    const vend = /^\/data-integrations\/([^/]+)\/(token|credentials)$/.exec(path);
    if (vend && request.method === "POST") {
      const provider = decodeURIComponent(vend[1]!);
      const kind = vend[2]!;
      const userId = body.user_id;
      if (typeof userId !== "string" || !userId)
        return json(422, { code: "user_id_required" });
      const owner =
        typeof body.connection_owner === "string" ? body.connection_owner : "user";
      const organizationId =
        typeof body.organization_id === "string" ? body.organization_id : undefined;
      if (owner === "organization" && !organizationId)
        return json(422, { code: "organization_id_required" });
      const forced = options.inactive?.[provider];
      if (forced) return json(200, { active: false, error: forced });
      const connection = connections.get(
        key(provider, owner as "user" | "organization", userId, organizationId),
      );
      if (!connection) return json(200, { active: false, error: "not_installed" });
      if (connection.state === "needs_reauthorization")
        return json(200, { active: false, error: "needs_reauthorization" });
      const shared = {
        expires_at: connection.expiresAt ?? null,
        scopes: connection.scopes ?? [],
        missing_scopes: connection.missingScopes ?? [],
      };
      return kind === "token"
        ? json(200, {
            active: true,
            access_token: {
              object: "access_token",
              access_token: connection.accessToken ?? "gho_fixture_token",
              ...shared,
            },
          })
        : json(200, {
            active: true,
            credential: {
              object: "credential",
              auth_method: connection.authMethod ?? "oauth",
              value: connection.accessToken ?? "gho_fixture_token",
              ...shared,
            },
          });
    }

    /* ------------------------------------------------------ data providers */
    const userProviders =
      /^\/user_management\/users\/([^/]+)\/data_providers$/.exec(path);
    const orgProviders = /^\/organizations\/([^/]+)\/data_providers$/.exec(path);
    if ((userProviders || orgProviders) && request.method === "GET") {
      const owner = orgProviders ? "organization" : "user";
      const principal = decodeURIComponent(
        (orgProviders ?? userProviders)![1]!,
      );
      const organizationId = orgProviders
        ? principal
        : (request.url.searchParams.get("organization_id") ?? undefined);
      return json(200, {
        object: "list",
        data: (options.providers ?? []).map((provider) => {
          const connection = connections.get(
            key(
              provider.slug,
              owner,
              orgProviders ? "" : principal,
              organizationId,
            ),
          );
          return {
            object: "data_provider",
            id: `data_integration_${provider.slug}`,
            name: provider.name,
            description: provider.description ?? null,
            slug: provider.slug,
            integration_type: provider.slug,
            credentials_type: "oauth2",
            auth_methods: ["oauth"],
            connection_owner: provider.connectionOwner ?? "user",
            created_at: "2026-01-15T10:30:00.000Z",
            updated_at: "2026-01-15T10:30:00.000Z",
            connected_account: connection ? accountBody(connection) : null,
          };
        }),
      });
    }

    /* --------------------------------------------------------------- relay */
    if (path === "/relay" || path.startsWith("/relay/")) {
      const relayUser = request.headers["x-relay-user"];
      const relayOrganization = request.headers["x-relay-organization"];
      const relayUrl = request.headers["x-relay-url"];
      const headerProvider = request.headers["x-relay-provider"];
      if (!relayUser)
        return json(400, {
          code: "relay_user_required",
          message: "The X-Relay-User header is absent.",
        });
      if (knownUsers.size && !knownUsers.has(relayUser))
        return json(400, {
          code: "relay_user_not_found",
          message: "No user with that ID exists in this environment.",
        });
      let slug: string | undefined;
      let upstream: URL | undefined;
      if (path === "/relay") {
        if (!relayUrl)
          return json(400, {
            code: "relay_missing_url",
            message: "X-Relay-URL is required for URL routing.",
          });
        if (!URL.canParse(relayUrl))
          return json(400, {
            code: "relay_invalid_url",
            message: "X-Relay-URL is not a valid URL.",
          });
        upstream = new URL(relayUrl);
        slug = headerProvider;
      } else {
        const segments = path.slice("/relay/".length).split("/");
        slug = decodeURIComponent(segments.shift() ?? "");
        upstream = new URL(
          `https://api.${slug}.example/${segments.join("/")}${request.url.search}`,
        );
        if (headerProvider && headerProvider !== slug)
          return json(400, {
            code: "relay_provider_conflict",
            message: "The path slug and X-Relay-Provider name different providers.",
          });
      }
      if (!slug)
        return json(404, {
          code: "relay_provider_not_found",
          message: "No provider resolved for this request.",
        });
      // Documented exact-match rule: the organization header is present for an
      // organization-scoped connection and absent otherwise; either mismatch
      // is the same 402 as never having connected.
      const candidate =
        connections.get(
          key(slug, "user", relayUser, relayOrganization ?? undefined),
        ) ??
        (relayOrganization
          ? connections.get(key(slug, "organization", relayUser, relayOrganization))
          : undefined);
      const usable =
        candidate &&
        candidate.state === "connected" &&
        (candidate.owner === "organization"
          ? candidate.organizationId === relayOrganization
          : (candidate.organizationId ?? undefined) ===
            (relayOrganization ?? undefined));
      if (!usable)
        return json(402, {
          code: "relay_authorization_required",
          connection: slug,
          message: `User has not authorized provider "${slug}"`,
          authorization_url:
            options.authorizationUrl === undefined
              ? `${fixture.origin}/oauth/authorize?provider=${encodeURIComponent(slug)}`
              : options.authorizationUrl,
        });
      const forwarded: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        const lower = name.toLowerCase();
        // Relay strips its own control headers, the API key, cookies and
        // forwarding metadata before calling the provider.
        if (
          lower === "authorization" ||
          lower === "cookie" ||
          lower === "connection" ||
          lower === "host" ||
          lower === "via" ||
          lower.startsWith("x-relay-") ||
          lower.startsWith("x-workos-") ||
          lower.startsWith("x-forwarded-")
        )
          continue;
        forwarded[lower] = value;
      }
      const respond: WorkOsUpstreamHandler =
        options.upstream ?? (() => ({ status: 200, body: { ok: true } }));
      const answer = respond({
        method: request.method,
        url: upstream,
        headers: forwarded,
        body: bodyText,
        injectedToken: candidate!.accessToken ?? "gho_fixture_token",
        connection: candidate,
      });
      return {
        status: answer.status,
        headers: {
          ...(answer.headers ?? {}),
          "x-relay-upstream-status": String(answer.status),
        },
        body: answer.body ?? {},
      };
    }

    return json(404, { code: "not_found" });
  });

  return {
    origin: fixture.origin,
    requests: fixture.requests,
    received: fixture.received,
    close: fixture.close,
    /** Completes an authorization the way the provider's redirect would. */
    completeAuthorization(
      provider: string,
      seed: Omit<WorkOsConnectionSeed, "provider">,
    ) {
      const owner = seed.owner ?? "user";
      const connection: Connection = {
        ...seed,
        provider,
        owner,
        id: `data_installation_${randomUUID().replace(/-/g, "").slice(0, 26)}`,
        state: seed.state ?? "connected",
      };
      connections.set(
        key(provider, owner, seed.userId, seed.organizationId),
        connection,
      );
      knownUsers.add(seed.userId);
      return connection.id;
    },
    /** Marks an existing connection as needing reauthorization. */
    expire(
      provider: string,
      seed: { userId: string; organizationId?: string; owner?: "user" | "organization" },
    ) {
      const lookup = key(
        provider,
        seed.owner ?? "user",
        seed.userId,
        seed.organizationId,
      );
      const connection = connections.get(lookup);
      if (connection) connection.state = "needs_reauthorization";
    },
    connection(
      provider: string,
      seed: { userId: string; organizationId?: string; owner?: "user" | "organization" },
    ) {
      return connections.get(
        key(provider, seed.owner ?? "user", seed.userId, seed.organizationId),
      );
    },
    /** Authorization links this double issued, for assertions about the return route. */
    authorizations: () => [...authorizations.values()],
  };
}

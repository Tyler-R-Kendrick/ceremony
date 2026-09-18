import { createHash, randomBytes, randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { startHttpFixture, type RecordedRequest } from "./http-fixture.js";

/*
 * An independent Vercel Connect API double.
 *
 * Written from the published contract, not from the adapter: the REST
 * reference pages for the Connect group, the machine-readable OpenAPI
 * document served at https://openapi.vercel.sh (retrieved 2026-09-18), the
 * Connect concept pages (connectors, installations, project links, tokens,
 * authentication, triggers) and the generic REST error page. It imports
 * nothing from `src/server/connectors/providers/vercel`, so a test that
 * passes here is a statement about the wire, not about one implementation
 * talking to itself.
 *
 * What it asserts on every request:
 *   - the exact path *and its version prefix* (v1 vs v2 differ per operation),
 *   - the method,
 *   - `Authorization: Bearer <token>` and, for bodies, a JSON content type,
 *   - `teamId` present exactly once on team-scoped operations and absent on
 *     the authorization and token endpoints, whose team comes from the
 *     credential,
 *   - the connector path segment percent-encoded exactly once
 *     (`slack/acme` travels as `slack%2Facme`),
 *   - the documented JSON body fields, rejecting unknown ones.
 *
 * Anything else answers with the documented error envelope
 * `{"error":{"code","message"}}` and the status the reference lists.
 *
 * Two behaviours are *modelled* rather than quoted, and both are marked
 * `modelled:` in the code: which credential class each endpoint accepts
 * (the docs describe the rule in prose - project links and RBAC - but
 * publish no wire-level discriminator), and the error codes that stand behind
 * the SDK's typed error classes. Both are recorded in the ledger.
 */

export type ConnectorSeed = {
  uid: string;
  id?: string;
  type?: string;
  typeName?: string;
  service?: string;
  displayName?: string;
  name?: string;
  /** Installation-aware types hold one grant per tenant; installation-free ones reach a single account. */
  supportsInstallation?: boolean;
  supportsRevocation?: boolean;
  supportsTriggers?: boolean;
  supportedSubjectTypes?: string[];
  defaultInstallationId?: string;
  installations?: string[];
  scopes?: string[];
  /** Project id to the environments enabled by the project link. */
  projects?: Record<string, string[]>;
  triggerDestinations?: Array<Record<string, unknown>>;
  triggersEnabled?: boolean;
  /** Provider-side tenant the double reports on a token response, when it knows one. */
  tenantId?: string;
  /** Some providers expose no account identity at all; then `externalSubject` stays absent. */
  reportsExternalSubject?: boolean;
};

export type CredentialSeed = {
  token: string;
  /** `management`: a team access token. `workload`: a deployment OIDC token. */
  kind: "management" | "workload";
  teamId: string;
  /** Workload credentials carry the deployment's project and environment. */
  projectId?: string;
  environment?: string;
  /** Team roles the double checks before a mutating management call. */
  canAdminister?: boolean;
};

export type VercelConnectFixtureOptions = {
  teamId?: string;
  connectors?: ConnectorSeed[];
  credentials?: CredentialSeed[];
  now?: () => number;
  /** Page size the list endpoints use when the caller names no limit. */
  pageSize?: number;
  authorizationLifetimeMs?: number;
  tokenLifetimeMs?: number;
};

export type ObservedCall = {
  method: string;
  path: string;
  version: "v1" | "v2" | "none";
  query: Record<string, string[]>;
  headers: Record<string, string>;
  body: unknown;
  status: number;
  /** The route the double matched, or "unmatched". */
  route: string;
};

type Authorization = {
  request: string;
  connectorUid: string;
  subjectKey: string;
  subject: Record<string, unknown>;
  scopes: string[];
  installationId?: string;
  expiresAt: number;
  state: "pending" | "approved" | "denied";
  verifier: string;
  returnUrl?: string;
  deviceCode?: string;
};

type Grant = {
  connectorUid: string;
  subjectKey: string;
  scopes: string[];
  installationId?: string;
  externalSubject?: string;
  authorizationId: string;
};

type StoredConnector = ConnectorSeed & {
  id: string;
  createdAt: number;
  updatedAt: number;
  projects: Record<string, string[]>;
  installations: string[];
  triggerDestinations: Array<Record<string, unknown>>;
};

/** The documented generic error envelope (docs/rest-api/errors). */
const errorBody = (code: string, message: string) => ({
  error: { code, message },
});

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** Path segments arrive percent-encoded once; `slack%2Facme` decodes to `slack/acme`. */
const decodeSegment = (segment: string): string => decodeURIComponent(segment);

/** The grant key separator; never part of a connector uid or a subject id. */
const SEPARATOR = "|#|";

function subjectKeyOf(subject: unknown): string | undefined {
  if (!isPlainObject(subject) || typeof subject["type"] !== "string")
    return undefined;
  const type = subject["type"];
  if (type === "app") return "app";
  if (type === "user")
    return typeof subject["id"] === "string"
      ? `user:${subject["id"]}`
      : undefined;
  if (type === "jwt-bearer")
    return typeof subject["sub"] === "string"
      ? `jwt-bearer:${subject["sub"]}`
      : undefined;
  return undefined;
}

/** Fields the Connect token and authorize request bodies document; anything else is rejected. */
const tokenBodyFields = new Set([
  "subject",
  "installationId",
  "audience",
  "scopes",
  "resources",
  "authorizationDetails",
  "validityBufferMs",
]);
const authorizeBodyFields = new Set([
  ...tokenBodyFields,
  "returnUrl",
  "webhook",
  "prompt",
  "deviceCode",
  "expiresInMs",
  "additionalParams",
]);

export async function startVercelConnect(
  options: VercelConnectFixtureOptions = {},
) {
  const teamId = options.teamId ?? "team_fixture";
  const now = options.now ?? Date.now;
  const pageSize = options.pageSize ?? 20;
  const authorizationLifetimeMs = options.authorizationLifetimeMs ?? 600_000;
  const tokenLifetimeMs = options.tokenLifetimeMs ?? 3_600_000;
  const calls: ObservedCall[] = [];
  const violations: string[] = [];
  const note = (message: string) => violations.push(message);

  const connectors = new Map<string, StoredConnector>();
  for (const seed of options.connectors ?? [])
    connectors.set(seed.uid, {
      ...seed,
      id:
        seed.id ??
        `scl_${createHash("sha1").update(seed.uid).digest("hex").slice(0, 16)}`,
      createdAt: now() - 86_400_000,
      updatedAt: now() - 3_600_000,
      projects: { ...(seed.projects ?? {}) },
      installations: [...(seed.installations ?? [])],
      triggerDestinations: [...(seed.triggerDestinations ?? [])],
    });
  const credentials = new Map<string, CredentialSeed>();
  for (const seed of options.credentials ?? [])
    credentials.set(seed.token, seed);

  const authorizations = new Map<string, Authorization>();
  const grants = new Map<string, Grant>();
  const issuedTokens: Array<{
    tokenId: string;
    token: string;
    connectorUid: string;
    subjectKey: string;
    expiresAt: number;
  }> = [];
  const grantKey = (
    connectorUid: string,
    subjectKey: string,
    installationId?: string,
  ) =>
    [connectorUid, subjectKey, installationId ?? ""].join(SEPARATOR);

  const connectorByPathSegment = (segment: string) => {
    const decoded = decodeSegment(segment);
    for (const connector of connectors.values())
      if (connector.uid === decoded || connector.id === decoded)
        return connector;
    return undefined;
  };

  type Reply = { status: number; body?: Record<string, unknown> };

  const connectorView = (connector: StoredConnector) => ({
    id: connector.id,
    uid: connector.uid,
    name: connector.name ?? connector.uid,
    displayName: connector.displayName ?? connector.name ?? connector.uid,
    type: connector.type ?? "oauth",
    typeName: connector.typeName ?? "Custom OAuth",
    service: connector.service ?? "example.com",
    supportedSubjectTypes: connector.supportedSubjectTypes ?? ["app", "user"],
    supportsInstallation: connector.supportsInstallation ?? false,
    supportsRevocation: connector.supportsRevocation ?? false,
    supportsTriggers: connector.supportsTriggers ?? false,
    supportsIcon: false,
    createdAt: connector.createdAt,
    updatedAt: connector.updatedAt,
    ...(connector.defaultInstallationId !== undefined
      ? { defaultInstallationId: connector.defaultInstallationId }
      : {}),
    ...(connector.triggersEnabled !== undefined
      ? { triggers: { enabled: connector.triggersEnabled } }
      : {}),
    ...(connector.triggerDestinations.length
      ? { triggerDestinations: connector.triggerDestinations }
      : {}),
  });

  const projectConnectionView = (
    connector: StoredConnector,
    projectId: string,
  ) => ({
    connectorId: connector.id,
    createdAt: connector.createdAt,
    updatedAt: connector.updatedAt,
    enabledEnvironments: [...(connector.projects[projectId] ?? [])],
    project: {
      id: projectId,
      name: `project-${projectId}`,
      customEnvironments: [],
    },
  });

  const paginate = <T>(
    items: T[],
    query: URLSearchParams,
  ): { page: T[]; next: string | null } => {
    const limit = Math.min(
      Number(query.get("limit") ?? pageSize) || pageSize,
      100,
    );
    const cursor = query.get("cursor");
    const start = cursor
      ? Number(Buffer.from(cursor, "base64url").toString("utf8"))
      : 0;
    const page = items.slice(start, start + limit);
    const nextIndex = start + limit;
    return {
      page,
      next:
        nextIndex < items.length
          ? Buffer.from(String(nextIndex), "utf8").toString("base64url")
          : null,
    };
  };

  const server = await startHttpFixture((request) => {
    const segments = request.url.pathname.split("/").filter(Boolean);
    const version =
      segments[0] === "v1" ? "v1" : segments[0] === "v2" ? "v2" : "none";
    const query: Record<string, string[]> = {};
    for (const key of new Set(request.url.searchParams.keys()))
      query[key] = request.url.searchParams.getAll(key);
    let route = "unmatched";
    let parsedBody: unknown = undefined;
    const record = (status: number) => {
      calls.push({
        method: request.method,
        path: request.url.pathname,
        version,
        query,
        headers: request.headers,
        body: parsedBody,
        status,
        route,
      });
    };
    const reply = (status: number, body?: Record<string, unknown>): Reply => {
      record(status);
      return body === undefined ? { status } : { status, body };
    };
    const failure = (status: number, code: string, message: string): Reply =>
      reply(status, errorBody(code, message));

    // --- transport-level checks every Connect request must satisfy ---------
    const authorization = request.headers["authorization"] ?? "";
    const bearer = /^Bearer (\S+)$/.exec(authorization)?.[1];
    if (request.body.length) {
      const contentType = request.headers["content-type"] ?? "";
      if (!/^application\/json\b/.test(contentType)) {
        note(
          `${request.method} ${request.url.pathname}: body without a JSON content type`,
        );
        return failure(400, "bad_request", "Expected application/json");
      }
      try {
        parsedBody = JSON.parse(request.body.toString("utf8"));
      } catch {
        return failure(400, "bad_request", "Body is not valid JSON");
      }
    }
    if (!bearer) return failure(401, "forbidden", "Not authorized");
    const credential = credentials.get(bearer);
    if (!credential || credential.teamId !== teamId)
      return failure(401, "forbidden", "Not authorized");

    const teamQuery = request.url.searchParams.getAll("teamId");
    const slugQuery = request.url.searchParams.getAll("slug");
    const requireTeamScope = (): Reply | undefined => {
      if (teamQuery.length > 1 || slugQuery.length > 1)
        return failure(400, "bad_request", "Duplicate team scope");
      if (teamQuery.length && slugQuery.length)
        return failure(400, "bad_request", "Send teamId or slug, not both");
      const named = teamQuery[0] ?? slugQuery[0];
      // The parameter description: "The request returns 401 if no team can be
      // selected." This double has no default team for a token.
      if (!named) return failure(401, "forbidden", "Not authorized");
      if (named !== teamId) return failure(403, "forbidden", "Not authorized");
      return undefined;
    };
    // modelled: dashboard/CLI/team tokens administer; deployment OIDC tokens
    // request runtime tokens. The docs describe this split as RBAC plus
    // project links rather than as a wire field.
    const requireManagement = (mutating: boolean): Reply | undefined => {
      if (credential.kind !== "management")
        return failure(
          403,
          "forbidden",
          "This credential cannot manage connectors",
        );
      if (mutating && credential.canAdminister === false)
        return failure(403, "forbidden", "Not authorized");
      return undefined;
    };
    const requireWorkload = (): Reply | undefined => {
      if (credential.kind !== "workload")
        return failure(
          403,
          "client_not_linked_to_project",
          "The calling project is not linked to this connector",
        );
      if (teamQuery.length || slugQuery.length) {
        note(
          `${request.method} ${request.url.pathname}: team scope query on a credential-scoped endpoint`,
        );
        return failure(400, "bad_request", "Unexpected team scope");
      }
      return undefined;
    };
    const requireLink = (connector: StoredConnector): Reply | undefined => {
      const environments = connector.projects[credential.projectId ?? ""];
      if (!environments)
        return failure(
          403,
          "client_not_linked_to_project",
          "The calling project is not linked to this connector",
        );
      if (!environments.includes(credential.environment ?? ""))
        return failure(
          403,
          "client_not_enabled_for_environment",
          "The project link does not include this environment",
        );
      return undefined;
    };

    // --- routes -----------------------------------------------------------
    // GET /v2/connect/connectors
    if (
      request.method === "GET" &&
      version === "v2" &&
      segments.length === 3 &&
      segments[1] === "connect" &&
      segments[2] === "connectors"
    ) {
      route = "connect.connectors.list";
      const denied = requireTeamScope() ?? requireManagement(false);
      if (denied) return denied;
      const search = request.url.searchParams.get("search");
      const projectId = request.url.searchParams.get("projectId");
      const all = [...connectors.values()].filter(
        (connector) =>
          (!projectId || connector.projects[projectId] !== undefined) &&
          (!search ||
            connector.uid.includes(search) ||
            (connector.service ?? "").includes(search)),
      );
      const { page, next } = paginate(all, request.url.searchParams);
      return reply(200, {
        connectors: page.map(connectorView),
        pagination: { next },
      });
    }

    // POST /v1/connect/connectors
    if (
      request.method === "POST" &&
      version === "v1" &&
      segments.length === 3 &&
      segments[1] === "connect" &&
      segments[2] === "connectors"
    ) {
      route = "connect.connectors.create";
      const denied = requireTeamScope() ?? requireManagement(true);
      if (denied) return denied;
      const body = isPlainObject(parsedBody) ? parsedBody : undefined;
      if (!body || !isPlainObject(body["data"]))
        return failure(400, "bad_request", "data is required");
      if (
        typeof body["type"] !== "string" &&
        !(
          typeof body["service"] === "string" &&
          typeof body["connectionMethod"] === "string"
        )
      )
        return failure(
          400,
          "bad_request",
          "Provide type, or service with connectionMethod",
        );
      const uid =
        typeof body["uid"] === "string"
          ? body["uid"]
          : `oauth/${randomUUID().slice(0, 8)}`;
      if (connectors.has(uid))
        return failure(409, "conflict", "A connector with that uid exists");
      const environments = isStringArray(body["environments"])
        ? body["environments"]
        : ["development", "preview", "production"];
      const created: StoredConnector = {
        uid,
        id: `scl_${createHash("sha1").update(uid).digest("hex").slice(0, 16)}`,
        type: typeof body["type"] === "string" ? body["type"] : "oauth",
        typeName: "Custom OAuth",
        service:
          typeof body["service"] === "string" ? body["service"] : "example.com",
        name: typeof body["name"] === "string" ? body["name"] : uid,
        displayName: typeof body["name"] === "string" ? body["name"] : uid,
        supportsInstallation: false,
        supportsRevocation: false,
        supportsTriggers: body["triggers"] === true,
        triggersEnabled: body["triggers"] === true,
        supportedSubjectTypes: ["app", "user"],
        createdAt: now(),
        updatedAt: now(),
        projects:
          typeof body["projectId"] === "string"
            ? { [body["projectId"]]: environments }
            : {},
        installations: [],
        triggerDestinations: [],
      };
      connectors.set(uid, created);
      return reply(201, connectorView(created));
    }

    // /v1/connect/connectors/{connector}  (GET, DELETE)
    // /v2/connect/connectors/{connector}  (PATCH)
    if (
      segments.length === 4 &&
      segments[1] === "connect" &&
      segments[2] === "connectors" &&
      (request.method === "GET" ||
        request.method === "DELETE" ||
        request.method === "PATCH")
    ) {
      const expected = request.method === "PATCH" ? "v2" : "v1";
      if (version !== expected) {
        route = "version-mismatch";
        note(
          `${request.method} ${request.url.pathname}: this operation is published under /${expected}`,
        );
        return failure(404, "not_found", "Could not find the endpoint");
      }
      const connector = connectorByPathSegment(segments[3] ?? "");
      if (request.method === "GET") {
        route = "connect.connectors.get";
        const denied = requireTeamScope() ?? requireManagement(false);
        if (denied) return denied;
        if (!connector)
          return failure(404, "not_found", "Could not find the connector");
        return reply(200, connectorView(connector));
      }
      if (request.method === "DELETE") {
        route = "connect.connectors.delete";
        const denied = requireTeamScope() ?? requireManagement(true);
        if (denied) return denied;
        if (!connector)
          return failure(404, "not_found", "Could not find the connector");
        connectors.delete(connector.uid);
        for (const [key, grant] of grants)
          if (grant.connectorUid === connector.uid) grants.delete(key);
        return reply(204);
      }
      route = "connect.connectors.update";
      const denied = requireTeamScope() ?? requireManagement(true);
      if (denied) return denied;
      if (!connector)
        return failure(404, "not_found", "Could not find the connector");
      const body = isPlainObject(parsedBody) ? parsedBody : undefined;
      if (!body || Object.keys(body).length === 0)
        return failure(400, "bad_request", "Nothing to update");
      const allowed = new Set([
        "triggers",
        "events",
        "data",
        "icon",
        "backgroundColor",
        "accentColor",
        "uid",
        "name",
      ]);
      for (const key of Object.keys(body))
        if (!allowed.has(key))
          return failure(400, "bad_request", `Unknown field ${key}`);
      if (typeof body["name"] === "string") {
        connector.name = body["name"];
        connector.displayName = body["name"];
      }
      if (typeof body["triggers"] === "boolean")
        connector.triggersEnabled = body["triggers"];
      connector.updatedAt = now();
      const data = body["data"];
      const widened =
        isPlainObject(data) && isPlainObject(data["userAuthorization"]);
      return reply(200, {
        connector: connectorView(connector),
        ...(widened ? { reconsentNeeded: { scope: "user" } } : {}),
        serviceSync: { status: "done" },
      });
    }

    // /v1/connect/connectors/{connector}/projects/{projectId}
    if (
      segments.length === 6 &&
      segments[1] === "connect" &&
      segments[2] === "connectors" &&
      segments[4] === "projects"
    ) {
      if (version !== "v1") {
        route = "version-mismatch";
        note(
          `${request.method} ${request.url.pathname}: project links are published under /v1`,
        );
        return failure(404, "not_found", "Could not find the endpoint");
      }
      const connector = connectorByPathSegment(segments[3] ?? "");
      const projectId = decodeSegment(segments[5] ?? "");
      const mutating = request.method !== "GET";
      route =
        request.method === "POST"
          ? "connect.projects.link"
          : request.method === "GET"
            ? "connect.projects.get"
            : "connect.projects.unlink";
      const denied = requireTeamScope() ?? requireManagement(mutating);
      if (denied) return denied;
      if (!connector)
        return failure(404, "not_found", "Could not find the connector");
      if (request.method === "POST") {
        const body = isPlainObject(parsedBody) ? parsedBody : undefined;
        if (
          !body ||
          !isStringArray(body["environments"]) ||
          body["environments"].length === 0
        )
          return failure(400, "bad_request", "environments is required");
        for (const key of Object.keys(body))
          if (key !== "environments")
            return failure(400, "bad_request", `Unknown field ${key}`);
        connector.projects[projectId] = [...new Set(body["environments"])];
        connector.updatedAt = now();
        return reply(200, projectConnectionView(connector, projectId));
      }
      if (request.method === "GET") {
        if (!connector.projects[projectId])
          return failure(
            404,
            "not_found",
            "Could not find the project connection",
          );
        return reply(200, projectConnectionView(connector, projectId));
      }
      if (request.method === "DELETE") {
        if (!connector.projects[projectId])
          return failure(
            404,
            "not_found",
            "Could not find the project connection",
          );
        delete connector.projects[projectId];
        connector.updatedAt = now();
        return reply(204);
      }
    }

    // GET /v2/connect/connectors/{connector}/projects
    if (
      request.method === "GET" &&
      segments.length === 5 &&
      segments[1] === "connect" &&
      segments[2] === "connectors" &&
      segments[4] === "projects"
    ) {
      if (version !== "v2") {
        route = "version-mismatch";
        note(`GET ${request.url.pathname}: this listing is published under /v2`);
        return failure(404, "not_found", "Could not find the endpoint");
      }
      route = "connect.connectors.projects";
      const denied = requireTeamScope() ?? requireManagement(false);
      if (denied) return denied;
      const connector = connectorByPathSegment(segments[3] ?? "");
      if (!connector)
        return failure(404, "not_found", "Could not find the connector");
      const all = Object.keys(connector.projects).map((projectId) =>
        projectConnectionView(connector, projectId),
      );
      const { page, next } = paginate(all, request.url.searchParams);
      return reply(200, { projects: page, pagination: { next } });
    }

    // GET /v2/connect/projects/{projectId}/connectors
    if (
      request.method === "GET" &&
      segments.length === 5 &&
      segments[1] === "connect" &&
      segments[2] === "projects" &&
      segments[4] === "connectors"
    ) {
      if (version !== "v2") {
        route = "version-mismatch";
        note(`GET ${request.url.pathname}: this listing is published under /v2`);
        return failure(404, "not_found", "Could not find the endpoint");
      }
      route = "connect.projects.connectors";
      const denied = requireTeamScope() ?? requireManagement(false);
      if (denied) return denied;
      const projectId = decodeSegment(segments[3] ?? "");
      const all = [...connectors.values()]
        .filter((connector) => connector.projects[projectId] !== undefined)
        .map((connector) => projectConnectionView(connector, projectId));
      const { page, next } = paginate(all, request.url.searchParams);
      return reply(200, { connectors: page, pagination: { next } });
    }

    // PATCH /v1/connect/connectors/{connector}/trigger-destinations
    if (
      request.method === "PATCH" &&
      segments.length === 5 &&
      segments[1] === "connect" &&
      segments[2] === "connectors" &&
      segments[4] === "trigger-destinations"
    ) {
      if (version !== "v1") {
        route = "version-mismatch";
        note(
          `PATCH ${request.url.pathname}: trigger destinations are published under /v1`,
        );
        return failure(404, "not_found", "Could not find the endpoint");
      }
      route = "connect.triggers.destinations.replace";
      const denied = requireTeamScope() ?? requireManagement(true);
      if (denied) return denied;
      const connector = connectorByPathSegment(segments[3] ?? "");
      if (!connector)
        return failure(404, "not_found", "Could not find the connector");
      const body = isPlainObject(parsedBody) ? parsedBody : undefined;
      const destinations = body?.["destinations"];
      if (!Array.isArray(destinations))
        return failure(400, "bad_request", "destinations is required");
      if (destinations.length > 3)
        return failure(400, "bad_request", "At most three destinations");
      for (const destination of destinations) {
        if (
          !isPlainObject(destination) ||
          typeof destination["projectId"] !== "string"
        )
          return failure(400, "bad_request", "projectId is required");
        if (
          destination["branch"] !== undefined &&
          destination["customEnvironmentId"] !== undefined
        )
          return failure(
            400,
            "bad_request",
            "branch and customEnvironmentId are exclusive",
          );
        if (connector.projects[destination["projectId"]] === undefined)
          return failure(
            400,
            "bad_request",
            "The destination project is not linked",
          );
      }
      connector.triggerDestinations = destinations as Array<
        Record<string, unknown>
      >;
      connector.updatedAt = now();
      return reply(200, connectorView(connector));
    }

    // POST /v1/connect/authorize/{connector}
    if (
      request.method === "POST" &&
      segments.length === 4 &&
      segments[1] === "connect" &&
      segments[2] === "authorize"
    ) {
      if (version !== "v1") {
        route = "version-mismatch";
        note(
          `POST ${request.url.pathname}: the authorization request is published under /v1`,
        );
        return failure(404, "not_found", "Could not find the endpoint");
      }
      route = "connect.authorize";
      const denied = requireWorkload();
      if (denied) return denied;
      const connector = connectorByPathSegment(segments[3] ?? "");
      if (!connector)
        return failure(404, "not_found", "Could not find the connector");
      const linked = requireLink(connector);
      if (linked) return linked;
      const body = isPlainObject(parsedBody) ? parsedBody : {};
      for (const key of Object.keys(body))
        if (!authorizeBodyFields.has(key))
          return failure(400, "bad_request", `Unknown field ${key}`);
      const subjectKey = subjectKeyOf(body["subject"]);
      if (!subjectKey) return failure(400, "bad_request", "subject is invalid");
      const subjectType = (body["subject"] as Record<string, unknown>)[
        "type"
      ] as string;
      if (
        !(connector.supportedSubjectTypes ?? ["app", "user"]).includes(
          subjectType,
        )
      )
        return failure(
          400,
          "bad_request",
          "The connector does not issue that subject type",
        );
      const installationId =
        typeof body["installationId"] === "string"
          ? body["installationId"]
          : undefined;
      if (installationId !== undefined && !(connector.supportsInstallation ?? false))
        return failure(
          400,
          "bad_request",
          "This connector type has no installations",
        );
      if (
        installationId !== undefined &&
        installationId !== "*" &&
        !connector.installations.includes(installationId)
      )
        return failure(
          404,
          "connector_installation_required",
          "No such installation",
        );
      const scopes = isStringArray(body["scopes"]) ? body["scopes"] : [];
      const allowed = connector.scopes;
      if (
        allowed &&
        !scopes.every((scope) => scope === "*" || allowed.includes(scope))
      )
        return failure(400, "bad_request", "Unsupported scope");
      if (typeof body["returnUrl"] === "string") {
        const url = new URL(body["returnUrl"]);
        if (
          url.protocol !== "https:" &&
          !["localhost", "127.0.0.1"].includes(url.hostname)
        )
          return failure(400, "bad_request", "returnUrl must be https");
      }
      const requestId = `car_${randomBytes(9).toString("hex")}`;
      const lifetime =
        typeof body["expiresInMs"] === "number"
          ? body["expiresInMs"]
          : authorizationLifetimeMs;
      const pending: Authorization = {
        request: requestId,
        connectorUid: connector.uid,
        subjectKey,
        subject: body["subject"] as Record<string, unknown>,
        scopes,
        ...(installationId !== undefined ? { installationId } : {}),
        expiresAt: now() + lifetime,
        state: "pending",
        verifier: randomBytes(32).toString("base64url"),
        ...(typeof body["returnUrl"] === "string"
          ? { returnUrl: body["returnUrl"] }
          : {}),
        ...(body["deviceCode"] === true
          ? { deviceCode: randomBytes(4).toString("hex").toUpperCase() }
          : {}),
      };
      authorizations.set(requestId, pending);
      return reply(200, {
        connector: {
          displayName: connector.displayName ?? connector.uid,
          id: connector.id,
          name: connector.name ?? connector.uid,
          service: connector.service ?? "example.com",
          serviceName: connector.typeName ?? "Example",
          type: connector.type ?? "oauth",
          uid: connector.uid,
        },
        ...(pending.deviceCode ? { deviceCode: pending.deviceCode } : {}),
        // The published response schema types `expiresAt` as a number even
        // though the rendered example shows the string "123".
        expiresAt: pending.expiresAt,
        request: requestId,
        url: `${server.origin}/connect/consent/${requestId}`,
        verifier: pending.verifier,
      });
    }

    // POST /v1/connect/token/{connector}
    if (
      request.method === "POST" &&
      segments.length === 4 &&
      segments[1] === "connect" &&
      segments[2] === "token"
    ) {
      if (version !== "v1") {
        route = "version-mismatch";
        note(
          `POST ${request.url.pathname}: the token endpoint is published under /v1`,
        );
        return failure(404, "not_found", "Could not find the endpoint");
      }
      route = "connect.token";
      const denied = requireWorkload();
      if (denied) return denied;
      const connector = connectorByPathSegment(segments[3] ?? "");
      if (!connector)
        return failure(404, "not_found", "Could not find the connector");
      const linked = requireLink(connector);
      if (linked) return linked;
      const body = isPlainObject(parsedBody) ? parsedBody : {};
      for (const key of Object.keys(body))
        if (!tokenBodyFields.has(key))
          return failure(400, "bad_request", `Unknown field ${key}`);
      const subjectKey = subjectKeyOf(body["subject"]);
      if (!subjectKey) return failure(400, "bad_request", "subject is invalid");
      let installationId =
        typeof body["installationId"] === "string"
          ? body["installationId"]
          : undefined;
      if (installationId !== undefined && !(connector.supportsInstallation ?? false))
        return failure(
          400,
          "bad_request",
          "This connector type has no installations",
        );
      if (connector.supportsInstallation) {
        installationId ??= connector.defaultInstallationId;
        if (installationId === undefined)
          return failure(
            403,
            "connector_installation_required",
            "No installation matches this request",
          );
        if (
          installationId !== "*" &&
          !connector.installations.includes(installationId)
        )
          return failure(
            403,
            "connector_installation_required",
            "No such installation",
          );
      }
      const grant = grants.get(
        grantKey(connector.uid, subjectKey, installationId),
      );
      if (!grant)
        return subjectKey === "app"
          ? failure(403, "no_token", "No valid token for this request")
          : failure(
              403,
              "user_authorization_required",
              "That subject has not authorized this connector",
            );
      const requested = isStringArray(body["scopes"]) ? body["scopes"] : [];
      const effective =
        requested.includes("*") || requested.length === 0
          ? grant.scopes
          : requested;
      if (!effective.every((scope) => grant.scopes.includes(scope)))
        return failure(
          403,
          "user_authorization_required",
          "Requested scopes exceed the grant",
        );
      const tokenId = `stk_${randomBytes(8).toString("hex")}`;
      const token = `provider_${randomBytes(16).toString("hex")}`;
      const expiresAt = now() + tokenLifetimeMs;
      issuedTokens.push({
        tokenId,
        token,
        connectorUid: connector.uid,
        subjectKey,
        expiresAt,
      });
      return reply(200, {
        token,
        tokenId,
        expiresAt,
        connector: {
          id: connector.id,
          type: connector.type ?? "oauth",
          uid: connector.uid,
        },
        name: connector.name ?? connector.uid,
        ...(installationId !== undefined ? { installationId } : {}),
        ...(connector.tenantId !== undefined
          ? { tenantId: connector.tenantId }
          : {}),
        ...(grant.externalSubject !== undefined
          ? { externalSubject: grant.externalSubject }
          : {}),
        authorizationId: grant.authorizationId,
        tokenGroupId: `tgr_${createHash("sha1")
          .update(grantKey(connector.uid, subjectKey, installationId))
          .digest("hex")
          .slice(0, 12)}`,
      });
    }

    // DELETE /v1/connect/connectors/{connector}/tokens  (observed in the SDK)
    if (
      request.method === "DELETE" &&
      segments.length === 5 &&
      segments[1] === "connect" &&
      segments[2] === "connectors" &&
      segments[4] === "tokens"
    ) {
      if (version !== "v1") {
        route = "version-mismatch";
        return failure(404, "not_found", "Could not find the endpoint");
      }
      route = "connect.tokens.revoke";
      const denied = requireWorkload();
      if (denied) return denied;
      const connector = connectorByPathSegment(segments[3] ?? "");
      if (!connector)
        return failure(404, "not_found", "Could not find the connector");
      const linked = requireLink(connector);
      if (linked) return linked;
      const body = isPlainObject(parsedBody) ? parsedBody : {};
      const subjectKey = subjectKeyOf(body["subject"]);
      if (!subjectKey) return failure(400, "bad_request", "subject is invalid");
      const installationId =
        typeof body["installationId"] === "string"
          ? body["installationId"]
          : undefined;
      grants.delete(grantKey(connector.uid, subjectKey, installationId));
      return reply(204);
    }

    return failure(404, "not_found", "Could not find the endpoint");
  });

  return {
    origin: server.origin,
    teamId,
    calls,
    /** Wire-contract violations the double noticed; a healthy run leaves this empty. */
    violations,
    close: server.close,
    connector: (uid: string) => connectors.get(uid),
    authorization: (request: string) => authorizations.get(request),
    issuedTokens,
    /** Requests the double matched to one route, in arrival order. */
    routed(route: string) {
      return calls.filter((call) => call.route === route);
    },
    /** Grants an app subject the connector's scopes; app subjects have no consent leg. */
    grantApp(
      connectorUid: string,
      input: {
        scopes: string[];
        installationId?: string;
        externalSubject?: string;
      },
    ) {
      grants.set(grantKey(connectorUid, "app", input.installationId), {
        connectorUid,
        subjectKey: "app",
        scopes: input.scopes,
        ...(input.installationId !== undefined
          ? { installationId: input.installationId }
          : {}),
        ...(input.externalSubject !== undefined
          ? { externalSubject: input.externalSubject }
          : {}),
        authorizationId: `auth_${randomBytes(6).toString("hex")}`,
      });
    },
    /** The human half of a consent flow: approve the request the adapter created. */
    approve(request: string, input: { externalSubject?: string } = {}) {
      const pending = authorizations.get(request);
      if (!pending) throw new Error("unknown authorization request");
      if (pending.expiresAt <= now()) throw new Error("authorization expired");
      pending.state = "approved";
      const connector = connectors.get(pending.connectorUid);
      const derived = (prefix: string) =>
        `${prefix}${createHash("sha1")
          .update(pending.subjectKey)
          .digest("hex")
          .slice(0, 8)
          .toUpperCase()}`;
      const externalSubject =
        input.externalSubject ??
        (connector?.reportsExternalSubject === false
          ? undefined
          : pending.subjectKey.startsWith("user:")
            ? derived("U")
            : pending.subjectKey.startsWith("jwt-bearer:")
              ? derived("F")
              : undefined);
      grants.set(
        grantKey(
          pending.connectorUid,
          pending.subjectKey,
          pending.installationId,
        ),
        {
          connectorUid: pending.connectorUid,
          subjectKey: pending.subjectKey,
          scopes: pending.scopes,
          ...(pending.installationId !== undefined
            ? { installationId: pending.installationId }
            : {}),
          ...(externalSubject !== undefined ? { externalSubject } : {}),
          authorizationId: `auth_${randomBytes(6).toString("hex")}`,
        },
      );
      return {
        externalSubject,
        /** The redirect the Connect consent screen would send the browser to. */
        returnUrl: pending.returnUrl,
      };
    },
    deny(request: string) {
      const pending = authorizations.get(request);
      if (!pending) throw new Error("unknown authorization request");
      pending.state = "denied";
    },
    /** Drops a grant the way an upstream revocation or an uninstall would. */
    revokeGrant(
      connectorUid: string,
      subjectKey: string,
      installationId?: string,
    ) {
      grants.delete(grantKey(connectorUid, subjectKey, installationId));
    },
    installInstallation(connectorUid: string, installationId: string) {
      const connector = connectors.get(connectorUid);
      if (!connector) throw new Error("unknown connector");
      connector.installations.push(installationId);
    },
  };
}
export type VercelConnectFixture = Awaited<
  ReturnType<typeof startVercelConnect>
>;

/*
 * The deployment identity side. Vercel Connect forwards a verified provider
 * event to a trigger destination with a Vercel OIDC token as a Bearer
 * credential (Connect Chat SDK page; `@vercel/connect` 2.3.0
 * `createConnectWebhookVerifier`). The token is an RS256 JWT from
 * https://oidc.vercel.com with the claims documented at /docs/oidc/reference.
 * This fixture mints those tokens and serves the JWKS, including a second,
 * unpublished key so a forgery has something to sign with.
 */
export async function startVercelOidcIssuer(
  options: { teamSlug?: string; jwksPath?: string } = {},
) {
  const teamSlug = options.teamSlug ?? "acme";
  const jwksPath = options.jwksPath ?? "/.well-known/jwks";
  const published = await generateKeyPair("RS256", { extractable: true });
  const unpublished = await generateKeyPair("RS256", { extractable: true });
  const kid = randomUUID();
  const publicJwk: JWK = {
    ...(await exportJWK(published.publicKey)),
    kid,
    use: "sig",
    alg: "RS256",
  };
  let served = 0;
  const server = await startHttpFixture((request: RecordedRequest) => {
    if (request.method === "GET" && request.url.pathname === jwksPath) {
      served++;
      return { status: 200, body: { keys: [publicJwk] } };
    }
    return {
      status: 404,
      body: { error: { code: "not_found", message: "Not found" } },
    };
  });
  const mint = async (input: {
    ownerId: string;
    projectId: string;
    environment: string;
    project?: string;
    owner?: string;
    audience?: string;
    issuer?: string;
    expiresInSeconds?: number;
    signWith?: "published" | "unpublished";
    keyId?: string;
    now?: number;
  }) => {
    const issuedAt = Math.floor((input.now ?? Date.now()) / 1000);
    return new SignJWT({
      owner: input.owner ?? teamSlug,
      owner_id: input.ownerId,
      project: input.project ?? "app",
      project_id: input.projectId,
      environment: input.environment,
    })
      .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: input.keyId ?? kid })
      .setIssuer(input.issuer ?? `https://oidc.vercel.com/${teamSlug}`)
      .setAudience(input.audience ?? `https://vercel.com/${teamSlug}`)
      .setSubject(
        `owner:${input.owner ?? teamSlug}:project:${input.project ?? "app"}:environment:${input.environment}`,
      )
      .setIssuedAt(issuedAt)
      .setNotBefore(issuedAt)
      .setExpirationTime(issuedAt + (input.expiresInSeconds ?? 7200))
      .sign(
        input.signWith === "unpublished"
          ? unpublished.privateKey
          : published.privateKey,
      );
  };
  return {
    origin: server.origin,
    jwksPath,
    teamSlug,
    keyId: kid,
    mint,
    jwksRequests: () => served,
    close: server.close,
  };
}
export type VercelOidcIssuerFixture = Awaited<
  ReturnType<typeof startVercelOidcIssuer>
>;

import { startHttpFixture } from "./http-fixture.js";

/*
 * An independent double of the Airbyte API, written from the published
 * reference (https://reference.airbyte.com, https://docs.airbyte.com/platform/api-documentation,
 * retrieved 2026-09-18) and not from the adapter under test. It implements the
 * documented paths only:
 *
 *   POST   /v1/applications/token   -> { access_token, token_type, expires_in }
 *   GET    /v1/sources/{sourceId}   -> SourceResponse
 *   GET    /v1/connections/{id}     -> ConnectionResponse
 *   GET    /v1/streams?sourceId=&destinationId=&ignoreCache=
 *   POST   /v1/jobs   { connectionId, jobType: sync|reset } -> JobResponse
 *   GET    /v1/jobs?connectionId=&limit= -> { data, next, previous }
 *   GET    /v1/jobs/{jobId}         -> JobResponse
 *   DELETE /v1/jobs/{jobId}         -> JobResponse (cancelled)
 *
 * Anything else answers 404 exactly as an unknown route would; the double never
 * invents an endpoint. Authorization is asserted here, independently: every
 * request but the token mint must carry `Authorization: Bearer <token>`, and a
 * wrong or missing token gets 401. The double holds connection state and
 * refuses to let a caller write it, which is how the tests observe that the
 * adapter never rewrites a checkpoint.
 */

export type AirbyteDoubleStream = {
  streamName: string;
  syncModes: string[];
  defaultCursorField?: string[];
  sourceDefinedCursorField?: boolean;
  sourceDefinedPrimaryKey?: string[][];
  propertyFields?: string[][];
};

export type AirbyteDoubleConnection = {
  connectionId: string;
  name: string;
  sourceId: string;
  destinationId: string;
  workspaceId: string;
  status: "active" | "inactive" | "deprecated";
  streams: Array<{
    name: string;
    syncMode: string;
    cursorField?: string[];
    primaryKey?: string[][];
  }>;
  /** Opaque per-stream checkpoints held by the platform; the API never exposes a writer. */
  state?: Record<string, unknown>;
};

export type AirbyteDoubleSource = {
  sourceId: string;
  name: string;
  sourceType: string;
  workspaceId: string;
  /** Streams the source reports; when absent, discovery fails as an unreachable source would. */
  streams?: AirbyteDoubleStream[];
  reachable?: boolean;
};

export type AirbyteDoubleJob = {
  jobId: number;
  connectionId: string;
  jobType: "sync" | "reset";
  status:
    "pending" | "running" | "incomplete" | "failed" | "succeeded" | "cancelled";
  startTime: string;
  lastUpdatedAt?: string;
  bytesSynced?: number;
  rowsSynced?: number;
};

export type AirbyteDoubleOptions = {
  sources?: AirbyteDoubleSource[];
  connections?: AirbyteDoubleConnection[];
  jobs?: AirbyteDoubleJob[];
  /** Bearer token the double accepts directly (a deployment API key). */
  apiKey?: string | undefined;
  /** Application credentials; when set, /applications/token mints `mintedToken`. */
  application?: { clientId: string; clientSecret: string; mintedToken: string };
  /** Status of a freshly created job; defaults to "running". */
  createdJobStatus?: AirbyteDoubleJob["status"];
  /** Fail the next N job creations with this status, to exercise uncertainty. */
  failJobCreation?: { times: number; status: number };
};

export async function startAirbyteApiDouble(
  options: AirbyteDoubleOptions = {},
) {
  const sources = new Map(
    (options.sources ?? []).map((source) => [source.sourceId, source]),
  );
  const connections = new Map(
    (options.connections ?? []).map((connection) => [
      connection.connectionId,
      connection,
    ]),
  );
  const jobs = new Map((options.jobs ?? []).map((job) => [job.jobId, job]));
  let nextJobId = Math.max(0, ...[...jobs.keys()]) + 1;
  let remainingFailures = options.failJobCreation?.times ?? 0;
  const tokenMints: Array<{ clientId: string }> = [];

  const unauthorized = { status: 401, body: { message: "unauthorized" } };

  const fixture = await startHttpFixture((request) => {
    const path = request.url.pathname;
    const method = request.method;

    if (method === "POST" && path === "/api/public/v1/applications/token") {
      const body = JSON.parse(request.body.toString("utf8") || "{}") as {
        client_id?: string;
        client_secret?: string;
      };
      if (
        !options.application ||
        body.client_id !== options.application.clientId ||
        body.client_secret !== options.application.clientSecret
      )
        return { status: 401, body: { message: "invalid_client" } };
      tokenMints.push({ clientId: body.client_id });
      return {
        body: {
          access_token: options.application.mintedToken,
          token_type: "Bearer",
          expires_in: 180,
        },
      };
    }

    const accepted = new Set<string>();
    if (options.apiKey) accepted.add(`Bearer ${options.apiKey}`);
    if (options.application)
      accepted.add(`Bearer ${options.application.mintedToken}`);
    if (!accepted.has(request.headers.authorization ?? "")) return unauthorized;

    if (!path.startsWith("/api/public/v1/")) return undefined;
    const rest = path.slice("/api/public/v1".length);

    const sourceMatch = /^\/sources\/([^/]+)$/.exec(rest);
    if (method === "GET" && sourceMatch) {
      const source = sources.get(decodeURIComponent(sourceMatch[1] ?? ""));
      if (!source) return { status: 404, body: { message: "not_found" } };
      return {
        body: {
          sourceId: source.sourceId,
          name: source.name,
          sourceType: source.sourceType,
          workspaceId: source.workspaceId,
          configuration: {},
        },
      };
    }

    const connectionMatch = /^\/connections\/([^/]+)$/.exec(rest);
    if (method === "GET" && connectionMatch) {
      const connection = connections.get(
        decodeURIComponent(connectionMatch[1] ?? ""),
      );
      if (!connection) return { status: 404, body: { message: "not_found" } };
      return {
        body: {
          connectionId: connection.connectionId,
          name: connection.name,
          sourceId: connection.sourceId,
          destinationId: connection.destinationId,
          workspaceId: connection.workspaceId,
          status: connection.status,
          configurations: {
            streams: connection.streams.map((stream) => ({
              name: stream.name,
              syncMode: stream.syncMode,
              ...(stream.cursorField
                ? { cursorField: stream.cursorField }
                : {}),
              ...(stream.primaryKey ? { primaryKey: stream.primaryKey } : {}),
            })),
          },
          namespaceDefinition: "source",
          createdAt: 1_700_000_000,
        },
      };
    }

    if (method === "GET" && rest === "/streams") {
      const sourceId = request.url.searchParams.get("sourceId");
      if (!sourceId)
        return { status: 400, body: { message: "sourceId required" } };
      const source = sources.get(sourceId);
      if (!source) return { status: 404, body: { message: "not_found" } };
      if (source.reachable === false)
        return { status: 502, body: { message: "source unreachable" } };
      return { body: source.streams ?? [] };
    }

    if (method === "POST" && rest === "/jobs") {
      if (remainingFailures > 0) {
        remainingFailures--;
        return {
          status: options.failJobCreation?.status ?? 503,
          body: { message: "unavailable" },
        };
      }
      const body = JSON.parse(request.body.toString("utf8") || "{}") as {
        connectionId?: string;
        jobType?: string;
      };
      if (body.jobType !== "sync" && body.jobType !== "reset")
        return { status: 400, body: { message: "invalid jobType" } };
      if (!body.connectionId || !connections.has(body.connectionId))
        return { status: 404, body: { message: "not_found" } };
      const job: AirbyteDoubleJob = {
        jobId: nextJobId++,
        connectionId: body.connectionId,
        jobType: body.jobType,
        status: options.createdJobStatus ?? "running",
        startTime: "2026-09-18T00:00:00Z",
      };
      jobs.set(job.jobId, job);
      return { body: job };
    }

    if (method === "GET" && rest === "/jobs") {
      const connectionId = request.url.searchParams.get("connectionId");
      const limit = Number(request.url.searchParams.get("limit") ?? "20");
      const data = [...jobs.values()]
        .filter((job) => !connectionId || job.connectionId === connectionId)
        .slice(0, Number.isFinite(limit) ? limit : 20);
      return { body: { data } };
    }

    const jobMatch = /^\/jobs\/(\d+)$/.exec(rest);
    if (jobMatch) {
      const job = jobs.get(Number(jobMatch[1]));
      if (!job) return { status: 404, body: { message: "not_found" } };
      if (method === "GET") return { body: job };
      if (method === "DELETE") {
        const cancelled: AirbyteDoubleJob = { ...job, status: "cancelled" };
        jobs.set(job.jobId, cancelled);
        return { body: cancelled };
      }
    }
    return undefined;
  });

  return {
    ...fixture,
    /** The documented self-managed base URL of this deployment. */
    apiUrl: `${fixture.origin}/api/public/v1`,
    jobs,
    connections,
    sources,
    tokenMints,
    /** Checkpoints the platform holds; tests assert the adapter never changed them. */
    stateOf(connectionId: string) {
      return connections.get(connectionId)?.state;
    },
  };
}

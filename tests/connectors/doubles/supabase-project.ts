import { SignJWT } from "jose";
import { startHttpFixture, type FixtureReply } from "./http-fixture.js";

/*
 * An independent double of one Supabase project: its Auth service under
 * /auth/v1 and its Data API (PostgREST) under /rest/v1. Written from the
 * documentation, not from the adapter:
 *
 *   Keys       Publishable keys (`sb_publishable_…`) and legacy `anon` JWTs are
 *              browser-safe; secret keys (`sb_secret_…`) and `service_role` JWTs
 *              are not and are refused here with 401, as the documentation says
 *              Supabase does. Keys travel on the `apikey` header; the signed-in
 *              user's JWT travels on `Authorization: Bearer`.
 *   GET /auth/v1/user     returns the user of the presented access token.
 *   GET /rest/v1/<table>  ?select=a,b  ?<column>=<operator>.<value>  ?order=col.asc
 *                         ?limit=N  ?offset=M ; responds 200 with a JSON array,
 *                         206 with Content-Range when a range was requested.
 *
 * Row Level Security is simulated: every row carries an owner, and a request
 * authenticated as a project user sees only its own rows. A table marked
 * `rlsDisabled` returns every row, so a test can show that the host's
 * "unverified" classification is the honest one.
 */

export type ProjectRow = Record<string, unknown> & { owner?: string };

export type ProjectTable = {
  name: string;
  rows: ProjectRow[];
  /** Absent policies: every row is returned to any authenticated caller. */
  rlsDisabled?: boolean;
  /** Not exposed through the Data API at all (PostgREST answers 404). */
  notExposed?: boolean;
};

export type ProjectUser = {
  id: string;
  email: string;
  aal?: "aal1" | "aal2";
};

export type SupabaseProjectDoubleOptions = {
  projectRef?: string;
  publishableKey?: string;
  users?: ProjectUser[];
  tables?: ProjectTable[];
  /** Seconds until an issued session expires. */
  sessionTtlSeconds?: number;
};

const SIGNING_KEY = new TextEncoder().encode(
  "synthetic-project-signing-key-for-connector-fixture",
);

export async function startSupabaseProjectDouble(
  options: SupabaseProjectDoubleOptions = {},
) {
  const projectRef = options.projectRef ?? "abcdefghijklmnopqrst";
  const publishableKey = options.publishableKey ?? "sb_publishable_fixture_key";
  const secretKey = "sb_secret_fixture_key";
  const users = new Map(
    (
      options.users ?? [{ id: "project-user-1", email: "user@example.test" }]
    ).map((user) => [user.id, user]),
  );
  const tables = new Map(
    (options.tables ?? []).map((table) => [table.name, table]),
  );
  const sessionTtlSeconds = options.sessionTtlSeconds ?? 3600;
  const sessions = new Map<string, { userId: string; expiresAt: number }>();
  const rejections: Array<{ path: string; reason: string }> = [];
  const observed = {
    apikeyHeaders: [] as string[],
    authorizationHeaders: [] as string[],
    restQueries: [] as URLSearchParams[],
    secretKeyPresented: false,
  };

  const reject = (path: string, reason: string, reply: FixtureReply) => {
    rejections.push({ path, reason });
    return reply;
  };

  /** Issues a session the way the project's token endpoint would; tests hand this to the adapter's session port. */
  const issueSession = async (userId: string) => {
    const user = users.get(userId);
    if (!user) throw new Error("Unknown fixture user");
    const expiresAt = Date.now() + sessionTtlSeconds * 1000;
    const accessToken = await new SignJWT({
      role: "authenticated",
      aal: user.aal ?? "aal1",
      email: user.email,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(user.id)
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt / 1000))
      .sign(SIGNING_KEY);
    sessions.set(accessToken, { userId: user.id, expiresAt });
    return { accessToken, userId: user.id, expiresAt };
  };

  const checkApiKey = (
    path: string,
    apikey: string | undefined,
  ): FixtureReply | undefined => {
    observed.apikeyHeaders.push(apikey ?? "");
    if (!apikey)
      return reject(path, "missing-apikey", {
        status: 401,
        body: { message: "No API key found in request" },
      });
    if (apikey === secretKey || apikey.startsWith("sb_secret_")) {
      // The documentation states a secret key does not work in a browser
      // context; this project refuses it outright.
      observed.secretKeyPresented = true;
      return reject(path, "secret-key-refused", {
        status: 401,
        body: { message: "Invalid API key" },
      });
    }
    if (apikey !== publishableKey)
      return reject(path, "unknown-apikey", {
        status: 401,
        body: { message: "Invalid API key" },
      });
    return undefined;
  };

  const authenticatedUser = (
    path: string,
    authorization: string | undefined,
  ): { error: FixtureReply } | { userId: string } => {
    observed.authorizationHeaders.push(authorization ?? "");
    if (!authorization?.startsWith("Bearer "))
      return {
        error: reject(path, "missing-bearer", {
          status: 401,
          body: { message: "Unauthorized" },
        }),
      };
    const token = authorization.slice(7);
    if (token.startsWith("sbp_") || token.startsWith("sb_secret_")) {
      // A management token or a secret key is a different authority entirely.
      return {
        error: reject(path, "wrong-authority-token", {
          status: 401,
          body: { message: "Invalid JWT" },
        }),
      };
    }
    const session = sessions.get(token);
    if (!session)
      return {
        error: reject(path, "unknown-session", {
          status: 401,
          body: { message: "Invalid JWT" },
        }),
      };
    if (session.expiresAt <= Date.now())
      return {
        error: reject(path, "session-expired", {
          status: 401,
          body: { code: "PGRST301", message: "JWT expired" },
        }),
      };
    return { userId: session.userId };
  };

  const compare = (operator: string, left: unknown, right: string): boolean => {
    const asNumber = Number(right);
    const numeric = typeof left === "number" && !Number.isNaN(asNumber);
    switch (operator) {
      case "eq":
        return numeric ? left === asNumber : String(left) === right;
      case "neq":
        return numeric ? left !== asNumber : String(left) !== right;
      case "gt":
        return numeric ? left > asNumber : String(left) > right;
      case "gte":
        return numeric ? left >= asNumber : String(left) >= right;
      case "lt":
        return numeric ? left < asNumber : String(left) < right;
      case "lte":
        return numeric ? left <= asNumber : String(left) <= right;
      case "like":
      case "ilike": {
        const pattern = right
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          .replace(/\\\*/g, ".*")
          .replace(/%/g, ".*");
        return new RegExp(`^${pattern}$`, operator === "ilike" ? "i" : "").test(
          String(left),
        );
      }
      case "is":
        return right === "null"
          ? left === null || left === undefined
          : String(left) === right;
      case "in": {
        const values = right
          .replace(/^\(/, "")
          .replace(/\)$/, "")
          .split(",")
          .map((value) => value.replace(/^"(.*)"$/s, "$1"));
        return values.some((value) =>
          numeric ? left === Number(value) : String(left) === value,
        );
      }
      default:
        return false;
    }
  };

  const fixture = await startHttpFixture(async (request) => {
    const path = request.url.pathname;

    if (path === "/auth/v1/user") {
      const keyError = checkApiKey(path, request.headers.apikey);
      if (keyError) return keyError;
      const admitted = authenticatedUser(path, request.headers.authorization);
      if ("error" in admitted) return admitted.error;
      const user = users.get(admitted.userId)!;
      return {
        status: 200,
        body: {
          id: user.id,
          aud: "authenticated",
          role: "authenticated",
          email: user.email,
          aal: user.aal ?? "aal1",
        },
      };
    }

    const restMatch = /^\/rest\/v1\/([^/]+)$/.exec(path);
    if (restMatch) {
      const keyError = checkApiKey(path, request.headers.apikey);
      if (keyError) return keyError;
      const admitted = authenticatedUser(path, request.headers.authorization);
      if ("error" in admitted) return admitted.error;
      if (request.method !== "GET")
        return reject(path, "method-not-approved", {
          status: 405,
          body: { message: "Method not allowed" },
        });
      const query = request.url.searchParams;
      observed.restQueries.push(new URLSearchParams(query));
      const tableName = decodeURIComponent(restMatch[1]!);
      const table = tables.get(tableName);
      if (!table || table.notExposed)
        return reject(path, "table-not-exposed", {
          status: 404,
          body: {
            code: "PGRST205",
            message: "Could not find the table in the schema cache",
          },
        });
      const select = (query.get("select") ?? "*").split(",").filter(Boolean);
      let rows = table.rows.filter(
        (row) =>
          table.rlsDisabled ||
          row.owner === undefined ||
          row.owner === admitted.userId,
      );
      for (const [name, value] of query) {
        if (["select", "order", "limit", "offset"].includes(name)) continue;
        const separator = value.indexOf(".");
        const operator = value.slice(0, separator);
        const operand = value.slice(separator + 1);
        if (!separator || separator < 0)
          return reject(path, "filter-syntax", {
            status: 400,
            body: { code: "PGRST100", message: "Unexpected filter" },
          });
        rows = rows.filter((row) => compare(operator, row[name], operand));
      }
      const order = query.get("order");
      if (order) {
        const [column, direction] = order.split(".");
        rows = [...rows].sort((a, b) => {
          const left = String(a[column!] ?? "");
          const right = String(b[column!] ?? "");
          return direction === "desc"
            ? right.localeCompare(left)
            : left.localeCompare(right);
        });
      }
      const total = rows.length;
      const offset = Number(query.get("offset") ?? "0");
      const limit = query.get("limit") ? Number(query.get("limit")) : undefined;
      rows = rows.slice(
        offset,
        limit === undefined ? undefined : offset + limit,
      );
      const projected = rows.map((row) =>
        select.includes("*")
          ? { ...row }
          : Object.fromEntries(
              select
                .filter((column) => Object.hasOwn(row, column))
                .map((column) => [column, row[column]]),
            ),
      );
      const ranged = query.has("limit") || query.has("offset");
      return {
        status: ranged ? 206 : 200,
        headers: {
          "content-range": `${offset}-${Math.max(offset, offset + projected.length - 1)}/${total}`,
          "range-unit": "items",
        },
        body: projected,
      };
    }

    return reject(path, "unknown-route", {
      status: 404,
      body: { message: "Not found" },
    });
  });

  return {
    origin: fixture.origin,
    projectRef,
    publishableKey,
    secretKey,
    issueSession,
    observed,
    rejections,
    requests: fixture.requests,
    received: fixture.received,
    expireSession(accessToken: string) {
      const session = sessions.get(accessToken);
      if (session) session.expiresAt = Date.now() - 1000;
    },
    close: fixture.close,
  };
}

export type SupabaseProjectDouble = Awaited<
  ReturnType<typeof startSupabaseProjectDouble>
>;

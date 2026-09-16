import { z } from "zod";
import { githubAppManifest, githubWorkflows } from "../github.js";
import { serviceManifests } from "../services.js";
import { AuthorizationError, type HostIdentityAdapter } from "../identity.js";
import {
  assertRequestBoundary,
  boundedJson,
  reserveRequest,
} from "../authorization.js";
import { teachingHttp } from "../teaching-http.js";
import type { TeachingRuntime } from "../teaching-runtime.js";
import { validContinuationWorker } from "./continuations.js";
import { AsyncCeremonyEnvironment } from "../async-environment.js";
import { authenticatedActor, requireCapability } from "../identity.js";
import { PersistenceConflict } from "../persistence/index.js";

type BrowserIdentity = HostIdentityAdapter & {
  login(request: Request): Promise<Response>;
  callback(request: Request): Promise<Response>;
  logout(request: Request): Promise<Response>;
};
function browserIdentity(identity: HostIdentityAdapter): BrowserIdentity {
  if (
    !("login" in identity) ||
    typeof identity.login !== "function" ||
    !("callback" in identity) ||
    typeof identity.callback !== "function" ||
    !("logout" in identity) ||
    typeof identity.logout !== "function"
  )
    throw new Error("Hosted identity unavailable");
  return identity as BrowserIdentity;
}
/** One mounted hosted route, also used by real HTTP identity integration tests. Human auth responses are never agent tools. */
export async function hostedHttp(
  request: Request,
  runtime: TeachingRuntime,
  startAgent: (runId: string, turnId: string) => Promise<void>,
  worker?: { secret: string | undefined; dispatch(): Promise<void> },
  mcp?: { fetch(request: Request): Promise<Response | undefined> },
): Promise<Response> {
  try {
    // Before the browser boundary, deliberately. That boundary is a CSRF
    // defence for requests authenticated by an ambient cookie: it requires an
    // Origin header equal to this app's. An MCP client is not a browser, sends
    // no Origin, and carries a bearer token that a hostile page cannot cause to
    // be attached — so the check would reject every MCP request while
    // defending against nothing. The MCP handler does its own authentication
    // and answers only its own two paths, returning undefined for the rest.
    const handled = await mcp?.fetch(request);
    if (handled) return handled;
    assertRequestBoundary(request, { origin: runtime.origin });
    const path = new URL(request.url).pathname;
    if (path === "/api/environment") {
      const actor = await authenticatedActor(request, runtime.identity);
      requireCapability(actor, "executor");
      if (actor.actorKind !== "human") throw new AuthorizationError("denied");
      await reserveRequest(runtime.store, actor);
      const environment = new AsyncCeremonyEnvironment(runtime.store);
      const result =
        request.method === "GET"
          ? await environment.describe(actor)
          : request.method === "POST"
            ? await environment.update(
                actor,
                await boundedJson(request, 131072),
              )
            : undefined;
      if (!result) throw new AuthorizationError("invalid_request");
      return Response.json(result, {
        headers: {
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "x-robots-tag": "noindex",
        },
      });
    }
    if (path === "/api/internal/continuations") {
      if (
        request.method !== "GET" ||
        !worker ||
        !validContinuationWorker(request, worker.secret)
      )
        throw new AuthorizationError("denied");
      await worker.dispatch();
      return Response.json(
        { dispatched: true },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (path === "/api/config" && request.method === "GET")
      return Response.json(
        {
          manifests: [githubAppManifest],
          liveManifests: [githubAppManifest, ...serviceManifests].filter(
            (manifest) => runtime.connectors.includes(manifest.id),
          ),
          liveAvailable: true,
          teachingAvailable: true,
          teachingConnectors: runtime.connectors,
          generationAvailable: false,
        },
        { headers: { "cache-control": "no-store" } },
      );
    if (path === "/api/workflows/github" && request.method === "GET")
      return Response.json(githubWorkflows, {
        headers: { "cache-control": "no-store" },
      });
    if (path === "/api/auth/callback")
      return await browserIdentity(runtime.identity).callback(request);
    if (path === "/api/auth/login" || path === "/api/auth/logout") {
      if (request.method !== "POST")
        throw new AuthorizationError("invalid_request");
      if (
        !z
          .object({})
          .strict()
          .safeParse(await boundedJson(request, 1024)).success
      )
        throw new AuthorizationError("invalid_request");
      await reserveRequest(
        runtime.store,
        {
          tenantId: "hosted",
          subjectId: "authentication-boundary",
          sessionId: "server",
          actorKind: "system",
          capabilities: [],
        },
        120,
      );
      const identity = browserIdentity(runtime.identity);
      const response = path.endsWith("/login")
        ? await identity.login(request)
        : await identity.logout(request);
      if (response.status !== 303)
        throw new Error("Hosted identity response unavailable");
      const headers = new Headers(response.headers);
      headers.delete("location");
      headers.set("cache-control", "no-store");
      headers.set("referrer-policy", "no-referrer");
      if (path.endsWith("/logout")) {
        headers.set("clear-site-data", '"cache", "cookies", "storage"');
        return Response.json({ signedOut: true }, { headers });
      }
      const authorizationUrl = response.headers.get("location");
      if (!authorizationUrl)
        throw new Error("Hosted identity response unavailable");
      return Response.json({ authorizationUrl }, { headers });
    }
    return await teachingHttp(request, runtime, startAgent);
  } catch (error) {
    const status =
      error instanceof z.ZodError
        ? 400
        : error instanceof AuthorizationError
          ? {
              unauthenticated: 401,
              denied: 403,
              invalid_request: 400,
              rate_limited: 429,
            }[error.code]
          : error instanceof PersistenceConflict
            ? 409
            : 503;
    return Response.json(
      {
        error:
          error instanceof z.ZodError
            ? "invalid_request"
            : error instanceof AuthorizationError
              ? error.code
              : "hosted-unavailable",
      },
      {
        status,
        headers: {
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        },
      },
    );
  }
}

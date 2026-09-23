import {
  McpServer,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  type AuthInfo,
  type McpRequestContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { ceremonyAgentTools } from "./agent-tools.js";
import {
  browserLoginToolInputs,
  browserToolFailure,
} from "./browser-login-tools.js";
import { AuthorizationError } from "./identity.js";
import type { ActorContext } from "./identity.js";
import { registerTeachingTools, type RefusalWording } from "./mcp-teaching.js";
import { PersistenceConflict } from "./persistence/index.js";
import { registerPrivateCollector } from "./mcp-app.js";
import type { PrivateCollectorOptions } from "./mcp-app.js";
import {
  connectorServerToolNames,
  registerConnectorServerTools,
} from "./connectors/mcp/server-tools.js";
import { registerAgentConnectorTools } from "./connectors/agents/mcp-intents.js";
import type { AgentConnectorDependencies } from "./connectors/agents/intents.js";
import type { ConnectorToolDependencies } from "./connectors/mcp/server-tools.js";
import type { CeremonyController } from "./controller.js";
import type { CeremonyDatabase } from "./storage.js";
import type { TeachingRuntime } from "./teaching-runtime.js";

/**
 * The ceremony MCP server.
 *
 * A chat client drives ceremonies through the same four operations the browser
 * uses, against the same runtime, with the same authorization. The transport is
 * the only difference: a bearer token instead of a session cookie. It can also
 * record, author and chain ceremonies (`mcp-teaching.ts`) through the same
 * operations the browser's teaching routes call — everything except review
 * and publication, which stay with people.
 *
 * Two properties this file exists to keep:
 *
 * - **The actor is never a tool argument.** It comes from `authenticate`, which
 *   the host supplies and which sees the HTTP request. A model can name a run
 *   id; it cannot name whose run it is.
 * - **No credential crosses MCP.** The tools carry run state only. Values are
 *   collected by the MCP App collector straight over HTTPS to the broker, and
 *   the assistant receives a one-use reference — never the value. That collector
 *   requires stable HTTPS origins, so on a plain-HTTP development origin it is
 *   not registered at all rather than registered in a weaker form.
 */

export interface CeremonyMcpOptions {
  /** Public URL of this MCP endpoint; the `resource` in RFC 9728 metadata. */
  resourceUrl: string;
  /** Authorization server that mints tokens for this resource. */
  issuer: string;
  /**
   * Resolve the bearer token to an actor. Host-owned: it validates the token
   * against the issuer and maps claims to capabilities. Returning null refuses
   * the request; it must never fall back to an anonymous or ambient actor.
   */
  authenticate(
    token: string,
    request: Request,
  ): Promise<ActorContext | null> | ActorContext | null;
  /** Registered when both origins are HTTPS; omitted otherwise, and said so. */
  privateCollector?: {
    brokerOrigin: string;
    appOrigin: string;
    appHtml: string;
    controller: CeremonyController;
    db: CeremonyDatabase;
    requestOwner: NonNullable<PrivateCollectorOptions["requestOwner"]>;
  };
  /**
   * Connector operations, when this deployment offers them. Supplying this
   * adds four tools beside the five above; leaving it out changes nothing.
   * The service behind it receives the authenticated actor and re-checks
   * capability, ownership and policy itself.
   */
  connectors?: ConnectorToolDependencies;
  /**
   * Safe connector intents (list, inspect, operations, reconnect,
   * disconnect), when this deployment offers them. Names already
   * registered are skipped, so this only ever adds; leaving it unset
   * changes nothing.
   */
  connectorIntents?: AgentConnectorDependencies;
  serverName?: string;
  serverVersion?: string;
  onerror?(error: Error): void;
}

/** Actor for the current request, carried across the SDK's opaque auth slot. */
interface CeremonyAuthInfo extends AuthInfo {
  extra: { actor: ActorContext };
}

const bearer = /^Bearer +([^\s]+)$/i;

function refusal(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
  };
}

/** A failure tells the model what to do next; it never echoes provider detail. */
function explain(error: unknown, wording: RefusalWording = {}): string {
  // The browser-session failures are mapped by the shared module, so HTTP and
  // MCP disagree about nothing: the same exception yields the same finite code
  // and the same finite reason, and only the wording differs.
  const browser = browserToolFailure(error);
  if (browser)
    return {
      "plan-rejected": `That connection configuration was rejected: ${browser.reason}.`,
      "session-lost":
        "That browser session is no longer available. Log in again.",
      "lease-conflict": "Another client controls that browser session.",
    }[browser.code];
  if (error instanceof AuthorizationError)
    return {
      unauthenticated: "Sign in to the ceremony application first.",
      denied:
        wording.denied ?? "This run belongs to a different session or subject.",
      invalid_request: "That request is not valid for this ceremony.",
      rate_limited: "Too many attempts. Wait before retrying.",
    }[error.code];
  if (error instanceof z.ZodError) return "Those arguments are not valid.";
  if (error instanceof PersistenceConflict)
    return "That changed since you read it. Read it again and use its current revision.";
  return (
    wording.fallback ??
    "The ceremony could not be advanced. Read the run again."
  );
}

export function createCeremonyMcpHandler(
  runtime: TeachingRuntime,
  options: CeremonyMcpOptions,
) {
  const resourceUrl = new URL(options.resourceUrl);
  const metadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);
  // RFC 9728 asks a resource server for one thing: who issues its tokens. The
  // client reads the authorization server's own metadata from the issuer, so
  // nothing here restates it and nothing can drift out of date with it.
  const metadata = {
    resource: resourceUrl.href,
    authorization_servers: [options.issuer],
    scopes_supported: ["executor", "author", "reviewer", "publisher", "admin"],
    bearer_methods_supported: ["header"],
    resource_name: options.serverName ?? "Ceremony",
  };
  const challenge = () =>
    new Response(null, {
      status: 401,
      headers: {
        "www-authenticate": `Bearer resource_metadata="${metadataUrl}"`,
        "cache-control": "no-store",
      },
    });
  const tools = ceremonyAgentTools(runtime);

  // The collector is a property of the deployment, not of a request, so the
  // decision is made once here and reported rather than retried per call.
  const collectorOrigins = options.privateCollector;
  const collectorAvailable = Boolean(
    collectorOrigins &&
    collectorOrigins.brokerOrigin.startsWith("https://") &&
    collectorOrigins.appOrigin.startsWith("https://"),
  );

  function build(context: McpRequestContext): McpServer {
    const actor = (context.authInfo as CeremonyAuthInfo | undefined)?.extra
      ?.actor;
    const server = new McpServer({
      name: options.serverName ?? "ceremony",
      version: options.serverVersion ?? "1.0.0",
    });
    const run = async (
      operate: (actor: ActorContext) => Promise<unknown>,
      wording?: RefusalWording,
    ) => {
      if (!actor) return refusal("Sign in to the ceremony application first.");
      try {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(await operate(actor)),
            },
          ],
        };
      } catch (error) {
        options.onerror?.(
          error instanceof Error ? error : new Error(String(error)),
        );
        return refusal(explain(error, wording));
      }
    };

    server.registerTool(
      "ceremony_connect",
      {
        description:
          "Start connecting a service and run every step that does not need a person. Returns the run, including the step now waiting.",
        inputSchema: z.strictObject({
          connectorId: z
            .string()
            .describe("A connector this deployment offers, such as github."),
          teach: z
            .boolean()
            .optional()
            .describe(
              "Record this ceremony from its first step, so it can be compiled into a recipe draft. Needs the author capability.",
            ),
        }),
        annotations: { destructiveHint: false, openWorldHint: true },
      },
      async (input) => await run((who) => tools.connect(who, input)),
    );
    server.registerTool(
      "ceremony_snapshot",
      {
        description:
          "Read the current state of a run. Use this after a person has been asked to do something.",
        inputSchema: z.strictObject({ runId: z.string() }),
        annotations: { readOnlyHint: true },
      },
      async (input) => await run((who) => tools.snapshot(who, input)),
    );
    server.registerTool(
      "ceremony_advance",
      {
        description:
          "Advance one step of a run. The revision must be the one you last read.",
        inputSchema: z.strictObject({
          runId: z.string(),
          nodeId: z.string(),
          revision: z.number().int().positive(),
          commandId: z
            .string()
            .describe(
              "Your own id for this attempt, so a retry is not a second attempt.",
            ),
        }),
        annotations: {
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (input) => await run((who) => tools.advance(who, input)),
    );
    server.registerTool(
      "ceremony_cancel",
      {
        description:
          "Cancel a run. This does not revoke access a completed ceremony already granted.",
        inputSchema: z.strictObject({
          runId: z.string(),
          revision: z.number().int().positive(),
        }),
        annotations: { destructiveHint: true },
      },
      async (input) => await run((who) => tools.cancel(who, input)),
    );
    server.registerTool(
      "ceremony_connectors",
      {
        description:
          "List the services you can connect here, including connectors you authored and installed.",
        inputSchema: z.strictObject({}),
        annotations: { readOnlyHint: true },
      },
      // The same list the browser's capabilities route reports: the host's
      // registered connectors and this actor's own installed ones. Another
      // author's installed connector is not listed, and cannot be started.
      async () =>
        await run(async (who) => ({
          connectors: [...new Set(await runtime.listConnectors(who))],
          privateCollection: collectorAvailable
            ? "in-chat"
            : "web-application-only",
        })),
    );

    registerTeachingTools(server, runtime, { actor, run });

    if (options.connectors)
      registerConnectorServerTools(server, options.connectors, {
        actor: () => actor,
        ...(options.onerror ? { onerror: options.onerror } : {}),
      });

    if (options.connectorIntents)
      registerAgentConnectorTools(server, options.connectorIntents, {
        actor: () => actor,
        // Only names really mounted above are taken. Without the four
        // connector tools, the intents' own status and connect are the only
        // way to reach those operations, so they must not be skipped.
        taken: options.connectors ? connectorServerToolNames : [],
        ...(options.onerror ? { onerror: options.onerror } : {}),
      });

    // The retained-browser operations are registered only where this
    // deployment actually has a browser executor. A tool that is offered and
    // always refuses teaches a model to keep trying; an absent tool does not.
    const browser = runtime.browserLogin;
    if (browser) {
      server.registerTool(
        "browser_login",
        {
          description:
            "Log in to a service in a real browser and keep the session. Credentials are passed as collector references; this tool never accepts a value.",
          inputSchema: browserLoginToolInputs.login,
          annotations: { destructiveHint: false, openWorldHint: true },
        },
        async (input) => await run((who) => browser.login(who, input)),
      );
      server.registerTool(
        "browser_session_status",
        {
          description:
            "Read what is known about a retained browser session, including whether you are the client permitted to drive it.",
          inputSchema: browserLoginToolInputs.sessionStatus,
          annotations: { readOnlyHint: true },
        },
        async (input) => await run((who) => browser.sessionStatus(who, input)),
      );
      server.registerTool(
        "browser_release",
        {
          description:
            "Stop driving a browser session, dispose one this server launched, or cancel its run. None of these logs the account out at the provider.",
          inputSchema: browserLoginToolInputs.release,
          annotations: { destructiveHint: true },
        },
        async (input) => await run((who) => browser.release(who, input)),
      );
      server.registerTool(
        "browser_backends",
        {
          description:
            "List the browsers this deployment can offer and what each one actually enforces.",
          inputSchema: browserLoginToolInputs.backends,
          annotations: { readOnlyHint: true },
        },
        async (input) => await run((who) => browser.backends(who, input)),
      );
    }

    if (collectorOrigins && collectorAvailable)
      registerPrivateCollector(
        server,
        collectorOrigins.controller,
        collectorOrigins.db,
        {
          brokerOrigin: collectorOrigins.brokerOrigin,
          appOrigin: collectorOrigins.appOrigin,
          appHtml: collectorOrigins.appHtml,
          owner: () => actor?.subjectId ?? "",
          requestOwner: collectorOrigins.requestOwner,
        },
      );
    return server;
  }

  const handler = createMcpHandler(build, {
    ...(options.onerror ? { onerror: options.onerror } : {}),
  });

  return {
    /** True when the in-chat collector is mounted; false means web-only. */
    collectorAvailable,
    metadataUrl,
    /** Answers the MCP endpoint and its RFC 9728 metadata; undefined otherwise. */
    async fetch(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url);
      if (url.pathname === new URL(metadataUrl).pathname)
        return Response.json(metadata, {
          headers: { "cache-control": "no-store" },
        });
      if (url.pathname !== resourceUrl.pathname) return undefined;
      const token = bearer.exec(
        request.headers.get("authorization") ?? "",
      )?.[1];
      if (!token) return challenge();
      let actor: ActorContext | null;
      try {
        actor = await options.authenticate(token, request);
      } catch {
        actor = null;
      }
      if (!actor) return challenge();
      const authInfo: CeremonyAuthInfo = {
        token,
        clientId: actor.sessionId,
        scopes: actor.capabilities,
        extra: { actor },
      };
      return await handler.fetch(request, { authInfo });
    },
  };
}

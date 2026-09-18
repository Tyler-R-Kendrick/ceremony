import { z } from "zod";
import type { ActorContext } from "../../../core/operation-contracts.js";
import {
  DEFINITION_LIMITS,
  connectionLifecycleSchema,
} from "../../../core/connectors/index.js";
import {
  assertRequestBoundary,
  boundedJson,
  reserveRequest,
} from "../../authorization.js";
import type { AsyncCeremonyStore } from "../../persistence/index.js";
import { ConnectorError, explainConnectorError } from "../errors.js";
import { referenceSchema } from "./inputs.js";
import {
  CONNECTOR_CALLBACK_PATH,
  type ConnectorCommandService,
} from "./service.js";

/*
 * The HTTP face of the command service. It is a mountable function: the host
 * authenticates the request with its own identity adapter and passes the
 * actor in; nothing here reads a token or a cookie. Same-origin, content-type
 * and size boundaries apply to every mutation; the provider callback is a
 * top-level navigation authenticated by the session and correlated by state,
 * and the event mount point delegates to a receiver that authenticates
 * deliveries by signature. Every failure is a sanitized code with a status.
 */

export const CONNECTOR_HTTP_PREFIX = "/api/v1/connectors";
export { CONNECTOR_CALLBACK_PATH };
export const DEFAULT_RETURN_PATH = "/connectors";

export type ConnectorEventReceiver = (input: {
  authority: string;
  request: Request;
}) => Promise<Response>;

export interface ConnectorHttpOptions {
  /** Exact trusted origin; must equal the service origin. */
  origin: string;
  /** Shared store for the subject-scoped request budget. */
  store: AsyncCeremonyStore;
  /** Where a completed callback sends the person; a path on this origin, never taken from input. */
  returnPath?: string;
  /** The events module's receiver; absent means the mount point answers 404. */
  receiveEvent?: ConnectorEventReceiver;
  rateLimit?: { limit: number; windowMs: number };
  /** Ceiling for ordinary JSON bodies; imports get their own, larger ceiling. */
  maxBodyBytes?: number;
}

export type ConnectorHttpHandler = (
  request: Request,
  actor: ActorContext,
) => Promise<Response | undefined>;

const headers = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

export function connectorReply(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers });
}

export function connectorErrorResponse(error: unknown): Response {
  const explained = explainConnectorError(error);
  return connectorReply(
    {
      error: explained.code,
      message: explained.message,
      ...(explained.detail ? { detail: explained.detail } : {}),
    },
    explained.status,
  );
}

const returnPathSchema = z
  .string()
  .max(512)
  .regex(/^\/(?!\/)[^\p{Cc}?#\s]*$/u);
const authoritySchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/);
const segment = (value: string) => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new ConnectorError("invalid-request", { detail: "path.segment" });
  }
  const parsed = referenceSchema.safeParse(decoded);
  if (!parsed.success)
    throw new ConnectorError("invalid-request", { detail: "path.segment" });
  return parsed.data;
};
const methodNotAllowed = (allow: string) =>
  Response.json(
    { error: "invalid-request", message: "Method not allowed." },
    { status: 405, headers: { ...headers, allow } },
  );

/** Provider deliveries only: no session, no origin check; the receiver authenticates by signature. */
export function createConnectorEventsHttp(
  options: Pick<ConnectorHttpOptions, "receiveEvent">,
): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const url = new URL(request.url);
    const route = /^\/events\/([^/]+)$/.exec(
      url.pathname.startsWith(`${CONNECTOR_HTTP_PREFIX}/`)
        ? url.pathname.slice(CONNECTOR_HTTP_PREFIX.length)
        : "",
    );
    if (!route) return undefined;
    try {
      if (request.method !== "POST") return methodNotAllowed("POST");
      const authority = authoritySchema.safeParse(
        decodeURIComponent(route[1]!),
      );
      if (!authority.success || !options.receiveEvent)
        return connectorReply(
          { error: "not-found", message: "Unknown event authority." },
          404,
        );
      const response = await options.receiveEvent({
        authority: authority.data,
        request,
      });
      // The receiver decides the status; the body it returns is its own
      // sanitized acknowledgement, never an echo of the delivery.
      const copy = new Headers(response.headers);
      copy.set("cache-control", "no-store");
      return new Response(response.body, {
        status: response.status,
        headers: copy,
      });
    } catch {
      return connectorReply(
        { error: "invalid-request", message: "The delivery was not accepted." },
        400,
      );
    }
  };
}

export function createConnectorHttp(
  service: ConnectorCommandService,
  options: ConnectorHttpOptions,
): ConnectorHttpHandler {
  if (new URL(options.origin).origin !== options.origin)
    throw new Error("Connector HTTP origin must be an exact origin");
  if (options.origin !== service.origin)
    throw new Error("Connector HTTP origin must match the command service");
  const returnPath = returnPathSchema.parse(
    options.returnPath ?? DEFAULT_RETURN_PATH,
  );
  const maxBytes = options.maxBodyBytes ?? 262_144;
  const importBytes = DEFINITION_LIMITS.bytes + 65_536;
  const limit = options.rateLimit?.limit ?? 120;
  const windowMs = options.rateLimit?.windowMs ?? 60_000;
  const events = createConnectorEventsHttp(options);
  const returnTo = (query: Record<string, string>) => {
    const location = new URL(returnPath, options.origin);
    for (const [name, value] of Object.entries(query))
      location.searchParams.set(name, value);
    return new Response(null, {
      status: 303,
      headers: { ...headers, location: location.href },
    });
  };

  return async (request, actor) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith(`${CONNECTOR_HTTP_PREFIX}/`)) return undefined;
    const path = url.pathname.slice(CONNECTOR_HTTP_PREFIX.length);
    try {
      if (path.startsWith("/events/")) return await events(request);
      const isImport = path === "/import";
      assertRequestBoundary(request, {
        origin: options.origin,
        maxBytes: isImport ? importBytes : maxBytes,
      });
      if (request.method !== "GET" && request.method !== "POST")
        return methodNotAllowed("GET, POST");
      await reserveRequest(options.store, actor, limit, windowMs);
      const post = request.method === "POST";

      if (path === "/callback") {
        if (post) return methodNotAllowed("GET");
        try {
          const view = await service.callback(actor, url);
          return returnTo({
            connection: view.connectionRef,
            outcome: view.lifecycle,
          });
        } catch (error) {
          const explained = explainConnectorError(error);
          return returnTo({
            outcome: explained.code,
            ...(explained.detail ? { detail: explained.detail } : {}),
          });
        }
      }

      const body = post
        ? await boundedJson(request, isImport ? importBytes : maxBytes)
        : undefined;

      if (path === "/catalog")
        return post
          ? methodNotAllowed("GET")
          : connectorReply({ entries: await service.catalog(actor) });
      if (path === "/definitions")
        return post
          ? methodNotAllowed("GET")
          : connectorReply({
              definitions: await service.listDefinitions(actor),
            });
      const definition = /^\/definitions\/([^/]+)$/.exec(path);
      if (definition)
        return post
          ? methodNotAllowed("GET")
          : connectorReply(
              await service.getDefinition(actor, segment(definition[1]!)),
            );
      if (path === "/import")
        return post
          ? connectorReply(await service.import(actor, body))
          : methodNotAllowed("POST");
      if (path === "/bindings")
        return post
          ? connectorReply(await service.approveBinding(actor, body), 201)
          : connectorReply({ bindings: await service.listBindings(actor) });
      if (path === "/configure")
        return post
          ? connectorReply(await service.configure(actor, body))
          : methodNotAllowed("POST");
      if (path === "/connections") {
        if (post)
          return connectorReply(await service.connect(actor, body), 201);
        const filter = z
          .strictObject({
            ecosystem: z
              .string()
              .regex(/^[a-z][a-z0-9-]{0,63}$/)
              .optional(),
            bindingRef: referenceSchema.optional(),
            lifecycle: connectionLifecycleSchema.optional(),
          })
          .parse(Object.fromEntries(url.searchParams));
        return connectorReply({
          connections: await service.listConnections(actor, {
            ...(filter.ecosystem ? { ecosystem: filter.ecosystem } : {}),
            ...(filter.bindingRef ? { bindingRef: filter.bindingRef } : {}),
            ...(filter.lifecycle ? { lifecycle: filter.lifecycle } : {}),
          }),
        });
      }
      const input = /^\/connections\/([^/]+)\/handoffs\/([^/]+)\/input$/.exec(
        path,
      );
      if (input) {
        if (!post) return methodNotAllowed("POST");
        const values = z.strictObject({ values: z.unknown() }).parse(body);
        return connectorReply(
          await service.provideInput(
            actor,
            segment(input[1]!),
            segment(input[2]!),
            values.values,
          ),
        );
      }
      const connection =
        /^\/connections\/([^/]+)(?:\/(poll|verify|reconnect|disconnect|invoke|revoke|delete|cancel))?$/.exec(
          path,
        );
      if (connection) {
        const ref = segment(connection[1]!);
        const action = connection[2];
        if (!action)
          return post
            ? methodNotAllowed("GET")
            : connectorReply(await service.status(actor, ref));
        if (!post) return methodNotAllowed("POST");
        switch (action) {
          case "poll":
            z.strictObject({}).parse(body ?? {});
            return connectorReply(await service.poll(actor, ref));
          case "verify":
            z.strictObject({}).parse(body ?? {});
            return connectorReply(await service.verify(actor, ref));
          case "cancel":
            z.strictObject({}).parse(body ?? {});
            return connectorReply(await service.cancelPending(actor, ref));
          case "reconnect":
            return connectorReply(await service.reconnect(actor, ref, body));
          case "disconnect":
            return connectorReply(await service.disconnect(actor, ref, body));
          case "invoke":
            return connectorReply(await service.invoke(actor, ref, body));
          case "revoke":
            return connectorReply(await service.revoke(actor, ref, body));
          case "delete":
            return connectorReply(await service.delete(actor, ref, body));
        }
      }
      return connectorReply(
        { error: "not-found", message: "Unknown connector route." },
        404,
      );
    } catch (error) {
      return connectorErrorResponse(error);
    }
  };
}

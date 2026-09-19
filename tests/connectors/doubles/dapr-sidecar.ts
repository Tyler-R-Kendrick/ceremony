import { startHttpFixture } from "./http-fixture.js";

/*
 * An independent Dapr sidecar.
 *
 * Written from the Dapr bindings API reference and the API-token operations
 * page (docs.dapr.io, runtime v1.18), not from the adapter. It implements the
 * documented output-binding route `POST /v1.0/bindings/<name>` with a body of
 * `{ data, metadata, operation }`, enforces the `dapr-api-token` header when a
 * token is configured, and answers with the documented status codes: 200 with
 * a body, 204 empty, 400 malformed, 500 failed.
 *
 * It knows nothing about Ceremony's bindings, so a request it accepts is a
 * request a real sidecar would accept.
 */

export type SidecarComponent = {
  name: string;
  /** Verbs this component implements; anything else is a malformed request. */
  operations: string[];
  /** Reply for a successful invocation; absent means 204. */
  reply?: unknown;
  /** Force a failure status for this component. */
  failWith?: number;
};

export type DaprSidecarFixtureOptions = {
  components: SidecarComponent[];
  /** Token the sidecar demands in `dapr-api-token`; omit for an unauthenticated sidecar. */
  apiToken?: string;
};

export async function startDaprSidecarFixture(
  options: DaprSidecarFixtureOptions,
) {
  const components = new Map(
    options.components.map((component) => [component.name, component]),
  );
  const invocations: Array<{
    name: string;
    operation: unknown;
    data: unknown;
    metadata: unknown;
  }> = [];

  const fixture = await startHttpFixture((request) => {
    if (options.apiToken !== undefined) {
      const presented = request.headers["dapr-api-token"];
      if (presented !== options.apiToken)
        return { status: 401, body: { error: "invalid api token" } };
    }
    const match = /^\/v1\.0\/bindings\/([^/]+)$/.exec(request.url.pathname);
    if (!match) return { status: 404, body: { error: "not found" } };
    if (request.method !== "POST" && request.method !== "PUT")
      return { status: 405, body: { error: "method not allowed" } };
    const name = decodeURIComponent(match[1]!);
    const component = components.get(name);
    if (!component)
      return { status: 404, body: { error: "component not found" } };
    let body: { data?: unknown; metadata?: unknown; operation?: unknown };
    try {
      body = JSON.parse(request.body.toString("utf8")) as typeof body;
    } catch {
      return { status: 400, body: { error: "malformed request" } };
    }
    if (
      typeof body.operation !== "string" ||
      !component.operations.includes(body.operation)
    )
      return { status: 400, body: { error: "unsupported operation" } };
    invocations.push({
      name,
      operation: body.operation,
      data: body.data,
      metadata: body.metadata,
    });
    if (component.failWith)
      return { status: component.failWith, body: { error: "binding failed" } };
    if (component.reply === undefined) return { status: 204 };
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: component.reply as Record<string, unknown>,
    };
  });

  return {
    origin: fixture.origin,
    requests: fixture.requests,
    invocations,
    tokensSeen(): Array<string | undefined> {
      return fixture.requests.map(
        (request) => request.headers["dapr-api-token"],
      );
    },
    close: fixture.close,
  };
}

/*
 * The other direction: what a real sidecar sends to an application for an
 * input binding. Dapr probes `OPTIONS /<name>` and then POSTs deliveries to
 * `/<name>`, adding `dapr-api-token: <APP_API_TOKEN>` when one is configured.
 * These builders produce exactly that so a receiver test never asks the
 * implementation what a delivery looks like.
 */
export function daprInputDelivery(input: {
  bindingName: string;
  payload: unknown;
  appApiToken?: string;
  receivedAt: number;
  traceparent?: string;
}): { headers: Headers; body: Uint8Array; receivedAt: number; path: string } {
  const headers = new Headers({ "content-type": "application/json" });
  if (input.appApiToken !== undefined)
    headers.set("dapr-api-token", input.appApiToken);
  if (input.traceparent) headers.set("traceparent", input.traceparent);
  return {
    headers,
    body: new TextEncoder().encode(JSON.stringify(input.payload)),
    receivedAt: input.receivedAt,
    path: `/${input.bindingName}`,
  };
}

/** The startup subscription probe a sidecar sends before any delivery. */
export function daprInputProbe(bindingName: string): {
  method: "OPTIONS";
  path: string;
} {
  return { method: "OPTIONS", path: `/${bindingName}` };
}

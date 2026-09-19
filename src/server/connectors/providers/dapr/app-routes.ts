import { daprComponentNameSchema } from "./schemas.js";

/*
 * The application side of a Dapr input binding.
 *
 * Dapr's sidecar-to-application leg is not the shared webhook route table.
 * The sidecar addresses the app by URL path: it probes `OPTIONS /<name>` once
 * at startup, reads 404 as "this app does not subscribe" and 2xx or 405 as
 * "it does", and then POSTs each delivery to `/<name>`. So the app has to
 * expose paths of its own, and this is them.
 *
 * The invariant this module exists to hold: **the route decides the
 * component, never the request.** A delivery carries no trustworthy statement
 * of which binding it belongs to -- a header naming one is attacker-written
 * data, and the app API token is a single shared bearer token across every
 * binding, so possessing it does not establish which component is speaking.
 * If the request could name its own component, anyone who learned the token
 * for a low-value binding could deliver into a high-value one. The mapping
 * from path to component is therefore fixed when the host builds the routes,
 * and nothing in a request can reach it.
 *
 * A path segment is matched literally against that table. It is never decoded
 * into a component name, never used to build one, and an unknown segment is
 * a 404 rather than a lookup, so the table cannot be walked.
 *
 * Authentication is not done here. Verifying `dapr-api-token` is the
 * receiver's job (`createDaprVendorVerifier`), and keeping the two apart is
 * deliberate: this module decides *what* a delivery is for, the receiver
 * decides *whether* to believe it, and neither can be talked out of its half.
 */

/** One host route and the approved input binding it stands for. */
export type DaprAppRoute = {
  /**
   * The single path segment the sidecar addresses, without slashes. Usually
   * the component name, but a host may publish a different one; the mapping
   * is what matters, not the spelling.
   */
  segment: string;
  /** The Dapr component this route delivers into. */
  component: string;
};

export type DaprAppRoutesOptions = {
  /** Where the routes hang, without a trailing slash. */
  mountPath?: string;
  routes: readonly DaprAppRoute[];
  /**
   * Hands one delivery to the host's receiver with the component the route
   * resolved. The receiver authenticates it and answers; whatever it returns
   * is passed through, because only it knows what it accepted.
   */
  receive(input: {
    component: string;
    request: Request;
  }): Promise<Response> | Response;
};

const DEFAULT_MOUNT = "/dapr/input";
const segmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

const noStore = { "cache-control": "no-store" } as const;

/**
 * Builds the app-side handler. Returns `undefined` for a request outside the
 * mount, so a host can chain it with its other routes.
 */
export function createDaprAppRoutes(
  options: DaprAppRoutesOptions,
): (request: Request) => Promise<Response | undefined> {
  const mountPath = (options.mountPath ?? DEFAULT_MOUNT).replace(/\/+$/, "");
  if (!mountPath.startsWith("/") || mountPath.includes("//"))
    throw new Error("Dapr app mount must be an absolute path");

  // Resolved once, at construction: a route table that could change per
  // request would be a route table a request could influence.
  const table = new Map<string, string>();
  for (const route of options.routes) {
    if (!segmentPattern.test(route.segment))
      throw new Error("Dapr app route segment is not a single path segment");
    const component = daprComponentNameSchema.parse(route.component);
    if (table.has(route.segment))
      throw new Error("Duplicate Dapr app route segment");
    table.set(route.segment, component);
  }

  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== mountPath && !url.pathname.startsWith(`${mountPath}/`))
      return undefined;
    const rest = url.pathname.slice(mountPath.length);
    // Exactly one segment. A nested path is not a binding this app serves,
    // and treating it as one would let a deeper path reach a shallower route.
    const segment = rest.startsWith("/") ? rest.slice(1) : rest;
    if (segment === "" || segment.includes("/"))
      return new Response(null, { status: 404, headers: noStore });

    const component = table.get(segment);
    // Unknown segment: 404 is both the honest answer and the one the sidecar
    // reads as "this app does not subscribe", so an unapproved binding is
    // declined at startup rather than after a delivery has been attempted.
    if (!component)
      return new Response(null, { status: 404, headers: noStore });

    if (request.method === "OPTIONS")
      return new Response(null, {
        status: 200,
        headers: { ...noStore, allow: "OPTIONS, POST" },
      });
    if (request.method !== "POST")
      return new Response(null, {
        status: 405,
        headers: { ...noStore, allow: "OPTIONS, POST" },
      });

    const response = await options.receive({ component, request });
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  };
}

import createClient from "openapi-fetch";
import type { components, paths } from "./generated/connectors.js";

/*
 * A third-party TypeScript client of the connector API, written the way a
 * consumer would write one: against types generated from the published
 * OpenAPI description by openapi-typescript, through openapi-fetch, with no
 * import from this repository's source. `./generated/` does not exist until
 * tests/openapi-client.test.ts generates it, which is why this directory is
 * outside the repository's own tsconfig and type-checked by that test instead.
 *
 * Nothing here is cast. If the description drifts from what this file does
 * with it -- a renamed field, a response that loses a status, a header that
 * stops being required -- the type-check fails before a request is sent.
 */

export type Connection = components["schemas"]["ConnectionView"];
export type HumanConnection = components["schemas"]["HumanConnectionView"];
type Lifecycle = components["schemas"]["ConnectionView"]["lifecycle"];
type ErrorCode = components["schemas"]["ErrorBody"]["error"];

/** A refusal, carrying the documented code and nothing a caller should branch on besides it. */
export class ConnectorApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | undefined,
  ) {
    super(`connector API answered ${status} ${code ?? "(no code)"}`);
  }
}

function refused(response: Response, error: { error?: ErrorCode }): never {
  throw new ConnectorApiError(response.status, error.error);
}

export type ConnectorClientOptions = {
  baseUrl: string;
  /** The deployment's origin, sent as the required `Origin` header on every POST. */
  origin: string;
  /** The deployment's session cookie; these routes take no bearer token. */
  cookie: string;
  fetch?: (request: Request) => Promise<Response>;
};

export function connectorClient(options: ConnectorClientOptions) {
  const client = createClient<paths>({
    baseUrl: options.baseUrl,
    headers: { cookie: options.cookie },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const header = { Origin: options.origin };

  return {
    async catalog() {
      const { data, error, response } = await client.GET(
        "/api/v1/connectors/catalog",
      );
      if (error) refused(response, error);
      return data.entries;
    },

    async importDocument(text: string, mediaType = "application/json") {
      const { data, error, response } = await client.POST(
        "/api/v1/connectors/import",
        {
          params: { header },
          body: { kind: "upload", mediaType, text },
        },
      );
      if (error) refused(response, error);
      return data.definitions;
    },

    /** A reference contains `/` and `:`; the client percent-encodes it into the path. */
    async definition(definitionRef: string) {
      const { data, error, response } = await client.GET(
        "/api/v1/connectors/definitions/{definitionRef}",
        { params: { path: { definitionRef } } },
      );
      if (error) refused(response, error);
      return data;
    },

    async approve(
      definitionRef: string,
      adapterId: string,
      approvals: components["schemas"]["BindingApprovalRequest"]["approvals"],
    ) {
      const { data, error, response } = await client.POST(
        "/api/v1/connectors/bindings",
        { params: { header }, body: { definitionRef, adapterId, approvals } },
      );
      if (error) refused(response, error);
      return data;
    },

    async bindings() {
      const { data, error, response } = await client.GET(
        "/api/v1/connectors/bindings",
      );
      if (error) refused(response, error);
      return data.bindings;
    },

    async connect(bindingRef: string, profileId: string) {
      const { data, error, response } = await client.POST(
        "/api/v1/connectors/connections",
        {
          params: { header },
          body: {
            bindingRef,
            intent: { profileId, requestedPermissions: ["read"] },
          },
        },
      );
      if (error) refused(response, error);
      return data;
    },

    async connections(lifecycle?: Lifecycle) {
      const { data, error, response } = await client.GET(
        "/api/v1/connectors/connections",
        { params: { query: lifecycle ? { lifecycle } : {} } },
      );
      if (error) refused(response, error);
      return data.connections;
    },

    /** An unknown reference is an answer, not an exception: the documented 404 narrows to `not-found`. */
    async connection(
      connectionRef: string,
    ): Promise<
      { found: true; connection: Connection } | { found: false; code: string }
    > {
      const { data, error, response } = await client.GET(
        "/api/v1/connectors/connections/{connectionRef}",
        { params: { path: { connectionRef } } },
      );
      if (data) return { found: true, connection: data };
      if (response.status === 404)
        return { found: false, code: error?.error ?? "not-found" };
      refused(response, error ?? {});
    },

    async invoke(
      connectionRef: string,
      operationRef: string,
      input: Record<string, unknown>,
      commandId: string,
    ) {
      const { data, error, response } = await client.POST(
        "/api/v1/connectors/connections/{connectionRef}/invoke",
        {
          params: { header, path: { connectionRef } },
          body: { operationRef, input, commandId },
        },
      );
      if (error) refused(response, error);
      return data;
    },
  };
}

/** The person's projection carries `presentation`; the assistant's never does. */
export function isHumanView(
  connection: Connection,
): connection is HumanConnection {
  return !("verified" in connection);
}

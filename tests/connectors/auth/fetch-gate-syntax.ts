import ts from "typescript";

/*
 * The gate's vocabulary: which libraries are gated, what the bounded transport
 * is, how large a ceiling may be, and what counts as reading a body.
 */

export const GATED = ["oauth4webapi", "jose"] as const;
export type NetworkExports = Record<string, Record<string, number[]>>;

/**
 * The bounded transport, by the file that declares each export. A response
 * bounder reads one answer under a ceiling, a fetch builder returns a fetch
 * whose answers it bounds, an options builder returns OAuth options carrying
 * such a fetch, and the reader is the one place a body is read under a
 * ceiling. A use counts only when it resolves (through any import or alias)
 * to the declaration named here.
 */
export type Kind = "response" | "fetch" | "options" | "reader";
export const REGISTRY: Record<string, Record<string, Kind>> = {
  "src/core/bounded-body.ts": { readBoundedBytes: "reader" },
  "src/server/connectors/auth/response-bound.ts": { boundResponse: "response" },
  "src/server/connectors/auth/wire.ts": {
    wireFetch: "fetch",
    requestOptions: "options",
  },
  "src/server/public-auth-fetch.ts": { boundedAuthFetch: "fetch" },
};

/** The OAuth ceiling, and the most any ceiling handed to the reader may be unless it is named below. */
export const MAX_CEILING = 1_048_576;

/**
 * Ceilings larger than the OAuth one, each a constant declared in its file and
 * held to the size its documentation gives. A body read under one of these is
 * data (a provider's records, an imported document), never a credential.
 */
export const NAMED_CEILINGS: Record<string, Record<string, number>> = {
  // docs/live-auth.md, Bounds: the Airbyte, Merge and Hasura NDC bodies (4, 8 and 8 MiB).
  "src/server/connectors/providers/airbyte/adapter.ts": {
    MAX_BODY_BYTES: 4 * 1024 * 1024,
  },
  "src/server/connectors/providers/merge/adapter.ts": {
    MAX_BODY_BYTES: 8 * 1024 * 1024,
  },
  "src/server/connectors/providers/hasura-ndc/adapter.ts": {
    MAX_BODY_BYTES: 8 * 1024 * 1024,
  },
  // docs/live-auth.md, Bounds: an Open Service Broker catalog (4 MiB).
  "src/server/connectors/providers/open-service-broker/client.ts": {
    maxCatalogBytes: 4 * 1024 * 1024,
  },
};

/** Members that read a body. */
export const READERS = new Set([
  "json",
  "text",
  "arrayBuffer",
  "blob",
  "formData",
  "bytes",
]);

export type State = "bounded" | "none" | "unbounded";
export const merge = (a: State, b: State): State => (a === b ? a : "unbounded");

export function unwrap(node: ts.Node): ts.Node {
  let current = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAwaitExpression(current) ||
      ts.isTypeAssertionExpression(current)
    )
      current = current.expression;
    else return current;
  }
}

/** A member name, for `a.b` and `a["b"]`; undefined for a computed one. */
export function memberName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression)
  )
    return node.argumentExpression.text;
  return undefined;
}

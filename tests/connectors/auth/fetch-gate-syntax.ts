import { dirname, join, normalize } from "node:path";
import ts from "typescript";

/* The gate's vocabulary: what is trusted, what counts as a body read, and small helpers over the tree. */

export type Source = { file: string; text: string };
export type NetworkExports = Record<string, Record<string, number[]>>;

export const GATED = ["oauth4webapi", "jose"];

/** What each registered export of the bounded transport is: a response bounder, a fetch builder or an options builder. */
export const REGISTRY: Record<
  string,
  Record<string, "response" | "fetch" | "options">
> = {
  "src/server/connectors/auth/response-bound.ts": { boundResponse: "response" },
  "src/server/connectors/auth/wire.ts": {
    wireFetch: "fetch",
    requestOptions: "options",
  },
  "src/server/public-auth-fetch.ts": { boundedAuthFetch: "fetch" },
};

export const READERS = new Set([
  "json",
  "text",
  "arrayBuffer",
  "blob",
  "formData",
  "bytes",
  "getReader",
]);

export type Kind = "response" | "fetch" | "options";
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
      ts.isAwaitExpression(current)
    )
      current = current.expression;
    else return current;
  }
}

/** Resolves a relative import specifier to the repository path it names. */
export function resolveImport(file: string, specifier: string): string {
  const target = normalize(join(dirname(file), specifier));
  return target.replace(/\.js$/, ".ts");
}

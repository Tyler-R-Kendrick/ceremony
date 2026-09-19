import { IssueCollector, pointer as jsonPointer } from "./issues.js";

/*
 * Bounded reference resolution. A document may point anywhere inside itself
 * and, through a host-supplied hook, at other documents; it may also point in
 * circles. Everything here counts nodes against a budget, follows `$ref`
 * chains for a fixed number of hops, refuses fragment forms it does not
 * implement, and never fetches anything itself: the hook decides what "fetch"
 * means and applies the deployment's network policy.
 */

export type ExternalResolver = (
  ref: string,
  context: { from: string | undefined },
) => Promise<unknown | undefined>;

export interface ReferenceLimits {
  /** Total nodes visited across every walk of one read. */
  maxNodes: number;
  /** Maximum nesting depth of any walked structure. */
  maxDepth: number;
  /** External documents the prefetch may request through the hook. */
  maxExternalDocuments: number;
  /** `$ref` hops followed from one value before the chain is declared cyclic or too long. */
  maxRefChain: number;
}

export const DEFAULT_REFERENCE_LIMITS: ReferenceLimits = Object.freeze({
  maxNodes: 250_000,
  maxDepth: 64,
  maxExternalDocuments: 32,
  maxRefChain: 32,
});

export class ReferenceBudgetExceeded extends Error {
  constructor(readonly limit: keyof ReferenceLimits) {
    super(`Reference budget exceeded: ${limit}`);
    this.name = "ReferenceBudgetExceeded";
  }
}

const reservedKeys = new Set(["__proto__", "prototype", "constructor"]);
const SEPARATOR = String.fromCharCode(0);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Own, non-reserved entries of an object in source order. */
export function entriesOf(value: Record<string, unknown>): [string, unknown][] {
  return Object.keys(value)
    .filter((key) => !reservedKeys.has(key))
    .map((key) => [key, value[key]]);
}

export function splitReference(ref: string): {
  uri: string;
  fragment: string;
} {
  const index = ref.indexOf("#");
  if (index < 0) return { uri: ref, fragment: "" };
  return { uri: ref.slice(0, index), fragment: ref.slice(index + 1) };
}

/** RFC 6901 pointer tokens from a URI fragment; undefined for plain-name anchors and malformed input. */
export function parsePointer(fragment: string): string[] | undefined {
  if (fragment === "") return [];
  if (!fragment.startsWith("/")) return undefined;
  let decoded = fragment;
  try {
    decoded = decodeURIComponent(fragment);
  } catch {
    return undefined;
  }
  return decoded
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

export function lookupPointer(
  root: unknown,
  tokens: readonly string[],
): { found: boolean; value: unknown } {
  let current: unknown = root;
  for (const tokenValue of tokens) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(tokenValue))
        return { found: false, value: undefined };
      const index = Number(tokenValue);
      if (index >= current.length) return { found: false, value: undefined };
      current = current[index];
    } else if (isRecord(current)) {
      if (reservedKeys.has(tokenValue) || !Object.hasOwn(current, tokenValue))
        return { found: false, value: undefined };
      current = current[tokenValue];
    } else return { found: false, value: undefined };
  }
  return { found: true, value: current };
}

export interface Resolved<T = unknown> {
  value: T;
  /** Key of the document holding the value: "" for the root document. */
  documentKey: string;
  /** JSON pointer of the value inside that document when it was reached by reference. */
  pointer: string;
  /** Reference strings followed, in order. */
  chain: string[];
}

export type ReferenceFailure =
  | { kind: "missing"; ref: string }
  | { kind: "unsupported-fragment"; ref: string }
  | { kind: "external-unavailable"; ref: string }
  | { kind: "cycle"; ref: string }
  | { kind: "too-deep"; ref: string };

export const externalKey = (from: string, uri: string) =>
  `${from}${SEPARATOR}${uri}`;

/**
 * Walks a structure iteratively with depth and node bounds. The visitor
 * returns false to stop descending into a value. Reserved keys are skipped so
 * a document cannot smuggle a prototype into anything built from the walk.
 */
export function boundedWalk(
  root: unknown,
  limits: ReferenceLimits,
  counter: { nodes: number },
  visitor: (
    value: unknown,
    path: readonly (string | number)[],
    depth: number,
  ) => boolean | void,
): void {
  const stack: Array<{
    value: unknown;
    path: readonly (string | number)[];
    depth: number;
  }> = [{ value: root, path: [], depth: 0 }];
  while (stack.length) {
    const item = stack.pop()!;
    counter.nodes++;
    if (counter.nodes > limits.maxNodes)
      throw new ReferenceBudgetExceeded("maxNodes");
    if (item.depth > limits.maxDepth)
      throw new ReferenceBudgetExceeded("maxDepth");
    if (visitor(item.value, item.path, item.depth) === false) continue;
    if (Array.isArray(item.value)) {
      for (let index = item.value.length - 1; index >= 0; index--)
        stack.push({
          value: item.value[index],
          path: [...item.path, index],
          depth: item.depth + 1,
        });
    } else if (isRecord(item.value)) {
      const entries = entriesOf(item.value);
      for (let index = entries.length - 1; index >= 0; index--) {
        const [key, value] = entries[index]!;
        stack.push({
          value,
          path: [...item.path, key],
          depth: item.depth + 1,
        });
      }
    }
  }
}

export class ReferenceResolver {
  readonly counter = { nodes: 0 };
  constructor(
    readonly root: unknown,
    readonly external: ReadonlyMap<string, unknown>,
    readonly limits: ReferenceLimits,
    readonly issues: IssueCollector,
  ) {}

  visit(count = 1): void {
    this.counter.nodes += count;
    if (this.counter.nodes > this.limits.maxNodes)
      throw new ReferenceBudgetExceeded("maxNodes");
  }

  isReference(
    value: unknown,
  ): value is Record<string, unknown> & { $ref: string } {
    return isRecord(value) && typeof value.$ref === "string";
  }

  private document(key: string): unknown {
    return key === "" ? this.root : this.external.get(key);
  }

  /** One hop: the value a reference string names, relative to the document it appears in. */
  lookup(
    ref: string,
    fromDocument: string,
  ):
    | { ok: true; resolved: Resolved }
    | { ok: false; failure: ReferenceFailure } {
    this.visit();
    const { uri, fragment } = splitReference(ref);
    const tokens = parsePointer(fragment);
    if (tokens === undefined)
      return { ok: false, failure: { kind: "unsupported-fragment", ref } };
    const documentKey =
      uri === "" ? fromDocument : externalKey(fromDocument, uri);
    if (uri !== "" && !this.external.has(documentKey))
      return { ok: false, failure: { kind: "external-unavailable", ref } };
    const result = lookupPointer(this.document(documentKey), tokens);
    if (!result.found) return { ok: false, failure: { kind: "missing", ref } };
    return {
      ok: true,
      resolved: {
        value: result.value,
        documentKey,
        pointer: jsonPointer(...tokens),
        chain: [ref],
      },
    };
  }

  /**
   * Follows `$ref` chains from a value until a non-reference is reached. The
   * caller decides what sibling keywords beside `$ref` mean for its version.
   */
  resolve(
    value: unknown,
    from: { documentKey: string; pointer: string },
  ):
    | { ok: true; resolved: Resolved }
    | { ok: false; failure: ReferenceFailure } {
    let current = value;
    let documentKey = from.documentKey;
    let pointerHere = from.pointer;
    const chain: string[] = [];
    const seen = new Set<string>();
    while (this.isReference(current)) {
      const ref = current.$ref;
      const key = `${documentKey}${SEPARATOR}${ref}`;
      if (seen.has(key)) return { ok: false, failure: { kind: "cycle", ref } };
      seen.add(key);
      if (chain.length >= this.limits.maxRefChain)
        return { ok: false, failure: { kind: "too-deep", ref } };
      const hop = this.lookup(ref, documentKey);
      if (!hop.ok) return hop;
      chain.push(ref);
      current = hop.resolved.value;
      documentKey = hop.resolved.documentKey;
      pointerHere = hop.resolved.pointer;
    }
    return {
      ok: true,
      resolved: { value: current, documentKey, pointer: pointerHere, chain },
    };
  }
}

/**
 * Finds every external `$ref` reachable from the root (and from documents
 * the hook returns), asks the hook for each one once, and returns the bounded
 * set. The hook applies network policy; a refusal or failure becomes a
 * diagnostic, never an exception that hides the rest of the document.
 */
export async function prefetchExternalReferences(
  root: unknown,
  resolveExternal: ExternalResolver | undefined,
  limits: ReferenceLimits,
  issues: IssueCollector,
  counter: { nodes: number },
): Promise<Map<string, unknown>> {
  const documents = new Map<string, unknown>();
  const reported = new Set<string>();
  const queue: Array<{ document: unknown; from: string }> = [
    { document: root, from: "" },
  ];
  let fetched = 0;
  while (queue.length) {
    const { document, from } = queue.shift()!;
    const wanted: string[] = [];
    boundedWalk(document, limits, counter, (value) => {
      if (isRecord(value) && typeof value.$ref === "string") {
        const { uri } = splitReference(value.$ref);
        if (uri !== "" && !wanted.includes(uri)) wanted.push(uri);
      }
      return true;
    });
    for (const uri of wanted) {
      const key = externalKey(from, uri);
      if (documents.has(key)) continue;
      if (!resolveExternal) {
        if (!reported.has(key)) {
          reported.add(key);
          issues.add({
            code: "structure.external-reference-unresolved",
            category: "structure",
            pointer: "#",
            dimension: "import",
            severity: "warning",
            message:
              "The document references an external document and no external resolver was provided; constructs behind that reference are reported as unresolved.",
          });
        }
        continue;
      }
      if (fetched >= limits.maxExternalDocuments) {
        if (!reported.has("limit")) {
          reported.add("limit");
          issues.add({
            code: "structure.external-reference-limit",
            category: "structure",
            pointer: "#",
            dimension: "import",
            severity: "warning",
            message:
              "The document references more external documents than the import allows; further references are reported as unresolved.",
          });
        }
        continue;
      }
      fetched++;
      let value: unknown;
      try {
        value = await resolveExternal(uri, {
          from: from === "" ? undefined : from,
        });
      } catch {
        value = undefined;
      }
      if (value === undefined) {
        issues.add({
          code: "network.external-reference-unavailable",
          category: "network",
          pointer: "#",
          dimension: "import",
          severity: "warning",
          message:
            "An external reference could not be retrieved under the deployment's network policy; constructs behind it are reported as unresolved.",
        });
        continue;
      }
      documents.set(key, value);
      queue.push({ document: value, from: key });
    }
  }
  return documents;
}

import { isRecord } from "../openapi/refs.js";

/*
 * A deliberately small JSONPath subset, documented exactly as implemented.
 *
 * Supported:
 *   $                    the root node
 *   .name  ['name']      a child by name ("name" may be quoted with ' or ")
 *   ["name"]             the same, double-quoted
 *   .*     [*]           every child of an object or array
 *   ..name  ..['name']   recursive descent to children with that name
 *   ..*                  recursive descent to every descendant
 *   [0]                  an array element by index (non-negative only)
 *
 * Deliberately NOT supported, and refused rather than approximated:
 *   [?...] filters, [(...)] scripts, [a,b] unions, [start:end] slices,
 *   [-1] negative indexes, and any function extension. RFC 9535 defines
 *   these; a partial implementation of a selector that decides *which*
 *   endpoints an overlay rewrites is a security defect, so an unsupported
 *   selector produces a blocking diagnostic and the action is not applied.
 *
 * Every walk is bounded by a node budget, so recursive descent over a hostile
 * document cannot become unbounded work.
 */

export type Segment =
  | { kind: "name"; name: string }
  | { kind: "index"; index: number }
  | { kind: "wildcard" }
  | { kind: "descend-name"; name: string }
  | { kind: "descend-wildcard" };

export type ParseResult =
  | { ok: true; segments: Segment[] }
  | { ok: false; reason: string; at: number };

const NAME_START = /[A-Za-z_]/;
const NAME_PART = /[A-Za-z0-9_-]/;

export function parseJsonPath(expression: string): ParseResult {
  if (expression.length > 1024)
    return { ok: false, reason: "expression-too-long", at: 0 };
  if (!expression.startsWith("$"))
    return { ok: false, reason: "must-start-at-root", at: 0 };
  const segments: Segment[] = [];
  let index = 1;
  while (index < expression.length) {
    const character = expression[index];
    if (character === ".") {
      const descend = expression[index + 1] === ".";
      index += descend ? 2 : 1;
      if (expression[index] === "*") {
        segments.push(descend ? { kind: "descend-wildcard" } : { kind: "wildcard" });
        index += 1;
        continue;
      }
      if (expression[index] === "[") {
        // `..['name']` and `..[0]`: descend then apply the bracket selector.
        if (!descend) continue;
        const bracket = readBracket(expression, index);
        if (!bracket.ok) return bracket;
        if (bracket.segment.kind !== "name")
          return {
            ok: false,
            reason: "unsupported-descent-selector",
            at: index,
          };
        segments.push({ kind: "descend-name", name: bracket.segment.name });
        index = bracket.next;
        continue;
      }
      const start = index;
      if (index >= expression.length || !NAME_START.test(expression[index]!))
        return { ok: false, reason: "expected-name", at: index };
      while (index < expression.length && NAME_PART.test(expression[index]!)) index += 1;
      const name = expression.slice(start, index);
      segments.push(descend ? { kind: "descend-name", name } : { kind: "name", name });
      continue;
    }
    if (character === "[") {
      const bracket = readBracket(expression, index);
      if (!bracket.ok) return bracket;
      segments.push(bracket.segment);
      index = bracket.next;
      continue;
    }
    return { ok: false, reason: "unexpected-character", at: index };
  }
  if (segments.length > 64)
    return { ok: false, reason: "too-many-segments", at: 0 };
  return { ok: true, segments };
}

type BracketResult =
  | { ok: true; segment: Segment; next: number }
  | { ok: false; reason: string; at: number };

function readBracket(expression: string, start: number): BracketResult {
  let index = start + 1;
  if (index >= expression.length)
    return { ok: false, reason: "unterminated-bracket", at: start };
  const character = expression[index];
  if (character === "?")
    return { ok: false, reason: "filter-selector-unsupported", at: index };
  if (character === "(")
    return { ok: false, reason: "script-selector-unsupported", at: index };
  if (character === "*") {
    if (expression[index + 1] !== "]")
      return { ok: false, reason: "unterminated-bracket", at: index };
    return { ok: true, segment: { kind: "wildcard" }, next: index + 2 };
  }
  if (character === "'" || character === '"') {
    const quote = character;
    index += 1;
    let name = "";
    while (index < expression.length && expression[index] !== quote) {
      if (expression[index] === "\\") {
        const next = expression[index + 1];
        if (next === undefined)
          return { ok: false, reason: "unterminated-string", at: index };
        // Only the two escapes RFC 9535 requires for a quoted name.
        if (next === quote || next === "\\") {
          name += next;
          index += 2;
          continue;
        }
        return { ok: false, reason: "unsupported-escape", at: index };
      }
      name += expression[index];
      index += 1;
    }
    if (expression[index] !== quote)
      return { ok: false, reason: "unterminated-string", at: index };
    index += 1;
    if (expression[index] === ",")
      return { ok: false, reason: "union-selector-unsupported", at: index };
    if (expression[index] !== "]")
      return { ok: false, reason: "unterminated-bracket", at: index };
    return { ok: true, segment: { kind: "name", name }, next: index + 1 };
  }
  if (/[0-9]/.test(character ?? "")) {
    const digitsStart = index;
    while (index < expression.length && /[0-9]/.test(expression[index]!)) index += 1;
    if (expression[index] === ":")
      return { ok: false, reason: "slice-selector-unsupported", at: index };
    if (expression[index] === ",")
      return { ok: false, reason: "union-selector-unsupported", at: index };
    if (expression[index] !== "]")
      return { ok: false, reason: "unterminated-bracket", at: index };
    const digits = expression.slice(digitsStart, index);
    if (digits.length > 9)
      return { ok: false, reason: "index-too-large", at: digitsStart };
    return {
      ok: true,
      segment: { kind: "index", index: Number(digits) },
      next: index + 1,
    };
  }
  if (character === "-")
    return { ok: false, reason: "negative-index-unsupported", at: index };
  return { ok: false, reason: "unsupported-selector", at: index };
}

/** A located node: its parent container, the key inside it, and the value. */
export interface Match {
  /** Undefined only for the root node. */
  parent: unknown;
  key: string | number | undefined;
  value: unknown;
  /** Normalized path of the match, for provenance. */
  path: string;
}

export class SelectionBudgetExceeded extends Error {
  constructor() {
    super("Selection budget exceeded");
    this.name = "SelectionBudgetExceeded";
  }
}

const pathStep = (path: string, key: string | number): string =>
  typeof key === "number"
    ? `${path}[${key}]`
    : `${path}['${key.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}']`;

/**
 * Applies the parsed segments to a document. Node visits are charged against
 * `budget`; exceeding it throws rather than returning a partial selection,
 * because a partial selection of an overlay target silently changes what the
 * overlay does.
 */
export function selectNodes(
  root: unknown,
  segments: readonly Segment[],
  budget: { nodes: number; limit: number },
): Match[] {
  let current: Match[] = [{ parent: undefined, key: undefined, value: root, path: "$" }];
  const charge = () => {
    if (++budget.nodes > budget.limit) throw new SelectionBudgetExceeded();
  };
  for (const segment of segments) {
    const next: Match[] = [];
    for (const match of current) {
      charge();
      switch (segment.kind) {
        case "name": {
          if (isRecord(match.value) && Object.hasOwn(match.value, segment.name))
            next.push({
              parent: match.value,
              key: segment.name,
              value: match.value[segment.name],
              path: pathStep(match.path, segment.name),
            });
          break;
        }
        case "index": {
          if (Array.isArray(match.value) && segment.index < match.value.length)
            next.push({
              parent: match.value,
              key: segment.index,
              value: match.value[segment.index],
              path: pathStep(match.path, segment.index),
            });
          break;
        }
        case "wildcard": {
          if (Array.isArray(match.value))
            match.value.forEach((value, index) => {
              charge();
              next.push({
                parent: match.value,
                key: index,
                value,
                path: pathStep(match.path, index),
              });
            });
          else if (isRecord(match.value))
            for (const key of Object.keys(match.value)) {
              charge();
              next.push({
                parent: match.value,
                key,
                value: match.value[key],
                path: pathStep(match.path, key),
              });
            }
          break;
        }
        case "descend-name":
        case "descend-wildcard": {
          const stack: Match[] = [match];
          while (stack.length) {
            const item = stack.pop()!;
            charge();
            if (Array.isArray(item.value))
              item.value.forEach((value, index) => {
                const child: Match = {
                  parent: item.value,
                  key: index,
                  value,
                  path: pathStep(item.path, index),
                };
                if (segment.kind === "descend-wildcard") next.push(child);
                stack.push(child);
              });
            else if (isRecord(item.value))
              for (const key of Object.keys(item.value)) {
                const child: Match = {
                  parent: item.value,
                  key,
                  value: item.value[key],
                  path: pathStep(item.path, key),
                };
                if (
                  segment.kind === "descend-wildcard" ||
                  key === segment.name
                )
                  next.push(child);
                stack.push(child);
              }
          }
          break;
        }
      }
    }
    current = next;
    if (current.length > budget.limit) throw new SelectionBudgetExceeded();
  }
  return current;
}

/** The documented subset, as a sentence an operator can read in a diagnostic. */
export const SUPPORTED_SELECTOR_SYNTAX =
  "root ($), child by name (.name or ['name']), wildcard (.* or [*]), recursive descent (..name or ..*) and array index ([0])";

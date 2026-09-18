import { ARAZZO_LIMITS, type ArazzoVersion } from "./limits.js";

/*
 * Arazzo runtime expressions, parsed with string operations against the
 * 1.1.0 ABNF (a superset of 1.0.1 that also names the exact identifier
 * classes). Parsing classifies an expression; it never resolves one. Nothing
 * here touches a network, a file or the values an expression would read.
 */

export type ExpressionSource = "header" | "query" | "path" | "body" | "payload";
export type RuntimeExpression =
  | { kind: "url" | "method" | "statusCode" | "self" }
  | {
      kind: "request" | "response" | "message";
      source: ExpressionSource;
      name?: string;
      pointer?: string;
    }
  | { kind: "inputs" | "outputs"; name: string; pointer?: string }
  | { kind: "steps"; stepId: string; name: string; pointer?: string }
  | {
      kind: "workflows";
      workflowId: string;
      field: "inputs" | "outputs";
      name: string;
      pointer?: string;
    }
  | { kind: "sourceDescriptions"; source: string; reference: string }
  | {
      kind: "components";
      component: "parameters" | "successActions" | "failureActions";
      name: string;
    };

const IDENTIFIER_STRICT = /^[A-Za-z0-9_-]+$/;
const IDENTIFIER = /^[A-Za-z0-9._-]+$/;
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const CONTROL = /\p{Cc}/u;

export const identifierStrictPattern = IDENTIFIER_STRICT;
export const identifierPattern = IDENTIFIER;

/** RFC 6901 pointer text: "" or "/"-prefixed tokens with only ~0 and ~1 escapes. */
export function validJsonPointer(pointer: string, maxSegments = 64): boolean {
  if (pointer === "") return true;
  if (!pointer.startsWith("/") || CONTROL.test(pointer)) return false;
  const segments = pointer.slice(1).split("/");
  if (segments.length > maxSegments) return false;
  return segments.every((segment) => {
    for (let index = 0; index < segment.length; index++)
      if (segment[index] === "~") {
        const next = segment[index + 1];
        if (next !== "0" && next !== "1") return false;
        index++;
      }
    return true;
  });
}

function splitPointer(text: string): { head: string; pointer?: string } {
  const hash = text.indexOf("#");
  if (hash === -1) return { head: text };
  return { head: text.slice(0, hash), pointer: text.slice(hash + 1) };
}

function withPointer<T extends { pointer?: string }>(
  base: Omit<T, "pointer">,
  pointer: string | undefined,
): T | undefined {
  if (pointer === undefined) return base as T;
  if (!validJsonPointer(pointer)) return undefined;
  return { ...base, pointer } as T;
}

function parseSource(
  kind: "request" | "response" | "message",
  rest: string,
): RuntimeExpression | undefined {
  if (rest.startsWith("header.")) {
    const name = rest.slice("header.".length);
    return TOKEN.test(name) ? { kind, source: "header", name } : undefined;
  }
  for (const source of ["query", "path"] as const)
    if (rest.startsWith(`${source}.`)) {
      const name = rest.slice(source.length + 1);
      return name.length ? { kind, source, name } : undefined;
    }
  for (const source of ["body", "payload"] as const) {
    if (rest === source) return { kind, source };
    if (rest.startsWith(`${source}#`)) {
      const pointer = rest.slice(source.length + 1);
      return validJsonPointer(pointer) ? { kind, source, pointer } : undefined;
    }
  }
  return undefined;
}

/**
 * Parses one runtime expression. Returns undefined for anything that is not
 * a well-formed expression; callers decide whether that is a literal or an
 * error for the field in question.
 */
export function parseRuntimeExpression(
  text: unknown,
): RuntimeExpression | undefined {
  if (
    typeof text !== "string" ||
    !text.startsWith("$") ||
    text.length > ARAZZO_LIMITS.expression ||
    CONTROL.test(text)
  )
    return undefined;
  switch (text) {
    case "$url":
      return { kind: "url" };
    case "$method":
      return { kind: "method" };
    case "$statusCode":
      return { kind: "statusCode" };
    case "$self":
      return { kind: "self" };
    default:
      break;
  }
  for (const kind of ["request", "response", "message"] as const)
    if (text.startsWith(`$${kind}.`))
      return parseSource(kind, text.slice(kind.length + 2));
  for (const kind of ["inputs", "outputs"] as const)
    if (text.startsWith(`$${kind}.`)) {
      const { head, pointer } = splitPointer(text.slice(kind.length + 2));
      if (!IDENTIFIER.test(head)) return undefined;
      return withPointer<Extract<RuntimeExpression, { kind: "inputs" }>>(
        { kind, name: head },
        pointer,
      );
    }
  if (text.startsWith("$steps.")) {
    const { head, pointer } = splitPointer(text.slice("$steps.".length));
    const dot = head.indexOf(".");
    if (dot === -1) return undefined;
    const stepId = head.slice(0, dot);
    const remainder = head.slice(dot + 1);
    if (!IDENTIFIER_STRICT.test(stepId) || !remainder.startsWith("outputs."))
      return undefined;
    const name = remainder.slice("outputs.".length);
    if (!IDENTIFIER.test(name)) return undefined;
    return withPointer<Extract<RuntimeExpression, { kind: "steps" }>>(
      { kind: "steps", stepId, name },
      pointer,
    );
  }
  if (text.startsWith("$workflows.")) {
    const { head, pointer } = splitPointer(text.slice("$workflows.".length));
    const parts = head.split(".");
    const workflowId = parts[0] ?? "";
    const field = parts[1];
    const name = parts.slice(2).join(".");
    if (
      !IDENTIFIER_STRICT.test(workflowId) ||
      (field !== "inputs" && field !== "outputs") ||
      !IDENTIFIER.test(name)
    )
      return undefined;
    return withPointer<Extract<RuntimeExpression, { kind: "workflows" }>>(
      { kind: "workflows", workflowId, field, name },
      pointer,
    );
  }
  if (text.startsWith("$sourceDescriptions.")) {
    const rest = text.slice("$sourceDescriptions.".length);
    const dot = rest.indexOf(".");
    if (dot === -1) return undefined;
    const source = rest.slice(0, dot);
    const reference = rest.slice(dot + 1);
    if (!IDENTIFIER_STRICT.test(source) || !reference.length) return undefined;
    return { kind: "sourceDescriptions", source, reference };
  }
  if (text.startsWith("$components.")) {
    const rest = text.slice("$components.".length);
    for (const component of [
      "parameters",
      "successActions",
      "failureActions",
    ] as const)
      if (rest.startsWith(`${component}.`)) {
        const name = rest.slice(component.length + 1);
        return IDENTIFIER.test(name)
          ? { kind: "components", component, name }
          : undefined;
      }
    return undefined;
  }
  return undefined;
}

/** The Arazzo version that introduced an expression form. */
export function expressionSince(expression: RuntimeExpression): ArazzoVersion {
  if (expression.kind === "self" || expression.kind === "message")
    return "1.1.0";
  if (
    (expression.kind === "request" || expression.kind === "response") &&
    expression.source === "payload"
  )
    return "1.1.0";
  return "1.0.1";
}

/** A string value that the specification reads as an expression rather than a literal. */
export function looksLikeExpression(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("$");
}

export type EmbeddedExpressions = {
  expressions: Array<{ text: string; expression: RuntimeExpression }>;
  invalid: boolean;
};

/**
 * Finds `{$...}` templates in a literal string. Braces not opening an
 * expression are literal characters, which is how the specification's own
 * JSON-template examples read.
 */
export function embeddedExpressions(text: string): EmbeddedExpressions {
  const result: EmbeddedExpressions = { expressions: [], invalid: false };
  let index = text.indexOf("{$");
  while (index !== -1) {
    const end = text.indexOf("}", index);
    if (end === -1) {
      result.invalid = true;
      break;
    }
    const inner = text.slice(index + 1, end);
    const expression = parseRuntimeExpression(inner);
    if (!expression) {
      result.invalid = true;
      break;
    }
    result.expressions.push({ text: inner, expression });
    if (result.expressions.length > ARAZZO_LIMITS.evaluator.embedded) {
      result.invalid = true;
      break;
    }
    index = text.indexOf("{$", end + 1);
  }
  return result;
}

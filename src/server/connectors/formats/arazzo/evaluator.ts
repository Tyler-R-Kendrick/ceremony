import { canonicalConnectorJson } from "../../../../core/connectors/identity.js";
import { ARAZZO_LIMITS } from "./limits.js";
import {
  parseRuntimeExpression,
  type RuntimeExpression,
} from "./expressions.js";

/*
 * The bounded evaluator for Arazzo `simple` criteria. It is a hand-written
 * tokenizer, a recursive-descent parser with a depth budget and a tree
 * walker over an explicit context. There is no eval, no Function, no dynamic
 * import and no regular expression built from document text. Every value that
 * enters the evaluator carries a classification, and every result carries the
 * join of the classifications it was derived from: a comparison against a
 * secret is itself secret, so it can never be published as a public output.
 */

export type Classification =
  "public" | "artifact" | "personal" | "secret" | "unclassified";

const RANK: Record<Classification, number> = {
  public: 0,
  artifact: 1,
  personal: 2,
  secret: 3,
  unclassified: 4,
};

/** The most restrictive classification among its arguments; unknown is treated as most restrictive. */
export function joinClassification(
  ...items: readonly Classification[]
): Classification {
  let best: Classification = "public";
  for (const item of items) if (RANK[item] > RANK[best]) best = item;
  return best;
}

export type ClassifiedValue = {
  value: unknown;
  classification: Classification;
};

export interface EvaluationContext {
  inputs?: Readonly<Record<string, ClassifiedValue>>;
  outputs?: Readonly<Record<string, ClassifiedValue>>;
  steps?: Readonly<
    Record<string, { outputs: Readonly<Record<string, ClassifiedValue>> }>
  >;
  statusCode?: number;
  url?: string;
  method?: string;
  /** Matched case-insensitively, as RFC 9110 field names are. */
  responseHeaders?: Readonly<Record<string, string>>;
}

export type ConditionSyntaxCode =
  | "empty"
  | "too-long"
  | "too-many-tokens"
  | "too-deep"
  | "unexpected-character"
  | "unterminated-string"
  | "literal-too-long"
  | "invalid-number"
  | "invalid-expression"
  | "unexpected-token"
  | "unexpected-end"
  | "chained-comparison";

export class ConditionSyntaxError extends Error {
  constructor(
    readonly code: ConditionSyntaxCode,
    readonly position: number,
  ) {
    super(`Condition syntax error: ${code} at ${position}`);
    this.name = "ConditionSyntaxError";
  }
}

type ComparisonOperator = "==" | "!=" | "<" | "<=" | ">" | ">=";
type LogicalOperator = "&&" | "||";
type Operator = ComparisonOperator | LogicalOperator | "!";
type Literal = string | number | boolean | null;

type Token =
  | { type: "literal"; value: Literal; at: number }
  | {
      type: "reference";
      text: string;
      expression: RuntimeExpression;
      at: number;
    }
  | { type: "op"; value: Operator; at: number }
  | { type: "lparen"; at: number }
  | { type: "rparen"; at: number };

export type ConditionNode =
  | { type: "literal"; value: Literal }
  | { type: "reference"; expression: RuntimeExpression; text: string }
  | { type: "not"; operand: ConditionNode }
  | {
      type: "compare";
      operator: ComparisonOperator;
      left: ConditionNode;
      right: ConditionNode;
    }
  | {
      type: "logical";
      operator: LogicalOperator;
      left: ConditionNode;
      right: ConditionNode;
    };

export interface ParsedCondition {
  readonly source: string;
  readonly ast: ConditionNode;
  readonly references: ReadonlyArray<{
    text: string;
    expression: RuntimeExpression;
  }>;
}

const NUMERIC = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const EXPRESSION_CHARS = /^[A-Za-z0-9_.#/~%*+^`$-]$/;
const NUMBER_CHARS = /^[0-9.eE+-]$/;
const LETTER = /^[A-Za-z]$/;
const DIGIT = /^[0-9]$/;
const WHITESPACE = /^[ \t\r\n]$/;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const fail = (code: ConditionSyntaxCode, at: number): never => {
    throw new ConditionSyntaxError(code, at);
  };
  const push = (token: Token) => {
    tokens.push(token);
    if (tokens.length > ARAZZO_LIMITS.evaluator.tokens)
      fail("too-many-tokens", token.at);
  };
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    const at = index;
    if (WHITESPACE.test(char)) {
      index++;
      continue;
    }
    if (char === "(" || char === ")") {
      push({ type: char === "(" ? "lparen" : "rparen", at });
      index++;
      continue;
    }
    const pair = source.slice(index, index + 2);
    if (pair === "&&" || pair === "||" || pair === "==" || pair === "!=") {
      push({ type: "op", value: pair, at });
      index += 2;
      continue;
    }
    if (pair === "<=" || pair === ">=") {
      push({ type: "op", value: pair, at });
      index += 2;
      continue;
    }
    if (char === "<" || char === ">" || char === "!") {
      push({ type: "op", value: char, at });
      index++;
      continue;
    }
    if (char === "&" || char === "|" || char === "=")
      fail("unexpected-character", at);
    if (char === "'") {
      let value = "";
      index++;
      for (;;) {
        if (index >= source.length) fail("unterminated-string", at);
        const current = source[index]!;
        if (current === "'") {
          if (source[index + 1] === "'") {
            value += "'";
            index += 2;
            continue;
          }
          index++;
          break;
        }
        value += current;
        index++;
        if (value.length > ARAZZO_LIMITS.evaluator.literal)
          fail("literal-too-long", at);
      }
      push({ type: "literal", value, at });
      continue;
    }
    if (
      DIGIT.test(char) ||
      (char === "-" && DIGIT.test(source[index + 1] ?? ""))
    ) {
      let text = char;
      index++;
      while (index < source.length && NUMBER_CHARS.test(source[index]!)) {
        text += source[index]!;
        index++;
      }
      const value = Number(text);
      if (!NUMERIC.test(text) || !Number.isFinite(value))
        fail("invalid-number", at);
      push({ type: "literal", value, at });
      continue;
    }
    if (char === "$") {
      let text = char;
      index++;
      while (index < source.length && EXPRESSION_CHARS.test(source[index]!)) {
        text += source[index]!;
        index++;
      }
      const expression = parseRuntimeExpression(text);
      if (!expression) fail("invalid-expression", at);
      push({ type: "reference", text, expression: expression!, at });
      continue;
    }
    if (LETTER.test(char)) {
      let word = "";
      while (index < source.length && LETTER.test(source[index]!)) {
        word += source[index]!;
        index++;
      }
      if (word === "true" || word === "false")
        push({ type: "literal", value: word === "true", at });
      else if (word === "null") push({ type: "literal", value: null, at });
      else fail("unexpected-token", at);
      continue;
    }
    fail("unexpected-character", at);
  }
  return tokens;
}

class Parser {
  private index = 0;
  readonly references: Array<{ text: string; expression: RuntimeExpression }> =
    [];
  constructor(
    private readonly tokens: Token[],
    private readonly length: number,
  ) {}
  private peek(): Token | undefined {
    return this.tokens[this.index];
  }
  private next(): Token {
    const token = this.tokens[this.index];
    if (!token) throw new ConditionSyntaxError("unexpected-end", this.length);
    this.index++;
    return token;
  }
  private guard(depth: number, at: number) {
    if (depth > ARAZZO_LIMITS.evaluator.depth)
      throw new ConditionSyntaxError("too-deep", at);
  }
  parse(): ConditionNode {
    const node = this.parseOr(1);
    const extra = this.peek();
    if (extra) throw new ConditionSyntaxError("unexpected-token", extra.at);
    return node;
  }
  private parseOr(depth: number): ConditionNode {
    let left = this.parseAnd(depth);
    for (;;) {
      const token = this.peek();
      if (token?.type !== "op" || token.value !== "||") return left;
      this.next();
      left = {
        type: "logical",
        operator: "||",
        left,
        right: this.parseAnd(depth),
      };
    }
  }
  private parseAnd(depth: number): ConditionNode {
    let left = this.parseComparison(depth);
    for (;;) {
      const token = this.peek();
      if (token?.type !== "op" || token.value !== "&&") return left;
      this.next();
      left = {
        type: "logical",
        operator: "&&",
        left,
        right: this.parseComparison(depth),
      };
    }
  }
  private parseComparison(depth: number): ConditionNode {
    const left = this.parseUnary(depth);
    const token = this.peek();
    if (token?.type !== "op" || token.value === "!" || isLogical(token.value))
      return left;
    this.next();
    const right = this.parseUnary(depth);
    const after = this.peek();
    if (after?.type === "op" && !isLogical(after.value) && after.value !== "!")
      throw new ConditionSyntaxError("chained-comparison", after.at);
    return { type: "compare", operator: token.value, left, right };
  }
  private parseUnary(depth: number): ConditionNode {
    const token = this.peek();
    if (token?.type === "op" && token.value === "!") {
      this.guard(depth + 1, token.at);
      this.next();
      return { type: "not", operand: this.parseUnary(depth + 1) };
    }
    return this.parsePrimary(depth);
  }
  private parsePrimary(depth: number): ConditionNode {
    const token = this.next();
    if (token.type === "literal")
      return { type: "literal", value: token.value };
    if (token.type === "reference") {
      this.references.push({ text: token.text, expression: token.expression });
      return {
        type: "reference",
        expression: token.expression,
        text: token.text,
      };
    }
    if (token.type === "lparen") {
      this.guard(depth + 1, token.at);
      const inner = this.parseOr(depth + 1);
      const close = this.next();
      if (close.type !== "rparen")
        throw new ConditionSyntaxError("unexpected-token", close.at);
      return inner;
    }
    throw new ConditionSyntaxError("unexpected-token", token.at);
  }
}

function isLogical(value: Operator): value is LogicalOperator {
  return value === "&&" || value === "||";
}

/** Parses a simple condition; throws ConditionSyntaxError with a position, never document text. */
export function parseCondition(source: string): ParsedCondition {
  if (typeof source !== "string" || !source.trim())
    throw new ConditionSyntaxError("empty", 0);
  if (source.length > ARAZZO_LIMITS.condition)
    throw new ConditionSyntaxError("too-long", ARAZZO_LIMITS.condition);
  const tokens = tokenize(source);
  const parser = new Parser(tokens, source.length);
  const ast = parser.parse();
  return { source, ast, references: parser.references };
}

/** References the evaluator can resolve from an execution context. */
export function isEvaluableReference(expression: RuntimeExpression): boolean {
  switch (expression.kind) {
    case "url":
    case "method":
    case "statusCode":
    case "inputs":
    case "outputs":
    case "steps":
      return true;
    case "response":
      return expression.source === "header";
    default:
      return false;
  }
}

export type EvaluationFailure =
  | "unresolved-reference"
  | "unsupported-reference"
  | "incomparable"
  | "non-boolean"
  | "pointer-limit";

class EvaluationError extends Error {
  constructor(readonly reason: EvaluationFailure) {
    super(reason);
    this.name = "EvaluationError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function own<T>(
  record: Readonly<Record<string, T>> | undefined,
  key: string,
): T | undefined {
  return record !== undefined && Object.hasOwn(record, key)
    ? record[key]
    : undefined;
}

function unescapeSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** RFC 6901 walk over plain data; missing paths are unresolved, never thrown from a getter. */
export function resolveJsonPointer(value: unknown, pointer: string): unknown {
  if (pointer === "") return value;
  const segments = pointer.slice(1).split("/").map(unescapeSegment);
  if (segments.length > ARAZZO_LIMITS.evaluator.pointerSegments)
    throw new EvaluationError("pointer-limit");
  let current = value;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (isPlainObject(current)) {
      if (!Object.hasOwn(current, segment)) return undefined;
      current = current[segment];
    } else return undefined;
    if (current === undefined) return undefined;
  }
  return current;
}

function pointed(
  entry: ClassifiedValue | undefined,
  pointer: string | undefined,
): ClassifiedValue {
  if (!entry) throw new EvaluationError("unresolved-reference");
  if (pointer === undefined) return entry;
  const value = resolveJsonPointer(entry.value, pointer);
  if (value === undefined) throw new EvaluationError("unresolved-reference");
  return { value, classification: entry.classification };
}

function resolve(
  expression: RuntimeExpression,
  context: EvaluationContext,
): ClassifiedValue {
  switch (expression.kind) {
    case "url":
    case "method":
    case "statusCode": {
      const value = context[expression.kind];
      if (value === undefined)
        throw new EvaluationError("unresolved-reference");
      return { value, classification: "public" };
    }
    case "response": {
      if (expression.source !== "header" || expression.name === undefined)
        throw new EvaluationError("unsupported-reference");
      const wanted = expression.name.toLowerCase();
      for (const [name, value] of Object.entries(context.responseHeaders ?? {}))
        if (name.toLowerCase() === wanted)
          return { value, classification: "public" };
      throw new EvaluationError("unresolved-reference");
    }
    case "inputs":
      return pointed(own(context.inputs, expression.name), expression.pointer);
    case "outputs":
      return pointed(own(context.outputs, expression.name), expression.pointer);
    case "steps":
      return pointed(
        own(own(context.steps, expression.stepId)?.outputs, expression.name),
        expression.pointer,
      );
    default:
      throw new EvaluationError("unsupported-reference");
  }
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && NUMERIC.test(value)) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
  }
  return undefined;
}

/** Arazzo loose equality: case-insensitive strings, coerced numeric strings, null only equals null. */
export function looseEquals(left: unknown, right: unknown): boolean {
  if (left === null || right === null) return left === null && right === null;
  if (typeof left === "string" && typeof right === "string")
    return left.toLowerCase() === right.toLowerCase();
  if (typeof left === "boolean" || typeof right === "boolean") {
    const a = asBoolean(left);
    const b = asBoolean(right);
    return a !== undefined && b !== undefined && a === b;
  }
  const a = numeric(left);
  const b = numeric(right);
  if (a !== undefined && b !== undefined) return a === b;
  if (
    (isPlainObject(left) || Array.isArray(left)) &&
    (isPlainObject(right) || Array.isArray(right))
  )
    return canonicalConnectorJson(left) === canonicalConnectorJson(right);
  return false;
}

function truthy(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (value === null) return false;
  throw new EvaluationError("non-boolean");
}

function evaluate(
  node: ConditionNode,
  context: EvaluationContext,
): ClassifiedValue {
  switch (node.type) {
    case "literal":
      return { value: node.value, classification: "public" };
    case "reference":
      return resolve(node.expression, context);
    case "not": {
      const operand = evaluate(node.operand, context);
      return {
        value: !truthy(operand.value),
        classification: operand.classification,
      };
    }
    case "logical": {
      const left = evaluate(node.left, context);
      const decided = truthy(left.value);
      if (node.operator === "&&" ? !decided : decided)
        return { value: decided, classification: left.classification };
      const right = evaluate(node.right, context);
      return {
        value: truthy(right.value),
        classification: joinClassification(
          left.classification,
          right.classification,
        ),
      };
    }
    case "compare": {
      const left = evaluate(node.left, context);
      const right = evaluate(node.right, context);
      const classification = joinClassification(
        left.classification,
        right.classification,
      );
      if (node.operator === "==")
        return { value: looseEquals(left.value, right.value), classification };
      if (node.operator === "!=")
        return { value: !looseEquals(left.value, right.value), classification };
      const a = numeric(left.value);
      const b = numeric(right.value);
      if (a === undefined || b === undefined)
        throw new EvaluationError("incomparable");
      const value =
        node.operator === "<"
          ? a < b
          : node.operator === "<="
            ? a <= b
            : node.operator === ">"
              ? a > b
              : a >= b;
      return { value, classification };
    }
    default:
      throw new EvaluationError("unsupported-reference");
  }
}

export type ConditionResult = {
  satisfied: boolean;
  classification: Classification;
  reason?: EvaluationFailure;
};

/**
 * Evaluates one condition. A condition passes only when it evaluates to
 * boolean true; null, unresolved references and incomparable operands fail
 * closed and say why. It never throws on document content.
 */
export function evaluateCondition(
  condition: ParsedCondition | string,
  context: EvaluationContext,
): ConditionResult {
  const parsed =
    typeof condition === "string" ? parseCondition(condition) : condition;
  try {
    const result = evaluate(parsed.ast, context);
    // A bare value is only a condition when it is boolean; `truthy` reports
    // anything else rather than guessing at JavaScript truthiness.
    return {
      satisfied: truthy(result.value),
      classification: result.classification,
    };
  } catch (error) {
    if (error instanceof EvaluationError)
      return {
        satisfied: false,
        classification: "unclassified",
        reason: error.reason,
      };
    throw error;
  }
}

/** All criteria must pass; the joint classification covers every criterion evaluated. */
export function evaluateCriteria(
  criteria: ReadonlyArray<ParsedCondition | string>,
  context: EvaluationContext,
): {
  satisfied: boolean;
  classification: Classification;
  results: ConditionResult[];
} {
  const results = criteria.map((criterion) =>
    evaluateCondition(criterion, context),
  );
  return {
    satisfied: results.every((result) => result.satisfied),
    classification: joinClassification(
      ...results.map((result) => result.classification),
    ),
    results,
  };
}

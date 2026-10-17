import ts from "typescript";
import type { FileFacts } from "./fetch-gate-facts.js";
import { MAX_CEILING, NAMED_CEILINGS, unwrap } from "./fetch-gate-syntax.js";

/*
 * A ceiling is only as good as its number. Every ceiling handed to the
 * bounded transport (`readBoundedBytes` and `boundResponse`, and the
 * `maxResponseBytes` of the options `wireFetch` and `requestOptions` take)
 * must be a constant the compiler can see, no larger than the OAuth ceiling,
 * or than a named ceiling's documented size. A ceiling that comes from a
 * parameter of the function around the call (`limit`, `options.maxResponseBytes`,
 * with or without a constant default) moves the rule to that function's
 * callers, as far as it is passed on. Anything the gate cannot follow is a
 * problem, never a pass.
 */

export type Forward = {
  fn: ts.SignatureDeclaration;
  index: number;
  path: string[];
};
export type Verdict = { problems: string[]; forwards: Forward[] };

const OK: Verdict = { problems: [], forwards: [] };
const problem = (text: string): Verdict => ({ problems: [text], forwards: [] });
const join = (...verdicts: Verdict[]): Verdict => ({
  problems: verdicts.flatMap((verdict) => verdict.problems),
  forwards: verdicts.flatMap((verdict) => verdict.forwards),
});
const DEPTH = 16;
const isFallback = (kind: ts.SyntaxKind) =>
  kind === ts.SyntaxKind.QuestionQuestionToken ||
  kind === ts.SyntaxKind.BarBarToken;

/** Where each registered name takes its ceiling: an argument, or a property of an options argument. */
export const CEILING_ARGUMENT: Record<
  string,
  { index: number; path: string[] }
> = {
  readBoundedBytes: { index: 1, path: [] },
  boundResponse: { index: 1, path: [] },
  wireFetch: { index: 0, path: ["maxResponseBytes"] },
  requestOptions: { index: 0, path: ["maxResponseBytes"] },
};

function parameterOf(facts: FileFacts, node: ts.Node) {
  const declaration = facts.symbolOf(node)?.declarations?.[0];
  if (!declaration || !ts.isParameter(declaration)) return undefined;
  const fn = declaration.parent;
  return ts.isFunctionLike(fn)
    ? { fn, index: fn.parameters.indexOf(declaration), declaration }
    : undefined;
}

const OPERATORS: Partial<
  Record<ts.SyntaxKind, (a: number, b: number) => number>
> = {
  [ts.SyntaxKind.AsteriskToken]: (a, b) => a * b,
  [ts.SyntaxKind.PlusToken]: (a, b) => a + b,
  [ts.SyntaxKind.MinusToken]: (a, b) => a - b,
  [ts.SyntaxKind.SlashToken]: (a, b) => a / b,
  [ts.SyntaxKind.AsteriskAsteriskToken]: (a, b) => a ** b,
};

/** A constant number and the bound it is held to; undefined when it is not one the compiler can see. */
function constantOf(
  facts: FileFacts,
  node: ts.Node,
  depth = 0,
): { bytes: number; bound: number } | undefined {
  if (depth > DEPTH) return undefined;
  const target = unwrap(node);
  if (ts.isNumericLiteral(target))
    return { bytes: Number(target.text), bound: MAX_CEILING };
  if (ts.isIdentifier(target) && target.text === "Infinity")
    return { bytes: Infinity, bound: MAX_CEILING };
  if (
    ts.isPrefixUnaryExpression(target) &&
    target.operator === ts.SyntaxKind.MinusToken
  ) {
    const inner = constantOf(facts, target.operand, depth + 1);
    return inner && { ...inner, bytes: -inner.bytes };
  }
  if (ts.isBinaryExpression(target)) {
    const op = OPERATORS[target.operatorToken.kind];
    const left = op && constantOf(facts, target.left, depth + 1);
    const right = op && constantOf(facts, target.right, depth + 1);
    return op && left && right
      ? {
          bytes: op(left.bytes, right.bytes),
          bound: Math.max(left.bound, right.bound),
        }
      : undefined;
  }
  if (ts.isPropertyAccessExpression(target)) {
    const owner = unwrap(target.expression);
    if (ts.isIdentifier(owner) && owner.text === "Number")
      return { bytes: Infinity, bound: MAX_CEILING };
    const values = ts.isIdentifier(owner) ? facts.declared(owner) : undefined;
    const object = values?.length === 1 ? values[0] : undefined;
    if (!object || !ts.isObjectLiteralExpression(object)) return undefined;
    const property = object.properties.find(
      (item): item is ts.PropertyAssignment =>
        ts.isPropertyAssignment(item) &&
        ts.isIdentifier(item.name) &&
        item.name.text === target.name.text,
    );
    return property && constantOf(facts, property.initializer, depth + 1);
  }
  if (ts.isIdentifier(target)) {
    const values = facts.declared(target);
    const declaration = facts.symbolOf(target)?.declarations?.[0];
    if (values?.length !== 1 || !declaration) return undefined;
    const value = constantOf(facts, values[0]!, depth + 1);
    const named =
      NAMED_CEILINGS[facts.gate.relative(declaration.getSourceFile())]?.[
        target.text
      ];
    return value && named !== undefined ? { ...value, bound: named } : value;
  }
  return undefined;
}

/** The ceiling itself: a constant within its bound, or a parameter whose callers must hold it. */
function judgeLeaf(
  facts: FileFacts,
  node: ts.Node,
  depth: number,
  named?: number,
): Verdict {
  if (depth > DEPTH) return problem("a ceiling too deep to follow");
  const target = unwrap(node);
  if (ts.isIdentifier(target) && target.text === "undefined") return OK;
  const parameter = ts.isIdentifier(target)
    ? parameterOf(facts, target)
    : undefined;
  if (parameter)
    return join(
      { problems: [], forwards: [{ ...parameter, path: [] }] },
      parameter.declaration.initializer
        ? judgeLeaf(facts, parameter.declaration.initializer, depth + 1)
        : OK,
    );
  if (ts.isPropertyAccessExpression(target)) {
    const owner = parameterOf(facts, unwrap(target.expression));
    if (owner)
      return {
        problems: [],
        forwards: [{ ...owner, path: [target.name.text] }],
      };
  }
  if (ts.isBinaryExpression(target) && isFallback(target.operatorToken.kind))
    return join(
      judgeLeaf(facts, target.left, depth + 1),
      judgeLeaf(facts, target.right, depth + 1),
    );
  if (ts.isConditionalExpression(target))
    return join(
      judgeLeaf(facts, target.whenTrue, depth + 1),
      judgeLeaf(facts, target.whenFalse, depth + 1),
    );
  const constant = constantOf(facts, target);
  const value =
    constant && named !== undefined ? { ...constant, bound: named } : constant;
  if (value)
    return value.bytes > 0 && value.bytes <= value.bound
      ? OK
      : problem(
          `hands the reader a ceiling of ${value.bytes} bytes; the most is ${value.bound}`,
        );
  // `limits.max`, where `limits` is an object the gate can follow.
  if (ts.isPropertyAccessExpression(target))
    return checkAt(facts, target.expression, [target.name.text], depth + 1);
  if (ts.isIdentifier(target)) {
    // A `const` that is itself a parameter-derived ceiling (`const limit = options.max ?? MAX`).
    const values = facts.declared(target);
    if (values?.length === 1) return judgeLeaf(facts, values[0]!, depth + 1);
  }
  return problem(
    `hands the reader a ceiling that is not a constant the compiler can see: ${target.getText().slice(0, 60)}`,
  );
}

/** The ceiling at `path` inside `node` (the ceiling argument itself when `path` is empty). */
export function checkAt(
  facts: FileFacts,
  node: ts.Node | undefined,
  path: string[],
  depth = 0,
  named?: number,
): Verdict {
  if (!node) return OK;
  if (depth > DEPTH) return problem("a ceiling too deep to follow");
  if (!path.length) return judgeLeaf(facts, node, depth, named);
  const target = unwrap(node);
  const unseen = () =>
    problem(
      `passes ${path.join(".")} in options the gate cannot see into: ${target.getText().replace(/\s+/g, " ").slice(0, 60)}`,
    );
  const each = (nodes: readonly ts.Node[], at = path) =>
    join(...nodes.map((value) => checkAt(facts, value, at, depth + 1)));
  if (ts.isIdentifier(target)) {
    const parameter = parameterOf(facts, target);
    if (parameter) return { problems: [], forwards: [{ ...parameter, path }] };
    const values = facts.declared(target);
    return values?.length ? each(values) : unseen();
  }
  if (ts.isPropertyAccessExpression(target))
    return each([target.expression], [target.name.text, ...path]);
  if (ts.isBinaryExpression(target) && isFallback(target.operatorToken.kind))
    return each([target.left, target.right]);
  if (ts.isConditionalExpression(target))
    return each([target.whenTrue, target.whenFalse]);
  if (ts.isObjectLiteralExpression(target)) {
    const [name, ...rest] = path;
    const found: Verdict[] = [];
    for (const property of target.properties) {
      if (ts.isSpreadAssignment(property))
        found.push(checkAt(facts, property.expression, path, depth + 1));
      else if (
        ts.isPropertyAssignment(property) &&
        (ts.isIdentifier(property.name) ||
          ts.isStringLiteralLike(property.name)) &&
        property.name.text === name
      )
        found.push(
          checkAt(
            facts,
            property.initializer,
            rest,
            depth + 1,
            NAMED_CEILINGS[facts.gate.relative(property.getSourceFile())]?.[
              name
            ],
          ),
        );
      else if (
        (ts.isShorthandPropertyAssignment(property) &&
          property.name.text === name) ||
        (property.name && ts.isComputedPropertyName(property.name)) ||
        ts.isGetAccessorDeclaration(property)
      )
        // A shorthand, a computed key or an accessor: the gate does not guess its value.
        found.push(unseen());
    }
    return join(...found);
  }
  if (ts.isCallExpression(target)) {
    // `Object.freeze(x)` is `x`.
    const callee = unwrap(target.expression);
    if (
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "Object" &&
      callee.name.text === "freeze"
    )
      return each(target.arguments.slice(0, 1));
    const fns = facts.functionsOf(target.expression);
    const returns = fns?.flatMap((fn) => facts.returnsOf(fn)) ?? [];
    return returns.length ? each(returns) : unseen();
  }
  return unseen();
}

/** The name a callee is spelled with. */
export function calleeName(node: ts.Node): string | undefined {
  const target = unwrap(node);
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  return undefined;
}

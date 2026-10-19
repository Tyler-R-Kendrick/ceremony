import ts from "typescript";
import { unwrap } from "./fetch-gate-syntax.js";

/*
 * Whether a call in a test can run. The pairing rule (fetch-gate-pairing.ts)
 * credits a test with serving an endless body, and with asserting that the
 * read stopped, only where that call is live: not under `skip` or `todo`
 * (`test.skip(...)`, `{ skip: true }`), not in a branch a literal condition
 * closes, not after a `return` or `throw`. Only what is visible in the source
 * is judged: a condition the gate cannot evaluate is taken to be able to go
 * either way.
 */

const TEST_FUNCTIONS = new Set(["test", "it", "describe", "suite"]);
const SKIPS = new Set(["skip", "todo"]);

/** What a literal condition always is: true, false, or undefined when it is not a literal. */
function truth(node: ts.Node): boolean | undefined {
  const target = unwrap(node);
  if (target.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (
    target.kind === ts.SyntaxKind.FalseKeyword ||
    target.kind === ts.SyntaxKind.NullKeyword
  )
    return false;
  if (ts.isIdentifier(target) && target.text === "undefined") return false;
  if (ts.isNumericLiteral(target)) return Number(target.text) !== 0;
  if (ts.isStringLiteralLike(target)) return target.text !== "";
  if (
    ts.isBinaryExpression(target) &&
    (target.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      target.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    // `x && false` is false and `x || true` is true whatever `x` is.
    const left = truth(target.left);
    const right = truth(target.right);
    const and =
      target.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken;
    if (left === !and || right === !and) return !and;
    if (left === and && right === and) return and;
    return undefined;
  }
  if (
    ts.isPrefixUnaryExpression(target) &&
    target.operator === ts.SyntaxKind.ExclamationToken
  ) {
    const inner = truth(target.operand);
    return inner === undefined ? undefined : !inner;
  }
  return undefined;
}

/** Whether a test is declared skipped or todo: `test.skip(...)`, or an options object with `skip`/`todo` that is not literally false. */
function declaredSkipped(call: ts.CallExpression): boolean {
  const callee = unwrap(call.expression);
  if (ts.isPropertyAccessExpression(callee) && SKIPS.has(callee.name.text))
    return true;
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression)
      ? callee.expression.text
      : undefined;
  const nameIsTest =
    name !== undefined &&
    (TEST_FUNCTIONS.has(name) || ts.isPropertyAccessExpression(callee));
  return (
    nameIsTest &&
    call.arguments.some(
      (argument) =>
        ts.isObjectLiteralExpression(argument) &&
        argument.properties.some(
          (property) =>
            ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.name) &&
            SKIPS.has(property.name.text) &&
            truth(property.initializer) !== false,
        ),
    )
  );
}

/** Why `node` cannot run inside a test that does, or undefined when it can. */
export function neverRuns(node: ts.Node): string | undefined {
  let child: ts.Node = node;
  for (let up = node.parent; up; child = up, up = up.parent) {
    if (ts.isIfStatement(up)) {
      const known = truth(up.expression);
      if (up.thenStatement === child && known === false)
        return "in a branch that never runs (an `if` that is never true)";
      if (up.elseStatement === child && known === true)
        return "in a branch that never runs (an `else` after an `if` that is always true)";
    } else if (ts.isConditionalExpression(up)) {
      const known = truth(up.condition);
      if (up.whenTrue === child && known === false)
        return "in a branch that never runs (a condition that is never true)";
      if (up.whenFalse === child && known === true)
        return "in a branch that never runs (a condition that is always true)";
    } else if (ts.isBinaryExpression(up) && up.right === child) {
      const known = truth(up.left);
      const kind = up.operatorToken.kind;
      if (
        (kind === ts.SyntaxKind.AmpersandAmpersandToken && known === false) ||
        (kind === ts.SyntaxKind.BarBarToken && known === true)
      )
        return "in a branch that never runs (the right side of a short circuit)";
    } else if (
      (ts.isWhileStatement(up) || ts.isForStatement(up)) &&
      up.statement === child &&
      (ts.isWhileStatement(up)
        ? truth(up.expression)
        : up.condition && truth(up.condition)) === false
    )
      return "in a loop that never runs";
    else if (ts.isBlock(up) || ts.isCaseClause(up) || ts.isSourceFile(up)) {
      const statements = up.statements;
      const at = statements.indexOf(child as ts.Statement);
      if (
        at > 0 &&
        statements
          .slice(0, at)
          .some(
            (item) => ts.isReturnStatement(item) || ts.isThrowStatement(item),
          )
      )
        return "after a `return` or `throw`, where it never runs";
    } else if (
      ts.isCallExpression(up) &&
      up.arguments.includes(child as ts.Expression) &&
      declaredSkipped(up)
    )
      return "in a test that is skipped (`skip` or `todo`), so it never runs";
  }
  return undefined;
}

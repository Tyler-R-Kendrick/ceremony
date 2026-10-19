import ts from "typescript";
import type { FileFacts } from "./fetch-gate-facts.js";
import { READERS, memberName, unwrap } from "./fetch-gate-syntax.js";

/*
 * What counts as reading a body, in every shape it can be written in. The
 * registered reader (`readBoundedBytes`) is a ceiling loop and is not one.
 *
 * - a member call of a reader: `r.json()`, `r["json"]()`, `r.clone()["text"]()`,
 *   or a member read by a computed name (`r[name]()`), which could be any;
 * - a reader's member called through `call`, `apply` or `Reflect.apply`;
 * - `stream/consumers` (`text(body)`, `json(body)`, ...);
 * - `for await` over a stream or a `.body`;
 * - a `getReader()` whose function has no running-total ceiling: a loop that
 *   reads, adds each chunk's length to a total and stops (throws, returns,
 *   cancels or breaks) when the total passes a limit.
 */

export type Read = { node: ts.Node; kind: string };

const STREAM_TYPES = new Set(["ReadableStream", "Readable", "IncomingMessage"]);
const BODIES = new Set(["Response", "Request", "Body", "Blob"]);

/** zod's `z.json()` is a schema, not a read. */
function fromZod(facts: FileFacts, callee: ts.Node): boolean {
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const declaration = facts.symbolOf(callee.expression)?.declarations?.[0];
  return Boolean(
    declaration?.getSourceFile().fileName.includes("/node_modules/zod/"),
  );
}

/** Whether a call reads a body, and how. */
function readOf(facts: FileFacts, call: ts.CallExpression): string | undefined {
  const callee = unwrap(call.expression);
  // A member chosen at run time on an answer could be any of its readers.
  if (
    ts.isElementAccessExpression(callee) &&
    !ts.isStringLiteralLike(callee.argumentExpression) &&
    BODIES.has(
      facts.checker.getTypeAtLocation(callee.expression).getSymbol()?.name ??
        "",
    )
  )
    return "computed member";
  const name = memberName(callee);
  // A body is read with no arguments; `c.json(value)` writes one.
  if (
    name &&
    READERS.has(name) &&
    call.arguments.length === 0 &&
    !fromZod(facts, callee)
  )
    return `.${name}()`;
  // `r.json.call(r)`, `r.json.apply(r)`, `Reflect.apply(r.json, r, [])`.
  if (
    (name === "call" || name === "apply" || name === "bind") &&
    (ts.isPropertyAccessExpression(callee) ||
      ts.isElementAccessExpression(callee))
  ) {
    const target = memberName(unwrap(callee.expression));
    if (target && READERS.has(target)) return `.${target}.${name}()`;
  }
  if (name === "apply" && ts.isPropertyAccessExpression(callee)) {
    const owner = unwrap(callee.expression);
    const first = call.arguments[0] && memberName(unwrap(call.arguments[0]));
    if (ts.isIdentifier(owner) && owner.text === "Reflect" && first)
      if (READERS.has(first)) return `Reflect.apply(.${first})`;
  }
  if (facts.sf.text.includes("stream/consumers")) {
    const declaration = facts.symbolOf(callee)?.declarations?.[0];
    if (
      declaration &&
      /\/stream\/consumers\.d\.ts$/.test(declaration.getSourceFile().fileName)
    )
      return "stream/consumers";
  }
  if (name === "getReader" && !hasCeilingLoop(call)) return "getReader()";
  return undefined;
}

/** A loop in the reader's function that adds up what it reads and stops past a limit. */
function hasCeilingLoop(call: ts.CallExpression): boolean {
  let fn: ts.Node | undefined = call.parent;
  while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
  if (!fn) return false;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isForStatement(node) ||
      ts.isWhileStatement(node) ||
      ts.isDoStatement(node) ||
      ts.isForOfStatement(node)
    )
      found = ceilingIn(node.statement);
    if (!found) ts.forEachChild(node, visit);
  };
  visit(fn);
  return found;
}

function ceilingIn(body: ts.Node): boolean {
  const totals = new Set<string>();
  let reads = false;
  const collect = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      memberName(unwrap(node.expression)) === "read"
    )
      reads = true;
    // `total += value.byteLength` (or `.length`).
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
      ts.isIdentifier(node.left) &&
      ["byteLength", "length"].includes(memberName(unwrap(node.right)) ?? "")
    )
      totals.add(node.left.text);
    ts.forEachChild(node, collect);
  };
  collect(body);
  if (!reads || !totals.size) return false;
  let stops = false;
  const guard = (node: ts.Node): void => {
    if (
      ts.isIfStatement(node) &&
      ts.isBinaryExpression(node.expression) &&
      [
        ts.SyntaxKind.GreaterThanToken,
        ts.SyntaxKind.GreaterThanEqualsToken,
      ].includes(node.expression.operatorToken.kind) &&
      ts.isIdentifier(node.expression.left) &&
      totals.has(node.expression.left.text) &&
      stopsIn(node.thenStatement)
    )
      stops = true;
    ts.forEachChild(node, guard);
  };
  guard(body);
  return stops;
}

function stopsIn(node: ts.Node): boolean {
  if (
    ts.isThrowStatement(node) ||
    ts.isReturnStatement(node) ||
    ts.isBreakStatement(node)
  )
    return true;
  if (
    ts.isCallExpression(node) &&
    memberName(unwrap(node.expression)) === "cancel"
  )
    return true;
  let found = false;
  ts.forEachChild(node, (child) => {
    found ||= !ts.isFunctionLike(child) && stopsIn(child);
  });
  return found;
}

/** Whether `for await` walks a body (a stream, or something's `.body`). */
function streamLoop(facts: FileFacts, loop: ts.ForOfStatement): boolean {
  if (!loop.awaitModifier) return false;
  const iterated = unwrap(loop.expression);
  if (memberName(iterated) === "body") return true;
  const symbol = facts.checker.getTypeAtLocation(iterated).getSymbol();
  return Boolean(symbol && STREAM_TYPES.has(symbol.name));
}

/** Every body read in `root`. */
export function readsIn(facts: FileFacts, root: ts.Node): Read[] {
  const found: Read[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const kind = readOf(facts, node);
      if (kind) found.push({ node, kind });
    }
    if (ts.isForOfStatement(node) && streamLoop(facts, node))
      found.push({ node, kind: "for await" });
    ts.forEachChild(node, walk);
  };
  walk(root);
  return found;
}

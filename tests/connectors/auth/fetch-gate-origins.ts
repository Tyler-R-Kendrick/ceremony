import ts from "typescript";
import { FileFacts } from "./fetch-gate-facts.js";
import { callsTo, spellingsOf } from "./fetch-gate-forwards.js";
import { neverRuns } from "./fetch-gate-liveness.js";
import type { GateProgram } from "./fetch-gate-program.js";
import { unwrap } from "./fetch-gate-syntax.js";

/*
 * Where a value comes from, as far as the source says: the object literal or
 * the declaration it was made in. The pairing rule (fetch-gate-pairing.ts)
 * uses it to tell whether the counter a test hands to the endless-body double
 * is the counter it asserts on, whatever name each place holds it under: a
 * `const`, a parameter of a wrapper (followed to every call of the wrapper that
 * can run), a
 * property of an object a function returns, a destructured binding. A value it
 * cannot follow is its own origin, so two values it cannot follow are never
 * taken for the same.
 */

const DEPTH = 12;

export type Origins = Set<ts.Node>;

const named = (name: ts.PropertyName | ts.BindingName | undefined) =>
  name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name))
    ? name.text
    : undefined;

/** The value of the property `name` of an object literal, as origins; undefined when it has none. */
function propertyOf(
  origins: (node: ts.Node) => Origins,
  literal: ts.ObjectLiteralExpression,
  name: string,
): Origins | undefined {
  for (const property of literal.properties) {
    if (ts.isPropertyAssignment(property) && named(property.name) === name)
      return origins(property.initializer);
    if (
      ts.isShorthandPropertyAssignment(property) &&
      property.name.text === name
    )
      return origins(property.name);
  }
  return undefined;
}

/** The lists a value is `push`ed into, anywhere in the function or file that declares it. */
function pushedInto(
  facts: FileFacts,
  symbol: ts.Symbol,
  declaration: ts.Node,
): ts.Expression[] {
  let scope: ts.Node = declaration;
  while (scope.parent && !ts.isFunctionLike(scope) && !ts.isSourceFile(scope))
    scope = scope.parent;
  const lists: ts.Expression[] = [];
  const walk = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "push" &&
      node.arguments.some(
        (argument) =>
          ts.isIdentifier(argument) && facts.symbolOf(argument) === symbol,
      )
    )
      lists.push(node.expression.expression);
    ts.forEachChild(node, walk);
  };
  walk(scope);
  return lists;
}

export function originsOf(
  gate: GateProgram,
  files: readonly string[],
  file: string,
  node: ts.Node,
): Origins {
  const facts = new FileFacts(gate, file);
  const visit = (at: ts.Node, depth: number): Origins => {
    const target = unwrap(at);
    if (depth > DEPTH) return new Set([target]);
    const next = (inner: ts.Node) => visit(inner, depth + 1);
    if (ts.isObjectLiteralExpression(target)) return new Set([target]);
    if (ts.isIdentifier(target)) {
      const symbol = ts.isShorthandPropertyAssignment(target.parent)
        ? facts.checker.getShorthandAssignmentValueSymbol(target.parent)
        : facts.symbolOf(target);
      const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      if (!declaration) return new Set([target]);
      if (
        ts.isParameter(declaration) &&
        ts.isFunctionLike(declaration.parent)
      ) {
        const wrapper = declaration.parent;
        const index = wrapper.parameters.indexOf(declaration);
        // Only the calls that can run: a wrapper called from a skipped test passes nothing.
        const passed = callsTo(
          gate,
          files,
          wrapper,
          spellingsOf(gate, files, wrapper),
        )
          .filter(({ call }) => !neverRuns(call))
          .map(({ call }) => call.arguments[index]);
        if (!passed.length || passed.some((argument) => !argument))
          return new Set([declaration]);
        return new Set(passed.flatMap((argument) => [...next(argument!)]));
      }
      if (ts.isVariableDeclaration(declaration)) {
        const list = declaration.parent;
        const constant =
          ts.isVariableDeclarationList(list) &&
          (list.flags & ts.NodeFlags.Const) !== 0;
        const own =
          constant && declaration.initializer
            ? next(declaration.initializer)
            : new Set<ts.Node>([declaration]);
        // A counter pushed into a list belongs to the list too.
        for (const list of pushedInto(facts, symbol!, declaration))
          for (const origin of next(list)) own.add(origin);
        return own;
      }
      if (
        ts.isBindingElement(declaration) &&
        ts.isObjectBindingPattern(declaration.parent)
      ) {
        const owner = declaration.parent.parent;
        const key = named(declaration.propertyName ?? declaration.name);
        const source =
          ts.isVariableDeclaration(owner) && owner.initializer
            ? next(owner.initializer)
            : undefined;
        if (key && source) {
          const found = [...source].map((origin) =>
            ts.isObjectLiteralExpression(origin)
              ? propertyOf(next, origin, key)
              : undefined,
          );
          if (found.every((item) => item))
            return new Set(found.flatMap((item) => [...item!]));
        }
      }
      return new Set([declaration]);
    }
    if (ts.isPropertyAccessExpression(target)) {
      const bases = next(target.expression);
      const found = [...bases].map((origin) =>
        ts.isObjectLiteralExpression(origin)
          ? propertyOf(next, origin, target.name.text)
          : undefined,
      );
      if (!found.every((item) => item)) return new Set([target]);
      const values = new Set(found.flatMap((item) => [...item!]));
      // A scalar read (`seen.pulled`) stands for the object it is read from.
      return [...values].some(ts.isObjectLiteralExpression) ? values : bases;
    }
    if (ts.isCallExpression(target)) {
      const fns = facts.functionsOf(target.expression);
      const returns = fns?.flatMap((fn) => facts.returnsOf(fn)) ?? [];
      return returns.length
        ? new Set(returns.flatMap((value) => [...next(value)]))
        : new Set([target]);
    }
    return new Set([target]);
  };
  return visit(node, 0);
}

/**
 * Every origin an expression is made of: those of each name in it, and of
 * each property read in it. What an assertion mentions, `{ pulled }` or
 * `Math.max(0, ...served.map((seen) => seen.pulled))` as much as `seen`.
 */
export function mentionedOrigins(
  gate: GateProgram,
  files: readonly string[],
  file: string,
  node: ts.Node,
): Origins {
  const found: Origins = new Set();
  const visit = (at: ts.Node): void => {
    const isName =
      (ts.isPropertyAccessExpression(at.parent) && at.parent.name === at) ||
      (ts.isPropertyAssignment(at.parent) && at.parent.name === at);
    if ((ts.isIdentifier(at) && !isName) || ts.isPropertyAccessExpression(at))
      for (const origin of originsOf(gate, files, file, at)) found.add(origin);
    ts.forEachChild(at, visit);
  };
  visit(node);
  return found;
}

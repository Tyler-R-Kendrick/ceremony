import ts from "typescript";
import { calleeName } from "./fetch-gate-ceilings.js";
import { FileFacts } from "./fetch-gate-facts.js";
import type { GateProgram } from "./fetch-gate-program.js";
import { unwrap } from "./fetch-gate-syntax.js";

/*
 * A function that hands a ceiling taken from its own parameter to a bounder
 * moves the ceiling rule to its callers (fetch-gate-ceilings.ts). Its callers
 * are found by what they call, not by how they spell it: by its own name, by
 * any name a module re-exports it under or a file imports it under, and
 * through a `const` that holds it, in this module or one that exports the
 * `const`. Any other use of it as a value (handed on, held in a `let`, put in
 * an object, exported as a default) could be called where the rule cannot
 * follow, so it is refused, as a bounder's is (fetch-gate-aliases.ts).
 */

/** The name a function is declared under: its own, or the `const` it is assigned to. */
function nameOf(fn: ts.SignatureDeclaration): string | undefined {
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  if (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name))
    return fn.parent.name.text;
  return undefined;
}

const constInitializer = (node: ts.Node): boolean => {
  const declaration = node.parent;
  return (
    ts.isVariableDeclaration(declaration) &&
    declaration.initializer !== undefined &&
    unwrap(declaration.initializer) === node &&
    ts.isVariableDeclarationList(declaration.parent) &&
    (declaration.parent.flags & ts.NodeFlags.Const) !== 0
  );
};

/** Every name `fn` is called by in `files`, to a fixpoint: its own, re-exported, imported and `const` names. */
export function spellingsOf(
  gate: GateProgram,
  files: readonly string[],
  fn: ts.SignatureDeclaration,
): Set<string> {
  const names = new Set<string>();
  const own = nameOf(fn);
  if (own) names.add(own);
  for (let round = 0; round < 8 && names.size; round++) {
    const before = names.size;
    for (const file of files) {
      const sf = gate.sourceFile(file);
      if (!sf || ![...names].some((name) => sf.text.includes(name))) continue;
      const facts = new FileFacts(gate, file);
      const holds = (node: ts.Node) =>
        facts.functionsOf(node)?.includes(fn) === true;
      const visit = (node: ts.Node): void => {
        if (
          (ts.isExportSpecifier(node) || ts.isImportSpecifier(node)) &&
          names.has((node.propertyName ?? node.name).text) &&
          holds(node.name)
        )
          names.add(node.name.text);
        else if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          ts.isVariableDeclarationList(node.parent) &&
          (node.parent.flags & ts.NodeFlags.Const) !== 0 &&
          holds(node.name)
        )
          names.add(node.name.text);
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    if (names.size === before) break;
  }
  return names;
}

/** Every call, in the given files, to the function `fn`, under any of its `names`. */
export function callsTo(
  gate: GateProgram,
  files: readonly string[],
  fn: ts.SignatureDeclaration,
  names: ReadonlySet<string>,
): Array<{ facts: FileFacts; call: ts.CallExpression }> {
  const found: Array<{ facts: FileFacts; call: ts.CallExpression }> = [];
  for (const file of files) {
    const sf = gate.sourceFile(file);
    if (!sf || ![...names].some((name) => sf.text.includes(name))) continue;
    const facts = new FileFacts(gate, file);
    const walk = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        names.has(calleeName(node.expression) ?? "") &&
        facts.functionsOf(node.expression)?.includes(fn)
      )
        found.push({ facts, call: node });
      ts.forEachChild(node, walk);
    };
    walk(sf);
  }
  return found;
}

/** Whether `node`, which names `fn`, is a use the callers' rule follows. */
function followed(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isCallExpression(parent) && parent.expression === node) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    const up = parent.parent;
    return ts.isCallExpression(up) && up.expression === parent;
  }
  if (
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isExportSpecifier(parent) ||
    ((ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent)) &&
      parent.name === node) ||
    constInitializer(node)
  )
    return true;
  for (let up: ts.Node = parent; up; up = up.parent)
    if (ts.isTypeNode(up)) return true;
  return false;
}

/** Every use of `fn` in `files` as a value its callers' rule cannot follow. */
export function forwarderValueUses(
  gate: GateProgram,
  files: readonly string[],
  fn: ts.SignatureDeclaration,
  names: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  for (const file of files) {
    const sf = gate.sourceFile(file);
    if (!sf || ![...names].some((name) => sf.text.includes(name))) continue;
    const facts = new FileFacts(gate, file);
    const visit = (node: ts.Node): void => {
      if (
        ts.isIdentifier(node) &&
        names.has(node.text) &&
        !followed(node) &&
        facts.functionsOf(node)?.includes(fn)
      )
        facts.report(
          node,
          `takes ${node.text} as a value; it passes a ceiling on, and the gate follows it only where it is called, imported, re-exported or held in a const`,
        );
      ts.forEachChild(node, visit);
    };
    visit(sf);
    problems.push(...facts.problems);
  }
  return problems;
}

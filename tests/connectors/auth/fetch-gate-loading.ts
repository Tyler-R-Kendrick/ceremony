import ts from "typescript";
import type { FileFacts } from "./fetch-gate-facts.js";
import { GATED, unwrap } from "./fetch-gate-syntax.js";

/*
 * Modules loaded where the compiler cannot see which: a gated library loaded
 * any way but a static import (so that its calls are read), and any loader
 * whose target is computed. A loader is accepted when what it can load is
 * visible: `import()` of a literal or of a template that starts at a relative
 * path (a file of this repository, never a package), and a `createRequire`
 * whose require is only ever called with a literal that is not gated, or only
 * asked to `resolve` (which loads nothing).
 */

const isGated = (specifier: string) =>
  (GATED as readonly string[]).includes(specifier);

const literalOf = (node: ts.Node | undefined) =>
  node && ts.isStringLiteralLike(node) ? node.text : undefined;

/** A template whose fixed head is a relative path: a file of this repository. */
const relativeTemplate = (node: ts.Node | undefined) =>
  node !== undefined &&
  ts.isTemplateExpression(node) &&
  /^\.\.?\//.test(node.head.text);

/** Whether a call to a require only loads a literal, non-gated module (or only resolves one). */
function requireUseIsVisible(use: ts.Node): boolean {
  const parent = use.parent;
  if (
    ts.isPropertyAccessExpression(parent) &&
    parent.expression === use &&
    parent.name.text === "resolve" &&
    ts.isCallExpression(parent.parent) &&
    parent.parent.expression === parent
  )
    return true;
  if (ts.isCallExpression(parent) && parent.expression === use) {
    const target = literalOf(parent.arguments[0]);
    return target !== undefined && !isGated(target);
  }
  return false;
}

/** Every use of a `createRequire(...)` result, and whether each is visible. */
function createdRequireIsVisible(
  facts: FileFacts,
  call: ts.CallExpression,
): boolean {
  if (requireUseIsVisible(call)) return true;
  const declaration = call.parent;
  if (
    !ts.isVariableDeclaration(declaration) ||
    unwrap(declaration.initializer!) !== call ||
    !ts.isIdentifier(declaration.name) ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    !(declaration.parent.flags & ts.NodeFlags.Const)
  )
    return false;
  const symbol = facts.checker.getSymbolAtLocation(declaration.name);
  let visible = true;
  const walk = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      node !== declaration.name &&
      facts.checker.getSymbolAtLocation(node) === symbol
    )
      visible &&= requireUseIsVisible(node);
    ts.forEachChild(node, walk);
  };
  walk(facts.sf);
  return visible;
}

/** The loading problems at one node. */
export function loadingProblems(facts: FileFacts, node: ts.Node): void {
  if (ts.isCallExpression(node)) {
    const [first] = node.arguments;
    const literal = literalOf(first);
    if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (literal !== undefined && isGated(literal))
        facts.report(node, `loads ${literal} dynamically; import it by name`);
      else if (literal === undefined && !relativeTemplate(first))
        facts.report(node, "loads a module by a name computed at run time");
    }
    if (
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      // A `const require = createRequire(...)` is read where it is made.
      !facts
        .symbolOf(node.expression)
        ?.declarations?.some(
          (declaration) =>
            ts.isVariableDeclaration(declaration) &&
            declaration.initializer !== undefined &&
            ts.isCallExpression(unwrap(declaration.initializer)) &&
            facts.symbolOf(
              (unwrap(declaration.initializer) as ts.CallExpression).expression,
            )?.name === "createRequire",
        ) &&
      (literal === undefined || isGated(literal))
    )
      facts.report(
        node,
        `loads ${literal ?? "a computed module"} through require; import it by name`,
      );
    if (
      facts.sf.text.includes("createRequire") &&
      facts.symbolOf(node.expression)?.name === "createRequire" &&
      !createdRequireIsVisible(facts, node)
    )
      facts.report(
        node,
        "loads modules through a require the gate cannot follow",
      );
  }
  if (ts.isImportEqualsDeclaration(node)) {
    const reference = node.moduleReference;
    if (
      ts.isExternalModuleReference(reference) &&
      ts.isStringLiteral(reference.expression) &&
      isGated(reference.expression.text)
    )
      facts.report(
        node,
        `loads ${reference.expression.text} through require; import it by name`,
      );
  }
  if (
    ts.isExportDeclaration(node) &&
    node.moduleSpecifier &&
    ts.isStringLiteral(node.moduleSpecifier) &&
    isGated(node.moduleSpecifier.text)
  )
    facts.report(
      node,
      `re-exports ${node.moduleSpecifier.text}, which hides its calls from the gate`,
    );
  if (
    ts.isImportDeclaration(node) &&
    ts.isStringLiteral(node.moduleSpecifier) &&
    isGated(node.moduleSpecifier.text) &&
    node.importClause?.name &&
    !node.importClause.isTypeOnly
  )
    facts.report(node, `default-imports ${node.moduleSpecifier.text}`);
}

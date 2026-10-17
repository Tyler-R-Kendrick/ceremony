import ts from "typescript";
import { CEILING_ARGUMENT } from "./fetch-gate-ceilings.js";
import type { FileFacts } from "./fetch-gate-facts.js";
import { REGISTRY } from "./fetch-gate-syntax.js";

/*
 * The ceiling rule finds a bounder where it is called: by its own name, or by
 * the name this file imports it under. A bounder taken as a value (held in a
 * variable, handed on, exported under another name, read by a computed name)
 * could be called where the rule does not look, with any ceiling. So a
 * bounder is called, imported, re-exported under its own name or named in a
 * type, and any other use of it is refused. (A bounded fetch that takes no
 * ceiling, `boundedAuthFetch`, is handed on as a value by design.)
 */

const NAMES = new Set(Object.keys(CEILING_ARGUMENT));

/** The registered name a symbol is, if it is one. */
function registeredName(
  facts: FileFacts,
  symbol: ts.Symbol | undefined,
): string | undefined {
  const declaration = symbol?.declarations?.[0];
  if (!symbol || !declaration) return undefined;
  const members = REGISTRY[facts.gate.relative(declaration.getSourceFile())];
  return members?.[symbol.name] && NAMES.has(symbol.name)
    ? symbol.name
    : undefined;
}

/** What an identifier refers to; in `{ name }` that is the value, not the property. */
function valueSymbol(facts: FileFacts, node: ts.Identifier) {
  if (!ts.isShorthandPropertyAssignment(node.parent))
    return facts.symbolOf(node);
  const symbol = facts.checker.getShorthandAssignmentValueSymbol(node.parent);
  return symbol && symbol.flags & ts.SymbolFlags.Alias
    ? facts.checker.getAliasedSymbol(symbol)
    : symbol;
}

/** Why `node`, which resolves to the bounder `name`, is a use the rule cannot follow. */
function valueUse(node: ts.Identifier, name: string): string | undefined {
  const parent = node.parent;
  if (ts.isCallExpression(parent) && parent.expression === node) return;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    const up = parent.parent;
    if (ts.isCallExpression(up) && up.expression === parent) return;
  }
  if (ts.isImportSpecifier(parent) || ts.isImportClause(parent)) return;
  if (ts.isExportSpecifier(parent))
    return parent.name.text === name
      ? undefined
      : `re-exports ${name} as ${parent.name.text}; a bounder keeps its own name`;
  if (
    (ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent)) &&
    parent.name === node
  )
    return;
  for (let up: ts.Node = parent; up; up = up.parent)
    if (ts.isTypeNode(up)) return;
  return `takes ${name} as a value; the gate checks a ceiling only where a bounder is called`;
}

/** Every use of a bounder in `sf` that is not a call, an import, a same-name re-export or a type. */
export function aliasProblems(facts: FileFacts, sf: ts.SourceFile): void {
  const local = new Set(NAMES);
  for (const statement of sf.statements) {
    const bindings = ts.isImportDeclaration(statement)
      ? statement.importClause?.namedBindings
      : undefined;
    if (bindings && ts.isNamedImports(bindings))
      for (const element of bindings.elements)
        if (element.propertyName && NAMES.has(element.propertyName.text))
          local.add(element.name.text);
  }
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && local.has(node.text)) {
      const name = registeredName(facts, valueSymbol(facts, node));
      const why = name && valueUse(node, name);
      if (why) facts.report(node, why);
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      NAMES.has(node.argumentExpression.text)
    ) {
      const name = registeredName(facts, facts.symbolOf(node));
      if (name)
        facts.report(
          node,
          `reads ${name} by a computed name; a bounder is called by its name`,
        );
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

import ts from "typescript";
import { Evaluator } from "./fetch-gate-evaluator.js";
import { loadingProblems } from "./fetch-gate-loading.js";
import { GATED, unwrap, type NetworkExports } from "./fetch-gate-syntax.js";

/*
 * Reads one source file. Everywhere: a module loaded by a name the compiler
 * cannot see (`import(name)`, `require` of a gated library, `createRequire`)
 * is refused. In a file that imports a gated library: every call into it that
 * can reach the network is checked, every other use of it that could hide
 * such a call (the module as a value, a request function as a value, the
 * custom fetch in a form the gate does not read) is refused.
 */

export class FileGate extends Evaluator {
  run(network: NetworkExports): string[] {
    const imports = GATED.some((module) => this.sf.text.includes(module));
    const visit = (node: ts.Node): void => {
      loadingProblems(this, node);
      if (imports) this.gated(node, network);
      ts.forEachChild(node, visit);
    };
    visit(this.sf);
    return this.problems;
  }

  private inType(node: ts.Node): boolean {
    for (let up = node.parent; up; up = up.parent) {
      if (ts.isTypeNode(up) || ts.isImportDeclaration(up)) return true;
      if (ts.isQualifiedName(up)) return true;
    }
    return false;
  }

  /** A use of a gated library, by what it resolves to. */
  private gated(node: ts.Node, network: NetworkExports) {
    if (
      !(
        ts.isIdentifier(node) ||
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)
      ) ||
      this.inType(node)
    )
      return;
    // `a.b` is read once, as the whole; its name is not read again alone.
    if (
      ts.isIdentifier(node) &&
      ts.isPropertyAccessExpression(node.parent) &&
      node.parent.name === node
    )
      return;
    if (
      ts.isElementAccessExpression(node) &&
      !ts.isStringLiteralLike(node.argumentExpression)
    ) {
      if (this.gatedOf(node.expression)?.name === "*")
        this.report(
          node,
          "reads a member of a gated library by a computed name",
        );
      return;
    }
    const ref = this.gatedOf(node);
    if (!ref) return;
    const parent = node.parent;
    if (ref.name === "*") {
      const member =
        (ts.isPropertyAccessExpression(parent) ||
          ts.isElementAccessExpression(parent)) &&
        parent.expression === node;
      if (!member)
        this.report(
          node,
          `uses the ${ref.module} namespace as a value, which hides its calls from the gate`,
        );
      return;
    }
    if (ref.name === "customFetch") return this.customFetch(node);
    const indices = network[ref.module]?.[ref.name];
    if (!indices) return;
    if (!(ts.isCallExpression(parent) && parent.expression === node)) {
      this.report(
        node,
        `${ref.name} is used as a value, which hides its calls from the gate`,
      );
      return;
    }
    this.note(parent, ref.name);
    for (const index of indices) {
      if (parent.arguments.slice(0, index + 1).some(ts.isSpreadElement)) {
        this.report(
          parent,
          `${ref.name} is called with spread arguments the gate cannot place`,
        );
        continue;
      }
      const options = parent.arguments[index];
      if (!options)
        this.report(
          parent,
          `${ref.name} is called without options, so it uses the global fetch unbounded`,
        );
      else if (this.optionsState(options) !== "bounded")
        this.report(
          options,
          `${ref.name} is given options that do not resolve to the bounded transport: ${options.getText().replace(/\s+/g, " ").slice(0, 70)}`,
        );
    }
  }

  /** Every place the custom fetch is named must be a form the gate reads, and its value must be bounded. */
  private customFetch(node: ts.Node) {
    this.note(node, "customFetch");
    const parent = node.parent;
    if (ts.isComputedPropertyName(parent)) {
      const owner = parent.parent;
      if (
        ts.isPropertyAssignment(owner) &&
        ts.isObjectLiteralExpression(owner.parent)
      )
        return this.requireFetch(owner.initializer);
      if (
        ts.isMethodDeclaration(owner) &&
        ts.isObjectLiteralExpression(owner.parent)
      )
        return this.requireFetch(owner);
      return this.report(
        node,
        "names the custom fetch as a member the gate does not read (an accessor or a class field)",
      );
    }
    if (
      ts.isElementAccessExpression(parent) &&
      parent.argumentExpression === node &&
      ts.isBinaryExpression(parent.parent) &&
      parent.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.parent.left === parent
    )
      return this.requireFetch(parent.parent.right);
    this.report(
      node,
      "names the custom fetch in a form the gate does not read",
    );
  }

  private requireFetch(value: ts.Node) {
    if (!this.boundedFetch(value, 0))
      this.report(
        value,
        `hands OAuth a fetch that does not read its answer under the ceiling: ${unwrap(value).getText().replace(/\s+/g, " ").slice(0, 70)}`,
      );
  }
}

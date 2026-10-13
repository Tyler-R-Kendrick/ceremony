import ts from "typescript";
import { Evaluator } from "./fetch-gate-evaluator.js";
import { GATED, READERS } from "./fetch-gate-syntax.js";

/** Checks one source file; the findings are sentences naming file and line. */
export class FileGate extends Evaluator {
  run(): string[] {
    this.collect(this.sf);
    this.visit(this.sf);
    return this.problems;
  }

  private inType(node: ts.Node): boolean {
    for (let up = node.parent; up; up = up.parent)
      if (ts.isTypeNode(up)) return true;
    return false;
  }

  private isReference(node: ts.Identifier): boolean {
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node)
      return false;
    if (
      (ts.isPropertyAssignment(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isPropertySignature(parent) ||
        ts.isBindingElement(parent)) &&
      (parent as { name?: ts.Node }).name === node
    )
      return false;
    if (ts.isBindingElement(parent) && parent.propertyName === node)
      return false;
    if (
      ts.isImportSpecifier(parent) ||
      ts.isImportClause(parent) ||
      ts.isNamespaceImport(parent)
    )
      return false;
    return !this.inType(node);
  }

  private visit(node: ts.Node) {
    if (ts.isCallExpression(node)) this.visitCall(node);
    if (ts.isIdentifier(node) && this.isReference(node))
      this.visitIdentifier(node);
    if (
      (ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      !this.inType(node)
    )
      this.visitMember(node);
    ts.forEachChild(node, (child) => this.visit(child));
  }

  private visitCall(call: ts.CallExpression) {
    if (call.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [first] = call.arguments;
      if (first && ts.isStringLiteralLike(first) && GATED.includes(first.text))
        this.report(
          call,
          `imports ${first.text} dynamically; import it by name`,
        );
      return;
    }
    if (
      ts.isIdentifier(call.expression) &&
      call.expression.text === "require" &&
      call.arguments[0] &&
      ts.isStringLiteralLike(call.arguments[0]) &&
      GATED.includes(call.arguments[0].text)
    )
      this.report(
        call,
        `requires ${call.arguments[0].text}; import it by name`,
      );
    const target = this.gatedRef(call.expression);
    const indices = target && this.network[target.module]?.[target.name];
    if (!target || !indices) return;
    this.note(call, target.name);
    for (const index of indices) {
      if (call.arguments.slice(0, index + 1).some(ts.isSpreadElement)) {
        this.report(
          call,
          `${target.name} is called with spread arguments the gate cannot place`,
        );
        continue;
      }
      const options = call.arguments[index];
      if (!options)
        this.report(
          call,
          `${target.name} is called without options, so it uses the global fetch unbounded`,
        );
      else if (this.optionsState(options) !== "bounded")
        this.report(
          options,
          `${target.name} is given options that do not resolve to the bounded transport: ${options.getText().replace(/\s+/g, " ").slice(0, 70)}`,
        );
    }
  }

  /** A bound namespace used as a value, a gated function used as a value, or the custom fetch in a form not read. */
  private visitIdentifier(node: ts.Identifier) {
    const parent = node.parent;
    if (this.namespaces.has(node.text)) {
      const member =
        (ts.isPropertyAccessExpression(parent) ||
          ts.isElementAccessExpression(parent)) &&
        parent.expression === node;
      if (!member)
        this.report(
          node,
          `uses the ${this.namespaces.get(node.text)} namespace as a value, which hides its calls from the gate`,
        );
      return;
    }
    const ref = this.named.get(node.text);
    if (ref) this.visitRef(node, ref);
  }

  private visitMember(
    node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  ) {
    const ref = this.gatedRef(node);
    if (ref) this.visitRef(node, ref);
    else if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      this.namespaces.has(node.expression.text)
    )
      this.report(node, "reads a member of a gated library by a computed name");
  }

  private visitRef(node: ts.Node, ref: { module: string; name: string }) {
    if (ref.name === "customFetch") return this.visitCustomFetch(node);
    if (!this.network[ref.module]?.[ref.name]) return;
    const parent = node.parent;
    const callee = ts.isCallExpression(parent) && parent.expression === node;
    if (!callee)
      this.report(
        node,
        `${ref.name} is used as a value, which hides its calls from the gate`,
      );
  }

  /** Every place the custom fetch is named must be a form the gate reads, and its value must be bounded. */
  private visitCustomFetch(node: ts.Node) {
    this.note(node, "customFetch");
    const parent = node.parent;
    if (parent && ts.isComputedPropertyName(parent)) {
      const owner = parent.parent;
      if (ts.isPropertyAssignment(owner))
        return this.requireFetch(owner.initializer);
      if (ts.isMethodDeclaration(owner)) return this.requireFetch(owner);
      return this.report(
        node,
        "names the custom fetch as a computed member the gate does not read",
      );
    }
    if (
      parent &&
      ts.isElementAccessExpression(parent) &&
      parent.argumentExpression === node &&
      parent.parent &&
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
        `hands OAuth a fetch that does not read its answer under the ceiling: ${value.getText().replace(/\s+/g, " ").slice(0, 70)}`,
      );
  }

  /** Zero-argument reads of a body (`.json()` and the like) in the file, as `line` numbers. */
  bodyReads(): number[] {
    const lines: number[] = [];
    const walk = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.arguments.length === 0 &&
        ts.isPropertyAccessExpression(node.expression) &&
        READERS.has(node.expression.name.text) &&
        node.expression.name.text !== "getReader" &&
        // zod's `z.json()` is a schema, not a body.
        !(
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "z"
        )
      )
        lines.push(
          this.sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        );
      ts.forEachChild(node, walk);
    };
    walk(this.sf);
    return lines;
  }
}

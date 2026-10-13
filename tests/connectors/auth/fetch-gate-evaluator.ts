import ts from "typescript";
import { FileFacts } from "./fetch-gate-facts.js";
import { merge, READERS, unwrap, type State } from "./fetch-gate-syntax.js";

/** Whether an expression resolves to the bounded transport. */
export class Evaluator extends FileFacts {
  /** What the options an OAuth call is given carry as their custom fetch. */
  optionsState(node: ts.Node, depth = 0): State {
    if (depth > 12) return "unbounded";
    const target = unwrap(node);
    if (ts.isObjectLiteralExpression(target)) {
      let state: State = "none";
      for (const property of target.properties) {
        if (ts.isSpreadAssignment(property)) {
          const inner = this.optionsState(property.expression, depth + 1);
          if (inner !== "none") state = inner;
        } else if (
          property.name &&
          ts.isComputedPropertyName(property.name) &&
          this.gatedRef(property.name.expression)?.name === "customFetch"
        ) {
          const value = ts.isPropertyAssignment(property)
            ? property.initializer
            : property;
          state = this.boundedFetch(value, depth + 1) ? "bounded" : "unbounded";
        }
      }
      return state;
    }
    if (ts.isConditionalExpression(target))
      return merge(
        this.optionsState(target.whenTrue, depth + 1),
        this.optionsState(target.whenFalse, depth + 1),
      );
    if (
      ts.isBinaryExpression(target) &&
      [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(
        target.operatorToken.kind,
      )
    )
      return merge(
        this.optionsState(target.left, depth + 1),
        this.optionsState(target.right, depth + 1),
      );
    if (target.kind === ts.SyntaxKind.UndefinedKeyword) return "none";
    if (ts.isIdentifier(target)) {
      if (target.text === "undefined") return "none";
      return this.viaDeclarations(
        target,
        (init) => this.optionsState(init, depth + 1),
        merge,
        "unbounded",
      );
    }
    if (ts.isCallExpression(target)) {
      if (this.registered(target.expression) === "options") return "bounded";
      return this.viaReturns(
        target.expression,
        (returned) => this.optionsState(returned, depth + 1),
        merge,
        "unbounded",
      );
    }
    return "unbounded";
  }

  /** Whether `node`, used as a custom fetch, hands back only answers read under the ceiling. */
  boundedFetch(node: ts.Node, depth: number): boolean {
    if (depth > 12) return false;
    const target = unwrap(node);
    if (ts.isIdentifier(target))
      return this.viaDeclarations(
        target,
        (init) => this.boundedFetch(init, depth + 1),
        (a, b) => a && b,
        false,
      );
    if (ts.isConditionalExpression(target))
      return (
        this.boundedFetch(target.whenTrue, depth + 1) &&
        this.boundedFetch(target.whenFalse, depth + 1)
      );
    if (ts.isCallExpression(target)) {
      if (this.registered(target.expression) === "fetch") return true;
      return this.viaReturns(
        target.expression,
        (returned) => this.boundedFetch(returned, depth + 1),
        (a, b) => a && b,
        false,
      );
    }
    if (ts.isFunctionLike(target)) return this.boundedFunction(target, depth);
    return false;
  }

  protected boundedFunction(
    fn: ts.SignatureDeclaration,
    depth: number,
  ): boolean {
    let reads = false;
    const scan = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        READERS.has(node.expression.name.text)
      )
        reads = true;
      ts.forEachChild(node, scan);
    };
    scan(fn);
    const returns = this.returnsOf(fn);
    return (
      !reads &&
      returns.length > 0 &&
      returns.every((returned) => this.boundedResponse(returned, depth + 1))
    );
  }

  /** Whether `node` is an answer that was read under the ceiling. */
  boundedResponse(node: ts.Node, depth: number): boolean {
    if (depth > 12) return false;
    const target = unwrap(node);
    if (ts.isIdentifier(target))
      return this.viaDeclarations(
        target,
        (init) => this.boundedResponse(init, depth + 1),
        (a, b) => a && b,
        false,
      );
    if (ts.isConditionalExpression(target))
      return (
        this.boundedResponse(target.whenTrue, depth + 1) &&
        this.boundedResponse(target.whenFalse, depth + 1)
      );
    if (!ts.isCallExpression(target)) return false;
    if (this.registered(target.expression) === "response") {
      const [first] = target.arguments;
      return first !== undefined && this.unread(first);
    }
    return this.boundedFetch(target.expression, depth + 1);
  }

  /** The answer as it came from the network: the result of a call, never one rebuilt from bytes already read. */
  protected unread(node: ts.Node): boolean {
    const target = unwrap(node);
    if (ts.isCallExpression(target)) return true;
    if (ts.isIdentifier(target))
      return (this.declarations.get(target.text) ?? []).every((declaration) =>
        ts.isCallExpression(unwrap(declaration)),
      );
    return false;
  }
}

import ts from "typescript";
import { CEILING_ARGUMENT, checkAt } from "./fetch-gate-ceilings.js";
import { FileFacts } from "./fetch-gate-facts.js";
import { readsIn } from "./fetch-gate-reads.js";
import { merge, unwrap, type State } from "./fetch-gate-syntax.js";

/*
 * Whether an expression resolves to the bounded transport. Names are
 * followed through the checker; anything the gate cannot see into (a
 * parameter, a value from outside, a helper that is not registered and does
 * not show its work) is unbounded.
 */

const DEPTH = 16;

export class Evaluator extends FileFacts {
  /** What the options of an OAuth call carry as their custom fetch. */
  optionsState(node: ts.Node, depth = 0): State {
    if (depth > DEPTH) return "unbounded";
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
          this.gatedOf(property.name.expression)?.name === "customFetch"
        )
          state =
            ts.isPropertyAssignment(property) ||
            ts.isMethodDeclaration(property)
              ? this.boundedFetch(
                  ts.isPropertyAssignment(property)
                    ? property.initializer
                    : property,
                  depth + 1,
                )
                ? "bounded"
                : "unbounded"
              : "unbounded";
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
    if (ts.isIdentifier(target) && target.text === "undefined") return "none";
    if (ts.isIdentifier(target)) {
      const values = this.declared(target);
      if (!values?.length) return "unbounded";
      return values
        .map((value) => this.optionsState(value, depth + 1))
        .reduce(merge);
    }
    if (ts.isCallExpression(target)) {
      if (this.registered(target.expression) === "options")
        return this.ceilingHolds(target) ? "bounded" : "unbounded";
      const fns = this.functionsOf(target.expression);
      const returns = fns?.flatMap((fn) => this.returnsOf(fn)) ?? [];
      if (!returns.length) return "unbounded";
      return returns
        .map((value) => this.optionsState(value, depth + 1))
        .reduce(merge);
    }
    return "unbounded";
  }

  /** The ceiling a registered call is given is one the gate accepts (fetch-gate-ceilings.ts); one passed in is its callers' to hold. */
  ceilingHolds(call: ts.CallExpression): boolean {
    const name = this.registeredAs(call.expression)?.name;
    const at = name ? CEILING_ARGUMENT[name] : undefined;
    return (
      !at ||
      checkAt(this, call.arguments[at.index], at.path).problems.length === 0
    );
  }

  /** Whether `node`, used as a custom fetch, hands back only answers read under the ceiling. */
  boundedFetch(node: ts.Node, depth: number): boolean {
    if (depth > DEPTH) return false;
    const target = unwrap(node);
    if (ts.isIdentifier(target) || ts.isPropertyAccessExpression(target)) {
      if (this.registered(target) === "fetch") return true;
      const values = this.declared(target);
      return Boolean(
        values?.length &&
        values.every((value) => this.boundedFetch(value, depth + 1)),
      );
    }
    if (ts.isConditionalExpression(target))
      return (
        this.boundedFetch(target.whenTrue, depth + 1) &&
        this.boundedFetch(target.whenFalse, depth + 1)
      );
    if (ts.isCallExpression(target)) {
      if (this.registered(target.expression) === "fetch")
        return this.ceilingHolds(target);
      const fns = this.functionsOf(target.expression);
      const returns = fns?.flatMap((fn) => this.returnsOf(fn)) ?? [];
      return (
        returns.length > 0 &&
        returns.every((value) => this.boundedFetch(value, depth + 1))
      );
    }
    if (ts.isFunctionLike(target)) return this.boundedFunction(target, depth);
    return false;
  }

  /**
   * A custom fetch of a file's own: nothing in it reads a body, rebuilds an
   * answer or hands one to a helper, and every path out of it returns an
   * answer read under the ceiling.
   */
  private boundedFunction(fn: ts.SignatureDeclaration, depth: number): boolean {
    if (readsIn(this, fn).length || this.rebuildsOrHandsOff(fn)) return false;
    const returns = this.returnsOf(fn);
    return (
      returns.length > 0 &&
      returns.every((returned) => this.boundedResponse(returned, depth + 1))
    );
  }

  /** `new Response(...)` anywhere in it, or an answer passed to anything but the bounded transport. */
  private rebuildsOrHandsOff(fn: ts.SignatureDeclaration): boolean {
    let found = false;
    const walk = (node: ts.Node): void => {
      if (found) return;
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Response"
      )
        found = true;
      if (
        ts.isCallExpression(node) &&
        this.registered(node.expression) !== "response" &&
        node.arguments.some((argument) => this.carriesAnswer(argument))
      )
        found = true;
      ts.forEachChild(node, walk);
    };
    walk(fn);
    return found;
  }

  /** An unread answer, or something reached from one (`r.clone()`, `r.body`). */
  private carriesAnswer(node: ts.Node): boolean {
    let current = unwrap(node);
    for (let depth = 0; depth < DEPTH; depth++) {
      if (this.unread(current, 0)) return true;
      if (ts.isCallExpression(current)) current = unwrap(current.expression);
      else if (
        ts.isPropertyAccessExpression(current) ||
        ts.isElementAccessExpression(current)
      )
        current = unwrap(current.expression);
      else return false;
    }
    return false;
  }

  /** Whether `node` is an answer that was read under the ceiling. */
  boundedResponse(node: ts.Node, depth: number): boolean {
    if (depth > DEPTH) return false;
    const target = unwrap(node);
    if (ts.isIdentifier(target)) {
      const values = this.declared(target);
      return Boolean(
        values?.length &&
        values.every((value) => this.boundedResponse(value, depth + 1)),
      );
    }
    if (ts.isConditionalExpression(target))
      return (
        this.boundedResponse(target.whenTrue, depth + 1) &&
        this.boundedResponse(target.whenFalse, depth + 1)
      );
    if (!ts.isCallExpression(target)) return false;
    if (this.registered(target.expression) === "response") {
      const [first] = target.arguments;
      return (
        first !== undefined &&
        this.unread(first, depth + 1) &&
        this.ceilingHolds(target)
      );
    }
    return this.boundedFetch(target.expression, depth + 1);
  }

  /**
   * The answer as it came from the network: the result of calling the
   * platform's `fetch` (or a value of its type), directly, through a `const`,
   * or through a function of this program whose every return is one and which
   * reads nothing. Never an answer built from bytes (`new Response(...)`),
   * never the result of a helper the gate cannot see into.
   */
  unread(node: ts.Node, depth: number): boolean {
    if (depth > DEPTH) return false;
    const target = unwrap(node);
    if (ts.isCallExpression(target)) {
      if (this.isFetch(target.expression)) return true;
      const fns = this.functionsOf(target.expression);
      return Boolean(
        fns?.length &&
        fns.every((fn) => {
          const returns = this.returnsOf(fn);
          return (
            returns.length > 0 &&
            readsIn(this, fn).length === 0 &&
            returns.every((value) => this.unread(value, depth + 1))
          );
        }),
      );
    }
    if (ts.isIdentifier(target)) {
      const values = this.declared(target);
      return Boolean(
        values?.length &&
        values.every((value) => this.unread(value, depth + 1)),
      );
    }
    return false;
  }
}

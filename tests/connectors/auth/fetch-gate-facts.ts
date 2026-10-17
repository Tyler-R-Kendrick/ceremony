import ts from "typescript";
import type { GateProgram } from "./fetch-gate-program.js";
import { GATED, REGISTRY, unwrap, type Kind } from "./fetch-gate-syntax.js";

/*
 * How a name in one source file resolves, through the type checker: to a
 * gated library's export, to a registered part of the bounded transport, or to
 * the declarations a value comes from. Nothing here judges; the evaluator and
 * the visitor do.
 */

export type Gated = { module: (typeof GATED)[number]; name: string };

export class FileFacts {
  readonly sf: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  readonly problems: string[] = [];
  /** Every gated call and custom fetch the gate read, as `file:line name`. */
  readonly inspected: string[] = [];

  constructor(
    readonly gate: GateProgram,
    readonly file: string,
    /** Registered names that do not vouch for themselves (the registry's own check). */
    readonly exclude: ReadonlySet<string> = new Set(),
  ) {
    const sf = gate.sourceFile(file);
    if (!sf) throw new Error(`${file} is not in the gate's program`);
    this.sf = sf;
    this.checker = gate.checker;
  }

  protected line(node: ts.Node): number {
    return this.sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  }

  note(node: ts.Node, what: string) {
    this.inspected.push(`${this.file}:${this.line(node)} ${what}`);
  }

  report(node: ts.Node, message: string) {
    this.problems.push(`${this.file}:${this.line(node)} ${message}`);
  }

  /** The symbol a node names, with imports and re-exports followed to what they name. */
  symbolOf(node: ts.Node): ts.Symbol | undefined {
    const at = ts.isPropertyAccessExpression(node)
      ? node.name
      : ts.isElementAccessExpression(node)
        ? node.argumentExpression
        : node;
    let symbol = this.checker.getSymbolAtLocation(at);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias)
      symbol = this.checker.getAliasedSymbol(symbol);
    return symbol;
  }

  /** The gated library a declaration belongs to, by the file it is declared in. */
  private moduleOf(declaration: ts.Node | undefined) {
    const file = declaration?.getSourceFile().fileName ?? "";
    return GATED.find((module) => file.includes(`/node_modules/${module}/`));
  }

  /** What a node names in a gated library: an export, or the module itself (`*`). */
  gatedOf(node: ts.Node): Gated | undefined {
    const symbol = this.symbolOf(node);
    const declaration = symbol?.declarations?.[0];
    const module = this.moduleOf(declaration);
    if (!symbol || !module) return undefined;
    return {
      module,
      name: declaration && ts.isSourceFile(declaration) ? "*" : symbol.name,
    };
  }

  /** The registered part of the bounded transport a node resolves to, if any. */
  registered(node: ts.Node): Kind | undefined {
    return this.registeredAs(node)?.kind;
  }

  /** The registered export a node resolves to, by kind and by the name it is declared under. */
  registeredAs(node: ts.Node): { kind: Kind; name: string } | undefined {
    const target = unwrap(node);
    if (!ts.isIdentifier(target) && !ts.isPropertyAccessExpression(target))
      return undefined;
    const symbol = this.symbolOf(target);
    const declaration = symbol?.declarations?.[0];
    if (!symbol || !declaration) return undefined;
    const kind =
      REGISTRY[this.gate.relative(declaration.getSourceFile())]?.[symbol.name];
    return kind && !this.exclude.has(symbol.name)
      ? { kind, name: symbol.name }
      : undefined;
  }

  /**
   * What a name's value comes from: the initializers and functions it is
   * declared as. Undefined when any declaration is something the gate cannot
   * see into (a parameter, a destructured binding, an ambient declaration):
   * then the value could be anything.
   */
  declared(node: ts.Node): ts.Node[] | undefined {
    const symbol = this.symbolOf(node);
    const declarations = symbol?.declarations;
    if (!declarations?.length) return undefined;
    const values: ts.Node[] = [];
    for (const declaration of declarations) {
      if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
        // A `let` may be reassigned anywhere; only a `const` is its initializer.
        const list = declaration.parent;
        if (
          !ts.isVariableDeclarationList(list) ||
          !(list.flags & ts.NodeFlags.Const)
        )
          return undefined;
        values.push(unwrap(declaration.initializer));
      } else if (
        ts.isFunctionDeclaration(declaration) ||
        ts.isFunctionExpression(declaration) ||
        ts.isArrowFunction(declaration) ||
        ts.isMethodDeclaration(declaration)
      )
        values.push(declaration);
      else return undefined;
    }
    return values;
  }

  /** The functions a callee resolves to, when every declaration of it is one. */
  functionsOf(callee: ts.Node): ts.SignatureDeclaration[] | undefined {
    const target = unwrap(callee);
    if (ts.isFunctionLike(target)) return [target];
    if (!ts.isIdentifier(target) && !ts.isPropertyAccessExpression(target))
      return undefined;
    const values = this.declared(target);
    if (!values?.length || !values.every((value) => ts.isFunctionLike(value)))
      return undefined;
    return values as ts.SignatureDeclaration[];
  }

  /** Every expression a function returns (its own returns, not nested functions'). */
  returnsOf(fn: ts.SignatureDeclaration): ts.Node[] {
    const body = (fn as { body?: ts.Node }).body;
    if (!body) return [];
    if (!ts.isBlock(body)) return [body];
    const found: ts.Node[] = [];
    const walk = (node: ts.Node) => {
      if (ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node) && node.expression)
        found.push(node.expression);
      ts.forEachChild(node, walk);
    };
    walk(body);
    return found;
  }

  /** Whether a callee is the platform's `fetch` (the global, or a value of its type). */
  isFetch(callee: ts.Node): boolean {
    const fetchType = this.gate.fetchType;
    if (!fetchType) return false;
    const type = this.checker.getTypeAtLocation(callee);
    const members = type.isUnion() ? type.types : [type];
    return members.every((member) => member === fetchType);
  }

  /** The declaration named `name` in this file, for the registry's own check. */
  ownDeclaration(name: string): ts.SignatureDeclaration | undefined {
    for (const statement of this.sf.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name)
        return statement;
      if (ts.isVariableStatement(statement))
        for (const declaration of statement.declarationList.declarations)
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === name &&
            declaration.initializer &&
            ts.isFunctionLike(unwrap(declaration.initializer))
          )
            return unwrap(declaration.initializer) as ts.SignatureDeclaration;
    }
    return undefined;
  }
}

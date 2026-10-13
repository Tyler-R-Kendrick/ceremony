import ts from "typescript";
import {
  GATED,
  REGISTRY,
  resolveImport,
  unwrap,
  type Kind,
  type NetworkExports,
  type Source,
} from "./fetch-gate-syntax.js";

/** What a source file imports and declares, and how a name in it resolves; nothing here judges. */
export class FileFacts {
  protected readonly sf: ts.SourceFile;
  protected readonly namespaces = new Map<string, string>();
  protected readonly named = new Map<
    string,
    { module: string; name: string }
  >();
  protected readonly relative = new Map<
    string,
    { path: string; name: string }
  >();
  protected readonly declarations = new Map<string, ts.Node[]>();
  readonly problems: string[] = [];
  /** Every gated call and custom fetch the gate read, as `file:line name`. */
  readonly inspected: string[] = [];

  constructor(
    protected readonly source: Source,
    protected readonly network: NetworkExports,
    protected readonly exclude: ReadonlySet<string> = new Set(),
  ) {
    this.sf = ts.createSourceFile(
      source.file,
      source.text,
      ts.ScriptTarget.ES2022,
      true,
      source.file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
  }

  protected note(node: ts.Node, what: string) {
    const line =
      this.sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    this.inspected.push(`${this.source.file}:${line} ${what}`);
  }

  protected report(node: ts.Node, message: string) {
    const line =
      this.sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    this.problems.push(`${this.source.file}:${line} ${message}`);
  }

  /** Imports and every declaration a name can be resolved to, in any scope. */
  protected collect(root: ts.Node) {
    const note = (name: string, node: ts.Node) =>
      this.declarations.set(name, [
        ...(this.declarations.get(name) ?? []),
        node,
      ]);
    const walk = (node: ts.Node) => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        this.collectImport(node, node.moduleSpecifier.text);
      if (ts.isImportEqualsDeclaration(node)) {
        const reference = node.moduleReference;
        if (
          ts.isExternalModuleReference(reference) &&
          ts.isStringLiteral(reference.expression) &&
          GATED.includes(reference.expression.text)
        )
          this.report(
            node,
            `imports ${reference.expression.text} by require; import it by name`,
          );
      }
      if (
        ts.isExportDeclaration(node) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        GATED.includes(node.moduleSpecifier.text)
      )
        this.report(
          node,
          `re-exports ${node.moduleSpecifier.text}, which hides its calls from the gate`,
        );
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer
      )
        note(node.name.text, node.initializer);
      if (ts.isFunctionDeclaration(node) && node.name)
        note(node.name.text, node);
      ts.forEachChild(node, walk);
    };
    walk(root);
  }

  protected collectImport(node: ts.ImportDeclaration, specifier: string) {
    const clause = node.importClause;
    if (!clause || clause.isTypeOnly) return;
    if (GATED.includes(specifier)) {
      if (clause.name) this.report(node, `default-imports ${specifier}`);
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings))
        this.namespaces.set(bindings.name.text, specifier);
      else if (bindings)
        for (const element of bindings.elements)
          if (!element.isTypeOnly)
            this.named.set(element.name.text, {
              module: specifier,
              name: (element.propertyName ?? element.name).text,
            });
    } else if (specifier.startsWith(".")) {
      const path = resolveImport(this.source.file, specifier);
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const element of bindings.elements)
          this.relative.set(element.name.text, {
            path,
            name: (element.propertyName ?? element.name).text,
          });
    }
  }

  /** What a node refers to in a gated library: `ns.name`, `ns["name"]` or a named import. */
  protected gatedRef(
    node: ts.Node,
  ): { module: string; name: string } | undefined {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression)
    ) {
      const module = this.namespaces.get(node.expression.text);
      return module ? { module, name: node.name.text } : undefined;
    }
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ts.isStringLiteralLike(node.argumentExpression)
    ) {
      const module = this.namespaces.get(node.expression.text);
      return module
        ? { module, name: node.argumentExpression.text }
        : undefined;
    }
    if (ts.isIdentifier(node)) return this.named.get(node.text);
    return undefined;
  }

  /** A registered export of the bounded transport, by the import that brought it in (or its own definition). */
  protected registered(node: ts.Node): Kind | undefined {
    const target = unwrap(node);
    if (!ts.isIdentifier(target)) return undefined;
    const imported = this.relative.get(target.text);
    const own = this.source.file;
    const path = imported?.path ?? own;
    const name = imported?.name ?? target.text;
    const kind = REGISTRY[path]?.[name];
    if (!kind || this.exclude.has(name)) return undefined;
    return imported || this.declarations.has(target.text) ? kind : undefined;
  }

  /** `combine` over every declaration a name resolves to; a name that resolves to none is `unresolved`. */
  protected viaDeclarations<T>(
    name: ts.Identifier,
    evaluate: (node: ts.Node) => T,
    combine: (a: T, b: T) => T,
    unresolved: T,
  ): T {
    const declared = this.declarations.get(name.text) ?? [];
    if (!declared.length) return unresolved;
    return declared.map(unwrap).map(evaluate).reduce(combine);
  }

  /** `combine` over what a locally defined function returns; a callee that is not one is `unresolved`. */
  protected viaReturns<T>(
    callee: ts.Node,
    evaluate: (node: ts.Node) => T,
    combine: (a: T, b: T) => T,
    unresolved: T,
  ): T {
    const target = unwrap(callee);
    const functions: ts.SignatureDeclaration[] = [];
    if (ts.isIdentifier(target))
      for (const declaration of this.declarations.get(target.text) ?? []) {
        const inner = unwrap(declaration);
        if (ts.isFunctionLike(inner)) functions.push(inner);
      }
    else if (ts.isFunctionLike(target)) functions.push(target);
    const returns = functions.flatMap((fn) => this.returnsOf(fn));
    if (!returns.length) return unresolved;
    return returns.map(evaluate).reduce(combine);
  }

  protected returnsOf(fn: ts.SignatureDeclaration): ts.Node[] {
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

  /** What the function declared as `name` returns. */
  exportedReturns(name: string): ts.Node[] {
    return (this.declarations.get(name) ?? []).flatMap((declaration) => {
      const inner = unwrap(declaration);
      return ts.isFunctionLike(inner) ? this.returnsOf(inner) : [];
    });
  }

  /** The names called inside the declaration of `exported`, for the registry's own check. */
  callsInside(exported: string): string[] {
    const calls: string[] = [];
    for (const declaration of this.declarations.get(exported) ?? []) {
      const walk = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression))
          calls.push(node.expression.text);
        ts.forEachChild(node, walk);
      };
      walk(declaration);
    }
    return calls;
  }
}

import { dirname, join, normalize } from "node:path";
import ts from "typescript";

/*
 * The gate on how OAuth answers are read, as a program over the syntax tree.
 *
 * A call into oauth4webapi or jose that can reach the network takes a fetch of
 * its own through the `customFetch` option, and without one it uses the global
 * fetch, whose answer nothing bounds. The gate finds those calls by what they
 * are bound to (an import of either library, under whatever name, as a
 * namespace or by name), not by how they are spelled, and requires for each
 * call that the option it is given resolves to the bounded transport.
 *
 * Which functions can reach the network is read from the libraries' own type
 * declarations: a function with a parameter whose type carries the
 * `customFetch` property. The list is derived, so an upgrade that adds a
 * request function is gated on arrival.
 *
 * "The bounded transport" is the registry below: `boundResponse` reads a body
 * under the ceiling, and the builders are the functions that apply it. A
 * builder counts only while its own body still applies the ceiling
 * (`checkRegistry`). A custom fetch of a file's own counts when every path out
 * of it returns an answer that went through `boundResponse` unread, or through
 * a bounded fetch, and nothing in it reads a body first.
 */

export type Source = { file: string; text: string };
export type NetworkExports = Record<string, Record<string, number[]>>;

const GATED = ["oauth4webapi", "jose"];

/** What each registered export of the bounded transport is: a response bounder, a fetch builder or an options builder. */
export const REGISTRY: Record<
  string,
  Record<string, "response" | "fetch" | "options">
> = {
  "src/server/connectors/auth/response-bound.ts": { boundResponse: "response" },
  "src/server/connectors/auth/wire.ts": {
    wireFetch: "fetch",
    requestOptions: "options",
  },
  "src/server/public-auth-fetch.ts": { boundedAuthFetch: "fetch" },
};

const READERS = new Set([
  "json",
  "text",
  "arrayBuffer",
  "blob",
  "formData",
  "bytes",
  "getReader",
]);

/** The exports of each gated library that take a fetch of their own, and at which parameter. */
export function deriveNetworkExports(root: string): NetworkExports {
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  };
  const found: NetworkExports = {};
  for (const specifier of GATED) {
    const resolved = ts.resolveModuleName(
      specifier,
      join(root, "src", "gate.ts"),
      options,
      ts.sys,
    ).resolvedModule;
    if (!resolved) throw new Error(`cannot resolve ${specifier}`);
    const program = ts.createProgram([resolved.resolvedFileName], options);
    const checker = program.getTypeChecker();
    const entry = program.getSourceFile(resolved.resolvedFileName)!;
    const exports: Record<string, number[]> = {};
    for (const exported of checker.getExportsOfModule(
      checker.getSymbolAtLocation(entry)!,
    )) {
      const target =
        exported.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(exported)
          : exported;
      for (const signature of checker
        .getTypeOfSymbol(target)
        .getCallSignatures())
        signature.getParameters().forEach((parameter, index) => {
          const type = checker.getNonNullableType(
            checker.getTypeOfSymbol(parameter),
          );
          const members = type.isUnion() ? type.types : [type];
          if (
            members.some((member) =>
              checker
                .getPropertiesOfType(member)
                .some((property) =>
                  property.escapedName.toString().startsWith("__@customFetch"),
                ),
            )
          )
            (exports[exported.name] ??= []).push(index);
        });
    }
    found[specifier] = exports;
  }
  return found;
}

type Kind = "response" | "fetch" | "options";
type State = "bounded" | "none" | "unbounded";

const merge = (a: State, b: State): State => (a === b ? a : "unbounded");

function unwrap(node: ts.Node): ts.Node {
  let current = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAwaitExpression(current)
    )
      current = current.expression;
    else return current;
  }
}

/** Resolves a relative import specifier to the repository path it names. */
function resolveImport(file: string, specifier: string): string {
  const target = normalize(join(dirname(file), specifier));
  return target.replace(/\.js$/, ".ts");
}

/** Checks one source file; the findings are sentences naming file and line. */
class FileGate {
  private readonly sf: ts.SourceFile;
  private readonly namespaces = new Map<string, string>();
  private readonly named = new Map<string, { module: string; name: string }>();
  private readonly relative = new Map<string, { path: string; name: string }>();
  private readonly declarations = new Map<string, ts.Node[]>();
  readonly problems: string[] = [];
  /** Every gated call and custom fetch the gate read, as `file:line name`. */
  readonly inspected: string[] = [];

  constructor(
    private readonly source: Source,
    private readonly network: NetworkExports,
    private readonly exclude: ReadonlySet<string> = new Set(),
  ) {
    this.sf = ts.createSourceFile(
      source.file,
      source.text,
      ts.ScriptTarget.ES2022,
      true,
      source.file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
  }

  private note(node: ts.Node, what: string) {
    const line =
      this.sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    this.inspected.push(`${this.source.file}:${line} ${what}`);
  }

  private report(node: ts.Node, message: string) {
    const line =
      this.sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    this.problems.push(`${this.source.file}:${line} ${message}`);
  }

  run(): string[] {
    this.collect(this.sf);
    this.visit(this.sf);
    return this.problems;
  }

  /** Imports and every declaration a name can be resolved to, in any scope. */
  private collect(root: ts.Node) {
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

  private collectImport(node: ts.ImportDeclaration, specifier: string) {
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
  private gatedRef(
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
  private registered(node: ts.Node): Kind | undefined {
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

  /** `combine` over every declaration a name resolves to; a name that resolves to none is `unresolved`. */
  private viaDeclarations<T>(
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
  private viaReturns<T>(
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

  private returnsOf(fn: ts.SignatureDeclaration): ts.Node[] {
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

  private boundedFunction(fn: ts.SignatureDeclaration, depth: number): boolean {
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
  private unread(node: ts.Node): boolean {
    const target = unwrap(node);
    if (ts.isCallExpression(target)) return true;
    if (ts.isIdentifier(target))
      return (this.declarations.get(target.text) ?? []).every((declaration) =>
        ts.isCallExpression(unwrap(declaration)),
      );
    return false;
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

/** Every problem the sources have, as sentences; empty when the gate holds. */
export function gateProblems(
  sources: Source[],
  network: NetworkExports,
): string[] {
  return sources.flatMap((source) => new FileGate(source, network).run());
}

/** The gated calls and custom fetches the gate read, so a test can say it saw the ones it should. */
export function gateInspected(
  sources: Source[],
  network: NetworkExports,
): string[] {
  return sources.flatMap((source) => {
    const gate = new FileGate(source, network);
    gate.run();
    return gate.inspected;
  });
}

/** The number of zero-argument body reads in each source that has any. */
export function bodyReadCounts(sources: Source[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const source of sources) {
    const lines = new FileGate(source, {}).bodyReads();
    if (lines.length) counts[source.file] = lines.length;
  }
  return counts;
}

/**
 * The registered builders must still apply the ceiling: a response bounder
 * reads through `readBoundedBytes`, and a fetch or options builder is bounded
 * by the same rules as any other custom fetch, with itself taken out of the
 * registry so it cannot vouch for itself.
 */
export function checkRegistry(
  read: (file: string) => string | undefined,
  network: NetworkExports,
): string[] {
  const found: string[] = [];
  for (const [file, members] of Object.entries(REGISTRY)) {
    const text = read(file);
    if (text === undefined) {
      found.push(`${file} is in the registry and does not exist`);
      continue;
    }
    for (const [name, kind] of Object.entries(members)) {
      const gate = new FileGate({ file, text }, network, new Set([name]));
      gate.run();
      if (!gate.exportedReturns(name).length) {
        found.push(
          `${file} ${name} is in the registry and is not declared there`,
        );
        continue;
      }
      if (kind === "response") {
        if (!gate.callsInside(name).includes("readBoundedBytes"))
          found.push(
            `${file} ${name} no longer reads through readBoundedBytes`,
          );
      } else if (kind === "fetch") {
        const returns = gate.exportedReturns(name);
        if (!returns.every((returned) => gate.boundedFetch(returned, 0)))
          found.push(
            `${file} ${name} no longer returns a fetch that reads under the ceiling`,
          );
      } else {
        const returns = gate.exportedReturns(name);
        if (
          !returns.every(
            (returned) => gate.optionsState(returned) === "bounded",
          )
        )
          found.push(
            `${file} ${name} no longer returns options with a bounded custom fetch`,
          );
      }
    }
  }
  return found;
}

import { execFileSync } from "node:child_process";
import { isAbsolute, join, relative } from "node:path";
import ts from "typescript";

/*
 * One TypeScript program over every tracked source file (and, for the tests,
 * sources that exist only in memory), so that a name is resolved the way the
 * compiler resolves it: a parameter is a parameter, a shadowed local is that
 * local, and an import is followed to the declaration it names.
 */

/** Generated deployment output, compiled from the tracked sources the gate reads. */
const BUILD_OUTPUT = /^(?:\.vercel\/output|dist)\//;

/** Sources the gate exists to refuse; they are read as data by its own tests. */
const GATE_FIXTURES =
  /^tests\/connectors\/auth\/fetch-gate-(?:fixtures|battery)\.ts$/;

/** Every tracked TypeScript or JavaScript source, outside dependencies, build output and the gate's own fixtures. */
export function trackedSources(root: string): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(
      (file) =>
        /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(file) &&
        !/(?:^|\/)node_modules\//.test(file) &&
        !BUILD_OUTPUT.test(file) &&
        !GATE_FIXTURES.test(file),
    );
}

export type GateProgram = {
  root: string;
  program: ts.Program;
  checker: ts.TypeChecker;
  /** The type of the global `fetch`: what an unread answer comes from. */
  fetchType: ts.Type | undefined;
  /** Repository-relative path of a source file in the program. */
  relative(file: ts.SourceFile | string): string;
  sourceFile(file: string): ts.SourceFile | undefined;
};

const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  lib: ["lib.es2024.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  allowJs: true,
  checkJs: false,
  jsx: ts.JsxEmit.ReactJSX,
  strict: true,
  esModuleInterop: true,
  resolveJsonModule: true,
  skipLibCheck: true,
  noEmit: true,
};

/** A program over `files` (repository-relative), plus `virtual` sources served from memory at their paths. */
export function gateProgram(
  root: string,
  files: readonly string[],
  virtual: Readonly<Record<string, string>> = {},
): GateProgram {
  const absolute = (file: string) =>
    isAbsolute(file) ? file : join(root, file);
  const memory = new Map(
    Object.entries(virtual).map(([file, text]) => [absolute(file), text]),
  );
  const host = ts.createCompilerHost(options, true);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, language, onError, create) => {
    const text = memory.get(fileName);
    return text === undefined
      ? getSourceFile(fileName, language, onError, create)
      : ts.createSourceFile(fileName, text, language, true);
  };
  const fileExists = host.fileExists.bind(host);
  host.fileExists = (fileName) => memory.has(fileName) || fileExists(fileName);
  const readFile = host.readFile.bind(host);
  host.readFile = (fileName) => memory.get(fileName) ?? readFile(fileName);
  const program = ts.createProgram(
    [...files.map(absolute), ...memory.keys()],
    options,
    host,
  );
  const checker = program.getTypeChecker();
  const fetchSymbol = checker.resolveName(
    "fetch",
    undefined,
    ts.SymbolFlags.Value,
    false,
  );
  return {
    root,
    program,
    checker,
    fetchType: fetchSymbol && checker.getTypeOfSymbol(fetchSymbol),
    relative: (file) =>
      relative(root, typeof file === "string" ? file : file.fileName),
    sourceFile: (file) => program.getSourceFile(absolute(file)),
  };
}

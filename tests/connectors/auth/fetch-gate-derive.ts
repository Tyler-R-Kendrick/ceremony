import { join } from "node:path";
import ts from "typescript";
import { GATED, type NetworkExports } from "./fetch-gate-syntax.js";

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

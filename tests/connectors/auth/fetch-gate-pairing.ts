import ts from "typescript";
import { FileFacts } from "./fetch-gate-facts.js";
import { callsTo, spellingsOf } from "./fetch-gate-forwards.js";
import type { GateProgram } from "./fetch-gate-program.js";
import { unwrap } from "./fetch-gate-syntax.js";

/*
 * A ceiling is shown to work by serving an answer that never ends to the code
 * that reads under it. So every bounded site, a production call where the
 * gate accepted the ceiling a body is read under (fetch-gate.ts), must be
 * named by at least one test that serves it an endless body. A test names
 * the sites it serves by passing them to the endless-body double
 * (tests/connectors/doubles/endless-body.ts), in the very call that serves
 * the body, as a list of string literals the gate reads; a site is its file
 * and the function around the call (`file#function`, or the module-level
 * `const` it sits in). A site no test names fails, and so does a name that
 * is not a site (one that was renamed or removed), so the pairing cannot go
 * stale in either direction.
 */

export const DOUBLE = "tests/connectors/doubles/endless-body.ts";
const SERVERS = new Set(["endlessBody", "endlessResponse", "endlessFetch"]);

const isTest = (file: string) => file.startsWith("tests/");

/** The function a call sits in, by the name it is declared under, or the module-level `const` around it. */
export function siteOf(file: string, call: ts.Node): string {
  let top: string | undefined;
  for (let up = call.parent; up; up = up.parent) {
    if (
      (ts.isFunctionDeclaration(up) || ts.isMethodDeclaration(up)) &&
      up.name &&
      ts.isIdentifier(up.name)
    )
      return `${file}#${up.name.text}`;
    if (
      (ts.isArrowFunction(up) || ts.isFunctionExpression(up)) &&
      (ts.isVariableDeclaration(up.parent) ||
        ts.isPropertyAssignment(up.parent)) &&
      ts.isIdentifier(up.parent.name)
    )
      return `${file}#${up.parent.name.text}`;
    if (ts.isVariableStatement(up) && ts.isSourceFile(up.parent)) {
      const name = up.declarationList.declarations[0]?.name;
      if (name && ts.isIdentifier(name)) top = name.text;
    }
  }
  return `${file}#${top ?? "module"}`;
}

const DEPTH = 6;

/**
 * The string literals a sites argument holds: an array literal of them, a
 * `const` holding one, or a parameter of a wrapper around the double, read at
 * every call of the wrapper in `files`. Undefined when any part is a form the
 * gate cannot read.
 */
function literals(
  gate: GateProgram,
  files: readonly string[],
  facts: FileFacts,
  node: ts.Node | undefined,
  depth = 0,
): string[] | undefined {
  if (!node || depth > DEPTH) return undefined;
  const target = unwrap(node);
  if (ts.isArrayLiteralExpression(target)) {
    const names = target.elements.map((element) => unwrap(element));
    return names.every(ts.isStringLiteralLike)
      ? names.map((name) => name.text)
      : undefined;
  }
  if (!ts.isIdentifier(target)) return undefined;
  const declaration = facts.symbolOf(target)?.declarations?.[0];
  if (declaration && ts.isParameter(declaration)) {
    const wrapper = declaration.parent;
    if (!ts.isFunctionLike(wrapper)) return undefined;
    const index = wrapper.parameters.indexOf(declaration);
    const calls = callsTo(
      gate,
      files,
      wrapper,
      spellingsOf(gate, files, wrapper),
    );
    if (!calls.length) return undefined;
    const all: string[] = [];
    for (const { facts: at, call } of calls) {
      const found = literals(gate, files, at, call.arguments[index], depth + 1);
      if (!found) return undefined;
      all.push(...found);
    }
    return all;
  }
  const values = facts.declared(target);
  return values?.length === 1
    ? literals(gate, files, facts, values[0], depth + 1)
    : undefined;
}

/** Which sites the tests in `files` serve an endless body to (and where), and namings the gate cannot read. */
function namedSites(gate: GateProgram, files: readonly string[]) {
  const named = new Map<string, string>();
  const problems: string[] = [];
  for (const file of files) {
    const sf = gate.sourceFile(file);
    if (!isTest(file) || file === DOUBLE || !sf) continue;
    if (![...SERVERS].some((name) => sf.text.includes(name))) continue;
    const facts = new FileFacts(gate, file);
    const visit = (node: ts.Node): void => {
      const served =
        ts.isCallExpression(node) &&
        facts
          .functionsOf(node.expression)
          ?.some(
            (fn) =>
              gate.relative(fn.getSourceFile()) === DOUBLE &&
              fn.name !== undefined &&
              ts.isIdentifier(fn.name) &&
              SERVERS.has(fn.name.text),
          );
      if (served) {
        const sites = literals(gate, files, facts, node.arguments[1]);
        if (!sites)
          facts.report(
            node,
            "serves an endless body to sites named in a form the gate cannot read; name them as a list of string literals",
          );
        const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        for (const site of sites ?? [])
          if (!named.has(site)) named.set(site, `${file}:${line}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    problems.push(...facts.problems);
  }
  return { named, problems };
}

/**
 * What the pairing between bounded sites and endless-body tests lacks, given
 * the calls where `runGate` accepted a ceiling (the production ones are the
 * sites) and the test files in `files` that may name them.
 */
export function pairingProblems(
  gate: GateProgram,
  files: readonly string[],
  accepted: ReadonlyArray<{ file: string; call: ts.Node }>,
): string[] {
  const sites = new Set(
    accepted
      .filter(({ file }) => !isTest(file))
      .map(({ file, call }) => siteOf(file, call)),
  );
  const { named, problems } = namedSites(gate, files);
  for (const site of [...sites].sort())
    if (!named.has(site))
      problems.push(
        `${site}: no test serves it an endless body (name it in an endless-body double's sites)`,
      );
  for (const [site, where] of named)
    if (!sites.has(site))
      problems.push(
        `${where} names ${site}, which is not a bounded site the gate accepts`,
      );
  return problems;
}

import ts from "typescript";
import { FileFacts } from "./fetch-gate-facts.js";
import { callsTo, spellingsOf } from "./fetch-gate-forwards.js";
import { neverRuns } from "./fetch-gate-liveness.js";
import { mentionedOrigins, originsOf } from "./fetch-gate-origins.js";
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
 *
 * A name in a string is not a test. The call that serves the body must also
 * be live (not under `skip` or `todo`, not in a branch a literal closes: see
 * fetch-gate-liveness.ts), its answer must be used (not discarded, not held in
 * a variable nothing reads), and the counter it is given (`seen`) must be the
 * one a live `assertReadUnder` in the same file asserts on, followed through
 * constants, wrapper parameters and returned objects (fetch-gate-origins.ts):
 * a test that serves nothing, or asserts nothing, names nothing.
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

/** Whether `call` is a call to the endless-body double's function named `name`. */
const callsDouble = (
  facts: FileFacts,
  call: ts.CallExpression,
  names: ReadonlySet<string>,
) =>
  facts
    .functionsOf(call.expression)
    ?.some(
      (fn) =>
        facts.gate.relative(fn.getSourceFile()) === DOUBLE &&
        fn.name !== undefined &&
        ts.isIdentifier(fn.name) &&
        names.has(fn.name.text),
    ) === true;

/** Why the answer a call serves is not used: discarded, or held in a variable nothing reads. */
function unusedAnswer(facts: FileFacts, call: ts.CallExpression) {
  let node: ts.Node = call;
  while (
    ts.isParenthesizedExpression(node.parent) ||
    ts.isAsExpression(node.parent) ||
    ts.isNonNullExpression(node.parent) ||
    ts.isAwaitExpression(node.parent)
  )
    node = node.parent;
  const parent = node.parent;
  if (ts.isExpressionStatement(parent) || ts.isVoidExpression(parent))
    return "discards the endless answer it serves; the test must use it";
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    const symbol = facts.checker.getSymbolAtLocation(parent.name);
    let reads = 0;
    const count = (inner: ts.Node): void => {
      if (
        ts.isIdentifier(inner) &&
        inner !== parent.name &&
        facts.checker.getSymbolAtLocation(inner) === symbol
      )
        reads++;
      ts.forEachChild(inner, count);
    };
    count(facts.sf);
    if (!reads)
      return "holds the endless answer it serves in a variable nothing uses";
  }
  return undefined;
}

const ASSERT = new Set(["assertReadUnder"]);

/** The counters the live `assertReadUnder` calls in a file assert on. */
function assertedCounters(
  gate: GateProgram,
  files: readonly string[],
  facts: FileFacts,
) {
  const asserted = new Set<ts.Node>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      callsDouble(facts, node, ASSERT) &&
      node.arguments[1] &&
      !neverRuns(node)
    )
      for (const origin of mentionedOrigins(
        gate,
        files,
        facts.file,
        node.arguments[1],
      ))
        asserted.add(origin);
    ts.forEachChild(node, visit);
  };
  visit(facts.sf);
  return asserted;
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
    let asserted: Set<ts.Node> | undefined;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && callsDouble(facts, node, SERVERS)) {
        const sites = literals(gate, files, facts, node.arguments[1]);
        if (!sites)
          facts.report(
            node,
            "serves an endless body to sites named in a form the gate cannot read; name them as a list of string literals",
          );
        const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        // What makes a naming a test: the call runs, its answer is used, and
        // its counter is asserted on.
        asserted ??= assertedCounters(gate, files, facts);
        const counters = node.arguments[0]
          ? originsOf(gate, files, file, node.arguments[0])
          : new Set<ts.Node>();
        const hollow = [
          unusedAnswer(facts, node),
          neverRuns(node) && `serves an endless body ${neverRuns(node)}`,
          ![...counters].some((origin) => asserted!.has(origin)) &&
            "serves an endless body whose counter never reaches assertReadUnder in this file; the test must assert that the read stopped",
        ].filter((reason): reason is string => Boolean(reason));
        for (const reason of hollow) facts.report(node, reason);
        if (!hollow.length)
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

import ts from "typescript";
import {
  CEILING_ARGUMENT,
  calleeName,
  callsTo,
  checkAt,
  type Forward,
} from "./fetch-gate-ceilings.js";
import { aliasProblems } from "./fetch-gate-aliases.js";
import { Evaluator } from "./fetch-gate-evaluator.js";
import type { GateProgram } from "./fetch-gate-program.js";
import { readsIn } from "./fetch-gate-reads.js";
import {
  REGISTRY,
  type Kind,
  type NetworkExports,
} from "./fetch-gate-syntax.js";
import { FileGate } from "./fetch-gate-visitor.js";

/*
 * The gate on how OAuth answers are read, as a program over the TypeScript
 * checker.
 *
 * Part A. A call into oauth4webapi or jose that can reach the network takes a
 * fetch of its own through the `customFetch` option, and without one it uses
 * the global fetch, whose answer nothing bounds. The gate finds those calls
 * by what they resolve to (fetch-gate-visitor.ts), takes which functions can
 * reach the network from the libraries' own declarations
 * (fetch-gate-derive.ts), and requires the options of each call to resolve to
 * the bounded transport (fetch-gate-evaluator.ts). Every ceiling handed to
 * that transport must be a constant within its bound (fetch-gate-ceilings.ts).
 * The registered builders are checked against their own source.
 *
 * Part B. The response bodies read by hand, in every shape a read can take
 * (fetch-gate-reads.ts), counted per file for the ledger in the test.
 */

export { deriveNetworkExports } from "./fetch-gate-derive.js";
export { gateProgram, trackedSources } from "./fetch-gate-program.js";
export { REGISTRY, type NetworkExports } from "./fetch-gate-syntax.js";

const BOUNDED_NAMES = /readBoundedBytes|boundResponse|wireFetch|requestOptions/;

/** Every ceiling handed to the bounded transport in `files`, followed through the functions that pass one on. */
function ceilingProblems(
  gate: GateProgram,
  files: readonly string[],
): string[] {
  const problems = new Set<string>();
  const seen = new Set<string>();
  const queue: Forward[] = [];
  const judge = (
    file: string,
    call: ts.CallExpression,
    index: number,
    path: string[],
  ) => {
    const facts = new Evaluator(gate, file);
    const verdict = checkAt(facts, call.arguments[index], path);
    for (const text of verdict.problems) facts.report(call, text);
    for (const text of facts.problems) problems.add(text);
    queue.push(...verdict.forwards);
  };
  for (const file of files) {
    const sf = gate.sourceFile(file);
    if (!sf || !BOUNDED_NAMES.test(sf.text)) continue;
    const facts = new Evaluator(gate, file);
    const renamed =
      /\b(?:readBoundedBytes|boundResponse|wireFetch|requestOptions) as /.test(
        sf.text,
      );
    const walk = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        (renamed || BOUNDED_NAMES.test(calleeName(node.expression) ?? ""))
      ) {
        const name = facts.registeredAs(node.expression)?.name;
        const at = name ? CEILING_ARGUMENT[name] : undefined;
        if (at) judge(file, node, at.index, at.path);
      }
      ts.forEachChild(node, walk);
    };
    walk(sf);
    aliasProblems(facts, sf);
    for (const text of facts.problems) problems.add(text);
  }
  while (queue.length) {
    const next = queue.shift()!;
    const key = `${next.fn.getSourceFile().fileName}:${next.fn.pos}:${next.index}:${next.path.join(".")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const { facts, call } of callsTo(gate, files, next.fn))
      judge(facts.file, call, next.index, next.path);
  }
  return [...problems];
}

/** The problems `files` have (as sentences naming file and line; empty when the gate holds) and the gated calls and custom fetches it read. */
export function runGate(
  gate: GateProgram,
  files: readonly string[],
  network: NetworkExports,
): { problems: string[]; inspected: string[] } {
  const visitors = files.map((file) => {
    const visitor = new FileGate(gate, file);
    visitor.run(network);
    return visitor;
  });
  return {
    problems: [
      ...visitors.flatMap((visitor) => visitor.problems),
      ...ceilingProblems(gate, files),
    ],
    inspected: visitors.flatMap((visitor) => visitor.inspected),
  };
}

/** The number of body reads in each file that has any. */
export function bodyReadCounts(
  gate: GateProgram,
  files: readonly string[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const file of files) {
    const facts = new Evaluator(gate, file);
    const reads = readsIn(facts, facts.sf).length;
    if (reads) counts[file] = reads;
  }
  return counts;
}

/**
 * The registered transport must still do what it is trusted for: the reader
 * stops at its ceiling, the response bounder reads through the reader, and a
 * fetch or options builder is bounded by the same rules as any other custom
 * fetch, with itself taken out of the registry so it cannot vouch for itself.
 */
export function checkRegistry(gate: GateProgram): string[] {
  const found: string[] = [];
  for (const [file, members] of Object.entries(REGISTRY)) {
    if (!gate.sourceFile(file)) {
      found.push(`${file} is in the registry and is not in the program`);
      continue;
    }
    for (const [name, kind] of Object.entries(members)) {
      const facts = new Evaluator(gate, file, new Set([name]));
      const declaration = facts.ownDeclaration(name);
      if (!declaration) {
        found.push(
          `${file} ${name} is in the registry and is not declared there`,
        );
        continue;
      }
      const returns = facts.returnsOf(declaration);
      let calls = 0;
      let readerCalls = 0;
      let readerLoops = 0;
      const walk = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          calls++;
          if (facts.registered(node.expression) === "reader") readerCalls++;
          if (
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "getReader"
          )
            readerLoops++;
        }
        ts.forEachChild(node, walk);
      };
      walk(declaration);
      const ok =
        kind === "reader"
          ? readerLoops > 0 && readsIn(facts, declaration).length === 0
          : kind === "response"
            ? readerCalls > 0
            : kind === "fetch"
              ? returns.length > 0 &&
                returns.every((value) => facts.boundedFetch(value, 0))
              : returns.length > 0 &&
                returns.every(
                  (value) => facts.optionsState(value) === "bounded",
                );
      if (!ok || calls === 0)
        found.push(
          `${file} ${name} no longer does what the registry trusts it for (${kind})`,
        );
    }
  }
  return found;
}

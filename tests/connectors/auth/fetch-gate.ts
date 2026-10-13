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

import { FileGate } from "./fetch-gate-visitor.js";
import {
  REGISTRY,
  type NetworkExports,
  type Source,
} from "./fetch-gate-syntax.js";

export { deriveNetworkExports } from "./fetch-gate-derive.js";
export {
  REGISTRY,
  type NetworkExports,
  type Source,
} from "./fetch-gate-syntax.js";

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

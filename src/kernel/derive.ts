/**
 * The components a flow needs, derived rather than listed.
 *
 * A human step's interface is needed only where the cheapest plan runs that
 * step. `necessary` are the interfaces some fault-free run shows; `contingent`
 * are the ones only a fallback reaches; `unreachable` are declared and never
 * shown, which is a declaration to delete.
 */
import {
  names,
  type Ceremony,
  type InterfaceSpec,
  type OperatorDecl,
} from "./ceremony.js";
import {
  check,
  cooperate,
  startingWorlds,
  type CheckOptions,
} from "./model.js";

export interface DerivedComponent {
  readonly operator: string;
  readonly interface: InterfaceSpec;
  readonly need: "necessary" | "contingent" | "unreachable";
}

export interface PathFromWorld {
  /** Facts already true when the run starts. */
  readonly world: readonly string[];
  readonly status: "success" | "failed";
  readonly probes: readonly string[];
  readonly acts: readonly string[];
  /** Human steps on this path, in order. */
  readonly interfaces: readonly string[];
  readonly cost: number;
}

export interface Derivation {
  readonly ceremony: string;
  readonly components: readonly DerivedComponent[];
  /** The fault-free run from each starting world, cheapest first. */
  readonly paths: readonly PathFromWorld[];
}

export function derive(
  ceremony: Ceremony,
  options: CheckOptions = {},
): Derivation {
  const compiled = ceremony.compiled;
  const human = compiled.operators.filter((op) => op.human);
  const isHuman = new Set(human.map((op) => op.id));
  const paths: PathFromWorld[] = startingWorlds(compiled)
    .map((world) => {
      const held = names(compiled, world);
      const run = cooperate(ceremony, held);
      return {
        world: held,
        status: run.status,
        probes: run.probes,
        acts: run.acts,
        interfaces: run.acts.filter((id) => isHuman.has(id)),
        cost: run.cost,
      };
    })
    .sort((a, b) => a.cost - b.cost || a.world.length - b.world.length);
  const necessary = new Set(paths.flatMap((path) => path.interfaces));
  const reached = new Set(check(ceremony, options).operatorsUsed);
  return {
    ceremony: ceremony.id,
    paths,
    components: human.map((op) => ({
      operator: op.id,
      interface: (ceremony.operators[op.id] as OperatorDecl)
        .interface as InterfaceSpec,
      need: necessary.has(op.id)
        ? "necessary"
        : reached.has(op.id)
          ? "contingent"
          : "unreachable",
    })),
  };
}

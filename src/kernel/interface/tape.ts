/**
 * A layout as a straight-line program.
 *
 * Following Shu Ding's calculus of interfaces: the interface is one function
 * from its inputs (container width, font scale, content lengths) to the
 * position and size of every box, written as a list of operations with no
 * branches or loops. Only four operations exist: a weighted sum, a product, a
 * ReLU and a step. A breakpoint is a step that blends both outcomes; a
 * maximum is a ReLU; a line count is a sum of steps. Because the program is
 * data, the same program can be run exactly, softened, differentiated or
 * bounded over a whole range of inputs.
 */
export type Ref = number & { readonly ref: unique symbol };

export type Node =
  | { readonly op: "input"; readonly name: string }
  | {
      readonly op: "sum";
      readonly terms: readonly (readonly [number, Ref])[];
      readonly bias: number;
    }
  | { readonly op: "mul"; readonly a: Ref; readonly b: Ref }
  | { readonly op: "relu"; readonly a: Ref }
  /** 1 where the argument is zero or more, otherwise 0. */
  | { readonly op: "step"; readonly a: Ref };

/**
 * What a node was built to mean, kept beside the program. The four operations
 * compute it either way; a reading that can do better knowing the intent (a
 * bound that need not count the same term twice) may use it.
 */
export type Hint =
  | { readonly kind: "max" | "min"; readonly a: Ref; readonly b: Ref }
  | {
      readonly kind: "blend";
      readonly gate: Ref;
      readonly then: Ref;
      readonly otherwise: Ref;
    };

export class Tape {
  readonly nodes: Node[] = [];
  readonly inputs = new Map<string, Ref>();
  readonly hints = new Map<Ref, Hint>();

  private push(node: Node): Ref {
    this.nodes.push(node);
    return (this.nodes.length - 1) as Ref;
  }

  input(name: string): Ref {
    const existing = this.inputs.get(name);
    if (existing !== undefined) return existing;
    const ref = this.push({ op: "input", name });
    this.inputs.set(name, ref);
    return ref;
  }

  /**
   * A weighted sum. Sums of sums are flattened and like terms merged, so a
   * quantity such as `width - (pad + (width - 2 * pad))` is stored as `pad`:
   * what cancels on paper cancels here, and bounds stay as tight as the
   * arithmetic allows.
   */
  sum(terms: readonly (readonly [number, Ref])[], bias = 0): Ref {
    const weights = new Map<Ref, number>();
    let constant = bias;
    for (const [weight, ref] of terms) {
      const node = this.nodes[ref] as Node;
      if (node.op === "sum") {
        constant += weight * node.bias;
        for (const [inner, innerRef] of node.terms) {
          weights.set(innerRef, (weights.get(innerRef) ?? 0) + weight * inner);
        }
      } else {
        weights.set(ref, (weights.get(ref) ?? 0) + weight);
      }
    }
    const merged = [...weights.entries()]
      .filter(([, weight]) => weight !== 0)
      .sort(([a], [b]) => a - b)
      .map(([ref, weight]) => [weight, ref] as const);
    return this.push({ op: "sum", terms: merged, bias: constant });
  }

  constant(value: number): Ref {
    return this.sum([], value);
  }

  add(a: Ref, b: Ref, bias = 0): Ref {
    return this.sum(
      [
        [1, a],
        [1, b],
      ],
      bias,
    );
  }

  sub(a: Ref, b: Ref, bias = 0): Ref {
    return this.sum(
      [
        [1, a],
        [-1, b],
      ],
      bias,
    );
  }

  /** `factor * a + bias`. */
  affine(a: Ref, factor: number, bias = 0): Ref {
    return this.sum([[factor, a]], bias);
  }

  /** A product; by a constant it is a weighted sum, so it still cancels. */
  mul(a: Ref, b: Ref): Ref {
    const left = this.nodes[a] as Node;
    const right = this.nodes[b] as Node;
    if (left.op === "sum" && left.terms.length === 0) {
      return this.affine(b, left.bias);
    }
    if (right.op === "sum" && right.terms.length === 0) {
      return this.affine(a, right.bias);
    }
    return this.push({ op: "mul", a, b });
  }

  relu(a: Ref): Ref {
    return this.push({ op: "relu", a });
  }

  step(a: Ref): Ref {
    return this.push({ op: "step", a });
  }

  max(a: Ref, b: Ref): Ref {
    const ref = this.add(b, this.relu(this.sub(a, b)));
    this.hints.set(ref, { kind: "max", a, b });
    return ref;
  }

  min(a: Ref, b: Ref): Ref {
    const ref = this.sub(a, this.relu(this.sub(a, b)));
    this.hints.set(ref, { kind: "min", a, b });
    return ref;
  }

  /** `then` where `gate` is 1 and `otherwise` where it is 0: a blend, not a branch. */
  blend(gate: Ref, then: Ref, otherwise: Ref): Ref {
    const ref = this.add(otherwise, this.mul(gate, this.sub(then, otherwise)));
    this.hints.set(ref, { kind: "blend", gate, then, otherwise });
    return ref;
  }

  /** `then` where `condition` is zero or more, `otherwise` elsewhere. */
  when(condition: Ref, then: Ref, otherwise: Ref): Ref {
    return this.blend(this.step(condition), then, otherwise);
  }

  /**
   * How many whole `unit`s fit under `amount`, plus one: the number of lines a
   * run of text needs. One step per possible count, up to `most`.
   */
  countUp(amount: Ref, unit: Ref, most: number): Ref {
    const steps: (readonly [number, Ref])[] = [];
    for (let k = 1; k < most; k += 1) {
      steps.push([
        1,
        this.step(
          this.sum([
            [1, amount],
            [-k, unit],
          ]),
        ),
      ]);
    }
    return this.sum(steps, 1);
  }
}

/** What it takes to run a tape: a meaning for each of the four operations. */
export interface Algebra<T> {
  constant(value: number): T;
  sum(terms: readonly (readonly [number, T])[], bias: number): T;
  mul(a: T, b: T): T;
  relu(a: T): T;
  step(a: T): T;
  /** Tighten a computed value using what the node was built to mean. */
  refine?(value: T, hint: Hint, at: (ref: Ref) => T): T;
}

/** `assumed` fixes the value of chosen step nodes, for reasoning by cases. */
export function run<T>(
  tape: Tape,
  algebra: Algebra<T>,
  inputs: Readonly<Record<string, T>>,
  assumed?: ReadonlyMap<Ref, T>,
): T[] {
  const values: T[] = [];
  const at = (ref: Ref): T => values[ref] as T;
  for (let index = 0; index < tape.nodes.length; index += 1) {
    const node = tape.nodes[index] as Node;
    const fixed = assumed?.get(index as Ref);
    if (fixed !== undefined) {
      values.push(fixed);
      continue;
    }
    switch (node.op) {
      case "input": {
        const value = inputs[node.name];
        if (value === undefined) throw new Error(`no input "${node.name}"`);
        values.push(value);
        break;
      }
      case "sum":
        values.push(
          algebra.sum(
            node.terms.map(([weight, ref]) => [weight, values[ref] as T]),
            node.bias,
          ),
        );
        break;
      case "mul":
        values.push(algebra.mul(values[node.a] as T, values[node.b] as T));
        break;
      case "relu":
        values.push(algebra.relu(values[node.a] as T));
        break;
      case "step":
        values.push(algebra.step(values[node.a] as T));
        break;
    }
    const hint = tape.hints.get(index as Ref);
    if (hint !== undefined && algebra.refine !== undefined) {
      values[index] = algebra.refine(values[index] as T, hint, at);
    }
  }
  return values;
}

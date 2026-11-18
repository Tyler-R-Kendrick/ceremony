/**
 * Cheapest sequence of operators from a set of held facts to the goal.
 *
 * Uniform-cost search over fact sets. Ceremonies are small (a couple of dozen
 * facts at most, and only reachable sets are visited), so the exact answer is
 * affordable and the controller never needs a heuristic it would then have to
 * be trusted on.
 */
import type { Compiled, CompiledOperator } from "./ceremony.js";

export interface Plan {
  readonly cost: number;
  /** Operator indexes, in execution order. */
  readonly steps: readonly number[];
}

const caches = new WeakMap<Compiled, Map<string, Plan | null>>();

export function applyEffect(held: number, op: CompiledOperator): number {
  return (held & ~op.consumes) | op.establishes;
}

interface Node {
  readonly state: number;
  readonly cost: number;
  readonly order: number;
  readonly parent: Node | null;
  readonly via: number;
}

function before(a: Node, b: Node): boolean {
  return a.cost < b.cost || (a.cost === b.cost && a.order < b.order);
}

function push(heap: Node[], node: Node): void {
  heap.push(node);
  let at = heap.length - 1;
  while (at > 0) {
    const up = (at - 1) >> 1;
    if (before(heap[up] as Node, heap[at] as Node)) break;
    [heap[up], heap[at]] = [heap[at] as Node, heap[up] as Node];
    at = up;
  }
}

function pop(heap: Node[]): Node {
  const top = heap[0] as Node;
  const last = heap.pop() as Node;
  if (heap.length > 0) {
    heap[0] = last;
    let at = 0;
    for (;;) {
      const left = 2 * at + 1;
      const right = left + 1;
      let least = at;
      if (
        left < heap.length &&
        before(heap[left] as Node, heap[least] as Node)
      ) {
        least = left;
      }
      if (
        right < heap.length &&
        before(heap[right] as Node, heap[least] as Node)
      ) {
        least = right;
      }
      if (least === at) break;
      [heap[least], heap[at]] = [heap[at] as Node, heap[least] as Node];
      at = least;
    }
  }
  return top;
}

/**
 * `usable` is a bitmask of operators the plan may use. Ties between equally
 * cheap plans break by declaration order, so the answer is a pure function of
 * its arguments.
 */
export function plan(
  compiled: Compiled,
  held: number,
  usable: number,
): Plan | null {
  let cache = caches.get(compiled);
  if (cache === undefined) {
    cache = new Map();
    caches.set(compiled, cache);
  }
  const key = `${held}:${usable}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  const operators = compiled.operators.filter(
    (op) => (usable & (1 << op.index)) !== 0,
  );
  const best = new Map<number, number>([[held, 0]]);
  const heap: Node[] = [];
  let order = 0;
  push(heap, { state: held, cost: 0, order, parent: null, via: -1 });
  let found: Plan | null = null;
  while (heap.length > 0) {
    const node = pop(heap);
    if (node.cost > (best.get(node.state) as number)) continue;
    if ((node.state & compiled.goal) === compiled.goal) {
      const steps: number[] = [];
      for (let at: Node | null = node; at !== null && at.via >= 0;) {
        steps.push(at.via);
        at = at.parent;
      }
      found = { cost: node.cost, steps: steps.reverse() };
      break;
    }
    for (const op of operators) {
      if ((node.state & op.requires) !== op.requires) continue;
      const next = applyEffect(node.state, op);
      if (next === node.state) continue;
      const cost = node.cost + op.cost;
      const known = best.get(next);
      if (known !== undefined && known <= cost) continue;
      best.set(next, cost);
      order += 1;
      push(heap, { state: next, cost, order, parent: node, via: op.index });
    }
  }
  cache.set(key, found);
  return found;
}

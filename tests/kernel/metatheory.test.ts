import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import {
  absorb,
  check,
  cooperate,
  decide,
  defineCeremony,
  names,
  startingWorlds,
  type Ceremony,
  type Controller,
  type Property,
} from "../../src/kernel/index.js";
import { githubAppAccess } from "../../src/kernel/flows/github-app.js";
import { cheapestCost, knowable, options, wellFormedDecl } from "./support.js";

const ceremony = (decl: Parameters<typeof defineCeremony>[0]): Ceremony =>
  defineCeremony(decl) as unknown as Ceremony;

test("every well-formed ceremony passes every property against every allowed environment", () => {
  fc.assert(
    fc.property(wellFormedDecl, (decl) => {
      const result = check(ceremony(decl), {
        invalidations: 1,
        maxStates: 400_000,
      });
      fc.pre(result.complete);
      assert.deepEqual(
        result.violations.map(
          (violation) => `${violation.property}: ${violation.message}`,
        ),
        [],
      );
      assert.ok(result.endings.length > 0);
    }),
    options,
  );
});

test("the fault-free run costs exactly the cheapest plan an independent search finds", () => {
  fc.assert(
    fc.property(wellFormedDecl, (decl) => {
      const built = ceremony(decl);
      for (const world of startingWorlds(built.compiled)) {
        const held = names(built.compiled, world);
        const run = cooperate(built, held);
        const cheapest = cheapestCost(decl, knowable(decl, held));
        if (Number.isFinite(cheapest)) {
          assert.equal(run.status, "success");
          assert.equal(run.cost, cheapest);
        } else {
          assert.equal(run.status, "failed");
          assert.equal(run.failure?.kind, "unreachable");
          assert.equal(run.cost, 0);
        }
      }
    }),
    options,
  );
});

test("a finished ceremony run again does nothing but look", () => {
  fc.assert(
    fc.property(wellFormedDecl, (decl) => {
      const built = ceremony(decl);
      for (const world of startingWorlds(built.compiled)) {
        const first = cooperate(built, names(built.compiled, world));
        if (first.status !== "success") continue;
        const again = cooperate(built, first.world);
        assert.equal(again.status, "success");
        assert.deepEqual(again.acts, []);
      }
    }),
    options,
  );
});

test("the fault-free run looks at each fact at most once and only where a probe exists", () => {
  fc.assert(
    fc.property(wellFormedDecl, (decl) => {
      const built = ceremony(decl);
      for (const world of startingWorlds(built.compiled)) {
        const run = cooperate(built, names(built.compiled, world));
        assert.equal(new Set(run.probes).size, run.probes.length);
        for (const probed of run.probes) {
          assert.equal(decl.facts[probed]?.observable, true);
        }
      }
    }),
    options,
  );
});

/**
 * Each property must be able to fail. A controller with one deliberate fault
 * is checked against the GitHub App ceremony; the checker has to name the
 * property that fault breaks.
 */
const faulty: readonly {
  readonly fault: string;
  readonly breaks: Property;
  readonly controller: Controller;
}[] = [
  {
    fault: "forgets that losing a fact loses what rests on it",
    breaks: "belief-sound",
    controller: {
      decide,
      absorb: (compiled, mind, observation) => {
        const next = absorb(compiled, mind, observation);
        return observation.kind === "act"
          ? { ...next, held: next.held | (mind.held & ~(1 << 3)) }
          : next;
      },
    },
  },
  {
    fault: "never spends an attempt",
    breaks: "terminates",
    controller: {
      decide,
      absorb: (compiled, mind, observation) => {
        const next = absorb(compiled, mind, observation);
        return {
          ...next,
          attempts: mind.attempts,
          blocked: mind.blocked,
          probeFailures: mind.probeFailures,
          staleReports: mind.staleReports,
        };
      },
    },
  },
  {
    fault: "declares success as soon as anything is held",
    breaks: "success-sound",
    controller: {
      absorb,
      decide: (compiled, mind) =>
        mind.held !== 0 && mind.terminal === null
          ? { kind: "succeed" }
          : decide(compiled, mind),
    },
  },
  {
    fault: "runs the last step of the plan first",
    breaks: "precondition",
    controller: {
      absorb,
      decide: (compiled, mind) => {
        const command = decide(compiled, mind);
        const mint = compiled.operatorIndex.get("mintToken") as number;
        return command.kind === "act" &&
          (mind.blocked & (1 << mint)) === 0 &&
          (mind.attempts[mint] as number) === 0
          ? { kind: "act", op: mint, attempt: 1 }
          : command;
      },
    },
  },
  {
    fault: "does not report what a lost reply may have left behind",
    breaks: "residue-accounted",
    controller: {
      decide,
      absorb: (compiled, mind, observation) => ({
        ...absorb(compiled, mind, observation),
        residue: 0,
      }),
    },
  },
  {
    fault: "treats a stale belief as a reason to give up on the operator",
    breaks: "recoverable",
    controller: {
      decide,
      absorb: (compiled, mind, observation) => {
        const next = absorb(compiled, mind, observation);
        if (observation.kind !== "act") return next;
        const outcome =
          compiled.operators[observation.op]?.outcomes[observation.outcome];
        return outcome?.kind === "invalidates"
          ? { ...next, blocked: next.blocked | (1 << observation.op) }
          : next;
      },
    },
  },
];

for (const { fault, breaks, controller } of faulty) {
  test(`a controller that ${fault} breaks "${breaks}"`, () => {
    const result = check(githubAppAccess as unknown as Ceremony, {
      controller,
      maxStates: 200_000,
    });
    const found = result.violations.find(
      (violation) => violation.property === breaks,
    );
    assert.ok(
      found,
      `expected "${breaks}", got ${result.violations.map((v) => v.property).join(", ") || "nothing"}`,
    );
    assert.ok(found.trace.length > 0);
  });
}

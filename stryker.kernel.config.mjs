import { readFileSync } from "node:fs";

const base = JSON.parse(
  readFileSync(new URL("./stryker.config.json", import.meta.url), "utf8"),
);

/*
 * Mutation over the kernel.
 *
 * The kernel's tests are mostly properties, and a property that passes
 * whether or not a line is there says nothing about that line. This run
 * mutates the policy, the planner, the runner and the interface prover and
 * requires that at least 80 per cent of the mutants make a kernel test fail.
 *
 * Whole files, not guarded line ranges: every line in these files decides
 * what a ceremony may do or what an interface is proved to show.
 *
 * A mutant that cannot be killed because the mutated program behaves the
 * same as the original is listed with its reason next to the test that
 * would otherwise kill it. It is not excluded here and the threshold is not
 * lowered for it.
 *
 * The kernel tests are pure: no database, network, browser or shared files.
 * That is why this run uses more than one worker where the base runs one.
 */
export default {
  ...base,
  concurrency: 4,
  mutate: [
    "src/kernel/policy.ts",
    "src/kernel/plan.ts",
    "src/kernel/run.ts",
    "src/kernel/interface/prove.ts",
    "src/kernel/interface/algebras.ts",
  ],
  tap: {
    ...base.tap,
    testFiles: ["tests/kernel/*.test.ts"],
    nodeArgs: ["--no-experimental-webstorage", ...base.tap.nodeArgs],
  },
  thresholds: { high: 90, low: 80, break: 80 },
  jsonReporter: { fileName: "artifacts/kernel-mutation/mutation.json" },
  htmlReporter: { fileName: "artifacts/kernel-mutation/index.html" },
};

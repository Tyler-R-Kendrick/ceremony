import type { Reporter, TestCase, TestModule } from "vitest/node";
import { mkdirSync, writeFileSync } from "node:fs";

export function safeWorkflowResult(input: {
  state: string;
  file: string;
  line?: number;
  stacks: string[];
}) {
  const state = ["passed", "failed", "skipped", "pending"].includes(input.state)
    ? input.state
    : "failed";
  const file =
    input.file.match(
      /(?:^|\/)(tests\/workflow\/[a-z0-9_.-]+\.test\.ts)$/i,
    )?.[1] ?? "unknown-test";
  const failure = input.stacks
    .map((stack) =>
      stack.match(
        /(?:^|\/)(tests\/workflow\/[a-z0-9_.-]+\.test\.ts):(\d+):(\d+)/i,
      ),
    )
    .find(Boolean);
  return {
    state,
    file,
    ...(Number.isInteger(input.line) && input.line! > 0
      ? { declarationLine: input.line }
      : {}),
    ...(failure
      ? {
          failureLocation: {
            file: failure[1]!,
            line: Number(failure[2]),
            column: Number(failure[3]),
          },
        }
      : {}),
  };
}

/** Location-only CI evidence: no test names, messages, diffs, prompts, or histories. */
export default class WorkflowSafeReporter implements Reporter {
  private cases: ReturnType<typeof safeWorkflowResult>[] = [];
  onTestCaseResult(test: TestCase) {
    const result = test.result();
    const safe = safeWorkflowResult({
      state: result.state,
      file: test.module.moduleId,
      ...(test.location ? { line: test.location.line } : {}),
      stacks: result.errors?.map((error) => error.stack ?? "") ?? [],
    });
    this.cases.push(safe);
    console.log(JSON.stringify({ type: "workflow-test", ...safe }));
  }
  onTestRunEnd(_modules: readonly TestModule[], unhandled: readonly unknown[]) {
    const counts = {
      passed: this.cases.filter((item) => item.state === "passed").length,
      failed: this.cases.filter((item) => item.state === "failed").length,
      skipped: this.cases.filter((item) => item.state === "skipped").length,
    };
    mkdirSync("artifacts/workflow", { recursive: true });
    writeFileSync(
      "artifacts/workflow/results.json",
      JSON.stringify(
        {
          schemaVersion: 1,
          cases: this.cases,
          counts,
          unhandledErrors: unhandled.length,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    console.log(
      ` Tests ${counts.passed} passed | ${counts.failed} failed | ${counts.skipped} skipped (${this.cases.length})`,
    );
  }
}

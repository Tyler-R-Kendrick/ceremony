import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { safeBrowserResult } from "../scripts/safe-browser-reporter.js";

test("AC-24: browser diagnostics allow only static locations and bounded execution metadata", () => {
  const fixture = {
    file: resolve("tests/browser/teaching-flow.spec.ts"),
    line: 12,
    project: "chromium",
    status: "failed",
    retry: 0,
    duration: 123,
    title: "private-canary",
    error: { message: "private-canary" },
    attachments: [{ body: "private-canary" }],
    stdout: ["private-canary"],
  };
  assert.deepEqual(safeBrowserResult(fixture), {
    file: "tests/browser/teaching-flow.spec.ts",
    line: 12,
    project: "chromium",
    status: "failed",
    retry: 0,
    duration: 123,
  });
  for (const change of [
    { file: resolve("private-canary.spec.ts") },
    { file: 42 },
    { project: "private-canary" },
    { status: "private-canary" },
    { line: "private-canary" },
    { retry: -1 },
    { duration: Infinity },
  ])
    assert.equal(safeBrowserResult({ ...fixture, ...change }), undefined);
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { assertAuthoringTermination } from "./fixtures/authoring-termination.js";

// Isolate this boundary so later synchronous tests cannot mask its failed TAP record.
test("authoring allocation and fuzzy correction terminate before their caller deadline", () => {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const fixture = new URL(
    "./fixtures/authoring-termination.ts",
    import.meta.url,
  );
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { assertAuthoringTermination } from ${JSON.stringify(fixture.href)}; assertAuthoringTermination(); process.stdout.write("complete");`,
    ],
    {
      env: environment,
      timeout: 3000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  assert.equal(
    Boolean(result.error),
    false,
    "authoring must finish before its caller deadline",
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "complete");
  // The same in-process calls retain source coverage; the child bounds sync failures first.
  assertAuthoringTermination();
});

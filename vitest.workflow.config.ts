import { defineConfig } from "vitest/config";
import { workflow } from "@workflow/vitest";
export default defineConfig({
  plugins: [workflow()],
  test: {
    include: ["tests/workflow/*.test.ts"],
    testTimeout: 60_000,
    includeTaskLocation: true,
    reporters: ["./tests/fixtures/workflow-safe-reporter.ts"],
  },
});

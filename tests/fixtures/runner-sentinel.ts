import { test } from "node:test";
import assert from "node:assert/strict";

// Deliberately failing preflight, invoked separately, never discovered as a product test.
test("Node must actually execute assertions", () => {
  assert.fail("CEREMONY_EXPECTED_ASSERTION_FAILURE");
});

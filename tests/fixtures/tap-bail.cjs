const { test } = require("node:test");
const assert = require("node:assert/strict");
process.on("SIGTERM", () => process.exit(1));
test("synthetic assertion", () => assert.equal(1, 2));
test("completed next assertion", () => assert.equal(1, 1));
test("later blocked operation", async () => {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
});

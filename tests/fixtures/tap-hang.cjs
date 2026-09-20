const { test } = require("node:test");
process.on("SIGTERM", () => process.exit(1));
test("an operation that never settles", async () => {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
});

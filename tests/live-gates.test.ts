import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("LIVE gates refuse absent explicit authorization before browser or provider access", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/verify-attended.ts"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CEREMONY_LIVE_AUTHORIZED: "false",
        CEREMONY_LIVE_ATTENDED: "false",
      },
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Attended verification blocked or failed/);
});

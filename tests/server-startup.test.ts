import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

test("occupied provider or app ports reject and release startup resources", () => {
  // A leaked Vite handle makes this child time out instead of turning a rejected
  // startup into a permanently hanging verification process.
  try {
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--import",
        "tsx",
        "-e",
        `
    import assert from 'node:assert/strict';
    import {createServer} from 'node:http';
    import {startReferenceApp} from './examples/server.ts';
    console.log('STARTUP_PROBE_IMPORTED');
    const app=createServer(), provider=createServer();
    for(const server of [app,provider]) await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const port=app.address().port, providerPort=provider.address().port;
    try {
      await assert.rejects(startReferenceApp({port,providerPort}), {code:'EADDRINUSE'});
      await new Promise(resolve=>provider.close(resolve));
      await assert.rejects(startReferenceApp({port,providerPort}), {code:'EADDRINUSE'});
    } finally {await new Promise(resolve=>app.close(resolve));}
    console.log('STARTUP_PROBE_CHECKED');
  `,
      ],
      {
        timeout: 15000,
        stdio: "pipe",
        env: { ...process.env, NODE_OPTIONS: "--no-experimental-webstorage" },
      },
    );
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ETIMEDOUT"
    ) {
      const output =
        "stdout" in error && Buffer.isBuffer(error.stdout)
          ? error.stdout.toString()
          : "";
      assert.fail(
        `Startup probe timed out: imported=${output.includes("STARTUP_PROBE_IMPORTED")}; checked=${output.includes("STARTUP_PROBE_CHECKED")}`,
      );
    }
    throw error;
  }
});

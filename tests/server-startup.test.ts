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
    console.log('STARTUP_PROBE_IMPORTED:'+Math.round(performance.now()));
    const resources=()=>console.log('STARTUP_PROBE_RESOURCES:'+JSON.stringify({elapsed:Math.round(performance.now()),types:process.getActiveResourcesInfo()}));
    const diagnostic=setInterval(resources,1000);
    diagnostic.unref();
    const app=createServer(), provider=createServer();
    for(const server of [app,provider]) await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const port=app.address().port, providerPort=provider.address().port;
    try {
      await assert.rejects(startReferenceApp({port,providerPort}), {code:'EADDRINUSE'});
      await new Promise(resolve=>provider.close(resolve));
      await assert.rejects(startReferenceApp({port,providerPort}), {code:'EADDRINUSE'});
    } finally {await new Promise(resolve=>app.close(resolve));}
    console.log('STARTUP_PROBE_CHECKED:'+Math.round(performance.now()));
    resources();
    process.once('beforeExit',()=>console.log('STARTUP_PROBE_DRAINED:'+Math.round(performance.now())));
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
        `Startup probe timed out: imported=${output.includes("STARTUP_PROBE_IMPORTED")}; checked=${output.includes("STARTUP_PROBE_CHECKED")}; phases=${output
          .split("\n")
          .filter((line) =>
            /^STARTUP_PROBE_(IMPORTED|CHECKED|DRAINED):\d+$/.test(line),
          )
          .join(",")}; resources=${
          output
            .split("\n")
            .filter((line) => line.startsWith("STARTUP_PROBE_RESOURCES:"))
            .at(-1) ?? "unknown"
        }`,
      );
    }
    throw error;
  }
});

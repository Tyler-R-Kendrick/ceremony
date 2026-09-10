import { execFileSync } from "node:child_process";
import { test } from "node:test";

test("occupied provider or app ports reject and release startup resources", () => {
  // A leaked Vite handle makes this child time out instead of turning a rejected
  // startup into a permanently hanging verification process.
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
    const app=createServer(), provider=createServer();
    for(const server of [app,provider]) await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const port=app.address().port, providerPort=provider.address().port;
    try {
      await assert.rejects(startReferenceApp({port,providerPort}), {code:'EADDRINUSE'});
      await new Promise(resolve=>provider.close(resolve));
      await assert.rejects(startReferenceApp({port,providerPort}), {code:'EADDRINUSE'});
    } finally {await new Promise(resolve=>app.close(resolve));}
  `,
    ],
    {
      timeout: 15000,
      stdio: "pipe",
      env: { ...process.env, NODE_OPTIONS: "--no-experimental-webstorage" },
    },
  );
});

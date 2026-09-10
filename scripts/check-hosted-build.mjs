import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";

// Exercise emitted deployment code, not the source factory or a simulated route.
const root = ".vercel/output";
const config = JSON.parse(await readFile(`${root}/config.json`, "utf8"));
assert.equal(config.version, 3);
assert.equal(config.framework.name, "nitro");
for (const path of [
  "static/index.html",
  "static/sw.js",
  "functions/api/[...path].func/index.mjs",
  "functions/.well-known/workflow/v1/flow.func/.vc-config.json",
  "functions/.well-known/workflow/v1/step.func/.vc-config.json",
  "functions/.well-known/workflow/v1/webhook/[token].func/.vc-config.json",
])
  await access(`${root}/${path}`);
for (const destination of [
  "/api/[...path]",
  "/.well-known/workflow/v1/flow",
  "/.well-known/workflow/v1/step",
])
  assert.ok(config.routes.some((route) => route.dest === destination));

// A clean child environment prevents this build check from touching configured
// accounts, databases or model services. Missing auth must fail closed at HTTP.
execFileSync(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `
  import assert from 'node:assert/strict';
  import {createServer} from 'node:http';
  import handler from './.vercel/output/functions/__server.func/index.mjs';
  const server=createServer(handler);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/config');
    assert.equal(response.status,503);
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.deepEqual(await response.json(),{error:'hosted-unavailable'});
  } finally { await new Promise(resolve=>server.close(resolve)); }
`,
  ],
  { env: { NODE_ENV: "production" }, stdio: "pipe", timeout: 30000 },
);
console.log(
  "Vercel output verified: static app, authenticated API carrier, Workflow routes; missing configuration fails closed over HTTP.",
);

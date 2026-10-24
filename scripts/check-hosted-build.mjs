import assert from "node:assert/strict";
import { readFile, access, cp, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise emitted deployment code, not the source factory or a simulated route.
const root = ".vercel/output";
const config = JSON.parse(await readFile(`${root}/config.json`, "utf8"));
assert.equal(config.version, 3);
assert.equal(config.framework.name, "nitro");
const workflowFunctions = `${root}/functions/.well-known/workflow/v1`;
for (const path of [
  "static/index.html",
  "static/sw.js",
  "functions/api/[...path].func/index.mjs",
  "functions/.well-known/workflow/v1/flow.func/.vc-config.json",
  "functions/.well-known/workflow/v1/webhook/[token].func/.vc-config.json",
])
  await access(`${root}/${path}`);
for (const destination of ["/api/[...path]", "/.well-known/workflow/v1/flow"])
  assert.ok(config.routes.some((route) => route.dest === destination));
// Workflow 5 runs steps inside the flow function, so that function is the queue
// consumer, and no standalone step function may ship beside it.
const flowConfig = JSON.parse(
  await readFile(`${workflowFunctions}/flow.func/.vc-config.json`, "utf8"),
);
assert.ok(
  flowConfig.experimentalTriggers?.some(
    (trigger) => trigger.topic === "__wkf_workflow_*",
  ),
  "The flow function must consume the workflow queue",
);
await assert.rejects(access(`${workflowFunctions}/step.func`), {
  code: "ENOENT",
});
// Nitro bundles the workflows into its own functions and keeps the build
// manifest in its build directory; the flow function must carry what it lists.
const manifest = JSON.parse(
  await readFile("node_modules/.nitro/workflow/manifest.json", "utf8"),
);
assert.ok(
  manifest.workflows["src/server/agent/workflow.ts"]?.ceremonyAgentWorkflow,
);
assert.ok(manifest.steps["src/server/agent/workflow.ts"]?.runAgentTurn);
for (const file of Object.keys({ ...manifest.workflows, ...manifest.steps }))
  assert.match(
    file,
    /^(src|node_modules)\//,
    "Only source and SDK workflows may ship",
  );
const flowEntry = await readFile(
  `${workflowFunctions}/flow.func/index.mjs`,
  "utf8",
);
for (const id of [
  manifest.workflows["src/server/agent/workflow.ts"].ceremonyAgentWorkflow
    .workflowId,
  manifest.steps["src/server/agent/workflow.ts"].runAgentTurn.stepId,
])
  assert.ok(flowEntry.includes(id), "The flow function must carry the agent");

// A clean child environment prevents this build check from touching configured
// accounts, databases or model services. Missing auth must fail closed at HTTP.
// Copy outside the checkout so ancestor node_modules cannot hide missing files.
const isolated = await mkdtemp(join(tmpdir(), "ceremony-hosted-check-"));
try {
  await cp(`${root}/functions`, join(isolated, "functions"), {
    recursive: true,
    dereference: true,
  });
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
  import assert from 'node:assert/strict';
  import {createServer} from 'node:http';
  import {createRequire} from 'node:module';
  import {resolve, dirname, sep} from 'node:path';
  import {readFileSync} from 'node:fs';
  import handler from './functions/__server.func/index.mjs';
  const flow = resolve('functions/.well-known/workflow/v1/flow.func/index.mjs');
  assert.equal(typeof (await import(flow)).default, 'function');
  for (const entry of [flow, resolve('functions/__server.func/index.mjs')]) {
    const require = createRequire(entry);
    const pkg = require.resolve('playwright-core/package.json');
    assert.ok(pkg.startsWith(dirname(entry) + sep), 'Playwright must ship inside each function');
    assert.equal(require('playwright-core').chromium.name(), 'chromium');
    assert.ok(JSON.parse(readFileSync(resolve(dirname(pkg), 'browsers.json'), 'utf8')).browsers.length);
  }
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
    {
      cwd: isolated,
      env: { NODE_ENV: "production" },
      stdio: "pipe",
      timeout: 30000,
    },
  );
} finally {
  await rm(isolated, { recursive: true, force: true });
}
console.log(
  "Vercel output verified outside the checkout: static app, API and Workflow handlers, packaged Playwright; missing configuration fails closed over HTTP.",
);

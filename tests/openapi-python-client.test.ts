import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  agent,
  createHarness,
  delegate,
  FIXTURE_DOCUMENT,
  handlerFetch,
  human,
  ORIGIN,
} from "./connectors/commands/harness.js";

/*
 * The same claim as tests/openapi-client.test.ts, in a second language.
 *
 * openapi-python-client -- pure Python, no Java runtime -- generates a client
 * package from the committed description into a gitignored directory, and
 * tests/consumers/openapi-python/smoke.py drives the real connector handler
 * through it over loopback HTTP: import, review, binding approval, connect,
 * the provider's authorization, listing, both projections of a connection,
 * the documented 404, and the 403 for a request from another origin.
 *
 * Generation must also be clean. The generator reports a schema it cannot
 * turn into a model as a warning and then leaves the model out, and the
 * package still imports until a route that needed it is called. So a warning
 * fails this test rather than a later, less legible import error.
 *
 * Python is not a dependency of this repository. Where the pinned generator
 * is not installed the test skips with the command that installs it; the
 * `python-client` CI job installs it and sets CEREMONY_REQUIRE_PYTHON_CLIENT,
 * which turns that skip into a failure so the job cannot pass vacuously.
 */

const root = resolve(import.meta.dirname, "..");
const consumer = join(root, "tests/consumers/openapi-python");
const generated = join(consumer, "generated", "ceremony_connectors");
const python = process.env.CEREMONY_PYTHON ?? "python3";
const pinned = /^openapi-python-client==(\S+)$/m.exec(
  readFileSync(join(consumer, "requirements.txt"), "utf8"),
)?.[1];

function installedVersion(): string | undefined {
  const probe = spawnSync(
    python,
    [
      "-c",
      "import importlib.metadata as m; print(m.version('openapi-python-client'))",
    ],
    { encoding: "utf8" },
  );
  return probe.status === 0 ? probe.stdout.trim() : undefined;
}

const installed = installedVersion();
const options =
  installed || process.env.CEREMONY_REQUIRE_PYTHON_CLIENT === "1"
    ? {}
    : {
        skip: `openapi-python-client is not installed for ${python} (pip install -r tests/consumers/openapi-python/requirements.txt)`,
      };

/** Loopback proxies must not see the test's own traffic, whatever the environment says. */
function withoutLoopbackProxy(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const bypass = [env.NO_PROXY ?? env.no_proxy, "127.0.0.1", "localhost"]
    .filter(Boolean)
    .join(",");
  return { ...env, NO_PROXY: bypass, no_proxy: bypass };
}

function execute(
  command: string,
  args: string[],
  options: { cwd: string; timeout: number; env: NodeJS.ProcessEnv },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") fail(error);
      else done({ code: error ? Number(error.code) : 0, stdout, stderr });
    });
  });
}

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

const PERSON = "python-client-human";
const ASSISTANT = "python-client-agent";

test(
  "OPC-01: openapi-python-client generates a client that drives the real handler",
  options,
  async (t) => {
    assert.equal(
      installed,
      pinned,
      "the generator is the version requirements.txt pins",
    );

    rmSync(join(consumer, "generated"), { recursive: true, force: true });
    const generation = spawnSync(
      python,
      [
        "-m",
        "openapi_python_client",
        "generate",
        "--path",
        join(root, "docs/openapi/connectors.openapi.json"),
        "--output-path",
        generated,
        "--meta",
        "none",
      ],
      { cwd: root, encoding: "utf8", env: withoutLoopbackProxy(process.env) },
    );
    const report = `${generation.stdout}${generation.stderr}`;
    assert.equal(generation.status, 0, report);
    assert.doesNotMatch(report, /warning|unable to process/i, report);

    const harness = await createHarness();
    t.after(() => harness.close());
    harness.register(PERSON, human());
    const assistant = harness.register(ASSISTANT, agent());
    await delegate(harness.store, assistant);

    // The handler behind a real listener, addressed as the deployment's origin
    // exactly as `harness.fetch` addresses it. Hop-by-hop headers stay here.
    const forward = handlerFetch(harness);
    const server = createServer(async (incoming, outgoing) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers))
        if (value !== undefined && !["host", "connection"].includes(name))
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      const method = incoming.method ?? "GET";
      const payload = await body(incoming);
      const response = await forward(
        new Request(`${ORIGIN}${incoming.url ?? "/"}`, {
          method,
          headers,
          ...(payload.byteLength && method !== "GET" && method !== "HEAD"
            ? { body: new Uint8Array(payload) }
            : {}),
        }),
      );
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    t.after(() => new Promise<void>((done) => server.close(() => done())));
    const { port } = server.address() as AddressInfo;

    // Asynchronous on purpose: the listener lives in this process, so a
    // synchronous spawn would block the event loop that has to answer it.
    const run = await execute(python, [join(consumer, "smoke.py")], {
      cwd: consumer,
      timeout: 120_000,
      env: withoutLoopbackProxy({
        ...process.env,
        CEREMONY_CLIENT_CONFIG: JSON.stringify({
          baseUrl: `http://127.0.0.1:${port}`,
          origin: ORIGIN,
          cookie: "fixture-session",
          person: PERSON,
          assistant: ASSISTANT,
          document: FIXTURE_DOCUMENT(harness.provider.origin),
          providerOrigin: harness.provider.origin,
        }),
      }),
    });
    assert.equal(run.code, 0, `${run.stdout}${run.stderr}`);
    const observed = JSON.parse(run.stdout) as Record<string, unknown>;

    assert.equal(observed.catalogIsList, true);
    assert.match(String(observed.definitionRef), /^definition:/);
    assert.equal(observed.reviewedRef, observed.definitionRef);
    assert.equal(observed.bindingStatus, "approved");
    assert.equal(observed.bindingListed, true);
    assert.equal(observed.connectLifecycle, "authorization-required");
    assert.equal((observed.listed as string[]).length, 1);
    assert.equal(observed.callbackStatus, 303);
    assert.equal(observed.afterCallback, "active");
    assert.equal(observed.assistantView, "AgentConnectionView");
    assert.equal(observed.assistantVerified, true);
    assert.deepEqual(observed.missing, [404, "not-found"]);
    assert.deepEqual(observed.crossSite, [403, "denied"]);
  },
);

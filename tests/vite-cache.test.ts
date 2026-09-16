import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  realpath,
  access,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { createServer, type ViteDevServer } from "vite";
import projectConfig from "../vite.config.js";
import { awaitStarted } from "./fixtures/await-started.js";

test("Vite roots sharing installed dependencies cannot invalidate each other's browser startup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ceremony-vite-cache-"));
  const sharedModules = join(directory, "shared", "node_modules");
  const servers: ViteDevServer[] = [];
  const paused = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let secondStart: Promise<ViteDevServer> | undefined;
  try {
    await mkdir(sharedModules, { recursive: true });
    await symlink(
      dirname(createRequire(import.meta.url).resolve("react/package.json")),
      join(sharedModules, "react"),
      "dir",
    );
    for (const name of ["first", "second"]) {
      const root = join(directory, name);
      await mkdir(root);
      await writeFile(join(root, "package.json"), '{"type":"module"}');
      await writeFile(
        join(root, "index.html"),
        '<script type="module" src="/main.js"></script>',
      );
      await writeFile(
        join(root, "main.js"),
        "import React from 'react'; globalThis.proofReady = !!React.createElement;",
      );
      await symlink(sharedModules, join(root, "node_modules"), "dir");
    }
    assert.equal(
      await realpath(join(directory, "first", "node_modules")),
      await realpath(join(directory, "second", "node_modules")),
    );
    const start = async (name: string, hold: boolean) => {
      const server = await createServer({
        ...projectConfig,
        configFile: false,
        root: join(directory, name),
        logLevel: "silent",
        server: { host: "127.0.0.1", port: 0, hmr: false },
        optimizeDeps: {
          noDiscovery: true,
          include: ["react"],
          esbuildOptions: {
            plugins: [
              {
                name: "cache-ownership-barrier",
                setup(build) {
                  if (hold)
                    build.onStart(async () => {
                      paused.resolve();
                      await release.promise;
                    });
                },
              },
            ],
          },
        },
      });
      servers.push(server);
      await server.listen();
      return server;
    };
    const first = await start("first", false);
    const optimizer = first.environments.client.depsOptimizer;
    assert.ok(optimizer);
    await optimizer.scanProcessing;
    await optimizer.metadata.optimized.react?.processing;
    await optimizer.metadata.discovered.react?.processing;
    await access(join(first.config.cacheDir, "deps", "react.js"));
    // Pause the second real optimizer after it invalidates its own old cache,
    // before it commits replacements. The first host has not served any page yet.
    secondStart = start("second", true);
    await awaitStarted(paused.promise, secondStart);
    const origin = first.resolvedUrls?.local[0];
    assert.ok(origin);
    const main = await fetch(new URL("main.js", origin));
    assert.equal(main.status, 200);
    const dependency = (await main.text()).match(
      /from\s+["']([^"']+\/deps\/react\.js[^"']*)/,
    )?.[1];
    assert.ok(dependency);
    const response = await fetch(new URL(dependency, origin));
    await response.arrayBuffer();
    assert.equal(
      response.status,
      200,
      "a second root must not remove a running host's browser dependency",
    );
    assert.notEqual(
      await realpath(first.config.cacheDir),
      await realpath(servers[1]!.config.cacheDir),
    );
  } finally {
    release.resolve();
    await secondStart?.catch(() => undefined);
    await Promise.all(servers.map((server) => server.close()));
    await rm(directory, { recursive: true, force: true });
  }
});

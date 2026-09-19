import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join, resolve } from "node:path";

/*
 * AC-PKG-01/02: what a consumer of the published package actually gets.
 *
 * The export map is a claim, and a packaging claim is the easiest kind to get
 * wrong without noticing: a subpath can name a file the build does not emit,
 * and `files` can omit an asset the map points at, while nothing in this
 * repository's own test run fails, because every import inside the repository
 * resolves through source. So this test does not read the export map. It packs
 * the package as `npm publish` would, unpacks it somewhere with no access to
 * this working tree, and imports through the subpaths from there.
 *
 * Deliberately: no network, no registry, no publish. `npm pack` writes a
 * tarball and does nothing else.
 *
 * The consumer is not built with `npm install`. Installing the tarball pulls
 * the package's runtime dependencies from a registry, and one of their
 * postinstall scripts downloads a native binary, which this environment
 * cannot reach and which has nothing to do with the claim under test. Instead
 * the tarball is unpacked into a scratch `node_modules` under `artifacts/`,
 * and the probe runs from there.
 *
 * What that does and does not prove, stated rather than implied. It does prove
 * the two things packaging gets wrong: the export map resolves, and it
 * resolves to files the tarball actually contains, because the extracted
 * directory holds nothing but what `npm pack` put in it. Dependencies resolve
 * from the repository's own `node_modules`, which Node finds by walking up
 * from the scratch directory, so this does not prove the dependency set a
 * fresh install would produce. Nothing resolves back into repository source:
 * the subpath goes through the packed `package.json`, whose targets are inside
 * the extracted copy.
 */

const root = resolve(import.meta.dirname, "../../..");
const built = join(root, "dist/server/connectors/index.js");

// The build is a separate, slow stage. Without it there is nothing to pack,
// and a skip that says why is more honest than a failure that would read as a
// packaging defect.
const options = existsSync(built) ? {} : { skip: "run npm run build first" };

test(
  "INT-PKG-01: a consumer resolves every connector subpath from the packed tarball",
  options,
  () => {
    // Inside the repository, so Node's upward search finds the repository's
    // node_modules for the package's own dependencies.
    const directory = mkdtempSync(join(root, "artifacts", "packed-consumer-"));
    try {
      const packed = execFileSync(
        "npm",
        ["pack", "--pack-destination", directory, "--silent"],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      )
        .trim()
        .split("\n")
        .at(-1)!;
      const tarball = join(directory, packed);

      const consumer = join(directory, "consumer");
      const installed = join(consumer, "node_modules/@ceremony/auth");
      mkdirSync(installed, { recursive: true });
      writeFileSync(
        join(consumer, "package.json"),
        JSON.stringify({ name: "consumer", private: true, type: "module" }),
      );
      // `npm pack` puts everything under a single `package/` directory.
      execFileSync(
        "tar",
        ["-xzf", tarball, "-C", installed, "--strip-components=1"],
        { encoding: "utf8" },
      );

      // Every subpath the package advertises for connector work, imported the
      // way a consumer would rather than by file path.
      const probe = join(consumer, "probe.mjs");
      writeFileSync(
        probe,
        [
          'import { createConnectorRuntime, createConnectorRegistry, ConnectorError } from "@ceremony/auth/server/connectors";',
          'import { normalizedDefinitionSchema } from "@ceremony/auth";',
          "const registry = createConnectorRegistry();",
          "console.log(",
          "  JSON.stringify({",
          "    runtime: typeof createConnectorRuntime,",
          "    error: typeof ConnectorError,",
          "    adapters: registry.list().length,",
          "    schema: typeof normalizedDefinitionSchema.parse,",
          "  }),",
          ");",
        ].join("\n"),
      );
      const output = execFileSync(process.execPath, [probe], {
        cwd: consumer,
        encoding: "utf8",
      });
      const report = JSON.parse(output.trim()) as Record<string, unknown>;
      assert.equal(report.runtime, "function");
      assert.equal(report.error, "function");
      assert.equal(report.schema, "function");
      // The inventory is the point of the subpath: a consumer that imports it
      // and gets an empty registry has a working import and a package that
      // does nothing.
      assert.ok(
        typeof report.adapters === "number" && report.adapters > 20,
        `packed registry built ${String(report.adapters)} adapters`,
      );

      // The stylesheet the directory needs is published, not merely mapped.
      assert.ok(
        existsSync(
          join(
            consumer,
            "node_modules/@ceremony/auth/src/react/connectors.css",
          ),
        ),
        "connectors.css is missing from the tarball",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

/*
 * The whole published package, as a consumer outside this repository gets it.
 *
 * tests/connectors/packaging/consumer.test.ts proves the connector subpaths
 * resolve from the tarball, with dependencies found by walking up into this
 * repository's node_modules. This test is stricter about both halves:
 *
 * - **What ships.** The tarball holds built output, the stylesheets the export
 *   map names, and documentation meant for readers -- never tests, fixtures,
 *   evidence ledgers, demo recordings or build output with no source behind
 *   it (a stale `dist/` file from a module since deleted).
 * - **What it needs.** The consumer lives in the system temp directory, where
 *   no upward search reaches this repository. Its node_modules holds the
 *   unpacked tarball and a link to each package the manifest *declares*
 *   (dependencies and peer dependencies) and nothing else. So an entry point
 *   that imports a package it forgot to declare -- one that only resolves
 *   here because it happens to be a devDependency -- fails to import.
 *
 * Every entry point in the export map is then imported as ESM by its public
 * specifier, and type-checked by its public specifier with `tsc`, from that
 * consumer.
 *
 * The consumer is linked rather than `npm install`ed on purpose: installing
 * the tarball fetches its dependencies from a registry, and one of them runs
 * a postinstall that downloads a native binary. Neither is reachable here and
 * neither is the claim under test. Linking to the already-installed copies
 * gives the same resolution graph for the declared set without the network.
 * No `npm publish`, and no registry, anywhere.
 */

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
) as {
  name: string;
  exports: Record<string, string | { types?: string; import?: string }>;
  files: string[];
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
};
const options = existsSync(join(root, "dist/core/index.js"))
  ? {}
  : { skip: "run npm run build first" };

/** Paths a published tarball must never contain. */
const forbidden = [
  /(^|\/)(tests?|__tests__|fixtures?|doubles|scratch|\.probe|artifacts|coverage)\//,
  /\.(test|spec|flow)\.[cm]?[jt]sx?$/,
  /\.(mp4|webm|mov|gif)$/,
  /^docs\/(implementation-evidence|demos)\//,
  /\.tsbuildinfo$/,
  /(^|\/)\.env/,
];

function pack(destination: string): { filename: string; files: string[] } {
  const output = execFileSync(
    "npm",
    ["pack", "--json", "--pack-destination", destination],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const [report] = JSON.parse(output) as Array<{
    filename: string;
    files: Array<{ path: string }>;
  }>;
  return {
    filename: join(destination, report!.filename),
    files: report!.files.map((file) => file.path),
  };
}

test(
  "PKG-01: the tarball ships built output and reader docs, and nothing else",
  options,
  () => {
    const directory = mkdtempSync(join(tmpdir(), "ceremony-pack-"));
    try {
      const { files } = pack(directory);
      const shipped = new Set(files);

      const offending = files.filter((path) =>
        forbidden.some((pattern) => pattern.test(path)),
      );
      assert.deepEqual(
        offending,
        [],
        "tests, fixtures and recordings stay out",
      );

      const outside = files.filter(
        (path) =>
          !path.startsWith("dist/") &&
          !path.startsWith("docs/") &&
          !/^src\/react\/[a-z-]+\.css$/.test(path) &&
          !["package.json", "README.md", "LICENSE"].includes(path),
      );
      assert.deepEqual(
        outside,
        [],
        "only dist, docs and the mapped stylesheets",
      );

      // A dist file with no source is left over from a module since removed,
      // and would ship code nobody maintains.
      const orphaned = files
        .filter((path) => path.startsWith("dist/") && path.endsWith(".js"))
        .filter((path) => {
          const base = path.slice("dist/".length, -".js".length);
          return !["ts", "tsx"].some((ext) =>
            existsSync(join(root, "src", `${base}.${ext}`)),
          );
        });
      assert.deepEqual(orphaned, [], "every built module has a source module");

      for (const [subpath, target] of Object.entries(manifest.exports)) {
        const targets =
          typeof target === "string"
            ? [target]
            : [target.import!, target.types!];
        for (const file of targets)
          assert.ok(
            shipped.has(file.replace(/^\.\//, "")),
            `${subpath} points at ${file}, which the tarball does not contain`,
          );
      }
      assert.ok(shipped.has("LICENSE"), "the license text ships");
      assert.ok(
        shipped.has("docs/openapi/connectors.openapi.json"),
        "the OpenAPI description ships",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "PKG-02: every public entry point imports and type-checks from an isolated consumer",
  options,
  () => {
    const directory = mkdtempSync(join(tmpdir(), "ceremony-consumer-"));
    try {
      const { filename } = pack(directory);
      const consumer = join(directory, "consumer");
      const modules = join(consumer, "node_modules");
      const installed = join(modules, manifest.name);
      mkdirSync(installed, { recursive: true });
      execFileSync("tar", [
        "-xzf",
        filename,
        "-C",
        installed,
        "--strip-components=1",
      ]);

      // The declared closure, and only it. A dependency must be present; an
      // optional peer is linked when this repository has it installed.
      const declared = {
        ...manifest.dependencies,
        ...manifest.peerDependencies,
      };
      for (const name of Object.keys(declared)) {
        const source = join(root, "node_modules", name);
        if (!existsSync(source)) {
          assert.ok(
            name in manifest.peerDependencies,
            `dependency ${name} is declared but not installed`,
          );
          continue;
        }
        mkdirSync(dirname(join(modules, name)), { recursive: true });
        symlinkSync(source, join(modules, name), "dir");
      }
      writeFileSync(
        join(consumer, "package.json"),
        JSON.stringify({ name: "consumer", private: true, type: "module" }),
      );

      const entries = Object.entries(manifest.exports).map(
        ([subpath, target]) => ({
          specifier: `${manifest.name}${subpath.slice(1)}`,
          kind:
            typeof target !== "string"
              ? "module"
              : target.endsWith(".json")
                ? "json"
                : "asset",
        }),
      );
      const probe = join(consumer, "probe.mjs");
      writeFileSync(
        probe,
        `import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
const entries = ${JSON.stringify(entries)};
const report = {};
for (const { specifier, kind } of entries) {
  if (kind === "module") {
    report[specifier] = Object.keys(await import(specifier)).length;
  } else if (kind === "json") {
    const { default: value } = await import(specifier, { with: { type: "json" } });
    report[specifier] = Object.keys(value).length;
  } else {
    report[specifier] = existsSync(fileURLToPath(import.meta.resolve(specifier))) ? 1 : 0;
  }
}
console.log(JSON.stringify(report));
`,
      );
      const env = { ...process.env, NODE_OPTIONS: "" };
      const report = JSON.parse(
        execFileSync(process.execPath, [probe], {
          cwd: consumer,
          encoding: "utf8",
          env,
        }).trim(),
      ) as Record<string, number>;
      for (const { specifier } of entries)
        assert.ok(
          (report[specifier] ?? 0) > 0,
          `${specifier} resolved to nothing a consumer can use`,
        );

      // Types, through the same public specifiers and the `types` conditions.
      const modulesOnly = entries.filter((entry) => entry.kind === "module");
      writeFileSync(
        join(consumer, "check.ts"),
        modulesOnly
          .map(
            ({ specifier }, index) =>
              `import * as entry${index} from ${JSON.stringify(specifier)};\nexport const size${index}: number = Object.keys(entry${index}).length;`,
          )
          .join("\n") + "\n",
      );
      writeFileSync(
        join(consumer, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2024",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            lib: ["ES2024", "DOM"],
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            types: [],
          },
          files: ["check.ts"],
        }),
      );
      execFileSync(
        process.execPath,
        [join(root, "node_modules/typescript/bin/tsc"), "-p", consumer],
        { cwd: consumer, encoding: "utf8", env },
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

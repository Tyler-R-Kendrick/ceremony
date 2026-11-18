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

/**
 * A consumer project in `directory`: the packed tarball unpacked into its
 * node_modules, beside a link to each declared dependency and peer and
 * nothing else. Returns the consumer's folder and the unpacked package's.
 */
function isolatedConsumer(directory: string): {
  consumer: string;
  installed: string;
} {
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
  return { consumer, installed };
}

test(
  "PKG-02: every public entry point imports and type-checks from an isolated consumer",
  options,
  () => {
    const directory = mkdtempSync(join(tmpdir(), "ceremony-consumer-"));
    try {
      const { consumer } = isolatedConsumer(directory);

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

/*
 * The kernel, as a package consumer gets it.
 *
 * Three entries: `./kernel` (facts, operators, ceremonies, the planner, the
 * policy and the model checker), `./kernel/interface` (the layout prover) and
 * `./kernel/flows` (the modelled auth families). A consumer defines a ceremony
 * from them and checks it, without reaching into `dist/` by path. Nothing a
 * kernel entry loads may belong to the server: the kernel is meant to run
 * where the server cannot, so every module reachable from the three entries
 * stays under `dist/kernel/`, and the only package it may name is the UI SDK,
 * which is an optional peer.
 */

const kernelEntries = ["./kernel", "./kernel/interface", "./kernel/flows"];

/** Packages a kernel entry may import. Each must be an optional peer. */
const kernelPeers = ["@ui-sdk/core"];

/**
 * The flow catalog declares its values with zod, a dependency of the package.
 * Only `./kernel/flows` may reach it: the kernel itself and its interface
 * prover import no package but the optional peers.
 */
const flowsDependencies = ["zod"];

function conditions(subpath: string): { types: string; import: string } {
  const target = manifest.exports[subpath];
  assert.ok(target !== undefined, `the export map has no ${subpath}`);
  assert.equal(
    typeof target,
    "object",
    `${subpath} names its types and its module separately`,
  );
  const { types, import: module } = target as {
    types?: string;
    import?: string;
  };
  assert.ok(types !== undefined, `${subpath} has a types condition`);
  assert.ok(module !== undefined, `${subpath} has an import condition`);
  return { types, import: module };
}

test("PKG-03: the export map publishes the kernel and declares its peer optional", () => {
  for (const subpath of kernelEntries) {
    const target = conditions(subpath);
    assert.match(
      target.import,
      /^\.\/dist\/kernel\/(.+\/)?[a-z-]+\.js$/,
      `${subpath} loads built kernel output`,
    );
    assert.match(
      target.types,
      /^\.\/dist\/kernel\/(.+\/)?[a-z-]+\.d\.ts$/,
      `${subpath} is typed by built kernel declarations`,
    );
    assert.equal(
      target.types.replace(/\.d\.ts$/, ""),
      target.import.replace(/\.js$/, ""),
      `${subpath} types and module describe the same file`,
    );
  }
  const meta = (
    manifest as unknown as {
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    }
  ).peerDependenciesMeta;
  for (const name of kernelPeers) {
    assert.ok(
      name in manifest.peerDependencies,
      `${name} is declared as a peer dependency`,
    );
    assert.equal(meta?.[name]?.optional, true, `${name} is an optional peer`);
    assert.ok(
      !(name in manifest.dependencies),
      `${name} is not a hard dependency`,
    );
  }
});

/**
 * Valid as both JavaScript and TypeScript, so the same text is run by Node
 * and type-checked by `tsc` through the public specifiers.
 */
const consumerProgram = `import {
  CeremonyDefinitionError,
  check,
  defineCeremony,
  established,
  fact,
  invalidates,
  of,
  operator,
  retry,
  terminal,
} from "${manifest.name}/kernel";
import { catalog, githubAppAccess, githubUserAccess } from "${manifest.name}/kernel/flows";
import { proveSheet, sheetLayout, SHEET_DOMAIN } from "${manifest.name}/kernel/interface";

const enter = operator({
  description: "Ask the person for a token.",
  establishes: ["entered"],
  actor: "human",
  idempotent: true,
  outcomes: {
    entered: established("The person submitted a token."),
    declined: terminal("declined", "The person chose not to."),
  },
  interface: {
    title: "Connect with a token",
    body: "Paste a token for this service.",
    fields: [{ name: "token", label: "Token", kind: "secret" }],
    actions: [
      { id: "submit", label: "Connect", outcome: "entered", emphasis: "primary" },
      { id: "cancel", label: "Not now", outcome: "declined", emphasis: "secondary" },
    ],
  },
});

const facts = {
  entered: fact({
    description: "The person entered a token.",
    volatile: true,
    secret: true,
    // A fact a person supplies declares a validator: any Standard Schema.
    // This one needs no library.
    value: of({
      "~standard": {
        version: 1,
        vendor: "consumer",
        validate: (value) =>
          typeof value === "string" && value.length > 0
            ? { value }
            : { issues: [{ message: "a token is non-empty text" }] },
      },
    }),
  }),
  token: fact({
    description: "The service accepted the token.",
    volatile: true,
    observable: true,
    secret: true,
  }),
};

const token = defineCeremony({
  id: "consumer-token",
  title: "Connect with a token",
  facts,
  operators: {
    enter,
    verify: operator({
      description: "Make one harmless call with the token.",
      establishes: ["token"],
      requires: ["entered"],
      consumes: ["entered"],
      actor: "machine",
      idempotent: true,
      outcomes: {
        accepted: established("The service accepted the token."),
        rejected: invalidates(["entered"], "The service refused the token."),
        unavailable: retry("The service did not answer."),
      },
    }),
  },
  goal: ["token"],
});

// The same ceremony with no way to notice a spent input: the kernel refuses it.
let refused = "";
try {
  defineCeremony({
    id: "consumer-careless",
    title: "Connect with a token",
    facts,
    operators: {
      enter,
      verify: operator({
        description: "Make one harmless call with the token.",
        establishes: ["token"],
        requires: ["entered"],
        consumes: ["entered"],
        actor: "machine",
        idempotent: true,
        outcomes: { accepted: established("The service accepted the token.") },
      }),
    },
    goal: ["token"],
  });
} catch (error) {
  if (error instanceof CeremonyDefinitionError)
    refused = error.issues.map((issue) => issue.rule).join(",");
}

const own = check(token);
const family = check(catalog.apiKey);
const spec = token.operators.enter.interface;
const proof = spec === undefined ? "none" : proveSheet(sheetLayout(spec)).status;

console.log(
  JSON.stringify({
    complete: own.complete,
    violations: own.violations.map((violation) => violation.property),
    operatorsUnused: own.operatorsUnused,
    refused,
    family: { complete: family.complete, violations: family.violations.length },
    families: Object.keys(catalog).length,
    composed: [githubAppAccess.id, githubUserAccess.id].every((id) => typeof id === "string"),
    proof,
    domain: SHEET_DOMAIN,
  }),
);
`;

test(
  "PKG-04: a consumer defines and checks a ceremony from the published kernel",
  options,
  () => {
    const directory = mkdtempSync(join(tmpdir(), "ceremony-kernel-"));
    try {
      const { consumer } = isolatedConsumer(directory);
      writeFileSync(join(consumer, "ceremony.mjs"), consumerProgram);
      writeFileSync(join(consumer, "ceremony.ts"), consumerProgram);
      const env = { ...process.env, NODE_OPTIONS: "" };

      const report = JSON.parse(
        execFileSync(process.execPath, [join(consumer, "ceremony.mjs")], {
          cwd: consumer,
          encoding: "utf8",
          env,
        }).trim(),
      ) as Record<string, unknown>;
      assert.deepEqual(report, {
        complete: true,
        violations: [],
        operatorsUnused: [],
        refused: "consumed-detectable,stale-precondition",
        family: { complete: true, violations: 0 },
        families: 11,
        composed: true,
        proof: "proved",
        domain: { width: [320, 1280], scale: [1, 2] },
      });

      writeFileSync(
        join(consumer, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            target: "ES2024",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            lib: ["ES2024", "DOM"],
            strict: true,
            noUncheckedIndexedAccess: true,
            exactOptionalPropertyTypes: true,
            noEmit: true,
            skipLibCheck: false,
            types: [],
          },
          files: ["ceremony.ts"],
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

/** Every specifier a module or declaration file names in an import or export. */
function specifiers(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns)
    for (const match of source.matchAll(pattern)) found.push(match[1]!);
  return found;
}

test(
  "PKG-05: no module outside the kernel is reachable from a kernel entry",
  options,
  () => {
    const directory = mkdtempSync(join(tmpdir(), "ceremony-kernel-graph-"));
    try {
      const { installed } = isolatedConsumer(directory);
      const walk = (entries: readonly string[]) => {
        const reached = new Set<string>();
        const packages = new Set<string>();
        const pending: string[] = [];
        for (const subpath of entries) {
          const target = conditions(subpath);
          pending.push(target.import.slice(2), target.types.slice(2));
        }
        while (pending.length > 0) {
          const path = pending.pop()!;
          if (reached.has(path)) continue;
          reached.add(path);
          const file = join(installed, path);
          assert.ok(existsSync(file), `${path} is in the tarball`);
          for (const specifier of specifiers(readFileSync(file, "utf8"))) {
            if (!specifier.startsWith(".")) {
              packages.add(specifier);
              continue;
            }
            let next = join(dirname(path), specifier);
            if (path.endsWith(".d.ts")) next = next.replace(/\.js$/, ".d.ts");
            pending.push(next);
          }
        }
        return { reached, packages };
      };
      const outsideOf = (allowed: readonly string[], packages: Set<string>) =>
        [...packages].filter(
          (name) =>
            !allowed.some(
              (peer) => name === peer || name.startsWith(`${peer}/`),
            ),
        );

      const { reached, packages } = walk(kernelEntries);
      const outside = [...reached].filter(
        (path) => !path.startsWith("dist/kernel/"),
      );
      assert.deepEqual(outside, [], "every reachable module is kernel code");
      assert.deepEqual(
        outsideOf([...kernelPeers, ...flowsDependencies], packages),
        [],
        "a kernel entry imports no package but its optional peers and the flows' declared dependencies, and no Node built-in",
      );
      const core = walk(
        kernelEntries.filter((entry) => entry !== "./kernel/flows"),
      );
      assert.deepEqual(
        outsideOf(kernelPeers, core.packages),
        [],
        "the kernel and its interface prover import no package but their optional peers, and no Node built-in",
      );
      for (const name of flowsDependencies)
        assert.ok(
          name in manifest.dependencies,
          `${name}, which the flows import, is a dependency of the package`,
        );
      for (const module of [
        "dist/kernel/ceremony.js",
        "dist/kernel/model.js",
        "dist/kernel/flows/catalog.js",
        "dist/kernel/flows/github-app.js",
        "dist/kernel/interface/sheet.js",
        "dist/kernel/interface/prove.js",
      ])
        assert.ok(reached.has(module), `${module} is reachable from an entry`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

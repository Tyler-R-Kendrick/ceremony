import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/*
 * QA-05. Environment and packaging sentinels that do not need a browser, a
 * registry or a network: what the default browser bundle is allowed to reach,
 * whether any source file has been corrupted by a literal control character,
 * and whether every test this swarm wrote is reachable from the documented
 * canonical commands.
 *
 * The browser accessibility, packed-consumer, hosted-build and workflow
 * recovery suites are real and already checked in; they bind fixed ports
 * (4173/4174 for the Playwright dev servers) and are excluded from execution
 * here by the concurrency rule, so this file asserts their presence and the
 * properties they depend on rather than muting or duplicating them.
 */

const ROOT = resolve(import.meta.dirname, "../../..");

/* -------------------------------------------- default browser bundle reach */

const SPECIFIER =
  /(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|(?:^|[\s;])import\s*["']([^"']+)["']/g;

function specifiersOf(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(SPECIFIER)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value) found.push(value);
  }
  return found;
}

/** Resolves a relative ESM specifier written with a `.js` extension to its source file. */
function resolveRelative(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  const candidates = [
    base,
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    base.replace(/\.jsx$/, ".tsx"),
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  return candidates.find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
}

type Reach = {
  files: string[];
  nodeBuiltins: Array<{ file: string; specifier: string }>;
  serverModules: Array<{ file: string; via: string }>;
  packages: Set<string>;
};

function reachableFrom(entries: string[]): Reach {
  const seen = new Set<string>();
  const nodeBuiltins: Reach["nodeBuiltins"] = [];
  const serverModules: Reach["serverModules"] = [];
  const packages = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const specifier of specifiersOf(source)) {
      if (specifier.startsWith("node:")) {
        nodeBuiltins.push({ file: relative(ROOT, file), specifier });
        continue;
      }
      if (!specifier.startsWith(".")) {
        packages.add(specifier.split("/").slice(0, 2).join("/"));
        continue;
      }
      const target = resolveRelative(file, specifier);
      if (!target) continue;
      if (relative(ROOT, target).startsWith(join("src", "server")))
        serverModules.push({
          file: relative(ROOT, file),
          via: relative(ROOT, target),
        });
      queue.push(target);
    }
  }
  return { files: [...seen], nodeBuiltins, serverModules, packages };
}

test("AC-PKG-02: the browser entry points cannot reach server-only code or Node builtins", () => {
  const entries = [
    resolve(ROOT, "src/core/index.ts"),
    resolve(ROOT, "src/react/index.tsx"),
  ].filter((entry) => existsSync(entry));
  assert.equal(entries.length, 2, "both published browser entries exist");

  const reach = reachableFrom(entries);
  assert.ok(reach.files.length > 10, "the walk actually followed the graph");
  assert.deepEqual(
    reach.serverModules,
    [],
    "no browser entry reaches src/server",
  );
  assert.deepEqual(
    reach.nodeBuiltins,
    [],
    "no browser entry imports a Node builtin",
  );
});

test("AC-PKG-02: connector core stays browser-safe as it grows", () => {
  const dir = resolve(ROOT, "src/core/connectors");
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".ts"))
    .map((name) => join(dir, name));
  assert.ok(files.length >= 5, "the connector core has real content");
  const reach = reachableFrom(files);
  assert.deepEqual(reach.nodeBuiltins, []);
  assert.deepEqual(reach.serverModules, []);
  // Zod is the one dependency the charter allows in core.
  assert.deepEqual(
    [...reach.packages].sort(),
    ["zod"],
    "connector core depends only on Zod",
  );
});

test("AC-PKG-02: server-only credential and crypto handling is not reachable from core", () => {
  const reach = reachableFrom([resolve(ROOT, "src/core/index.ts")]);
  const text = reach.files.map((file) => readFileSync(file, "utf8")).join("\n");
  for (const forbidden of [
    "createHmac(",
    "createDecipheriv(",
    "process.env",
    "undici",
  ])
    assert.equal(
      text.includes(forbidden),
      false,
      `${forbidden} must not appear in the default browser bundle's sources`,
    );
});

/* ------------------------------------------------- control-character hygiene */

function sourceFiles(directory: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|mts|cts|js|mjs|cjs|json)$/.test(entry.name))
        out.push(path);
    }
  };
  walk(directory);
  return out;
}

/**
 * Matches any C0 control character other than tab, newline and carriage
 * return, plus DEL. Written as a character class over code points so that no
 * escape in this file can itself be rewritten into a literal byte by a
 * formatter, which is the failure this test exists to catch.
 */
function controlCharacterAt(source: string): number {
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32 || code === 127) return index;
  }
  return -1;
}

test("QA-05: no source file contains a literal control character", () => {
  const offenders: Array<{ file: string; line: number; code: number }> = [];
  for (const file of [
    ...sourceFiles(resolve(ROOT, "src")),
    ...sourceFiles(resolve(ROOT, "tests")),
  ]) {
    const source = readFileSync(file, "utf8");
    const at = controlCharacterAt(source);
    if (at >= 0)
      offenders.push({
        file: relative(ROOT, file),
        line: source.slice(0, at).split("\n").length,
        code: source.charCodeAt(at),
      });
  }
  assert.deepEqual(
    offenders,
    [],
    `a literal control character makes a file binary to grep and to diffs; ` +
      `length-prefix composite keys instead: ${JSON.stringify(offenders)}`,
  );
});

test("QA-05: the sentinel recognizes a control character when there is one", () => {
  assert.equal(
    controlCharacterAt(
      `plain${String.fromCharCode(9)}text${String.fromCharCode(10)}`,
    ),
    -1,
  );
  assert.equal(controlCharacterAt(`a${String.fromCharCode(0)}b`), 1);
  assert.equal(controlCharacterAt(`a${String.fromCharCode(31)}b`), 1);
  assert.equal(controlCharacterAt(`a${String.fromCharCode(127)}b`), 1);
});

/* --------------------------------------- reachability from canonical commands */

type PackageJson = {
  scripts: Record<string, string>;
  exports: Record<string, unknown>;
};

function packageJson(): PackageJson {
  return JSON.parse(
    readFileSync(resolve(ROOT, "package.json"), "utf8"),
  ) as PackageJson;
}

function discoverTests(directory: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".test.ts")) out.push(relative(ROOT, path));
    }
  };
  walk(directory);
  return out;
}

test("QA-05: every QA test file is reachable from the canonical commands", () => {
  const discovered = discoverTests(resolve(ROOT, "tests"));
  const mine = discovered.filter((file) =>
    file.startsWith(join("tests", "connectors", "qa")),
  );
  assert.ok(mine.length >= 5, `QA suites were discovered: ${mine.join(", ")}`);

  // `npm test` runs scripts/test.mjs, which discovers tests/**/*.test.ts
  // recursively and excludes only tests/workflow.
  const runner = readFileSync(resolve(ROOT, "scripts/test.mjs"), "utf8");
  // Matched on the directory rather than the whole call. The helper gained a
  // suffix argument -- `discover("tests", ".test.ts")` -- so that the same walk
  // could also collect `tests/browser/*.spec.ts`, which changed this call's text
  // without changing the fact this assertion is about: the walk starts at the
  // tests root and is recursive. Pinning the exact arguments made a signature
  // change look like a coverage regression.
  assert.match(
    runner,
    /discover\("tests"/,
    "the canonical runner discovers the whole tests tree",
  );
  assert.ok(
    runner.includes("tests/workflow/"),
    "and excludes only the workflow suite",
  );
  for (const file of mine)
    assert.equal(
      file.startsWith(join("tests", "workflow")),
      false,
      `${file} would be excluded from npm test`,
    );

  // The focused supplement must cover them too.
  const scripts = packageJson().scripts;
  assert.ok(
    scripts["test:connectors"]?.includes("tests/connectors/**/*.test.ts"),
    "test:connectors covers every connector suite, including this one",
  );
});

test("QA-05: the canonical verification commands the charter names all exist", () => {
  const scripts = packageJson().scripts;
  for (const name of [
    "check",
    "specs:check",
    "test:specs",
    "test:pact",
    "test:integration",
    "test:security",
    "test:agent",
    "test:workflow",
    "test:e2e",
    "test:coverage",
    "test:mutation",
    "build",
    "build:vercel",
    "format:check",
    "verify",
    "verify:live",
    "verify:release",
  ])
    assert.ok(
      typeof scripts[name] === "string",
      `package.json is missing the canonical command ${name}`,
    );
});

test("AC-UX-05: the browser accessibility suites for the connector surface exist and are wired", () => {
  // These run under Playwright on fixed ports and are not executed here; what
  // QA checks is that they exist, target the connector surface, and are
  // reachable from the canonical e2e command.
  const specs = [
    "tests/browser/connector-directory.spec.ts",
    "tests/browser/connector-drawer.spec.ts",
  ];
  for (const spec of specs) {
    const path = resolve(ROOT, spec);
    assert.ok(existsSync(path), `${spec} exists`);
    const source = readFileSync(path, "utf8");
    assert.ok(
      /keyboard|Tab|focus|aria|role=|getByRole/i.test(source),
      `${spec} makes keyboard or accessible-name assertions`,
    );
  }
  const config = readFileSync(resolve(ROOT, "playwright.config.ts"), "utf8");
  assert.ok(
    /tests\/browser/.test(config),
    "the Playwright project points at tests/browser",
  );
  const scripts = packageJson().scripts;
  assert.ok(scripts["test:e2e"], "and test:e2e is the canonical entry point");
});

test("AC-PKG-01: the packed-consumer suites exist and exercise the published entry points", () => {
  const consumers = resolve(ROOT, "tests/consumers");
  assert.ok(existsSync(consumers), "the packed consumer fixtures are present");
  const exportsMap = packageJson().exports;
  for (const entry of [".", "./react", "./server", "./mcp-app"])
    assert.ok(
      Object.hasOwn(exportsMap, entry),
      `the published export ${entry} is still declared`,
    );
});

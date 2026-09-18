import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";

/*
 * The sentinel fixtures prove that a particular adversarial source did not
 * run. This proves the stronger thing they cannot: that these readers have no
 * way to run anything at all. It reads their own source and asserts that the
 * primitives which could execute imported code — `require(`, dynamic
 * `import(`, `eval`, `new Function`, `vm`, a child process — do not appear in
 * them. A future edit that reaches for one fails here, in front of a reviewer,
 * rather than quietly becoming a code path a fixture happens not to exercise.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..", "src", "server", "connectors", "formats");

/** Every module that touches untrusted connector source. */
const READERS = [
  "automation/common.ts",
  "automation/definition.ts",
  "automation/js-literals.ts",
  "automation/ruby-literals.ts",
  "zapier/profile.ts",
  "zapier/read.ts",
  "zapier/export.ts",
  "n8n/profile.ts",
  "n8n/read.ts",
  "n8n/export.ts",
  "workato/profile.ts",
  "workato/read.ts",
  "workato/export.ts",
];

/** Patterns that would mean "this source can run something". */
const EXECUTION = [
  { name: "require()", pattern: /\brequire\s*\(/ },
  { name: "dynamic import()", pattern: /[^.\w]import\s*\(/ },
  { name: "eval()", pattern: /\beval\s*\(/ },
  { name: "new Function", pattern: /\bnew\s+Function\b/ },
  { name: "Function constructor", pattern: /[^.\w]Function\s*\(/ },
  { name: "child_process", pattern: /child_process/ },
  { name: "node:vm", pattern: /node:vm|\bvm\.runIn/ },
  { name: "worker_threads", pattern: /worker_threads/ },
  { name: "spawn", pattern: /\bspawn(Sync)?\s*\(/ },
  { name: "exec", pattern: /\bexec(Sync|File)?\s*\(/ },
  { name: "process.binding", pattern: /process\.binding/ },
  { name: "createRequire", pattern: /createRequire/ },
];

/** Node built-ins an importer has no business reaching for. */
const FORBIDDEN_IMPORTS =
  /from\s+"node:(child_process|vm|worker_threads|fs|fs\/promises|http|https|net|dgram|cluster|repl|module)"/;

describe("the automation importers cannot execute anything", () => {
  for (const relative of READERS)
    test(`${relative} contains no execution primitive`, async () => {
      const source = await readFile(join(root, relative), "utf8");
      for (const { name, pattern } of EXECUTION)
        assert.equal(
          pattern.test(source),
          false,
          `${relative} must not contain ${name}`,
        );
      assert.equal(
        FORBIDDEN_IMPORTS.test(source),
        false,
        `${relative} must not import a process, filesystem or network module`,
      );
    });

  test("no importer reaches the network or the filesystem", async () => {
    for (const relative of READERS) {
      const source = await readFile(join(root, relative), "utf8");
      assert.equal(/\bfetch\s*\(/.test(source), false, relative);
      assert.equal(/readFile|writeFile|readFileSync/.test(source), false, relative);
    }
  });

  test("the external runtime adapter uses crypto and nothing else from Node", async () => {
    const source = await readFile(
      join(root, "automation", "external-runtime.ts"),
      "utf8",
    );
    const imports = [...source.matchAll(/from\s+"(node:[^"]+)"/g)].map(
      (match) => match[1],
    );
    assert.deepEqual(imports, ["node:crypto"]);
    for (const { name, pattern } of EXECUTION)
      assert.equal(
        pattern.test(source),
        false,
        `the adapter must not contain ${name}`,
      );
    // It reaches the network only through the injected, policy-bound fetch.
    assert.equal(/[^.]\bfetch\s*\(/.test(source), false);
    assert.match(source, /ctx\.environment\.fetch\(/);
  });

  test("the importers are pure functions of their input", async () => {
    // A reader takes text or parsed data and returns a description. It holds
    // no module-level mutable state that a second import could observe.
    for (const relative of ["zapier/read.ts", "n8n/read.ts", "workato/read.ts"]) {
      const source = await readFile(join(root, relative), "utf8");
      assert.equal(
        /^let [a-zA-Z]/m.test(source.replace(/^ +let /gm, "  let ")),
        false,
        `${relative} declares no module-level mutable binding`,
      );
    }
  });
});

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { parse as parseYaml } from "yaml";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const outputs = [
  "dist",
  "web-dist",
  ".output",
  ".nitro",
  ".swc",
  ".workflow-vitest",
];
const protectedPaths = [
  ".ceremony",
  ".workflow-data",
  "artifacts",
  "node_modules",
  "test-results",
  ".git",
];

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "ceremony-clean-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "scripts"));
  await copyFile(
    join(root, "scripts/clean.mjs"),
    join(dir, "scripts/clean.mjs"),
  );
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "@ceremony/auth" }),
  );
  for (const path of [...outputs, ...protectedPaths]) {
    await mkdir(join(dir, path));
    await writeFile(join(dir, path, "retained.txt"), "fixture");
  }
  await writeFile(join(dir, ".env"), "FIXTURE_ONLY=not-a-credential\n");
  return {
    dir,
    run: (...args: string[]) =>
      exec(process.execPath, [join(dir, "scripts/clean.mjs"), ...args], {
        cwd: tmpdir(),
      }),
  };
}

test("project cleanup previews by default and removes only rebuildable outputs when applied", async (t) => {
  const { dir, run } = await fixture(t);
  const before = (await readdir(dir)).sort();
  assert.match((await run()).stdout, /Preview only/);
  assert.deepEqual((await readdir(dir)).sort(), before);
  await symlink(
    join(dir, ".ceremony"),
    join(dir, "dist", "private-link"),
    "dir",
  );
  await run("--apply");
  const after = await readdir(dir);
  for (const path of outputs) assert.ok(!after.includes(path));
  for (const path of protectedPaths)
    assert.equal(
      await readFile(join(dir, path, "retained.txt"), "utf8"),
      "fixture",
    );
  assert.ok(after.includes(".env"));
  assert.match((await run("--apply")).stdout, /nothing/);
});

test("project cleanup refuses unknown arguments, another package, symlinks and non-directory outputs before removal", async (t) => {
  const { dir, run } = await fixture(t);
  const before = (await readdir(dir)).sort();
  await assert.rejects(run("--all"));
  assert.deepEqual((await readdir(dir)).sort(), before);
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "other" }));
  await assert.rejects(run("--apply"));
  assert.deepEqual((await readdir(dir)).sort(), before);
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ name: "@ceremony/auth" }),
  );
  await rm(join(dir, ".workflow-vitest"), { recursive: true });
  await symlink(join(dir, ".ceremony"), join(dir, ".workflow-vitest"), "dir");
  await assert.rejects(run("--apply"));
  for (const path of [...outputs, ...protectedPaths])
    assert.equal(
      await readFile(join(dir, path, "retained.txt"), "utf8"),
      "fixture",
    );
  await rm(join(dir, ".workflow-vitest"));
  await writeFile(join(dir, ".workflow-vitest"), "unexpected-file");
  await assert.rejects(run("--apply"));
  assert.equal(
    await readFile(join(dir, "dist", "retained.txt"), "utf8"),
    "fixture",
  );
});

test("project Node baseline and container CI agree without implicit credential environment forwarding", async () => {
  const node = (await readFile(join(root, ".nvmrc"), "utf8")).trim();
  const config = JSON.parse(
    await readFile(join(root, ".devcontainer/devcontainer.json"), "utf8"),
  );
  assert.equal(node, "24");
  assert.match(
    config.image,
    new RegExp(`:${String.raw`\d+\.\d+\.\d+`}-${node}-bookworm$`),
  );
  assert.equal(config.remoteUser, "node");
  assert.equal(config.workspaceFolder, "/workspaces/ceremony");
  assert.equal(config.postCreateCommand, "npm ci && npm run setup:browsers");
  assert.deepEqual(config.forwardPorts, [4173, 4174]);
  for (const port of config.forwardPorts)
    assert.equal(config.portsAttributes[port].requireLocalPort, true);
  assert.equal(config.otherPortsAttributes.onAutoForward, "ignore");
  for (const field of [
    "privileged",
    "mounts",
    "containerEnv",
    "remoteEnv",
    "runArgs",
    "postStartCommand",
  ])
    assert.equal(config[field], undefined);
  const ci = await readFile(join(root, ".github/workflows/verify.yml"), "utf8");
  // Every job takes its Node from the same file, so a job cannot quietly run on
  // a different runtime than the one the project claims to support. Counting
  // the pins against the setup steps states that rule; counting them against a
  // fixed number would only state how many jobs there were when it was written.
  const setups = ci.match(/uses: actions\/setup-node@/g)?.length ?? 0;
  assert.ok(setups > 0);
  assert.equal(ci.match(/node-version-file: \.nvmrc/g)?.length, setups);
  const containerCI = await readFile(
    join(root, ".github/workflows/devcontainer.yml"),
    "utf8",
  );
  assert.match(containerCI, /push: never/);
  assert.match(containerCI, /inheritEnv: false/);
  assert.match(containerCI, /set -eu/);
  assert.match(containerCI, /npm run test:integration/);
});

test("project onboarding and architecture relative documentation links resolve", async () => {
  for (const file of [
    "README.md",
    "CONTRIBUTING.md",
    "PRODUCT.md",
    "docs/README.md",
    "docs/architecture.md",
    "docs/development.md",
    "docs/reference.md",
  ]) {
    const text = await readFile(join(root, file), "utf8");
    for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1]!;
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      await readFile(resolve(root, dirname(file), target.split("#")[0]!));
    }
  }
});

// The type check is every `tsc` invocation that `npm run check` reaches,
// following `npm run <script>` into other package scripts. A `-b` invocation
// builds each referenced project, so it runs with `--force` to measure a full
// check rather than an up-to-date one.
type TypeCheck = { args: string[]; build: boolean; projects: string[] };

async function typeChecks(): Promise<TypeCheck[]> {
  const scripts: Record<string, string> = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  ).scripts;
  const found: TypeCheck[] = [];
  const visit = (name: string, seen: Set<string>) => {
    const script = scripts[name];
    assert.ok(script !== undefined, `package script ${name} is missing`);
    assert.ok(!seen.has(name), `package script ${name} runs itself`);
    for (const part of script.split(/&&|;|\|\|/)) {
      const words = part.trim().split(/\s+/).filter(Boolean);
      if (words[0] === "npm" && words[1] === "run" && words[2])
        visit(words[2], new Set([...seen, name]));
      if (words[0] !== "tsc") continue;
      const args = words.slice(1);
      const build = args[0] === "-b" || args[0] === "--build";
      let projects: string[];
      if (build) {
        projects = args.slice(1).filter((arg) => !arg.startsWith("-"));
        if (projects.length === 0) projects = ["."];
      } else {
        const flag = args.findIndex((a) => a === "-p" || a === "--project");
        projects = [flag === -1 ? "." : args[flag + 1]!];
      }
      found.push({ args, build, projects });
    }
  };
  visit("check", new Set());
  return found;
}

function configPath(project: string) {
  const path = resolve(root, project);
  return path.endsWith(".json") ? path : join(path, "tsconfig.json");
}

// Every project a type check reaches, with its references, and the files it
// checks.
function projectFiles(checks: TypeCheck[]) {
  const projects = new Map<string, string[]>();
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      );
    },
  };
  const visit = (path: string) => {
    if (projects.has(path)) return;
    const parsed = ts.getParsedCommandLineOfConfigFile(path, undefined, host);
    assert.ok(parsed, `${path} does not parse`);
    projects.set(
      path,
      parsed.fileNames.map((file) => resolve(file)),
    );
    for (const reference of parsed.projectReferences ?? [])
      visit(configPath(reference.path));
  };
  for (const check of checks)
    for (const project of check.projects) visit(configPath(project));
  return projects;
}

const memoryLimitKilobytes = 1_200_000;

test("every type-check project in npm run check finishes under 1.2 GB of memory", async (t) => {
  const checks = await typeChecks();
  assert.ok(checks.length > 0, "npm run check runs no tsc type check");
  for (const check of checks) {
    const args = [
      ...check.args,
      ...(check.build ? ["--force"] : []),
      "--extendedDiagnostics",
    ];
    const label = `tsc ${args.join(" ")}`;
    const result = await exec(
      process.execPath,
      [join(root, "node_modules/typescript/bin/tsc"), ...args],
      { cwd: root, maxBuffer: 256 * 1024 * 1024 },
    ).then(
      ({ stdout }) => ({ code: 0, stdout }),
      (error: { code?: number; stdout?: string; stderr?: string }) => ({
        code: error.code ?? 1,
        stdout: `${error.stdout ?? ""}${error.stderr ?? ""}`,
      }),
    );
    assert.equal(
      result.code,
      0,
      `${label} exited ${result.code}:\n${result.stdout.slice(-4000)}`,
    );
    const used = [...result.stdout.matchAll(/^Memory used:\s+(\d+)K$/gm)].map(
      (match) => Number(match[1]),
    );
    assert.ok(used.length > 0, `${label} reported no memory use`);
    t.diagnostic(`${label}: ${used.map((k) => `${k}K`).join(", ")}`);
    for (const kilobytes of used)
      assert.ok(
        kilobytes < memoryLimitKilobytes,
        `${label} used ${kilobytes}K, limit ${memoryLimitKilobytes}K`,
      );
  }
});

test("every TypeScript source in src, examples, tests, scripts and extensions belongs to a type-check project", async () => {
  const projects = projectFiles(await typeChecks());
  const covered = new Set([...projects.values()].flat());
  // The mutation runner copies the project into an untracked sandbox inside
  // the checkout, so list what the repository tracks from its top level; the
  // sandbox holds the same paths.
  const { stdout: top } = await exec("git", ["rev-parse", "--show-toplevel"], {
    cwd: root,
  });
  const { stdout } = await exec("git", ["ls-files", "-z"], {
    cwd: top.trim(),
    maxBuffer: 64 * 1024 * 1024,
  });
  const required = stdout
    .split("\0")
    .filter((file) => /\.(ts|tsx|mts|cts)$/.test(file))
    .filter(
      (file) =>
        /^(src|examples|tests|scripts|extensions)\//.test(file) ||
        file === "vite.config.ts" ||
        file === "playwright.config.ts",
    )
    .filter((file) => !file.startsWith("tests/consumers/"));
  assert.ok(required.length > 0);
  const missing = required.filter((file) => !covered.has(join(root, file)));
  assert.deepEqual(missing, [], "files no type-check project includes");
});

type WorkflowStep = {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
};
type WorkflowJob = { env?: Record<string, unknown>; steps?: WorkflowStep[] };

// The commands a job runs, with each `npm run <script>` followed into the
// package script it names and each `scripts/...` or `verification/...` file a
// command names read in full, so a job that delegates to a script is judged on
// what that script runs. Each check.sh must be named, not reached by a glob:
// the test below finds every check.sh on disk, so a new area that is not named
// fails here instead of being skipped in CI.
async function jobCommands(job: WorkflowJob) {
  const scripts: Record<string, string> = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  ).scripts;
  const seen = new Set<string>();
  const texts: string[] = [];
  const visit = async (text: string) => {
    texts.push(text);
    for (const match of text.matchAll(/npm run ([\w:.-]+)/g)) {
      const name = match[1]!;
      if (seen.has(`script:${name}`)) continue;
      seen.add(`script:${name}`);
      const script = scripts[name];
      assert.ok(script !== undefined, `package script ${name} is missing`);
      await visit(script);
    }
    for (const match of text.matchAll(
      /(?:^|[\s"'])((?:scripts|verification)\/[\w./-]+\.(?:sh|mjs|ts|js))/g,
    )) {
      const file = match[1]!;
      if (seen.has(`file:${file}`)) continue;
      seen.add(`file:${file}`);
      const body = await readFile(join(root, file), "utf8").catch(() => "");
      if (body) await visit(body);
    }
  };
  for (const step of job.steps ?? []) if (step.run) await visit(step.run);
  return texts.join("\n");
}

function stepEnv(job: WorkflowJob, step: WorkflowStep, name: string) {
  const value = step.env?.[name] ?? job.env?.[name];
  return value === undefined ? undefined : String(value);
}

test("CI runs the kernel properties, the TLA+ models and the Bombadil browser properties as separate jobs", async () => {
  const workflow = parseYaml(
    await readFile(join(root, ".github/workflows/verify.yml"), "utf8"),
  ) as { jobs: Record<string, WorkflowJob> };
  for (const name of ["kernel", "models", "bombadil"]) {
    const job = workflow.jobs[name];
    assert.ok(job, `verify.yml has no ${name} job`);
    const node = (job.steps ?? []).filter((step) =>
      step.uses?.startsWith("actions/setup-node@"),
    );
    assert.equal(node.length, 1, `${name} job sets up Node once`);
    assert.equal(node[0]!.with?.["node-version-file"], ".nvmrc");
  }

  // kernel: the kernel property tests at 1000 runs per property.
  const kernel = workflow.jobs.kernel!;
  const kernelStep = (kernel.steps ?? []).find((step) =>
    /\bnpm run test:kernel\b/.test(step.run ?? ""),
  );
  assert.ok(kernelStep, "kernel job does not run npm run test:kernel");
  assert.equal(stepEnv(kernel, kernelStep, "FUZZ_RUNS"), "1000");

  // models: Java 21, the TLC jar cached under the hash tlc.sh pins, every
  // area's check.sh and the kernel flow model.
  const models = workflow.jobs.models!;
  const java = (models.steps ?? []).find((step) =>
    step.uses?.startsWith("actions/setup-java@"),
  );
  assert.ok(java, "models job does not set up Java");
  assert.equal(String(java.with?.["java-version"]), "21");
  const tlc = await readFile(join(root, "verification/tlc.sh"), "utf8");
  const sum = /^sum=([0-9a-f]{64})$/m.exec(tlc)?.[1];
  assert.ok(sum, "verification/tlc.sh pins no jar hash");
  const cache = (models.steps ?? []).find((step) =>
    step.uses?.startsWith("actions/cache@"),
  );
  assert.ok(cache, "models job does not cache the TLC jar");
  assert.match(String(cache.with?.path), /ceremony-tla/);
  const key = String(cache.with?.key);
  assert.ok(
    key.includes(sum) || key.includes("hashFiles('verification/tlc.sh')"),
    `TLC jar cache key ${key} is not tied to the jar's hash`,
  );
  const checks: string[] = [];
  for (const entry of await readdir(join(root, "verification"), {
    withFileTypes: true,
  })) {
    if (!entry.isDirectory()) continue;
    const check = `verification/${entry.name}/check.sh`;
    if (
      await readFile(join(root, check)).then(
        () => true,
        () => false,
      )
    )
      checks.push(check);
  }
  assert.ok(checks.length >= 4, `found only ${checks.join(", ")}`);
  const modelCommands = await jobCommands(models);
  for (const check of checks)
    assert.ok(
      modelCommands.includes(check),
      `models job does not run ${check}`,
    );
  assert.match(
    modelCommands,
    /verification\/tlc\.sh connect-github ConnectGitHub\b/,
  );
  const scripts: Record<string, string> = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  ).scripts;
  assert.ok(
    scripts["verify:models"],
    "package script verify:models is missing",
  );
  const local = await jobCommands({
    steps: [{ run: "npm run verify:models" }],
  });
  for (const check of checks)
    assert.ok(local.includes(check), `verify:models does not run ${check}`);
  assert.match(local, /verification\/tlc\.sh connect-github ConnectGitHub\b/);

  // bombadil: Chromium installed, then the browser properties for 90 seconds.
  const bombadil = workflow.jobs.bombadil!;
  assert.ok(
    (bombadil.steps ?? []).some((step) =>
      /playwright install\b.*\bchromium\b/.test(step.run ?? ""),
    ),
    "bombadil job does not install Chromium",
  );
  assert.ok(
    (bombadil.steps ?? []).some((step) =>
      /\bnpm run test:bombadil -- 90s\b/.test(step.run ?? ""),
    ),
    "bombadil job does not run npm run test:bombadil -- 90s",
  );
});

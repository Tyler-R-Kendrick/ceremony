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

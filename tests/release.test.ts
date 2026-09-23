import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { parse } from "yaml";
import { releaseRefusal } from "../scripts/release-guard.js";

/*
 * The release path, checked without releasing anything.
 *
 * Nothing here publishes, tags or talks to a registry. It holds the guard
 * that replaced `"private": true` to its rule, and the workflow to the
 * properties that make it safe to leave in the repository: it cannot run on
 * a pull request or a fork, it fails before building when the token is
 * missing, it checks the tag against the version before installing anything,
 * and the npm token reaches only the steps that talk to the registry.
 */

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
) as {
  version: string;
  private?: boolean;
  scripts: Record<string, string>;
  publishConfig?: Record<string, unknown>;
};

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  env?: Record<string, string>;
};
const workflow = parse(
  readFileSync(join(root, ".github/workflows/release.yml"), "utf8"),
) as {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<
    string,
    {
      if?: string;
      permissions: Record<string, string>;
      env: Record<string, string>;
      steps: Step[];
    }
  >;
};

test("REL-01: the guard publishes only the version the tag names", () => {
  const version = "1.4.0";
  assert.equal(
    releaseRefusal({ version }, { CEREMONY_RELEASE_TAG: "v1.4.0" }),
    undefined,
  );
  assert.match(
    releaseRefusal({ version }, {}) ?? "",
    /CEREMONY_RELEASE_TAG is not set/,
    "a publish from a checkout, with no tag, is refused",
  );
  for (const tag of ["1.4.0", "v1.4.1", "v1.4.0-rc.1", "v1.4", " v1.4.0"])
    assert.match(
      releaseRefusal({ version }, { CEREMONY_RELEASE_TAG: tag }) ?? "",
      /does not match/,
      `the tag ${JSON.stringify(tag)} does not name ${version}`,
    );
  assert.match(
    releaseRefusal(
      { version, private: true },
      { CEREMONY_RELEASE_TAG: "v1.4.0" },
    ) ?? "",
    /private/,
  );
});

test("REL-02: the guard runs first in prepublishOnly, before the checks", async () => {
  assert.equal(manifest.private, undefined, "the package is publishable");
  assert.equal(
    manifest.scripts.prepublishOnly,
    "node --import tsx scripts/release-guard.ts && npm run check && npm run build && npm run test:package",
  );
  assert.deepEqual(manifest.publishConfig, {
    access: "public",
    provenance: true,
  });

  // And as a command: refused without a tag, admitted with the right one.
  const run = (tag?: string) =>
    promisify(execFile)(
      process.execPath,
      ["--import", "tsx", join(root, "scripts/release-guard.ts")],
      {
        cwd: root,
        env: {
          ...process.env,
          NODE_OPTIONS: "",
          CEREMONY_RELEASE_TAG: tag ?? "",
        },
      },
    );
  await assert.rejects(run(), (error: { code?: number; stderr?: string }) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr ?? "", /Refusing to publish/);
    return true;
  });
  await assert.rejects(run("v0.0.0-not-this"), /does not match/);
  const { stdout } = await run(`v${manifest.version}`);
  assert.match(
    stdout,
    new RegExp(`@${manifest.version.replace(/\./g, "\\.")}`),
  );
});

test("REL-03: the release workflow cannot publish from a pull request, a fork, or a mismatched tag", () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ["push", "release"]);
  assert.deepEqual(workflow.on.release, { types: ["published"] });
  assert.deepEqual(workflow.on.push, { tags: ["v*"] });
  assert.deepEqual(workflow.permissions, { contents: "read" });

  const jobs = Object.values(workflow.jobs);
  assert.equal(jobs.length, 1);
  const job = jobs[0]!;
  assert.equal(job.if, "${{ !github.event.repository.fork }}");
  assert.deepEqual(job.permissions, {
    contents: "read",
    "id-token": "write",
  });
  assert.equal(job.env.CEREMONY_RELEASE_TAG, "${{ github.ref_name }}");

  const index = (predicate: (step: Step) => boolean, what: string) => {
    const found = job.steps.findIndex(predicate);
    assert.ok(found >= 0, `the workflow has ${what}`);
    return found;
  };
  const token = index(
    (step) => step.name === "Require NPM_TOKEN",
    "a token check",
  );
  const tag = index(
    (step) => step.run?.includes("scripts/release-guard.ts") ?? false,
    "a tag check",
  );
  const install = index((step) => step.run === "npm ci", "an install");
  const check = index((step) => step.run === "npm run check", "the checks");
  const build = index((step) => step.run === "npm run build", "the build");
  const pack = index(
    (step) => step.run === "npm run test:package",
    "the package test",
  );
  const publish = index(
    (step) => step.run?.includes("npm publish") ?? false,
    "a publish",
  );
  assert.equal(token, 0, "a missing token fails before anything else runs");
  assert.match(job.steps[token]!.run!, /exit 1/);
  assert.ok(
    token < tag &&
      tag < install &&
      install < check &&
      check < build &&
      build < pack &&
      pack < publish,
    "token, tag, install, check, build, package test, then publish",
  );
  assert.equal(publish, job.steps.length - 1, "publishing is the last step");
  assert.match(
    job.steps[publish]!.run!,
    /npm publish --provenance --access public/,
  );

  // The token is handed only to the steps that talk to the registry.
  const holders = job.steps
    .filter((step) =>
      Object.values(step.env ?? {}).some((value) =>
        value.includes("secrets.NPM_TOKEN"),
      ),
    )
    .map((step) => step.name);
  assert.deepEqual(holders, [
    "Require NPM_TOKEN",
    "Already published?",
    "Publish",
  ]);
  assert.equal(
    JSON.stringify(job.env).includes("secrets."),
    false,
    "no secret is set for the whole job",
  );
});

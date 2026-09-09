import { spawnSync, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  requiredStages,
  summarizeStage,
  coverageTotals,
} from "./verification-summary.js";
import {
  profileFingerprint,
  browserVersions,
} from "./verification-metadata.js";

// Store only allowlisted command statistics, never provider/model/DOM diagnostics.
const commands = requiredStages;
const startedAt = new Date().toISOString();
const profilePath =
  process.env.CEREMONY_RELEASE_PROFILE ??
  "docs/implementation-evidence/ceremony-teaching/local-profile.json";
let metadata;
try {
  metadata = profileFingerprint(JSON.parse(readFileSync(profilePath, "utf8")));
} catch {
  console.error(
    "Verification requires a valid non-secret profile. No raw configuration retained.",
  );
  process.exit(1);
}
let commit = null;
try {
  const dirty = execFileSync("git", ["status", "--porcelain"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (!dirty.trim())
    commit = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
} catch {
  /* An unversioned/dirty local check is useful, but cannot certify a release commit. */
}
const directory = join(
  "artifacts",
  "verification",
  startedAt.replace(/[:.]/g, "-"),
);
mkdirSync(directory, { recursive: true });
const results = [];
function persist(complete = false, coverageValid = false) {
  const verdict =
    results.some((item) => item.exitCode !== 0) || (complete && !coverageValid)
      ? "FAIL"
      : complete && results.length === commands.length
        ? "PASS"
        : "INCOMPLETE";
  writeFileSync(
    join(directory, "commands.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        commit,
        startedAt,
        runtime: process.version,
        ...metadata,
        results,
        verdict,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
}
for (const command of commands) {
  console.log(`Checking ${command}`);
  const start = Date.now();
  const result = spawnSync("npm", ["run", command], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, "--no-experimental-webstorage"]
        .filter(Boolean)
        .join(" "),
    },
  });
  const output = (result.stdout ?? "") + "\n" + (result.stderr ?? "");
  let mutation;
  if (command === "test:security:mutation") {
    try {
      const path = "artifacts/security-mutation/mutation.json";
      if (statSync(path).mtimeMs >= start)
        mutation = JSON.parse(readFileSync(path, "utf8"));
    } catch {}
  }
  const record = {
    ...summarizeStage(command, result.status, output, mutation),
    startedAt: new Date(start).toISOString(),
    checkedAt: new Date().toISOString(),
    browsers: {},
    durationMs: Date.now() - start,
  };
  if (command === "test:e2e" && record.exitCode === 0) {
    try {
      const { chromium, firefox, webkit } = await import("playwright-core");
      record.browsers = await browserVersions({
        chromium: () => chromium.launch(),
        firefox: () => firefox.launch(),
        webkit: () =>
          webkit.launch(
            process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE_PATH
              ? {
                  executablePath: process.env.PLAYWRIGHT_WEBKIT_EXECUTABLE_PATH,
                }
              : {},
          ),
      });
    } catch {
      record.exitCode = 1;
    }
  }
  results.push(record);
  console.log(
    `${command}: ${record.exitCode === 0 ? "PASS" : "FAIL"}${record.tests ? ` (${record.tests.passed ?? 0} passed, ${record.tests.failed ?? 0} failed, ${record.tests.skipped ?? 0} skipped)` : ""}`,
  );
  persist();
  if (record.exitCode !== 0) {
    console.error(
      `Run npm run ${command} for local diagnostics. Sanitized attempt retained at ${directory}/commands.json`,
    );
    process.exitCode = 1;
    break;
  }
}
if (!process.exitCode) {
  try {
    const path = "artifacts/coverage/coverage-summary.json";
    if (statSync(path).mtimeMs < Date.parse(startedAt))
      throw new Error("Stale coverage");
    const coverage = coverageTotals(JSON.parse(readFileSync(path, "utf8")));
    if (
      profileFingerprint(JSON.parse(readFileSync(profilePath, "utf8")))
        .configurationDigest !== metadata.configurationDigest
    )
      throw new Error("Profile changed during verification");
    writeFileSync(
      join(directory, "coverage.json"),
      JSON.stringify(coverage, null, 2) + "\n",
      { mode: 0o600 },
    );
    if (commit) {
      const dirty = execFileSync("git", ["status", "--porcelain"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const current = execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (dirty.trim() || current !== commit) commit = null;
    }
    persist(true, true);
    console.log(
      `Deterministic checks passed. Sanitized evidence: ${directory}/commands.json`,
    );
  } catch {
    process.exitCode = 1;
    persist(true, false);
    console.error(
      "Deterministic verification failed: missing, stale or invalid coverage summary. No raw diagnostics retained.",
    );
  }
}

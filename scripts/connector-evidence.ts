import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { run as nodeRun } from "node:test";
import { z } from "zod";

/*
 * Joins the swarm ledgers with actual test results into one machine-readable
 * evidence report. Every required work item in the charter is listed whether
 * or not a ledger mentions it: an item nobody delivered is reported unmet, not
 * omitted. Test results come from the Node test runner's JUnit output over the
 * connector suites, never from a ledger's own claim. Nothing here retains raw
 * diagnostics, provider bodies or secrets: only file names, counts and codes.
 */

/*
 * A ledger is read strictly where it is read at all, and loosely where it is
 * not.
 *
 * The first version was `strictObject` throughout, and that was a mistake with
 * a cost: twenty of the twenty-six ledgers carried a descriptive key this
 * schema had not anticipated -- a swarm's own `testCommands`, `verification`,
 * `sourceProfiles`, `findings`, a per-item `title` or `provider` -- and an
 * unrecognized key failed the whole document, so every work item inside it was
 * discarded. The report then said 151 of 154 requirements were unmet while the
 * suites were in fact green and the ledgers said 152 were implemented. An
 * evidence report that understates is still wrong, and understating is the
 * more corrosive direction: it teaches a reader to ignore the report.
 *
 * So: every field this report actually reads is validated exactly as before,
 * and an additional key is carried through as unvalidated material rather than
 * trusted or dropped. A required key is still required, so a typo in one is
 * still a failure rather than a silently ignored extra. Nothing here reads an
 * additional key, which is why admitting it is safe -- it cannot influence a
 * verdict, and the report names it so a reader knows the ledger said more than
 * the report checked.
 */
export const ledgerSchema = z.looseObject({
  swarm: z.string().regex(/^[A-Z][A-Z0-9-]{1,40}$/),
  workItems: z
    .array(
      z.looseObject({
        // A numbered id is a required work item. An uppercase-suffixed one is
        // a swarm's own extra row (a summary, an adapter overview); it is
        // admitted so the rest of the ledger survives, and it can never
        // satisfy a requirement, because the join below matches exact ids.
        id: z.string().regex(/^[A-Z]{2,6}-(?:\d{2}|[A-Z]{2,12})$/),
        status: z.enum(["implemented", "partial", "unmet"]),
        files: z.array(z.string().max(300)).max(200),
        tests: z.array(z.string().max(300)).max(200),
        acceptanceIds: z.array(z.string().regex(/^AC-[A-Z]+-\d{2}$/)).max(64),
        evidenceLevel: z.enum([
          "not-tested",
          "unit",
          "protocol-fixture",
          "local-integration",
          "browser-integration",
          "live-authorized",
          "deployed-authorized",
        ]),
        sourceProfileIds: z.array(z.string().max(200)).max(32).default([]),
        // The ceilings exist to keep a raw provider payload out of the report,
        // not to truncate a considered limitation. Both were tight enough that
        // three swarms tripped them while writing prose, so both are wider;
        // they are still far below any plausible payload.
        limitations: z.array(z.string().max(1500)).max(64).default([]),
        notes: z.string().max(6000).default(""),
      }),
    )
    .max(64),
  contractChanges: z.array(z.unknown()).max(64).default([]),
  integrationPatches: z.array(z.unknown()).max(64).default([]),
  dependenciesProposed: z.array(z.unknown()).max(32).default([]),
  unmet: z.array(z.unknown()).max(64).default([]),
  /*
   * "No external effect was performed" is the claim that matters most in this
   * work, so the field admits either a sentence or a structured record. Two
   * swarms recorded it structurally, which is more auditable, not less; the
   * previous string-only shape rejected them and lost the rest of the ledger
   * along with the claim.
   */
  externalEffectsPerformed: z
    .array(z.union([z.string().max(1500), z.record(z.string(), z.unknown())]))
    .max(64)
    .default([]),
  securityFindings: z.array(z.unknown()).max(200).default([]),
});
export type Ledger = z.infer<typeof ledgerSchema>;

/** Every work item the brief requires. A missing ledger entry is an unmet requirement. */
export const requiredWorkItems: Record<string, string[]> = {
  INT: ["INT-01", "INT-02", "INT-03", "INT-04", "INT-05", "INT-06"],
  CONTRACT: ["CON-01", "CON-02", "CON-03", "CON-04", "CON-05", "CON-06"],
  IMPORT: ["IMP-01", "IMP-02", "IMP-03", "IMP-04", "IMP-05", "IMP-06"],
  HTTP: ["HTTP-01", "HTTP-02", "HTTP-03", "HTTP-04", "HTTP-05", "HTTP-06"],
  WORKFLOW: ["WF-01", "WF-02", "WF-03", "WF-04", "WF-05"],
  EVENT: ["EVT-01", "EVT-02", "EVT-03", "EVT-04", "EVT-05", "EVT-06"],
  OAUTH: ["OA-01", "OA-02", "OA-03", "OA-04", "OA-05", "OA-06"],
  REGISTRY: ["REG-01", "REG-02", "REG-03", "REG-04", "REG-05"],
  MCP: ["MCP-01", "MCP-02", "MCP-03", "MCP-04", "MCP-05", "MCP-06"],
  VERCEL: ["VC-01", "VC-02", "VC-03", "VC-04", "VC-05", "VC-06"],
  SUPABASE: ["SB-01", "SB-02", "SB-03", "SB-04", "SB-05", "SB-06"],
  NANGO: ["NG-01", "NG-02", "NG-03", "NG-04", "NG-05", "NG-06"],
  PIPEDREAM: ["PD-01", "PD-02", "PD-03", "PD-04"],
  COMPOSIO: ["CO-01", "CO-02", "CO-03", "CO-04"],
  "IDENTITY-BROKERS": ["IB-01", "IB-02", "IB-03", "IB-04", "IB-05"],
  CATALOGS: ["CAT-01", "CAT-02", "CAT-03", "CAT-04", "CAT-05"],
  MICROSOFT: ["MS-01", "MS-02", "MS-03", "MS-04", "MS-05"],
  AUTOMATION: ["AUTO-01", "AUTO-02", "AUTO-03", "AUTO-04", "AUTO-05"],
  DATA: ["DATA-01", "DATA-02", "DATA-03", "DATA-04", "DATA-05"],
  CLOUD: ["CLOUD-01", "CLOUD-02", "CLOUD-03", "CLOUD-04"],
  BINDINGS: ["BIND-01", "BIND-02", "BIND-03", "BIND-04", "BIND-05"],
  "AGENT-SURFACES": ["AG-01", "AG-02", "AG-03", "AG-04", "AG-05"],
  STATE: [
    "STATE-01",
    "STATE-02",
    "STATE-03",
    "STATE-04",
    "STATE-05",
    "STATE-06",
  ],
  COMMAND: ["CMD-01", "CMD-02", "CMD-03", "CMD-04", "CMD-05", "CMD-06"],
  UX: ["UX-01", "UX-02", "UX-03", "UX-04", "UX-05", "UX-06", "UX-07"],
  SECURITY: ["SEC-01", "SEC-02", "SEC-03", "SEC-04", "SEC-05", "SEC-06"],
  QA: ["QA-01", "QA-02", "QA-03", "QA-04", "QA-05", "QA-06"],
  DOCS: ["DOC-01", "DOC-02", "DOC-03", "DOC-04", "DOC-05", "DOC-06"],
};

const root = fileURLToPath(new URL("..", import.meta.url));
const evidenceDirectory = join(
  root,
  "docs/implementation-evidence/connector-interoperability",
);
const ledgerDirectory = join(evidenceDirectory, "ledger");

function git(args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/** Digest of the tracked diff plus untracked file contents: identifies a dirty tree exactly. */
function workingTreeDigest(): string | null {
  const dirty = git(["status", "--porcelain"]);
  if (!dirty) return null;
  const hash = createHash("sha256");
  hash.update(git(["diff", "HEAD", "--binary"]));
  for (const file of git(["ls-files", "--others", "--exclude-standard"])
    .split("\n")
    .filter(Boolean)
    .sort()) {
    hash.update(`\n--- ${file}\n`);
    try {
      hash.update(readFileSync(join(root, file)));
    } catch {
      hash.update("<unreadable>");
    }
  }
  return hash.digest("hex");
}

export type SuiteResult = {
  file: string;
  passed: number;
  failed: number;
  skipped: number;
};

/**
 * Runs the connector suites once and records, per file, how many top-level
 * tests passed, failed or were skipped.
 *
 * This used to parse the JUnit reporter's XML, which cannot answer the
 * question. Node names a `<testsuite>` after a `describe` block's title, and a
 * suite written as top-level `test()` calls -- which is most of this
 * repository -- emits bare `<testcase>` elements with no enclosing suite and
 * no file attribute anywhere. So every result was unattributable, the report
 * recorded zero suites, and every requirement read as unverified while the
 * suites were in fact green. An evidence report that understates is still
 * wrong, and it is the more dangerous direction here: it trains a reader to
 * discount it.
 *
 * The programmatic runner carries `data.file` on every event, so attribution
 * comes from the runner rather than from a reporter's formatting. Only
 * `nesting === 0` is counted, so a subtest is not double-counted with its
 * parent. Counts only are kept: a failure message could quote a payload, and
 * none is retained.
 */
export async function runConnectorSuites(files: string[]): Promise<{
  command: string;
  exitCode: number | null;
  suites: SuiteResult[];
}> {
  const byFile = new Map<string, SuiteResult>();
  const record = (file: string | undefined, key: keyof SuiteResult): void => {
    if (!file) return;
    const relativePath = relative(root, file);
    const existing = byFile.get(relativePath) ?? {
      file: relativePath,
      passed: 0,
      failed: 0,
      skipped: 0,
    };
    if (key !== "file") existing[key] += 1;
    byFile.set(relativePath, existing);
  };

  let failed = false;
  const stream = nodeRun({
    files: files.map((file) => join(root, file)),
    concurrency: 4,
    execArgv: ["--no-experimental-webstorage", "--import", "tsx"],
  });
  for await (const event of stream) {
    if (event.type === "test:pass" || event.type === "test:fail") {
      const data = event.data as {
        file?: string;
        nesting?: number;
        skip?: boolean;
        todo?: boolean;
      };
      if (data.nesting !== 0) continue;
      if (data.skip === true || data.todo === true)
        record(data.file, "skipped");
      else if (event.type === "test:pass") record(data.file, "passed");
      else {
        record(data.file, "failed");
        failed = true;
      }
    }
  }
  return {
    command: `node --import tsx --test ${files.length} connector test files (programmatic runner, counts only)`,
    exitCode: failed ? 1 : 0,
    suites: [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file)),
  };
}

function discoverConnectorTests(): string[] {
  const results: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".test.ts"))
        results.push(relative(root, path));
    }
  };
  const base = join(root, "tests/connectors");
  if (existsSync(base)) walk(base);
  return results.sort();
}

export function loadLedgers(): { ledgers: Ledger[]; problems: string[] } {
  const ledgers: Ledger[] = [];
  const problems: string[] = [];
  if (!existsSync(ledgerDirectory)) return { ledgers, problems };
  for (const name of readdirSync(ledgerDirectory).sort()) {
    if (!name.endsWith(".json")) continue;
    try {
      const parsed = ledgerSchema.safeParse(
        JSON.parse(readFileSync(join(ledgerDirectory, name), "utf8")),
      );
      if (!parsed.success) {
        problems.push(
          `ledger/${name}: ${parsed.error.issues
            .slice(0, 5)
            .map((issue) => `${issue.path.join(".")} ${issue.message}`)
            .join("; ")}`,
        );
        continue;
      }
      ledgers.push(parsed.data);
    } catch {
      problems.push(`ledger/${name}: unreadable JSON`);
    }
  }
  return { ledgers, problems };
}

type Check = {
  testId: string;
  command: string;
  result: "pass" | "fail" | "blocked" | "not-applicable";
  evidenceLevel: string;
  artifact?: string;
  reason?: string;
};

export function buildReport(input: {
  ledgers: Ledger[];
  problems: string[];
  suites: SuiteResult[];
  suiteCommand: string;
  environment: Record<string, unknown>;
}) {
  const byFile = new Map(input.suites.map((suite) => [suite.file, suite]));
  const items = new Map<
    string,
    Ledger["workItems"][number] & { swarm: string }
  >();
  for (const ledger of input.ledgers)
    for (const item of ledger.workItems)
      items.set(item.id, { ...item, swarm: ledger.swarm });
  const requirements = [];
  const unmet: Array<{ id: string; swarm: string; reason: string }> = [];
  for (const [swarm, ids] of Object.entries(requiredWorkItems))
    for (const id of ids) {
      const item = items.get(id);
      if (!item) {
        unmet.push({ id, swarm, reason: "no ledger entry: not delivered" });
        requirements.push({
          id,
          swarm,
          implementationStatus: "unmet",
          files: [],
          sourceProfileIds: [],
          acceptanceIds: [],
          checks: [],
          limitations: ["No ledger entry was produced for this work item."],
        });
        continue;
      }
      const checks: Check[] = item.tests.map((file) => {
        const suite = byFile.get(file);
        /*
         * A ledger's `tests` list is what a swarm considers the evidence for a
         * work item, and that is not always a file this run executes. Three
         * kinds appear, and conflating them was wrong in the worst direction:
         * every path absent from the connector run was reported as a failed
         * check, so a YAML fixture -- which is not a test and can never appear
         * in a test run -- made an implemented requirement read as unmet.
         *
         * So each path is classified by what it is.
         *
         * A `.test.ts` under tests/connectors is this run's business. Present
         * and green is a pass; present and red is a fail; absent really does
         * mean it did not run, and stays a fail.
         *
         * A Playwright `.spec.ts` belongs to another runner that binds fixed
         * ports and is not started here. It is `blocked`, naming the runner,
         * because the evidence exists and this run is not the place it is
         * produced.
         *
         * Anything else -- a fixture, a double, a harness, a helper module --
         * is supporting material rather than a check. It is `not-applicable`,
         * and it neither confirms nor contradicts the requirement.
         */
        const isConnectorTest =
          file.startsWith("tests/connectors/") && file.endsWith(".test.ts");
        const isBrowserSpec = file.endsWith(".spec.ts");
        const result: Check["result"] = isConnectorTest
          ? !suite || suite.failed > 0 || suite.passed === 0
            ? "fail"
            : "pass"
          : isBrowserSpec
            ? "blocked"
            : suite
              ? "pass"
              : "not-applicable";
        const reason = isConnectorTest
          ? suite
            ? undefined
            : "test file not found in the recorded connector run"
          : isBrowserSpec
            ? "Playwright specification; run by npm run test:e2e, which binds fixed ports and is not started here"
            : suite
              ? undefined
              : "supporting material (fixture, double or harness), not an executable check";
        return {
          testId: file,
          command: isBrowserSpec
            ? `npx playwright test ${file}`
            : `node --import tsx --test ${file}`,
          result,
          evidenceLevel: item.evidenceLevel,
          artifact: "artifacts/connectors/junit.xml",
          ...(reason ? { reason } : {}),
        };
      });
      const liveBlocked = item.limitations.find((text) =>
        /\blive\b|\bblocked\b|credential|account/i.test(text),
      );
      if (item.evidenceLevel !== "live-authorized" && liveBlocked)
        checks.push({
          testId: `${id}:live-authorized`,
          command: "npm run verify:live",
          result: "blocked",
          evidenceLevel: "live-authorized",
          reason: liveBlocked,
        });
      if (item.status !== "implemented")
        unmet.push({
          id,
          swarm,
          reason: `${item.status}: ${item.notes || item.limitations.join("; ") || "see ledger"}`,
        });
      else if (checks.some((check) => check.result === "fail"))
        unmet.push({
          id,
          swarm,
          reason: `a recorded test check failed: ${checks
            .filter((check) => check.result === "fail")
            .map((check) => check.testId)
            .join(", ")}`,
        });
      // A requirement whose only evidence is blocked is not confirmed here,
      // and saying so is the point of this report. It is listed separately
      // from a failure, because the two ask different things of a reader: one
      // is a defect, the other is a run that has not happened.
      else if (
        checks.length > 0 &&
        checks.every((check) => check.result !== "pass") &&
        checks.some((check) => check.result === "blocked")
      )
        unmet.push({
          id,
          swarm,
          reason:
            "every recorded check is blocked in this environment; no passing check confirms it here",
        });
      requirements.push({
        id,
        swarm,
        implementationStatus: item.status,
        files: item.files,
        sourceProfileIds: item.sourceProfileIds,
        acceptanceIds: item.acceptanceIds,
        checks,
        limitations: item.limitations,
      });
    }
  const head = git(["rev-parse", "HEAD"]);
  const treeDigest = workingTreeDigest();
  return {
    reportVersion: 1,
    generatedAt: new Date().toISOString(),
    git: {
      baseCommit: "d741eed0de296950def366d0a92fa63b77070abc",
      testedCommit: treeDigest ? `${head}+dirty` : head,
      workingTreeDigest: treeDigest,
      lockfileDigest: createHash("sha256")
        .update(readFileSync(join(root, "package-lock.json")))
        .digest("hex"),
    },
    environment: input.environment,
    suiteCommand: input.suiteCommand,
    suites: input.suites,
    ledgerProblems: input.problems,
    requirements,
    securityFindings: input.ledgers.flatMap(
      (ledger) => ledger.securityFindings,
    ),
    unmetRequirements: unmet,
    unsupportedNativeFeatures: input.ledgers.flatMap((ledger) =>
      ledger.workItems.flatMap((item) =>
        item.limitations.map((limitation) => ({ id: item.id, limitation })),
      ),
    ),
    externalEffectsPerformed: input.ledgers.flatMap(
      (ledger) => ledger.externalEffectsPerformed,
    ),
    contractChanges: input.ledgers.flatMap((ledger) =>
      ledger.contractChanges.map((change) => ({ swarm: ledger.swarm, change })),
    ),
    integrationPatches: input.ledgers.flatMap((ledger) =>
      ledger.integrationPatches.map((patch) => ({
        swarm: ledger.swarm,
        patch,
      })),
    ),
    dependenciesProposed: input.ledgers.flatMap((ledger) =>
      ledger.dependenciesProposed.map((dependency) => ({
        swarm: ledger.swarm,
        dependency,
      })),
    ),
    sourceLock:
      "docs/implementation-evidence/connector-interoperability/source-lock.json",
  };
}

export function summarize(report: ReturnType<typeof buildReport>): string {
  const total = report.requirements.length;
  const implemented = report.requirements.filter(
    (item) => item.implementationStatus === "implemented",
  ).length;
  const partial = report.requirements.filter(
    (item) => item.implementationStatus === "partial",
  ).length;
  const passedFiles = report.suites.filter(
    (suite) => suite.failed === 0 && suite.passed > 0,
  ).length;
  const lines = [
    "# Connector interoperability: evidence summary",
    "",
    "Generated by `npm run evidence:connectors` from the swarm ledgers and one JUnit-recorded run of every test under `tests/connectors/`. Counts only; no diagnostics are retained.",
    "",
    `- Tested commit: \`${report.git.testedCommit}\`${report.git.workingTreeDigest ? ` (working tree digest \`${report.git.workingTreeDigest.slice(0, 16)}…\`)` : ""}`,
    `- Base commit: \`${report.git.baseCommit}\``,
    `- Lockfile digest: \`${report.git.lockfileDigest.slice(0, 16)}…\``,
    `- Environment: ${JSON.stringify(report.environment)}`,
    `- Required work items: ${total}; implemented ${implemented}; partial ${partial}; unmet ${total - implemented - partial}`,
    `- Connector test files recorded: ${report.suites.length}; passing files ${passedFiles}; total passed ${report.suites.reduce((sum, suite) => sum + suite.passed, 0)}, failed ${report.suites.reduce((sum, suite) => sum + suite.failed, 0)}, skipped ${report.suites.reduce((sum, suite) => sum + suite.skipped, 0)}`,
    `- Ledger problems: ${report.ledgerProblems.length}`,
    "",
    "## Unmet or partial requirements",
    "",
    ...(report.unmetRequirements.length
      ? report.unmetRequirements.map(
          (item) => `- ${item.id} (${item.swarm}): ${item.reason}`,
        )
      : ["- none"]),
    "",
    "## Requirements",
    "",
    "| Item | Swarm | Status | Evidence | Tests (pass/fail) | Acceptance |",
    "| --- | --- | --- | --- | --- | --- |",
    ...report.requirements.map((item) => {
      const checks = item.checks.filter((check) => check.result !== "blocked");
      const pass = checks.filter((check) => check.result === "pass").length;
      const fail = checks.filter((check) => check.result === "fail").length;
      const level = item.checks[0]?.evidenceLevel ?? "not-tested";
      return `| ${item.id} | ${item.swarm} | ${item.implementationStatus} | ${level} | ${pass}/${fail} | ${item.acceptanceIds.join(", ")} |`;
    }),
    "",
    "## External effects performed",
    "",
    ...(report.externalEffectsPerformed.length
      ? report.externalEffectsPerformed.map((effect) => `- ${effect}`)
      : ["- none"]),
    "",
  ];
  return lines.join("\n");
}

async function environmentSummary(): Promise<Record<string, unknown>> {
  let database = "unavailable";
  try {
    const { postgresFixture } = await import("../tests/fixtures/postgres.js");
    const fixture = await postgresFixture();
    try {
      const { Pool } = await import("pg");
      const pool = new Pool(fixture.config);
      const row = await pool.query("select version()");
      database = String(row.rows[0]?.version ?? "").split(" on ")[0] ?? "";
      await pool.end();
    } finally {
      await fixture.close();
    }
  } catch {
    database = "unavailable";
  }
  return {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    database,
    browsers: [],
    nativeWebMcpAvailable: false,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const files = discoverConnectorTests();
  const skipTests = process.argv.includes("--no-tests");
  const run = skipTests
    ? { command: "skipped (--no-tests)", exitCode: null, suites: [] }
    : await runConnectorSuites(files);
  const { ledgers, problems } = loadLedgers();
  const report = buildReport({
    ledgers,
    problems,
    suites: run.suites,
    suiteCommand: run.command,
    environment: await environmentSummary(),
  });
  mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(
    join(evidenceDirectory, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  writeFileSync(join(evidenceDirectory, "README.md"), summarize(report));
  /*
   * Format what was just generated. `format:check` covers `docs`, so a
   * generated file that prettier disagrees with fails the repository's own
   * gate the moment anyone regenerates it -- and the disagreement is entirely
   * cosmetic (prettier pads markdown table columns). Reimplementing that
   * padding here would be a second, drifting copy of prettier's rules, and
   * exempting the files in `.prettierignore` would leave a gate that passes
   * only because it stopped looking. Formatting the output is the version
   * with no lie in it.
   *
   * Best effort: a missing prettier is a developer-environment problem, not a
   * reason to fail an evidence run that has already produced its report.
   */
  try {
    execFileSync(
      "npx",
      [
        "prettier",
        "--write",
        "--log-level",
        "warn",
        join(evidenceDirectory, "report.json"),
        join(evidenceDirectory, "README.md"),
      ],
      { cwd: root, stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch {
    console.warn(
      "Generated evidence was written but could not be formatted; run npm run format.",
    );
  }
  console.log(
    `Connector evidence: ${report.requirements.length} requirements, ${report.unmetRequirements.length} unmet/partial, ${run.suites.length} suites (exit ${run.exitCode}).`,
  );
  if (run.exitCode !== 0 && !skipTests) process.exitCode = 1;
}

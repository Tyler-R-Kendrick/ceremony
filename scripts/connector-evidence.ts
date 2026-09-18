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
import { z } from "zod";

/*
 * Joins the swarm ledgers with actual test results into one machine-readable
 * evidence report. Every required work item in the charter is listed whether
 * or not a ledger mentions it: an item nobody delivered is reported unmet, not
 * omitted. Test results come from the Node test runner's JUnit output over the
 * connector suites, never from a ledger's own claim. Nothing here retains raw
 * diagnostics, provider bodies or secrets: only file names, counts and codes.
 */

export const ledgerSchema = z.strictObject({
  swarm: z.string().regex(/^[A-Z][A-Z0-9-]{1,40}$/),
  workItems: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[A-Z]{2,6}-\d{2}$/),
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
        limitations: z.array(z.string().max(500)).max(64).default([]),
        notes: z.string().max(2000).default(""),
      }),
    )
    .max(64),
  contractChanges: z.array(z.unknown()).max(64).default([]),
  integrationPatches: z.array(z.unknown()).max(64).default([]),
  dependenciesProposed: z.array(z.unknown()).max(32).default([]),
  unmet: z.array(z.unknown()).max(64).default([]),
  externalEffectsPerformed: z.array(z.string().max(500)).max(64).default([]),
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
 * Minimal JUnit reader for Node's reporter output. Suites are named by file;
 * only counts are kept, so failure messages (which could quote payloads)
 * never enter the report.
 */
export function parseJunit(xml: string): SuiteResult[] {
  const suites: SuiteResult[] = [];
  const suitePattern =
    /<testsuite\b([^>]*)>([\s\S]*?)<\/testsuite>|<testsuite\b([^>]*)\/>/g;
  for (const match of xml.matchAll(suitePattern)) {
    const attributes = match[1] ?? match[3] ?? "";
    const body = match[2] ?? "";
    const name = /\bname="([^"]*)"/.exec(attributes)?.[1] ?? "";
    const file = name
      .replace(/&#x2F;|&#47;/g, "/")
      .replace(/^.*?(tests\/)/, "$1");
    if (!file.startsWith("tests/")) continue;
    const cases = [
      ...body.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g),
    ];
    let passed = 0,
      failed = 0,
      skipped = 0;
    for (const item of cases) {
      const inner = item[3] ?? "";
      if (/<skipped\b/.test(inner)) skipped++;
      else if (/<failure\b|<error\b/.test(inner)) failed++;
      else passed++;
    }
    const existing = suites.find((suite) => suite.file === file);
    if (existing) {
      existing.passed += passed;
      existing.failed += failed;
      existing.skipped += skipped;
    } else suites.push({ file, passed, failed, skipped });
  }
  return suites;
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

/** Runs the connector suites once with the JUnit reporter; counts only are retained. */
export function runConnectorSuites(files: string[]): {
  command: string;
  exitCode: number | null;
  suites: SuiteResult[];
} {
  const artifacts = join(root, "artifacts/connectors");
  mkdirSync(artifacts, { recursive: true });
  const destination = join(artifacts, "junit.xml");
  const args = [
    "--no-experimental-webstorage",
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=4",
    "--test-reporter=junit",
    `--test-reporter-destination=${destination}`,
    ...files,
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=8192" },
  });
  let suites: SuiteResult[] = [];
  try {
    suites = parseJunit(readFileSync(destination, "utf8"));
  } catch {
    suites = [];
  }
  return {
    command: `node --import tsx --test --test-reporter=junit ${files.length} connector test files`,
    exitCode: result.status,
    suites,
  };
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
        const result: Check["result"] = !suite
          ? "fail"
          : suite.failed > 0 || suite.passed === 0
            ? "fail"
            : "pass";
        return {
          testId: file,
          command: `node --import tsx --test ${file}`,
          result,
          evidenceLevel: item.evidenceLevel,
          artifact: "artifacts/connectors/junit.xml",
          ...(suite
            ? {}
            : { reason: "test file not found in the recorded connector run" }),
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
        unmet.push({ id, swarm, reason: "a recorded test check failed" });
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
    : runConnectorSuites(files);
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
  console.log(
    `Connector evidence: ${report.requirements.length} requirements, ${report.unmetRequirements.length} unmet/partial, ${run.suites.length} suites (exit ${run.exitCode}).`,
  );
  if (run.exitCode !== 0 && !skipTests) process.exitCode = 1;
}

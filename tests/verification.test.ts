import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptanceIds,
  liveIds,
  deriveVerification,
  verificationConfigurationDigest,
  verificationExecutionSchema,
  verificationResultSchema,
  type VerificationConfiguration,
  type VerificationExecution,
} from "../src/server/verification.js";

const configuration: VerificationConfiguration = {
  profile: "production",
  origin: "https://ceremony.example",
  environment: "production",
  configurationVersion: "v1",
  identityIssuer: "https://identity.example",
  keyId: "key-v1",
  model: "fixture-model",
  modelRoute: "compatible",
  capabilities: {
    nativeWebMCP: true,
    remoteBrowser: true,
    inAppAgent: true,
    installedPwa: true,
  },
};
const commit = "a".repeat(40);
const checkedAt = "2026-09-09T12:00:00.000Z";
const base = {
  commit,
  checkedAt,
  configuration,
  dependencyVersions: { node: "test" },
};
function execution(
  cases: string[],
  environment: VerificationExecution["environment"] = "local-integration",
): VerificationExecution {
  return {
    schemaVersion: 1,
    commit,
    configurationDigest: verificationConfigurationDigest(configuration),
    checkedAt,
    command: "npm run verify",
    exitCode: 0,
    attempt: 1,
    environment,
    runtime: "node-test",
    browsers: { chromium: "fixture-version" },
    interfaces: [],
    tests: { passed: 1, failed: 0, skipped: 0 },
    cases,
    evidencePaths: ["artifacts/test.json"],
  };
}
const all = () => [
  {
    ...execution(acceptanceIds, "local-e2e"),
    browsers: {
      chromium: "fixture-version",
      firefox: "fixture-version",
      webkit: "fixture-version",
    },
    interfaces: [
      "postgresql",
      "workflow-local",
      "native-webmcp",
    ] as VerificationExecution["interfaces"],
  },
  ...liveIds.map((id) =>
    execution(
      [id],
      id === "LIVE-03"
        ? "deployed"
        : id === "LIVE-04"
          ? "real-device"
          : "live-provider",
    ),
  ),
];

test("OPS-05: absent local evidence fails; unavailable real credentials never become passing skips", () => {
  const result = deriveVerification({ ...base, executions: [] });
  assert.equal(result.counts.failed, 48);
  assert.equal(result.counts.blocked, 5);
  assert.equal(result.releaseVerdict, "FAIL");
  const localOnly = deriveVerification({
    ...base,
    executions: [all()[0]!],
  });
  assert.equal(localOnly.releaseVerdict, "BLOCKED_EXTERNAL");
  assert.equal(localOnly.counts.passed, 48);
  assert.equal(localOnly.counts.blocked, 5);
});
test("SEC: unit-only claims cannot certify browser, PostgreSQL, Workflow or native interfaces", () => {
  for (const tests of [
    { passed: 0, failed: 0, skipped: 0 },
    { passed: 1, failed: 1, skipped: 0 },
    { passed: 1, failed: 0, skipped: 1 },
  ]) {
    const executions = all();
    executions[0]!.tests = tests;
    assert.equal(
      deriveVerification({ ...base, executions }).releaseVerdict,
      "FAIL",
    );
  }
  const { tests: _omitted, ...missingCounts } = execution(["AC-01"]);
  assert.equal(
    verificationExecutionSchema.safeParse(missingCounts).success,
    false,
  );
  const result = deriveVerification({
    ...base,
    executions: [execution(acceptanceIds, "unit")],
  });
  for (const id of ["AC-01", "AC-27", "AC-28", "AC-34", "AC-39", "AC-40"]) {
    assert.equal(
      result.cases.find((item) => item.id === id)!.reasonCode,
      "missing-required-boundary",
    );
  }
  const chromiumOnly = all();
  chromiumOnly[0]!.browsers = { chromium: "fixture-version" };
  assert.equal(
    deriveVerification({ ...base, executions: chromiumOnly }).cases.find(
      (item) => item.id === "AC-39",
    )!.status,
    "FAIL",
  );
  const splitEngines = all();
  splitEngines[0]!.browsers = { chromium: "fixture-version" };
  splitEngines.push({
    ...execution(["AC-39"], "local-e2e"),
    browsers: { firefox: "fixture-version", webkit: "fixture-version" },
  });
  assert.equal(
    deriveVerification({ ...base, executions: splitEngines }).releaseVerdict,
    "PASS",
  );
  for (const id of ["AC-00", "AC-49", "LIVE-06"])
    assert.equal(
      verificationExecutionSchema.safeParse({ ...execution([id]) }).success,
      false,
    );
});
test("OPS-05: exact commit/config, explicit profile and actual outcomes determine release", () => {
  const report = deriveVerification({ ...base, executions: all() });
  assert.equal(report.releaseVerdict, "PASS");
  assert.equal(report.counts.passed, 53);
  const failed = all();
  failed.push({ ...execution(["AC-01"]), exitCode: 1, attempt: 2 });
  assert.equal(
    deriveVerification({ ...base, executions: failed }).releaseVerdict,
    "FAIL",
  );
  for (const alteration of [
    { commit: "b".repeat(40) },
    { configurationDigest: "c".repeat(64) },
    { checkedAt: "2026-01-01T00:00:00.000Z" },
    { checkedAt: "2027-01-01T00:00:00.000Z" },
  ]) {
    const executions = all();
    executions[0] = { ...executions[0]!, ...alteration };
    assert.equal(
      deriveVerification({ ...base, executions }).cases[0]!.reasonCode,
      "stale-evidence",
    );
  }
  const wrong = all();
  wrong[1] = { ...wrong[1]!, environment: "local-integration" };
  assert.equal(
    deriveVerification({ ...base, executions: wrong }).cases.find(
      (item) => item.id === "LIVE-01",
    )!.status,
    "FAIL",
  );
  assert.throws(
    () => deriveVerification({ ...base, executions: [], maxAgeMs: 0 }),
    /lifetime/,
  );
});
test("OPS-05: strict evidence rejects extra success flags, paths, duplicates and missing proof", () => {
  assert.equal(
    verificationExecutionSchema.safeParse({
      ...execution(["AC-01"]),
      success: true,
    }).success,
    false,
  );
  assert.equal(
    verificationExecutionSchema.safeParse({
      ...execution(["AC-01"]),
      cases: ["AC-01", "AC-01"],
    }).success,
    false,
  );
  assert.equal(
    verificationExecutionSchema.safeParse({
      ...execution(["AC-01"]),
      evidencePaths: ["../../secret"],
    }).success,
    false,
  );
  const empty = execution(["AC-01"]);
  empty.evidencePaths = [];
  assert.equal(
    deriveVerification({ ...base, executions: [empty] }).cases[0]!.status,
    "FAIL",
  );
  assert.equal(
    verificationResultSchema.safeParse({
      ...deriveVerification({ ...base, executions: [] }),
      forcePass: true,
    }).success,
    false,
  );
});
test("OPS-02/05: disabled capabilities are explicit; invalid production configuration cannot release", () => {
  const config = {
    ...configuration,
    capabilities: {
      nativeWebMCP: false,
      remoteBrowser: false,
      inAppAgent: false,
      installedPwa: false,
    },
  };
  const report = deriveVerification({
    ...base,
    configuration: config,
    executions: [],
  });
  for (const id of ["AC-40", "LIVE-02", "LIVE-04", "LIVE-05"])
    assert.equal(
      report.cases.find((item) => item.id === id)!.reasonCode,
      "capability-disabled",
    );
  const local = deriveVerification({
    ...base,
    configuration: { ...configuration, profile: "local" },
    executions: [],
  });
  assert.equal(
    local.cases.find((item) => item.id === "LIVE-01")!.status,
    "NOT_REQUESTED",
  );
  const invalid = deriveVerification({
    ...base,
    configuration: { ...configuration, origin: "unconfigured" },
    executions: [],
  });
  assert.equal(
    invalid.cases.find((item) => item.id === "AC-19")!.reasonCode,
    "invalid-configuration",
  );
  assert.equal(
    verificationConfigurationDigest({
      ...configuration,
      capabilities: {
        installedPwa: true,
        inAppAgent: true,
        remoteBrowser: true,
        nativeWebMCP: true,
      },
    }),
    verificationConfigurationDigest(configuration),
  );
  assert.notEqual(
    verificationConfigurationDigest({
      ...configuration,
      configurationVersion: "v2",
    }),
    verificationConfigurationDigest(configuration),
  );
});

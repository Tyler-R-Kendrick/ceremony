import { createHash } from "node:crypto";
import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);
const caseId = z
  .string()
  .regex(/^(AC-\d{2}|LIVE-\d{2}|SMOKE-GITHUB-READONLY)$/);
const environment = z.enum([
  "unit",
  "local-integration",
  "local-e2e",
  "deployed",
  "live-provider",
  "real-device",
]);
const command = z
  .string()
  .max(256)
  .regex(/^[A-Za-z0-9_./:@ -]+$/);
const evidencePath = z
  .string()
  .max(256)
  .regex(/^(?!\/)(?!.*\.\.)[A-Za-z0-9_./-]+$/);
export const verificationExecutionSchema = z
  .object({
    schemaVersion: z.literal(1),
    commit,
    configurationDigest: digest,
    checkedAt: z.iso.datetime(),
    command,
    exitCode: z.number().int().min(0).max(255),
    attempt: z.number().int().positive(),
    environment,
    runtime: z.string().min(1).max(100),
    browsers: z.record(
      z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
      z.string().max(100),
    ),
    cases: z
      .array(caseId)
      .max(60)
      .refine((ids) => new Set(ids).size === ids.length),
    evidencePaths: z.array(evidencePath).max(20),
  })
  .strict();
export type VerificationExecution = z.infer<typeof verificationExecutionSchema>;
export const verificationConfigurationSchema = z
  .object({
    profile: z.enum(["local", "production"]),
    origin: z.string().max(200),
    environment: z.string().max(100),
    configurationVersion: z.string().max(100),
    identityIssuer: z.string().max(200),
    keyId: z.string().max(64),
    model: z.string().max(200),
    modelRoute: z.enum(["disabled", "compatible", "gateway"]),
    capabilities: z
      .object({
        nativeWebMCP: z.boolean(),
        remoteBrowser: z.boolean(),
        inAppAgent: z.boolean(),
        installedPwa: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type VerificationConfiguration = z.infer<
  typeof verificationConfigurationSchema
>;
export const verificationResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    commit,
    checkedAt: z.iso.datetime(),
    profile: z.enum(["local", "production"]),
    configurationDigest: digest,
    dependencyVersions: z.record(z.string().max(100), z.string().max(100)),
    capabilities: z.record(
      z.string().max(100),
      z.object({ enabled: z.boolean(), certified: z.boolean() }).strict(),
    ),
    cases: z
      .array(
        z
          .object({
            id: caseId,
            status: z.enum([
              "PASS",
              "FAIL",
              "BLOCKED_EXTERNAL",
              "NOT_REQUESTED",
            ]),
            command,
            environment,
            evidencePaths: z.array(evidencePath).max(100),
            reasonCode: z
              .enum([
                "missing-local-evidence",
                "missing-external-evidence",
                "stale-evidence",
                "command-failed",
                "capability-disabled",
                "external-not-requested",
                "invalid-configuration",
              ])
              .optional(),
          })
          .strict(),
      )
      .max(60),
    counts: z
      .object({
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        blocked: z.number().int().nonnegative(),
        notRequested: z.number().int().nonnegative(),
      })
      .strict(),
    releaseVerdict: z.enum(["PASS", "FAIL", "BLOCKED_EXTERNAL"]),
  })
  .strict();
export type VerificationResult = z.infer<typeof verificationResultSchema>;
export function verificationConfigurationDigest(
  input: VerificationConfiguration,
): string {
  // Explicit field construction prevents secret-bearing extra configuration from entering fingerprints.
  const config = verificationConfigurationSchema.parse(input);
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}
export const acceptanceIds = Array.from(
  { length: 48 },
  (_, index) => `AC-${String(index + 1).padStart(2, "0")}`,
);
export const liveIds = ["LIVE-01", "LIVE-02", "LIVE-03", "LIVE-04", "LIVE-05"];
/** Results are derived from executed outcomes. Earlier failed attempts remain failures, not hidden retries. */
export function deriveVerification(input: {
  commit: string;
  checkedAt: string;
  configuration: VerificationConfiguration;
  dependencyVersions: Record<string, string>;
  executions: unknown[];
  maxAgeMs?: number;
}): VerificationResult {
  commit.parse(input.commit);
  z.iso.datetime().parse(input.checkedAt);
  const config = verificationConfigurationSchema.parse(input.configuration);
  const fingerprint = verificationConfigurationDigest(config);
  const executions = input.executions.map((value) =>
    verificationExecutionSchema.parse(value),
  );
  const age = input.maxAgeMs ?? 7 * 86400000;
  if (!Number.isSafeInteger(age) || age < 1 || age > 30 * 86400000)
    throw new Error("Invalid evidence lifetime");
  const cases: VerificationResult["cases"] = [...acceptanceIds, ...liveIds].map(
    (id) => {
      const external = id.startsWith("LIVE-");
      const base = {
        id,
        command: external ? "npm run verify:live" : "npm run verify",
        environment: (id === "LIVE-04"
          ? "real-device"
          : id === "LIVE-03"
            ? "deployed"
            : external
              ? "live-provider"
              : "local-integration") as VerificationResult["cases"][number]["environment"],
        evidencePaths: [] as string[],
      };
      if (
        (id === "AC-40" && !config.capabilities.nativeWebMCP) ||
        (id === "LIVE-02" && !config.capabilities.inAppAgent) ||
        (id === "LIVE-04" && !config.capabilities.installedPwa) ||
        (id === "LIVE-05" && !config.capabilities.remoteBrowser)
      )
        return {
          ...base,
          status: "NOT_REQUESTED",
          reasonCode: "capability-disabled",
        };
      if (id === "AC-19" && config.profile === "production") {
        const exactHttps = (value: string, originOnly = true) => {
          try {
            const url = new URL(value);
            return (
              url.protocol === "https:" &&
              !url.username &&
              !url.password &&
              !url.search &&
              !url.hash &&
              (!originOnly || url.origin === value)
            );
          } catch {
            return false;
          }
        };
        if (
          !exactHttps(config.origin) ||
          !exactHttps(config.identityIssuer, false) ||
          [config.keyId, config.configurationVersion].some(
            (value) => !value || value === "unconfigured",
          )
        )
          return {
            ...base,
            status: "FAIL",
            reasonCode: "invalid-configuration",
          };
      }
      if (external && config.profile === "local")
        return {
          ...base,
          status: "NOT_REQUESTED",
          reasonCode: "external-not-requested",
        };
      const relevant = executions.filter((result) => result.cases.includes(id));
      if (!relevant.length)
        return {
          ...base,
          status: external ? "BLOCKED_EXTERNAL" : "FAIL",
          reasonCode: external
            ? "missing-external-evidence"
            : "missing-local-evidence",
        };
      const current = relevant.filter(
        (result) =>
          result.commit === input.commit &&
          result.configurationDigest === fingerprint &&
          Date.parse(input.checkedAt) - Date.parse(result.checkedAt) >= 0 &&
          Date.parse(input.checkedAt) - Date.parse(result.checkedAt) <= age,
      );
      if (current.length !== relevant.length)
        return { ...base, status: "FAIL", reasonCode: "stale-evidence" };
      if (current.some((result) => result.exitCode !== 0))
        return { ...base, status: "FAIL", reasonCode: "command-failed" };
      if (current.some((result) => !result.evidencePaths.length))
        return {
          ...base,
          status: "FAIL",
          reasonCode: "missing-local-evidence",
        };
      if (
        external &&
        current.some((result) => result.environment !== base.environment)
      )
        return {
          ...base,
          status: "FAIL",
          reasonCode: "missing-external-evidence",
        };
      return {
        ...base,
        status: "PASS",
        command: current[0]!.command,
        environment: current[0]!.environment,
        evidencePaths: [
          ...new Set(current.flatMap((result) => result.evidencePaths)),
        ],
      };
    },
  );
  const counts = {
    passed: cases.filter((c) => c.status === "PASS").length,
    failed: cases.filter((c) => c.status === "FAIL").length,
    blocked: cases.filter((c) => c.status === "BLOCKED_EXTERNAL").length,
    notRequested: cases.filter((c) => c.status === "NOT_REQUESTED").length,
  };
  const passed = (id: string) =>
    cases.some((c) => c.id === id && c.status === "PASS");
  return verificationResultSchema.parse({
    schemaVersion: 1,
    commit: input.commit,
    checkedAt: input.checkedAt,
    profile: config.profile,
    configurationDigest: fingerprint,
    dependencyVersions: input.dependencyVersions,
    capabilities: {
      nativeWebMCP: {
        enabled: config.capabilities.nativeWebMCP,
        certified: passed("AC-40"),
      },
      remoteBrowser: {
        enabled: config.capabilities.remoteBrowser,
        certified: passed("LIVE-05"),
      },
      inAppAgent: {
        enabled: config.capabilities.inAppAgent,
        certified: passed("LIVE-02") && passed("LIVE-03"),
      },
      installedPwa: {
        enabled: config.capabilities.installedPwa,
        certified: passed("LIVE-04"),
      },
    },
    cases,
    counts,
    releaseVerdict: counts.failed
      ? "FAIL"
      : counts.blocked
        ? "BLOCKED_EXTERNAL"
        : "PASS",
  });
}

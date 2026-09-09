import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, realpath, stat } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import { createAppAuth } from "@octokit/auth-app";
import { request } from "@octokit/request";
import { z } from "zod";
import {
  deriveVerification,
  verificationConfigurationDigest,
  verificationConfigurationSchema,
  verificationExecutionSchema,
  type VerificationExecution,
} from "../src/server/verification.js";

const mode = process.argv[2] ?? "release";
if (!["audit", "release", "live"].includes(mode))
  throw new Error("Unknown verification mode");
const root = resolve(process.env.CEREMONY_EVIDENCE_CHECKOUT ?? process.cwd());
const output = resolve(
  process.cwd(),
  "docs/implementation-evidence/ceremony-teaching",
);
try {
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const dirty = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=no"],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
  if (mode !== "audit" && dirty) throw new Error("Dirty verification checkout");
  const profilePath = resolve(
    process.env.CEREMONY_RELEASE_PROFILE ??
      "docs/implementation-evidence/ceremony-teaching/profile.json",
  );
  const config = verificationConfigurationSchema.parse(
    JSON.parse(await readFile(profilePath, "utf8")),
  );
  if (mode !== "audit" && config.profile !== "production")
    throw new Error(
      "Release verification requires an explicit production profile",
    );
  const configurationDigest = verificationConfigurationDigest(config);
  const lock = JSON.parse(
    await readFile(resolve(root, "package-lock.json"), "utf8"),
  );
  const dependencyVersions: Record<string, string> = {};
  for (const name of [
    "ai",
    "workflow",
    "pg",
    "oauth4webapi",
    "jose",
    "@playwright/test",
    "nitro",
    "zod",
  ]) {
    const version = lock.packages?.[`node_modules/${name}`]?.version;
    if (typeof version !== "string")
      throw new Error("Missing locked verification dependency");
    dependencyVersions[name] = version;
  }
  const executions: VerificationExecution[] = [];
  if (process.env.CEREMONY_VERIFICATION_RESULTS) {
    if (
      (await stat(process.env.CEREMONY_VERIFICATION_RESULTS)).size >
      2 * 1024 * 1024
    )
      throw new Error("Verification input exceeds size limit");
    const source = JSON.parse(
      await readFile(process.env.CEREMONY_VERIFICATION_RESULTS, "utf8"),
    );
    if (!Array.isArray(source) || source.length > 500)
      throw new Error("Invalid verification results");
    for (const item of source) {
      const result = verificationExecutionSchema.parse(item);
      for (const path of result.evidencePaths) {
        const target = await realpath(resolve(root, path));
        const owned = relative(root, target);
        const metadata = await stat(target);
        if (
          owned.startsWith(`..${sep}`) ||
          owned === ".." ||
          !owned ||
          !metadata.isFile() ||
          metadata.size === 0
        )
          throw new Error("Invalid verification artifact");
      }
      if (
        result.exitCode === 0 &&
        result.cases.length &&
        !result.evidencePaths.length
      )
        throw new Error("Missing executed evidence");
      executions.push(result);
    }
  }
  if (mode === "live") {
    // Read-only smoke is supplementary: it cannot certify manifest creation or attended browser consent.
    const id = process.env.CEREMONY_LIVE_GITHUB_APP_ID;
    const key = process.env.CEREMONY_LIVE_GITHUB_PRIVATE_KEY;
    const enabled = process.env.CEREMONY_LIVE_AUTHORIZED === "true";
    let status: "PASS" | "FAIL" | "BLOCKED_EXTERNAL" = "BLOCKED_EXTERNAL";
    if (enabled && id && key) {
      try {
        const appId = z
          .string()
          .regex(/^[1-9][0-9]{0,15}$/)
          .parse(id);
        const token = (
          await createAppAuth({ appId, privateKey: key })({ type: "app" })
        ).token;
        const response = await request("GET https://api.github.com/app", {
          headers: {
            authorization: `Bearer ${token}`,
            "x-github-api-version": "2022-11-28",
          },
          request: { redirect: "error", signal: AbortSignal.timeout(15000) },
        });
        const app = z
          .object({ id: z.number().int().positive() })
          .parse(response.data);
        status = String(app.id) === appId ? "PASS" : "FAIL";
      } catch {
        status = "FAIL";
      }
    }
    await mkdir(output, { recursive: true });
    await writeFile(
      resolve(output, "github-readonly-smoke.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          commit,
          configurationDigest,
          checkedAt: new Date().toISOString(),
          id: "SMOKE-GITHUB-READONLY",
          status,
          command: "npm run verify:live",
          environment: "live-provider",
          runtime: process.version,
          reasonCode:
            status === "BLOCKED_EXTERNAL"
              ? "authorized-readonly-configuration-required"
              : status === "FAIL"
                ? "provider-verification-failed"
                : "readonly-smoke-not-full-certification",
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
  }
  const report = deriveVerification({
    commit,
    checkedAt: new Date().toISOString(),
    configuration: config,
    dependencyVersions,
    executions,
  });
  await mkdir(output, { recursive: true });
  await writeFile(
    resolve(output, "verification.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      profile: report.profile,
      commit,
      counts: report.counts,
      releaseVerdict: report.releaseVerdict,
    }),
  );
  // Live invocation itself is never a successful skip; full required live cases must have current attended evidence.
  const requested =
    mode === "live"
      ? report.cases.filter(
          (item) =>
            item.id.startsWith("LIVE-") &&
            item.reasonCode !== "capability-disabled",
        )
      : report.cases;
  process.exitCode = requested.some(
    (item) =>
      item.status !== "PASS" &&
      item.reasonCode !== "capability-disabled" &&
      !(mode === "audit" && item.status === "NOT_REQUESTED"),
  )
    ? 1
    : 0;
} catch {
  console.error(
    "Verification failed: provide a valid checkout, explicit profile, and current sanitized execution evidence. No secrets were logged.",
  );
  process.exitCode = 1;
}

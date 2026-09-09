import { readFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";
import {
  verificationConfigurationSchema,
  verificationConfigurationDigest,
} from "../src/server/verification.js";

// Operator certification tooling, not an end-user dependency. No provider actions are automated.
async function main() {
  if (
    process.env.CEREMONY_LIVE_AUTHORIZED !== "true" ||
    process.env.CEREMONY_LIVE_ATTENDED !== "true" ||
    !process.env.CEREMONY_RELEASE_PROFILE
  )
    throw new Error("authorized-attended-profile-required");
  const config = verificationConfigurationSchema.parse(
    JSON.parse(await readFile(process.env.CEREMONY_RELEASE_PROFILE, "utf8")),
  );
  if (
    config.profile !== "production" ||
    !config.origin.startsWith("https://") ||
    new URL(config.origin).origin !== config.origin
  )
    throw new Error("production-exact-origin-required");
  if (
    execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  )
    throw new Error("clean-checkout-required");
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const browser = await chromium.launch({ headless: false });
  try {
    // Fresh isolated context. No persistence, tracing, HAR, console, video, screenshots, or request listeners.
    const context = await browser.newContext();
    const page = await context.newPage();
    console.log(
      "Complete sign-in and Connect GitHub in the opened browser. Provider login, MFA and consent remain yours. No provider action is automated.",
    );
    await page.goto(config.origin, { waitUntil: "domcontentloaded" });
    const complete = await page.waitForFunction(
      async (origin) => {
        if (location.origin !== origin) return false;
        const id = new URL(location.href).searchParams.get("teachingRun");
        if (!id || !/^[A-Za-z0-9_.:-]{1,120}$/.test(id)) return false;
        const response = await fetch(
          `/api/v1/teaching/runs/${encodeURIComponent(id)}`,
          { credentials: "same-origin", cache: "no-store" },
        );
        if (!response.ok) return false;
        const run = await response.json();
        return (
          run.provider === "github" &&
          run.profile === "github-app" &&
          run.status === "complete" &&
          Array.isArray(run.nodes) &&
          [
            "github.prepare-app",
            "github.authorize-installation",
            "github.verify-access",
          ].every((operation) =>
            run.nodes.some(
              (node: { operationId?: unknown; verified?: unknown }) =>
                node.operationId === operation && node.verified === true,
            ),
          )
        );
      },
      config.origin,
      { timeout: 600000, polling: 2000 },
    );
    if ((await complete.jsonValue()) !== true)
      throw new Error("verified-connection-required");
    if (
      execFileSync("git", ["status", "--porcelain"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() ||
      execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() !== commit
    )
      throw new Error("verification-checkout-changed");
    await mkdir("artifacts/live", { recursive: true });
    await writeFile(
      "artifacts/live/attended-connection.json",
      JSON.stringify(
        {
          schemaVersion: 1,
          commit,
          checkedAt: new Date().toISOString(),
          configurationDigest: verificationConfigurationDigest(config),
          runtime: process.version,
          browser: browser.version(),
          status: "PASS",
          scope: "attended-verified-connection-only",
          fullProviderCertification: false,
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    console.log(
      "Attended connection verified. Supplementary evidence only: registration freshness, recovery and deployed durability need their own required evidence.",
    );
  } finally {
    await browser.close();
  }
}
main().catch(() => {
  console.error(
    "Attended verification blocked or failed: explicit authorized production profile, clean checkout, supported graphical browser and human completion are required. No private diagnostics retained.",
  );
  process.exitCode = 1;
});

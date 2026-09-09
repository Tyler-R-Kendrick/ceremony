import { z } from "zod";
import {
  verificationConfigurationDigest,
  verificationConfigurationSchema,
} from "../src/server/verification.js";

export function profileFingerprint(value: unknown) {
  const configuration = verificationConfigurationSchema.parse(value);
  return {
    profile: configuration.profile,
    configurationDigest: verificationConfigurationDigest(configuration),
  };
}
type Browser = { version(): string; close(): Promise<void> };
/** Probe installed runtime binaries, never infer an unavailable version from package metadata. */
export async function browserVersions(
  launch: Record<"chromium" | "firefox" | "webkit", () => Promise<Browser>>,
) {
  const versions: Record<string, string> = {};
  for (const name of ["chromium", "firefox", "webkit"] as const) {
    const browser = await launch[name]();
    try {
      versions[name] = z
        .string()
        .min(1)
        .max(100)
        .regex(/^[A-Za-z0-9 ._-]+$/)
        .parse(browser.version());
    } finally {
      await browser.close();
    }
  }
  return versions;
}

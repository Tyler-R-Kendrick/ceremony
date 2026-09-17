import { z } from "zod";
import { admittedOrigin } from "./templates.js";

export const catalogProfileSchema = z.strictObject({
  id: z.string().min(3).max(64),
  provider: z.string().min(2).max(64),
  /** Executable profiles run only against the exact admitted fixture origin. */
  executable: z.boolean(),
  fixtureOrigin: z.string().url().optional(),
  /** Discovery-only public entries are never admitted for execution. */
  discoveryOnly: z.boolean(),
  entry: z.string().url(),
  steps: z
    .array(z.enum(["combined", "identifier", "password", "verification"]))
    .min(1)
    .max(4),
  maxSubmissions: z.number().int().min(1).max(3),
  evidence: z.string().min(3).max(200),
});
export type CatalogProfile = z.infer<typeof catalogProfileSchema>;

const ownedFixtureOrigin = "http://127.0.0.1";
export const browserLoginCatalog: readonly CatalogProfile[] = [
  {
    id: "owned-fixture-login",
    provider: "ceremony-fixture",
    executable: true,
    fixtureOrigin: ownedFixtureOrigin,
    discoveryOnly: false,
    entry: `${ownedFixtureOrigin}:0/login`,
    steps: ["combined", "identifier", "password", "verification"],
    maxSubmissions: 3,
    evidence:
      "Owned loopback fixture; covered by extension E2E and focused tests.",
  },
  {
    id: "github-login",
    provider: "GitHub",
    executable: false,
    discoveryOnly: true,
    entry: "https://github.com/login",
    steps: ["combined"],
    maxSubmissions: 1,
    evidence:
      "Public sign-in page reachable; no reviewed browser execution evidence.",
  },
  {
    id: "google-login",
    provider: "Google",
    executable: false,
    discoveryOnly: true,
    entry: "https://accounts.google.com/ServiceLogin",
    steps: ["identifier"],
    maxSubmissions: 1,
    evidence:
      "Public identifier page reachable; later steps and SSO unreviewed.",
  },
  {
    id: "microsoft-login",
    provider: "Microsoft",
    executable: false,
    discoveryOnly: true,
    entry: "https://login.microsoftonline.com/",
    steps: ["identifier"],
    maxSubmissions: 1,
    evidence: "Public landing page reachable; execution unreviewed.",
  },
] as const;

/** Executable admission is fixture-only; discovery entries can never execute. */
export function executableProfile(
  profileId: string,
): CatalogProfile | undefined {
  const profile = browserLoginCatalog.find((item) => item.id === profileId);
  if (
    !profile ||
    !profile.executable ||
    profile.discoveryOnly ||
    !profile.fixtureOrigin
  )
    return undefined;
  return profile;
}

/** Execution admits only the profile's own fixture origin, never live providers. */
export function admittedCatalogOrigin(
  profileId: string,
  value: string,
): string {
  const profile = executableProfile(profileId);
  if (!profile?.fixtureOrigin) throw new Error("Profile is not executable");
  const origin = admittedOrigin(value);
  if (new URL(origin).hostname !== new URL(profile.fixtureOrigin).hostname)
    throw new Error("Origin is outside the executable fixture profile");
  return origin;
}

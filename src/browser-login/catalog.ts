import { z } from "zod";

/** Canonical origins, not URL prefixes, host patterns, or implicitly trusted ports. */
export const catalogOriginSchema = z
  .string()
  .max(2000)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.origin === value &&
        !url.username &&
        !url.password &&
        !url.hostname.includes("*") &&
        url.port !== "0" &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" && url.hostname === "127.0.0.1"))
      );
    } catch {
      return false;
    }
  }, "Expected an exact canonical HTTPS or loopback origin");

const entrySchema = z
  .string()
  .max(2000)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.href === value &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        catalogOriginSchema.safeParse(url.origin).success
      );
    } catch {
      return false;
    }
  }, "Expected a canonical entry URL without credentials, query, or fragment");

export const catalogStepSchema = z.enum([
  "combined",
  "identifier",
  "password",
  "verification",
]);
export type CatalogStep = z.infer<typeof catalogStepSchema>;
export const catalogSequenceSchema = z
  .union([
    z.tuple([z.literal("combined"), z.literal("verification")]),
    z.tuple([
      z.literal("identifier"),
      z.literal("password"),
      z.literal("verification"),
    ]),
  ])
  .readonly();

export type CatalogSequence = z.infer<typeof catalogSequenceSchema>;

export const catalogVerificationSchema = z.union([
  // This declares a verifier contract, not evidence that a run succeeded.
  z
    .strictObject({
      strategy: z.literal("fixture-account"),
      path: z.literal("/account"),
    })
    .readonly(),
  z.strictObject({ strategy: z.literal("unvalidated") }).readonly(),
]);

export const catalogProfileSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z][a-z0-9-]{2,63}$/),
    provider: z.string().trim().min(2).max(64),
    executable: z.boolean(),
    discoveryOnly: z.boolean(),
    validation: z.enum(["fixture-only", "pending-validation"]),
    originBinding: z.enum(["run-start-loopback", "exact"]),
    fixtureOrigin: catalogOriginSchema.optional(),
    entry: entrySchema,
    declaredOrigins: z.array(catalogOriginSchema).min(1).max(8).readonly(),
    allowedFrameOrigins: z.array(catalogOriginSchema).max(8).readonly(),
    /** Alternatives, never concatenated. Discovery-only entries declare no runnable sequence. */
    sequences: z.array(catalogSequenceSchema).max(2).readonly(),
    /** Compatibility alias for the first alternative only. Use sequences for execution. */
    steps: z.array(catalogStepSchema).max(3).readonly(),
    /** Total credential submissions, not verification observations; no implicit retries. */
    maxSubmissions: z.number().int().min(0).max(2),
    verification: catalogVerificationSchema,
  })
  .superRefine((profile, ctx) => {
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    for (const key of ["declaredOrigins", "allowedFrameOrigins"] as const) {
      if (new Set(profile[key]).size !== profile[key].length)
        fail(key, "Origins must be unique");
    }
    let entryOrigin: string | undefined;
    try {
      entryOrigin = new URL(profile.entry).origin;
    } catch {
      /* entrySchema reports invalid URLs */
    }
    if (!entryOrigin || !profile.declaredOrigins.includes(entryOrigin))
      fail("entry", "Entry must belong to a declared exact origin");
    if (
      profile.allowedFrameOrigins.some(
        (origin) => !profile.declaredOrigins.includes(origin),
      )
    )
      fail("allowedFrameOrigins", "Frame origins must be explicitly declared");
    if (
      new Set(profile.sequences.map((sequence) => sequence.join(","))).size !==
      profile.sequences.length
    )
      fail("sequences", "Alternatives must be unique");
    if (
      JSON.stringify(profile.steps) !==
      JSON.stringify(profile.sequences[0] ?? [])
    )
      fail(
        "steps",
        "Steps must equal the first alternative (or be empty for discovery)",
      );
    if (profile.executable === profile.discoveryOnly)
      fail(
        "executable",
        "Exactly one of executable and discoveryOnly must be true",
      );
    if (profile.executable) {
      if (
        profile.validation !== "fixture-only" ||
        profile.originBinding !== "run-start-loopback"
      )
        fail("validation", "Execution is fixture-only with run-start binding");
      if (
        !profile.fixtureOrigin ||
        !catalogOriginSchema.safeParse(profile.fixtureOrigin).success ||
        !profile.fixtureOrigin.startsWith("http://127.0.0.1") ||
        new URL(profile.fixtureOrigin).hostname !== "127.0.0.1"
      )
        fail(
          "fixtureOrigin",
          "Execution requires the owned HTTP loopback fixture",
        );
      if (
        profile.declaredOrigins.length !== 1 ||
        profile.declaredOrigins[0] !== profile.fixtureOrigin
      )
        fail("declaredOrigins", "Fixture may declare only its exact origin");
      if (!profile.sequences.length)
        fail(
          "sequences",
          "Execution requires a complete credential and verification sequence",
        );
      const budget = Math.max(
        0,
        ...profile.sequences.map((sequence) => sequence.length - 1),
      );
      if (profile.maxSubmissions !== budget)
        fail(
          "maxSubmissions",
          "Budget must equal the longest alternative's submission count",
        );
      if (profile.verification.strategy !== "fixture-account")
        fail(
          "verification",
          "Executable fixture requires account verification",
        );
    } else {
      if (
        profile.validation !== "pending-validation" ||
        profile.originBinding !== "exact" ||
        profile.fixtureOrigin !== undefined
      )
        fail(
          "validation",
          "Discovery profiles require exact origins and pending validation",
        );
      if (
        profile.sequences.length ||
        profile.maxSubmissions !== 0 ||
        profile.allowedFrameOrigins.length
      )
        fail(
          "sequences",
          "Discovery profiles cannot authorize submissions or frames",
        );
      if (profile.verification.strategy !== "unvalidated")
        fail("verification", "Discovery verification must remain unvalidated");
    }
  })
  .readonly();
export type CatalogProfile = z.infer<typeof catalogProfileSchema>;

export const browserLoginCatalogSchema = z
  .array(catalogProfileSchema)
  .min(1)
  .refine(
    (profiles) =>
      new Set(profiles.map((profile) => profile.id)).size === profiles.length,
    "Profile IDs must be unique",
  )
  .readonly();

const ownedFixtureOrigin = "http://127.0.0.1";
export const browserLoginCatalog = browserLoginCatalogSchema.parse([
  {
    id: "owned-fixture-login",
    provider: "ceremony-fixture",
    executable: true,
    discoveryOnly: false,
    validation: "fixture-only",
    originBinding: "run-start-loopback",
    fixtureOrigin: ownedFixtureOrigin,
    entry: `${ownedFixtureOrigin}/login`,
    declaredOrigins: [ownedFixtureOrigin],
    allowedFrameOrigins: [],
    sequences: [
      ["combined", "verification"],
      ["identifier", "password", "verification"],
    ],
    steps: ["combined", "verification"],
    maxSubmissions: 2,
    verification: { strategy: "fixture-account", path: "/account" },
  },
  ...[
    {
      id: "github-login",
      provider: "GitHub",
      entry: "https://github.com/login",
      origin: "https://github.com",
    },
    {
      id: "google-login",
      provider: "Google",
      entry: "https://accounts.google.com/ServiceLogin",
      origin: "https://accounts.google.com",
    },
    {
      id: "microsoft-login",
      provider: "Microsoft",
      entry: "https://login.microsoftonline.com/",
      origin: "https://login.microsoftonline.com",
    },
  ].map(({ origin, ...metadata }) => ({
    ...metadata,
    executable: false,
    discoveryOnly: true,
    validation: "pending-validation",
    originBinding: "exact",
    declaredOrigins: [origin],
    allowedFrameOrigins: [],
    sequences: [],
    steps: [],
    maxSubmissions: 0,
    verification: { strategy: "unvalidated" },
  })),
]);

/**
 * Without an origin, returns immutable metadata only (not execution admission).
 * Supply the canonical HTTP loopback origin captured by trusted code at run start
 * to obtain a run-local profile. No global catalog mutation or hostname widening.
 */
export function executableProfile(
  profileId: string,
  runStartOrigin?: string,
): CatalogProfile | undefined {
  const profile = browserLoginCatalog.find((item) => item.id === profileId);
  if (!profile?.executable || profile.discoveryOnly) return undefined;
  if (runStartOrigin === undefined) return profile;
  const origin = catalogOriginSchema.parse(runStartOrigin);
  const url = new URL(origin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
    throw new Error("Run start must bind the owned HTTP loopback fixture");
  return catalogProfileSchema.parse({
    ...profile,
    fixtureOrigin: origin,
    entry: new URL(new URL(profile.entry).pathname, origin).href,
    declaredOrigins: [origin],
    allowedFrameOrigins: profile.allowedFrameOrigins.map(() => origin),
  });
}

/**
 * The third argument MUST be the origin retained from run start, never taken
 * from the currently observed document. The two-argument legacy call fails closed.
 * A document URL may contain a path/query; its scheme, host AND port must match.
 */
export function admittedCatalogOrigin(
  profileId: string,
  value: string,
  runStartOrigin?: string,
): string {
  if (runStartOrigin === undefined)
    throw new Error("Run-start fixture origin is required");
  const profile = executableProfile(profileId, runStartOrigin);
  if (!profile?.fixtureOrigin) throw new Error("Profile is not executable");
  const url = new URL(value);
  if (
    value !== value.trim() ||
    /[\u0000-\u0020\\]/.test(value) ||
    url.username ||
    url.password ||
    url.origin !== profile.fixtureOrigin
  )
    throw new Error("Origin is outside the bound executable fixture profile");
  return url.origin;
}

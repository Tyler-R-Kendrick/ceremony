import { z } from "zod";

/**
 * Vocabulary for logging a person into a *named* browser session and leaving
 * that session usable afterwards.
 *
 * The existing {@link ./browser-contracts.js} vocabulary describes one page and
 * one ephemeral attempt. It deliberately says nothing about *which* browser the
 * attempt ran in, who may drive it next, or whether the resulting session
 * outlives the call. Those are exactly the questions a retained login has to
 * answer, so they live here rather than being smuggled into a page snapshot.
 *
 * Four things are kept apart on purpose, because collapsing any pair of them is
 * how a harness ends up believing it is logged in when it is not:
 *
 * - a provider *grant* (an API credential was issued and checked),
 * - a browser *session* (the expected account is present in one exact context),
 * - *control* (an identified client may drive that context), and
 * - a person's *word* that they finished.
 *
 * Nothing in this module is authority. Every reference is opaque and is
 * resolved by the server against the current actor, tenant and policy on every
 * operation; holding one is not possession of anything.
 */

/* ------------------------------------------------------------------ *
 * Opaque references
 * ------------------------------------------------------------------ */

/**
 * References are prefixed so a mix-up is a validation error rather than a
 * silently accepted substitution: a document reference handed where a session
 * reference belongs is rejected by shape before anything resolves it.
 *
 * TypeScript branding is not relied on. A brand disappears at runtime and every
 * one of these values arrives from a client, so each has a real schema.
 */
const referencePattern = (prefix: string) =>
  new RegExp(`^${prefix}_[0-9a-f]{32}$`);

export function opaqueReferenceSchema(prefix: string) {
  return z
    .string()
    .max(64)
    .regex(referencePattern(prefix), `Expected a ${prefix} reference`);
}

/** Mint a reference. Randomness is the only meaning a reference carries. */
export function mintReference(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export const executorRefSchema = opaqueReferenceSchema("bexec");
export const browserSessionRefSchema = opaqueReferenceSchema("bsess");
export const contextRefSchema = opaqueReferenceSchema("bctx");
export const targetRefSchema = opaqueReferenceSchema("btgt");
export const frameRefSchema = opaqueReferenceSchema("bfrm");
export const documentRefSchema = opaqueReferenceSchema("bdoc");
export const elementRefSchema = opaqueReferenceSchema("belm");
export const runRefSchema = opaqueReferenceSchema("brun");
export const evidenceRefSchema = opaqueReferenceSchema("bevd");
export const handoffRefSchema = opaqueReferenceSchema("bhof");
export const effectRefSchema = opaqueReferenceSchema("beff");
export const leaseRefSchema = opaqueReferenceSchema("blse");
export const grantRefSchema = opaqueReferenceSchema("bgrt");

/* ------------------------------------------------------------------ *
 * Engines, ownership and trust
 * ------------------------------------------------------------------ */

/**
 * Real engines, not product names. A Playwright WebKit build is not the
 * person's installed Safari and never claims to be; `webkit` here means the
 * engine this process can actually launch.
 */
export const browserEngines = ["chromium", "firefox", "webkit"] as const;
export const browserEngineSchema = z.enum(browserEngines);
export type BrowserEngine = z.infer<typeof browserEngineSchema>;

/**
 * Who owns the browser process.
 *
 * `attached-user` is the person's own browser, reached through an installed
 * companion. Releasing automation there must leave their tabs, cookies and
 * process exactly as they were: Ceremony borrowed control, it does not own the
 * browser. `managed` is a process this executor launched and may dispose.
 */
export const browserOwnerships = ["attached-user", "managed"] as const;
export const browserOwnershipSchema = z.enum(browserOwnerships);
export type BrowserOwnership = z.infer<typeof browserOwnershipSchema>;

/**
 * What the holder of control may do.
 *
 * `constrained-auth` exposes validated authentication operations and approved
 * projections only — no arbitrary scripting, no raw DOM or cookie export, no
 * second channel into the credential-bearing context. `trusted-agent` is an
 * explicit delegation of broader authority; a deployment in that mode must say
 * plainly that the controlling harness can read the page and use the account.
 * There is no third mode that claims constrained guarantees while a debugging
 * channel into the same browser stays open.
 */
export const browserTrustModes = ["constrained-auth", "trusted-agent"] as const;
export const browserTrustModeSchema = z.enum(browserTrustModes);
export type BrowserTrustMode = z.infer<typeof browserTrustModeSchema>;

/** What happens to the session when the login call returns. */
export const loginContinuations = [
  /** Hand the authenticated browser back to the person who asked for it. */
  "return-to-user",
  /** Keep it for an authorized client to drive within its granted scope. */
  "retain-for-authorized-agent",
  /**
   * Existing behaviour: the context exists only to complete the attempt and is
   * disposed when it ends. Kept so present ephemeral authorization flows are
   * not quietly converted into retained sessions.
   */
  "dispose",
] as const;
export const loginContinuationSchema = z.enum(loginContinuations);
export type LoginContinuation = z.infer<typeof loginContinuationSchema>;

/* ------------------------------------------------------------------ *
 * Operational reasons
 * ------------------------------------------------------------------ */

/**
 * Why an operation did not do what was asked. Finite, so a caller and a test
 * can assert the specific wall instead of matching prose, and so a public error
 * never has to carry a free-form string that could echo a secret, a URL with
 * auth parameters or a serialized browser object.
 */
export const browserOperationReasons = [
  /** The selected browser, context or tab is gone or was never reachable. */
  "target-unavailable",
  /** The document that was observed is not the document now in front of us. */
  "stale-document",
  /** The element that was approved is not the element now in the page. */
  "stale-element",
  /** No approval was held to act against; none was taken, or it was released. */
  "no-observation",
  /** The form would now deliver to somewhere the approval never covered. */
  "unapproved-recipient",
  /** A backend cannot do what the effective plan requires of it. */
  "unsupported-capability",
  /** The expected account is not the account present. */
  "account-mismatch",
  /** A platform authenticator or OS dialog must answer; no page can. */
  "requires-user-verification",
  /** The plan's allowance for asking a person is spent. */
  "interaction-budget-exhausted",
  /** Something was dispatched and the outcome is genuinely not known. */
  "submission-indeterminate",
  /** Another holder owns this context, or this lease was superseded. */
  "lease-conflict",
  /** The browser or executor behind this session is no longer the same one. */
  "generation-mismatch",
  /** The caller is not permitted to do this to this session. */
  "not-authorized",
  /** The effective plan changed under a pending decision. */
  "plan-revised",
  /** The run, grant, handoff or lease outlived its expiry. */
  "expired",
  /** The operation was cancelled before dispatch. */
  "cancelled",
  /** A person was asked to take part and refused. */
  "human-declined",
  /** Nobody could be reached to take part. */
  "human-unavailable",
  /**
   * A value the attempt was holding privately appeared on a surface that must
   * never carry one - a page snapshot bound for an interpreter, or a note an
   * interpreter proposed. The attempt stops.
   *
   * It has its own name rather than folding into `provider-error` because the
   * two call for opposite responses. A provider error is something to retry or
   * report upstream; this is a privacy tripwire, and a host that cannot tell
   * them apart cannot alarm on the one that matters. The name says what
   * happened and carries nothing about the value, which is the point.
   */
  "protected-value-exposed",
  /** The provider reported an error the ceremony cannot act on. */
  "provider-error",
] as const;
export const browserOperationReasonSchema = z.enum(browserOperationReasons);
export type BrowserOperationReason = z.infer<
  typeof browserOperationReasonSchema
>;

/* ------------------------------------------------------------------ *
 * Backend capabilities
 * ------------------------------------------------------------------ */

/**
 * A capability is a tested behaviour of one backend at one version, not an
 * optimistic boolean. `PORT-CLAIMS` generates these from the runtime and from
 * contract-test evidence; a rendering test can never turn one on.
 */
export const browserCapabilitySchema = z
  .strictObject({
    /** Can retain a logged-in context after the login call returns. */
    retainedSession: z.boolean(),
    /** Holds element identity in the driver, not in page-readable attributes. */
    backendHeldElements: z.boolean(),
    /** Detects that the observed document was replaced before acting. */
    documentBinding: z.boolean(),
    /** Can bind a popup to its opener and refuse an unrelated one. */
    popupBinding: z.boolean(),
    /** Can act inside a named cross-origin frame with origin rechecked. */
    frameBinding: z.boolean(),
    /**
     * Enforces that *every* subresource leaves through an approved path, not
     * only top-level documents. Chromium's `Fetch` document interception does
     * not cover this, so it is declared separately and truthfully.
     */
    strongEgressContainment: z.boolean(),
    /** Can observe a native authenticator request and hand off to a person. */
    authenticatorHandoff: z.boolean(),
    /** Can serialize and restore storage state for this engine. */
    statePersistence: z.boolean(),
    /**
     * A holder of control can reach a raw debugging channel into this browser.
     * When true the deployment is `trusted-agent` whatever the UI says.
     */
    debugExposure: z.boolean(),
  })
  .readonly();
export type BrowserCapabilities = z.infer<typeof browserCapabilitySchema>;

export const backendDescriptorSchema = z
  .strictObject({
    backendId: z.string().regex(/^[a-z][a-z0-9-]{2,47}$/),
    engine: browserEngineSchema,
    ownership: browserOwnershipSchema,
    /** Actual executable version, recorded so evidence names what ran. */
    engineVersion: z.string().max(64),
    capabilities: browserCapabilitySchema,
  })
  .readonly();
export type BackendDescriptor = z.infer<typeof backendDescriptorSchema>;

/**
 * Capabilities an effective plan requires of whatever backend runs it. A
 * backend that cannot prove one refuses the operation *before* a credential is
 * released, rather than proceeding with a weaker guarantee.
 */
export const requiredCapabilitySchema = z
  .strictObject({
    retainedSession: z.boolean().optional(),
    strongEgressContainment: z.boolean().optional(),
    statePersistence: z.boolean().optional(),
    frameBinding: z.boolean().optional(),
    popupBinding: z.boolean().optional(),
  })
  .strict();
export type RequiredCapabilities = z.infer<typeof requiredCapabilitySchema>;

/** Which required capabilities a descriptor cannot satisfy. Empty means it can. */
export function unmetCapabilities(
  backend: BackendDescriptor,
  required: RequiredCapabilities,
): readonly (keyof BrowserCapabilities)[] {
  const unmet: (keyof BrowserCapabilities)[] = [];
  for (const [name, wanted] of Object.entries(required)) {
    if (wanted !== true) continue;
    const key = name as keyof BrowserCapabilities;
    if (backend.capabilities[key] !== true) unmet.push(key);
  }
  return unmet;
}

/* ------------------------------------------------------------------ *
 * Login intent
 * ------------------------------------------------------------------ */

/**
 * When the expected account is not named up front, the caller must say what to
 * do about it rather than letting the first account found become "success".
 */
export const accountPolicySchema = z.discriminatedUnion("kind", [
  /** Exactly this account, verified, or the attempt reports a mismatch. */
  z.strictObject({
    kind: z.literal("expect"),
    accountRef: z.string().max(256),
  }),
  /** Whatever account is already present may be accepted, once confirmed. */
  z.strictObject({ kind: z.literal("accept-existing") }),
  /** A person chooses among the accounts the provider offers. */
  z.strictObject({ kind: z.literal("require-selection") }),
]);
export type AccountPolicy = z.infer<typeof accountPolicySchema>;

/* ------------------------------------------------------------------ *
 * Evidence
 * ------------------------------------------------------------------ */

/**
 * How strongly the account was established. These never promote into one
 * another, and every consumer keeps the distinction: a fixture result stays
 * fixture-labelled in the UI, in MCP output and in an export.
 */
export const loginEvidenceKinds = [
  /** An owned test provider confirmed the account through this exact context. */
  "fixture-verified",
  /** A reviewed live-provider verifier confirmed it through this context. */
  "provider-verified",
  /** A person said they finished. A claim, not provider evidence. */
  "human-attested",
] as const;
export const loginEvidenceKindSchema = z.enum(loginEvidenceKinds);
export type LoginEvidenceKind = z.infer<typeof loginEvidenceKindSchema>;

/** Only these establish a `verified` outcome. Attestation does not. */
export const verifyingEvidenceKinds: readonly LoginEvidenceKind[] = [
  "fixture-verified",
  "provider-verified",
];

export const loginEvidenceSchema = z
  .strictObject({
    kind: loginEvidenceKindSchema,
    /** Which verifier ran, and at what version. A parser change is a new one. */
    verifierRef: z.string().min(1).max(128),
    verifierVersion: z.string().min(1).max(64),
    browserSessionRef: browserSessionRefSchema,
    /** Ties the evidence to one browser process, not merely to a session row. */
    browserGeneration: z.string().max(64),
    accountRef: z.string().min(1).max(256),
    verifiedAt: z.string().datetime(),
    expiresAt: z.string().datetime().optional(),
    /** Evidence gathered under one plan does not carry to a revised one. */
    effectivePlanDigest: z.string().length(64),
  })
  .readonly();
export type LoginEvidence = z.infer<typeof loginEvidenceSchema>;

/** Whether evidence still counts right now, for this plan and this browser. */
export function evidenceIsFresh(
  evidence: LoginEvidence,
  now: Date,
  expect: { planDigest: string; browserGeneration: string },
): boolean {
  if (evidence.effectivePlanDigest !== expect.planDigest) return false;
  if (evidence.browserGeneration !== expect.browserGeneration) return false;
  if (!evidence.expiresAt) return true;
  return Date.parse(evidence.expiresAt) > now.getTime();
}

/* ------------------------------------------------------------------ *
 * Results
 * ------------------------------------------------------------------ */

/**
 * The outcomes a login can have. They are deliberately not collapsible:
 * `submitted-unverified` is what an honest harness reports when it typed a
 * password and never established who is logged in, and no consumer may round it
 * up to `verified`.
 */
export const loginResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("verified"),
    runRef: runRefSchema,
    sessionRef: browserSessionRefSchema,
    evidenceRef: evidenceRefSchema,
    evidenceKind: loginEvidenceKindSchema,
  }),
  z.strictObject({
    status: z.literal("requires-human"),
    runRef: runRefSchema,
    handoffRef: handoffRefSchema,
    reason: z.enum([
      "human-challenge",
      "passkey",
      "native-dialog",
      "push-approval",
      "account-selection",
    ]),
  }),
  z.strictObject({
    status: z.literal("submitted-unverified"),
    runRef: runRefSchema,
    sessionRef: browserSessionRefSchema.optional(),
  }),
  z.strictObject({
    status: z.literal("indeterminate"),
    runRef: runRefSchema,
    /**
     * The durable record of what was sent, when a deployment keeps one.
     *
     * Optional, and absent rather than invented. A deployment with no effect
     * ledger can still discover that a submission left the browser and that
     * nobody learned the answer - that is the part a caller must act on - but
     * there is nothing to look the attempt up in afterwards. Minting a
     * reference here so the shape stays uniform would hand back an identifier
     * that resolves to nothing, which is the same class of false claim as a
     * capability nothing implements.
     */
    effectRef: effectRefSchema.optional(),
  }),
  z.strictObject({
    status: z.literal("blocked"),
    runRef: runRefSchema.optional(),
    reason: browserOperationReasonSchema,
  }),
  z.strictObject({ status: z.literal("cancelled"), runRef: runRefSchema }),
  z.strictObject({ status: z.literal("session-lost"), runRef: runRefSchema }),
]);
export type LoginResult = z.infer<typeof loginResultSchema>;

/* ------------------------------------------------------------------ *
 * Handoffs
 * ------------------------------------------------------------------ */

/**
 * One request for a person to take part.
 *
 * `handoffRef` identifies the *attempt*, not the run. Keying a wait by run
 * alone is what lets a reply to an abandoned first attempt settle a second one,
 * so the attempt is the unit here and a resolution names it explicitly.
 */
export const handoffResolutionSchema = z.enum([
  "completed",
  "declined",
  "unavailable",
]);
export type HandoffOutcome = z.infer<typeof handoffResolutionSchema>;

/* ------------------------------------------------------------------ *
 * Sessions and leases
 * ------------------------------------------------------------------ */

/**
 * The durable, secret-free record of a retained browser session.
 *
 * Live browser handles and control URLs are *not* here. This is what may be
 * written to a database and read back after a restart; a row does not make a
 * browser process durable, so `browserGeneration` is checked on reconnect and a
 * mismatch means the session is lost rather than silently re-adopted.
 */
export const browserSessionRecordSchema = z
  .strictObject({
    sessionRef: browserSessionRefSchema,
    ownership: browserOwnershipSchema,
    engine: browserEngineSchema,
    backendId: z.string().max(48),
    executorRef: executorRefSchema,
    browserGeneration: z.string().max(64),
    contextRef: contextRefSchema,
    /** Tenant and subject that own the session; resolved on every operation. */
    tenant: z.string().min(1).max(128),
    subject: z.string().min(1).max(128),
    /** Who may currently drive it, and under which lease generation. */
    controllerRef: z.string().min(1).max(128).optional(),
    leaseRef: leaseRefSchema.optional(),
    leaseGeneration: z.number().int().nonnegative(),
    trustMode: browserTrustModeSchema,
    /** Operations the controller may perform. Not a blanket grant. */
    scope: z.array(z.string().min(1).max(64)).max(32),
    effectivePlanDigest: z.string().length(64),
    evidenceRef: evidenceRefSchema.optional(),
    evidenceKind: loginEvidenceKindSchema.optional(),
    verifiedAt: z.string().datetime().optional(),
    expiresAt: z.string().datetime(),
  })
  .readonly();
export type BrowserSessionRecord = z.infer<typeof browserSessionRecordSchema>;

/**
 * What releasing control does, kept as separate operations because they have
 * genuinely different effects and conflating them produces false claims.
 */
export const sessionReleaseKinds = [
  /** Stop driving. For an attached browser: the person keeps everything. */
  "release-control",
  /** Destroy the resources this executor owns. Never an attached process. */
  "dispose-managed",
  /** Stop the current run. Cannot retract an already dispatched request. */
  "cancel-run",
] as const;
export const sessionReleaseKindSchema = z.enum(sessionReleaseKinds);
export type SessionReleaseKind = z.infer<typeof sessionReleaseKindSchema>;

/**
 * What a release actually did.
 *
 * `upstreamLogout` is always false: Ceremony can stop driving a browser and can
 * destroy a context it owns, but it does not end the provider's session, and
 * saying otherwise would be a lie a caller could act on.
 */
export const sessionReleaseResultSchema = z
  .strictObject({
    kind: sessionReleaseKindSchema,
    automationRevoked: z.boolean(),
    managedResourcesDisposed: z.boolean(),
    userBrowserPreserved: z.boolean(),
    upstreamLogout: z.literal(false),
  })
  .readonly();
export type SessionReleaseResult = z.infer<typeof sessionReleaseResultSchema>;

/* ------------------------------------------------------------------ *
 * Public projections
 * ------------------------------------------------------------------ */

/**
 * What a client may see about a session. Deliberately not the record: no
 * tenant, no subject, no executor reference, no context reference, and never a
 * control URL or a browser handle.
 */
export const sessionStatusSchema = z
  .strictObject({
    sessionRef: browserSessionRefSchema,
    ownership: browserOwnershipSchema,
    engine: browserEngineSchema,
    trustMode: browserTrustModeSchema,
    evidenceKind: loginEvidenceKindSchema.optional(),
    verifiedAt: z.string().datetime().optional(),
    expiresAt: z.string().datetime(),
    /** True only while verifying evidence exists and is still fresh. */
    verified: z.boolean(),
    /** Whether the asking client is the one currently permitted to drive. */
    controllable: z.boolean(),
    scope: z.array(z.string().max(64)).max(32),
  })
  .readonly();
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

/**
 * Project a record for a caller. Verification is recomputed rather than read
 * from a stored boolean, so stale evidence cannot keep reporting `verified`
 * after the plan or the browser changed.
 */
export function projectSessionStatus(
  record: BrowserSessionRecord,
  options: {
    now: Date;
    evidence?: LoginEvidence | undefined;
    callerRef?: string | undefined;
    planDigest: string;
  },
): SessionStatus {
  const verified =
    options.evidence !== undefined &&
    verifyingEvidenceKinds.includes(options.evidence.kind) &&
    evidenceIsFresh(options.evidence, options.now, {
      planDigest: options.planDigest,
      browserGeneration: record.browserGeneration,
    });
  return {
    sessionRef: record.sessionRef,
    ownership: record.ownership,
    engine: record.engine,
    trustMode: record.trustMode,
    ...(record.evidenceKind ? { evidenceKind: record.evidenceKind } : {}),
    ...(record.verifiedAt ? { verifiedAt: record.verifiedAt } : {}),
    expiresAt: record.expiresAt,
    verified,
    controllable:
      options.callerRef !== undefined &&
      record.controllerRef === options.callerRef &&
      Date.parse(record.expiresAt) > options.now.getTime(),
    scope: record.scope,
  };
}

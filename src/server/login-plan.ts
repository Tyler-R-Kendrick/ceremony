import { createHash } from "node:crypto";
import { z } from "zod";
import {
  accountPolicySchema,
  browserEngineSchema,
  browserOwnershipSchema,
  browserReasoningModeSchema,
  browserTrustModeSchema,
  loginContinuationSchema,
  requiredCapabilitySchema,
  type AccountPolicy,
  type BackendDescriptor,
  type RequiredCapabilities,
} from "../core/browser-session-contracts.js";
import { unmetCapabilities } from "../core/browser-session-contracts.js";
import {
  derivedRoleOf,
  heldCredentialKinds,
  issuedDeclarationSchema,
  pageLabelSchema,
  type IssuedDeclaration,
  type IssuedSinkKind,
} from "../core/browser-contracts.js";
import {
  recordingReferenceSchema,
  type RecordingReference,
} from "../core/recorded-ceremony.js";

/**
 * Turning what a person asked for into what the server will actually do.
 *
 * A configuration wizard collects choices. Those choices are a *request*: until
 * the server has resolved them against its own registrations, checked them
 * against policy and written down a canonical result, nothing about them is
 * true. The failure this module exists to prevent is the one where a wizard
 * renders "interruptions: none" and "key scope: personal", the run then uses
 * neither, and the interface is describing a plan that was never sent.
 *
 * So the compiled plan is the only thing execution reads, it carries a digest,
 * and approvals, pending effects, leases and evidence are all bound to that
 * digest. A configuration change under a pending human wait produces a new
 * digest and therefore cannot authorize the work approved under the old one.
 */

/**
 * An origin, canonicalized once, here.
 *
 * Scheme, host and effective port; no userinfo, no path, no wildcard, and
 * never a suffix test. Several places in the codebase need "the same origin"
 * to mean the same thing, and the way that stops being true is each of them
 * writing its own comparison.
 */
export const exactOriginSchema = z
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
          // Loopback stays available for owned fixtures and development. It is
          // an exception for a specific host, not a hole for "local-looking"
          // names, and production policy is what decides whether it applies.
          (url.protocol === "http:" &&
            (url.hostname === "127.0.0.1" || url.hostname === "[::1]")))
      );
    } catch {
      return false;
    }
  }, "Expected an exact canonical origin");

/**
 * What the wizard collected. Every field here is a *request*, and every field
 * either changes the compiled plan or is rejected — a field that is displayed
 * and then ignored is the defect, not a harmless nicety.
 */
export const connectionDraftSchema = z
  .strictObject({
    connectorId: z.string().min(1).max(128),
    engine: browserEngineSchema,
    ownership: browserOwnershipSchema,
    entryUrl: z.string().url().max(2000),
    navigationOrigins: z.array(exactOriginSchema).min(1).max(16),
    /**
     * Where a *secret* may be typed, per role, kept separate from where the
     * ceremony may navigate. Permission to visit an identity provider is not
     * permission to type this site's password into it.
     */
    credentialRecipients: z
      .record(z.string().max(32), z.array(exactOriginSchema).max(8))
      .optional(),
    frameOrigins: z.array(exactOriginSchema).max(8).optional(),
    account: accountPolicySchema,
    continuation: loginContinuationSchema,
    trustMode: browserTrustModeSchema,
    /**
     * Whether this login may consult the host's model, and nothing wider.
     *
     * Absent means `deterministic`. A default that reached for a model would
     * make "I did not fill this in" mean "send the page to inference", which
     * is the wrong direction for the one field here that decides whether
     * anything about somebody's sign-in page leaves the deployment.
     */
    reasoning: browserReasoningModeSchema.optional(),
    /**
     * How many times this ceremony may ask a person to take part. It counts
     * rounds Ceremony requests, cumulatively across retries, resumes and
     * interpreter fallback. It is not, and cannot be, a promise about the
     * prompts a browser or an operating system decides to show.
     */
    interactionRounds: z.number().int().min(0).max(8),
    /** Verification is required unless the host explicitly permits otherwise. */
    requireVerification: z.boolean(),
    verifierOrigin: exactOriginSchema.optional(),
    required: requiredCapabilitySchema.optional(),
    /**
     * References to values held by the private collector. The draft carries
     * authorized references; it never carries a password.
     */
    credentialRefs: z
      .record(z.string().max(32), z.string().max(128))
      .optional(),
    sessionTtlMs: z.number().int().min(60_000).max(86_400_000),
    /**
     * A published recorded ceremony to replay instead of reading the page,
     * pinned by version and digest. The login then consults no model at all;
     * where the provider no longer matches the recording it stops by name.
     *
     * Part of the plan, and so of its digest: a login approved to replay one
     * recording cannot quietly replay another.
     */
    recording: recordingReferenceSchema.optional(),
    /**
     * Values the provider shows on a page that this login keeps - an OAuth
     * client's ID and secret on its developer settings page - named by the
     * exact label of the read-only field each is in, and the host sink they
     * go to. The sink is a kind the host registered (`oauth-client`,
     * `credential-custody`), never anything a caller supplies, and the
     * values never come back out of the login: not in its result, its steps
     * or a recording, and never to the interpreter.
     */
    issued: issuedDeclarationSchema.optional(),
    /**
     * Options this login chooses, by the exact label of the `<select>` each
     * is for: `{ "Country or region": "Canada" }`. Page text on both sides,
     * held to the rule for page labels, so a secret cannot be passed as one.
     * A required choice not named here is handed to a person.
     */
    choices: z
      .record(pageLabelSchema, pageLabelSchema)
      .refine(
        (choices) => Object.keys(choices).length <= 8,
        "At most 8 choices",
      )
      .optional(),
  })
  .strict();
export type ConnectionDraft = z.infer<typeof connectionDraftSchema>;

/** Why a draft could not become a plan. Finite, so a UI can explain it. */
export const planRejectionReasons = [
  "unknown-connector",
  "unsupported-engine",
  "unsupported-capability",
  "entry-origin-not-declared",
  "verifier-origin-not-declared",
  "recipient-origin-not-declared",
  "verification-required",
  "unknown-credential-reference",
  "ambiguous-account",
  /** Inference was asked for and this host has no model to do it with. */
  "reasoning-unavailable",
  /**
   * The named recording is not published here at that version and digest,
   * or it was retired.
   */
  "recording-unavailable",
  /** The recording acts on an origin this plan does not admit. */
  "recording-origin-not-declared",
  /**
   * The plan keeps issued values and this host registered no sink of that
   * kind, so there is nowhere trusted for them to go.
   */
  "issued-sink-unavailable",
  /**
   * The plan's issued declaration and the published recording's differ. A
   * recording keeps exactly what its reviewer saw it keep, and a plan that
   * replays it keeps exactly that too.
   */
  "recording-issued-mismatch",
] as const;
export const planRejectionReasonSchema = z.enum(planRejectionReasons);
export type PlanRejectionReason = z.infer<typeof planRejectionReasonSchema>;

/**
 * Why a draft was refused, and — only where it is safe — which value did it.
 *
 * A rejection is the one object here that routinely leaves the process by a
 * route nobody planned: it is thrown, logged, attached to a report, and on a
 * model-facing surface it is rendered into a transcript. Every other surface
 * in this system has a written rule about what it may carry. This is that
 * rule.
 *
 * `detail` may hold something the *server* worked out — which capabilities a
 * backend lacks — or a token from a closed set the schema already validated:
 * an engine, an ownership, a role name, a canonical origin. It may not hold a
 * free-form string the caller sent. `connectorId` is the one such field, 128
 * characters of anything, and echoing it back bought nothing: a caller
 * already knows what it asked for, so the echo was only ever a second,
 * unredacted copy travelling somewhere the first one was not going to go.
 */
export class PlanRejected extends Error {
  constructor(
    readonly reason: PlanRejectionReason,
    readonly detail?: string,
  ) {
    super(`Configuration rejected: ${reason}`);
    this.name = "PlanRejected";
  }
}

/**
 * The canonical plan. This, and nothing else, is what execution reads.
 */
export type EffectiveLoginPlan = {
  connectorId: string;
  engine: z.infer<typeof browserEngineSchema>;
  ownership: z.infer<typeof browserOwnershipSchema>;
  backendId: string;
  entryUrl: string;
  navigationOrigins: readonly string[];
  credentialRecipients: Readonly<Record<string, readonly string[]>>;
  frameOrigins: readonly string[];
  account: AccountPolicy;
  continuation: z.infer<typeof loginContinuationSchema>;
  trustMode: z.infer<typeof browserTrustModeSchema>;
  /** Who may decide the next action. Resolved, never absent, always digested. */
  reasoning: z.infer<typeof browserReasoningModeSchema>;
  interactionRounds: number;
  requireVerification: boolean;
  verifierOrigin: string | undefined;
  required: RequiredCapabilities;
  credentialRefs: Readonly<Record<string, string>>;
  sessionTtlMs: number;
  /** The published recording this login replays, when it replays one. */
  recording?: RecordingReference;
  /** What this login keeps from a provider page, and where it goes. */
  issued?: IssuedDeclaration;
  /** Options this login chooses, by field label. */
  choices?: Readonly<Record<string, string>>;
  revision: number;
  digest: string;
};

/**
 * Canonical JSON: sorted keys, so two plans that say the same thing digest the
 * same and two that differ anywhere digest differently.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

export function planDigest(plan: Omit<EffectiveLoginPlan, "digest">): string {
  return createHash("sha256").update(canonical(plan)).digest("hex");
}

function originOf(url: string): string {
  return new URL(url).origin;
}

export type CompileOptions = {
  /** Backends this host actually has, from the runtime, not from the client. */
  backends: readonly BackendDescriptor[];
  /** Connectors the server knows. An unknown one never falls back to the first. */
  knownConnectors: ReadonlySet<string>;
  /** Credential references this actor may use, resolved by the caller already. */
  availableCredentialRefs?: ReadonlySet<string>;
  /** Whether this deployment permits a deliberately unverified attempt. */
  allowUnverified?: boolean;
  /**
   * Whether this host has a model configured at all, from the runtime rather
   * than from the client. A draft asking for inference on a host without one
   * is refused here — the alternative is running the deterministic rules
   * under a plan that says a model decided, which is the same defect as a
   * wizard rendering a setting the server never compiled.
   */
  modelAvailable?: boolean;
  /**
   * The issued-value sinks this host registered. A plan naming any other is
   * refused here: a sink is the host's decision, and one it never made is not
   * a place a secret may be sent.
   */
  issuedSinks?: ReadonlySet<IssuedSinkKind>;
  revision: number;
};

/**
 * Compile a draft into the plan the server will execute, or reject it by name.
 *
 * Nothing here is silently ignored and nothing is silently defaulted into
 * existence. A choice the host cannot honour is a rejection the interface can
 * explain, which is the only way a person can tell the difference between "that
 * is not supported" and "that quietly did nothing".
 */
export function compileLoginPlan(
  input: unknown,
  options: CompileOptions,
): EffectiveLoginPlan {
  const draft = connectionDraftSchema.parse(input);

  // No detail. The connector id is the only unbounded caller string the
  // compiler reads, and the reason alone names the field it belongs to.
  if (!options.knownConnectors.has(draft.connectorId))
    throw new PlanRejected("unknown-connector");

  const backend = options.backends.find(
    (candidate) =>
      candidate.engine === draft.engine &&
      candidate.ownership === draft.ownership,
  );
  if (!backend)
    throw new PlanRejected(
      "unsupported-engine",
      `${draft.ownership} ${draft.engine}`,
    );

  const required: RequiredCapabilities = {
    ...(draft.required ?? {}),
    // Retention is not a preference when the caller asked to keep the session;
    // a backend that cannot retain must refuse rather than return a browser it
    // is about to close.
    ...(draft.continuation === "dispose" ? {} : { retainedSession: true }),
    // Nor is acting inside a frame. Declaring a frame origin *is* declaring
    // that this login happens in a frame, so the capability that makes that
    // possible is required whether or not the caller thought to name it.
    //
    // Without this the field was accepted, canonicalized, digested and then
    // read by nothing: `createBoundTargets` observes through
    // `page.evaluateHandle`, which is the main frame and nothing else. A
    // person who configured "the credential form is at https://auth.example
    // in a frame" got a plan that said so and a run that never looked. It
    // failed closed - the driver simply never found the field - but a
    // configuration that reads as supported and cannot work is the defect
    // this compiler exists to prevent, one step further along than a wizard
    // rendering a setting the server never compiled.
    //
    // `frameBinding` was false on every engine when this was written, so
    // this was a refusal, and being told no leaves a person free to choose
    // something else. Then #66 enforced frames and this same line started
    // admitting them - the route a requirement here is meant to take.
    ...((draft.frameOrigins ?? []).length > 0 ? { frameBinding: true } : {}),
  };
  const unmet = unmetCapabilities(backend, required);
  if (unmet.length > 0)
    throw new PlanRejected("unsupported-capability", unmet.join(","));

  const navigationOrigins = [...new Set(draft.navigationOrigins)];
  const entryOrigin = originOf(draft.entryUrl);
  if (!navigationOrigins.includes(entryOrigin))
    throw new PlanRejected("entry-origin-not-declared", entryOrigin);

  // Every credential recipient must also be a declared navigation origin, but
  // the converse is deliberately not true: an SSO hop can be admitted for
  // navigation while receiving no password at all.
  const credentialRecipients: Record<string, readonly string[]> = {};
  for (const [role, origins] of Object.entries(
    draft.credentialRecipients ?? {},
  )) {
    for (const origin of origins)
      if (!navigationOrigins.includes(origin))
        throw new PlanRejected("recipient-origin-not-declared", origin);
    credentialRecipients[role] = [...new Set(origins)];
  }

  for (const origin of draft.frameOrigins ?? [])
    if (!navigationOrigins.includes(origin))
      throw new PlanRejected("recipient-origin-not-declared", origin);

  if (draft.verifierOrigin && !navigationOrigins.includes(draft.verifierOrigin))
    throw new PlanRejected(
      "verifier-origin-not-declared",
      draft.verifierOrigin,
    );

  // Turning verification off is a host decision, not a client one, and even
  // where it is allowed the attempt gets a different, lesser outcome. There is
  // no configuration that produces a verified result without evidence.
  if (!draft.requireVerification && options.allowUnverified !== true)
    throw new PlanRejected("verification-required");

  // Asking for a model this host does not have is a refusal, never a quiet
  // downgrade. Both answers run a login; only one of them runs the login the
  // plan describes, and a caller told "no model here" can choose a host that
  // has one, while a caller told nothing believes a model looked at the page.
  const reasoning = draft.reasoning ?? "deterministic";
  if (reasoning === "host-model" && options.modelAvailable !== true)
    throw new PlanRejected("reasoning-unavailable");

  const credentialRefs: Record<string, string> = {};
  for (const [role, reference] of Object.entries(draft.credentialRefs ?? {})) {
    if (
      options.availableCredentialRefs &&
      !options.availableCredentialRefs.has(reference)
    )
      throw new PlanRejected("unknown-credential-reference", role);
    credentialRefs[role] = reference;
  }
  // A held credential and the role it derives are two answers to one question.
  // A plan naming both a `totp-seed` and a `totp-code` would type whichever the
  // service happened to prefer, which is a field silently ignored by another
  // name, so the derived role's own reference is the one refused.
  for (const kind of heldCredentialKinds) {
    const derived = derivedRoleOf[kind];
    if (credentialRefs[kind] !== undefined && credentialRefs[derived])
      throw new PlanRejected("unknown-credential-reference", derived);
  }

  if (draft.issued && options.issuedSinks?.has(draft.issued.sink) !== true)
    throw new PlanRejected("issued-sink-unavailable", draft.issued.sink);

  // "Whichever account is there" has to be said, not assumed. Without an
  // explicit policy a run would quietly accept the first session it found.
  if (
    draft.account.kind === "expect" &&
    draft.account.accountRef.trim().length === 0
  )
    throw new PlanRejected("ambiguous-account");

  const withoutDigest: Omit<EffectiveLoginPlan, "digest"> = {
    connectorId: draft.connectorId,
    engine: draft.engine,
    ownership: draft.ownership,
    backendId: backend.backendId,
    entryUrl: draft.entryUrl,
    navigationOrigins,
    credentialRecipients,
    frameOrigins: [...new Set(draft.frameOrigins ?? [])],
    account: draft.account,
    continuation: draft.continuation,
    trustMode: draft.trustMode,
    reasoning,
    interactionRounds: draft.interactionRounds,
    requireVerification: draft.requireVerification,
    verifierOrigin: draft.verifierOrigin,
    required,
    credentialRefs,
    sessionTtlMs: draft.sessionTtlMs,
    ...(draft.recording ? { recording: draft.recording } : {}),
    ...(draft.issued ? { issued: draft.issued } : {}),
    ...(draft.choices && Object.keys(draft.choices).length > 0
      ? { choices: draft.choices }
      : {}),
    revision: options.revision,
  };
  return { ...withoutDigest, digest: planDigest(withoutDigest) };
}

/**
 * Where a given role's secret may be typed.
 *
 * Falling back to the navigation origins would undo the separation the plan
 * just made, so a role with no declared recipients can be typed nowhere. That
 * is the safe direction: a missing declaration blocks a login instead of
 * widening one.
 */
export function recipientsFor(
  plan: EffectiveLoginPlan,
  role: string,
): readonly string[] {
  return plan.credentialRecipients[role] ?? [];
}

/**
 * Whether a plan is still the one a decision was made under.
 *
 * Used before dispatching anything a person or a policy approved earlier: the
 * digest changing means the approval was for different work.
 */
export function planUnchanged(
  plan: EffectiveLoginPlan,
  expect: { digest: string; revision: number },
): boolean {
  return plan.digest === expect.digest && plan.revision === expect.revision;
}

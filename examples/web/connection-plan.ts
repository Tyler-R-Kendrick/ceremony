import { z } from "zod";
import type {
  AccountPolicy,
  BackendDescriptor,
  BrowserEngine,
  BrowserOwnership,
  BrowserTrustMode,
  LoginContinuation,
  LoginResult,
  RequiredCapabilities,
  SessionStatus,
} from "../../src/core/browser-session-contracts.js";
import type {
  ConnectionDraft as ServerConnectionDraft,
  PlanRejectionReason,
} from "../../src/server/login-plan.js";
import type { AuthFamily, Capability, CatalogEntry } from "./catalog.js";

/**
 * Turning what the Add Connection wizard collected into what the server will
 * actually run, and reading back what it decided.
 *
 * The wizard on its own produces a *request*. Until the server has compiled it
 * against its own registrations there is no plan, no digest and nothing in
 * effect — so this module is deliberately the only place the draft is allowed
 * to leave the browser, and the only place a compiled plan is read out of a
 * response. Rendering the draft as though it were the plan is the defect this
 * file exists to make impossible: every value the Complete step presents as
 * settled comes out of {@link compileConnection}, never out of the draft.
 *
 * Nothing here is authorization. It builds a body, posts it to an
 * already-authenticated route, and reports exactly what came back, including
 * the cases where the answer is "this host will not do that".
 */

/* ------------------------------------------------------------------ *
 * The draft the wizard collects
 * ------------------------------------------------------------------ */

export type KeyScope = "shared" | "per-user";
export type Mode = "managed" | "custom";

export interface ConnectionDraft {
  entryId: string;
  mode: Mode;
  family: AuthFamily;
  /** Free-form per-family configuration; the server re-validates all of it. */
  values: Record<string, string>;
  keyScope: KeyScope;
  capabilities: Capability[];
  interruptions: "any" | "at-most-one" | "none";
  identity: "personal" | "anonymous" | "either";
  /** Which registered browser runs this. Offered from the server's own list. */
  engine: BrowserEngine;
  /** Whose browser it is. `attached-user` needs a companion this host admits. */
  ownership: BrowserOwnership;
}

/* ------------------------------------------------------------------ *
 * The one route this client speaks to
 * ------------------------------------------------------------------ */

/**
 * The shared tool surface, not a second route invented for the wizard.
 *
 * These are the same operations `src/server/browser-login-tools.ts` exposes to
 * MCP clients, mounted by `src/server/teaching-http.ts` under the teaching
 * prefix. If a deployment offers no browser executor the route is absent
 * rather than present-and-always-refusing, which is why "unavailable" is a
 * state this module reports rather than an error it hides.
 */
export const browserLoginToolPath = "/api/v1/teaching/tools/browser-login";
export const browserBackendsToolPath =
  "/api/v1/teaching/tools/browser-backends";

/* ------------------------------------------------------------------ *
 * What the wizard sends
 * ------------------------------------------------------------------ */

/**
 * The body of the `draft` argument: the compiler's own draft minus the
 * connector, which the tool names once at the top level.
 *
 * Declared structurally rather than imported as a value so no server module is
 * pulled into the browser bundle, and then checked against the real type
 * below — a field added to the compiler that this file does not carry is a
 * compile error here rather than a field the interface silently drops.
 */
export interface LoginDraftRequest {
  engine: BrowserEngine;
  ownership: BrowserOwnership;
  entryUrl: string;
  navigationOrigins: string[];
  credentialRecipients?: Record<string, string[]>;
  frameOrigins?: string[];
  account: AccountPolicy;
  continuation: LoginContinuation;
  trustMode: BrowserTrustMode;
  interactionRounds: number;
  requireVerification: boolean;
  verifierOrigin?: string;
  required?: RequiredCapabilities;
  sessionTtlMs: number;
}

type ServerDraftWithoutConnector = Omit<
  ServerConnectionDraft,
  "connectorId" | "credentialRefs"
>;
/** Fails to compile if {@link LoginDraftRequest} drifts from the compiler. */
type DraftIsAssignable = LoginDraftRequest extends ServerDraftWithoutConnector
  ? true
  : never;
const draftMatchesCompiler: DraftIsAssignable = true;
void draftMatchesCompiler;

/* ------------------------------------------------------------------ *
 * Origins
 * ------------------------------------------------------------------ */

/**
 * The same origin rule the compiler applies, applied here first.
 *
 * Not to pre-empt the server — it re-checks everything — but so a person who
 * typed a path, a wildcard or a bare `http://` host is told which field is
 * wrong instead of watching a whole configuration bounce as `invalid_request`
 * with nothing named.
 */
export function exactOrigin(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  let url: URL;
  try {
    url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`,
    );
  } catch {
    return undefined;
  }
  if (url.username || url.password || url.hostname.includes("*"))
    return undefined;
  if (url.port === "0") return undefined;
  if (url.protocol === "https:") return url.origin;
  if (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "[::1]")
  )
    return url.origin;
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Per-family projection
 * ------------------------------------------------------------------ */

/** Which wizard values a family turns into plan fields, and which it cannot. */
interface FamilyProjection {
  /** The address the ceremony starts at, before canonicalization. */
  entry(draft: ConnectionDraft): string;
  /** Which field the entry address came from, for naming a rejection. */
  entryField: string;
  entryLabel: string;
  /** Further origins the ceremony is allowed to reach. */
  extra(draft: ConnectionDraft): string[];
  /** Named frames the ceremony may act inside. */
  frames(draft: ConnectionDraft): string[];
  /** Credential roles typed at the entry origin. Empty means none, ever. */
  roles(draft: ConnectionDraft): string[];
  /** Capabilities this family's mechanics need of whatever browser runs it. */
  required: RequiredCapabilities;
  /** Values this family collects that a login plan does not carry, and why. */
  notCarried: readonly { key: string; label: string; reason: string }[];
}

const value = (draft: ConnectionDraft, name: string) =>
  draft.values[name] ?? "";

const oauth: FamilyProjection = {
  entry: (draft) =>
    draft.mode === "managed"
      ? value(draft, "issuer")
      : value(draft, "authorizationEndpoint"),
  entryField: "issuer",
  entryLabel: "Server URL",
  extra: (draft) =>
    draft.mode === "managed" ? [] : [value(draft, "tokenEndpoint")],
  frames: () => [],
  // A provider's own sign-in page receives the person's provider credential,
  // never this connection's. Nothing is typed by the ceremony here.
  roles: () => [],
  required: { popupBinding: true },
  notCarried: [
    {
      key: "clientIdName",
      label: "Client ID environment name",
      reason:
        "Resolved from encrypted session configuration when the ceremony runs. A login plan carries origins, not bindings.",
    },
    {
      key: "scopes",
      label: "Scopes",
      reason:
        "Requested from the provider by the connector's method, not by the browser session plan.",
    },
  ],
};

const projections: Record<AuthFamily, FamilyProjection> = {
  "oauth-code": oauth,
  "oauth-client-credentials": {
    ...oauth,
    // Nobody is present, so nothing may pop up and nothing may be asked.
    required: {},
  },
  "api-key": {
    entry: (draft) => value(draft, "service"),
    entryField: "service",
    entryLabel: "Service",
    extra: () => [],
    frames: () => [],
    roles: () => ["key"],
    required: {},
    notCarried: [
      {
        key: "uid",
        label: "UID",
        reason:
          "Names the stored credential inside this workspace. The browser session plan never carries a credential name.",
      },
      {
        key: "scope",
        label: "Scope",
        reason: "Enforced by the provider against the key, not by this plan.",
      },
      {
        key: "expiration",
        label: "Expiration",
        reason:
          "Governs the credential's own lifetime. The plan's session lifetime is separate and is shown below.",
      },
      {
        key: "keyName",
        label: "Key environment name",
        reason:
          "Resolved from encrypted session configuration at run time; a plan carries references, never names typed here.",
      },
      {
        key: "name",
        label: "Name",
        reason: "A label for this workspace. It reaches no runtime decision.",
      },
    ],
  },
  basic: {
    entry: (draft) => value(draft, "service"),
    entryField: "service",
    entryLabel: "Service origin",
    extra: () => [],
    frames: () => [],
    roles: () => ["identifier", "token"],
    required: {},
    notCarried: [
      {
        key: "identifierLabel",
        label: "Identifier label",
        reason: "Wording shown to the person; no runtime decision reads it.",
      },
      {
        key: "tokenLabel",
        label: "Token label",
        reason: "Wording shown to the person; no runtime decision reads it.",
      },
    ],
  },
  device: {
    entry: (draft) => value(draft, "deviceEndpoint"),
    entryField: "deviceEndpoint",
    entryLabel: "Device authorization endpoint",
    extra: (draft) => [value(draft, "verificationUri")],
    frames: () => [],
    roles: () => [],
    required: {},
    notCarried: [],
  },
  "github-app": {
    entry: () => "https://github.com",
    entryField: "namespace",
    entryLabel: "GitHub",
    extra: () => [],
    frames: () => [],
    roles: () => [],
    // Manifest registration and installation both hand off through a window
    // the opener has to be able to recognise again.
    required: { popupBinding: true },
    notCarried: [
      {
        key: "appIdName",
        label: "App ID environment name",
        reason:
          "Resolved from encrypted session configuration at run time, not from this plan.",
      },
      {
        key: "appKeyName",
        label: "Private key environment name",
        reason:
          "Resolved from encrypted session configuration at run time, not from this plan.",
      },
    ],
  },
  "browser-login": {
    entry: (draft) => value(draft, "origin"),
    entryField: "origin",
    entryLabel: "Entry origin",
    extra: () => [],
    frames: () => [],
    // Two pages means the identifier is typed on one and the secret on the
    // other, and the plan has to admit both before either is typed anywhere.
    roles: (draft) =>
      value(draft, "sequence") === "identifier"
        ? ["identifier", "password"]
        : ["password"],
    required: { frameBinding: true, popupBinding: true },
    notCarried: [],
  },
  "account-registration": {
    entry: (draft) => value(draft, "service"),
    entryField: "service",
    entryLabel: "Service origin",
    extra: () => [],
    frames: () => [],
    // A provider that issues its own credential, mails a link or takes the
    // whole step is never asked for a password, so no origin may receive one.
    roles: (draft) =>
      ["none", "provider", "issued-token"].includes(value(draft, "secret"))
        ? []
        : ["password"],
    required: {},
    notCarried: [
      {
        key: "identifier",
        label: "What names the account",
        reason:
          "Collected by the registration ceremony itself. The plan decides where it may be typed, not what it is.",
      },
    ],
  },
  "anonymous-claim": {
    entry: (draft) => value(draft, "claimUrl"),
    entryField: "claimUrl",
    entryLabel: "Claim page",
    extra: () => [],
    frames: () => [],
    roles: () => [],
    required: {},
    notCarried: [],
  },
};

/** How often a plan may ask a person, as a number the compiler can enforce. */
const interactionRounds = { any: 8, "at-most-one": 1, none: 0 } as const;

/* ------------------------------------------------------------------ *
 * Draft → request
 * ------------------------------------------------------------------ */

export type ProjectionResult =
  | { ok: true; connectorId: string; draft: LoginDraftRequest }
  | {
      ok: false;
      /** Which wizard field has to be answered before anything can be sent. */
      field: string;
      label: string;
      reason: string;
      step: 2 | 3;
    };

/**
 * Project the wizard's draft onto the compiler's draft.
 *
 * Every operative field of {@link ConnectionDraft} lands in exactly one part of
 * the request, and the mapping is a pure function so a test can assert what the
 * wire carries without driving a browser. What a family collects and a plan
 * cannot carry is listed in {@link notCarriedBy} instead of being dropped.
 */
export function projectDraft(
  entry: CatalogEntry,
  draft: ConnectionDraft,
): ProjectionResult {
  const projection = projections[draft.family];
  const declared = exactOrigin(projection.entry(draft));
  const registered = entry.origin ? exactOrigin(entry.origin) : undefined;
  // "Managed" means this workspace's registration for the service is what runs;
  // "Custom" means the endpoints the operator declared are the whole of it.
  const entryOrigin =
    draft.mode === "managed"
      ? (registered ?? declared)
      : (declared ?? registered);
  if (!entryOrigin)
    return {
      ok: false,
      field: projection.entryField,
      label: projection.entryLabel,
      reason:
        "An exact https origin is needed before the server can compile this. A path, a wildcard or a bare host is not one.",
      step: 2,
    };
  const extras = projection
    .extra(draft)
    .map(exactOrigin)
    .filter((origin): origin is string => Boolean(origin));
  const frames = projection
    .frames(draft)
    .map(exactOrigin)
    .filter((origin): origin is string => Boolean(origin));
  const navigationOrigins = [
    ...new Set([
      entryOrigin,
      ...extras,
      // A managed configuration also admits the registration; a custom one
      // deliberately does not, so the two produce different plans.
      ...(draft.mode === "managed" && registered ? [registered] : []),
    ]),
  ];
  const roles = projection.roles(draft);
  // Whose key this is changes who may be asked for it, which is a different
  // role in the plan and therefore a different digest.
  const holder = draft.keyScope === "shared" ? "workspace" : "person";
  const credentialRecipients = Object.fromEntries(
    roles.map((role) => [`${holder}-${role}`, [entryOrigin]]),
  );
  const verify = draft.capabilities.includes("verification");
  // Exposing the session to MCP clients is what retains it for a client to
  // drive; handing it back is what a person-owned handoff means; anything else
  // ends when the call does.
  const continuation: LoginContinuation = draft.capabilities.includes("webmcp")
    ? "retain-for-authorized-agent"
    : draft.capabilities.includes("a2h")
      ? "return-to-user"
      : "dispose";
  const required: RequiredCapabilities = {
    ...projection.required,
    // Replaying a recorded sign-in means the browser has to be able to save
    // and restore what the recording established.
    ...(draft.capabilities.includes("teaching") ||
    draft.capabilities.includes("recipes")
      ? { statePersistence: true }
      : {}),
  };
  return {
    ok: true,
    connectorId: draft.entryId,
    draft: {
      engine: draft.engine,
      ownership: draft.ownership,
      entryUrl: entryOrigin,
      navigationOrigins,
      ...(Object.keys(credentialRecipients).length
        ? { credentialRecipients }
        : {}),
      ...(frames.length ? { frameOrigins: frames } : {}),
      account: accountPolicy(draft),
      continuation,
      trustMode:
        continuation === "retain-for-authorized-agent"
          ? "trusted-agent"
          : "constrained-auth",
      interactionRounds: interactionRounds[draft.interruptions],
      requireVerification: verify,
      ...(verify ? { verifierOrigin: entryOrigin } : {}),
      ...(Object.keys(required).length ? { required } : {}),
      sessionTtlMs: continuation === "dispose" ? 300_000 : 3_600_000,
    },
  };
}

/**
 * Whose account ends up signed in.
 *
 * Both questions the wizard asks about people land here, because they are one
 * question at plan level: may whatever account is already present be accepted,
 * or does somebody have to choose. Neither answer is assumed — "accept
 * whatever is there" is said out loud or the compiler refuses the draft.
 */
function accountPolicy(draft: ConnectionDraft): AccountPolicy {
  if (draft.identity === "anonymous") return { kind: "accept-existing" };
  if (draft.identity === "personal") return { kind: "require-selection" };
  return draft.keyScope === "per-user"
    ? { kind: "require-selection" }
    : { kind: "accept-existing" };
}

/** What this family collects that a login plan does not carry, and why. */
export function notCarriedBy(
  draft: ConnectionDraft,
): readonly { key: string; label: string; reason: string }[] {
  return projections[draft.family].notCarried.filter((item) =>
    Boolean(draft.values[item.key]?.trim()),
  );
}

/* ------------------------------------------------------------------ *
 * What comes back
 * ------------------------------------------------------------------ */

/**
 * The canonical plan, when a host echoes the one it compiled.
 *
 * This is the single seam. `browser_login` answers with a login result; a host
 * that also returns the plan it compiled puts it under `plan`, and this is the
 * only shape this client will present as canonical. When no plan comes back the
 * interface says so — it never re-renders the draft as though the server had
 * agreed to it.
 */
export const effectivePlanSchema = z
  .object({
    digest: z.string(),
    revision: z.number(),
    backendId: z.string().optional(),
    engine: z.string().optional(),
    ownership: z.string().optional(),
    entryUrl: z.string().optional(),
    navigationOrigins: z.array(z.string()).optional(),
    credentialRecipients: z.record(z.string(), z.array(z.string())).optional(),
    frameOrigins: z.array(z.string()).optional(),
    continuation: z.string().optional(),
    trustMode: z.string().optional(),
    interactionRounds: z.number().optional(),
    requireVerification: z.boolean().optional(),
    verifierOrigin: z.string().optional(),
    sessionTtlMs: z.number().optional(),
    account: z.object({ kind: z.string() }).loose().optional(),
  })
  .loose();
export type EffectivePlanEcho = z.infer<typeof effectivePlanSchema>;

const loginResponseSchema = z
  .object({
    status: z.string(),
    runRef: z.string().optional(),
    sessionRef: z.string().optional(),
    evidenceKind: z.string().optional(),
    reason: z.string().optional(),
    plan: effectivePlanSchema.optional(),
  })
  .loose();

const failureSchema = z.object({
  error: z.string(),
  reason: z.string().optional(),
});

export type CompileOutcome =
  | {
      kind: "compiled";
      /** Canonical, from the server. Undefined when this host echoes no plan. */
      plan?: EffectivePlanEcho;
      result: z.infer<typeof loginResponseSchema>;
      /** Server-resolved facts about the session it retained, when there is one. */
      session?: SessionStatus;
    }
  | {
      kind: "rejected";
      reason: PlanRejectionReason;
      message: string;
      step: 2 | 3;
    }
  | { kind: "refused"; code: string; message: string };

/** Plain words for each refusal the compiler can name, and where to fix it. */
export const rejectionGuidance: Record<
  PlanRejectionReason,
  { message: string; step: 2 | 3 }
> = {
  "unknown-connector": {
    message: "This workspace has no connector registered under that name.",
    step: 2,
  },
  "unsupported-engine": {
    message:
      "No browser of that kind and ownership is registered on this host, so nothing could run this.",
    step: 2,
  },
  "unsupported-capability": {
    message:
      "The browsers this host has cannot enforce something this configuration requires. Turn off the capability that needs it, or run it somewhere that can.",
    step: 3,
  },
  "entry-origin-not-declared": {
    message:
      "The address this connection starts at is not one of the origins it declares.",
    step: 2,
  },
  "verifier-origin-not-declared": {
    message:
      "Verification would have to reach an origin this connection does not declare.",
    step: 3,
  },
  "recipient-origin-not-declared": {
    message:
      "A credential would be typed at an origin this connection does not admit for navigation.",
    step: 2,
  },
  "verification-required": {
    message:
      "This workspace does not run a connection that never reads anything back. Turn on “Verify real access before completing”.",
    step: 3,
  },
  "unknown-credential-reference": {
    message:
      "The stored credential this configuration names is not one this workspace holds.",
    step: 2,
  },
  "ambiguous-account": {
    message: "The account this connection expects was left empty.",
    step: 3,
  },
};

const refusals: Record<string, string> = {
  denied:
    "This session is not allowed to compile a browser session plan in this workspace.",
  unauthenticated: "Sign in before a configuration can be compiled.",
  unavailable:
    "This workspace runs no browser executor, so there is no browser session to compile this against.",
  invalid_request:
    "The server refused the shape of this request and named no field.",
  "lease-conflict":
    "Another client already holds the browser session this would have used.",
  "session-lost": "The browser behind this session is no longer the same one.",
  conflict: "The configuration changed while this was being compiled.",
};

function refusal(code: string): string {
  return (
    refusals[code] ??
    "The server declined to compile this configuration and named no reason."
  );
}

const rejectionReasons = Object.keys(
  rejectionGuidance,
) as PlanRejectionReason[];

/* ------------------------------------------------------------------ *
 * The call
 * ------------------------------------------------------------------ */

async function post(path: string, body: unknown): Promise<Response> {
  return await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
}

/**
 * Send the draft and report exactly what the server said about it.
 *
 * Every branch returns something the interface can state. There is no path here
 * that swallows a failure and lets the Complete step keep describing the
 * draft: a refusal, a rejection and a compiled plan are three different
 * answers and the caller has to render all three.
 */
export async function compileConnection(
  entry: CatalogEntry,
  draft: ConnectionDraft,
): Promise<CompileOutcome> {
  const projected = projectDraft(entry, draft);
  if (!projected.ok)
    return {
      kind: "refused",
      code: "incomplete",
      message: `${projected.label}: ${projected.reason}`,
    };
  let response: Response;
  try {
    response = await post(browserLoginToolPath, {
      connectorId: projected.connectorId,
      draft: projected.draft,
    });
  } catch {
    return {
      kind: "refused",
      code: "unreachable",
      message: "The configuration could not be sent to the server.",
    };
  }
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const failed = failureSchema.safeParse(payload);
    const reason = failed.success ? failed.data.reason : undefined;
    if (reason && (rejectionReasons as string[]).includes(reason)) {
      const named = reason as PlanRejectionReason;
      return { kind: "rejected", reason: named, ...rejectionGuidance[named] };
    }
    const code = failed.success ? failed.data.error : "unavailable";
    return { kind: "refused", code, message: refusal(code) };
  }
  const result = loginResponseSchema.safeParse(payload);
  if (!result.success)
    return {
      kind: "refused",
      code: "unrecognized",
      message: "The server answered in a shape this interface cannot read.",
    };
  const session = result.data.sessionRef
    ? await readSessionStatus(result.data.sessionRef)
    : undefined;
  return {
    kind: "compiled",
    ...(result.data.plan ? { plan: result.data.plan } : {}),
    result: result.data,
    ...(session ? { session } : {}),
  };
}

/**
 * The server's own projection of the session it retained.
 *
 * Read rather than assumed: `verified` is recomputed from evidence the server
 * still holds, so a session whose evidence no longer describes the plan reports
 * false here however the login call once ended.
 */
async function readSessionStatus(
  sessionRef: string,
): Promise<SessionStatus | undefined> {
  try {
    const response = await post(
      "/api/v1/teaching/tools/browser-session-status",
      { sessionRef },
    );
    if (!response.ok) return undefined;
    return (await response.json()) as SessionStatus;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * Backend negotiation
 * ------------------------------------------------------------------ */

export type BackendNegotiation =
  | {
      kind: "offered";
      backends: BackendDescriptor[];
      /** True when no plan may turn verification off, whatever a client asks. */
      verificationRequired: boolean;
    }
  | { kind: "unavailable"; message: string };

const negotiationSchema = z.object({
  backends: z.array(
    z.object({
      backendId: z.string(),
      engine: z.enum(["chromium", "firefox", "webkit"]),
      ownership: z.enum(["attached-user", "managed"]),
      engineVersion: z.string(),
      capabilities: z.record(z.string(), z.boolean()),
    }),
  ),
  verificationRequired: z.boolean(),
});

/**
 * Which browsers this host actually has, asked before anything is offered.
 *
 * A choice a host cannot honour is disabled with the reason on it rather than
 * left selectable so a person can discover the wall by hitting it. The
 * capability booleans are the runtime's own, which is why an engine can be
 * present and still refuse a plan that demands containment it does not have.
 */
export async function readBackends(): Promise<BackendNegotiation> {
  let response: Response;
  try {
    response = await post(browserBackendsToolPath, {});
  } catch {
    return {
      kind: "unavailable",
      message: "The list of available browsers could not be read.",
    };
  }
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const failed = failureSchema.safeParse(payload);
    return {
      kind: "unavailable",
      message: refusal(failed.success ? failed.data.error : "unavailable"),
    };
  }
  const parsed = negotiationSchema.safeParse(payload);
  if (!parsed.success)
    return {
      kind: "unavailable",
      message: "The list of available browsers arrived in an unreadable shape.",
    };
  return {
    kind: "offered",
    backends: parsed.data.backends as unknown as BackendDescriptor[],
    verificationRequired: parsed.data.verificationRequired,
  };
}

/** Every engine the vocabulary has, so an absent one can be shown as absent. */
export const allEngines: readonly BrowserEngine[] = [
  "chromium",
  "firefox",
  "webkit",
];

export const engineLabels: Record<BrowserEngine, string> = {
  chromium: "Chromium",
  firefox: "Firefox",
  webkit: "WebKit",
};

export const ownershipLabels: Record<BrowserOwnership, string> = {
  managed: "A browser this workspace launches",
  "attached-user": "My own browser, through the companion",
};

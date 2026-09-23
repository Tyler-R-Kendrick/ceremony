import type { ActorContext } from "../../core/operation-contracts.js";
import type {
  CapabilityStatus,
  CompatibilityIssue,
  ConfigurationRequirement,
  ConnectorSourceIdentity,
  CredentialCustody,
  Ecosystem,
  EvidenceTargetInput,
  NormalizedDefinition,
  OwnerKind,
  RuntimeClass,
  SourceRecord,
  SupportLevel,
  VerificationClaim,
} from "./adapter-types.js";
import type {
  ApprovedDestination,
  BoundOperation,
  RuntimeBinding,
} from "./binding.js";
import type {
  Clock,
  ConfigurationPort,
  ConnectionRecord,
  CredentialCustodyPort,
  EffectJournalPort,
  EvidenceStorePort,
  HandoffIssue,
  HandoffPort,
  HandoffRecord,
  RandomPort,
  VerifiedEventEnvelope,
} from "./ports.js";

export type {
  CapabilityStatus,
  CompatibilityIssue,
  ConfigurationRequirement,
  ConnectorSourceIdentity,
  CredentialCustody,
  Ecosystem,
  NormalizedDefinition,
  RuntimeClass,
  SourceRecord,
  SupportLevel,
  VerificationClaim,
} from "./adapter-types.js";

/*
 * A connector adapter is the protocol implementation for one ecosystem or
 * provider. It receives everything it needs through the call context — fetch,
 * clock, randomness, custody, handoffs, effects — and returns typed outcomes.
 * It does not persist connections, does not read headers or cookies, does not
 * derive an actor from its arguments, and cannot reach a destination its
 * binding does not approve. The command layer owns persistence, policy
 * rechecks and projections; adapters own wire correctness.
 */

export interface AdapterEnvironment {
  fetch: typeof fetch;
  now: Clock;
  random: RandomPort;
  credentials: CredentialCustodyPort;
  handoffs: HandoffPort;
  effects: EffectJournalPort;
  evidence?: EvidenceStorePort;
  configuration: ConfigurationPort;
  /** Exact trusted origin of this deployment; return routes are built from it, never from input. */
  origin: string;
}

export interface AdapterCallContext {
  actor: ActorContext;
  binding: RuntimeBinding;
  connection?: ConnectionRecord;
  /**
   * The pending handoff a completion continues, resolved by the command layer
   * (private human surface or tenant-scoped correlation); it carries the
   * protected transient material (PKCE verifier, device code, widget token).
   * Absent when the caller could not be shown it, in which case an adapter
   * that needs it reports `pending`, never an error that leaks it.
   */
  handoff?: HandoffRecord;
  /** Current connection generation; stale completions are fenced against it. */
  generation: number;
  signal: AbortSignal;
  environment: AdapterEnvironment;
}

export type AuthorizationIntent = {
  profileId?: string;
  ownerKind: OwnerKind;
  requestedPermissions: string[];
  target?: EvidenceTargetInput;
  /** Explicit human intent to replace the verified account; never inferred from a callback. */
  accountSwitch: boolean;
  /** A policy constraint; "none" may yield human-required, never a bypass. */
  interruption: "allowed" | "none";
};

export type HandoffProposal = Omit<
  HandoffIssue,
  "actor" | "connectionRef" | "bindingRef" | "generation"
>;

export type AuthorizationStart =
  | { kind: "handoff"; handoff: HandoffProposal }
  | { kind: "verify" }
  | { kind: "configuration-required"; missing: string[] }
  | { kind: "human-required"; code: string }
  | { kind: "unsupported"; code: string };

export type CompletionInput =
  | { kind: "redirect"; url: URL }
  | { kind: "event"; event: VerifiedEventEnvelope }
  | { kind: "poll" }
  | { kind: "input"; values: Record<string, string> };

export type CompletionResult = {
  state:
    | "complete"
    | "pending"
    | "denied"
    | "expired"
    | "indeterminate"
    | "human-required";
  claims: VerificationClaim[];
  credentialRef?: string;
  externalIds?: Record<string, string>;
  target?: EvidenceTargetInput;
  code?: string;
  /** A further handoff the completion requires (multi-round input, MFA). */
  handoff?: HandoffProposal;
  /** Bounded, non-secret adapter state to persist on the connection. */
  adapterState?: Record<string, unknown>;
  /**
   * The adapter already moved the handoff to its terminal state itself, under
   * the generation fence, before binding any credential (the OAuth grants in
   * `connectors/auth` do). The command layer then records that state on the
   * connection and does not complete the handoff a second time.
   */
  handoffSettled?: boolean;
};

export type InvokeRequest = {
  operationRef: string;
  input: unknown;
  commandId: string;
  /** Host-supplied only when the operation's replay policy accepts an upstream key. */
  idempotencyKey?: string;
};

export type InvokeResult = {
  state: "complete" | "failed" | "indeterminate" | "human-required" | "denied";
  output?: unknown;
  outputClassification: "public" | "personal" | "secret";
  effect: "read" | "write" | "unknown";
  code?: string;
  handoff?: HandoffProposal;
  effectRef?: string;
};

export type DisconnectScope = "local" | "broker" | "upstream";
export type DisconnectOutcome =
  "applied" | "unsupported" | "failed" | "not-attempted" | "indeterminate";
export type DisconnectResult = {
  local: DisconnectOutcome;
  broker: DisconnectOutcome;
  upstream: DisconnectOutcome;
  /** Other local connections that share the affected upstream grant, for impact review. */
  sharedWith?: string[];
};

export type DiscoverInput = {
  query?: string;
  cursor?: string;
  limit?: number;
  /** Adapter-specific scope selectors (project, workspace, environment); validated by the adapter. */
  scope?: Record<string, string>;
  refresh?: boolean;
};
export type DiscoveredItem = {
  identity: ConnectorSourceIdentity;
  displayName: string;
  description: string;
  /** Provenance markers the source itself reports, never trust on their own. */
  provenance?: Record<string, string>;
  sourceRef?: string;
  status?: "active" | "deprecated" | "deleted" | "unknown";
};
export type DiscoverResult = {
  items: DiscoveredItem[];
  nextCursor?: string;
  freshness: { fetchedAt: number; stale: boolean; source: "live" | "snapshot" };
  issues: CompatibilityIssue[];
};

export type ImportInput = {
  bytes: Uint8Array;
  mediaType: string;
  origin: SourceRecord["origin"];
  identityHint?: Partial<ConnectorSourceIdentity>;
  /** Registry or catalog metadata that accompanied the bytes; inert. */
  metadata?: Record<string, unknown>;
};
export type ImportOutcome = {
  source: SourceRecord;
  definitions: NormalizedDefinition[];
  issues: CompatibilityIssue[];
  executableCandidates: string[];
};

export type ExportRequest = {
  definition: NormalizedDefinition;
  format: string;
  includeNativeExtensions: boolean;
};
export type ExportOutcome = {
  mediaType: string;
  bytes: Uint8Array;
  losses: CompatibilityIssue[];
};

export type DelegateRequest = {
  skill: string;
  input: unknown;
  commandId: string;
  taskRef?: string;
  action: "start" | "status" | "cancel" | "input";
};

export interface EventPort {
  /** Authenticates a raw delivery for this authority; undefined means unverifiable, never accepted. */
  verify(
    ctx: AdapterCallContext,
    delivery: { headers: Headers; body: Uint8Array; receivedAt: number },
  ): Promise<VerifiedEventEnvelope | undefined>;
  subscribe?(
    ctx: AdapterCallContext,
    input: { destinationId: string; eventTypes: string[] },
  ): Promise<{ subscriptionId: string; state: "active" | "pending" }>;
  unsubscribe?(
    ctx: AdapterCallContext,
    subscriptionId: string,
  ): Promise<DisconnectOutcome>;
}

export interface ConnectorAdapter {
  readonly id: string;
  readonly ecosystem: Ecosystem;
  readonly adapterVersion: string;
  readonly runtime: RuntimeClass;
  readonly displayName: string;
  readonly description: string;
  /** Logical service key for directory grouping; grouping never merges grants. */
  readonly service: string;
  readonly support: SupportLevel;
  /**
   * `"definition"` when the adapter runs whatever description a person
   * imported (the generic OpenAPI and provider-catalog adapters): its own
   * suites prove the code path, not any provider behind an imported
   * definition, so support evidence speaks for one definition at a time.
   * Absent means `"adapter"`: one provider, and adapter-wide evidence speaks
   * for every connection through it. See `SupportLabelScope`.
   */
  readonly evidenceScope?: "adapter" | "definition";
  readonly custody: readonly CredentialCustody[];
  readonly configuration: readonly ConfigurationRequirement[];
  /** Protocol profiles this adapter implements, e.g. ["openapi-3.1", "openapi-3.0"]. */
  readonly profiles: readonly string[];
  /** Per-dimension status given which configuration names are present. */
  capabilities(present: ReadonlySet<string>): CapabilityStatus[];
  discover?(
    ctx: AdapterCallContext,
    input: DiscoverInput,
  ): Promise<DiscoverResult>;
  import?(ctx: AdapterCallContext, input: ImportInput): Promise<ImportOutcome>;
  authorize?(
    ctx: AdapterCallContext,
    intent: AuthorizationIntent,
  ): Promise<AuthorizationStart>;
  complete?(
    ctx: AdapterCallContext,
    input: CompletionInput,
  ): Promise<CompletionResult>;
  verify?(ctx: AdapterCallContext): Promise<CompletionResult>;
  invoke?(
    ctx: AdapterCallContext,
    request: InvokeRequest,
  ): Promise<InvokeResult>;
  events?: EventPort;
  reconnect?(
    ctx: AdapterCallContext,
    intent: AuthorizationIntent,
  ): Promise<AuthorizationStart>;
  disconnect?(
    ctx: AdapterCallContext,
    scope: DisconnectScope,
  ): Promise<DisconnectResult>;
  revoke?(ctx: AdapterCallContext): Promise<DisconnectResult>;
  export?(
    ctx: AdapterCallContext,
    request: ExportRequest,
  ): Promise<ExportOutcome>;
  delegate?(
    ctx: AdapterCallContext,
    request: DelegateRequest,
  ): Promise<InvokeResult>;
  /**
   * Compiles a reviewer's approval into this adapter's bound operations and
   * inert settings, for formats whose operations cannot be executed from the
   * normalized definition alone (an OpenAPI operation needs its parameter
   * plan). The command layer has already resolved every reviewer decision;
   * the adapter may only realise them, never widen them. Absent means the
   * command layer compiles the operations itself.
   */
  reviewBinding?(input: BindingReview): Promise<BindingReviewResult>;
  /**
   * Settings keys only the reviewed path writes (plans, profiles, per-profile
   * issuer policies). A reviewer's free-form `settings` naming one is refused,
   * as is `oauth`, which only the reviewed issuer policy sets.
   */
  readonly reservedSettings?: readonly string[];
  /**
   * Whether the adapter reads per-profile issuer policies
   * (`settings["oauth-profiles"]`). Approval refuses them for an adapter that
   * does not, rather than pinning a reviewed policy nothing would ever read.
   */
  readonly profileIssuerPolicies?: boolean;
}

/** One approved operation with every reviewer decision already resolved. */
export type ReviewedOperation = {
  nativeId: string;
  destinationId: string;
  effect: BoundOperation["effect"];
  outputClassification: BoundOperation["outputClassification"];
  cost: BoundOperation["cost"];
  consent: BoundOperation["consent"];
  replay: BoundOperation["replay"];
  targetParameters: string[];
  authenticationProfile?: string;
};

export type BindingReview = {
  definition: NormalizedDefinition;
  /** The exact bytes the definition was imported from, digest-checked; absent when the host kept none. */
  source?: { bytes: Uint8Array; mediaType: string };
  destinations: readonly ApprovedDestination[];
  operations: readonly ReviewedOperation[];
  /** The profile the binding executes, when the reviewer chose one. */
  profileId?: string;
  /** A read operation the reviewer named to verify credentials with. */
  verifier?: { nativeId: string; input?: unknown };
};

export type BindingReviewResult = {
  operations: BoundOperation[];
  /** Adapter-owned inert settings; merged under the reviewer's and pinned by the reviewed digest. */
  settings: Record<string, unknown>;
};

/** Trusted host construction only; a client argument never selects or adds an adapter. */
export class ConnectorAdapterRegistry {
  private readonly adapters = new Map<string, ConnectorAdapter>();
  register(adapter: ConnectorAdapter): void {
    if (!/^[a-z][a-z0-9-]{0,119}$/.test(adapter.id))
      throw new Error("Invalid adapter id");
    if (this.adapters.has(adapter.id))
      throw new Error("Adapter already registered");
    this.adapters.set(adapter.id, adapter);
  }
  get(id: string): ConnectorAdapter | undefined {
    return this.adapters.get(id);
  }
  require(id: string): ConnectorAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error("Unknown adapter");
    return adapter;
  }
  list(): ConnectorAdapter[] {
    return [...this.adapters.values()];
  }
}

/** Convenience for adapters: one status row per dimension with sensible defaults. */
export function capabilityStatus(
  adapter: Pick<ConnectorAdapter, "adapterVersion" | "runtime">,
  input: Pick<CapabilityStatus, "dimension" | "profile"> &
    Partial<
      Pick<
        CapabilityStatus,
        | "implementation"
        | "configuration"
        | "evidence"
        | "evidenceRef"
        | "limitations"
      >
    >,
): CapabilityStatus {
  const implementation = input.implementation ?? "implemented";
  return {
    dimension: input.dimension,
    profile: input.profile,
    adapterVersion: adapter.adapterVersion,
    runtime: adapter.runtime,
    implementation,
    configuration: input.configuration ?? "not-applicable",
    evidence:
      implementation === "unsupported"
        ? "not-tested"
        : (input.evidence ?? "unit"),
    ...(input.evidenceRef && implementation !== "unsupported"
      ? { evidenceRef: input.evidenceRef }
      : {}),
    limitations: input.limitations ?? [],
  };
}

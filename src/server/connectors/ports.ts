import type { ActorContext } from "../../core/operation-contracts.js";
import type {
  BindingRef,
  ConnectionRef,
  ConnectionSummary,
  ConnectorHandoffSummary,
  CredentialCustody,
  EvidenceRef,
  HandoffRef,
  NormalizedDefinition,
  OwnerKind,
  SourceRecord,
  VerificationClaim,
} from "../../core/connectors/index.js";
import type { RuntimeBinding } from "./binding.js";

/*
 * Ports are the seams between adapters and the deployment. Adapters receive
 * them and never construct them; the state layer implements them over the
 * shared encrypted store; tests may supply memory doubles. Every port takes the
 * authenticated actor where ownership matters, and none of them returns a
 * credential value to a caller that did not open a `use` callback.
 */

export type Clock = () => number;
export interface RandomPort {
  bytes(length: number): Uint8Array;
  uuid(): string;
}

export type CredentialMaterial = Readonly<Record<string, string>>;
export type CredentialScope = {
  tenantId: string;
  ownerKind: OwnerKind;
  ownerId: string;
  connectionRef: ConnectionRef;
  bindingRef: BindingRef;
  custody: CredentialCustody;
};

/**
 * Host-owned credential custody. Material is written once, used inside
 * trusted callbacks, refreshed under a single-flight lock and revoked by
 * reference. External brokers keep their own tokens; what this port holds for
 * them is the protected broker reference, under the matching custody kind.
 */
export interface CredentialCustodyPort {
  store(
    scope: CredentialScope,
    material: CredentialMaterial,
    options?: { expiresAt?: number; replaces?: string },
  ): Promise<string>;
  /** The callback's return value must not contain the material. */
  use<T>(
    scope: CredentialScope,
    ref: string,
    work: (material: CredentialMaterial) => Promise<T>,
  ): Promise<T>;
  /**
   * Single-flight rotation: concurrent callers share one refresh, and a result
   * computed against an older generation cannot overwrite a newer one.
   */
  refresh(
    scope: CredentialScope,
    ref: string,
    work: (
      current: CredentialMaterial,
    ) => Promise<{ material: CredentialMaterial; expiresAt?: number }>,
  ): Promise<{ ref: string; expiresAt?: number }>;
  revoke(scope: CredentialScope, ref: string): Promise<void>;
  describe(
    scope: CredentialScope,
    ref: string,
  ): Promise<{ custody: CredentialCustody; expiresAt?: number } | undefined>;
}

export type HandoffIssue = {
  actor: ActorContext;
  connectionRef: ConnectionRef;
  bindingRef: BindingRef;
  generation: number;
  kind: ConnectorHandoffSummary["kind"];
  presentation: ConnectorHandoffSummary["presentation"];
  expiresAt: number;
  /** Sanitized purpose code; never provider prose. */
  intent: string;
  /** External correlation (OAuth state, broker session id) used to route a completion back. */
  correlationKey?: string;
  /** Protected transient material: destination URL, PKCE verifier, widget token, device code. */
  private: Record<string, string>;
};
export type HandoffRecord = Omit<HandoffIssue, "actor"> & {
  handoffRef: HandoffRef;
  tenantId: string;
  subjectId: string;
  sessionId: string;
  state: ConnectorHandoffSummary["state"];
  issuedAt: number;
};

export interface HandoffPort {
  issue(
    input: HandoffIssue,
  ): Promise<{ handoffRef: HandoffRef; summary: ConnectorHandoffSummary }>;
  /** Private human surface only: the initiating human's own pending handoff. */
  present(
    actor: ActorContext,
    handoffRef: HandoffRef,
  ): Promise<HandoffRecord | undefined>;
  /** Routes an external completion by its correlation key within one tenant; grants nothing. */
  resolveCorrelation(
    tenantId: string,
    correlationKey: string,
  ): Promise<HandoffRecord | undefined>;
  /** One-use completion fenced by generation; a stale or repeated completion is refused. */
  complete(
    handoffRef: HandoffRef,
    expectedGeneration: number,
    state: Exclude<ConnectorHandoffSummary["state"], "issued" | "waiting">,
  ): Promise<HandoffRecord>;
  cancelAll(connectionRef: ConnectionRef, reason: string): Promise<number>;
}

/** The full server-side connection record; projections pick what leaves it. */
export type ConnectionRecord = ConnectionSummary & {
  tenantId: string;
  ownerId: string;
  /** Present for session-bound connections; absent for durable owner connections. */
  sessionId?: string;
  authorityInstance: string;
  bindingRevision: number;
  policyRevision: string;
  configurationRevision: string;
  credentialRef?: string;
  /** Native upstream identifiers, keyed by a bounded name (connectionId, installationId ...). */
  externalIds: Record<string, string>;
  evidenceRefs: EvidenceRef[];
  /** Sanitized, bounded adapter state that is not a credential (cursor, account choice). */
  state: Record<string, unknown>;
};

export interface ConnectionStorePort {
  create(record: ConnectionRecord): Promise<{ revision: number }>;
  /** Undefined for missing *and* foreign records: ownership failures leak no existence. */
  get(
    actor: ActorContext,
    connectionRef: ConnectionRef,
  ): Promise<{ record: ConnectionRecord; revision: number } | undefined>;
  update(
    actor: ActorContext,
    connectionRef: ConnectionRef,
    expectedRevision: number,
    patch: Partial<
      Omit<
        ConnectionRecord,
        "connectionRef" | "tenantId" | "ownerId" | "ownerKind" | "createdAt"
      >
    >,
  ): Promise<{ revision: number }>;
  list(
    actor: ActorContext,
    filter?: {
      ecosystem?: string;
      bindingRef?: BindingRef;
      lifecycle?: ConnectionSummary["lifecycle"];
    },
  ): Promise<Array<{ record: ConnectionRecord; revision: number }>>;
  /** Fences later callbacks, refreshes and invocations against the previous generation. */
  advanceGeneration(
    actor: ActorContext,
    connectionRef: ConnectionRef,
    expectedRevision: number,
  ): Promise<{ generation: number; revision: number }>;
  /** Exact match on authority instance and external id within one tenant; never a display-name match. */
  findByExternalId(
    tenantId: string,
    authorityInstance: string,
    name: string,
    value: string,
  ): Promise<{ record: ConnectionRecord; revision: number } | undefined>;
}

export interface EvidenceStorePort {
  append(
    actor: ActorContext,
    connectionRef: ConnectionRef,
    claim: VerificationClaim,
  ): Promise<EvidenceRef>;
  list(
    actor: ActorContext,
    connectionRef: ConnectionRef,
  ): Promise<VerificationClaim[]>;
  /** Marks claims stale after source, policy or configuration drift; returns the count. */
  invalidate(
    actor: ActorContext,
    connectionRef: ConnectionRef,
    reason: string,
  ): Promise<number>;
}

export type EffectIntent = {
  actor: ActorContext;
  connectionRef?: ConnectionRef;
  bindingRef?: BindingRef;
  /** Operation identity, e.g. "vercel.token.acquire" or an operationRef. */
  operation: string;
  /** Digest of the exact request that defines "the same effect". */
  digest: string;
  /** Upstream idempotency key and its documented scope, when the provider offers one. */
  idempotency?: { key: string; scope: string };
  commandId?: string;
};
export type EffectOutcome = {
  status: "applied" | "not-applied" | "failed" | "indeterminate" | "reconciled";
  code?: string;
  at: number;
};
export interface EffectJournalPort {
  /** Persists intent before the call; a repeated digest returns the earlier outcome instead of a new effect. */
  begin(
    intent: EffectIntent,
  ): Promise<{ effectRef: string; prior?: EffectOutcome }>;
  complete(effectRef: string, outcome: EffectOutcome): Promise<void>;
  get(
    actor: ActorContext,
    effectRef: string,
  ): Promise<EffectOutcome | undefined>;
}

export interface SourceArtifactPort {
  put(
    tenantId: string,
    bytes: Uint8Array,
    meta: { mediaType: string; digest: string; retainUntil?: number },
  ): Promise<string>;
  get(
    tenantId: string,
    artifactRef: string,
  ): Promise<
    { bytes: Uint8Array; mediaType: string; digest: string } | undefined
  >;
  delete(tenantId: string, artifactRef: string): Promise<void>;
}

export interface DefinitionStorePort {
  putSource(tenantId: string, source: SourceRecord): Promise<void>;
  getSource(
    tenantId: string,
    sourceRef: string,
  ): Promise<SourceRecord | undefined>;
  putDefinition(
    tenantId: string,
    definition: NormalizedDefinition,
  ): Promise<void>;
  getDefinition(
    tenantId: string,
    definitionRef: string,
  ): Promise<NormalizedDefinition | undefined>;
  listDefinitions(
    tenantId: string,
    filter?: { ecosystem?: string },
  ): Promise<NormalizedDefinition[]>;
  /** Bindings are immutable per revision; a new revision is a new record. */
  putBinding(binding: RuntimeBinding): Promise<void>;
  getBinding(
    tenantId: string,
    bindingRef: string,
    revision?: number,
  ): Promise<RuntimeBinding | undefined>;
  listBindings(
    tenantId: string,
    filter?: { definitionRef?: string; adapterId?: string },
  ): Promise<RuntimeBinding[]>;
}

/** Private configuration lookup bound to an actor by the command layer; values never leave server code. */
export interface ConfigurationPort {
  read(name: string): Promise<string | undefined>;
  /** Names present, for readiness reports; never values. */
  present(names: readonly string[]): Promise<ReadonlySet<string>>;
  /** Revision that changes when any named value changes; part of the connection key. */
  revision(): Promise<string>;
}

/**
 * Minimal verified-event shape adapters may return; the events module owns the
 * full schema (`verifiedEventEnvelopeSchema`) and every envelope it builds is
 * assignable here. Optional fields admit an explicit `undefined` so a builder
 * may spread one without dropping the key first; a reader sees `T | undefined`
 * either way.
 */
export type VerifiedEventEnvelope = {
  eventId: string;
  authority: string;
  providerEventType: string;
  receivedAt: number;
  sourceTime?: number | undefined;
  verification: {
    method: "standard-webhooks" | "vendor-signature" | "forwarder-signature";
    keyId?: string | undefined;
  };
  connectionRef?: ConnectionRef | undefined;
  payloadClassification: "public" | "personal" | "secret";
  payload: unknown;
};

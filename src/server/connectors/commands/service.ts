import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ActorContext } from "../../../core/operation-contracts.js";
import {
  agentConnectorProjection,
  authorReviewProjection,
  bindingReferenceSchema,
  canonicalConnectorJson,
  connectorImportResultSchema,
  humanConnectionProjection,
  normalizedDefinitionSchema,
  normalizedDigestOf,
  sourceRecordSchema,
  verificationClaimSchema,
  type BindingReference,
  type CatalogEntry,
  type ConnectionSummary,
  type ConnectorImportResult,
  type HumanPresentation,
  type NormalizedDefinition,
  type SourceRecord,
  type VerificationClaim,
} from "../../../core/connectors/index.js";
import {
  AuthorizationError,
  requireCapability,
  type Capability,
} from "../../identity.js";
import { PersistenceConflict } from "../../persistence/index.js";
import type { AgentConnectorDependencies } from "../agents/intents.js";
import type {
  AdapterCallContext,
  AuthorizationIntent,
  AuthorizationStart,
  CompletionResult,
  ConnectorAdapter,
  ConnectorAdapterRegistry,
  DisconnectResult,
  HandoffProposal,
  ImportInput as AdapterImportInput,
  ImportOutcome,
  InvokeResult,
} from "../adapter.js";
import {
  boundOperation,
  runtimeBindingSchema,
  type ApprovedDestination,
  type BoundOperation,
  type RuntimeBinding,
} from "../binding.js";
import { ConnectorError } from "../errors.js";
import { catalogFor } from "../inventory.js";
import type {
  Clock,
  ConfigurationPort,
  ConnectionRecord,
  ConnectionStorePort,
  CredentialCustodyPort,
  CredentialScope,
  DefinitionStorePort,
  EffectJournalPort,
  EffectOutcome,
  EvidenceStorePort,
  HandoffPort,
  HandoffRecord,
  RandomPort,
  SourceArtifactPort,
  VerifiedEventEnvelope,
} from "../ports.js";
import {
  SERVER_EXTENSION,
  TRANSPORT_EXTENSION,
  bindingApprovalSchema,
  configureInputSchema,
  connectInputSchema,
  disconnectInputSchema,
  handoffValuesSchema,
  importInputSchema,
  intentInputSchema,
  invokeInputSchema,
  reconnectInputSchema,
  type BindingApprovalInput,
  type ConfigureInput,
  type ConnectInput,
  type DisconnectInput,
  type ImportInput,
  type IntentInput,
  type InvokeInput,
  type OperationApproval,
  type ReconnectInput,
} from "./inputs.js";
import type { ConnectorPolicy, PolicySubject } from "./policy.js";

/*
 * The command layer. Every command takes the authenticated actor first and
 * never a tenant, subject or session from its input; every effect boundary
 * rechecks host policy; intent is persisted before an external call; every
 * response is a positive projection chosen by actor kind. Adapters own wire
 * correctness and receive everything through the call context; this class
 * owns persistence, fencing, evidence, consent and what leaves the server.
 */

export type HumanConnectionView = ReturnType<typeof humanConnectionProjection>;
export type AgentConnectionView = ReturnType<typeof agentConnectorProjection>;
export type ConnectionView = HumanConnectionView | AgentConnectionView;

export type InvokeResponse = {
  state: InvokeResult["state"];
  effect: BoundOperation["effect"];
  outputClassification: BoundOperation["outputClassification"];
  output?: unknown;
  /** The effect ran (or was replayed) but this actor may not see the output. */
  outputWithheld?: true;
  code?: string;
  effectRef?: string;
  /** A repeated command returned the journaled outcome; no second effect occurred. */
  replayed?: true;
  handoff?: { kind: string; state: string };
  presentation?: HumanPresentation;
};

export type DefinitionListEntry = {
  definitionRef: string;
  identity: NormalizedDefinition["identity"];
  display: NormalizedDefinition["display"];
  issues: { blocking: number; warning: number; info: number };
};

export type ConnectorImporter = (
  input: AdapterImportInput,
  context: { actor: ActorContext; signal: AbortSignal; fetch: typeof fetch },
) => Promise<ImportOutcome | undefined>;

/** The private path configuration values take; names come back, values never do. */
export interface ConfigurationWriter {
  consume(
    actor: ActorContext,
    secretRef: string,
  ): Promise<Record<string, string> | undefined>;
  write(
    actor: ActorContext,
    values: Record<string, string>,
  ): Promise<{ revision: string }>;
}

export interface ConnectorCommandPorts {
  connections: ConnectionStorePort;
  evidence: EvidenceStorePort;
  effects: EffectJournalPort;
  handoffs: HandoffPort;
  credentials: CredentialCustodyPort;
  definitions: DefinitionStorePort;
  artifacts: SourceArtifactPort;
}

export interface ConnectorCommandServiceOptions {
  registry: ConnectorAdapterRegistry;
  ports: ConnectorCommandPorts;
  /** Private configuration bound to the actor; values never leave server code. */
  configuration(actor: ActorContext): ConfigurationPort;
  policy: ConnectorPolicy;
  /** The approved fetcher (SSRF controls, no automatic redirects, bounds). */
  fetch: typeof fetch;
  /** Exact trusted origin of this deployment; callback and return routes derive from it. */
  origin: string;
  now?: Clock;
  random?: RandomPort;
  /** Format importers (OpenAPI, Arazzo, AsyncAPI ...); an adapter's own `import` is used when named. */
  importers?: readonly ConnectorImporter[];
  configure?: ConfigurationWriter;
  /** Upper bound on any adapter call, including the provider round trips inside it. */
  callTimeoutMs?: number;
}

export const CONNECTOR_CALLBACK_PATH = "/api/v1/connectors/callback";
const MAX_HANDOFF_MS = 24 * 60 * 60 * 1000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const dottedCode = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){0,11}$/;
const externalIdName = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;
const configurationName = /^[A-Z][A-Z0-9_]{0,95}$/;
const classificationRank = { public: 0, personal: 1, secret: 2 } as const;

type ConnectionEntry = { record: ConnectionRecord; revision: number };
type ConnectionPatch = Parameters<ConnectionStorePort["update"]>[3];
type HandoffHandle = { handoffRef: string; generation: number };

const sha256Hex = (value: unknown) =>
  createHash("sha256").update(canonicalConnectorJson(value)).digest("hex");
const iso = (ms: number) => new Date(ms).toISOString();
const code = (value: string | undefined, fallback: string) =>
  value && value.length <= 120 && dottedCode.test(value) ? value : fallback;
/**
 * The handoff this connection is actually waiting on. A handoff issued for an
 * earlier generation was superseded when the generation advanced, so it is
 * neither pending nor projected — it cannot be completed, presented or
 * cancelled as if it still belonged here.
 */
const pending = (record: ConnectionRecord) =>
  record.handoff &&
  record.handoff.generation === record.generation &&
  (record.handoff.state === "issued" || record.handoff.state === "waiting")
    ? record.handoff
    : undefined;
const currentHandoff = (record: ConnectionRecord) =>
  record.handoff && record.handoff.generation === record.generation
    ? record.handoff
    : undefined;
const closed = (record: ConnectionRecord) =>
  record.lifecycle === "locally-disconnected" ||
  record.lifecycle === "upstream-revoked";
const deleted = (record: ConnectionRecord) => record.state.deleted === true;

function requireAny(actor: ActorContext, capabilities: Capability[]): void {
  if (
    !actor.capabilities.includes("admin") &&
    !capabilities.some((capability) => actor.capabilities.includes(capability))
  )
    throw new AuthorizationError("denied");
}

/** Port failures in the connector vocabulary; ownership failures leak no existence. */
async function port<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ConnectorError || error instanceof AuthorizationError)
      throw error;
    if (error instanceof PersistenceConflict)
      throw new ConnectorError("conflict", { cause: error });
    if (error instanceof Error) {
      if (/conflict|stale|already/i.test(error.message))
        throw new ConnectorError("conflict", { cause: error });
      if (/denied|unknown|not found/i.test(error.message))
        throw new ConnectorError("not-found", { cause: error });
    }
    throw error;
  }
}

/** Adapter failures never reach a caller as text; only a code does. */
async function adapterCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    if (error instanceof z.ZodError)
      throw new ConnectorError("invalid-request", {
        detail: "adapter.input",
        cause: error,
      });
    if (error instanceof DOMException && error.name === "AbortError")
      throw new ConnectorError("upstream-unavailable", {
        detail: "adapter.timeout",
        cause: error,
      });
    throw new ConnectorError("upstream-unavailable", {
      detail: "adapter.failure",
      cause: error,
    });
  }
}

function presentationOf(
  material: Readonly<Record<string, string>>,
): HumanPresentation | undefined {
  const shown: HumanPresentation = {};
  if (material.url !== undefined) shown.url = material.url;
  if (material.userCode !== undefined) shown.userCode = material.userCode;
  if (material.instructions !== undefined)
    shown.instructions = material.instructions;
  return Object.keys(shown).length ? shown : undefined;
}

function intentOf(record: ConnectionRecord): IntentInput {
  const parsed = intentInputSchema.safeParse(record.state.intent);
  return parsed.success
    ? parsed.data
    : {
        requestedPermissions: [],
        accountSwitch: false,
        interruption: "allowed",
      };
}

function toAdapterIntent(
  intent: IntentInput,
  ownerKind: ConnectionRecord["ownerKind"],
  profileId: string | undefined,
): AuthorizationIntent {
  return {
    ...(profileId ? { profileId } : {}),
    ownerKind,
    requestedPermissions: [...intent.requestedPermissions],
    ...(intent.target ? { target: intent.target } : {}),
    accountSwitch: intent.accountSwitch,
    interruption: intent.interruption,
  };
}

function boundedState(
  current: Record<string, unknown>,
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(extra ?? {}))
    if (
      /^[^\p{Cc}]{1,120}$/u.test(key) &&
      !["__proto__", "prototype", "constructor", "intent", "deleted"].includes(
        key,
      )
    )
      merged[key] = value;
  if (
    Object.keys(merged).length > 64 ||
    Buffer.byteLength(JSON.stringify(merged)) > 65536
  )
    throw new ConnectorError("invalid-request", { detail: "state.bounds" });
  return merged;
}

export class ConnectorCommandService {
  readonly registry: ConnectorAdapterRegistry;
  readonly origin: string;
  readonly policy: ConnectorPolicy;
  private readonly ports: ConnectorCommandPorts;
  private readonly now: Clock;
  private readonly random: RandomPort;
  private readonly callTimeoutMs: number;

  constructor(private readonly options: ConnectorCommandServiceOptions) {
    const origin = new URL(options.origin);
    if (origin.origin !== options.origin)
      throw new Error("Connector command origin must be an exact origin");
    this.registry = options.registry;
    this.origin = options.origin;
    this.policy = options.policy;
    this.ports = options.ports;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? {
      bytes: (length) => new Uint8Array(randomBytes(length)),
      uuid: () => randomUUID(),
    };
    this.callTimeoutMs = options.callTimeoutMs ?? 30_000;
  }

  /** The exact callback URL adapters must register; built from the origin, never from input. */
  get callbackUrl(): string {
    return `${this.origin}${CONNECTOR_CALLBACK_PATH}`;
  }

  private async authorize(
    actor: ActorContext,
    subject: PolicySubject,
    action: Parameters<ConnectorPolicy["authorize"]>[2],
    detail = "policy.denied",
  ): Promise<void> {
    let allowed = false;
    try {
      allowed = await this.policy.authorize(actor, subject, action);
    } catch {
      allowed = false;
    }
    if (!allowed) throw new ConnectorError("denied", { detail });
  }

  private context(
    actor: ActorContext,
    binding: RuntimeBinding,
    connection?: ConnectionRecord,
    handoff?: HandoffRecord,
  ): AdapterCallContext {
    return {
      actor,
      binding,
      ...(connection ? { connection } : {}),
      ...(handoff ? { handoff } : {}),
      generation: connection?.generation ?? 0,
      signal: AbortSignal.timeout(this.callTimeoutMs),
      environment: {
        fetch: this.options.fetch,
        now: this.now,
        random: this.random,
        credentials: this.ports.credentials,
        handoffs: this.ports.handoffs,
        effects: this.ports.effects,
        evidence: this.ports.evidence,
        configuration: this.options.configuration(actor),
        origin: this.origin,
      },
    };
  }

  private adapterFor(binding: string | Pick<RuntimeBinding, "adapterId">) {
    const adapter = this.registry.get(
      typeof binding === "string" ? binding : binding.adapterId,
    );
    if (!adapter)
      throw new ConnectorError("unsupported", {
        detail: "adapter.unavailable",
      });
    return adapter;
  }

  private async binding(
    tenantId: string,
    bindingRef: string,
    revision?: number,
  ): Promise<RuntimeBinding> {
    const binding = await this.ports.definitions.getBinding(
      tenantId,
      bindingRef,
      revision,
    );
    if (!binding || binding.tenantId !== tenantId)
      throw new ConnectorError("not-found", { detail: "binding.unknown" });
    return binding;
  }

  private approved(binding: RuntimeBinding): RuntimeBinding {
    if (binding.status !== "approved")
      throw new ConnectorError("denied", { detail: "binding.not-approved" });
    return binding;
  }

  private async definition(
    tenantId: string,
    definitionRef: string,
  ): Promise<NormalizedDefinition> {
    const definition = await this.ports.definitions.getDefinition(
      tenantId,
      definitionRef,
    );
    if (!definition)
      throw new ConnectorError("not-found", { detail: "definition.unknown" });
    return definition;
  }

  /** Missing and foreign records are the same absence. */
  private async connection(
    actor: ActorContext,
    connectionRef: string,
  ): Promise<ConnectionEntry> {
    const entry = await port(() =>
      this.ports.connections.get(actor, connectionRef),
    );
    if (!entry || deleted(entry.record))
      throw new ConnectorError("not-found", { detail: "connection.unknown" });
    return entry;
  }

  private async update(
    actor: ActorContext,
    entry: ConnectionEntry,
    patch: ConnectionPatch,
  ): Promise<ConnectionEntry> {
    const updated = await port(() =>
      this.ports.connections.update(
        actor,
        entry.record.connectionRef,
        entry.revision,
        patch,
      ),
    );
    const record = { ...entry.record, ...patch } as ConnectionRecord;
    return { record, revision: updated.revision };
  }

  private summary(entry: ConnectionEntry): ConnectionSummary {
    const r = entry.record;
    return {
      connectionRef: r.connectionRef,
      bindingRef: r.bindingRef,
      definitionRef: r.definitionRef,
      ecosystem: r.ecosystem,
      service: r.service,
      displayName: r.displayName,
      ownerKind: r.ownerKind,
      custody: r.custody,
      runtime: r.runtime,
      lifecycle: r.lifecycle,
      generation: r.generation,
      revision: entry.revision,
      ...(r.target ? { target: r.target } : {}),
      ...(r.verification ? { verification: r.verification } : {}),
      ...(currentHandoff(r) ? { handoff: r.handoff } : {}),
      ...(r.lastOutcome ? { lastOutcome: r.lastOutcome } : {}),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  private project(
    actor: ActorContext,
    entry: ConnectionEntry,
    presentation?: HumanPresentation,
  ): ConnectionView {
    const summary = this.summary(entry);
    if (actor.actorKind === "agent") return agentConnectorProjection(summary);
    return humanConnectionProjection(
      summary,
      actor.actorKind === "human" ? presentation : undefined,
    );
  }

  /** The initiating human's own pending handoff, or nothing. */
  private async pendingHandoff(
    actor: ActorContext,
    record: ConnectionRecord,
  ): Promise<HandoffRecord | undefined> {
    const summary = pending(record);
    if (!summary || actor.actorKind !== "human") return undefined;
    const handoff = await this.ports.handoffs.present(
      actor,
      summary.handoffRef,
    );
    if (
      !handoff ||
      handoff.connectionRef !== record.connectionRef ||
      handoff.generation !== record.generation ||
      (handoff.state !== "issued" && handoff.state !== "waiting")
    )
      return undefined;
    return handoff;
  }

  private scope(record: ConnectionRecord): CredentialScope {
    return {
      tenantId: record.tenantId,
      ownerKind: record.ownerKind,
      ownerId: record.ownerId,
      connectionRef: record.connectionRef,
      bindingRef: record.bindingRef,
      custody: record.custody,
    };
  }

  // ---------------------------------------------------------------- catalog

  async catalog(actor: ActorContext): Promise<CatalogEntry[]> {
    requireCapability(actor, "executor");
    await this.authorize(actor, { kind: "catalog" }, "catalog");
    const configuration = this.options.configuration(actor);
    const presence = new Map<string, ReadonlySet<string>>();
    for (const adapter of this.registry.list())
      presence.set(
        adapter.id,
        await configuration.present(
          adapter.configuration.map((item) => item.name),
        ),
      );
    return catalogFor(
      this.registry,
      (adapter) => presence.get(adapter.id) ?? new Set(),
    );
  }

  // ------------------------------------------------------------ definitions

  async listDefinitions(actor: ActorContext): Promise<DefinitionListEntry[]> {
    requireAny(actor, ["author", "reviewer"]);
    await this.authorize(actor, { kind: "catalog" }, "review");
    const definitions = await this.ports.definitions.listDefinitions(
      actor.tenantId,
    );
    return definitions.map((definition) => ({
      definitionRef: definition.definitionRef,
      identity: { ...definition.identity },
      display: { ...definition.display },
      issues: {
        blocking: definition.compatibility.issues.filter(
          (issue) => issue.severity === "blocking",
        ).length,
        warning: definition.compatibility.issues.filter(
          (issue) => issue.severity === "warning",
        ).length,
        info: definition.compatibility.issues.filter(
          (issue) => issue.severity === "info",
        ).length,
      },
    }));
  }

  async getDefinition(
    actor: ActorContext,
    definitionRef: string,
  ): Promise<ReturnType<typeof authorReviewProjection>> {
    requireAny(actor, ["author", "reviewer"]);
    const definition = await this.definition(actor.tenantId, definitionRef);
    await this.authorize(actor, { kind: "definition", definition }, "review");
    const source = await this.ports.definitions.getSource(
      actor.tenantId,
      definition.sourceRef,
    );
    if (!source)
      throw new ConnectorError("not-found", { detail: "source.unknown" });
    return authorReviewProjection(definition, source);
  }

  // ----------------------------------------------------------------- import

  async import(
    actor: ActorContext,
    rawInput: unknown,
  ): Promise<ConnectorImportResult> {
    requireCapability(actor, "author");
    const input: ImportInput = importInputSchema.parse(rawInput);
    await this.authorize(
      actor,
      {
        kind: "import",
        origin: input.kind,
        ...(input.adapterId ? { adapterId: input.adapterId } : {}),
      },
      "import",
    );
    const captured = await this.captureSource(input);
    const signal = AbortSignal.timeout(this.callTimeoutMs);
    const adapterInput: AdapterImportInput = {
      bytes: captured.bytes,
      mediaType: captured.mediaType,
      origin: captured.origin,
    };
    let outcome: ImportOutcome | undefined;
    if (input.adapterId) {
      const adapter = this.registry.get(input.adapterId);
      if (!adapter?.import)
        throw new ConnectorError("unsupported", {
          detail: "import.adapter-unsupported",
        });
      outcome = await adapterCall(() =>
        adapter.import!(
          this.context(actor, this.importContextBinding(adapter, actor)),
          adapterInput,
        ),
      );
    } else {
      for (const importer of this.options.importers ?? []) {
        outcome = await adapterCall(() =>
          importer(adapterInput, { actor, signal, fetch: this.options.fetch }),
        );
        if (outcome) break;
      }
    }
    if (!outcome)
      throw new ConnectorError("unsupported", { detail: "import.no-importer" });
    return this.persistImport(actor, captured, outcome);
  }

  private importContextBinding(
    adapter: ConnectorAdapter,
    actor: ActorContext,
  ): RuntimeBinding {
    // An import runs with no approved destination: nothing to fetch, nothing
    // to sign. A well-formed adapter cannot reach the network from here.
    return runtimeBindingSchema.parse({
      bindingRef: "binding:import-context",
      definitionRef: "definition:import-context",
      revision: 0,
      adapterId: adapter.id,
      adapterVersion: adapter.adapterVersion,
      runtime: adapter.runtime,
      custody: "no-credential",
      authorityInstance: "",
      status: "retired",
      approvedAt: iso(this.now()),
      policyRevision: this.policy.revision,
      tenantId: actor.tenantId,
      destinations: [],
      operations: [],
      configuration: [],
      permittedTargets: [],
      reviewedDigest: sha256Hex("import-context"),
      settings: {},
    });
  }

  private async captureSource(input: ImportInput): Promise<{
    bytes: Uint8Array;
    mediaType: string;
    origin: SourceRecord["origin"];
  }> {
    if (input.kind === "upload")
      return {
        bytes: new TextEncoder().encode(input.text),
        mediaType: input.mediaType.toLowerCase(),
        origin: { kind: "upload" },
      };
    const url = new URL(input.url);
    if (
      url.username ||
      url.password ||
      url.hash ||
      (url.protocol !== "https:" && url.protocol !== "http:")
    )
      throw new ConnectorError("network-policy", { detail: "import.url" });
    let response: Response;
    try {
      response = await this.options.fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          accept:
            "application/json, application/yaml, application/x-yaml, text/yaml, */*;q=0.1",
        },
      });
    } catch (error) {
      throw new ConnectorError("upstream-unavailable", {
        detail: "import.fetch",
        cause: error,
      });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ConnectorError("upstream-rejected", {
        detail: "import.fetch-status",
      });
    }
    const limit = 4 * 1024 * 1024;
    const reader = response.body?.getReader();
    if (!reader)
      throw new ConnectorError("upstream-rejected", { detail: "import.empty" });
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw new ConnectorError("invalid-request", {
          detail: "import.too-large",
        });
      }
      chunks.push(value);
    }
    const mediaType =
      response.headers.get("content-type")?.split(";")[0]?.trim() ||
      "application/octet-stream";
    return {
      bytes: Buffer.concat(chunks),
      mediaType: /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mediaType)
        ? mediaType.toLowerCase()
        : "application/octet-stream",
      origin: { kind: "url", location: `${url.origin}${url.pathname}` },
    };
  }

  private async persistImport(
    actor: ActorContext,
    captured: { bytes: Uint8Array; mediaType: string },
    outcome: ImportOutcome,
  ): Promise<ConnectorImportResult> {
    const byteDigest = createHash("sha256")
      .update(captured.bytes)
      .digest("hex");
    const sourceRef = `source:${sha256Hex([actor.tenantId, byteDigest]).slice(0, 40)}`;
    const artifactRef = await this.ports.artifacts.put(
      actor.tenantId,
      captured.bytes,
      { mediaType: captured.mediaType, digest: byteDigest },
    );
    const source = sourceRecordSchema.parse({
      ...outcome.source,
      sourceRef,
      digest: { algorithm: "sha256", value: byteDigest },
      byteLength: captured.bytes.byteLength,
      mediaType: captured.mediaType,
      artifactRef,
    });
    await this.ports.definitions.putSource(actor.tenantId, source);
    const refs: string[] = [];
    for (const [index, candidate] of outcome.definitions.entries()) {
      const definitionRef = `definition:${sha256Hex([
        actor.tenantId,
        sourceRef,
        index,
        candidate.identity,
      ]).slice(0, 40)}`;
      const body = { ...candidate, definitionRef, sourceRef };
      const definition = normalizedDefinitionSchema.parse({
        ...body,
        normalizedDigest: await normalizedDigestOf(body),
      });
      await this.ports.definitions.putDefinition(actor.tenantId, definition);
      refs.push(definitionRef);
    }
    return connectorImportResultSchema.parse({
      sourceRef,
      definitions: refs,
      issues: outcome.issues,
      executableCandidates: outcome.executableCandidates,
    });
  }

  // --------------------------------------------------------------- bindings

  async listBindings(actor: ActorContext): Promise<BindingReference[]> {
    requireCapability(actor, "executor");
    const bindings = await this.ports.definitions.listBindings(actor.tenantId);
    return bindings
      .filter((binding) => binding.tenantId === actor.tenantId)
      .map((binding) => this.reference(binding));
  }

  private reference(binding: RuntimeBinding): BindingReference {
    return bindingReferenceSchema.parse({
      bindingRef: binding.bindingRef,
      definitionRef: binding.definitionRef,
      revision: binding.revision,
      adapterId: binding.adapterId,
      adapterVersion: binding.adapterVersion,
      runtime: binding.runtime,
      custody: binding.custody,
      authorityInstance: binding.authorityInstance,
      status: binding.status,
      approvedAt: binding.approvedAt,
      policyRevision: binding.policyRevision,
    });
  }

  /**
   * Review: turns a description into an executable binding, one explicit
   * decision at a time. A definition never approves its own servers; the
   * reviewer names each destination, and host policy decides its network
   * class. Every operation is compiled from the definition plus the
   * reviewer's overrides, and the whole reviewed set is digested into the
   * binding so a changed source or policy cannot reuse this approval.
   */
  async approveBinding(
    actor: ActorContext,
    rawInput: unknown,
  ): Promise<BindingReference> {
    requireAny(actor, ["reviewer", "publisher"]);
    const input: BindingApprovalInput = bindingApprovalSchema.parse(rawInput);
    const definition = await this.definition(
      actor.tenantId,
      input.definitionRef,
    );
    const adapter = this.adapterFor(input.adapterId);
    await this.authorize(actor, { kind: "definition", definition }, "approve");
    if (
      definition.compatibility.issues.some(
        (issue) =>
          issue.severity === "blocking" &&
          issue.executionImpact === "blocks-definition",
      )
    )
      throw new ConnectorError("denied", { detail: "definition.blocked" });
    const approvals = input.approvals;
    const profile = approvals.profileId
      ? definition.authentication.find(
          (item) => item.id === approvals.profileId,
        )
      : undefined;
    if (approvals.profileId && !profile)
      throw new ConnectorError("invalid-request", {
        detail: "profile.unknown",
      });
    if (profile?.kind === "unsupported")
      throw new ConnectorError("denied", { detail: "profile.unsupported" });
    const custody = approvals.custody ?? adapter.custody[0];
    if (!custody || !adapter.custody.includes(custody))
      throw new ConnectorError("invalid-request", {
        detail: "custody.unknown",
      });

    const destinations = await this.approveDestinations(
      actor,
      definition,
      approvals.destinations,
    );
    const operations = approvals.operations.map((approval, index) =>
      this.compileOperation(
        definition,
        destinations,
        typeof approval === "string" ? { nativeId: approval } : approval,
        approvals.profileId,
        index,
      ),
    );
    const configuration =
      approvals.configuration ??
      definition.configuration
        .filter((item) => item.required)
        .map((item) => item.name);
    const source = await this.ports.definitions.getSource(
      actor.tenantId,
      definition.sourceRef,
    );
    const authorityInstance =
      approvals.authorityInstance ??
      (profile && "issuer" in profile && profile.issuer
        ? new URL(profile.issuer).origin
        : (destinations[0]?.origin ?? ""));
    const bindingRef = `binding:${sha256Hex([
      actor.tenantId,
      definition.definitionRef,
      adapter.id,
    ]).slice(0, 40)}`;
    const existing = await this.ports.definitions.listBindings(actor.tenantId, {
      definitionRef: definition.definitionRef,
      adapterId: adapter.id,
    });
    const revision =
      existing
        .filter((item) => item.bindingRef === bindingRef)
        .reduce((max, item) => Math.max(max, item.revision), 0) + 1;
    const reviewedDigest = sha256Hex({
      normalizedDigest: definition.normalizedDigest,
      sourceDigest: source?.digest.value ?? null,
      adapterId: adapter.id,
      adapterVersion: adapter.adapterVersion,
      profileId: approvals.profileId ?? null,
      destinations,
      operations,
      permittedTargets: approvals.permittedTargets,
      configuration,
      settings: approvals.settings,
      policyRevision: this.policy.revision,
    });
    const binding = runtimeBindingSchema.parse({
      bindingRef,
      definitionRef: definition.definitionRef,
      revision,
      adapterId: adapter.id,
      adapterVersion: adapter.adapterVersion,
      runtime: adapter.runtime,
      custody,
      authorityInstance,
      status: "approved",
      approvedAt: iso(this.now()),
      policyRevision: this.policy.revision,
      tenantId: actor.tenantId,
      ...(approvals.profileId ? { profileId: approvals.profileId } : {}),
      destinations,
      operations,
      configuration,
      permittedTargets: approvals.permittedTargets,
      reviewedDigest,
      settings: approvals.settings,
    });
    await this.ports.definitions.putBinding(binding);
    return this.reference(binding);
  }

  private async approveDestinations(
    actor: ActorContext,
    definition: NormalizedDefinition,
    named: readonly string[],
  ): Promise<ApprovedDestination[]> {
    const destinations: ApprovedDestination[] = [];
    const seen = new Set<string>();
    for (const [index, entry] of named.entries()) {
      if (!URL.canParse(entry))
        throw new ConnectorError("invalid-request", {
          detail: "destination.invalid",
        });
      const url = new URL(entry);
      if (url.username || url.password || url.search || url.hash)
        throw new ConnectorError("invalid-request", {
          detail: "destination.invalid",
        });
      const declared = definition.declaredServers.find(
        (server) =>
          server.url === entry ||
          (URL.canParse(server.url) &&
            new URL(server.url).origin === url.origin &&
            (url.pathname === "/" ||
              new URL(server.url).pathname === url.pathname)),
      );
      const pathPrefix =
        url.pathname !== "/" ? url.pathname.replace(/\/+$/, "") : undefined;
      const key = `${url.origin}${pathPrefix ?? ""}`;
      if (seen.has(key))
        throw new ConnectorError("invalid-request", {
          detail: "destination.duplicate",
        });
      seen.add(key);
      let network: ApprovedDestination["network"] | false = false;
      try {
        network = await this.policy.allowDestination(actor, {
          origin: url.origin,
          declared: Boolean(declared),
          definition,
        });
      } catch {
        network = false;
      }
      if (!network)
        throw new ConnectorError("network-policy", {
          detail: "destination.not-permitted",
        });
      destinations.push({
        id: `destination-${index + 1}`,
        origin: url.origin,
        ...(pathPrefix ? { pathPrefix } : {}),
        network,
      });
    }
    return destinations;
  }

  private compileOperation(
    definition: NormalizedDefinition,
    destinations: ApprovedDestination[],
    approval: OperationApproval,
    profileId: string | undefined,
    index: number,
  ): BoundOperation {
    const capability = definition.capabilities.find(
      (item) => item.nativeId === approval.nativeId,
    );
    if (!capability)
      throw new ConnectorError("invalid-request", {
        detail: "operation.unknown",
      });
    const extensions = capability.nativeExtensions ?? {};
    const declaredTransport = extensions[TRANSPORT_EXTENSION];
    const transport = approval.transport
      ? approval.transport
      : declaredTransport !== undefined
        ? boundOperationTransport(declaredTransport)
        : undefined;
    if (!transport)
      throw new ConnectorError("invalid-request", {
        detail: "operation.transport-unknown",
      });
    const destination = this.pickDestination(
      definition,
      destinations,
      approval.destination ?? extensions[SERVER_EXTENSION],
    );
    const effect = approval.effect ?? capability.effect;
    const outputClassification =
      approval.outputClassification ??
      (capability.dataClassification === "unknown"
        ? "secret"
        : capability.dataClassification);
    const authenticationProfile =
      approval.authenticationProfile ??
      (profileId && (capability.authentication ?? []).includes(profileId)
        ? profileId
        : undefined);
    if (
      authenticationProfile &&
      !definition.authentication.some(
        (item) => item.id === authenticationProfile,
      )
    )
      throw new ConnectorError("invalid-request", {
        detail: "profile.unknown",
      });
    const replay =
      approval.replay ?? (effect === "read" ? "read-only" : "none");
    return {
      operationRef: `operation:${sha256Hex([approval.nativeId, index]).slice(0, 32)}`,
      nativeId: approval.nativeId,
      destinationId: destination.id,
      transport,
      effect,
      outputClassification,
      cost: approval.cost ?? capability.cost,
      consent: approval.consent ?? (effect === "read" ? "none" : "confirm"),
      replay: effect !== "read" && replay === "read-only" ? "none" : replay,
      targetParameters: approval.targetParameters ?? [],
      ...(authenticationProfile ? { authenticationProfile } : {}),
      ...(capability.label ? { description: capability.label } : {}),
    };
  }

  private pickDestination(
    definition: NormalizedDefinition,
    destinations: ApprovedDestination[],
    selector: unknown,
  ): ApprovedDestination {
    if (selector === undefined) {
      if (destinations.length === 1) return destinations[0]!;
      throw new ConnectorError("invalid-request", {
        detail: "operation.destination-ambiguous",
      });
    }
    if (typeof selector === "number") {
      const declared = definition.declaredServers[selector - 1];
      const byIndex = destinations[selector - 1];
      const match =
        (declared &&
          URL.canParse(declared.url) &&
          destinations.find(
            (item) => item.origin === new URL(declared.url).origin,
          )) ||
        byIndex;
      if (match) return match;
    }
    if (typeof selector === "string" && URL.canParse(selector)) {
      const origin = new URL(selector).origin;
      const match = destinations.find((item) => item.origin === origin);
      if (match) return match;
    }
    throw new ConnectorError("invalid-request", {
      detail: "operation.destination-unapproved",
    });
  }

  // -------------------------------------------------------------- configure

  /** Names in, names out. Values arrive through a one-use private reference. */
  async configure(
    actor: ActorContext,
    rawInput: unknown,
  ): Promise<{ names: string[]; revision: string }> {
    requireCapability(actor, "executor");
    if (actor.actorKind !== "human")
      throw new ConnectorError("denied", { detail: "configure.human-only" });
    const input: ConfigureInput = configureInputSchema.parse(rawInput);
    const writer = this.options.configure;
    if (!writer)
      throw new ConnectorError("unsupported", {
        detail: "configure.unavailable",
      });
    await this.authorize(actor, { kind: "catalog" }, "configure");
    const values = await writer.consume(actor, input.secretRef);
    if (!values)
      throw new ConnectorError("expired", { detail: "configure.reference" });
    const names = Object.keys(values);
    if (
      !names.length ||
      names.length > 48 ||
      names.some((name) => !configurationName.test(name)) ||
      (input.names && names.some((name) => !input.names!.includes(name)))
    )
      throw new ConnectorError("invalid-request", {
        detail: "configure.names",
      });
    const written = await writer.write(actor, values);
    return { names: names.sort(), revision: written.revision };
  }

  // ---------------------------------------------------------------- connect

  async connect(
    actor: ActorContext,
    rawInput: unknown,
  ): Promise<ConnectionView> {
    requireCapability(actor, "executor");
    const input: ConnectInput = connectInputSchema.parse(rawInput);
    if (input.intent.accountSwitch)
      throw new ConnectorError("invalid-request", {
        detail: "account-switch.reconnect-only",
      });
    const binding = this.approved(
      await this.binding(actor.tenantId, input.bindingRef),
    );
    const adapter = this.adapterFor(binding);
    const definition = await this.definition(
      actor.tenantId,
      binding.definitionRef,
    );
    await this.authorize(actor, { kind: "binding", binding }, "connect");
    if (input.durable)
      await this.authorize(
        actor,
        { kind: "binding", binding },
        "connect-durable",
        "connect.durable-denied",
      );
    if (!(await this.policy.allowOwnerKind(actor, input.ownerKind, binding)))
      throw new ConnectorError("denied", { detail: "owner.kind" });
    if (
      input.ownerKind !== "user" &&
      !(await this.policy.allowSharedKey(actor, input.ownerKind, binding))
    )
      throw new ConnectorError("denied", { detail: "owner.shared-key" });
    if (
      input.intent.target &&
      !(await this.policy.allowTarget(actor, input.intent.target, binding))
    )
      throw new ConnectorError("denied", { detail: "target.policy" });
    const profileId = input.intent.profileId ?? binding.profileId;
    if (
      profileId &&
      !definition.authentication.some((item) => item.id === profileId)
    )
      throw new ConnectorError("invalid-request", {
        detail: "profile.unknown",
      });

    const existing = (
      await port(() =>
        this.ports.connections.list(actor, { bindingRef: binding.bindingRef }),
      )
    ).find(
      (entry) =>
        !deleted(entry.record) &&
        !closed(entry.record) &&
        entry.record.ownerKind === input.ownerKind &&
        (entry.record.sessionId === undefined) === input.durable &&
        entry.record.state.profileId === (profileId ?? null) &&
        sha256Hex(intentOf(entry.record).target ?? null) ===
          sha256Hex(input.intent.target ?? null),
    );
    if (existing) return this.status(actor, existing.record.connectionRef);

    const configuration = this.options.configuration(actor);
    const present = await configuration.present(binding.configuration);
    const missing = binding.configuration.filter((name) => !present.has(name));
    const now = this.now();
    const record: ConnectionRecord = {
      connectionRef: `connection:${this.random.uuid()}`,
      bindingRef: binding.bindingRef,
      definitionRef: binding.definitionRef,
      ecosystem: definition.display.ecosystem,
      service: definition.display.service ?? adapter.service,
      displayName: definition.display.name,
      ownerKind: input.ownerKind,
      custody: binding.custody,
      runtime: binding.runtime,
      lifecycle: missing.length
        ? "configuration-required"
        : "authorization-required",
      generation: 0,
      revision: 0,
      ...(missing.length ? { lastOutcome: "configuration.missing" } : {}),
      createdAt: iso(now),
      updatedAt: iso(now),
      tenantId: actor.tenantId,
      ownerId: actor.subjectId,
      ...(input.durable ? {} : { sessionId: actor.sessionId }),
      authorityInstance: binding.authorityInstance,
      bindingRevision: binding.revision,
      policyRevision: binding.policyRevision,
      configurationRevision: await configuration.revision(),
      externalIds: {},
      evidenceRefs: [],
      state: {
        intent: input.intent,
        profileId: profileId ?? null,
        ...(missing.length ? { missingConfiguration: missing } : {}),
      },
    };
    const created = await port(() => this.ports.connections.create(record));
    let entry: ConnectionEntry = { record, revision: created.revision };
    if (missing.length) return this.project(actor, entry);

    const ctx = this.context(actor, binding, record);
    if (!adapter.authorize) {
      entry = await this.update(actor, entry, {
        lastOutcome: "adapter.authorize-unsupported",
      });
      throw new ConnectorError("unsupported", {
        detail: "adapter.authorize-unsupported",
      });
    }
    const start = await adapterCall(() =>
      adapter.authorize!(
        ctx,
        toAdapterIntent(input.intent, input.ownerKind, profileId),
      ),
    );
    const applied = await this.applyStart(
      actor,
      entry,
      binding,
      adapter,
      start,
      input.intent,
    );
    entry = await this.update(actor, entry, applied.patch);
    if (applied.unsupported)
      throw new ConnectorError("unsupported", { detail: applied.unsupported });
    return this.project(actor, entry, applied.presentation);
  }

  private async applyStart(
    actor: ActorContext,
    entry: ConnectionEntry,
    binding: RuntimeBinding,
    adapter: ConnectorAdapter,
    start: AuthorizationStart,
    intent: IntentInput,
  ): Promise<{
    patch: ConnectionPatch;
    presentation?: HumanPresentation | undefined;
    unsupported?: string | undefined;
  }> {
    const record = entry.record;
    switch (start.kind) {
      case "handoff":
        return this.issueHandoff(actor, record, start.handoff, intent, {});
      case "verify": {
        if (!adapter.verify)
          return {
            patch: { lastOutcome: "adapter.verify-unsupported" },
            unsupported: "adapter.verify-unsupported",
          };
        const result = await adapterCall(() =>
          adapter.verify!(this.context(actor, binding, record)),
        );
        return this.applyCompletion(
          actor,
          entry,
          result,
          undefined,
          intent,
          "authorize",
        );
      }
      case "configuration-required":
        return {
          patch: {
            lifecycle: "configuration-required",
            lastOutcome: "configuration.missing",
            state: {
              ...record.state,
              missingConfiguration: start.missing.filter((name) =>
                configurationName.test(name),
              ),
            },
          },
        };
      case "human-required":
        return {
          patch: {
            lifecycle: "human-required",
            lastOutcome: code(start.code, "human.required"),
          },
        };
      case "unsupported": {
        const detail = code(start.code, "adapter.unsupported");
        return { patch: { lastOutcome: detail }, unsupported: detail };
      }
    }
  }

  private async issueHandoff(
    actor: ActorContext,
    record: ConnectionRecord,
    proposal: HandoffProposal,
    intent: IntentInput,
    patch: ConnectionPatch,
  ): Promise<{
    patch: ConnectionPatch;
    presentation?: HumanPresentation | undefined;
  }> {
    if (intent.interruption === "none")
      return {
        patch: {
          ...patch,
          lifecycle: "human-required",
          lastOutcome: "interruption.required",
        },
      };
    const now = this.now();
    if (proposal.expiresAt <= now)
      throw new ConnectorError("expired", { detail: "handoff.expired" });
    const issued = await port(() =>
      this.ports.handoffs.issue({
        actor,
        connectionRef: record.connectionRef,
        bindingRef: record.bindingRef,
        generation: record.generation,
        kind: proposal.kind,
        presentation: proposal.presentation,
        expiresAt: Math.min(proposal.expiresAt, now + MAX_HANDOFF_MS),
        intent: proposal.intent,
        ...(proposal.correlationKey
          ? { correlationKey: proposal.correlationKey }
          : {}),
        private: proposal.private,
      }),
    );
    const input =
      proposal.kind === "input-required" ||
      proposal.kind === "private-collector";
    return {
      patch: {
        ...patch,
        lifecycle: input ? "human-required" : "authorization-required",
        handoff: issued.summary,
        lastOutcome: input ? "handoff.input-required" : "handoff.issued",
      },
      ...(actor.actorKind === "human"
        ? { presentation: presentationOf(proposal.private) }
        : {}),
    };
  }

  /**
   * Applies what an adapter reports. Claims become evidence stamped with the
   * connection's own binding and policy revision; a connection becomes active
   * only when the claims satisfy the recorded intent, and a verified account
   * is never silently replaced by a different one.
   */
  private async applyCompletion(
    actor: ActorContext,
    entry: ConnectionEntry,
    result: CompletionResult,
    handoff: HandoffHandle | undefined,
    intent: IntentInput,
    mode: "authorize" | "verify",
  ): Promise<{
    patch: ConnectionPatch;
    presentation?: HumanPresentation | undefined;
  }> {
    const record = entry.record;
    const patch: ConnectionPatch = {};
    const finish = async (
      state: "completed" | "denied" | "expired" | "cancelled" | "superseded",
    ) => {
      if (!handoff) return;
      await port(() =>
        this.ports.handoffs.complete(
          handoff.handoffRef,
          handoff.generation,
          state,
        ),
      );
      if (record.handoff?.handoffRef === handoff.handoffRef)
        patch.handoff = { ...record.handoff, state };
    };
    const scope = this.scope(record);
    switch (result.state) {
      case "complete": {
        const claims = this.stampClaims(record, result.claims);
        const identity = claims.find(
          (claim) => claim.kind === "account-identity",
        );
        const verified = result.target ?? identity?.target;
        const satisfies =
          !intent.target ||
          claims.some(
            (claim) =>
              (claim.kind === "account-identity" ||
                claim.kind === "resource-access") &&
              claim.target.kind === intent.target!.kind &&
              claim.target.id === intent.target!.id,
          );
        if (
          record.target &&
          verified &&
          record.target.kind === verified.kind &&
          record.target.id !== verified.id &&
          !intent.accountSwitch
        ) {
          // A different account came back. Nothing is rebound: the new
          // material is discarded and a person must ask for the switch.
          if (
            result.credentialRef &&
            result.credentialRef !== record.credentialRef
          )
            await this.ports.credentials
              .revoke(scope, result.credentialRef)
              .catch(() => {});
          await finish("denied");
          patch.lifecycle = "reconnect-required";
          patch.lastOutcome = "verification.account-changed";
          return { patch };
        }
        const evidenceRefs = [...record.evidenceRefs];
        for (const claim of claims)
          evidenceRefs.push(
            await port(() =>
              this.ports.evidence.append(actor, record.connectionRef, claim),
            ),
          );
        if (
          record.credentialRef &&
          result.credentialRef &&
          result.credentialRef !== record.credentialRef
        )
          await this.ports.credentials
            .revoke(scope, record.credentialRef)
            .catch(() => {});
        patch.evidenceRefs = evidenceRefs.slice(-256);
        if (result.credentialRef) patch.credentialRef = result.credentialRef;
        patch.externalIds = this.externalIds(record, result.externalIds);
        patch.state = boundedState(record.state, result.adapterState);
        patch.configurationRevision = await this.options
          .configuration(actor)
          .revision();
        if (!satisfies) {
          await finish("completed");
          patch.lifecycle = "human-required";
          patch.lastOutcome = "verification.target-unverified";
          return { patch };
        }
        if (verified) patch.target = { kind: verified.kind, id: verified.id };
        if (claims.length) {
          const validUntil = claims
            .map((claim) => claim.validUntil)
            .filter((value): value is string => Boolean(value))
            .sort()[0];
          patch.verification = {
            kinds: [...new Set(claims.map((claim) => claim.kind))].slice(0, 8),
            observedAt: claims
              .map((claim) => claim.observedAt)
              .sort()
              .at(-1)!,
            ...(validUntil ? { validUntil } : {}),
            limitations: [
              ...new Set(claims.flatMap((claim) => claim.limitations)),
            ].slice(0, 16),
          };
        }
        await finish("completed");
        patch.lifecycle = "active";
        patch.lastOutcome =
          mode === "verify"
            ? "verification.complete"
            : "authorization.complete";
        return { patch };
      }
      case "pending":
        return {
          patch: { lastOutcome: code(result.code, "authorization.pending") },
        };
      case "denied":
        await finish("denied");
        patch.lifecycle =
          mode === "verify" ? "reconnect-required" : "authorization-required";
        patch.lastOutcome = code(result.code, "authorization.denied");
        return { patch };
      case "expired":
        await finish("expired");
        patch.lifecycle =
          mode === "verify" ? "expired" : "authorization-required";
        patch.lastOutcome = code(result.code, "handoff.expired");
        return { patch };
      case "indeterminate":
        await finish("completed");
        patch.lifecycle = "indeterminate";
        patch.lastOutcome = code(result.code, "authorization.indeterminate");
        return { patch };
      case "human-required": {
        await finish("completed");
        patch.lifecycle = "human-required";
        patch.lastOutcome = code(result.code, "human.required");
        if (result.handoff)
          return this.issueHandoff(
            actor,
            { ...record, ...patch } as ConnectionRecord,
            result.handoff,
            intent,
            patch,
          );
        return { patch };
      }
    }
  }

  private stampClaims(
    record: ConnectionRecord,
    claims: VerificationClaim[],
  ): VerificationClaim[] {
    return claims.map((claim) => {
      const parsed = verificationClaimSchema.safeParse({
        ...claim,
        evidenceRef: `evidence:${this.random.uuid()}`,
        bindingRevision: record.bindingRevision,
        policyRevision: record.policyRevision,
      });
      if (!parsed.success)
        throw new ConnectorError("upstream-rejected", {
          detail: "evidence.invalid",
        });
      return parsed.data;
    });
  }

  private externalIds(
    record: ConnectionRecord,
    extra: Record<string, string> | undefined,
  ): Record<string, string> {
    const merged = { ...record.externalIds };
    for (const [name, value] of Object.entries(extra ?? {})) {
      if (!externalIdName.test(name) || typeof value !== "string")
        throw new ConnectorError("upstream-rejected", {
          detail: "external-id.invalid",
        });
      merged[name] = value;
    }
    if (Object.keys(merged).length > 32)
      throw new ConnectorError("upstream-rejected", {
        detail: "external-id.bounds",
      });
    return merged;
  }

  // -------------------------------------------------------------- callbacks

  /**
   * A provider redirect landing on the deployment's fixed callback path. The
   * state parameter is only a correlation key: it finds the handoff inside
   * the caller's tenant, and then the caller must be the human who started
   * it, in the same session, before the current generation, and the handoff
   * must not have been used. Only then does the adapter see the URL.
   */
  async callback(actor: ActorContext, url: URL): Promise<ConnectionView> {
    requireCapability(actor, "executor");
    if (actor.actorKind !== "human")
      throw new ConnectorError("denied", { detail: "callback.human-only" });
    const states = url.searchParams.getAll("state");
    const state = states[0];
    if (
      states.length !== 1 ||
      !state ||
      state.length > 1024 ||
      !/^[^\p{Cc}]+$/u.test(state)
    )
      throw new ConnectorError("invalid-request", { detail: "callback.state" });
    const handoff = await this.ports.handoffs.resolveCorrelation(
      actor.tenantId,
      state,
    );
    if (!handoff || handoff.tenantId !== actor.tenantId)
      throw new ConnectorError("not-found", { detail: "handoff.unknown" });
    if (
      handoff.subjectId !== actor.subjectId ||
      handoff.sessionId !== actor.sessionId
    )
      throw new ConnectorError("denied", { detail: "handoff.recipient" });
    return this.complete(actor, handoff, { kind: "redirect", url });
  }

  private async complete(
    actor: ActorContext,
    handoff: HandoffRecord,
    input: Parameters<NonNullable<ConnectorAdapter["complete"]>>[1],
  ): Promise<ConnectionView> {
    if (handoff.state !== "issued" && handoff.state !== "waiting")
      throw new ConnectorError("conflict", { detail: "handoff.consumed" });
    const entry = await this.connection(actor, handoff.connectionRef);
    const record = entry.record;
    if (closed(record))
      throw new ConnectorError("denied", { detail: "connection.disconnected" });
    if (handoff.generation !== record.generation)
      throw new ConnectorError("expired", {
        detail: "handoff.stale-generation",
      });
    if (handoff.expiresAt <= this.now()) {
      await port(() =>
        this.ports.handoffs.complete(
          handoff.handoffRef,
          handoff.generation,
          "expired",
        ),
      ).catch(() => {});
      await this.update(actor, entry, {
        lifecycle: "authorization-required",
        lastOutcome: "handoff.expired",
        ...(record.handoff?.handoffRef === handoff.handoffRef
          ? { handoff: { ...record.handoff, state: "expired" } }
          : {}),
      });
      throw new ConnectorError("expired", { detail: "handoff.expired" });
    }
    const binding = this.approved(
      await this.binding(
        actor.tenantId,
        record.bindingRef,
        record.bindingRevision,
      ),
    );
    const adapter = this.adapterFor(binding);
    if (!adapter.complete)
      throw new ConnectorError("unsupported", {
        detail: "adapter.complete-unsupported",
      });
    await this.authorize(
      actor,
      { kind: "connection", connection: record, binding },
      input.kind === "event"
        ? "event"
        : input.kind === "input"
          ? "input"
          : "callback",
    );
    // One completion per handoff and generation, even under concurrency: the
    // journal entry is written before the adapter touches the provider.
    const journal = await this.ports.effects.begin({
      actor,
      connectionRef: record.connectionRef,
      bindingRef: record.bindingRef,
      operation: "connector.handoff.complete",
      digest: sha256Hex([handoff.handoffRef, handoff.generation, input.kind]),
      commandId: handoff.handoffRef,
    });
    if (journal.prior && input.kind !== "input" && input.kind !== "poll")
      throw new ConnectorError("conflict", { detail: "handoff.consumed" });
    const intent = intentOf(record);
    let result: CompletionResult;
    try {
      result = await adapterCall(() =>
        adapter.complete!(this.context(actor, binding, record, handoff), input),
      );
    } catch (error) {
      await this.ports.effects
        .complete(journal.effectRef, {
          status: "failed",
          code:
            error instanceof ConnectorError
              ? (error.detail ?? error.code)
              : "adapter.failure",
          at: this.now(),
        })
        .catch(() => {});
      await this.update(actor, entry, {
        lastOutcome:
          error instanceof ConnectorError
            ? code(error.detail, error.code)
            : "adapter.failure",
      }).catch(() => {});
      throw error;
    }
    const applied = await this.applyCompletion(
      actor,
      entry,
      result,
      { handoffRef: handoff.handoffRef, generation: handoff.generation },
      intent,
      "authorize",
    );
    await this.ports.effects
      .complete(journal.effectRef, this.effectOutcome(result))
      .catch(() => {});
    const updated = await this.update(actor, entry, applied.patch);
    return this.project(actor, updated, applied.presentation);
  }

  private effectOutcome(
    result: CompletionResult | InvokeResult,
  ): EffectOutcome {
    const status: EffectOutcome["status"] =
      result.state === "complete"
        ? "applied"
        : result.state === "indeterminate"
          ? "indeterminate"
          : result.state === "failed"
            ? "failed"
            : "not-applied";
    return {
      status,
      ...(result.code ? { code: result.code.slice(0, 120) } : {}),
      at: this.now(),
    };
  }

  /** A verified provider event continuing a handoff; the actor is the recorded initiator, acting as system. */
  async continueFromEvent(
    tenantId: string,
    correlationKey: string,
    event: VerifiedEventEnvelope,
  ): Promise<ConnectionView | undefined> {
    const handoff = await this.ports.handoffs.resolveCorrelation(
      tenantId,
      correlationKey,
    );
    if (!handoff || handoff.tenantId !== tenantId) return undefined;
    const actor: ActorContext = {
      tenantId: handoff.tenantId,
      subjectId: handoff.subjectId,
      sessionId: handoff.sessionId,
      actorKind: "system",
      capabilities: ["executor"],
    };
    return this.complete(actor, handoff, { kind: "event", event });
  }

  /** Private input for an input-required handoff; values reach the adapter and nothing else. */
  async provideInput(
    actor: ActorContext,
    connectionRef: string,
    handoffRef: string,
    rawValues: unknown,
  ): Promise<ConnectionView> {
    requireCapability(actor, "executor");
    if (actor.actorKind !== "human")
      throw new ConnectorError("denied", { detail: "input.human-only" });
    const values = handoffValuesSchema.parse(rawValues);
    const entry = await this.connection(actor, connectionRef);
    const handoff = await this.ports.handoffs.present(actor, handoffRef);
    if (!handoff || handoff.connectionRef !== connectionRef)
      throw new ConnectorError("not-found", { detail: "handoff.unknown" });
    if (
      handoff.kind !== "input-required" &&
      handoff.kind !== "private-collector"
    )
      throw new ConnectorError("invalid-request", { detail: "handoff.kind" });
    void entry;
    return this.complete(actor, handoff, { kind: "input", values });
  }

  async poll(
    actor: ActorContext,
    connectionRef: string,
  ): Promise<ConnectionView> {
    requireCapability(actor, "executor");
    const entry = await this.connection(actor, connectionRef);
    const record = entry.record;
    const summary = pending(record);
    if (!summary) return this.status(actor, connectionRef);
    if (Date.parse(summary.expiresAt) <= this.now()) {
      await port(() =>
        this.ports.handoffs.complete(
          summary.handoffRef,
          summary.generation,
          "expired",
        ),
      ).catch(() => {});
      const updated = await this.update(actor, entry, {
        lifecycle: "authorization-required",
        lastOutcome: "handoff.expired",
        handoff: { ...summary, state: "expired" },
      });
      return this.project(actor, updated);
    }
    const binding = this.approved(
      await this.binding(
        actor.tenantId,
        record.bindingRef,
        record.bindingRevision,
      ),
    );
    const adapter = this.adapterFor(binding);
    await this.authorize(
      actor,
      { kind: "connection", connection: record, binding },
      "poll",
    );
    if (!adapter.complete) return this.project(actor, entry);
    const handoff = await this.pendingHandoff(actor, record);
    const result = await adapterCall(() =>
      adapter.complete!(this.context(actor, binding, record, handoff), {
        kind: "poll",
      }),
    );
    const applied = await this.applyCompletion(
      actor,
      entry,
      result,
      { handoffRef: summary.handoffRef, generation: summary.generation },
      intentOf(record),
      "authorize",
    );
    const updated = await this.update(actor, entry, applied.patch);
    const presentation =
      applied.presentation ??
      (result.state === "pending"
        ? presentationOf(handoff?.private ?? {})
        : undefined);
    return this.project(actor, updated, presentation);
  }

  async status(
    actor: ActorContext,
    connectionRef: string,
  ): Promise<ConnectionView> {
    requireCapability(actor, "executor");
    const entry = await this.connection(actor, connectionRef);
    const handoff = await this.pendingHandoff(actor, entry.record);
    return this.project(
      actor,
      entry,
      handoff && handoff.expiresAt > this.now()
        ? presentationOf(handoff.private)
        : undefined,
    );
  }

  async listConnections(
    actor: ActorContext,
    filter?: Parameters<ConnectionStorePort["list"]>[1],
  ): Promise<ConnectionView[]> {
    requireCapability(actor, "executor");
    const entries = await port(() =>
      this.ports.connections.list(actor, filter),
    );
    return entries
      .filter((entry) => !deleted(entry.record))
      .map((entry) => this.project(actor, entry));
  }

  /** Fresh evidence for an existing grant; never a way to obtain one. */
  async verify(
    actor: ActorContext,
    connectionRef: string,
  ): Promise<ConnectionView> {
    requireCapability(actor, "executor");
    const entry = await this.connection(actor, connectionRef);
    const record = entry.record;
    if (
      !["active", "degraded", "expired", "verifying", "indeterminate"].includes(
        record.lifecycle,
      )
    )
      throw new ConnectorError("conflict", {
        detail: `connection.${record.lifecycle}`,
      });
    const binding = this.approved(
      await this.binding(
        actor.tenantId,
        record.bindingRef,
        record.bindingRevision,
      ),
    );
    const adapter = this.adapterFor(binding);
    if (!adapter.verify)
      throw new ConnectorError("unsupported", {
        detail: "adapter.verify-unsupported",
      });
    await this.authorize(
      actor,
      { kind: "connection", connection: record, binding },
      "verify",
    );
    const result = await adapterCall(() =>
      adapter.verify!(this.context(actor, binding, record)),
    );
    const applied = await this.applyCompletion(
      actor,
      entry,
      result,
      undefined,
      intentOf(record),
      "verify",
    );
    return this.project(actor, await this.update(actor, entry, applied.patch));
  }

  // ----------------------------------------------------------------- invoke

  /**
   * Runs one approved operation. The caller names a connection, an operation
   * reference and input; the binding supplies the destination, transport and
   * credential authority. Targets are checked against what the connection may
   * touch, consent against host policy, and the exact intent (binding
   * revision, generation, input, command id) is journaled before the call so
   * a retry cannot become a second effect and a changed input cannot ride on
   * an earlier approval.
   */
  async invoke(
    actor: ActorContext,
    connectionRef: string,
    rawInput: unknown,
  ): Promise<InvokeResponse> {
    requireCapability(actor, "executor");
    const input: InvokeInput = invokeInputSchema.parse(rawInput);
    const entry = await this.connection(actor, connectionRef);
    const record = entry.record;
    if (closed(record))
      throw new ConnectorError("denied", { detail: "connection.disconnected" });
    if (record.lifecycle !== "active")
      throw new ConnectorError("conflict", {
        detail: `connection.${record.lifecycle}`,
      });
    const configuration = this.options.configuration(actor);
    if ((await configuration.revision()) !== record.configurationRevision) {
      await this.ports.evidence
        .invalidate(actor, connectionRef, "configuration-changed")
        .catch(() => {});
      await this.update(actor, entry, {
        lifecycle: "reconnect-required",
        lastOutcome: "configuration.changed",
      });
      throw new ConnectorError("conflict", { detail: "configuration.changed" });
    }
    const binding = this.approved(
      await this.binding(
        actor.tenantId,
        record.bindingRef,
        record.bindingRevision,
      ),
    );
    const adapter = this.adapterFor(binding);
    await this.authorize(
      actor,
      { kind: "connection", connection: record, binding },
      "invoke",
    );
    const operation = boundOperation(binding, input.operationRef);
    if (!operation)
      throw new ConnectorError("denied", { detail: "operation.unapproved" });
    if (!adapter.invoke)
      throw new ConnectorError("unsupported", {
        detail: "adapter.invoke-unsupported",
      });
    for (const name of operation.targetParameters) {
      const value = input.input[name];
      if (typeof value !== "string" || !value)
        throw new ConnectorError("invalid-request", {
          detail: "target.missing",
        });
      const permitted =
        binding.permittedTargets.some(
          (target) => target.kind === name && target.id === value,
        ) ||
        (record.target?.kind === name && record.target.id === value);
      if (!permitted)
        throw new ConnectorError("denied", { detail: "target.not-permitted" });
      if (
        !(await this.policy.allowTarget(
          actor,
          { kind: name, id: value },
          binding,
        ))
      )
        throw new ConnectorError("denied", { detail: "target.policy" });
    }
    if (
      !(await this.policy.allowOutput(
        actor,
        operation.outputClassification,
        operation,
      ))
    )
      throw new ConnectorError("denied", { detail: "output.classification" });
    const consentRequired = await this.policy.requireConsent(
      actor,
      operation,
      record,
    );
    if (consentRequired && !(actor.actorKind === "human" && input.confirm))
      return {
        state: "human-required",
        effect: operation.effect,
        outputClassification: operation.outputClassification,
        code: "consent.required",
      };

    const intentDigest = sha256Hex({
      tenantId: actor.tenantId,
      subjectId: actor.subjectId,
      connectionRef,
      generation: record.generation,
      bindingRef: binding.bindingRef,
      bindingRevision: binding.revision,
      operationRef: operation.operationRef,
      input: input.input,
      commandId: input.commandId,
    });
    const command = await this.ports.effects.begin({
      actor,
      connectionRef,
      bindingRef: binding.bindingRef,
      operation: "connector.command",
      digest: sha256Hex([
        actor.tenantId,
        actor.subjectId,
        connectionRef,
        input.commandId,
      ]),
      commandId: input.commandId,
    });
    if (!command.prior)
      await this.ports.effects.complete(command.effectRef, {
        status: "applied",
        code: "command.admitted",
        at: this.now(),
      });
    const journal = await this.ports.effects.begin({
      actor,
      connectionRef,
      bindingRef: binding.bindingRef,
      operation: "connector.invoke",
      digest: intentDigest,
      ...(operation.replay === "upstream-idempotency-key"
        ? {
            idempotency: {
              key: intentDigest.slice(0, 32),
              scope: binding.authorityInstance || "binding",
            },
          }
        : {}),
      commandId: input.commandId,
    });
    if (journal.prior) {
      const prior = journal.prior;
      return {
        state:
          prior.status === "applied" || prior.status === "reconciled"
            ? "complete"
            : prior.status === "failed"
              ? "failed"
              : prior.status === "not-applied"
                ? "denied"
                : "indeterminate",
        effect: operation.effect,
        outputClassification: operation.outputClassification,
        code: prior.code ?? "effect.replayed",
        effectRef: journal.effectRef,
        replayed: true,
      };
    }
    if (command.prior)
      // The command id was used before with a different intent: refuse rather
      // than run a second effect under a familiar name.
      throw new ConnectorError("denied", { detail: "command.reused" });

    let result: InvokeResult;
    try {
      result = await adapterCall(() =>
        adapter.invoke!(this.context(actor, binding, record), {
          operationRef: operation.operationRef,
          input: input.input,
          commandId: input.commandId,
          ...(operation.replay === "upstream-idempotency-key"
            ? { idempotencyKey: intentDigest.slice(0, 32) }
            : {}),
        }),
      );
    } catch (error) {
      const uncertain = operation.replay !== "read-only";
      await this.ports.effects
        .complete(journal.effectRef, {
          status: uncertain ? "indeterminate" : "failed",
          code:
            error instanceof ConnectorError
              ? (error.detail ?? error.code)
              : "adapter.failure",
          at: this.now(),
        })
        .catch(() => {});
      if (uncertain)
        throw new ConnectorError("indeterminate", {
          detail: "effect.uncertain",
          cause: error,
        });
      throw error;
    }
    await this.ports.effects
      .complete(journal.effectRef, this.effectOutcome(result))
      .catch(() => {});

    const classification =
      classificationRank[result.outputClassification] >
      classificationRank[operation.outputClassification]
        ? result.outputClassification
        : operation.outputClassification;
    const response: InvokeResponse = {
      state: result.state,
      effect: operation.effect,
      outputClassification: classification,
      effectRef: journal.effectRef,
      ...(result.code ? { code: code(result.code, "adapter.code") } : {}),
    };
    if (result.output !== undefined) {
      const allowed = await this.policy.allowOutput(
        actor,
        classification,
        operation,
      );
      const size = Buffer.byteLength(JSON.stringify(result.output) ?? "");
      if (!allowed || size > MAX_OUTPUT_BYTES) {
        response.outputWithheld = true;
        if (size > MAX_OUTPUT_BYTES) response.code = "output.too-large";
      } else response.output = result.output;
    }
    if (result.state === "human-required" && result.handoff) {
      const issued = await this.issueHandoff(
        actor,
        record,
        result.handoff,
        intentOf(record),
        {},
      );
      const updated = await this.update(actor, entry, {
        ...issued.patch,
        lifecycle: record.lifecycle,
      });
      const summary = pending(updated.record);
      if (summary)
        response.handoff = { kind: summary.kind, state: summary.state };
      if (issued.presentation && actor.actorKind === "human")
        response.presentation = issued.presentation;
    }
    return response;
  }

  // --------------------------------------------------------------- reconnect

  /** A new authorization under the current binding revision; the old grant stays until the new one is verified. */
  async reconnect(
    actor: ActorContext,
    connectionRef: string,
    rawInput: unknown,
  ): Promise<ConnectionView> {
    requireCapability(actor, "executor");
    const input: ReconnectInput = reconnectInputSchema.parse(rawInput);
    const entry = await this.connection(actor, connectionRef);
    const record = entry.record;
    if (closed(record))
      throw new ConnectorError("denied", { detail: "connection.disconnected" });
    if (entry.revision !== input.expectedRevision)
      throw new ConnectorError("conflict", { detail: "revision.stale" });
    const binding = this.approved(
      await this.binding(actor.tenantId, record.bindingRef),
    );
    const adapter = this.adapterFor(binding);
    await this.authorize(
      actor,
      { kind: "connection", connection: record, binding },
      "reconnect",
    );
    if (input.accountSwitch) {
      if (actor.actorKind !== "human")
        throw new ConnectorError("denied", {
          detail: "account-switch.human-only",
        });
      await this.authorize(
        actor,
        { kind: "connection", connection: record, binding },
        "account-switch",
        "account-switch.denied",
      );
    }
    const previous = intentOf(record);
    const target = input.target ?? previous.target;
    if (target && !(await this.policy.allowTarget(actor, target, binding)))
      throw new ConnectorError("denied", { detail: "target.policy" });
    const intent: IntentInput = {
      ...(previous.profileId ? { profileId: previous.profileId } : {}),
      requestedPermissions:
        input.requestedPermissions ?? previous.requestedPermissions,
      ...(target ? { target } : {}),
      accountSwitch: input.accountSwitch,
      interruption: input.interruption,
    };
    const profileId =
      typeof record.state.profileId === "string"
        ? record.state.profileId
        : binding.profileId;
    const advanced = await port(() =>
      this.ports.connections.advanceGeneration(
        actor,
        connectionRef,
        entry.revision,
      ),
    );
    await this.ports.handoffs.cancelAll(connectionRef, "reconnect");
    await this.ports.evidence
      .invalidate(actor, connectionRef, "reconnect")
      .catch(() => {});
    const fenced: ConnectionRecord = {
      ...record,
      generation: advanced.generation,
      bindingRevision: binding.revision,
      policyRevision: binding.policyRevision,
      lifecycle: "authorization-required",
    };
    let current: ConnectionEntry = {
      record: fenced,
      revision: advanced.revision,
    };
    current = await this.update(actor, current, {
      lifecycle: "authorization-required",
      bindingRevision: binding.revision,
      policyRevision: binding.policyRevision,
      lastOutcome: "reconnect.started",
      state: { ...record.state, intent, profileId: profileId ?? null },
    });
    const start = adapter.reconnect ?? adapter.authorize;
    if (!start)
      throw new ConnectorError("unsupported", {
        detail: "adapter.reconnect-unsupported",
      });
    const outcome = await adapterCall(() =>
      start.call(
        adapter,
        this.context(actor, binding, current.record),
        toAdapterIntent(intent, record.ownerKind, profileId),
      ),
    );
    const applied = await this.applyStart(
      actor,
      current,
      binding,
      adapter,
      outcome,
      intent,
    );
    current = await this.update(actor, current, applied.patch);
    if (applied.unsupported)
      throw new ConnectorError("unsupported", { detail: applied.unsupported });
    return this.project(actor, current, applied.presentation);
  }

  /** Cancels pending handoffs without touching any grant. */
  async cancelPending(
    actor: ActorContext,
    connectionRef: string,
  ): Promise<ConnectionView> {
    requireCapability(actor, "executor");
    const entry = await this.connection(actor, connectionRef);
    const summary = pending(entry.record);
    if (!summary) return this.project(actor, entry);
    await this.ports.handoffs.cancelAll(connectionRef, "cancelled");
    return this.project(
      actor,
      await this.update(actor, entry, {
        handoff: { ...summary, state: "cancelled" },
        lastOutcome: "handoff.cancelled",
        lifecycle:
          entry.record.lifecycle === "human-required"
            ? "authorization-required"
            : entry.record.lifecycle,
      }),
    );
  }

  // -------------------------------------------------------------- disconnect

  /**
   * Local unlink by default. Broker deletion and upstream revocation are
   * distinct intents with their own authorization, and neither runs while
   * another local connection shares the grant unless the caller acknowledges
   * that impact explicitly.
   */
  async disconnect(
    actor: ActorContext,
    connectionRef: string,
    rawInput: unknown,
  ): Promise<{ result: DisconnectResult; connection: ConnectionView }> {
    requireCapability(actor, "executor");
    const input: DisconnectInput = disconnectInputSchema.parse(rawInput);
    const entry = await this.connection(actor, connectionRef);
    const record = entry.record;
    if (entry.revision !== input.expectedRevision)
      throw new ConnectorError("conflict", { detail: "revision.stale" });
    const binding = await this.binding(
      actor.tenantId,
      record.bindingRef,
      record.bindingRevision,
    );
    const action =
      input.scope === "local"
        ? "disconnect"
        : input.scope === "broker"
          ? "disconnect-broker"
          : "disconnect-upstream";
    if (input.scope !== "local" && actor.actorKind !== "human")
      throw new ConnectorError("denied", { detail: "disconnect.human-only" });
    await this.authorize(
      actor,
      { kind: "connection", connection: record, binding },
      action,
      `${action}.denied`,
    );
    const sharedWith = await this.sharedWith(record);
    if (
      input.scope !== "local" &&
      sharedWith.length &&
      !input.acknowledgeSharedImpact
    )
      throw new ConnectorError("conflict", {
        detail: "disconnect.shared-grant",
      });

    const advanced = await port(() =>
      this.ports.connections.advanceGeneration(
        actor,
        connectionRef,
        entry.revision,
      ),
    );
    await this.ports.handoffs.cancelAll(connectionRef, "disconnect");
    let current: ConnectionEntry = {
      record: { ...record, generation: advanced.generation },
      revision: advanced.revision,
    };
    let remote: DisconnectResult = {
      local: "not-attempted",
      broker: "not-attempted",
      upstream: "not-attempted",
    };
    if (input.scope !== "local") {
      const adapter = this.registry.get(binding.adapterId);
      if (adapter?.disconnect)
        remote = await adapterCall(() =>
          adapter.disconnect!(
            this.context(actor, binding, current.record),
            input.scope,
          ),
        );
      else remote = { ...remote, [input.scope]: "unsupported" };
    }
    if (record.credentialRef)
      await this.ports.credentials
        .revoke(this.scope(record), record.credentialRef)
        .catch(() => {});
    await this.ports.evidence
      .invalidate(actor, connectionRef, `disconnect.${input.scope}`)
      .catch(() => {});
    const result: DisconnectResult = {
      local: "applied",
      broker: remote.broker,
      upstream: remote.upstream,
      ...(sharedWith.length || remote.sharedWith?.length
        ? {
            sharedWith: [
              ...new Set([...sharedWith, ...(remote.sharedWith ?? [])]),
            ],
          }
        : {}),
    };
    current = await this.update(actor, current, {
      lifecycle:
        result.upstream === "applied"
          ? "upstream-revoked"
          : "locally-disconnected",
      lastOutcome: `disconnect.${input.scope}`,
    });
    return { result, connection: this.project(actor, current) };
  }

  private async sharedWith(record: ConnectionRecord): Promise<string[]> {
    const shared = new Set<string>();
    for (const [name, value] of Object.entries(record.externalIds)) {
      const other = await this.ports.connections.findByExternalId(
        record.tenantId,
        record.authorityInstance,
        name,
        value,
      );
      if (
        other &&
        other.record.connectionRef !== record.connectionRef &&
        !closed(other.record) &&
        !deleted(other.record)
      )
        shared.add(other.record.connectionRef);
    }
    return [...shared];
  }

  /** Administrative upstream revocation; separate from any user's disconnect. */
  async revoke(
    actor: ActorContext,
    connectionRef: string,
    rawInput: unknown,
  ): Promise<{ result: DisconnectResult; connection: ConnectionView }> {
    requireCapability(actor, "admin");
    if (!actor.capabilities.includes("admin") || actor.actorKind !== "human")
      throw new ConnectorError("denied", { detail: "revoke.admin-only" });
    const input = z
      .strictObject({ expectedRevision: z.number().int().positive() })
      .parse(rawInput);
    const entry = await this.connection(actor, connectionRef);
    const record = entry.record;
    if (entry.revision !== input.expectedRevision)
      throw new ConnectorError("conflict", { detail: "revision.stale" });
    const binding = await this.binding(
      actor.tenantId,
      record.bindingRef,
      record.bindingRevision,
    );
    await this.authorize(
      actor,
      { kind: "connection", connection: record, binding },
      "revoke",
      "revoke.denied",
    );
    const advanced = await port(() =>
      this.ports.connections.advanceGeneration(
        actor,
        connectionRef,
        entry.revision,
      ),
    );
    await this.ports.handoffs.cancelAll(connectionRef, "revoke");
    let current: ConnectionEntry = {
      record: { ...record, generation: advanced.generation },
      revision: advanced.revision,
    };
    const adapter = this.registry.get(binding.adapterId);
    const remote: DisconnectResult = adapter?.revoke
      ? await adapterCall(() =>
          adapter.revoke!(this.context(actor, binding, current.record)),
        )
      : {
          local: "not-attempted",
          broker: "not-attempted",
          upstream: "unsupported",
        };
    if (record.credentialRef)
      await this.ports.credentials
        .revoke(this.scope(record), record.credentialRef)
        .catch(() => {});
    await this.ports.evidence
      .invalidate(actor, connectionRef, "revoke")
      .catch(() => {});
    current = await this.update(actor, current, {
      lifecycle:
        remote.upstream === "applied"
          ? "upstream-revoked"
          : "locally-disconnected",
      lastOutcome:
        remote.upstream === "applied"
          ? "revoke.applied"
          : `revoke.${remote.upstream}`,
    });
    return {
      result: { ...remote, local: "applied" },
      connection: this.project(actor, current),
    };
  }

  /** Administrative purge of a disconnected connection's local record; never an upstream effect. */
  async delete(
    actor: ActorContext,
    connectionRef: string,
    rawInput: unknown,
  ): Promise<{ deleted: true }> {
    requireCapability(actor, "admin");
    if (!actor.capabilities.includes("admin") || actor.actorKind !== "human")
      throw new ConnectorError("denied", { detail: "delete.admin-only" });
    const input = z
      .strictObject({ expectedRevision: z.number().int().positive() })
      .parse(rawInput);
    const entry = await this.connection(actor, connectionRef);
    const record = entry.record;
    if (entry.revision !== input.expectedRevision)
      throw new ConnectorError("conflict", { detail: "revision.stale" });
    if (!closed(record))
      throw new ConnectorError("conflict", {
        detail: "delete.requires-disconnect",
      });
    const binding = await this.binding(
      actor.tenantId,
      record.bindingRef,
      record.bindingRevision,
    );
    await this.authorize(
      actor,
      { kind: "connection", connection: record, binding },
      "delete",
      "delete.denied",
    );
    await this.ports.handoffs.cancelAll(connectionRef, "delete");
    if (record.credentialRef)
      await this.ports.credentials
        .revoke(this.scope(record), record.credentialRef)
        .catch(() => {});
    await this.ports.evidence
      .invalidate(actor, connectionRef, "delete")
      .catch(() => {});
    await this.update(actor, entry, {
      state: { deleted: true },
      lastOutcome: "delete.applied",
    });
    return { deleted: true };
  }

  // --------------------------------------------------------- agent surface

  /**
   * The dependency an assistant's connector intents run on.
   *
   * The intents narrow every result themselves, through
   * `agentConnectorProjection` and `agentDefinitionProjection`, so that one
   * module decides what an assistant may see. That only works if what reaches
   * them is unprojected, and every public method here already projects for
   * the actor it was given. Rather than publish a second, unprojected way to
   * read connections, the seam is built inside the class: it can reach
   * `summary` and `definition` directly, and nothing new leaves the object.
   *
   * Each method rechecks rather than trusting the caller. The actor must be
   * an agent, must hold `executor`, and must pass the same policy questions
   * the equivalent public command asks. A delegation that lapsed between two
   * intents is denied on the second.
   */
  agentDependencies(): AgentConnectorDependencies {
    const agent = (actor: ActorContext): void => {
      if (actor.actorKind !== "agent")
        throw new ConnectorError("denied", { detail: "agent.actor-required" });
      requireCapability(actor, "executor");
    };
    // An absence and a refusal read alike to an assistant, so a reference it
    // may not use is indistinguishable from one that does not exist.
    const absent = async <T>(
      read: () => Promise<T>,
    ): Promise<T | undefined> => {
      try {
        return await read();
      } catch (error) {
        if (
          error instanceof ConnectorError &&
          (error.code === "not-found" || error.code === "denied")
        )
          return undefined;
        throw error;
      }
    };
    return {
      list: async (actor) => {
        agent(actor);
        const entries = await port(() => this.ports.connections.list(actor));
        return entries
          .filter((entry) => !deleted(entry.record))
          .map((entry) => this.summary(entry));
      },
      definition: async (actor, definitionRef) => {
        agent(actor);
        return absent(async () => {
          const definition = await this.definition(
            actor.tenantId,
            definitionRef,
          );
          // An assistant reads a definition through the bindings it may
          // execute, never through the review surface: `getDefinition` is for
          // an author or a reviewer and answers a different question.
          await this.authorize(
            actor,
            { kind: "definition", definition },
            "catalog",
            "definition.denied",
          );
          return definition;
        });
      },
      status: async (actor, connectionRef) => {
        agent(actor);
        return absent(async () => {
          const entry = await this.connection(actor, connectionRef);
          return this.summary(entry);
        });
      },
      operations: async (actor, connectionRef) => {
        agent(actor);
        const entry = await this.connection(actor, connectionRef);
        const binding = this.approved(
          await this.binding(
            actor.tenantId,
            entry.record.bindingRef,
            entry.record.bindingRevision,
          ),
        );
        await this.authorize(
          actor,
          { kind: "connection", connection: entry.record, binding },
          "catalog",
          "operations.denied",
        );
        return binding.operations;
      },
      connect: async (actor, input) => {
        agent(actor);
        // `accountSwitch` is human-only at the service; passing it on keeps
        // the refusal in one place rather than guessing it here.
        const view = await this.connect(actor, {
          bindingRef: input.bindingRef,
          ownerKind: "user",
          durable: false,
          intent: {
            ...(input.accountSwitch === undefined
              ? {}
              : { accountSwitch: input.accountSwitch }),
            ...(input.interruption === undefined
              ? {}
              : { interruption: input.interruption }),
          },
        });
        return this.reread(actor, view);
      },
      reconnect: async (actor, input) => {
        agent(actor);
        const view = await this.reconnect(actor, input.connectionRef, {
          expectedRevision: input.expectedRevision,
          intent: {
            ...(input.accountSwitch === undefined
              ? {}
              : { accountSwitch: input.accountSwitch }),
            ...(input.interruption === undefined
              ? {}
              : { interruption: input.interruption }),
          },
        });
        void view;
        const entry = await this.connection(actor, input.connectionRef);
        return this.summary(entry);
      },
      disconnect: async (actor, input) => {
        agent(actor);
        // Local only. A broker or upstream scope is human-only at the
        // service, and an assistant has no way to ask for one.
        const { result } = await this.disconnect(actor, input.connectionRef, {
          expectedRevision: input.expectedRevision,
          scope: "local",
        });
        return result;
      },
    };
  }

  /**
   * The summary behind a view the service has just returned. `connect` and
   * `reconnect` answer with a projection, and an assistant's intents need the
   * unprojected record to narrow it themselves.
   */
  private async reread(
    actor: ActorContext,
    view: ConnectionView,
  ): Promise<ConnectionSummary> {
    const entry = await this.connection(actor, view.connectionRef);
    return this.summary(entry);
  }
}

function boundOperationTransport(
  value: unknown,
): BoundOperation["transport"] | undefined {
  const parsed = z
    .discriminatedUnion("kind", [
      z.strictObject({
        kind: z.literal("http"),
        method: z.enum([
          "GET",
          "HEAD",
          "POST",
          "PUT",
          "PATCH",
          "DELETE",
          "OPTIONS",
        ]),
        pathTemplate: z
          .string()
          .max(1024)
          .regex(/^\/[^\p{Cc}?#]*$/u),
      }),
      z.strictObject({
        kind: z.literal("mcp-tool"),
        toolName: z.string().min(1).max(512),
      }),
      z.strictObject({
        kind: z.literal("mcp-resource"),
        uriTemplate: z.string().max(2048),
      }),
      z.strictObject({
        kind: z.literal("mcp-prompt"),
        promptName: z.string().min(1).max(512),
      }),
      z.strictObject({
        kind: z.literal("broker-action"),
        action: z.string().min(1).max(512),
      }),
      z.strictObject({
        kind: z.literal("delegated"),
        route: z.string().min(1).max(256),
      }),
    ])
    .safeParse(value);
  return parsed.success
    ? (parsed.data as BoundOperation["transport"])
    : undefined;
}

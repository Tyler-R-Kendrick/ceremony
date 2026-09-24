import { z } from "zod";
import {
  catalogEntrySchema,
  connectionSummarySchema,
  connectorAuditEventSchema,
  normalizedDefinitionSchema,
  sourceRecordSchema,
  type CatalogEntry,
  type ConnectionSummary,
  type ConnectorAuditEvent,
  type NormalizedDefinition,
  type SourceRecord,
} from "./contracts.js";
import {
  portableDefinitionSchema,
  type PortableDefinition,
} from "./envelope.js";
import { evidenceLevels, type EvidenceLevel } from "./identity.js";

/*
 * Projections are positive allowlists. Each one names the fields it emits and
 * constructs a new object from them, so a field added to a record later is
 * nonpublic until a projection is deliberately taught about it. None of these
 * functions ever spreads its input.
 */

/** A URL a person may be shown: HTTPS, or loopback HTTP for local fixtures; no userinfo, no fragment. */
export const presentationUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    !url.username &&
    !url.password &&
    !url.hash &&
    (url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  );
}, "Unsafe presentation URL");

/** The public directory row. Built by the server; the browser only reads it. */
export function publicCatalogProjection(entry: CatalogEntry): CatalogEntry {
  return catalogEntrySchema.parse({
    id: entry.id,
    ecosystem: entry.ecosystem,
    service: entry.service,
    displayName: entry.displayName,
    description: entry.description,
    support: entry.support,
    custody: [...entry.custody],
    runtimes: [...entry.runtimes],
    authentication: [...entry.authentication],
    configuration: entry.configuration.map((item) => ({
      name: item.name,
      required: item.required,
      classification: item.classification,
      present: item.present,
    })),
    capabilities: entry.capabilities.map((status) => ({
      dimension: status.dimension,
      profile: status.profile,
      adapterVersion: status.adapterVersion,
      runtime: status.runtime,
      implementation: status.implementation,
      configuration: status.configuration,
      evidence: status.evidence,
      ...(status.evidenceRef ? { evidenceRef: status.evidenceRef } : {}),
      limitations: [...status.limitations],
    })),
    evidence: entry.evidence,
    ...(entry.supportLabel ? { supportLabel: entry.supportLabel } : {}),
    group: entry.group,
    ...(entry.definitionRef ? { definitionRef: entry.definitionRef } : {}),
  });
}

/** The strongest evidence level among statuses; individual dimensions keep their own. */
export function strongestEvidence(
  levels: readonly EvidenceLevel[],
): EvidenceLevel {
  let best = 0;
  for (const level of levels)
    best = Math.max(best, evidenceLevels.indexOf(level));
  return evidenceLevels[best] ?? "not-tested";
}

export type HumanPresentation = {
  /** Where the person goes to continue; validated, and only ever for the initiating human. */
  url?: string;
  /** A device/user code a person types on another surface. */
  userCode?: string;
  instructions?: string;
};

/**
 * What the authenticated initiating human sees. It is the only projection that
 * may carry a destination URL or a device code, and it carries them only when
 * the caller has already established that this person owns the handoff.
 */
export function humanConnectionProjection(
  summary: ConnectionSummary,
  presentation?: HumanPresentation,
): ConnectionSummary & { presentation?: HumanPresentation } {
  const base = connectionSummarySchema.parse({
    connectionRef: summary.connectionRef,
    bindingRef: summary.bindingRef,
    definitionRef: summary.definitionRef,
    ecosystem: summary.ecosystem,
    service: summary.service,
    displayName: summary.displayName,
    ownerKind: summary.ownerKind,
    custody: summary.custody,
    runtime: summary.runtime,
    lifecycle: summary.lifecycle,
    generation: summary.generation,
    revision: summary.revision,
    ...(summary.target
      ? { target: { kind: summary.target.kind, id: summary.target.id } }
      : {}),
    ...(summary.verification
      ? {
          verification: {
            kinds: [...summary.verification.kinds],
            observedAt: summary.verification.observedAt,
            ...(summary.verification.validUntil
              ? { validUntil: summary.verification.validUntil }
              : {}),
            limitations: [...summary.verification.limitations],
          },
        }
      : {}),
    ...(summary.handoff
      ? {
          handoff: {
            handoffRef: summary.handoff.handoffRef,
            kind: summary.handoff.kind,
            state: summary.handoff.state,
            presentation: summary.handoff.presentation,
            expiresAt: summary.handoff.expiresAt,
            generation: summary.handoff.generation,
          },
        }
      : {}),
    ...(summary.lastOutcome ? { lastOutcome: summary.lastOutcome } : {}),
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
  });
  if (!presentation) return base;
  const shown: HumanPresentation = {};
  if (presentation.url !== undefined)
    shown.url = presentationUrlSchema.parse(presentation.url);
  if (presentation.userCode !== undefined)
    shown.userCode = z
      .string()
      .min(1)
      .max(64)
      .regex(/^[^\p{Cc}]+$/u)
      .parse(presentation.userCode);
  if (presentation.instructions !== undefined)
    shown.instructions = z
      .string()
      .max(500)
      .regex(/^[^\p{Cc}]*$/u)
      .parse(presentation.instructions);
  return { ...base, presentation: shown };
}

/**
 * What a model or tool sees: correlation identifiers and lifecycle, nothing it
 * could navigate to, paste, or use to select an account. Verification is a
 * boolean here because the claims themselves name targets.
 */
export function agentConnectorProjection(summary: ConnectionSummary) {
  const parsed = connectionSummarySchema.parse(
    humanConnectionProjection(summary),
  );
  return {
    connectionRef: parsed.connectionRef,
    bindingRef: parsed.bindingRef,
    ecosystem: parsed.ecosystem,
    service: parsed.service,
    lifecycle: parsed.lifecycle,
    generation: parsed.generation,
    revision: parsed.revision,
    custody: parsed.custody,
    verified:
      parsed.verification !== undefined && parsed.lifecycle === "active",
    ...(parsed.target ? { targetKind: parsed.target.kind } : {}),
    ...(parsed.handoff
      ? { handoff: { kind: parsed.handoff.kind, state: parsed.handoff.state } }
      : {}),
  };
}

/**
 * What a model or tool sees of a definition: identifiers, kinds and declared
 * classifications, never source prose, endpoints, pointers, extensions or
 * diagnostics text. A capability listed here is something the host may later
 * bind, not something the caller can invoke.
 */
export function agentDefinitionProjection(definition: NormalizedDefinition) {
  const checked = normalizedDefinitionSchema.parse(definition);
  return {
    definitionRef: checked.definitionRef,
    identity: {
      ecosystem: checked.identity.ecosystem,
      authorityNamespace: checked.identity.authorityNamespace,
      nativeId: checked.identity.nativeId,
      nativeVersion: checked.identity.nativeVersion,
    },
    displayName: checked.display.name,
    ...(checked.display.service ? { service: checked.display.service } : {}),
    authentication: checked.authentication.map((profile) => ({
      id: profile.id,
      kind: profile.kind,
    })),
    capabilities: checked.capabilities.map((capability) => ({
      kind: capability.kind,
      nativeId: capability.nativeId,
      effect: capability.effect,
      dataClassification: capability.dataClassification,
      cost: capability.cost,
      authentication: [...(capability.authentication ?? [])],
    })),
    dimensions: { ...checked.compatibility.dimensions },
    blocked: checked.compatibility.issues
      .filter((issue) => issue.severity === "blocking")
      .map((issue) => ({
        code: issue.code,
        dimension: issue.dimension,
        executionImpact: issue.executionImpact,
      })),
  };
}

/** What an authorized author or operator reviews before approving a binding. */
export function authorReviewProjection(
  definition: NormalizedDefinition,
  source: SourceRecord,
): {
  definition: NormalizedDefinition;
  source: Omit<SourceRecord, "artifactRef">;
} {
  const checked = normalizedDefinitionSchema.parse(definition);
  const { artifactRef: _artifact, ...provenance } =
    sourceRecordSchema.parse(source);
  void _artifact;
  return { definition: checked, source: provenance };
}

/**
 * What leaves the deployment as a description. Persistence references never
 * travel; native extensions travel only when the exporting operator says so,
 * because a source's extensions can carry examples and vendor fields that were
 * never reviewed for publication.
 */
export function exportDefinitionProjection(
  definition: NormalizedDefinition,
  options: { includeNativeExtensions?: boolean } = {},
): PortableDefinition {
  const checked = normalizedDefinitionSchema.parse(definition);
  const {
    definitionRef: _definitionRef,
    sourceRef: _sourceRef,
    ...portable
  } = checked;
  void _definitionRef;
  void _sourceRef;
  return portableDefinitionSchema.parse({
    ...portable,
    capabilities: portable.capabilities.map((capability) => {
      const { nativeExtensions, ...rest } = capability;
      return options.includeNativeExtensions && nativeExtensions
        ? { ...rest, nativeExtensions }
        : rest;
    }),
    nativeExtensions: options.includeNativeExtensions
      ? portable.nativeExtensions
      : {},
  });
}

export function auditConnectorProjection(
  event: ConnectorAuditEvent,
): ConnectorAuditEvent {
  return connectorAuditEventSchema.parse({
    schemaVersion: 1,
    at: event.at,
    actorKind: event.actorKind,
    action: event.action,
    ...(event.connectionRef ? { connectionRef: event.connectionRef } : {}),
    ...(event.bindingRef ? { bindingRef: event.bindingRef } : {}),
    outcome: event.outcome,
    ...(event.code ? { code: event.code } : {}),
    ...(event.generation === undefined ? {} : { generation: event.generation }),
  });
}

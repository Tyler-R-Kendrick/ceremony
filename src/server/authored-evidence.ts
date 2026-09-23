import { createHash } from "node:crypto";
import { z } from "zod";
import {
  canonicalConnectorJson,
  computeSupportLabel,
  supportEvidenceSchema,
  type SupportEvidence,
  type SupportLabelResult,
} from "../core/connectors/index.js";
import type { ActorContext } from "../core/operation-contracts.js";
import type {
  AsyncCeremonyStore,
  AsyncTransaction,
} from "./persistence/index.js";

/*
 * Support evidence for authored connectors, recorded by the runtime and by
 * nothing else.
 *
 * An authored connector is tenant data, not host code, so no ledger in this
 * repository can speak for it: the suites that exercise the authored
 * operations prove the code path against local doubles, never a provider
 * behind a connector somebody wrote yesterday. Its label is therefore
 * computed like a generic adapter's, per definition, and the only entries
 * that can name its definition are the ones written here.
 *
 * What earns an entry. The authored verifier (`authored.verify-access`)
 * completing: the connector's approved credential-verification request was
 * accepted by the provider, or an authorization finished and its session
 * checked out. A refused, unavailable or unverified run records nothing.
 *
 * Which definition it names. The one the run actually exercised, and only
 * when three reads agree: the credential or session was bound to it when it
 * was created (`bindAuthoredDefinition`), the verifier computed it from the
 * same installed record it probed with, and the installed record still names
 * it when the entry is written. A connector reinstalled at any point in
 * between records nothing, rather than crediting a definition nobody ran;
 * this matters most for a session verified without any network call, whose
 * only exercise of the provider was the exchange that created it.
 *
 * What target it claims. The runtime decides, from the transport the run
 * used, never the author: its own public-only transport can reach nothing
 * but public addresses at the provider's declared origins, so a run through
 * it is `recorded-live`; a loopback development transport is at most a
 * `local-double`; a transport the host supplied records nothing unless the
 * host says what it reaches. See `registerAuthoredOperations`.
 *
 * What it is about. One definition: a digest of the parts of the installed
 * connector that decide where a credential goes and how it is proved (the
 * manifest, the recipe and the provider endpoints and verification request),
 * not the incidental discovery bookkeeping. Editing any of those gives a new
 * definition that nobody has verified, and the label falls back to
 * `unverified` until a run proves the new one.
 *
 * Why it cannot be forged. Entries live under the `evidence` record kind,
 * which no route, tool, authoring command or install path writes; only
 * `recordAuthoredEvidence` does, and only the verifier calls it. A record that
 * does not parse strictly, names another adapter or another connector is
 * read as no evidence at all, so a damaged record fails closed.
 */

/** The adapter id every authored connector's entries carry. */
export const AUTHORED_ADAPTER_ID = "authored";

/** What an authored run may claim: never an attended certification, which only the harness writes. */
export type AuthoredEvidenceTarget = "recorded-live" | "local-double";

/** Entries kept per connector; the oldest are dropped first. */
const MAX_ENTRIES = 16;

const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");

const evidenceKey = (actor: ActorContext, connectorId: string) => ({
  tenant: actor.tenantId,
  kind: "evidence" as const,
  id: `authored-support:${sha256(connectorId).slice(0, 40)}`,
});

const installedKey = (actor: ActorContext, connectorId: string) => ({
  tenant: actor.tenantId,
  kind: "artifact" as const,
  id: `installed-connector:${connectorId}`,
});

const installedSchema = z.object({
  author: z.string(),
  manifest: z.unknown(),
  definition: z.unknown(),
  discovery: z.record(z.string(), z.unknown()).optional(),
});

/**
 * The discovery fields that decide where a credential is sent and how its
 * acceptance is proved. Everything else discovery records (documents read,
 * whether search was used, a retry hint) is bookkeeping that changes between
 * runs without changing what the connector does.
 */
const definingDiscovery = [
  "origin",
  "issuer",
  "authorizationEndpoint",
  "tokenEndpoint",
  "userinfoEndpoint",
  "deviceAuthorizationEndpoint",
  "registrationEndpoint",
  "pushedAuthorizationRequestEndpoint",
  "requirePushedAuthorizationRequests",
  "clientId",
  "scopes",
  "tokenEndpointAuthMethod",
  "authorizationParams",
  "dpopRequired",
  "credentialVerification",
] as const;

/** `sha256:<digest>` of an installed connector's defining parts. */
export function authoredDefinitionName(installed: {
  manifest: unknown;
  definition: unknown;
  discovery?: Record<string, unknown> | undefined;
}): string {
  const discovery = Object.fromEntries(
    definingDiscovery.flatMap((name) =>
      installed.discovery?.[name] === undefined
        ? []
        : [[name, installed.discovery[name]]],
    ),
  );
  return `sha256:${sha256(
    canonicalConnectorJson({
      manifest: installed.manifest,
      definition: installed.definition,
      discovery,
    }),
  )}`;
}

const storedSchema = z.strictObject({
  schemaVersion: z.literal(1),
  connectorId: z.string(),
  entries: z.array(supportEvidenceSchema).max(MAX_ENTRIES),
});

/** The installed record as this actor may use it: their own connector, or nothing. */
function ownInstalled(value: unknown, actor: ActorContext) {
  const parsed = installedSchema.safeParse(value);
  return parsed.success && parsed.data.author === actor.subjectId
    ? parsed.data
    : undefined;
}

/**
 * The definition name of an installed-connector record as read, or nothing
 * when it is not this actor's. A caller that acts on a record computes the
 * name from the same read it acts on, so the name is of what it used.
 */
export function authoredDefinitionOf(
  value: unknown,
  actor: ActorContext,
): string | undefined {
  const installed = ownInstalled(value, actor);
  return installed ? authoredDefinitionName(installed) : undefined;
}

/**
 * The definition a credential or session is bound to when it is created:
 * the installed record read in the same transaction, provided the discovery
 * the ceremony actually used defines the same connector. A ceremony that ran
 * against discovery the installed record no longer (or not yet) carries is
 * bound to nothing, and can never be evidence.
 */
export async function bindAuthoredDefinition(
  tx: AsyncTransaction,
  actor: ActorContext,
  connectorId: string,
  used?: Record<string, unknown>,
): Promise<string | undefined> {
  const installed = ownInstalled(
    (await tx.get(installedKey(actor, connectorId)))?.value,
    actor,
  );
  if (!installed) return undefined;
  const name = authoredDefinitionName(installed);
  if (
    used &&
    authoredDefinitionName({ ...installed, discovery: used }) !== name
  )
    return undefined;
  return name;
}

async function readInstalled(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  connectorId: string,
) {
  const record = await store.transaction((tx) =>
    tx.get(installedKey(actor, connectorId)),
  );
  return ownInstalled(record?.value, actor);
}

/** Entries for this connector, or none when the record is absent or does not parse exactly. */
async function readEntries(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  connectorId: string,
): Promise<{ entries: SupportEvidence[]; revision: number | null }> {
  const record = await store.transaction((tx) =>
    tx.get(evidenceKey(actor, connectorId)),
  );
  if (!record) return { entries: [], revision: null };
  const parsed = storedSchema.safeParse(record.value);
  if (!parsed.success || parsed.data.connectorId !== connectorId)
    return { entries: [], revision: record.revision };
  return {
    entries: parsed.data.entries.filter(
      (entry) =>
        entry.adapterId === AUTHORED_ADAPTER_ID &&
        entry.check.startsWith("authored-run:") &&
        entry.definition !== undefined,
    ),
    revision: record.revision,
  };
}

/**
 * Records that a verified run exercised `definition`: the name the verifier
 * computed from the installed record it acted on, which also matched the
 * definition its credential or session was bound to. Called only by the
 * authored verifier, after the provider accepted the credential or the
 * authorization's session checked out.
 *
 * The write re-reads the installed record in its own transaction and is
 * refused unless it still names that definition. A reinstall while the probe
 * was in flight would otherwise have the probe of one definition recorded
 * as evidence for another, which nothing ever ran. Returns the entry, or
 * nothing when the write was refused.
 */
export async function recordAuthoredEvidence(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  input: {
    connectorId: string;
    runId: string;
    definition: string;
    target: AuthoredEvidenceTarget;
    proof: "credential-accepted" | "authorization-verified";
    now: number;
  },
): Promise<SupportEvidence | undefined> {
  const entry = supportEvidenceSchema.parse({
    adapterId: AUTHORED_ADAPTER_ID,
    // The run is named by a digest: a run id is an internal reference, and
    // the entry is shown to whoever reads the connector's label.
    check: `authored-run:${sha256(`${actor.tenantId}\u0000${input.runId}`).slice(0, 32)}`,
    target: input.target,
    recordedAt: new Date(input.now).toISOString().slice(0, 10),
    definition: input.definition,
    notes:
      input.proof === "credential-accepted"
        ? "The approved credential-verification request was accepted by the provider."
        : "An authorization completed and its session was verified.",
  });
  return store.transaction(async (tx) => {
    if (
      (await bindAuthoredDefinition(tx, actor, input.connectorId)) !==
      input.definition
    )
      return undefined;
    const key = evidenceKey(actor, input.connectorId);
    const current = await tx.get(key);
    const parsed = storedSchema.safeParse(current?.value);
    const prior =
      parsed.success && parsed.data.connectorId === input.connectorId
        ? parsed.data.entries
        : [];
    // One entry per definition and target is enough to label it: the most
    // recent. Older definitions stay (a revert regains them) up to the bound.
    const kept = prior.filter(
      (item) =>
        !(item.definition === entry.definition && item.target === entry.target),
    );
    await tx.put(
      key,
      {
        schemaVersion: 1,
        connectorId: input.connectorId,
        entries: [...kept, entry].slice(-MAX_ENTRIES),
      },
      current?.revision ?? null,
    );
    return entry;
  });
}

/**
 * The label of this connector's current definition, from runtime-recorded
 * entries only. An authored connector that is not installed for this actor,
 * or whose definition no run has verified, is `unverified`.
 */
export async function authoredSupportLabel(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  connectorId: string,
  now: number,
): Promise<SupportLabelResult> {
  const installed = await readInstalled(store, actor, connectorId);
  const { entries } = await readEntries(store, actor, connectorId);
  return computeSupportLabel(AUTHORED_ADAPTER_ID, entries, {
    asOf: now,
    // The provider's configuration is the connector itself; a run could not
    // have verified without it.
    configured: true,
    definitionScoped: true,
    definitions:
      installed && installed.author === actor.subjectId
        ? [authoredDefinitionName(installed)]
        : [],
  });
}

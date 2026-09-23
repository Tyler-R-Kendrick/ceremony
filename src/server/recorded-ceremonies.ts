import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CeremonyPlan } from "../core/ceremony-plan.js";
import {
  ceremonyPlanFromRecording,
  digestRecordedCeremony,
  recordedCeremonySchema,
  recordingReferenceSchema,
  type RecordedCeremony,
  type RecordingReference,
} from "../core/recorded-ceremony.js";
import { AuthorizationError, requireCapability } from "./identity.js";
import type { ActorContext, Capability } from "./identity.js";
import {
  PersistenceConflict,
  type AsyncCeremonyStore,
  type AsyncTransaction,
} from "./persistence/index.js";

/**
 * Recorded ceremonies, from draft to something another login may replay.
 *
 * The lifecycle is the one recipes already have, for the same reason: an
 * artifact that decides what is typed where on somebody's sign-in page is
 * not something an agent gets to put into service on its own say-so.
 *
 * - **Draft.** Whoever holds `author` may save one — including an agent that
 *   just recorded a login. A draft is visible to its author, and to the
 *   people who review and publish; nobody else can replay it.
 * - **Review.** A person holding `reviewer` approves one exact revision and
 *   digest. Editing the draft is a new revision, and the review no longer
 *   covers it.
 * - **Publish.** A person holding `publisher` publishes a reviewed digest as a
 *   new immutable version. Only a published version, named by version *and*
 *   digest, can be replayed by `browser_login`.
 *
 * Review and publication also require a human actor. Capabilities say what a
 * token may do; `actorKind` says who is holding it, and "publishing stays
 * human" is a statement about the second. No MCP tool calls either method.
 *
 * Nothing stored here holds a value. The recording was checked against every
 * value the login resolved before it was handed over, and it is re-parsed
 * through the schema — which has no field for one — on every read and write.
 */

const draftIdSchema = z
  .string()
  .regex(
    /^recorded-ceremony:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );

const outcomeSchema = z.enum(["verified", "submitted-unverified"]);
const connectorIdSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.:-]{0,119}$/);

const draftRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  author: z.string().min(1).max(200),
  session: z.string().min(1).max(200),
  connectorId: connectorIdSchema,
  /** What the recorded login established. A reviewer weighs the two differently. */
  outcome: outcomeSchema,
  digest: z.string(),
  recording: z.unknown(),
});
const reviewRecordSchema = z.strictObject({
  digest: z.string(),
  reviewer: z.string(),
});
const publishedRecordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  version: z.string(),
  digest: z.string(),
  connectorId: connectorIdSchema,
  outcome: outcomeSchema,
  author: z.string(),
  reviewer: z.string(),
  publisher: z.string(),
  retired: z.boolean(),
  recording: z.unknown(),
});

export type RecordedCeremonyDraft = {
  draftId: string;
  revision: number;
  digest: string;
  connectorId: string;
  outcome: z.infer<typeof outcomeSchema>;
  recording: RecordedCeremony;
  /** What the recording implies a caller must be able to supply. */
  plan: CeremonyPlan;
};

export type PublishedRecordedCeremony = RecordingReference & {
  connectorId: string;
  outcome: z.infer<typeof outcomeSchema>;
  recording: RecordedCeremony;
};

/** Public inputs, shared by the MCP tools and the HTTP routes. */
export const recordedCeremonyInputs = {
  /** Exactly one of a draft id or a published reference. */
  read: z
    .strictObject({
      draftId: draftIdSchema.optional(),
      published: recordingReferenceSchema.optional(),
    })
    .refine(
      (input) =>
        (input.draftId === undefined) !== (input.published === undefined),
      "Name a draft or a published version, not both",
    ),
  review: z.strictObject({
    revision: z.number().int().positive(),
    digest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  }),
} as const;

function draftKey(actor: ActorContext, draftId: string) {
  return { tenant: actor.tenantId, kind: "draft" as const, id: draftId };
}
function reviewKey(actor: ActorContext, draftId: string, revision: number) {
  return {
    tenant: actor.tenantId,
    kind: "review" as const,
    id: `${draftId}:${revision}`,
  };
}
function publishedKey(actor: ActorContext, id: string, version: string) {
  return {
    tenant: actor.tenantId,
    kind: "artifact" as const,
    id: `recorded-ceremony:${id}@${version}`,
  };
}

const holds = (actor: ActorContext, ...capabilities: Capability[]) =>
  actor.capabilities.includes("admin") ||
  capabilities.some((capability) => actor.capabilities.includes(capability));

/** Only a person reviews or publishes. */
function requireHuman(actor: ActorContext) {
  if (actor.actorKind !== "human") throw new AuthorizationError("denied");
}

async function parsed(recording: unknown): Promise<{
  recording: RecordedCeremony;
  digest: string;
}> {
  const value = recordedCeremonySchema.parse(recording);
  return { recording: value, digest: await digestRecordedCeremony(value) };
}

export class RecordedCeremonies {
  constructor(private readonly store: AsyncCeremonyStore) {}

  /** Save what a login recorded as a new draft owned by the actor. */
  async saveDraft(
    actor: ActorContext,
    recording: RecordedCeremony,
    meta: {
      connectorId: string;
      outcome: z.infer<typeof outcomeSchema>;
    },
  ): Promise<RecordedCeremonyDraft> {
    requireCapability(actor, "author");
    const checked = await parsed(recording);
    const draftId = `recorded-ceremony:${randomUUID()}`;
    const record: z.infer<typeof draftRecordSchema> = {
      schemaVersion: 1,
      author: actor.subjectId,
      session: actor.sessionId,
      connectorId: connectorIdSchema.parse(meta.connectorId),
      outcome: meta.outcome,
      digest: checked.digest,
      recording: checked.recording,
    };
    const revision = await this.store.transaction((tx) =>
      tx.put(draftKey(actor, draftId), record, null),
    );
    return this.present(draftId, revision, record, checked.recording);
  }

  /**
   * A draft, for its author or for the people who review and publish.
   * Anyone else is told it does not exist, which is also what a missing one
   * says: the two must not be distinguishable.
   */
  async readDraft(
    actor: ActorContext,
    draftId: string,
  ): Promise<RecordedCeremonyDraft> {
    draftIdSchema.parse(draftId);
    const current = await this.store.transaction((tx) =>
      tx.get(draftKey(actor, draftId)),
    );
    if (!current) throw new AuthorizationError("denied");
    const record = draftRecordSchema.safeParse(current.value);
    if (!record.success) throw new AuthorizationError("denied");
    const own =
      record.data.author === actor.subjectId && holds(actor, "author");
    if (!own && !holds(actor, "reviewer", "publisher"))
      throw new AuthorizationError("denied");
    const checked = await parsed(record.data.recording);
    return this.present(
      draftId,
      current.revision,
      record.data,
      checked.recording,
    );
  }

  /** Approve one exact revision and digest of a draft. */
  async review(
    actor: ActorContext,
    draftId: string,
    input: unknown,
  ): Promise<{ reviewed: true; draftId: string; revision: number }> {
    requireCapability(actor, "reviewer");
    requireHuman(actor);
    draftIdSchema.parse(draftId);
    const { revision, digest } = recordedCeremonyInputs.review.parse(input);
    return this.store.transaction(async (tx) => {
      const record = await this.current(tx, actor, draftId, revision, digest);
      const key = reviewKey(actor, draftId, revision);
      const previous = await tx.get(key);
      await tx.put(
        key,
        { digest: record.digest, reviewer: actor.subjectId },
        previous?.revision ?? null,
      );
      return { reviewed: true as const, draftId, revision };
    });
  }

  /**
   * Publish a reviewed digest as a new immutable version. The version is
   * minted here; nothing a caller sends chooses it.
   */
  async publish(
    actor: ActorContext,
    draftId: string,
    input: unknown,
  ): Promise<RecordingReference> {
    requireCapability(actor, "publisher");
    requireHuman(actor);
    draftIdSchema.parse(draftId);
    const { revision, digest } = recordedCeremonyInputs.review.parse(input);
    return this.store.transaction(async (tx) => {
      const record = await this.current(tx, actor, draftId, revision, digest);
      const review = await tx.get(reviewKey(actor, draftId, revision));
      const approved = review
        ? reviewRecordSchema.safeParse(review.value)
        : undefined;
      if (!approved?.success || approved.data.digest !== digest)
        throw new AuthorizationError("invalid_request");
      const checked = await parsed(record.recording);
      const counterKey = {
        tenant: actor.tenantId,
        kind: "session" as const,
        id: `recorded-ceremony:${checked.recording.id}@counter`,
      };
      const counter = await tx.get<{ next: number }>(counterKey);
      const next = counter?.value.next ?? 1;
      const version = `1.0.${next}`;
      await tx.put(counterKey, { next: next + 1 }, counter?.revision ?? null);
      const published: z.infer<typeof publishedRecordSchema> = {
        schemaVersion: 1,
        version,
        digest,
        connectorId: record.connectorId,
        outcome: record.outcome,
        author: record.author,
        reviewer: approved.data.reviewer,
        publisher: actor.subjectId,
        retired: false,
        recording: checked.recording,
      };
      await tx.put(
        publishedKey(actor, checked.recording.id, version),
        published,
        null,
      );
      return { id: checked.recording.id, version, digest };
    });
  }

  /**
   * A published version, pinned by digest. The stored bytes are digested
   * again on the way out, so a record that changed underneath its digest is
   * refused rather than replayed.
   */
  async getPublished(
    actor: ActorContext,
    reference: RecordingReference,
  ): Promise<PublishedRecordedCeremony | undefined> {
    if (!holds(actor, "executor", "author", "reviewer", "publisher"))
      throw new AuthorizationError("denied");
    const ref = recordingReferenceSchema.parse(reference);
    const stored = await this.store.transaction((tx) =>
      tx.get(publishedKey(actor, ref.id, ref.version)),
    );
    if (!stored) return undefined;
    const record = publishedRecordSchema.safeParse(stored.value);
    if (!record.success || record.data.retired) return undefined;
    if (record.data.digest !== ref.digest) return undefined;
    const checked = await parsed(record.data.recording);
    if (checked.digest !== ref.digest) return undefined;
    return {
      ...ref,
      connectorId: record.data.connectorId,
      outcome: record.data.outcome,
      recording: checked.recording,
    };
  }

  /** Stop a version being replayed. It stays readable to nobody. */
  async retire(actor: ActorContext, reference: RecordingReference) {
    requireCapability(actor, "admin");
    const ref = recordingReferenceSchema.parse(reference);
    await this.store.transaction(async (tx) => {
      const key = publishedKey(actor, ref.id, ref.version);
      const stored = await tx.get(key);
      if (!stored) throw new AuthorizationError("denied");
      const record = publishedRecordSchema.parse(stored.value);
      await tx.put(key, { ...record, retired: true }, stored.revision);
    });
  }

  private async current(
    tx: AsyncTransaction,
    actor: ActorContext,
    draftId: string,
    revision: number,
    digest: string,
  ): Promise<z.infer<typeof draftRecordSchema>> {
    const current = await tx.get(draftKey(actor, draftId));
    if (!current) throw new AuthorizationError("denied");
    const record = draftRecordSchema.safeParse(current.value);
    if (!record.success) throw new AuthorizationError("denied");
    if (current.revision !== revision) throw new PersistenceConflict();
    if (record.data.digest !== digest)
      throw new AuthorizationError("invalid_request");
    return record.data;
  }

  private present(
    draftId: string,
    revision: number,
    record: z.infer<typeof draftRecordSchema>,
    recording: RecordedCeremony,
  ): RecordedCeremonyDraft {
    return {
      draftId,
      revision,
      digest: record.digest,
      connectorId: record.connectorId,
      outcome: record.outcome,
      recording,
      plan: ceremonyPlanFromRecording(recording),
    };
  }
}

/**
 * The people's routes: read a draft, review it, publish it. Mounted by the
 * teaching HTTP surface under `/recorded-ceremonies/`; there is no MCP
 * equivalent for review or publication, on purpose.
 *
 * Returns `undefined` for a path this does not own, so the caller can answer
 * 404 the way it answers every other unknown path.
 */
export async function recordedCeremonyRoute(
  recordings: RecordedCeremonies | undefined,
  actor: ActorContext,
  path: string,
  post: boolean,
  body: unknown,
): Promise<unknown> {
  const match =
    /^\/recorded-ceremonies\/drafts\/([^/]+)(?:\/(review|publish))?$/.exec(
      path,
    );
  if (!match || !recordings) return undefined;
  const draftId = draftIdSchema.parse(decodeURIComponent(match[1]!));
  if (!post && !match[2]) return recordings.readDraft(actor, draftId);
  if (post && match[2] === "review")
    return recordings.review(actor, draftId, body);
  if (post && match[2] === "publish")
    return recordings.publish(actor, draftId, body);
  return undefined;
}

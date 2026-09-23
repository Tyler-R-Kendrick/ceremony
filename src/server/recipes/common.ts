import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { ActorContext } from "../../core/operation-contracts.js";
import type { AsyncCeremonyStore } from "../persistence/index.js";
import {
  verificationFromMessage,
  type ProgrammableInbox,
} from "../authored-inbox.js";
import {
  NEUTRAL_PROVIDER,
  type OperationContext,
  type OperationRegistry,
  type OperationResult,
  type VocabularyEntry,
} from "./registry.js";

/**
 * Provider-neutral ("common") steps: reusable pieces of a ceremony that any
 * provider's recipe may include, such as an agent-controlled inbox that
 * receives a verification email. They are registered through
 * `OperationRegistry.registerNeutral`, read and write only this vocabulary, and
 * never touch provider artifacts.
 *
 * Secret material (the inbox address, a code, a link) stays in server-side
 * records bound to the run that created them. A binding carries only an opaque
 * random handle, and the handles are artifact-classified, so neither snapshots
 * nor audit events ever include them. A trusted provider handler resolves a
 * handle with the readers below, for its own run only.
 */
const handleSchema = (kind: string) =>
  z.string().regex(new RegExp(`^common-${kind}-[a-f0-9]{32}$`));
const neutral = (
  schema: z.ZodType,
  classification: VocabularyEntry["classification"],
): VocabularyEntry => ({
  schema,
  classification,
  provider: NEUTRAL_PROVIDER,
  profile: NEUTRAL_PROVIDER,
  // Neutral values name nothing provider-specific (a run-bound handle, a
  // public host name), so they may cross between the connectors of one run.
  crossProvider: true,
});
export const commonVocabulary = new Map<string, VocabularyEntry>([
  ["common.inbox", neutral(handleSchema("inbox"), "artifact")],
  ["common.verification", neutral(handleSchema("verification"), "artifact")],
  /**
   * The shared contract for "create a client at provider A, use it at
   * provider B": an opaque handle to a client registration held server-side
   * for the run that minted it. Provider A's trusted handler stores the
   * client with `mintOAuthClient`; provider B's resolves it with
   * `readOAuthClient`. The secret never enters a binding, a snapshot or an
   * event.
   */
  ["common.oauth-client", neutral(handleSchema("client"), "artifact")],
  [
    "common.link-host",
    neutral(
      z
        .string()
        .max(253)
        .regex(/^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/),
      "public",
    ),
  ],
]);
export const commonOperations = {
  provisionInbox: { id: "common.provision-inbox", version: "1.0.0" },
  awaitInboxVerification: {
    id: "common.await-inbox-verification",
    version: "1.0.0",
  },
} as const;

/** Codes and links are short-lived; an address outlives one registration attempt. */
const INBOX_TTL_MS = 60 * 60_000;
const VERIFICATION_TTL_MS = 15 * 60_000;
const inboxRecordSchema = z.strictObject({
  kind: z.literal("inbox"),
  runId: z.string(),
  subjectId: z.string(),
  address: z.email().max(320),
  since: z.number(),
  expires: z.number(),
});
const verificationRecordSchema = z.strictObject({
  kind: z.literal("verification"),
  runId: z.string(),
  subjectId: z.string(),
  code: z.string().max(16).optional(),
  link: z.string().max(2100).optional(),
  expires: z.number(),
});
const oauthClientRecordSchema = z.strictObject({
  kind: z.literal("oauth-client"),
  runId: z.string(),
  subjectId: z.string(),
  clientId: z.string().min(1).max(512),
  clientSecret: z.string().min(1).max(4096).optional(),
  expires: z.number(),
});
/** A client registration outlives one step but not the run that needs it. */
const OAUTH_CLIENT_TTL_MS = 60 * 60_000;
type Owner = { actor: ActorContext; runId: string };
const recordKey = (actor: ActorContext, handle: string) => ({
  tenant: actor.tenantId,
  kind: "artifact" as const,
  id: `common-step:${handle}`,
});
const newHandle = (kind: "inbox" | "verification" | "client") =>
  `common-${kind}-${randomBytes(16).toString("hex")}`;

async function readRecord<T extends { runId: string; subjectId: string }>(
  store: AsyncCeremonyStore,
  owner: Owner,
  handle: unknown,
  schema: z.ZodType<T & { expires: number }>,
  consume = false,
): Promise<T | undefined> {
  if (
    typeof handle !== "string" ||
    !/^common-[a-z]+-[a-f0-9]{32}$/.test(handle)
  )
    return undefined;
  return store.transaction(async (tx) => {
    const key = recordKey(owner.actor, handle);
    const record = await tx.get(key);
    const parsed = schema.safeParse(record?.value);
    // A handle is meaningful only inside the run (and subject) that minted it.
    if (
      !record ||
      !parsed.success ||
      parsed.data.runId !== owner.runId ||
      parsed.data.subjectId !== owner.actor.subjectId ||
      parsed.data.expires <= (await tx.now())
    )
      return undefined;
    if (consume) await tx.delete(key, record.revision);
    return parsed.data;
  });
}

/** Trusted server-side resolution of an inbox handle to its address. Never a tool result. */
export async function readInboxAddress(
  store: AsyncCeremonyStore,
  owner: Owner,
  handle: unknown,
): Promise<string | undefined> {
  return (await readRecord(store, owner, handle, inboxRecordSchema))?.address;
}

/**
 * Trusted single use of a received code or link by the provider step that
 * submits it. The record is deleted on read, so a replayed binding finds
 * nothing.
 */
export async function consumeInboxVerification(
  store: AsyncCeremonyStore,
  owner: Owner,
  handle: unknown,
): Promise<{ code?: string; link?: string } | undefined> {
  const record = await readRecord(
    store,
    owner,
    handle,
    verificationRecordSchema,
    true,
  );
  if (!record) return undefined;
  return {
    ...(record.code ? { code: record.code } : {}),
    ...(record.link ? { link: record.link } : {}),
  };
}

/**
 * Trusted storage of a client registration by the provider step that created
 * it. Returns the opaque `common.oauth-client` handle the step outputs; the
 * identifier and secret stay in this record, bound to the run and subject.
 */
export async function mintOAuthClient(
  store: AsyncCeremonyStore,
  owner: Owner,
  client: { clientId: string; clientSecret?: string },
): Promise<string> {
  const handle = newHandle("client");
  await store.transaction(async (tx) => {
    await tx.put(
      recordKey(owner.actor, handle),
      oauthClientRecordSchema.parse({
        kind: "oauth-client",
        runId: owner.runId,
        subjectId: owner.actor.subjectId,
        clientId: client.clientId,
        ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
        expires: (await tx.now()) + OAUTH_CLIENT_TTL_MS,
      }),
      null,
    );
  });
  return handle;
}

/**
 * Trusted server-side resolution of a `common.oauth-client` handle, for a
 * step of the same run, whichever connector's context that step runs in.
 * Never a tool result.
 */
export async function readOAuthClient(
  store: AsyncCeremonyStore,
  owner: Owner,
  handle: unknown,
): Promise<{ clientId: string; clientSecret?: string } | undefined> {
  const record = await readRecord(
    store,
    owner,
    handle,
    oauthClientRecordSchema,
  );
  if (!record) return undefined;
  return {
    clientId: record.clientId,
    ...(record.clientSecret ? { clientSecret: record.clientSecret } : {}),
  };
}

/**
 * Register the provider-neutral steps. `inbox` is the host's agent inbox (the
 * same one authored account registration uses); without it the inbox steps
 * report `unavailable` instead of pretending to wait.
 */
export function registerCommonOperations(
  registry: OperationRegistry,
  options: { store: AsyncCeremonyStore; inbox?: ProgrammableInbox },
): void {
  const { store, inbox } = options;
  const unavailable: OperationResult = {
    state: "failed",
    outputs: {},
    diagnosticCode: "unavailable",
  };
  const contract = (
    operation: { id: string; version: string },
    inputs: Record<string, { contract: string; required: boolean }>,
    outputs: Record<string, { contract: string; required: boolean }>,
  ) => ({
    id: operation.id,
    version: operation.version,
    provider: NEUTRAL_PROVIDER,
    profile: NEUTRAL_PROVIDER,
    inputs,
    outputs,
    effects: [operation.id],
    verifier: operation.id,
    humanFallback: "common.none",
  });
  const fixtures = ["tests/recipe-common.test.ts"];

  registry.registerNeutral({
    contract: contract(
      commonOperations.provisionInbox,
      {},
      { inbox: { contract: "common.inbox", required: true } },
    ),
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({ inbox: handleSchema("inbox") }),
    classifications: {},
    fixtures,
    handler: async (context: OperationContext) => {
      if (!inbox) return unavailable;
      let address: string;
      try {
        address = z
          .email()
          .max(320)
          .parse(await inbox.provision());
      } catch {
        // A lost provision only orphans a disposable address, so this is a
        // plain failure the agent may retry, not an uncertain effect.
        return unavailable;
      }
      const handle = newHandle("inbox");
      await store.transaction(async (tx) => {
        const now = await tx.now();
        await tx.put(
          recordKey(context.actor, handle),
          {
            kind: "inbox",
            runId: context.runId,
            subjectId: context.actor.subjectId,
            address,
            since: now,
            expires: now + INBOX_TTL_MS,
          } satisfies z.infer<typeof inboxRecordSchema>,
          null,
        );
      });
      return { state: "complete", outputs: { inbox: handle } };
    },
    verify: async (context, result) =>
      result.state === "complete" &&
      Boolean(await readInboxAddress(store, context, result.outputs.inbox)),
  });

  registry.registerNeutral({
    contract: contract(
      commonOperations.awaitInboxVerification,
      {
        inbox: { contract: "common.inbox", required: true },
        linkHost: { contract: "common.link-host", required: false },
      },
      { verification: { contract: "common.verification", required: true } },
    ),
    inputSchema: z.strictObject({
      inbox: handleSchema("inbox"),
      linkHost: commonVocabulary.get("common.link-host")!.schema.optional(),
    }) as z.ZodType<Record<string, unknown>>,
    outputSchema: z.strictObject({
      verification: handleSchema("verification"),
    }),
    classifications: {
      inbox: { classification: "artifact", schema: handleSchema("inbox") },
      linkHost: {
        classification: "public",
        schema: commonVocabulary.get("common.link-host")!.schema,
      },
    },
    fixtures,
    handler: async (context: OperationContext, inputs) => {
      if (!inbox) return unavailable;
      const record = await readRecord(
        store,
        context,
        inputs.inbox,
        inboxRecordSchema,
      );
      if (!record) return unavailable;
      const message = await inbox
        .latest(record.address, record.since)
        .catch(() => undefined);
      const found = message
        ? verificationFromMessage(
            message,
            typeof inputs.linkHost === "string" ? inputs.linkHost : undefined,
          )
        : undefined;
      // Nothing yet is not a failure: the node stays open and is advanced again.
      if (!message || !found) return { state: "verifying", outputs: {} };
      const handle = newHandle("verification");
      await store.transaction(async (tx) => {
        const now = await tx.now();
        const key = recordKey(context.actor, inputs.inbox as string);
        const current = await tx.get(key);
        const parsed = inboxRecordSchema.safeParse(current?.value);
        if (current && parsed.success)
          // A later wait on the same inbox needs a newer message, never this one again.
          await tx.put(
            key,
            { ...parsed.data, since: message.at + 1 },
            current.revision,
          );
        await tx.put(
          recordKey(context.actor, handle),
          {
            kind: "verification",
            runId: context.runId,
            subjectId: context.actor.subjectId,
            ...found,
            expires: now + VERIFICATION_TTL_MS,
          } satisfies z.infer<typeof verificationRecordSchema>,
          null,
        );
      });
      return { state: "complete", outputs: { verification: handle } };
    },
    verify: async (context, result) =>
      result.state === "complete" &&
      Boolean(
        await readRecord(
          store,
          context,
          result.outputs.verification,
          verificationRecordSchema,
        ),
      ),
  });
}

import { createHash, randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { importJWK, type CryptoKey } from "jose";
import { z } from "zod";
import { Agent2Human, type A2HRecordStore } from "../a2h.js";
import { CeremonyDatabase } from "../storage.js";
import {
  PersistenceConflict,
  type AsyncCeremonyStore,
  type Fence,
} from "../persistence/index.js";
import type { RunRecord } from "../commands.js";

const recipientSchema = z.strictObject({
  principalId: z.string().min(1).max(200),
  type: z.enum(["email", "sms"]),
  address: z.string().min(1).max(200),
});

export function postgresA2HRecords(
  store: AsyncCeremonyStore,
  tenant: string,
  namespace?: () => string | undefined,
): A2HRecordStore {
  const activeDelivery = new AsyncLocalStorage<{
    fence: Fence;
    namespace: string | undefined;
  }>();
  const key = (id: string, scope?: string) => ({
    tenant,
    kind: "handoff" as const,
    id: scope ? `a2h:${scope}:${id}` : `a2h:${id}`,
  });
  return {
    async lock(id, work) {
      const delivery = await store.transaction(async (tx) => {
        // Old and new binaries must contend for the same run lease. Keep the
        // first assignment at its legacy key, including uncertain deliveries.
        const fence = await tx.claim(key(id), "a2h", 30_000);
        const scope = namespace?.();
        const legacy = await tx.get<{
          message?: { channel?: { render?: { body?: unknown } } };
        }>(key(id));
        const body = legacy?.value.message?.channel?.render?.body;
        // The signed render URL binds the assignment in the legacy format.
        // Unknown formats stay put and fail closed in the full Agent2Human
        // context checks; never guess that they are a renewal.
        const previousAssignment =
          typeof body === "string"
            ? /\/api\/v1\/teaching\/jira\/owner-setup\/([a-f0-9-]{36})\./.exec(
                body,
              )?.[1]
            : undefined;
        return {
          fence,
          namespace:
            previousAssignment && previousAssignment !== scope
              ? scope
              : undefined,
        };
      });
      try {
        return await activeDelivery.run(delivery, work);
      } finally {
        await store.transaction(async (tx) => {
          await tx.assertFence(delivery.fence);
          await tx.cancel(delivery.fence);
        });
      }
    },
    async get(id, schema) {
      const record = await store.transaction((tx) =>
        tx.get(key(id, activeDelivery.getStore()?.namespace)),
      );
      return record ? schema.parse(record.value) : undefined;
    },
    async put(id, value) {
      const delivery = activeDelivery.getStore();
      if (!delivery) throw new PersistenceConflict();
      await store.transaction(async (tx) => {
        await tx.assertFence(delivery.fence);
        const recordKey = key(id, delivery.namespace);
        const current = await tx.get(recordKey);
        await tx.put(recordKey, value, current?.revision ?? null);
      });
    },
  };
}

export async function hostedJiraOwnerDelivery(
  env: NodeJS.ProcessEnv,
  store: AsyncCeremonyStore,
  origin: string,
  tenant: string,
  scopes: readonly string[],
  fetcher?: typeof fetch,
) {
  const present = [
    env.CEREMONY_A2H_GATEWAY_ORIGIN,
    env.CEREMONY_A2H_AGENT_ID,
    env.CEREMONY_A2H_KEY_ID,
    env.CEREMONY_A2H_PRIVATE_JWK,
    env.CEREMONY_A2H_GATEWAY_JWK,
    env.CEREMONY_A2H_API_KEY,
    env.CEREMONY_A2H_RECIPIENTS,
  ];
  if (present.every((value) => !value)) return undefined;
  const parsed = z
    .strictObject({
      gatewayOrigin: z.url(),
      agentId: z.string().min(1).max(200),
      keyId: z.string().min(1).max(100),
      privateJwk: z.string().min(1).max(8000),
      gatewayJwk: z.string().min(1).max(8000),
      apiKey: z.string().min(1).max(200),
      recipients: z.string().min(1).max(20000),
    })
    .safeParse({
      gatewayOrigin: env.CEREMONY_A2H_GATEWAY_ORIGIN,
      agentId: env.CEREMONY_A2H_AGENT_ID,
      keyId: env.CEREMONY_A2H_KEY_ID,
      privateJwk: env.CEREMONY_A2H_PRIVATE_JWK,
      gatewayJwk: env.CEREMONY_A2H_GATEWAY_JWK,
      apiKey: env.CEREMONY_A2H_API_KEY,
      recipients: env.CEREMONY_A2H_RECIPIENTS,
    });
  if (!parsed.success) throw new Error("Incomplete hosted A2H configuration");
  const recipients = z
    .record(z.string().min(1).max(200), recipientSchema)
    .parse(JSON.parse(parsed.data.recipients));
  const privateKey = (await importJWK(
    JSON.parse(parsed.data.privateJwk),
    "EdDSA",
  )) as CryptoKey;
  const gatewayKey = (await importJWK(
    JSON.parse(parsed.data.gatewayJwk),
    "EdDSA",
  )) as CryptoKey;
  // A renewed assignment is a new notification, not a change to the run or
  // to an existing signed request. Retries of one assignment retain its key.
  const assignmentScope = new AsyncLocalStorage<string>();
  const agent = new Agent2Human(
    new CeremonyDatabase(":memory:", randomBytes(32)),
    {
      gatewayOrigin: parsed.data.gatewayOrigin,
      agentId: parsed.data.agentId,
      keyId: parsed.data.keyId,
      privateKey,
      gatewayKey,
      apiKey: parsed.data.apiKey,
      records: postgresA2HRecords(store, tenant, () =>
        assignmentScope.getStore(),
      ),
      ...(fetcher ? { fetch: fetcher } : {}),
      recipient: (owner) => {
        const recipient = recipients[owner];
        if (!recipient) throw new Error("No host-configured A2H recipient");
        return recipient;
      },
    },
  );
  return async (input: {
    owner: string;
    run: RunRecord;
    assignmentId: string;
    tenantId: string;
  }) => {
    if (input.tenantId !== tenant) throw new Error("A2H tenant mismatch");
    const url = `${origin}/api/v1/teaching/jira/owner-setup/${input.assignmentId}`;
    await assignmentScope.run(input.assignmentId, () =>
      agent.authorize(input.owner, input.run.id, url, {
        connectorId: "jira",
        connectorName: "Jira",
        purpose: "app-registration",
        effect: {
          tenantId: input.tenantId,
          subjectId: input.owner,
          runId: input.run.id,
          operationId: "jira.prepare-app",
          operationVersion: "1.0.0",
          target: input.run.target,
          configurationVersion: input.run.configurationVersion,
          scopes: [...scopes],
          argumentsDigest: createHash("sha256")
            .update(JSON.stringify(["jira.prepare-app", input.assignmentId]))
            .digest("hex"),
        },
      }),
    );
  };
}

import { createHmac, randomBytes } from "node:crypto";
import { SQLiteCeremonyStore } from "../../../src/server/persistence/index.js";
import type { AsyncCeremonyStore } from "../../../src/server/persistence/index.js";
import { memoryPorts } from "../doubles/ports.js";
import { buildBinding } from "../fixtures/builders.js";
import {
  SubscriptionRegistry,
  registrySecretResolver,
  standardWebhookSignedContent,
  type ApproveSubscriptionInput,
  type EventSubscription,
} from "../../../src/server/connectors/events/index.js";
import type { ActorContext } from "../../../src/core/operation-contracts.js";
import type { RuntimeBinding } from "../../../src/server/connectors/binding.js";

/*
 * Shared scaffolding for the event tests. Everything here builds real records
 * through the real registry and the real encrypted store; nothing stubs a
 * verifier, an inbox or a subscription.
 */

export const ring = () => ({
  current: "test",
  keys: { test: new Uint8Array(randomBytes(32)) },
});

export function memoryStore(): SQLiteCeremonyStore {
  return new SQLiteCeremonyStore(":memory:", ring());
}

export const actorFor = (
  tenantId: string,
  subjectId = "subject-1",
): ActorContext => ({
  tenantId,
  subjectId,
  sessionId: "session-1",
  actorKind: "human",
  capabilities: ["executor"],
});

/** A binding whose approved destination is the loopback receiver origin. */
export function receiverBinding(
  tenantId: string,
  overrides: Partial<RuntimeBinding> = {},
): RuntimeBinding {
  return buildBinding({
    tenantId,
    bindingRef: "binding:events",
    destinations: [
      {
        id: "receiver",
        origin: "https://app.example",
        network: "public",
      },
      {
        id: "other-receiver",
        origin: "https://other.app.example",
        network: "public",
      },
    ],
    operations: [],
    configuration: [],
    ...overrides,
  });
}

export const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
export const ROTATED = "whsec_c2Vjb25kLXNlY3JldC1mb3Itcm90YXRpb24hIQ==";

/** Signs a body exactly as a Standard Webhooks sender would. */
export function signStandardWebhook(input: {
  id: string;
  timestampSeconds: number;
  body: string | Uint8Array;
  secret?: string;
}): Headers {
  const body =
    typeof input.body === "string"
      ? new Uint8Array(Buffer.from(input.body, "utf8"))
      : input.body;
  const key = Buffer.from((input.secret ?? SECRET).replace(/^whsec_/, ""), "base64");
  const signature = createHmac("sha256", key)
    .update(
      standardWebhookSignedContent(input.id, String(input.timestampSeconds), body),
    )
    .digest("base64");
  return new Headers({
    "webhook-id": input.id,
    "webhook-timestamp": String(input.timestampSeconds),
    "webhook-signature": `v1,${signature}`,
    "content-type": "application/json",
  });
}

export type Scaffold = {
  store: AsyncCeremonyStore;
  ports: ReturnType<typeof memoryPorts>;
  registry: SubscriptionRegistry;
  actor: ActorContext;
  binding: RuntimeBinding;
  subscription: EventSubscription;
  secretRef: string;
  resolveSecrets: ReturnType<typeof registrySecretResolver>;
};

/** An approved, active subscription with its signing secret held in credential custody. */
export async function scaffold(options: {
  store?: AsyncCeremonyStore;
  tenantId?: string;
  subjectId?: string;
  authority?: string;
  eventTypes?: string[];
  generation?: number;
  material?: Record<string, string>;
  verification?: ApproveSubscriptionInput["verification"];
  activate?: boolean;
} = {}): Promise<Scaffold> {
  const tenantId = options.tenantId ?? "tenant-a";
  const store = options.store ?? memoryStore();
  const ports = memoryPorts();
  const registry = new SubscriptionRegistry(store);
  const actor = actorFor(tenantId, options.subjectId);
  const binding = receiverBinding(tenantId);
  const secretRef = await ports.credentials.store(
    {
      tenantId,
      ownerKind: "user",
      ownerId: actor.subjectId,
      connectionRef: "connection:1",
      bindingRef: binding.bindingRef,
      custody: "host-owned",
    },
    options.material ?? { primary: SECRET },
  );
  let subscription = await registry.approve(actor, {
    connectionRef: "connection:1",
    binding,
    destinationId: "receiver",
    eventTypes: options.eventTypes ?? ["invoice.paid", "connection.revoked"],
    secretRef,
    verification: options.verification ?? { method: "standard-webhooks" },
    authority: options.authority ?? "acme-billing",
    generation: options.generation ?? 1,
    policyRevision: "policy:1",
  });
  if (options.activate !== false)
    subscription = await registry.activate(actor, subscription.subscriptionId);
  return {
    store,
    ports,
    registry,
    actor,
    binding,
    subscription,
    secretRef,
    resolveSecrets: registrySecretResolver({
      registry,
      credentials: ports.credentials,
    }),
  };
}

export function webhookRequest(input: {
  subscription: Pick<EventSubscription, "authority" | "subscriptionId">;
  body: string;
  headers: Headers;
  mountPath?: string;
  origin?: string;
  method?: string;
}): Request {
  const mount = input.mountPath ?? "/api/v1/connectors/events";
  const origin = input.origin ?? "https://app.example";
  return new Request(
    `${origin}${mount}/${input.subscription.authority}/${input.subscription.subscriptionId}`,
    {
      method: input.method ?? "POST",
      headers: input.headers,
      body: input.method === "GET" ? null : input.body,
    },
  );
}

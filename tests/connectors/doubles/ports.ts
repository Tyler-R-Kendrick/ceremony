import { randomBytes, randomUUID } from "node:crypto";
import type { ActorContext } from "../../../src/core/operation-contracts.js";
import type { ConnectorHandoffSummary } from "../../../src/core/connectors/index.js";
import type {
  ConnectionRecord,
  EffectIntent,
  EffectOutcome,
  HandoffIssue,
  HandoffRecord,
  VerificationClaim,
} from "../../../src/server/connectors/index.js";
import type {
  ConfigurationPort,
  ConnectionStorePort,
  CredentialCustodyPort,
  CredentialMaterial,
  CredentialScope,
  EffectJournalPort,
  EvidenceStorePort,
  HandoffPort,
  RandomPort,
} from "../../../src/server/connectors/ports.js";
import type { AdapterEnvironment } from "../../../src/server/connectors/adapter.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";

/*
 * In-memory implementations of the connector ports, for adapter tests only.
 * They keep the same ownership and one-use rules as the real state layer so a
 * test cannot pass here and fail there for a reason the double hid. They are
 * never used by the product; the state swarm supplies the persistent ports.
 */

export type MemoryPorts = ReturnType<typeof memoryPorts>;

export function memoryPorts(options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  const credentials = new Map<
    string,
    {
      scope: CredentialScope;
      material: CredentialMaterial;
      expiresAt?: number;
      generation: number;
    }
  >();
  const refreshing = new Map<
    string,
    Promise<{ ref: string; expiresAt?: number }>
  >();
  const sameScope = (a: CredentialScope, b: CredentialScope) =>
    a.tenantId === b.tenantId &&
    a.ownerKind === b.ownerKind &&
    a.ownerId === b.ownerId &&
    a.connectionRef === b.connectionRef &&
    a.bindingRef === b.bindingRef &&
    a.custody === b.custody;
  const custody: CredentialCustodyPort = {
    async store(scope, material, opts = {}) {
      const ref = opts.replaces ?? `cred:${randomUUID()}`;
      const prior = credentials.get(ref);
      if (prior && !sameScope(prior.scope, scope))
        throw new Error("scope mismatch");
      credentials.set(ref, {
        scope,
        material: Object.freeze({ ...material }),
        ...(opts.expiresAt === undefined ? {} : { expiresAt: opts.expiresAt }),
        generation: (prior?.generation ?? 0) + 1,
      });
      return ref;
    },
    async use(scope, ref, work) {
      const entry = credentials.get(ref);
      if (!entry || !sameScope(entry.scope, scope))
        throw new Error("unknown credential");
      // The same refusal the state layer's custody port raises, so an adapter
      // that renews on expiry is exercised against the code it will really see.
      if (entry.expiresAt !== undefined && entry.expiresAt <= now())
        throw new ConnectorError("expired", { detail: "credential.expired" });
      return work(entry.material);
    },
    async refresh(scope, ref, work) {
      const inflight = refreshing.get(ref);
      if (inflight) return inflight;
      const run = (async () => {
        const entry = credentials.get(ref);
        if (!entry || !sameScope(entry.scope, scope))
          throw new Error("unknown credential");
        const generation = entry.generation;
        const next = await work(entry.material);
        const current = credentials.get(ref);
        if (!current || current.generation !== generation)
          throw new Error("stale refresh discarded");
        credentials.set(ref, {
          scope,
          material: Object.freeze({ ...next.material }),
          ...(next.expiresAt === undefined
            ? {}
            : { expiresAt: next.expiresAt }),
          generation: generation + 1,
        });
        return {
          ref,
          ...(next.expiresAt === undefined
            ? {}
            : { expiresAt: next.expiresAt }),
        };
      })();
      refreshing.set(ref, run);
      try {
        return await run;
      } finally {
        refreshing.delete(ref);
      }
    },
    async revoke(scope, ref) {
      const entry = credentials.get(ref);
      if (entry && sameScope(entry.scope, scope)) credentials.delete(ref);
    },
    async describe(scope, ref) {
      const entry = credentials.get(ref);
      if (!entry || !sameScope(entry.scope, scope)) return undefined;
      return {
        custody: entry.scope.custody,
        ...(entry.expiresAt === undefined
          ? {}
          : { expiresAt: entry.expiresAt }),
      };
    },
  };

  const handoffRecords = new Map<string, HandoffRecord>();
  const handoffs: HandoffPort = {
    async issue(input: HandoffIssue) {
      const handoffRef = `handoff:${randomUUID()}`;
      const { actor, ...rest } = input;
      const record: HandoffRecord = {
        ...rest,
        handoffRef,
        tenantId: actor.tenantId,
        subjectId: actor.subjectId,
        sessionId: actor.sessionId,
        state: "issued",
        issuedAt: now(),
      };
      handoffRecords.set(handoffRef, record);
      const summary: ConnectorHandoffSummary = {
        handoffRef,
        kind: record.kind,
        state: record.state,
        presentation: record.presentation,
        expiresAt: new Date(record.expiresAt).toISOString(),
        generation: record.generation,
      };
      return { handoffRef, summary };
    },
    async present(actor, handoffRef) {
      const record = handoffRecords.get(handoffRef);
      if (
        !record ||
        record.tenantId !== actor.tenantId ||
        record.subjectId !== actor.subjectId ||
        record.sessionId !== actor.sessionId ||
        actor.actorKind !== "human"
      )
        return undefined;
      if (record.expiresAt <= now() && record.state === "issued")
        record.state = "expired";
      return record;
    },
    async resolveCorrelation(tenantId, correlationKey) {
      for (const record of handoffRecords.values())
        if (
          record.tenantId === tenantId &&
          record.correlationKey === correlationKey
        )
          return record;
      return undefined;
    },
    async complete(handoffRef, expectedGeneration, state) {
      const record = handoffRecords.get(handoffRef);
      if (!record) throw new Error("unknown handoff");
      if (record.generation !== expectedGeneration)
        throw new Error("stale handoff generation");
      if (record.state !== "issued" && record.state !== "waiting")
        throw new Error("handoff already completed");
      record.state = state;
      return record;
    },
    async cancelAll(connectionRef, _reason) {
      let count = 0;
      for (const record of handoffRecords.values())
        if (
          record.connectionRef === connectionRef &&
          (record.state === "issued" || record.state === "waiting")
        ) {
          record.state = "cancelled";
          count++;
        }
      return count;
    },
  };

  const effectRecords = new Map<
    string,
    { intent: EffectIntent; outcome?: EffectOutcome }
  >();
  const effects: EffectJournalPort = {
    async begin(intent) {
      for (const [effectRef, entry] of effectRecords)
        if (
          entry.intent.actor.tenantId === intent.actor.tenantId &&
          entry.intent.operation === intent.operation &&
          entry.intent.digest === intent.digest
        )
          return {
            effectRef,
            ...(entry.outcome
              ? { prior: entry.outcome }
              : { prior: { status: "indeterminate" as const, at: now() } }),
          };
      const effectRef = `effect:${randomUUID()}`;
      effectRecords.set(effectRef, { intent });
      return { effectRef };
    },
    async complete(effectRef, outcome) {
      const entry = effectRecords.get(effectRef);
      if (!entry) throw new Error("unknown effect");
      entry.outcome = outcome;
    },
    async get(actor, effectRef) {
      const entry = effectRecords.get(effectRef);
      if (!entry || entry.intent.actor.tenantId !== actor.tenantId)
        return undefined;
      return entry.outcome;
    },
  };

  const connections = new Map<
    string,
    { record: ConnectionRecord; revision: number }
  >();
  const owned = (actor: ActorContext, record: ConnectionRecord) =>
    record.tenantId === actor.tenantId &&
    record.ownerId === actor.subjectId &&
    (record.sessionId === undefined || record.sessionId === actor.sessionId);
  const connectionStore: ConnectionStorePort = {
    async create(record) {
      if (connections.has(record.connectionRef))
        throw new Error("duplicate connection");
      connections.set(record.connectionRef, {
        record: structuredClone(record),
        revision: 1,
      });
      return { revision: 1 };
    },
    async get(actor, connectionRef) {
      const entry = connections.get(connectionRef);
      if (!entry || !owned(actor, entry.record)) return undefined;
      return {
        record: structuredClone(entry.record),
        revision: entry.revision,
      };
    },
    async update(actor, connectionRef, expectedRevision, patch) {
      const entry = connections.get(connectionRef);
      if (!entry || !owned(actor, entry.record)) throw new Error("denied");
      if (entry.revision !== expectedRevision) throw new Error("conflict");
      entry.record = {
        ...entry.record,
        ...structuredClone(patch),
        updatedAt: new Date(now()).toISOString(),
      } as ConnectionRecord;
      entry.revision++;
      return { revision: entry.revision };
    },
    async list(actor, filter = {}) {
      return [...connections.values()]
        .filter(
          (entry) =>
            owned(actor, entry.record) &&
            (!filter.ecosystem ||
              entry.record.ecosystem === filter.ecosystem) &&
            (!filter.bindingRef ||
              entry.record.bindingRef === filter.bindingRef) &&
            (!filter.lifecycle || entry.record.lifecycle === filter.lifecycle),
        )
        .map((entry) => ({
          record: structuredClone(entry.record),
          revision: entry.revision,
        }));
    },
    async advanceGeneration(actor, connectionRef, expectedRevision) {
      const entry = connections.get(connectionRef);
      if (!entry || !owned(actor, entry.record)) throw new Error("denied");
      if (entry.revision !== expectedRevision) throw new Error("conflict");
      entry.record = {
        ...entry.record,
        generation: entry.record.generation + 1,
      };
      entry.revision++;
      return { generation: entry.record.generation, revision: entry.revision };
    },
    async findByExternalId(tenantId, authorityInstance, name, value) {
      for (const entry of connections.values())
        if (
          entry.record.tenantId === tenantId &&
          entry.record.authorityInstance === authorityInstance &&
          entry.record.externalIds[name] === value
        )
          return {
            record: structuredClone(entry.record),
            revision: entry.revision,
          };
      return undefined;
    },
  };

  const claims = new Map<
    string,
    Array<VerificationClaim & { stale?: string }>
  >();
  const evidence: EvidenceStorePort = {
    async append(actor, connectionRef, claim) {
      const entry = connections.get(connectionRef);
      if (!entry || !owned(actor, entry.record)) throw new Error("denied");
      const list = claims.get(connectionRef) ?? [];
      list.push(structuredClone(claim));
      claims.set(connectionRef, list);
      return claim.evidenceRef;
    },
    async list(actor, connectionRef) {
      const entry = connections.get(connectionRef);
      if (!entry || !owned(actor, entry.record)) return [];
      return (claims.get(connectionRef) ?? [])
        .filter((claim) => !claim.stale)
        .map((claim) => structuredClone(claim));
    },
    async invalidate(actor, connectionRef, reason) {
      const entry = connections.get(connectionRef);
      if (!entry || !owned(actor, entry.record)) return 0;
      const list = claims.get(connectionRef) ?? [];
      let count = 0;
      for (const claim of list)
        if (!claim.stale) {
          claim.stale = reason;
          count++;
        }
      return count;
    },
  };

  const values = new Map<string, string>();
  let configurationRevision = 1;
  const configuration: ConfigurationPort & {
    set(name: string, value: string | undefined): void;
  } = {
    set(name, value) {
      if (value === undefined) values.delete(name);
      else values.set(name, value);
      configurationRevision++;
    },
    async read(name) {
      return values.get(name);
    },
    async present(names) {
      return new Set(names.filter((name) => values.has(name)));
    },
    async revision() {
      return `cfg:${configurationRevision}`;
    },
  };

  const random: RandomPort = {
    bytes: (length) => new Uint8Array(randomBytes(length)),
    uuid: () => randomUUID(),
  };

  return {
    credentials: custody,
    handoffs,
    effects,
    connections: connectionStore,
    evidence,
    configuration,
    random,
    now,
    /** Peek for assertions only; the product never reads material this way. */
    inspect: {
      credentialRefs: () => [...credentials.keys()],
      credentialMaterial: (ref: string) => credentials.get(ref)?.material,
      handoffs: () => [...handoffRecords.values()],
      effects: () =>
        [...effectRecords.entries()].map(([effectRef, entry]) => ({
          effectRef,
          ...entry,
        })),
      connections: () => [...connections.values()],
    },
    environment(options: {
      fetch: typeof fetch;
      origin?: string;
    }): AdapterEnvironment {
      return {
        fetch: options.fetch,
        now,
        random,
        credentials: custody,
        handoffs,
        effects,
        evidence,
        configuration,
        origin: options.origin ?? "https://app.example",
      };
    },
  };
}

export const fixtureActor: ActorContext = {
  tenantId: "tenant-a",
  subjectId: "subject-1",
  sessionId: "session-1",
  actorKind: "human",
  capabilities: ["executor", "author", "reviewer", "publisher", "admin"],
};

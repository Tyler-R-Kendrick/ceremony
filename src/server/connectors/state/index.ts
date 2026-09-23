import type { AsyncCeremonyStore } from "../../persistence/index.js";
import type { AdapterEnvironment } from "../adapter.js";
import type { Clock, ConfigurationPort, RandomPort } from "../ports.js";
import { systemRandom, type CacheInvalidationHook } from "./common.js";
import {
  createCredentialCustodyPort,
  type ConnectorCredentialCustody,
} from "./credentials.js";
import { createHandoffPort } from "./handoffs.js";
import {
  createEffectJournalPort,
  type ConnectorEffectJournal,
} from "./effects.js";
import {
  createConnectionStore,
  type ConnectionOwnership,
  type ConnectorConnectionStore,
} from "./connections.js";
import {
  createEvidenceStore,
  type ConnectorEvidenceStore,
} from "./evidence.js";
import {
  createSourceArtifactPort,
  type ConnectorSourceArtifacts,
} from "./artifacts.js";
import {
  createDefinitionStore,
  type ConnectorDefinitionStore,
} from "./definitions.js";
import { createAuthorityThrottle, type AuthorityThrottle } from "./throttle.js";
import { createDriftInvalidator, type DriftInvalidator } from "./drift.js";
import {
  createSupportSnapshotStore,
  type SupportSnapshotStore,
} from "./support.js";
import type { HandoffPort } from "../ports.js";
import type { ClientRegistrationStorePort } from "../auth/client.js";
import { createClientRegistrationStore } from "./registrations.js";

/*
 * The production state layer for connector interoperability: every port in
 * `../ports.ts` implemented over the shared encrypted AsyncCeremonyStore
 * (PostgreSQL in production, SQLite locally), plus the lifecycle, throttling
 * and drift services the command layer composes with them. Construct once per
 * process with `createConnectorPorts(store, options)`; the returned ports are
 * safe to share across requests and across workers on the same database.
 */

export type ConnectorPortsOptions = {
  /** Injected clock for tests that simulate expiry; production uses database time. */
  now?: Clock;
  /** Worker identity prefix for leases; defaults to a random per-process value. */
  worker?: string;
  /** Lease held during one refresh or one effect; heartbeat effects that run longer. */
  leaseMs?: number;
  /** A credential expiring within this margin is refreshed rather than used. */
  expirySafetyMarginMs?: number;
  /** External identifier names shared by several connections (installations, projects). */
  sharedExternalIdNames?: readonly string[];
  /** Host ownership policy for organization and workload owners. */
  owns?: ConnectionOwnership;
  cacheInvalidation?: CacheInvalidationHook;
  maxArtifactBytes?: number;
  throttle?: { limit?: number; windowMs?: number };
  random?: RandomPort;
};

export type ConnectorPorts = {
  credentials: ConnectorCredentialCustody;
  handoffs: HandoffPort;
  effects: ConnectorEffectJournal;
  connections: ConnectorConnectionStore;
  evidence: ConnectorEvidenceStore;
  artifacts: ConnectorSourceArtifacts;
  definitions: ConnectorDefinitionStore;
  throttle: AuthorityThrottle;
  drift: DriftInvalidator;
  support: SupportSnapshotStore;
  /** Where the OAuth grants persist RFC 7591 dynamic client registrations. */
  registrations: ClientRegistrationStorePort;
  random: RandomPort;
  now: Clock;
  /** Composes the adapter environment for one call; configuration is bound per actor by the caller. */
  environment(input: {
    fetch: typeof fetch;
    origin: string;
    configuration: ConfigurationPort;
  }): AdapterEnvironment;
};

export function createConnectorPorts(
  store: AsyncCeremonyStore,
  options: ConnectorPortsOptions = {},
): ConnectorPorts {
  const shared = {
    ...(options.now ? { now: options.now } : {}),
    ...(options.owns ? { owns: options.owns } : {}),
    ...(options.cacheInvalidation
      ? { cacheInvalidation: options.cacheInvalidation }
      : {}),
  };
  const lease =
    options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs };
  const credentials = createCredentialCustodyPort(store, {
    ...(options.now ? { now: options.now } : {}),
    ...(options.worker ? { worker: options.worker } : {}),
    ...lease,
    ...(options.expirySafetyMarginMs === undefined
      ? {}
      : { expirySafetyMarginMs: options.expirySafetyMarginMs }),
  });
  const handoffs = createHandoffPort(store, {
    ...(options.now ? { now: options.now } : {}),
  });
  const effects = createEffectJournalPort(store, {
    ...(options.now ? { now: options.now } : {}),
    ...(options.worker ? { worker: options.worker } : {}),
    ...lease,
  });
  const connections = createConnectionStore(store, {
    ...shared,
    ...(options.sharedExternalIdNames
      ? { sharedExternalIdNames: options.sharedExternalIdNames }
      : {}),
  });
  const evidence = createEvidenceStore(store, {
    ...(options.now ? { now: options.now } : {}),
    ...(options.owns ? { owns: options.owns } : {}),
  });
  const artifacts = createSourceArtifactPort(store, {
    ...(options.now ? { now: options.now } : {}),
    ...(options.maxArtifactBytes === undefined
      ? {}
      : { maxBytes: options.maxArtifactBytes }),
  });
  const definitions = createDefinitionStore(store);
  const throttle = createAuthorityThrottle(store, {
    ...(options.now ? { now: options.now } : {}),
    ...(options.throttle?.limit === undefined
      ? {}
      : { limit: options.throttle.limit }),
    ...(options.throttle?.windowMs === undefined
      ? {}
      : { windowMs: options.throttle.windowMs }),
  });
  const drift = createDriftInvalidator(store, shared);
  const support = createSupportSnapshotStore(store);
  const registrations = createClientRegistrationStore(store);
  const random = options.random ?? systemRandom;
  const now = options.now ?? Date.now;
  return {
    credentials,
    handoffs,
    effects,
    connections,
    evidence,
    artifacts,
    definitions,
    throttle,
    drift,
    support,
    registrations,
    random,
    now,
    environment(input) {
      return {
        fetch: input.fetch,
        now,
        random,
        credentials,
        handoffs,
        effects,
        evidence,
        configuration: input.configuration,
        origin: input.origin,
      };
    },
  };
}

export {
  INDEX_TENANT,
  type CacheInvalidationEvent,
  type CacheInvalidationHook,
} from "./common.js";
export {
  assertNoMaterial,
  createCredentialCustodyPort,
  type ConnectorCredentialCustody,
  type CredentialCustodyOptions,
} from "./credentials.js";
export { createHandoffPort, type HandoffOptions } from "./handoffs.js";
export {
  createEffectJournalPort,
  type ConnectorEffectJournal,
  type EffectJournalOptions,
  type UnresolvedEffect,
} from "./effects.js";
export {
  connectionKeyDigest,
  createConnectionStore,
  defaultOwnership,
  explainDisconnect,
  keyDigestOf,
  type ConnectionEntry,
  type ConnectionKeyParts,
  type ConnectionOwnership,
  type ConnectionStoreOptions,
  type ConnectorConnectionStore,
  type DisconnectInput,
  type StoredConnectionRecord,
} from "./connections.js";
export {
  createEvidenceStore,
  type ConnectorEvidenceStore,
  type EvidenceEntry,
  type EvidenceStoreOptions,
} from "./evidence.js";
export {
  createSourceArtifactPort,
  type ConnectorSourceArtifacts,
  type SourceArtifactOptions,
} from "./artifacts.js";
export {
  createDefinitionStore,
  type ConnectorDefinitionStore,
} from "./definitions.js";
export {
  createAuthorityThrottle,
  type AuthorityBudget,
  type AuthorityThrottle,
  type AuthorityThrottleOptions,
} from "./throttle.js";
export {
  createDriftInvalidator,
  isVerificationCurrent,
  type DriftInvalidator,
  type DriftOptions,
  type DriftOutcome,
  type DriftSignal,
} from "./drift.js";
export {
  createHostConfigurationPort,
  createSessionConfigurationPort,
} from "./configuration.js";
export {
  createSupportSnapshotStore,
  type SupportSnapshotStore,
} from "./support.js";
export { createClientRegistrationStore } from "./registrations.js";
export { type DisconnectRecord, type SupportSnapshot } from "./schemas.js";

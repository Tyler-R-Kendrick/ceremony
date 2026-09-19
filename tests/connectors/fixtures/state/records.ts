import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActorContext } from "../../../../src/core/operation-contracts.js";
import {
  completeDimensions,
  type NormalizedDefinition,
  type SourceRecord,
  type VerificationClaim,
} from "../../../../src/core/connectors/index.js";
import type { RuntimeBinding } from "../../../../src/server/connectors/binding.js";
import type { ConnectionRecord } from "../../../../src/server/connectors/ports.js";
import {
  SQLiteCeremonyStore,
  type AsyncCeremonyStore,
  type Keyring,
} from "../../../../src/server/persistence/index.js";

/*
 * Builders for the connector state tests. They produce records that satisfy
 * the real core schemas, so a test that passes here exercised the same
 * validation the product runs on every read.
 */

export const stateKeyring = (): Keyring => ({
  current: "state",
  keys: { state: randomBytes(32) },
});

export const actorFor = (
  tenantId: string,
  subjectId = "subject-1",
  extra: Partial<ActorContext> = {},
): ActorContext => ({
  tenantId,
  subjectId,
  sessionId: "session-1",
  actorKind: "human",
  capabilities: ["executor", "author"],
  ...extra,
});

export const iso = (ms: number) => new Date(ms).toISOString();

export function connectionRecord(
  input: Partial<ConnectionRecord> & { tenantId: string; ownerId?: string },
): ConnectionRecord {
  const at = iso(1_700_000_000_000);
  return {
    connectionRef: `connection:${randomUUID()}`,
    bindingRef: "binding:fixture",
    definitionRef: "definition:fixture",
    ecosystem: "nango",
    service: "fixture-service",
    displayName: "Fixture connection",
    ownerKind: "user",
    custody: "host-owned",
    runtime: "hosted-server",
    lifecycle: "active",
    generation: 0,
    revision: 0,
    createdAt: at,
    updatedAt: at,
    ownerId: input.ownerId ?? "subject-1",
    sessionId: undefined,
    authorityInstance: "https://api.fixture.example",
    bindingRevision: 1,
    policyRevision: "policy-1",
    configurationRevision: "cfg-1",
    externalIds: {},
    evidenceRefs: [],
    state: {},
    ...input,
  } as ConnectionRecord;
}

export function claim(
  input: Partial<VerificationClaim> = {},
): VerificationClaim {
  return {
    kind: "account-identity",
    evidenceRef: `evidence:${randomUUID()}`,
    issuer: "provider",
    target: { kind: "account", id: "acct_fixture" },
    observedAt: iso(1_700_000_000_000),
    verifierVersion: "1",
    bindingRevision: 1,
    policyRevision: "policy-1",
    limitations: [],
    ...input,
  } as VerificationClaim;
}

export function sourceRecord(input: Partial<SourceRecord> = {}): SourceRecord {
  return {
    sourceRef: `source:${randomUUID()}`,
    identity: {
      ecosystem: "openapi",
      authorityNamespace: "",
      nativeId: "acme/Orders API",
      nativeVersion: "2026-01-01",
    },
    format: { name: "openapi", version: "3.1.0" },
    origin: { kind: "upload" },
    digest: { algorithm: "sha256", value: "a".repeat(64) },
    byteLength: 12,
    mediaType: "application/json",
    capturedAt: iso(1_700_000_000_000),
    adaptation: [],
    overlays: [],
    ...input,
  } as SourceRecord;
}

export function definitionRecord(
  input: Partial<NormalizedDefinition> = {},
): NormalizedDefinition {
  return {
    schemaVersion: 1,
    definitionRef: `definition:${randomUUID()}`,
    identity: {
      ecosystem: "openapi",
      authorityNamespace: "",
      nativeId: "acme/Orders API",
      nativeVersion: "2026-01-01",
    },
    sourceRef: "source:fixture",
    normalizedDigest: "b".repeat(64),
    importer: { id: "fixture-importer", version: "1" },
    display: {
      name: "Orders API",
      description: "Fixture description",
      ecosystem: "openapi",
      service: "orders",
    },
    authentication: [
      { id: "public", label: "No credential", kind: "none", reason: "public" },
    ],
    configuration: [],
    capabilities: [],
    events: [],
    declaredServers: [],
    compatibility: {
      issues: [],
      dimensions: completeDimensions({ import: "exact" }),
    },
    nativeExtensions: {},
    ...input,
  } as NormalizedDefinition;
}

export function runtimeBinding(
  input: Partial<RuntimeBinding> & { tenantId: string },
): RuntimeBinding {
  return {
    bindingRef: "binding:fixture",
    definitionRef: "definition:fixture",
    revision: 1,
    adapterId: "fixture-adapter",
    adapterVersion: "1",
    runtime: "hosted-server",
    custody: "host-owned",
    authorityInstance: "https://api.fixture.example",
    status: "approved",
    approvedAt: iso(1_700_000_000_000),
    policyRevision: "policy-1",
    destinations: [
      {
        id: "api",
        origin: "https://api.fixture.example",
        network: "public",
      },
    ],
    operations: [
      {
        operationRef: "op:list",
        nativeId: "listOrders",
        destinationId: "api",
        transport: { kind: "http", method: "GET", pathTemplate: "/orders" },
        effect: "read",
        outputClassification: "personal",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
    ],
    configuration: [],
    permittedTargets: [{ kind: "account", id: "acct_fixture" }],
    reviewedDigest: "c".repeat(64),
    settings: {},
    ...input,
  } as RuntimeBinding;
}

export function credentialScope(
  tenantId: string,
  input: {
    ownerId?: string;
    connectionRef?: string;
    bindingRef?: string;
    custody?: ConnectionRecord["custody"];
    ownerKind?: ConnectionRecord["ownerKind"];
  } = {},
) {
  return {
    tenantId,
    ownerKind: input.ownerKind ?? ("user" as const),
    ownerId: input.ownerId ?? "subject-1",
    connectionRef: input.connectionRef ?? "connection:fixture",
    bindingRef: input.bindingRef ?? "binding:fixture",
    custody: input.custody ?? ("host-owned" as const),
  };
}

/** A file-backed SQLite store plus its directory, for reopen and encryption tests. */
export async function sqliteFixture(keyring = stateKeyring()) {
  const directory = await mkdtemp(join(tmpdir(), "ceremony-connector-state-"));
  const path = join(directory, "state.sqlite");
  let store = new SQLiteCeremonyStore(path, keyring);
  return {
    path,
    keyring,
    get store(): AsyncCeremonyStore {
      return store;
    },
    async reopen(withKeyring = keyring) {
      await store.close();
      store = new SQLiteCeremonyStore(path, withKeyring);
      return store;
    },
    async close() {
      await store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

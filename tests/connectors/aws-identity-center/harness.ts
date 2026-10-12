import { createHash, randomBytes } from "node:crypto";
import type { TestContext } from "node:test";
import type { ActorContext } from "../../../src/core/operation-contracts.js";
import type { AdapterCallContext } from "../../../src/server/connectors/adapter.js";
import { runtimeBindingSchema } from "../../../src/server/connectors/binding.js";
import { ConnectorAdapterRegistry } from "../../../src/server/connectors/index.js";
import {
  ConnectorCommandService,
  defaultConnectorPolicy,
} from "../../../src/server/connectors/commands/index.js";
import type {
  EffectIntent,
  EffectOutcome,
} from "../../../src/server/connectors/ports.js";
import {
  AWS_SETTINGS_KEY,
  awsIdentityCenterBoundOperations,
  createAwsIdentityCenterAdapter,
} from "../../../src/server/connectors/providers/aws-identity-center/index.js";
import { createConnectorPorts } from "../../../src/server/connectors/state/index.js";
import { SQLiteCeremonyStore } from "../../../src/server/persistence/index.js";
import {
  memoryArtifactStore,
  memoryDefinitionStore,
  ORIGIN,
  TENANT,
  agent,
  human,
} from "../commands/harness.js";
import {
  startAwsIdentityCenter,
  type AwsIdentityCenterOptions,
  type PersonSeed,
} from "../doubles/aws-identity-center.js";
import { buildDefinition, buildProfile } from "../fixtures/builders.js";

/*
 * The AWS IAM Identity Center ceremony, driven through the real connector
 * command service over the REAL state ports (encrypted SQLite custody,
 * handoffs, effect journal, connections, evidence) against the loopback
 * double. The only thing written by hand is the approved binding, because the
 * definition store is a port.
 */

export const REGION = "us-east-1";
export const START_URL = "https://acme.awsapps.com/start";
export const START_TIME = Date.parse("2026-10-12T09:00:00.000Z");

export const alice: PersonSeed = {
  id: "alice",
  accounts: [
    {
      accountId: "111122223333",
      accountName: "Production",
      emailAddress: "prod-aws@example.test",
      roles: ["ReadOnlyAccess", "AdministratorAccess"],
    },
    {
      accountId: "444455556666",
      accountName: "Sandbox",
      emailAddress: "sandbox-aws@example.test",
      roles: ["PowerUserAccess"],
    },
    {
      accountId: "777788889999",
      accountName: "Not on the binding",
      roles: ["ReadOnlyAccess"],
    },
  ],
};

/**
 * The delegation record that makes an agent actor live, expiring on the
 * harness clock rather than the database's: these tests move a clock of their
 * own.
 */
async function delegateUntil(
  store: SQLiteCeremonyStore,
  actor: ActorContext,
  expiresAt: number,
): Promise<void> {
  const runId = actor.delegationId!;
  await store.transaction(async (tx) => {
    await tx.put(
      { tenant: "workload", kind: "session" as const, id: runId },
      {
        actor: { ...actor, actorKind: "human" },
        runId,
        expiresAt,
        revoked: false,
      },
      null,
    );
    await tx.put(
      { tenant: actor.tenantId, kind: "budget" as const, id: `agent:${runId}` },
      { stopped: false },
      null,
    );
  });
}

export type AwsSetupOptions = {
  people?: PersonSeed[];
  double?: AwsIdentityCenterOptions;
  /** Accounts the binding permits; defaults to the first two of Alice's. */
  accounts?: string[];
  /** Role targets (`account:role`) the binding restricts to. */
  roles?: string[];
  settings?: Record<string, unknown>;
  destinations?: { oidc?: string; portal?: string };
  /** The custody port refuses a record this close to its expiry; the default is its own. */
  expirySafetyMarginMs?: number;
};

export async function awsSetup(t: TestContext, options: AwsSetupOptions = {}) {
  let clock = START_TIME;
  const now = () => clock;
  const advance = (ms: number) => {
    clock += ms;
  };
  const fixture = await startAwsIdentityCenter({
    region: REGION,
    startUrl: START_URL,
    people: options.people ?? [structuredClone(alice)],
    now,
    ...options.double,
  });
  t.after(() => fixture.close());

  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  t.after(() => store.close());
  const ports = createConnectorPorts(store, {
    now,
    ...(options.expirySafetyMarginMs === undefined
      ? {}
      : { expirySafetyMarginMs: options.expirySafetyMarginMs }),
  });
  // Every effect the adapter journals passes through here, so a test can sweep
  // the journal for a secret and read which operations were attempted.
  const journal: Array<EffectIntent | EffectOutcome> = [];
  const effects = {
    ...ports.effects,
    begin: async (intent: EffectIntent) => {
      journal.push(intent);
      return ports.effects.begin(intent);
    },
    complete: async (effectRef: string, outcome: EffectOutcome) => {
      journal.push(outcome);
      return ports.effects.complete(effectRef, outcome);
    },
  };
  // Every custody record the adapter writes, so a test can prove none outlives its attempt.
  const stored: string[] = [];
  const credentials = {
    ...ports.credentials,
    store: async (...args: Parameters<typeof ports.credentials.store>) => {
      const ref = await ports.credentials.store(...args);
      stored.push(ref);
      return ref;
    },
  };
  const registry = new ConnectorAdapterRegistry();
  registry.register(createAwsIdentityCenterAdapter());
  const definitions = memoryDefinitionStore();
  const service = new ConnectorCommandService({
    registry,
    ports: {
      connections: ports.connections,
      evidence: ports.evidence,
      effects,
      handoffs: ports.handoffs,
      credentials,
      definitions,
      artifacts: memoryArtifactStore(),
    },
    configuration: () => ({
      read: async () => undefined,
      present: async () => new Set<string>(),
      revision: async () => "cfg:1",
    }),
    policy: defaultConnectorPolicy({ store, loopbackFixtures: true, now }),
    fetch: (input, init) => fetch(input as RequestInfo, init),
    origin: ORIGIN,
    importers: [],
    now,
  });

  const definition = buildDefinition({
    definitionRef: "definition:aws-identity-center",
    sourceRef: "source:aws-identity-center",
    display: {
      name: "AWS IAM Identity Center",
      description: "Signs a person in to their AWS accounts.",
      ecosystem: "aws-identity-center",
      service: "aws",
    },
    authentication: [buildProfile("oauth-device")],
    configuration: [],
    capabilities: [],
  });
  const accounts = options.accounts ?? ["111122223333", "444455556666"];
  const binding = runtimeBindingSchema.parse({
    bindingRef: "binding:aws-identity-center-1",
    definitionRef: definition.definitionRef,
    revision: 1,
    adapterId: "aws-identity-center",
    adapterVersion: "1.0.0",
    runtime: "hosted-server",
    custody: "host-owned",
    authorityInstance: `aws-identity-center:${REGION}:acme`,
    status: "approved",
    approvedAt: "2026-10-01T00:00:00.000Z",
    policyRevision: "policy:1",
    tenantId: TENANT,
    profileId: "oauth-device",
    destinations: [
      {
        id: "oidc",
        origin: options.destinations?.oidc ?? fixture.oidcOrigin,
        network: "loopback-fixture",
      },
      {
        id: "portal",
        origin: options.destinations?.portal ?? fixture.portalOrigin,
        network: "loopback-fixture",
      },
    ],
    operations: awsIdentityCenterBoundOperations(),
    configuration: [],
    permittedTargets: [
      ...accounts.map((id) => ({ kind: "aws-account", id })),
      ...(options.roles ?? []).map((id) => ({ kind: "aws-role", id })),
    ],
    reviewedDigest: createHash("sha256").update("aws-review").digest("hex"),
    agentOutputConsent: "personal",
    settings: {
      [AWS_SETTINGS_KEY]: {
        region: REGION,
        startUrl: START_URL,
        requestTimeoutMs: 120_000,
        ...options.settings,
      },
    },
  });
  await definitions.putDefinition(TENANT, definition);
  await definitions.putBinding(binding);
  const person: ActorContext = human({
    capabilities: ["executor", "author", "reviewer", "publisher", "admin"],
  });
  const delegate_ = agent();
  await delegateUntil(store, delegate_, START_TIME + 7 * 86_400_000);

  /** The record behind a connection, as the store holds it. */
  const record = async (connectionRef: string) => {
    const found = await ports.connections.get(person, connectionRef);
    if (!found) throw new Error("no such connection");
    return found.record;
  };
  /**
   * The custody record's material, read the way trusted code does. Tests use
   * it only as a positive control (the secret IS in custody) and to read the
   * expiry; production code never returns what it reads here.
   */
  const heldMaterial = async (connectionRef: string) => {
    const connection = await record(connectionRef);
    const scope = {
      tenantId: connection.tenantId,
      ownerKind: connection.ownerKind,
      ownerId: connection.ownerId,
      connectionRef: connection.connectionRef,
      bindingRef: connection.bindingRef,
      custody: connection.custody,
    };
    // Reading through a rotation writes the record back, so the expiry it
    // had is carried over: looking must not change what is looked at.
    const expiresAt = (
      await ports.credentials.describe(scope, connection.credentialRef!)
    )?.expiresAt;
    let held: Record<string, string> = {};
    await ports.credentials.refresh(
      scope,
      connection.credentialRef!,
      async (current) => {
        held = { ...current };
        return {
          material: current,
          ...(expiresAt === undefined ? {} : { expiresAt }),
        };
      },
    );
    return held;
  };
  /** A call context for trusted host code that uses a connection's credentials directly. */
  const adapterContext = async (
    connectionRef: string,
  ): Promise<AdapterCallContext> => {
    const connection = await record(connectionRef);
    return {
      actor: person,
      binding,
      connection,
      generation: connection.generation,
      signal: new AbortController().signal,
      environment: ports.environment({
        fetch: globalThis.fetch,
        origin: ORIGIN,
        configuration: {
          read: async () => undefined,
          present: async () => new Set<string>(),
          revision: async () => "cfg:1",
        },
      }),
    };
  };
  return {
    clock: now,
    advance,
    fixture,
    store,
    ports,
    service,
    definitions,
    binding,
    person,
    agent: delegate_,
    journal,
    stored,
    record,
    heldMaterial,
    adapterContext,
  };
}

export type AwsSetup = Awaited<ReturnType<typeof awsSetup>>;

/** The user code on a connect view, for the person to type on the double's page. */
export function userCodeOf(view: unknown): string {
  const code = (view as { presentation?: { userCode?: string } }).presentation
    ?.userCode;
  if (!code) throw new Error("the view shows no user code");
  return code;
}

export function handoffRefOf(view: unknown): string {
  const ref = (view as { handoff?: { handoffRef?: string } }).handoff
    ?.handoffRef;
  if (!ref) throw new Error("the view has no handoff");
  return ref;
}

export function connectionRefOf(view: unknown): string {
  return (view as { connectionRef: string }).connectionRef;
}

/** Connects, approves as the person would, and polls once past the interval. */
export async function connectAndApprove(
  setup: AwsSetup,
  intent: Record<string, unknown> = {},
) {
  const connected = await setup.service.connect(setup.person, {
    bindingRef: setup.binding.bindingRef,
    intent,
  });
  const connectionRef = connectionRefOf(connected);
  const userCode = userCodeOf(connected);
  if (!setup.fixture.approve(userCode)) throw new Error("code not approvable");
  setup.advance(6_000);
  const polled = await setup.service.poll(setup.person, connectionRef);
  return { connectionRef, userCode, connected, polled };
}

/** The whole way to an active connection on the first account and role. */
export async function connectAndChoose(
  setup: AwsSetup,
  choice: { accountId: string; roleName: string } = {
    accountId: "111122223333",
    roleName: "ReadOnlyAccess",
  },
) {
  const first = await connectAndApprove(setup);
  const done = await setup.service.provideInput(
    setup.person,
    first.connectionRef,
    handoffRefOf(first.polled),
    choice,
  );
  return { ...first, done };
}

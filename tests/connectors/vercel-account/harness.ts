import { createHash, randomBytes } from "node:crypto";
import type { TestContext } from "node:test";
import type { ActorContext } from "../../../src/core/operation-contracts.js";
import type { AdapterCallContext } from "../../../src/server/connectors/adapter.js";
import { issuerPolicy } from "../../../src/server/connectors/auth/index.js";
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
  createVercelAccountAdapter,
  VERCEL_ACCOUNT_ADAPTER_ID,
  VERCEL_ACCOUNT_SETTINGS_KEY,
  vercelAccountBoundOperations,
  vercelAccountConfigurationNames,
  vercelAccountIssuerPolicy,
} from "../../../src/server/connectors/providers/vercel-account/index.js";
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
  startVercelAccount,
  type PersonSeed,
  type VercelAccountOptions,
} from "../doubles/vercel-account.js";
import { buildDefinition, buildProfile } from "../fixtures/builders.js";

/*
 * The Vercel account sign-in, driven through the real connector command
 * service over the REAL state ports (encrypted SQLite custody, handoffs,
 * effect journal, connections, evidence) against the loopback double. The
 * only thing written by hand is the approved binding, because the definition
 * store is a port. The issuer policy is the one a host pins for the real
 * Vercel (`vercelAccountIssuerPolicy`) with its two origins swapped for the
 * double's.
 */

export const CLIENT_ID = "dummy-vercel-client";
export const START_TIME = Date.parse("2026-10-12T09:00:00.000Z");

export const alice: PersonSeed = {
  id: "user_dummy_alice",
  username: "alice",
  name: "Alice Example",
  email: "alice@example.test",
  teams: [
    {
      id: "team_dummy_acme",
      slug: "acme",
      name: "Acme",
      createdAt: START_TIME - 30 * 86_400_000,
    },
    {
      id: "team_dummy_labs",
      slug: "labs",
      name: "Labs",
      createdAt: START_TIME - 20 * 86_400_000,
    },
    {
      id: "team_dummy_other",
      slug: "elsewhere",
      name: "Not on the binding",
      createdAt: START_TIME - 10 * 86_400_000,
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

export type AccountSetupOptions = {
  people?: PersonSeed[];
  double?: VercelAccountOptions;
  /** Teams the binding permits; defaults to the first two of Alice's. */
  teams?: string[];
  settings?: Record<string, unknown>;
  /** Pins RFC 7009 revocation off (false) in the issuer policy; on is the policy default. */
  revoke?: boolean;
  /** The longest the service lets any adapter call run (its own default otherwise). */
  callTimeoutMs?: number;
  /** Overrides the destination's origin and network. */
  apiOrigin?: string;
  apiNetwork?: "public" | "loopback-fixture";
  /** Replaces the client id the host configured. */
  clientId?: string | null;
  /** The custody port refuses a record this close to its expiry; the default is its own. */
  expirySafetyMarginMs?: number;
};

export async function accountSetup(
  t: TestContext,
  options: AccountSetupOptions = {},
) {
  let clock = START_TIME;
  const now = () => clock;
  const advance = (ms: number) => {
    clock += ms;
  };
  const fixture = await startVercelAccount({
    people: options.people ?? [structuredClone(alice)],
    clientIds: [CLIENT_ID],
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
  const configured: Record<string, string> =
    options.clientId === null
      ? {}
      : {
          [vercelAccountConfigurationNames.clientId]:
            options.clientId ?? CLIENT_ID,
        };
  const configuration = () => ({
    read: async (name: string) => configured[name],
    present: async (names: readonly string[]) =>
      new Set(names.filter((name) => configured[name] !== undefined)),
    revision: async () => "cfg:1",
  });
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
  registry.register(createVercelAccountAdapter());
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
    configuration,
    policy: defaultConnectorPolicy({ store, loopbackFixtures: true, now }),
    fetch: (input, init) => fetch(input as RequestInfo, init),
    origin: ORIGIN,
    importers: [],
    now,
    ...(options.callTimeoutMs === undefined
      ? {}
      : { callTimeoutMs: options.callTimeoutMs }),
  });

  const definition = buildDefinition({
    definitionRef: "definition:vercel-account",
    sourceRef: "source:vercel-account",
    display: {
      name: "Vercel account",
      description: "Signs a person in to their Vercel account.",
      ecosystem: VERCEL_ACCOUNT_ADAPTER_ID,
      service: "vercel",
    },
    authentication: [buildProfile("oauth-device")],
    configuration: [],
    capabilities: [],
  });
  const teams = options.teams ?? ["team_dummy_acme", "team_dummy_labs"];
  // The policy a host pins for the real Vercel, with its two origins swapped
  // for the double's: the issuer's own, and the API's as a trusted origin.
  const policy = issuerPolicy({
    ...vercelAccountIssuerPolicy(
      options.revoke === undefined ? {} : { revoke: options.revoke },
    ),
    issuer: fixture.issuerOrigin,
    trustedOrigins: [fixture.apiOrigin],
    allowLoopbackHttp: true,
  });
  const binding = runtimeBindingSchema.parse({
    bindingRef: "binding:vercel-account-1",
    definitionRef: definition.definitionRef,
    revision: 1,
    adapterId: VERCEL_ACCOUNT_ADAPTER_ID,
    adapterVersion: "1.0.0",
    runtime: "hosted-server",
    custody: "host-owned",
    authorityInstance: "vercel-account:acme",
    status: "approved",
    approvedAt: "2026-10-01T00:00:00.000Z",
    policyRevision: "policy:1",
    tenantId: TENANT,
    profileId: "oauth-device",
    destinations: [
      {
        id: "api",
        origin: options.apiOrigin ?? fixture.apiOrigin,
        network: options.apiNetwork ?? "loopback-fixture",
      },
    ],
    operations: vercelAccountBoundOperations(),
    configuration: [vercelAccountConfigurationNames.clientId],
    permittedTargets: teams.map((id) => ({ kind: "vercel-team", id })),
    reviewedDigest: createHash("sha256").update("vercel-review").digest("hex"),
    agentOutputConsent: "personal",
    settings: {
      oauth: policy,
      [VERCEL_ACCOUNT_SETTINGS_KEY]: {
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
  const environment = () =>
    ports.environment({
      fetch: globalThis.fetch,
      origin: ORIGIN,
      configuration: configuration(),
    });
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
      environment: environment(),
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
    policy,
    person,
    agent: delegate_,
    journal,
    stored,
    record,
    heldMaterial,
    adapterContext,
    environment,
    configured,
  };
}

export type AccountSetup = Awaited<ReturnType<typeof accountSetup>>;

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
  setup: AccountSetup,
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

/** The whole way to an active connection on the first team. */
export async function connectAndChoose(setup: AccountSetup, team = "acme") {
  const first = await connectAndApprove(setup);
  const done = await setup.service.provideInput(
    setup.person,
    first.connectionRef,
    handoffRefOf(first.polled),
    { team },
  );
  return { ...first, done };
}

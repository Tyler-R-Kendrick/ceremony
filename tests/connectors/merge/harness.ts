import {
  runtimeBindingSchema,
  type RuntimeBinding,
} from "../../../src/server/connectors/binding.js";
import type {
  AdapterCallContext,
  ConnectionRecord,
} from "../../../src/server/connectors/index.js";
import {
  createMergeAdapter,
  mergeConfigurationNames,
} from "../../../src/server/connectors/providers/merge/index.js";
import { startMergeApiDouble } from "../doubles/merge-api.js";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";
import {
  accountA,
  accountB,
  incompleteAccount,
  relinkAccount,
} from "../fixtures/merge/accounts.js";

/* The Merge adapter against its API double, shared by the Merge suites. */

export function bindingFor(
  origin: string,
  overrides: Partial<RuntimeBinding> = {},
): RuntimeBinding {
  return runtimeBindingSchema.parse({
    bindingRef: "binding:merge:1",
    definitionRef: "def:merge:1",
    revision: 1,
    adapterId: "merge",
    adapterVersion: "2026.09.18",
    runtime: "hosted-server",
    custody: "external-credential-broker",
    authorityInstance: origin,
    status: "approved",
    approvedAt: "2026-09-18T00:00:00.000Z",
    policyRevision: "policy-1",
    tenantId: fixtureActor.tenantId,
    destinations: [{ id: "api", origin, network: "loopback-fixture" }],
    operations: [
      {
        operationRef: "op:employees.list",
        nativeId: "hris.employees.list",
        destinationId: "api",
        transport: {
          kind: "http",
          method: "GET",
          pathTemplate: "/hris/v1/employees",
        },
        effect: "read",
        outputClassification: "personal",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
      {
        operationRef: "op:groups.list",
        nativeId: "hris.groups.list",
        destinationId: "api",
        transport: {
          kind: "http",
          method: "GET",
          pathTemplate: "/hris/v1/groups",
        },
        effect: "read",
        outputClassification: "personal",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
      {
        operationRef: "op:passthrough.timeoff",
        nativeId: "hris.passthrough.time-off-policies",
        destinationId: "api",
        transport: {
          kind: "delegated",
          route: "GET /v1/time_off_policies",
        },
        effect: "read",
        outputClassification: "personal",
        cost: "metered",
        consent: "confirm",
        replay: "read-only",
        targetParameters: [],
      },
    ],
    configuration: [mergeConfigurationNames.apiKey],
    permittedTargets: [
      { kind: "merge-linked-account", id: accountA.id },
      { kind: "merge-linked-account", id: accountB.id },
    ],
    reviewedDigest: "c".repeat(64),
    settings: {
      "merge.categories": ["hris"],
      "merge.endUsers": {
        [fixtureActor.subjectId]: {
          originId: accountA.endUserOriginId,
          organization: "Acme",
          email: "ops@acme.test",
        },
      },
      "merge.reads": {
        "op:employees.list": {
          category: "hris",
          model: "employees",
          fields: ["id", "first_name", "last_name", "work_email"],
        },
        "op:groups.list": {
          category: "hris",
          model: "groups",
          fields: ["id", "name"],
        },
      },
      "merge.passthrough": {
        "op:passthrough.timeoff": {
          category: "hris",
          path: "/v1/time_off_policies",
          method: "GET",
        },
      },
    },
    ...overrides,
  });
}

export async function harness(
  options: {
    accounts?: Parameters<typeof startMergeApiDouble>[0] extends infer T
      ? T extends { accounts?: infer A }
        ? A
        : never
      : never;
    accountToken?: string;
    linkedAccountId?: string;
    bindingOverrides?: Partial<RuntimeBinding>;
    doubleOptions?: Parameters<typeof startMergeApiDouble>[0];
    adapterOptions?: Parameters<typeof createMergeAdapter>[0];
  } = {},
) {
  const double = await startMergeApiDouble({
    accounts: [accountA, accountB, incompleteAccount, relinkAccount],
    ...options.doubleOptions,
  });
  const ports = memoryPorts({ now: () => 1_770_000_000_000 });
  ports.configuration.set(mergeConfigurationNames.apiKey, double.apiKey);
  const binding = bindingFor(double.origin, options.bindingOverrides ?? {});
  const record: ConnectionRecord = {
    connectionRef: "conn:merge:1",
    bindingRef: binding.bindingRef,
    definitionRef: binding.definitionRef,
    ecosystem: "merge",
    service: "merge",
    displayName: "Merge linked account",
    ownerKind: "user",
    custody: "external-credential-broker",
    runtime: "hosted-server",
    lifecycle: "active",
    generation: 1,
    revision: 1,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    tenantId: fixtureActor.tenantId,
    ownerId: fixtureActor.subjectId,
    authorityInstance: binding.authorityInstance,
    bindingRevision: binding.revision,
    policyRevision: binding.policyRevision,
    configurationRevision: "cfg:1",
    externalIds: options.linkedAccountId
      ? { linkedAccountId: options.linkedAccountId }
      : {},
    evidenceRefs: [],
    state: {},
  };
  if (options.accountToken !== undefined) {
    record.credentialRef = await ports.credentials.store(
      {
        tenantId: record.tenantId,
        ownerKind: record.ownerKind,
        ownerId: record.ownerId,
        connectionRef: record.connectionRef,
        bindingRef: record.bindingRef,
        custody: "external-credential-broker",
      },
      { accountToken: options.accountToken },
    );
  }
  await ports.connections.create(record);
  const controller = new AbortController();
  const ctx: AdapterCallContext = {
    actor: fixtureActor,
    binding,
    connection: record,
    generation: 1,
    signal: controller.signal,
    environment: ports.environment({ fetch: globalThis.fetch }),
  };
  return {
    double,
    ports,
    ctx,
    binding,
    adapter: createMergeAdapter(options.adapterOptions),
    async close() {
      controller.abort();
      await double.close();
    },
  };
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";
import { startServiceBrokerFixture } from "../doubles/service-broker.js";
import { buildBinding } from "../fixtures/builders.js";
import type { AdapterCallContext } from "../../../src/server/connectors/adapter.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { verifyNormalizedDigest } from "../../../src/core/connectors/index.js";
import {
  OSB_ADAPTER_ID,
  OSB_API_VERSION,
  OSB_OPERATIONS,
  OSB_PASSWORD_CONFIGURATION,
  OSB_SOURCE,
  OSB_USERNAME_CONFIGURATION,
  createOpenServiceBrokerAdapter,
  importOpenServiceBrokerCatalog,
} from "../../../src/server/connectors/providers/open-service-broker/index.js";

/*
 * The catalog is the contract. `instances_retrievable` and
 * `bindings_retrievable` decide what may be called at all, and paid plans
 * decide what this profile refuses to touch, so both are read from the
 * broker's own document and never assumed.
 */

const BROKER_USER = "fixture-platform";
const BROKER_PASSWORD = "fixture-platform-password";

const catalogDocument = async () =>
  JSON.parse(
    await readFile(
      fileURLToPath(
        new URL("../fixtures/open-service-broker/catalog.json", import.meta.url),
      ),
      "utf8",
    ),
  ) as { services: Parameters<typeof startServiceBrokerFixture>[0]["services"] };

export async function brokerHarness(options: {
  origin: string;
  services: Awaited<ReturnType<typeof catalogDocument>>["services"];
  configureCredentials?: boolean;
  permittedTargets?: Array<{ kind: string; id: string }>;
  operationOverrides?: Partial<
    Record<keyof typeof OSB_OPERATIONS, { method: "GET" | "PUT" | "DELETE" }>
  >;
}) {
  const ports = memoryPorts();
  if (options.configureCredentials !== false) {
    ports.configuration.set(OSB_USERNAME_CONFIGURATION, BROKER_USER);
    ports.configuration.set(OSB_PASSWORD_CONFIGURATION, BROKER_PASSWORD);
  }
  const operationFor = (
    key: keyof typeof OSB_OPERATIONS,
    pathTemplate: string,
  ) => ({
    operationRef: OSB_OPERATIONS[key],
    nativeId: key,
    destinationId: "broker",
    transport: {
      kind: "http" as const,
      method: options.operationOverrides?.[key]?.method ?? ("GET" as const),
      pathTemplate,
    },
    effect: "read" as const,
    outputClassification: (key === "binding" ? "personal" : "public") as
      | "public"
      | "personal",
    cost: "free" as const,
    consent: "none" as const,
    replay: "read-only" as const,
    targetParameters: [] as string[],
  });
  const binding = buildBinding({
    adapterId: OSB_ADAPTER_ID,
    destinations: [
      { id: "broker", origin: options.origin, network: "loopback-fixture" },
    ],
    operations: [
      operationFor("catalog", "/v2/catalog"),
      operationFor("instance", "/v2/service_instances"),
      operationFor("instanceLastOperation", "/v2/service_instances"),
      operationFor("binding", "/v2/service_instances"),
      operationFor("bindingLastOperation", "/v2/service_instances"),
    ],
    configuration: [],
    permittedTargets: options.permittedTargets ?? [],
    settings: {
      broker: {
        destinationId: "broker",
        brokerId: "fixture-broker",
        credentials: {
          kind: "basic",
          usernameConfiguration: OSB_USERNAME_CONFIGURATION,
          passwordConfiguration: OSB_PASSWORD_CONFIGURATION,
        },
        services: options.services.map((service) => ({
          serviceId: service.id,
          instancesRetrievable: service.instances_retrievable === true,
          bindingsRetrievable: service.bindings_retrievable === true,
          bindable: service.bindable,
        })),
        acceptsIncomplete: false,
      },
    },
    profileId: undefined,
  });
  const ctx: AdapterCallContext = {
    actor: fixtureActor,
    binding,
    generation: 0,
    signal: AbortSignal.timeout(10_000),
    environment: ports.environment({ fetch: globalThis.fetch }),
  };
  return { ports, binding, ctx };
}

export const brokerCredentials = {
  username: BROKER_USER,
  password: BROKER_PASSWORD,
};
export { catalogDocument };

test("the catalog import describes retrievability exactly as the broker declared it", async () => {
  const document = await catalogDocument();
  const imported = await importOpenServiceBrokerCatalog(document, {
    sourceRef: "source:broker",
    origin: { kind: "provider-api" },
    brokerId: "fixture-broker",
    capturedAt: "2026-09-18T00:00:00.000Z",
  });
  assert.equal(imported.services.length, 3);
  const postgres = imported.services.find(
    (service) => service.name === "fixture-postgres",
  );
  assert.ok(postgres);
  assert.equal(postgres.instancesRetrievable, true);
  assert.equal(postgres.bindingsRetrievable, true);
  const cache = imported.services.find(
    (service) => service.name === "fixture-opaque-cache",
  );
  assert.ok(cache);
  // Acceptance: missing optional broker retrieval support is reported
  // accurately rather than being attempted and guessed at.
  assert.equal(cache.instancesRetrievable, false);
  assert.equal(cache.bindingsRetrievable, false);
  const missingBindings = imported.issues.find(
    (issue) =>
      issue.code === "osb.service.bindings-not-retrievable" &&
      issue.sourcePointer.includes(cache.serviceId),
  );
  assert.ok(missingBindings, "the limitation is an explicit issue");
  assert.equal(missingBindings.disposition, "unsupported");
  assert.equal(missingBindings.executionImpact, "blocks-operation");
  // A non-bindable offering gets no binding limitation, because it has no bindings.
  assert.equal(
    imported.issues.some(
      (issue) =>
        issue.code === "osb.service.bindings-not-retrievable" &&
        issue.sourcePointer.includes("3ac1a0bd-0a52-4d18-9c4d-3f3b5d4c9e71"),
    ),
    false,
  );
  assert.equal(await verifyNormalizedDigest(imported.definition), true);
});

test("plan bindability and free/paid follow the specification's precedence rules", async () => {
  const document = await catalogDocument();
  const imported = await importOpenServiceBrokerCatalog(document, {
    sourceRef: "source:broker",
    origin: { kind: "provider-api" },
    brokerId: "fixture-broker",
    capturedAt: "2026-09-18T00:00:00.000Z",
  });
  const cache = imported.services.find(
    (service) => service.name === "fixture-opaque-cache",
  )!;
  // The plan declares no `bindable`, so it inherits the offering's.
  assert.equal(cache.plans[0]!.bindable, true);
  // `free` defaults to true when the plan does not say otherwise.
  assert.equal(cache.plans[0]!.free, true);
  const postgres = imported.services.find(
    (service) => service.name === "fixture-postgres",
  )!;
  const dedicated = postgres.plans.find((plan) => plan.name === "dedicated")!;
  assert.equal(dedicated.free, false);
  const paidIssue = imported.issues.find(
    (issue) =>
      issue.code === "osb.plan.not-free" &&
      issue.sourcePointer.includes(dedicated.planId),
  );
  assert.ok(paidIssue, "a paid plan is named as out of scope");
  assert.match(paidIssue.message, /Provisioning and plan changes are unavailable/);
});

test("every catalog import records that the profile is inspection only", async () => {
  const document = await catalogDocument();
  const imported = await importOpenServiceBrokerCatalog(document, {
    sourceRef: "source:broker",
    origin: { kind: "provider-api" },
    brokerId: "fixture-broker",
    capturedAt: "2026-09-18T00:00:00.000Z",
  });
  const issue = imported.issues.find(
    (item) => item.code === "osb.profile.inspection-only",
  );
  assert.ok(issue);
  assert.match(issue.message, /no such request is issued/);
  assert.equal(imported.identity.nativeVersion, OSB_API_VERSION);
  assert.equal(OSB_SOURCE.tag, "v2.17");
});

test("discovery sends the required version header and the documented route", async () => {
  const document = await catalogDocument();
  const broker = await startServiceBrokerFixture({
    services: document.services,
    credentials: brokerCredentials,
  });
  try {
    const { ctx } = await brokerHarness({
      origin: broker.origin,
      services: document.services,
    });
    const adapter = createOpenServiceBrokerAdapter();
    const result = await adapter.discover!(ctx, {});
    assert.equal(result.items.length, 3);
    assert.equal(result.freshness.source, "live");
    assert.deepEqual(broker.apiVersionsSeen(), [OSB_API_VERSION]);
    assert.equal(broker.received("GET", "/v2/catalog").length, 1);
    const cache = result.items.find(
      (item) => item.displayName === "fixture-opaque-cache",
    );
    assert.equal(cache?.provenance?.bindingsRetrievable, "false");
    assert.equal(cache?.provenance?.paidPlans, "0");
    const postgres = result.items.find(
      (item) => item.displayName === "fixture-postgres",
    );
    assert.equal(postgres?.provenance?.paidPlans, "1");
    // The request identity is fresh per request; the originating identity is a
    // pseudonym, never the host's own tenant or subject.
    assert.equal(broker.requestIdentities().length, 1);
    const identities = broker.originatingIdentities();
    assert.equal(identities.length, 1);
    assert.match(identities[0]!, /^ceremony /);
    const decoded = Buffer.from(identities[0]!.split(" ")[1]!, "base64").toString(
      "utf8",
    );
    assert.equal(decoded.includes(fixtureActor.tenantId), false);
    assert.equal(decoded.includes(fixtureActor.subjectId), false);
    assert.match(decoded, /"user_id":"[0-9a-f]{32}"/);
  } finally {
    await broker.close();
  }
});

test("a broker that rejects the declared API version is reported unsupported", async () => {
  const document = await catalogDocument();
  const broker = await startServiceBrokerFixture({
    services: document.services,
    credentials: brokerCredentials,
    supportedMinor: 13,
  });
  try {
    const { ctx } = await brokerHarness({
      origin: broker.origin,
      services: document.services,
    });
    const adapter = createOpenServiceBrokerAdapter();
    await assert.rejects(
      () => adapter.discover!(ctx, {}),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "unsupported" &&
        error.detail === "osb.api-version-rejected",
    );
    // One attempt, then a stop: no version downgrade loop.
    assert.equal(broker.requests.length, 1);
  } finally {
    await broker.close();
  }
});

test("invalid broker credentials fail without retrying and without leaking them", async () => {
  const document = await catalogDocument();
  const broker = await startServiceBrokerFixture({
    services: document.services,
    credentials: { username: BROKER_USER, password: "a-different-password" },
  });
  try {
    const { ctx } = await brokerHarness({
      origin: broker.origin,
      services: document.services,
    });
    const adapter = createOpenServiceBrokerAdapter();
    await assert.rejects(
      () => adapter.discover!(ctx, {}),
      (error: unknown) => {
        assert.ok(error instanceof ConnectorError);
        assert.equal(error.code, "unauthenticated");
        assert.equal(error.message.includes(BROKER_PASSWORD), false);
        return true;
      },
    );
    assert.equal(broker.requests.length, 1);
  } finally {
    await broker.close();
  }
});

test("missing broker credentials stop the call rather than sending an anonymous one", async () => {
  const document = await catalogDocument();
  const broker = await startServiceBrokerFixture({
    services: document.services,
    credentials: brokerCredentials,
  });
  try {
    const { ctx } = await brokerHarness({
      origin: broker.origin,
      services: document.services,
      configureCredentials: false,
    });
    const adapter = createOpenServiceBrokerAdapter();
    await assert.rejects(
      () => adapter.discover!(ctx, {}),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "configuration-required" &&
        error.detail === "osb.credentials.missing",
    );
    assert.equal(broker.requests.length, 0);
  } finally {
    await broker.close();
  }
});

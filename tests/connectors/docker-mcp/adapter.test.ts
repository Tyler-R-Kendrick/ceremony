import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { memoryPorts, fixtureActor } from "../doubles/ports.js";
import { startHttpFixture } from "../doubles/http-fixture.js";
import { buildBinding, buildDefinition } from "../fixtures/builders.js";
import {
  createDockerMcpCatalogAdapter,
  DOCKER_CATALOG_OPERATION,
  dockerRunnerAvailability,
} from "../../../src/server/connectors/registries/docker/adapter.js";
import {
  exportDockerMcpDescriptor,
  dockerRunDescriptor,
} from "../../../src/server/connectors/registries/docker/export.js";
import { readDockerMcpCatalog } from "../../../src/server/connectors/registries/docker/catalog.js";
import {
  NO_RUNNER_CONFIGURED,
  unavailableHostRunner,
  type HostRunnerPort,
} from "../../../src/server/connectors/registries/docker/runner.js";
import type {
  AdapterCallContext,
  NormalizedDefinition,
} from "../../../src/server/connectors/adapter.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";

const catalogText = () =>
  readFile(
    fileURLToPath(new URL("../fixtures/docker-mcp/catalog.yaml", import.meta.url)),
    "utf8",
  );

async function harness(
  options: { runner?: HostRunnerPort; body?: string; status?: number } = {},
) {
  const text = options.body ?? (await catalogText());
  const fixture = await startHttpFixture((request) =>
    request.url.pathname === "/mcp/catalog/v2/catalog.yaml"
      ? {
          status: options.status ?? 200,
          headers: { "content-type": "application/yaml" },
          body: text,
        }
      : undefined,
  );
  const ports = memoryPorts();
  const binding = buildBinding({
    adapterId: "docker-mcp-catalog",
    destinations: [
      { id: "catalog", origin: fixture.origin, network: "loopback-fixture" },
    ],
    operations: [
      {
        operationRef: DOCKER_CATALOG_OPERATION,
        nativeId: "catalog.yaml",
        destinationId: "catalog",
        transport: {
          kind: "http",
          method: "GET",
          pathTemplate: "/mcp/catalog/v2/catalog.yaml",
        },
        effect: "read",
        outputClassification: "public",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
    ],
    configuration: [],
    profileId: undefined,
  });
  const ctx: AdapterCallContext = {
    actor: fixtureActor,
    binding,
    generation: 0,
    signal: AbortSignal.timeout(5000),
    environment: ports.environment({ fetch: globalThis.fetch }),
  };
  const adapter = createDockerMcpCatalogAdapter(
    options.runner ? { runner: options.runner } : {},
  );
  return { fixture, ports, ctx, adapter, binding };
}

async function importedDefinitions(): Promise<NormalizedDefinition[]> {
  const { fixture, ctx, adapter } = await harness();
  try {
    const bytes = new TextEncoder().encode(await catalogText());
    const outcome = await adapter.import!(ctx, {
      bytes,
      mediaType: "application/yaml",
      origin: { kind: "upload" },
    });
    return outcome.definitions;
  } finally {
    await fixture.close();
  }
}

test("discovery pages the catalog and preserves provenance", async () => {
  const { fixture, ctx, adapter } = await harness();
  try {
    const first = await adapter.discover!(ctx, { limit: 3 });
    assert.equal(first.items.length, 3);
    assert.equal(first.nextCursor, "3");
    assert.equal(first.freshness.source, "live");
    assert.equal(first.freshness.stale, false);
    const second = await adapter.discover!(ctx, {
      limit: 3,
      cursor: first.nextCursor!,
    });
    assert.equal(second.items.length, 3);
    const third = await adapter.discover!(ctx, {
      limit: 3,
      cursor: second.nextCursor!,
    });
    assert.equal(third.nextCursor, undefined);
    const ids = [...first.items, ...second.items, ...third.items].map(
      (item) => item.identity.nativeId,
    );
    assert.equal(new Set(ids).size, 7);
    const github = [...first.items, ...second.items, ...third.items].find(
      (item) => item.identity.nativeId === "github-official",
    );
    assert.ok(github);
    assert.equal(github.identity.ecosystem, "docker-mcp");
    assert.equal(github.identity.authorityNamespace, "ceremony-fixture");
    assert.equal(
      github.identity.nativeVersion,
      "sha256:508a0857ec762b1ab1cece29193345b501fab1dd9d1228a7b617062954cecac6",
    );
    assert.equal(github.provenance?.owner, "github");
    assert.equal(github.provenance?.entryType, "server");
    assert.equal(
      github.provenance?.upstreamRepository,
      "https://github.com/github/github-mcp-server",
    );
    const requests = fixture.received("GET", "/mcp/catalog/v2/catalog.yaml");
    assert.equal(requests.length, 3);
    assert.equal(requests[0]?.headers.authorization, undefined);
  } finally {
    await fixture.close();
  }
});

test("discovery filters by query and refuses a forged cursor", async () => {
  const { fixture, ctx, adapter } = await harness();
  try {
    const result = await adapter.discover!(ctx, { query: "couch" });
    assert.deepEqual(
      result.items.map((item) => item.identity.nativeId),
      ["couchbase"],
    );
    await assert.rejects(
      () => adapter.discover!(ctx, { cursor: "../../etc" }),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "invalid-request",
    );
  } finally {
    await fixture.close();
  }
});

test("discovery requires a bound catalog destination", async () => {
  const { fixture, ctx, adapter, binding } = await harness();
  try {
    const unbound = { ...ctx, binding: { ...binding, operations: [] } };
    await assert.rejects(
      () => adapter.discover!(unbound, {}),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "configuration-required",
    );
  } finally {
    await fixture.close();
  }
});

test("import produces inert definitions with secrets as named configuration", async () => {
  const definitions = await importedDefinitions();
  assert.equal(definitions.length, 7);
  const brave = definitions.find(
    (definition) => definition.identity.nativeId === "brave",
  );
  assert.ok(brave);
  assert.equal(brave.display.ecosystem, "docker-mcp");
  assert.equal(brave.importer.id, "docker-mcp-catalog");
  assert.deepEqual(
    brave.configuration.map((item) => [item.name, item.classification]),
    [["BRAVE_API_KEY", "secret"]],
  );
  assert.deepEqual(
    brave.capabilities.map((capability) => capability.kind),
    ["mcp-tool", "mcp-tool", "mcp-tool"],
  );
  assert.equal(brave.compatibility.dimensions.invoke, "requires-configuration");
  assert.equal(brave.compatibility.dimensions.import, "exact");
  assert.ok(
    brave.compatibility.issues.some(
      (issue) => issue.code === "docker-mcp.invoke.local-runner-required",
    ),
  );
  // The image reference is carried as data, never as an instruction to pull.
  assert.equal(
    (
      (brave.nativeExtensions as { entry: { image: string } }).entry
    ).image.startsWith("mcp/brave-search@sha256:"),
    true,
  );
});

test("a remote catalog entry declares its server and header credential without inventing a login", async () => {
  const definitions = await importedDefinitions();
  const context7 = definitions.find(
    (definition) => definition.identity.nativeId === "context7",
  );
  assert.ok(context7);
  assert.deepEqual(context7.declaredServers, [
    { url: "https://mcp.context7.com/mcp", status: "declared" },
  ]);
  assert.deepEqual(
    context7.authentication.map((profile) => profile.kind),
    ["api-key"],
  );
  assert.equal(
    context7.authentication[0]?.kind === "api-key" &&
      context7.authentication[0].parameterName,
    "CONTEXT7_API_KEY",
  );
  assert.deepEqual(
    context7.configuration.map((item) => item.name),
    ["CONTEXT7_API_KEY"],
  );
});

test("a Docker-brokered OAuth entry is preserved but blocked for authorization here", async () => {
  const definitions = await importedDefinitions();
  const github = definitions.find(
    (definition) => definition.identity.nativeId === "github-official",
  );
  assert.ok(github);
  const broker = github.authentication.find(
    (profile) => profile.kind === "external-broker",
  );
  assert.ok(broker);
  assert.equal(
    broker.kind === "external-broker" && broker.custody,
    "external-credential-broker",
  );
  const blocking = github.compatibility.issues.filter(
    (issue) => issue.severity === "blocking",
  );
  assert.ok(
    blocking.some((issue) => issue.code === "docker-mcp.auth.toolkit-broker"),
  );
  assert.equal(github.compatibility.dimensions.authorize, "unsupported");
});

test("AC-EXT-08: importing in a hosted deployment works and local execution is explicitly unavailable", async () => {
  const { fixture, ctx, adapter } = await harness();
  try {
    const bytes = new TextEncoder().encode(await catalogText());
    const outcome = await adapter.import!(ctx, {
      bytes,
      mediaType: "application/yaml",
      origin: { kind: "url", location: "https://desktop.docker.com/catalog.yaml" },
    });
    assert.equal(outcome.definitions.length, 7);
    assert.deepEqual(outcome.executableCandidates, []);
    assert.equal(outcome.source.digest.algorithm, "sha256");
    assert.equal(outcome.source.byteLength, bytes.byteLength);

    const availability = await dockerRunnerAvailability(adapter);
    assert.equal(availability.available, false);
    assert.equal(availability.reason, NO_RUNNER_CONFIGURED);

    const rows = adapter.capabilities(new Set());
    const invoke = rows.find((row) => row.dimension === "invoke");
    assert.ok(invoke);
    assert.equal(invoke.implementation, "unsupported");
    assert.equal(invoke.runtime, "trusted-local-runner");
    assert.equal(invoke.configuration, "missing");
    assert.equal(invoke.evidence, "not-tested");
    assert.ok(invoke.limitations.includes(NO_RUNNER_CONFIGURED));
    assert.equal(adapter.support, "catalog-only");

    await assert.rejects(
      () =>
        adapter.invoke!(ctx, {
          operationRef: "docker-mcp.run",
          input: {},
          commandId: "command-1",
        }),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "unsupported",
    );
    // Nothing was attempted upstream: the only requests are catalog reads.
    assert.equal(
      fixture.requests.every((request) =>
        request.url.pathname.endsWith("catalog.yaml"),
      ),
      true,
    );
  } finally {
    await fixture.close();
  }
});

test("an explicitly configured runner receives a descriptor and is never constructed by default", async () => {
  const seen: unknown[] = [];
  const runner: HostRunnerPort = {
    async available() {
      return { available: true };
    },
    async run(descriptor) {
      seen.push(descriptor);
      return {
        state: "complete",
        outputClassification: "public",
        effect: "read",
        output: { ok: true },
      };
    },
  };
  const definitions = await importedDefinitions();
  const brave = definitions.find(
    (definition) => definition.identity.nativeId === "brave",
  )!;
  const { fixture, ctx, adapter, binding } = await harness({ runner });
  try {
    const bound = {
      ...ctx,
      binding: { ...binding, settings: { definition: brave } },
    };
    const result = await adapter.invoke!(bound, {
      operationRef: "docker-mcp.run",
      input: { q: "x" },
      commandId: "command-2",
    });
    assert.equal(result.state, "complete");
    assert.equal(seen.length, 1);
    const descriptor = dockerRunDescriptor(brave);
    assert.equal(descriptor.type, "server");
    assert.equal(
      descriptor.imageDigest,
      "sha256:f58a5c22c1196ec7bd1ca586ce216f2334fc298550ddcf652c0e8adb6d256d78",
    );
    assert.deepEqual(descriptor.secrets, [
      { name: "brave.api_key", env: "BRAVE_API_KEY" },
    ]);
    assert.deepEqual(descriptor.environment, [
      { name: "BRAVE_MCP_TRANSPORT", value: "stdio" },
    ]);
    const rows = adapter.capabilities(new Set());
    const invoke = rows.find((row) => row.dimension === "invoke");
    assert.equal(invoke?.implementation, "implemented");
    assert.equal(invoke?.runtime, "trusted-local-runner");
  } finally {
    await fixture.close();
  }
});

test("the default runner refuses to run and reports the exact reason", async () => {
  const runner = unavailableHostRunner("Docker Desktop is not installed here.");
  assert.deepEqual(await runner.available(), {
    available: false,
    reason: "Docker Desktop is not installed here.",
  });
  await assert.rejects(
    () =>
      runner.run(
        { catalogName: "c", id: "a", type: "server", command: [], environment: [], secrets: [], volumes: [], allowHosts: [] },
        {} as AdapterCallContext,
      ),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "unsupported",
  );
});

test("export reproduces a catalog entry, reports losses and refuses foreign definitions", async () => {
  const definitions = await importedDefinitions();
  const couchbase = definitions.find(
    (definition) => definition.identity.nativeId === "couchbase",
  )!;
  const exported = exportDockerMcpDescriptor(couchbase);
  assert.equal(exported.mediaType, "application/yaml");
  const reread = readDockerMcpCatalog(exported.text);
  assert.ok(reread.catalog);
  assert.equal(reread.catalog.servers.length, 1);
  const entry = reread.catalog.servers[0]!;
  assert.equal(entry.id, "couchbase");
  assert.equal(entry.type, "server");
  assert.equal(
    entry.image?.digest,
    "sha256:85a104706d8b2b3bceddf47f2a0e30e68dd5ddcdc2cbff3faa48e885d4b9f4bc",
  );
  assert.deepEqual(
    entry.secrets.map((secret) => [secret.name, secret.env]),
    [["couchbase.cb_password", "CB_PASSWORD"]],
  );
  assert.deepEqual(
    entry.tools.map((tool) => tool.name),
    ["get_document_by_id", "run_sql_plus_plus_query"],
  );
  assert.ok(
    exported.losses.some(
      (loss) => loss.code === "docker-mcp.export.blocking-issues",
    ),
  );
  assert.throws(
    () => exportDockerMcpDescriptor(buildDefinition()),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "unsupported",
  );
});

test("an export never reconstructs a value the reader removed", async () => {
  const hostile = await readFile(
    fileURLToPath(new URL("../fixtures/docker-mcp/hostile.yaml", import.meta.url)),
    "utf8",
  );
  const { fixture, ctx, adapter } = await harness({ body: hostile });
  try {
    const outcome = await adapter.import!(ctx, {
      bytes: new TextEncoder().encode(hostile),
      mediaType: "application/yaml",
      origin: { kind: "upload" },
    });
    const literal = outcome.definitions.find(
      (definition) => definition.identity.nativeId === "literal-credentials",
    )!;
    const exported = exportDockerMcpDescriptor(literal);
    assert.ok(!exported.text.includes("ghp_CANARYTOKEN4b2"));
    assert.ok(!exported.text.includes("sk_live_CANARY_SECRET_9f3"));
    assert.ok(
      exported.losses.some(
        (loss) => loss.code === "docker-mcp.export.redacted-on-import",
      ),
    );
    const loader = outcome.definitions.find(
      (definition) => definition.identity.nativeId === "loader-hijack",
    )!;
    const loaderExport = exportDockerMcpDescriptor(loader);
    assert.ok(!loaderExport.text.includes("LD_PRELOAD"));
    assert.ok(!loaderExport.text.includes("NODE_OPTIONS"));
    const descriptor = dockerRunDescriptor(loader);
    assert.deepEqual(
      descriptor.environment.map((entry) => entry.name),
      ["SAFE_MODE"],
    );
  } finally {
    await fixture.close();
  }
});

test("an unreachable or oversized catalog fails closed", async () => {
  const failing = await harness({ status: 503 });
  try {
    await assert.rejects(
      () => failing.adapter.discover!(failing.ctx, {}),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "upstream-unavailable",
    );
  } finally {
    await failing.fixture.close();
  }
  const broken = await harness({ body: "name: x\nname: y\n" });
  try {
    const result = await broken.adapter.discover!(broken.ctx, {});
    assert.deepEqual(result.items, []);
    assert.equal(result.issues[0]?.severity, "blocking");
  } finally {
    await broken.fixture.close();
  }
});

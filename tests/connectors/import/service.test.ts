import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthorizationError } from "../../../src/server/identity.js";
import {
  IMPORT_FIXTURE_ROOT,
  detectDocument,
  importFromUrl,
  importLocalFixture,
  importUpload,
} from "../../../src/server/connectors/import/index.js";
import { connectorImportResultSchema } from "../../../src/core/connectors/index.js";
import { startHttpFixture } from "../doubles/http-fixture.js";
import {
  CANARY,
  assertNoCanary,
  encode,
  expectConnectorError,
  fixtureBytes,
  importActor,
  importPorts,
  loopbackPolicy,
  readOnlyActor,
} from "./support.js";

/*
 * IMP-06. The command helpers a server route mounts: authenticated upload,
 * explicit URL ingestion and the air-gapped fixture path. Import produces
 * candidates and diagnostics; it registers nothing executable and contacts
 * nothing beyond the one approved retrieval.
 */

test("import requires the host's authenticated author capability", async () => {
  const ports = importPorts();
  const bytes = await fixtureBytes("petstore-openapi-3.0.json");
  await assert.rejects(
    () => importUpload(readOnlyActor, bytes, "application/json", ports),
    (error: unknown) =>
      error instanceof AuthorizationError && error.code === "denied",
  );
  // A forged actor shape is not identity: it fails validation, it does not pass.
  for (const actor of [
    undefined,
    {},
    { ...importActor, capabilities: ["author", "root"] },
    { ...importActor, tenantId: "" },
    { ...importActor, extra: "field" },
  ])
    await assert.rejects(
      () => importUpload(actor as never, bytes, "application/json", ports),
      (error: unknown) => error instanceof AuthorizationError,
    );
  assert.equal(ports.artifacts.entries().length, 0);
  // An admin capability covers authoring, as elsewhere in the host.
  const admin = { ...importActor, capabilities: ["admin" as const] };
  const outcome = await importUpload(admin, bytes, "application/json", ports);
  assert.equal(outcome.source.byteLength, bytes.byteLength);
});

test("an upload becomes a candidate with provenance and no executable registration", async () => {
  const ports = importPorts();
  const bytes = await fixtureBytes("petstore-openapi-3.1.yaml");
  const outcome = await importUpload(
    importActor,
    bytes,
    "application/yaml",
    ports,
    { fileName: "petstore.yaml" },
  );

  assert.equal(connectorImportResultSchema.safeParse(outcome.result).success, true);
  assert.equal(outcome.result.sourceRef, outcome.source.sourceRef);
  // Import registers nothing: no definitions, no executable candidates.
  assert.deepEqual(outcome.result.definitions, []);
  assert.deepEqual(outcome.result.executableCandidates, []);
  assert.equal(outcome.document.format, "yaml");
  assert.equal(outcome.document.detected.ecosystem, "openapi");
  assert.equal(outcome.document.detected.version, "3.1.0");
  assert.equal(outcome.document.detected.title, "Petstore Fixture");
  assert.equal(outcome.source.origin.kind, "upload");
  assert.equal(outcome.source.origin.location, undefined);
  assert.equal(outcome.source.format.name, "openapi");
  assert.equal(outcome.source.identity.nativeVersion, "2024-06-01");
  assert.equal(outcome.source.identity.nativeId, "petstore.yaml");
  assert.equal(outcome.source.mediaType, "application/yaml");
  assert.match(outcome.document.normalizedDigest, /^[a-f0-9]{64}$/);
  assert.notEqual(outcome.document.normalizedDigest, outcome.source.digest.value);
  // The stored record is the one that was returned.
  assert.deepEqual(
    await ports.definitions.getSource(importActor.tenantId, outcome.source.sourceRef),
    outcome.source,
  );
});

test("each supported family is recognized, and an unknown one is stored as opaque", async () => {
  const ports = importPorts();
  const expectations = [
    ["petstore-openapi-3.0.json", "application/json", "openapi", "3.0.3"],
    ["swagger-2.json", "application/json", "openapi", "2.0"],
    ["asyncapi-3.yaml", "application/yaml", "asyncapi", "3.0.0"],
    ["mcp-server.json", "application/json", "mcp-registry", "2025-07-09"],
  ] as const;
  for (const [name, mediaType, ecosystem, version] of expectations) {
    const outcome = await importUpload(
      importActor,
      await fixtureBytes(name),
      mediaType,
      ports,
      { fileName: name },
    );
    assert.equal(outcome.document.detected.ecosystem, ecosystem, name);
    assert.equal(outcome.document.detected.version, version, name);
    assert.equal(outcome.issues.length, 0, name);
  }
  // A registry entry naming an npm package and arguments is inert data: it is
  // recorded, and nothing installs, spawns or pulls anything.
  const registry = await importUpload(
    importActor,
    await fixtureBytes("mcp-server.json"),
    "application/json",
    ports,
    { fileName: "mcp-server.json" },
  );
  const packages = (registry.document.value as { packages: Array<{ identifier: string }> })
    .packages;
  assert.equal(packages[0]?.identifier, "@example/fixture-mcp");
  assert.deepEqual(registry.result.executableCandidates, []);

  // An unrecognized document still imports, with a warning and no capabilities.
  const unknown = await importUpload(
    importActor,
    encode('{"something":"else"}'),
    "application/json",
    ports,
  );
  assert.equal(unknown.document.detected.ecosystem, "unknown");
  const issue = unknown.issues.find(
    (item) => item.code === "structure.format-unrecognized",
  );
  assert.equal(issue?.severity, "warning");
  assert.equal(issue?.executionImpact, "none");
});

test("detection reads declared markers and nothing else", () => {
  assert.equal(detectDocument({ openapi: "3.2.0" }).version, "3.2.0");
  assert.equal(detectDocument({ swagger: "2.0" }).formatName, "swagger");
  assert.equal(detectDocument({ swagger: "1.2" }).ecosystem, "unknown");
  assert.equal(detectDocument({ arazzo: "1.1.0" }).ecosystem, "arazzo");
  assert.equal(detectDocument({ overlay: "1.1.0" }).ecosystem, "openapi-overlay");
  assert.equal(
    detectDocument({ format: "ceremony-connector", version: 2 }).ecosystem,
    "ceremony",
  );
  assert.equal(
    detectDocument({ protocolVersion: "0.3.0", skills: [], url: "https://a.example" })
      .ecosystem,
    "a2a",
  );
  // Nothing about a title or description can change what the document is.
  assert.equal(
    detectDocument({ info: { title: "OpenAPI", version: "9" } }).ecosystem,
    "unknown",
  );
  assert.equal(detectDocument("openapi: 3.1.0").ecosystem, "unknown");
  assert.equal(detectDocument(null).ecosystem, "unknown");
  // A title with control characters is dropped rather than carried into display.
  assert.equal(
    detectDocument({ openapi: "3.1.0", info: { title: "bad\u0007title" } }).title,
    undefined,
  );
});

test("a URL import performs exactly one retrieval and no provider call", async (t) => {
  const fixture = await startHttpFixture(async (request) => {
    if (request.url.pathname === "/v1/openapi.yaml")
      return {
        headers: { "content-type": "application/yaml" },
        body: Buffer.from(await fixtureBytes("petstore-openapi-3.1.yaml")),
      };
    // Everything a careless importer might also touch: declared servers,
    // discovery documents, schema references and the authorization server.
    return { status: 200, body: { unexpected: request.url.pathname } };
  });
  t.after(() => fixture.close());
  const ports = importPorts();
  const outcome = await importFromUrl(
    importActor,
    `${fixture.origin}/v1/openapi.yaml`,
    loopbackPolicy(),
    ports,
  );

  assert.deepEqual(
    fixture.requests.map((request) => request.url.pathname),
    ["/v1/openapi.yaml"],
  );
  assert.equal(outcome.source.origin.kind, "url");
  assert.equal(outcome.source.origin.location, `${fixture.origin}/v1/openapi.yaml`);
  assert.equal(outcome.source.identity.authorityNamespace, new URL(fixture.origin).host);
  assert.equal(outcome.source.identity.nativeId, "/v1/openapi.yaml");
  assert.deepEqual(outcome.result.executableCandidates, []);
  // The document declares a server and several references; none was contacted.
  const declared = (outcome.document.value as { servers: Array<{ url: string }> }).servers;
  assert.equal(declared[0]?.url, "https://api.petstore.example/v2");
  assert.equal(fixture.requests.length, 1);
});

test("URL ingestion refuses unsafe destinations before any request", async (t) => {
  const fixture = await startHttpFixture(() => ({ body: { ok: true } }));
  t.after(() => fixture.close());
  const ports = importPorts();
  for (const [url, detail] of [
    ["https://api.example/spec.json", "network.loopback-fixture-only"],
    ["http://169.254.169.254/latest/meta-data/", "network.loopback-fixture-only"],
    ["http://10.0.0.5/spec.json", "network.loopback-fixture-only"],
    ["file:///etc/passwd", "network.scheme-forbidden"],
    [`http://user:${CANARY}@127.0.0.1:1/spec.json`, "network.userinfo-forbidden"],
  ] as const) {
    const error = await expectConnectorError(
      importFromUrl(importActor, url, loopbackPolicy(), ports),
      "network-policy",
      detail,
    );
    assertNoCanary(error);
  }
  assert.equal(fixture.requests.length, 0);
  assert.equal(ports.artifacts.entries().length, 0);

  // A non-200 answer is an upstream rejection, not an empty import.
  const failing = await startHttpFixture(() => ({ status: 403, body: { error: "no" } }));
  t.after(() => failing.close());
  await expectConnectorError(
    importFromUrl(importActor, `${failing.origin}/spec.json`, loopbackPolicy(), ports),
    "upstream-rejected",
    "import.status-403",
  );
  assert.equal(ports.artifacts.entries().length, 0);
});

test("a caller cannot substitute an unapproved fetcher", async (t) => {
  const fixture = await startHttpFixture(() => ({ body: { openapi: "3.1.0" } }));
  t.after(() => fixture.close());
  const ports = importPorts();
  await expectConnectorError(
    importFromUrl(importActor, `${fixture.origin}/spec.json`, loopbackPolicy(), ports, {
      fetch: globalThis.fetch as never,
    }),
    "invalid-request",
    "import.fetch-not-approved",
  );
  assert.equal(fixture.requests.length, 0);
});

test("the air-gapped path reads only the fixture directory", async () => {
  const ports = importPorts();
  const outcome = await importLocalFixture("petstore-openapi-3.1.yaml", ports);
  assert.equal(outcome.source.origin.kind, "builtin-fixture");
  assert.equal(outcome.source.origin.location, undefined);
  assert.equal(outcome.document.detected.ecosystem, "openapi");
  assert.equal(outcome.source.identity.nativeId, "petstore-openapi-3.1.yaml");
  assert.ok(IMPORT_FIXTURE_ROOT.endsWith("tests/connectors/fixtures/import/"));

  for (const name of [
    "../../../package.json",
    "/etc/passwd",
    "nested/spec.json",
    "spec.exe",
    "..",
    "petstore-openapi-3.1.yaml\u0000.json",
    "",
  ])
    await expectConnectorError(
      importLocalFixture(name, ports),
      "invalid-request",
      "import.fixture-name-invalid",
    );
  await expectConnectorError(
    importLocalFixture("not-there.json", ports),
    "not-found",
    "import.fixture-missing",
  );
});

test("every checked-in fixture imports or is refused for a stated reason", async () => {
  const ports = importPorts();
  const expectations: Record<string, string> = {
    "malicious-duplicate-keys.json": "json.duplicate-key",
    "malicious-duplicate-keys.yaml": "yaml.duplicate-key",
    "malicious-yaml-tags.yaml": "yaml.tag-unsupported",
    "malicious-yaml-binary.yaml": "yaml.tag-unsupported",
    "malicious-proto-key.json": "document.reserved-key",
    "malicious-proto-key.yaml": "document.reserved-key",
    "malicious-billion-laughs.yaml": "yaml.alias-expansion-exceeds-bounds",
    "malicious-merge-key.yaml": "yaml.merge-key-unsupported",
    "malicious-circular-alias.yaml": "yaml.circular-alias",
    "malicious-multi-document.yaml": "yaml.multiple-documents",
    "malicious-yaml-1-1.yaml": "yaml.version-unsupported",
    "canary-invalid.json": "json.syntax",
  };
  const benign = [
    "petstore-openapi-3.1.yaml",
    "petstore-openapi-3.0.json",
    "swagger-2.json",
    "asyncapi-3.yaml",
    "mcp-server.json",
    "recursive-schema.json",
    "malicious-private-refs.yaml",
    "malicious-example-values.json",
    "canary-secrets.yaml",
    "refresh-v1.yaml",
    "refresh-v2-benign.yaml",
    "refresh-v2-security.yaml",
  ];
  for (const [name, detail] of Object.entries(expectations)) {
    const error = await expectConnectorError(
      importLocalFixture(name, ports),
      "invalid-request",
      detail,
    );
    assertNoCanary(error);
  }
  // A refused document leaves no artifact and no record behind.
  assert.equal(ports.artifacts.entries().length, 0);

  for (const name of benign) {
    const outcome = await importLocalFixture(name, ports);
    assert.equal(outcome.result.sourceRef, outcome.source.sourceRef, name);
    assert.deepEqual(outcome.result.executableCandidates, [], name);
  }
  assert.equal(ports.artifacts.entries().length, benign.length);
});

test("documents that describe dangerous things are imported as descriptions", async () => {
  const ports = importPorts();
  // References to metadata services and private networks are part of the
  // document; importing it neither resolves nor rejects them here.
  const refs = await importLocalFixture("malicious-private-refs.yaml", ports);
  const schemas = (
    refs.document.value as {
      components: { schemas: Record<string, { $ref: string }> };
    }
  ).components.schemas;
  assert.equal(
    schemas.Metadata?.$ref,
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/#/role",
  );
  // Nothing was contacted: the import made one local read and no request.
  assert.equal(refs.source.origin.kind, "builtin-fixture");
  // The credential-bearing reference survives in the document but not in any
  // diagnostic the import produced.
  assertNoCanary(refs.result, refs.issues, refs.source);
  assert.ok(JSON.stringify(refs.document.value).includes(CANARY));
});

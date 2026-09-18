import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { catalogEntryFor } from "../../../src/server/connectors/inventory.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  createMicrosoftCustomConnectorAdapter,
  defaultAuthorizationHook,
  type MicrosoftAuthorizationHook,
} from "../../../src/server/connectors/formats/microsoft/adapter.js";
import { startHttpFixture } from "../doubles/http-fixture.js";
import {
  actorFor,
  adapterContext,
  apiPropertiesFixture,
  buildMicrosoftBinding,
  connectedPrincipal,
  portsWithFetch,
  readFixtureConnector,
  settingsFixture,
  swaggerFixture,
} from "./support.js";

/*
 * The adapter as the host sees it: one directory row, one import entry point,
 * one credential seam. Its negative capabilities are part of the contract, so
 * they are asserted rather than assumed.
 */

const REGION_CONTRACT = "list:CreateItem:body:payload/region";

const minimalContext = (origin: string) => {
  const { environment } = portsWithFetch(origin);
  return adapterContext({
    actor: actorFor("tenant-a", "subject-1"),
    binding: buildMicrosoftBinding({ origin, operations: [] }),
    environment,
  });
};

test("the adapter reports its ecosystem, custody and protocol profiles", () => {
  const adapter = createMicrosoftCustomConnectorAdapter();
  assert.equal(adapter.id, "microsoft-custom-connector");
  assert.equal(adapter.ecosystem, "microsoft-custom-connector");
  assert.equal(adapter.runtime, "hosted-server");
  assert.deepEqual([...adapter.custody], ["host-owned"]);
  assert.ok(adapter.profiles.includes("swagger-2.0"));
  assert.deepEqual(adapter.configuration, []);
});

test("capabilities report each dimension with its real limitations", () => {
  const adapter = createMicrosoftCustomConnectorAdapter();
  const rows = new Map(
    adapter.capabilities(new Set()).map((row) => [row.dimension, row]),
  );

  const verify = rows.get("verify");
  assert.equal(verify?.implementation, "implemented");
  assert.deepEqual(verify?.limitations, [
    "testConnection demonstrates connectivity only",
    "account identity not established",
  ]);

  // Events are genuinely unsupported, and an unsupported dimension may never
  // carry passing evidence.
  const events = rows.get("events");
  assert.equal(events?.implementation, "unsupported");
  assert.equal(events?.evidence, "not-tested");
  assert.ok(events?.limitations.some((text) => /polling/.test(text)));

  const invoke = rows.get("invoke");
  assert.ok(
    invoke?.limitations.some((text) => /dynamic field lookups only/.test(text)),
    "the adapter says which operations it will execute",
  );
  const importRow = rows.get("import");
  assert.ok(
    importRow?.limitations.some((text) => /Swagger 2.0 only/.test(text)),
  );
});

test("the directory row is derived from the adapter, not from a static list", () => {
  const adapter = createMicrosoftCustomConnectorAdapter();
  const entry = catalogEntryFor(adapter, new Set());
  assert.equal(entry.id, "microsoft-custom-connector");
  assert.equal(entry.ecosystem, "microsoft-custom-connector");
  assert.deepEqual(entry.custody, ["host-owned"]);
  assert.deepEqual(entry.configuration, []);
  assert.equal(entry.group, entry.service);
  assert.ok(entry.capabilities.length >= 6);
});

test("import reads the swagger with its companion files and records provenance", async (t) => {
  const fixture = await startHttpFixture(() => ({ body: {} }));
  t.after(() => fixture.close());
  const adapter = createMicrosoftCustomConnectorAdapter();
  const bytes = new TextEncoder().encode(JSON.stringify(swaggerFixture()));
  const outcome = await adapter.import!(minimalContext(fixture.origin), {
    bytes,
    mediaType: "application/json",
    origin: { kind: "upload" },
    metadata: {
      apiProperties: apiPropertiesFixture(),
      settings: settingsFixture(),
    },
  });

  assert.equal(outcome.definitions.length, 1);
  const definition = outcome.definitions[0]!;
  assert.equal(definition.identity.ecosystem, "microsoft-custom-connector");
  assert.equal(definition.identity.nativeId, "contoso-projects-9f21");

  // The exact bytes are digested, separately from the canonical digest of the
  // normalized description.
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(outcome.source.digest.value, digest);
  assert.equal(outcome.source.byteLength, bytes.byteLength);
  assert.deepEqual(outcome.source.format, { name: "swagger", version: "2.0" });
  assert.equal(outcome.source.origin.kind, "upload");
  assert.notEqual(definition.normalizedDigest, digest);
  assert.deepEqual(outcome.source.adaptation, [
    {
      step: "microsoft-custom-connector-read",
      version: adapter.adapterVersion,
      inputDigest: digest,
      outputDigest: definition.normalizedDigest,
    },
  ]);
  // Import offers candidates; it approves nothing.
  assert.ok(outcome.executableCandidates.includes("GetProjects"));
  assert.ok(!outcome.executableCandidates.includes("CreateItem"));
  assert.ok(outcome.issues.length > 0);
  assert.equal(fixture.requests.length, 0, "import never reaches the network");
});

test("import refuses bytes that are not a JSON document without echoing them", async (t) => {
  const fixture = await startHttpFixture(() => ({ body: {} }));
  t.after(() => fixture.close());
  const adapter = createMicrosoftCustomConnectorAdapter();
  await assert.rejects(
    adapter.import!(minimalContext(fixture.origin), {
      bytes: new TextEncoder().encode('{"secret": "CANARY_IN_BROKEN_JSON"'),
      mediaType: "application/json",
      origin: { kind: "upload" },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.code, "invalid-request");
      assert.equal(error.detail, "microsoft.import.not-json");
      assert.ok(!error.message.includes("CANARY_IN_BROKEN_JSON"));
      return true;
    },
  );
});

test("import of an unreadable definition yields provenance and diagnostics, not a definition", async (t) => {
  const fixture = await startHttpFixture(() => ({ body: {} }));
  t.after(() => fixture.close());
  const adapter = createMicrosoftCustomConnectorAdapter();
  const outcome = await adapter.import!(minimalContext(fixture.origin), {
    bytes: new TextEncoder().encode(
      JSON.stringify({ openapi: "3.1.0", info: { title: "x", version: "1" } }),
    ),
    mediaType: "application/json",
    origin: { kind: "upload" },
  });
  assert.deepEqual(outcome.definitions, []);
  assert.deepEqual(outcome.executableCandidates, []);
  assert.ok(
    outcome.issues.some((issue) => issue.code === "version.openapi-3-unsupported"),
  );
  // The captured bytes are still recorded, so the artifact can be reviewed.
  assert.equal(outcome.source.byteLength > 0, true);
});

test("export through the adapter refuses a format it does not produce", async (t) => {
  const read = await readFixtureConnector();
  const fixture = await startHttpFixture(() => ({ body: {} }));
  t.after(() => fixture.close());
  const adapter = createMicrosoftCustomConnectorAdapter();
  const ctx = minimalContext(fixture.origin);
  await assert.rejects(
    adapter.export!(ctx, {
      definition: read.definition,
      format: "openapi-3.1",
      includeNativeExtensions: true,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.code, "unsupported");
      assert.equal(error.detail, "microsoft.export.format");
      return true;
    },
  );
  const outcome = await adapter.export!(ctx, {
    definition: read.definition,
    format: "swagger-2.0",
    includeNativeExtensions: true,
  });
  assert.equal(outcome.mediaType, "application/json");
  assert.ok(outcome.bytes.byteLength > 0);
});

test("the default credential hook builds each declared authentication shape", () => {
  assert.deepEqual(
    defaultAuthorizationHook({
      kind: "api-key",
      placement: "header",
      parameterName: "X-Api-Key",
      material: { value: "k1" },
    }),
    { headers: { "X-Api-Key": "k1" } },
  );
  assert.deepEqual(
    defaultAuthorizationHook({
      kind: "api-key",
      placement: "query",
      parameterName: "api_key",
      material: { value: "k2" },
    }),
    { query: { api_key: "k2" } },
  );
  assert.deepEqual(
    defaultAuthorizationHook({
      kind: "http-basic",
      material: { username: "ada", password: "lovelace" },
    }),
    { headers: { authorization: `Basic ${Buffer.from("ada:lovelace").toString("base64")}` } },
  );
  assert.deepEqual(
    defaultAuthorizationHook({
      kind: "oauth2",
      material: { access_token: "at-1" },
    }),
    { headers: { authorization: "Bearer at-1" } },
  );
  assert.deepEqual(defaultAuthorizationHook({ kind: "none", material: {} }), {});

  // A credential that would split a header is refused rather than sent.
  assert.throws(
    () =>
      defaultAuthorizationHook({
        kind: "api-key",
        placement: "header",
        parameterName: "X-Api-Key",
        material: { value: "bad\r\nX-Injected: 1" },
      }),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "configuration-required",
  );
  // A missing credential is a configuration failure, never an anonymous call.
  assert.throws(
    () => defaultAuthorizationHook({ kind: "oauth2", material: {} }),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "configuration-required",
  );
});

test("a host-supplied credential hook replaces the default without touching anything else", async (t) => {
  const read = await readFixtureConnector();
  const fixture = await startHttpFixture(() => ({ body: { regions: [] } }));
  t.after(() => fixture.close());
  const { ports, environment } = portsWithFetch(fixture.origin);
  const binding = buildMicrosoftBinding({
    origin: fixture.origin,
    pathPrefix: "/v1",
    operations: read.dynamicOperations,
    dynamicFields: read.dynamicFields,
    authentication: { kind: "oauth2" },
  });
  const actor = actorFor("tenant-a", "subject-1");
  const connection = await connectedPrincipal({
    ports,
    binding,
    actor,
    apiKey: "opaque-broker-reference",
  });

  const seen: string[] = [];
  const hook: MicrosoftAuthorizationHook = (request) => {
    seen.push(request.kind);
    // The material is opened inside custody and never returned to the caller.
    assert.equal(request.material.value, "opaque-broker-reference");
    return { headers: { authorization: "Bearer exchanged-by-the-oauth-profile" } };
  };
  const adapter = createMicrosoftCustomConnectorAdapter({ authorization: hook });
  const result = await adapter.invoke!(
    adapterContext({ actor, binding, connection, environment }),
    {
      operationRef: "msdyn:GetRegions",
      input: { contractId: REGION_CONTRACT, values: { projectId: "proj-1" } },
      commandId: "command-1",
    },
  );

  assert.equal(result.state, "complete");
  assert.deepEqual(seen, ["oauth2"]);
  const received = fixture.received("GET", "/v1/projects/proj-1/regions");
  assert.equal(
    received[0]?.headers.authorization,
    "Bearer exchanged-by-the-oauth-profile",
  );
  // The credential never travels back out in the result.
  assert.ok(!JSON.stringify(result).includes("opaque-broker-reference"));
});

test("an invocation without a connection is a configuration failure, not an anonymous call", async (t) => {
  const read = await readFixtureConnector();
  const fixture = await startHttpFixture(() => ({ body: { regions: [] } }));
  t.after(() => fixture.close());
  const { environment } = portsWithFetch(fixture.origin);
  const binding = buildMicrosoftBinding({
    origin: fixture.origin,
    pathPrefix: "/v1",
    operations: read.dynamicOperations,
    dynamicFields: read.dynamicFields,
    authentication: {
      kind: "api-key",
      placement: "header",
      parameterName: "X-Api-Key",
    },
  });
  const adapter = createMicrosoftCustomConnectorAdapter();
  await assert.rejects(
    adapter.invoke!(
      adapterContext({
        actor: actorFor("tenant-a", "subject-1"),
        binding,
        environment,
      }),
      {
        operationRef: "msdyn:GetRegions",
        input: { contractId: REGION_CONTRACT, values: { projectId: "proj-1" } },
        commandId: "command-1",
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.code, "configuration-required");
      return true;
    },
  );
  assert.equal(fixture.requests.length, 0);
});

test("binding settings a host did not write are refused", async (t) => {
  const fixture = await startHttpFixture(() => ({ body: {} }));
  t.after(() => fixture.close());
  const { environment } = portsWithFetch(fixture.origin);
  const binding = buildMicrosoftBinding({ origin: fixture.origin, operations: [] });
  // A settings block that does not parse is a binding fault, not a caller one.
  const broken = { ...binding, settings: { dynamicFields: "not-an-array" } };
  const adapter = createMicrosoftCustomConnectorAdapter();
  await assert.rejects(
    adapter.invoke!(
      adapterContext({
        actor: actorFor("tenant-a", "subject-1"),
        binding: broken,
        environment,
      }),
      { operationRef: "msdyn:GetRegions", input: {}, commandId: "c" },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.detail, "microsoft.binding.settings-invalid");
      return true;
    },
  );
});

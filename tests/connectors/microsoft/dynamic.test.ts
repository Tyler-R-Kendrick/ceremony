import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { createMicrosoftCustomConnectorAdapter } from "../../../src/server/connectors/formats/microsoft/adapter.js";
import { dynamicFieldUiContracts } from "../../../src/server/connectors/formats/microsoft/export.js";
import { readCustomConnector } from "../../../src/server/connectors/formats/microsoft/read.js";
import type { DynamicOptionsResult } from "../../../src/server/connectors/formats/microsoft/dynamic.js";
import { startHttpFixture } from "../doubles/http-fixture.js";
import {
  actorFor,
  adapterContext,
  apiPropertiesFixture,
  buildMicrosoftBinding,
  canaries,
  connectedPrincipal,
  contractById,
  operationByRef,
  portsWithFetch,
  readFixtureConnector,
  settingsFixture,
  swaggerFixture,
} from "./support.js";

/*
 * MS-02 and AC-EXT-10. A dynamic field is a description until a host approves
 * it; then it is a server-side read, executed with the current principal's
 * connection credentials, bounded, sanitized and cached per connection
 * generation. None of it is ever an unauthenticated browser fetch.
 */

/** Built at runtime: a formatter rewrites these escapes into literal bytes. */
const NUL = String.fromCharCode(0);
const RIGHT_TO_LEFT_OVERRIDE = String.fromCharCode(0x202e);

const REGION_CONTRACT = "list:CreateItem:body:payload/region";
const PROJECT_CONTRACT = "values:CreateItem:path:projectId";
const SCHEMA_CONTRACT = "properties:CreateItem:body:payload/details";

test("dynamic values and dynamic lists compile into contracts with typed parameter binding", async () => {
  const read = await readFixtureConnector();
  const projects = contractById(read.dynamicFields, PROJECT_CONTRACT);
  assert.equal(projects.kind, "values");
  assert.equal(projects.extension, "x-ms-dynamic-values");
  assert.equal(projects.operationId, "GetProjects");
  assert.equal(projects.operation?.operationRef, "msdyn:GetProjects");
  assert.deepEqual(projects.selection, {
    collection: "value",
    value: "name",
    title: "properties/displayName",
  });
  assert.equal(projects.executable, true);
  assert.deepEqual(projects.parameters, []);

  const regions = contractById(read.dynamicFields, REGION_CONTRACT);
  assert.equal(regions.extension, "x-ms-dynamic-list");
  assert.deepEqual(regions.selection, {
    collection: "regions",
    value: "code",
    title: "label",
  });
  assert.deepEqual(regions.parameters, [
    {
      target: "projectId",
      source: "parameter",
      reference: "projectId",
      resolved: true,
    },
  ]);
  // The newer extension wins when a field declares both forms, so a UI never
  // renders the same field twice.
  const older = contractById(
    read.dynamicFields,
    "values:CreateItem:body:payload/region",
  );
  assert.equal(older.preferred, false);
  assert.equal(regions.preferred, true);

  // A dynamic schema keeps its static input and its parameter reference.
  const details = contractById(read.dynamicFields, SCHEMA_CONTRACT);
  assert.equal(details.kind, "properties");
  assert.equal(details.selection.value, "schema");
  assert.deepEqual(
    details.parameters.find((parameter) => parameter.source === "static"),
    { target: "version", source: "static", value: "2.0" },
  );
});

test("a dynamic list may depend on a field that is itself filled by a dynamic value", async () => {
  const read = await readFixtureConnector();
  const regions = contractById(read.dynamicFields, REGION_CONTRACT);
  const dependency = regions.parameters.find(
    (parameter) => parameter.source === "parameter",
  );
  assert.equal(
    dependency?.source === "parameter" ? dependency.reference : undefined,
    "projectId",
  );
  // projectId is the field the first dynamic lookup fills.
  const projects = contractById(read.dynamicFields, PROJECT_CONTRACT);
  assert.equal(projects.field.name, "projectId");
  assert.equal(projects.field.location, "path");

  const ui = dynamicFieldUiContracts(read.dynamicFields);
  const regionUi = ui.find((contract) => contract.id === REGION_CONTRACT);
  assert.deepEqual(regionUi?.dependsOn, ["projectId"]);
  const projectUi = ui.find((contract) => contract.id === PROJECT_CONTRACT);
  assert.deepEqual(projectUi?.dependsOn, []);
});

test("dynamic operations compile into read-only candidates classified personal", async () => {
  const read = await readFixtureConnector();
  const regions = operationByRef(read.dynamicOperations, "msdyn:GetRegions");
  assert.deepEqual(regions.transport, {
    kind: "http",
    method: "GET",
    // basePath belongs on the wire, the `paths` key does not carry it.
    pathTemplate: "/v1/projects/{projectId}/regions",
  });
  assert.equal(regions.effect, "read");
  assert.equal(regions.replay, "read-only");
  assert.equal(regions.consent, "none");
  // A list of an account's projects is not public data.
  assert.equal(regions.outputClassification, "personal");
  assert.deepEqual(regions.targetParameters, ["projectId"]);
  assert.equal(regions.destinationId, "api");
});

test("a dynamic reference to an operation the document does not declare is refused", async () => {
  const swagger = swaggerFixture() as Record<string, unknown>;
  const paths = swagger.paths as Record<
    string,
    Record<string, Record<string, unknown>>
  >;
  const create = paths["/projects/{projectId}/items"]?.post;
  const parameters = create?.parameters as Array<Record<string, unknown>>;
  (parameters[0] as { "x-ms-dynamic-values": { operationId: string } })[
    "x-ms-dynamic-values"
  ].operationId = "NoSuchOperation";
  const read = await readCustomConnector({
    swagger,
    apiProperties: apiPropertiesFixture(),
    settings: settingsFixture(),
  });
  const issue = read.issues.find(
    (item) => item.code === "structure.dynamic-operation-unknown",
  );
  assert.equal(issue?.severity, "warning");
  assert.equal(issue?.disposition, "unsupported");
  const contract = contractById(read.dynamicFields, PROJECT_CONTRACT);
  assert.equal(contract.executable, false);
  assert.deepEqual(contract.blockedBy, ["structure.dynamic-operation-unknown"]);
  assert.equal(contract.operation, undefined);
  // Nothing unresolvable becomes a bound-operation candidate.
  assert.ok(
    !read.dynamicOperations.some((item) => item.nativeId === "NoSuchOperation"),
  );
});

test("an unresolved parameter reference is reported and blocks the contract", async () => {
  const swagger = swaggerFixture() as Record<string, unknown>;
  const paths = swagger.paths as Record<
    string,
    Record<string, Record<string, unknown>>
  >;
  const create = paths["/projects/{projectId}/items"]?.post;
  const parameters = create?.parameters as Array<Record<string, unknown>>;
  const body = parameters[1] as {
    schema: { properties: { region: Record<string, unknown> } };
  };
  (
    body.schema.properties.region["x-ms-dynamic-list"] as {
      parameters: Record<string, unknown>;
    }
  ).parameters = { projectId: { parameterReference: "notAParameter" } };
  const read = await readCustomConnector({
    swagger,
    apiProperties: apiPropertiesFixture(),
    settings: settingsFixture(),
  });
  const issue = read.issues.find(
    (item) => item.code === "structure.dynamic-reference-unresolved",
  );
  assert.ok(issue, "the unresolved reference is reported");
  assert.match(issue?.message ?? "", /parameterReference/);
  const contract = contractById(read.dynamicFields, REGION_CONTRACT);
  assert.equal(contract.executable, false);
});

test("the adapter runs an approved lookup server-side with the caller's credentials", async (t) => {
  const read = await readFixtureConnector();
  const fixture = await startHttpFixture((request) => {
    if (request.url.pathname === "/v1/projects/proj-1/regions")
      return {
        body: {
          regions: [
            { code: "eu-west", label: "Europe West" },
            { code: "us-east", label: "US East" },
          ],
        },
      };
    return undefined;
  });
  t.after(() => fixture.close());

  const { ports, environment } = portsWithFetch(fixture.origin);
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
  const actor = actorFor("tenant-a", "subject-1");
  const connection = await connectedPrincipal({
    ports,
    binding,
    actor,
    apiKey: "key-for-subject-1",
  });
  const adapter = createMicrosoftCustomConnectorAdapter();
  const result = await adapter.invoke!(
    adapterContext({ actor, binding, connection, environment }),
    {
      operationRef: "msdyn:GetRegions",
      input: { contractId: REGION_CONTRACT, values: { projectId: "proj-1" } },
      commandId: "command-1",
    },
  );

  assert.equal(result.state, "complete");
  assert.equal(result.effect, "read");
  assert.equal(result.outputClassification, "personal");
  const output = result.output as DynamicOptionsResult;
  assert.deepEqual(output.options, [
    { value: "eu-west", title: "Europe West" },
    { value: "us-east", title: "US East" },
  ]);
  assert.equal(output.cached, false);

  // The request is the one the description and the binding describe, and it
  // carries the connection's credential — the browser never sees it.
  const received = fixture.received("GET", "/v1/projects/proj-1/regions");
  assert.equal(received.length, 1);
  assert.equal(received[0]?.headers["x-api-key"], "key-for-subject-1");
});

test("the caller cannot name a contract or an operation the binding has not approved", async (t) => {
  const read = await readFixtureConnector();
  const fixture = await startHttpFixture(() => ({ body: { regions: [] } }));
  t.after(() => fixture.close());
  const { ports, environment } = portsWithFetch(fixture.origin);
  const binding = buildMicrosoftBinding({
    origin: fixture.origin,
    pathPrefix: "/v1",
    operations: read.dynamicOperations,
    // The host approved no dynamic field contracts.
    dynamicFields: [],
    authentication: {
      kind: "api-key",
      placement: "header",
      parameterName: "X-Api-Key",
    },
  });
  const actor = actorFor("tenant-a", "subject-1");
  const connection = await connectedPrincipal({
    ports,
    binding,
    actor,
    apiKey: "k",
  });
  const adapter = createMicrosoftCustomConnectorAdapter();
  const ctx = adapterContext({ actor, binding, connection, environment });

  await assert.rejects(
    adapter.invoke!(ctx, {
      operationRef: "msdyn:GetRegions",
      input: { contractId: REGION_CONTRACT, values: { projectId: "proj-1" } },
      commandId: "command-1",
    }),
    (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.code, "denied");
      assert.equal(error.detail, "microsoft.dynamic.unapproved");
      return true;
    },
  );
  await assert.rejects(
    adapter.invoke!(ctx, {
      operationRef: "msdyn:NotApproved",
      input: { contractId: REGION_CONTRACT },
      commandId: "command-2",
    }),
    (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.code, "denied");
      assert.equal(error.detail, "microsoft.operation.unapproved");
      return true;
    },
  );
  assert.equal(fixture.requests.length, 0, "nothing was sent upstream");
});

test("a target parameter outside the connection's permitted targets is denied", async (t) => {
  const read = await readFixtureConnector();
  const fixture = await startHttpFixture(() => ({ body: { regions: [] } }));
  t.after(() => fixture.close());
  const { ports, environment } = portsWithFetch(fixture.origin);
  const binding = buildMicrosoftBinding({
    origin: fixture.origin,
    pathPrefix: "/v1",
    operations: read.dynamicOperations,
    dynamicFields: read.dynamicFields,
    permittedTargets: [{ kind: "project", id: "proj-1" }],
    authentication: {
      kind: "api-key",
      placement: "header",
      parameterName: "X-Api-Key",
    },
  });
  const actor = actorFor("tenant-a", "subject-1");
  const connection = await connectedPrincipal({
    ports,
    binding,
    actor,
    apiKey: "k",
  });
  const adapter = createMicrosoftCustomConnectorAdapter();
  await assert.rejects(
    adapter.invoke!(
      adapterContext({ actor, binding, connection, environment }),
      {
        operationRef: "msdyn:GetRegions",
        input: {
          contractId: REGION_CONTRACT,
          values: { projectId: "someone-elses" },
        },
        commandId: "command-1",
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.code, "denied");
      assert.equal(error.detail, "microsoft.target.not-permitted");
      return true;
    },
  );
  assert.equal(fixture.requests.length, 0);
});

test("an upstream denial is reported without leaking the response body", async (t) => {
  const read = await readFixtureConnector();
  const fixture = await startHttpFixture(() => ({
    status: 403,
    body: {
      error: "forbidden",
      detail: `This account may not list regions: ${canaries.upstreamBody}`,
    },
  }));
  t.after(() => fixture.close());
  const { ports, environment } = portsWithFetch(fixture.origin);
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
  const actor = actorFor("tenant-a", "subject-1");
  const connection = await connectedPrincipal({
    ports,
    binding,
    actor,
    apiKey: "k",
  });
  const adapter = createMicrosoftCustomConnectorAdapter();
  const result = await adapter.invoke!(
    adapterContext({ actor, binding, connection, environment }),
    {
      operationRef: "msdyn:GetRegions",
      input: { contractId: REGION_CONTRACT, values: { projectId: "proj-1" } },
      commandId: "command-1",
    },
  );
  assert.equal(result.state, "denied");
  assert.equal(result.code, "microsoft.dynamic.forbidden");
  assert.equal(result.output, undefined);
  assert.ok(!JSON.stringify(result).includes(canaries.upstreamBody));
});

test("hostile option titles are sanitized and option values are bounded", async (t) => {
  const read = await readFixtureConnector();
  const overLong = "x".repeat(2000);
  const fixture = await startHttpFixture(() => ({
    body: {
      regions: [
        {
          code: "eu-west",
          label: `<img src=x onerror=alert(1)>Europe${NUL} West${RIGHT_TO_LEFT_OVERRIDE}`,
        },
        { code: overLong, label: "Too long to be a value" },
        { code: { nested: "object" }, label: "Not a primitive" },
        { code: "ok", label: { also: "not text" } },
      ],
    },
  }));
  t.after(() => fixture.close());
  const { ports, environment } = portsWithFetch(fixture.origin);
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
  const actor = actorFor("tenant-a", "subject-1");
  const connection = await connectedPrincipal({
    ports,
    binding,
    actor,
    apiKey: "k",
  });
  const adapter = createMicrosoftCustomConnectorAdapter();
  const result = await adapter.invoke!(
    adapterContext({ actor, binding, connection, environment }),
    {
      operationRef: "msdyn:GetRegions",
      input: { contractId: REGION_CONTRACT, values: { projectId: "proj-1" } },
      commandId: "command-1",
    },
  );
  const output = result.output as DynamicOptionsResult;
  assert.equal(output.options[0]?.value, "eu-west");
  // Markup, control characters and bidirectional overrides are gone.
  assert.equal(output.options[0]?.title, "Europe West");
  assert.ok(!output.options[0]?.title.includes("<"));
  assert.ok(!/\p{Cc}|\p{Cf}/u.test(output.options[0]?.title ?? ""));
  // An over-long value and a non-primitive value are dropped, not truncated
  // into something the form would submit.
  assert.ok(!output.options.some((option) => option.value === overLong));
  assert.ok(output.options.every((option) => typeof option.value !== "object"));
  assert.equal(output.dropped, 2);
  // A non-text title falls back to the value rather than rendering "[object Object]".
  const fallback = output.options.find((option) => option.value === "ok");
  assert.equal(fallback?.title, "ok");
});

test("more options than the limit are bounded and reported as truncated", async (t) => {
  const read = await readFixtureConnector();
  const fixture = await startHttpFixture(() => ({
    body: {
      regions: Array.from({ length: 900 }, (_item, index) => ({
        code: `region-${index}`,
        label: `Region ${index}`,
      })),
    },
  }));
  t.after(() => fixture.close());
  const { ports, environment } = portsWithFetch(fixture.origin);
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
  const actor = actorFor("tenant-a", "subject-1");
  const connection = await connectedPrincipal({
    ports,
    binding,
    actor,
    apiKey: "k",
  });
  const adapter = createMicrosoftCustomConnectorAdapter();
  const result = await adapter.invoke!(
    adapterContext({ actor, binding, connection, environment }),
    {
      operationRef: "msdyn:GetRegions",
      input: { contractId: REGION_CONTRACT, values: { projectId: "proj-1" } },
      commandId: "command-1",
    },
  );
  const output = result.output as DynamicOptionsResult;
  assert.equal(output.options.length, 500);
  assert.equal(output.truncated, true);
});

test("cached options never cross principals or survive a generation change", async (t) => {
  const read = await readFixtureConnector();
  const fixture = await startHttpFixture((request) => {
    const key = request.headers["x-api-key"];
    return {
      body: {
        regions: [{ code: `region-of-${key}`, label: `Region of ${key}` }],
      },
    };
  });
  t.after(() => fixture.close());

  const { ports, environment } = portsWithFetch(fixture.origin);
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
  const invoke = async (
    actor: ReturnType<typeof actorFor>,
    connection: Awaited<ReturnType<typeof connectedPrincipal>>,
  ) =>
    adapter.invoke!(
      adapterContext({
        actor,
        binding,
        connection,
        environment,
        generation: connection.generation,
      }),
      {
        operationRef: "msdyn:GetRegions",
        input: { contractId: REGION_CONTRACT, values: { projectId: "proj-1" } },
        commandId: `command-${actor.subjectId}-${connection.generation}`,
      },
    );

  const alice = actorFor("tenant-a", "subject-alice");
  const aliceConnection = await connectedPrincipal({
    ports,
    binding,
    actor: alice,
    apiKey: "key-alice",
  });
  const bob = actorFor("tenant-b", "subject-bob");
  const bobConnection = await connectedPrincipal({
    ports,
    binding,
    actor: bob,
    apiKey: "key-bob",
  });

  const first = await invoke(alice, aliceConnection);
  const firstOutput = first.output as DynamicOptionsResult;
  assert.equal(firstOutput.options[0]?.value, "region-of-key-alice");
  assert.equal(firstOutput.cached, false);

  // Alice again: served from her own cache, no second upstream call.
  const repeat = await invoke(alice, aliceConnection);
  assert.equal((repeat.output as DynamicOptionsResult).cached, true);
  assert.equal(fixture.requests.length, 1);

  // Bob asks the identical question. He must never see Alice's list.
  const other = await invoke(bob, bobConnection);
  const otherOutput = other.output as DynamicOptionsResult;
  assert.equal(otherOutput.options[0]?.value, "region-of-key-bob");
  assert.equal(otherOutput.cached, false);
  assert.equal(fixture.requests.length, 2);

  // A reconnect advances the generation, and the old cache cannot answer for it.
  const reconnected = {
    ...aliceConnection,
    generation: aliceConnection.generation + 1,
  };
  const afterReconnect = await invoke(alice, reconnected);
  assert.equal((afterReconnect.output as DynamicOptionsResult).cached, false);
  assert.equal(fixture.requests.length, 3);
});

test("a stale generation is refused before any upstream call", async (t) => {
  const read = await readFixtureConnector();
  const fixture = await startHttpFixture(() => ({ body: { regions: [] } }));
  t.after(() => fixture.close());
  const { ports, environment } = portsWithFetch(fixture.origin);
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
  const actor = actorFor("tenant-a", "subject-1");
  const connection = await connectedPrincipal({
    ports,
    binding,
    actor,
    apiKey: "k",
    generation: 2,
  });
  const adapter = createMicrosoftCustomConnectorAdapter();
  await assert.rejects(
    adapter.invoke!(
      adapterContext({
        actor,
        binding,
        connection,
        environment,
        generation: 3,
      }),
      {
        operationRef: "msdyn:GetRegions",
        input: { contractId: REGION_CONTRACT, values: { projectId: "proj-1" } },
        commandId: "command-1",
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.code, "conflict");
      return true;
    },
  );
  assert.equal(fixture.requests.length, 0);
});

test("a dynamic schema lookup returns a bounded, cleaned schema", async (t) => {
  const read = await readFixtureConnector();
  const fixture = await startHttpFixture((request) => {
    if (request.url.pathname === "/v1/projects/proj-1/schema")
      return {
        body: {
          schema: {
            type: "object",
            properties: {
              [`owner${NUL}Name`]: {
                type: "string",
                title: `Owner${RIGHT_TO_LEFT_OVERRIDE}Name`,
              },
            },
          },
        },
      };
    return undefined;
  });
  t.after(() => fixture.close());
  const { ports, environment } = portsWithFetch(fixture.origin);
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
  const actor = actorFor("tenant-a", "subject-1");
  const connection = await connectedPrincipal({
    ports,
    binding,
    actor,
    apiKey: "k",
  });
  const adapter = createMicrosoftCustomConnectorAdapter();
  const result = await adapter.invoke!(
    adapterContext({ actor, binding, connection, environment }),
    {
      operationRef: "msdyn:GetItemSchema",
      input: { contractId: SCHEMA_CONTRACT, values: { projectId: "proj-1" } },
      commandId: "command-1",
    },
  );
  assert.equal(result.state, "complete");
  const output = result.output as { kind: string; schema: unknown };
  assert.equal(output.kind, "schema");
  const serialized = JSON.stringify(output.schema);
  assert.ok(!/\p{Cc}|\p{Cf}/u.test(serialized));
  assert.match(serialized, /ownerName/);

  // The static parameter documented on the extension is sent as written.
  const received = fixture.received("GET", "/v1/projects/proj-1/schema");
  assert.equal(received[0]?.url.searchParams.get("version"), "2.0");
});

test("a dynamic field on a hidden privileged input still classifies its output as personal", async (t) => {
  const swagger = swaggerFixture() as Record<string, unknown>;
  const paths = swagger.paths as Record<
    string,
    Record<string, Record<string, unknown>>
  >;
  const parameters = paths["/projects/{projectId}/items"]?.post
    ?.parameters as Array<Record<string, unknown>>;
  const body = parameters[1] as {
    schema: { properties: { apiSecret: Record<string, unknown> } };
  };
  // An internal, password-shaped field that also offers a dynamic list.
  body.schema.properties.apiSecret["x-ms-dynamic-list"] = {
    operationId: "GetProjects",
    itemsPath: "value",
    itemValuePath: "name",
    itemTitlePath: "properties/displayName",
    parameters: {},
  };
  const read = await readCustomConnector({
    swagger,
    apiProperties: apiPropertiesFixture(),
    settings: settingsFixture(),
  });
  const contract = contractById(
    read.dynamicFields,
    "list:CreateItem:body:payload/apiSecret",
  );
  // Visibility travels as presentation, and never as authorization.
  assert.equal(contract.visibility, "internal");
  const operation = operationByRef(read.dynamicOperations, "msdyn:GetProjects");
  assert.equal(operation.outputClassification, "personal");
  assert.equal(operation.consent, "none");

  const ui = dynamicFieldUiContracts(read.dynamicFields);
  const hidden = ui.find(
    (item) => item.id === "list:CreateItem:body:payload/apiSecret",
  );
  assert.equal(hidden?.visibility, "internal");

  // A host that did not approve this contract cannot have it executed.
  const fixture = await startHttpFixture(() => ({ body: { value: [] } }));
  t.after(() => fixture.close());
  const { ports, environment } = portsWithFetch(fixture.origin);
  const binding = buildMicrosoftBinding({
    origin: fixture.origin,
    pathPrefix: "/v1",
    operations: read.dynamicOperations,
    dynamicFields: read.dynamicFields.filter(
      (item) => item.id !== "list:CreateItem:body:payload/apiSecret",
    ),
    authentication: {
      kind: "api-key",
      placement: "header",
      parameterName: "X-Api-Key",
    },
  });
  const actor = actorFor("tenant-a", "subject-1");
  const connection = await connectedPrincipal({
    ports,
    binding,
    actor,
    apiKey: "k",
  });
  const adapter = createMicrosoftCustomConnectorAdapter();
  await assert.rejects(
    adapter.invoke!(
      adapterContext({ actor, binding, connection, environment }),
      {
        operationRef: "msdyn:GetProjects",
        input: { contractId: "list:CreateItem:body:payload/apiSecret" },
        commandId: "command-1",
      },
    ),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "denied",
  );
  assert.equal(fixture.requests.length, 0);
});

test("a cancelled call never reaches the provider", async (t) => {
  const read = await readFixtureConnector();
  const fixture = await startHttpFixture(() => ({ body: { regions: [] } }));
  t.after(() => fixture.close());
  const { ports, environment } = portsWithFetch(fixture.origin);
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
  const actor = actorFor("tenant-a", "subject-1");
  const connection = await connectedPrincipal({
    ports,
    binding,
    actor,
    apiKey: "k",
  });
  const adapter = createMicrosoftCustomConnectorAdapter();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    adapter.invoke!(
      adapterContext({
        actor,
        binding,
        connection,
        environment,
        signal: controller.signal,
      }),
      {
        operationRef: "msdyn:GetRegions",
        input: { contractId: REGION_CONTRACT, values: { projectId: "proj-1" } },
        commandId: "command-1",
      },
    ),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "cancelled",
  );
  assert.equal(fixture.requests.length, 0);
});

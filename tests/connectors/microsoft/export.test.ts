import assert from "node:assert/strict";
import test from "node:test";
import {
  dynamicFieldUiContracts,
  exportCustomConnector,
} from "../../../src/server/connectors/formats/microsoft/export.js";
import { readCustomConnector } from "../../../src/server/connectors/formats/microsoft/read.js";
import {
  apiPropertiesFixture,
  buildMicrosoftBinding,
  canaries,
  fixtureJson,
  readFixtureConnector,
  settingsFixture,
  swaggerFixture,
} from "./support.js";

/*
 * MS-05. The export writes back the supported profile: the operations a
 * binding approved, the extensions the source actually carried, and a loss
 * report for everything a description cannot reproduce. The two things it must
 * never do are invent an extension the source did not have and lose something
 * without saying so.
 */

type Json = Record<string, unknown>;

const exported = async () => {
  const read = await readFixtureConnector();
  const binding = buildMicrosoftBinding({
    origin: "https://api.contoso.example",
    pathPrefix: "/v1",
    operations: [
      ...read.dynamicOperations,
      ...(read.verifierOperation ? [read.verifierOperation] : []),
    ],
  });
  return { read, binding, result: exportCustomConnector(read.definition, binding) };
};

test("the export is a Swagger 2.0 document bounded to the approved operations", async () => {
  const { read, result } = await exported();
  const document = result.document;
  assert.equal(document.swagger, "2.0");
  assert.deepEqual(document.info, {
    title: "Contoso Projects",
    version: "2026-09-01",
    description: "Creates and tracks work items inside a Contoso project.",
  });
  // Host and base path come from the binding's approved destination.
  assert.equal(document.host, "api.contoso.example");
  assert.deepEqual(document.schemes, ["https"]);
  assert.equal(document.basePath, "/v1");

  const paths = document.paths as Json;
  // Exactly the operations the binding approved: three dynamic lookups and the
  // connection test. CreateItem was blocked by policy and was never bound.
  assert.deepEqual(Object.keys(paths).sort(), [
    "/me",
    "/projects",
    "/projects/{projectId}/regions",
    "/projects/{projectId}/schema",
  ]);
  const omitted = result.losses.filter(
    (loss) => loss.code === "policy.operation-not-bound",
  );
  assert.ok(
    omitted.some((loss) => loss.message.includes("CreateItem")),
    "an unbound operation is reported, not silently dropped",
  );
  assert.ok(omitted.every((loss) => loss.severity === "info"));
  assert.ok(read.definition.capabilities.length > Object.keys(paths).length);

  // The exported bytes are the document.
  assert.equal(result.mediaType, "application/json");
  assert.deepEqual(
    JSON.parse(Buffer.from(result.bytes).toString("utf8")),
    document,
  );
});

test("security definitions are re-emitted exactly as the source declared them", async () => {
  const { result } = await exported();
  assert.deepEqual(result.document.securityDefinitions, {
    api_key: { type: "apiKey", in: "header", name: "X-Api-Key" },
  });
  assert.deepEqual(result.document.security, [{ api_key: [] }]);
  // The OAuth profile came from apiProperties.json, not from a security
  // definition, so no security definition is invented for it.
  assert.equal(
    Object.keys(result.document.securityDefinitions as Json).length,
    1,
  );
});

test("preserved extensions are placed back on the node they came from", async () => {
  const { result } = await exported();
  // Document level.
  assert.deepEqual(result.document["x-ms-capabilities"], {
    testConnection: { operationId: "WhoAmI", parameters: {} },
  });
  assert.ok(Array.isArray(result.document["x-ms-connector-metadata"]));

  const paths = result.document.paths as Record<string, Json>;
  const regions = paths["/projects/{projectId}/regions"]?.get as Json;
  assert.equal(regions.operationId, "GetRegions");
  // Operation-level x-ms-visibility travels on the operation.
  assert.equal(regions["x-ms-visibility"], "internal");
  const schema = paths["/projects/{projectId}/schema"]?.get as Json;
  const parameters = schema.parameters as Json[];
  const version = parameters.find((parameter) => parameter.name === "version");
  assert.equal(version?.["x-ms-visibility"], "internal");
  assert.equal(version?.in, "query");
});

test("the export invents no extension the source did not carry", async () => {
  const { result } = await exported();
  const source = swaggerFixture() as Json;
  const sourceNames = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, item] of Object.entries(value)) {
      if (key.startsWith("x-")) sourceNames.add(key);
      walk(item);
    }
  };
  walk(source);

  const exportedNames = new Set<string>();
  const walkExported = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walkExported);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, item] of Object.entries(value)) {
      if (key.startsWith("x-")) exportedNames.add(key);
      walkExported(item);
    }
  };
  walkExported(result.document);

  for (const name of exportedNames)
    assert.ok(sourceNames.has(name), `${name} was present in the source`);
});

test("losses name every construct the description cannot reproduce", async () => {
  const { result } = await exported();
  const codes = new Set(result.losses.map((loss) => loss.code));
  // Schemas live in the protected artifact, not in the description.
  assert.ok(codes.has("schema.response-not-preserved"));
  // apiProperties is a separate file and no credential ever leaves in an export.
  assert.ok(codes.has("structure.api-properties-not-exported"));
  const apiProperties = result.losses.find(
    (loss) => loss.code === "structure.api-properties-not-exported",
  );
  assert.match(
    apiProperties?.message ?? "",
    /no credential, client secret or connection value ever leaves in an export/,
  );
  // Policy instances change behaviour and are reported as a difference.
  const policy = result.losses.find(
    (loss) => loss.code === "policy.templates-not-exported",
  );
  assert.equal(policy?.category, "policy");
  assert.equal(policy?.disposition, "unsupported");
  assert.match(policy?.message ?? "", /does not behave identically/);
  assert.ok(result.losses.every((loss) => loss.dimension === "export"));
});

test("custom code is reported as an exported behaviour difference", async () => {
  const read = await readCustomConnector({
    swagger: swaggerFixture(),
    apiProperties: fixtureJson("apiProperties.script.json"),
    settings: fixtureJson("settings.script.json"),
  });
  const result = exportCustomConnector(read.definition);
  const loss = result.losses.find(
    (item) => item.code === "executable-code.script-not-exported",
  );
  assert.equal(loss?.category, "executable-code");
  assert.match(loss?.message ?? "", /not carried, executed or exported/);
  assert.ok(!JSON.stringify(result.document).includes(canaries.scriptBody));
});

test("a body schema that the description does not carry is an explicit loss", async () => {
  const read = await readFixtureConnector();
  // Bind CreateItem itself so its body parameter is exported.
  const binding = buildMicrosoftBinding({
    origin: "https://api.contoso.example",
    pathPrefix: "/v1",
    operations: [
      {
        operationRef: "msop:CreateItem",
        nativeId: "CreateItem",
        destinationId: "api",
        transport: {
          kind: "http",
          method: "POST",
          pathTemplate: "/v1/projects/{projectId}/items",
        },
        effect: "write",
        outputClassification: "personal",
        cost: "unknown",
        consent: "confirm",
        replay: "none",
        targetParameters: ["projectId"],
      },
    ],
  });
  const result = exportCustomConnector(read.definition, binding);
  const loss = result.losses.find(
    (item) => item.code === "schema.body-not-preserved",
  );
  assert.equal(loss?.severity, "warning");
  assert.match(loss?.message ?? "", /not a working connector definition/);
  // The dynamic extensions inside that body schema have nowhere to attach, and
  // the export says so rather than dropping them quietly.
  assert.ok(
    result.losses.some((item) => item.code === "schema.body-extensions-unplaced"),
  );
  const paths = result.document.paths as Record<string, Json>;
  const create = paths["/projects/{projectId}/items"]?.post as Json;
  const parameters = create.parameters as Json[];
  const body = parameters.find((parameter) => parameter.in === "body");
  assert.ok(body, "the body parameter is still described");
  assert.equal(body?.schema, undefined);
  // The path parameter keeps its dynamic-values extension, which does attach.
  const projectId = parameters.find((parameter) => parameter.name === "projectId");
  assert.ok(projectId?.["x-ms-dynamic-values"]);
});

test("an export whose host is rebound to the approved destination says so", async () => {
  const read = await readFixtureConnector();
  const binding = buildMicrosoftBinding({
    origin: "https://eu.contoso.example",
    operations: read.dynamicOperations,
  });
  const result = exportCustomConnector(read.definition, binding);
  assert.equal(result.document.host, "eu.contoso.example");
  const loss = result.losses.find((item) => item.code === "network.host-rebound");
  assert.equal(loss?.category, "network");
  assert.match(loss?.message ?? "", /not the host the source declared/);
});

test("no canary from a source default or example survives an export", async () => {
  const { result } = await exported();
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(canaries.parameterDefault));
  assert.ok(!serialized.includes(canaries.responseExample));
});

test("the dynamic-field UI contract matches the fixture the UX surface renders", async () => {
  const read = await readFixtureConnector();
  const contract = fixtureJson("dynamic-field-ui.json") as {
    connector: string;
    fields: unknown[];
  };
  assert.equal(contract.connector, read.definition.identity.nativeId);
  const produced = dynamicFieldUiContracts(read.dynamicFields);
  assert.deepEqual(JSON.parse(JSON.stringify(produced)), contract.fields);

  // A renderer needs the operation, the dependencies and the value/title paths
  // and nothing else: no pointers into the source, no source prose.
  for (const field of produced) {
    assert.ok(field.operationId.length > 0);
    assert.ok(Array.isArray(field.dependsOn));
    assert.ok(!Object.hasOwn(field, "sourcePointer"));
  }
  // Only the preferred form of a doubly-declared field is rendered.
  assert.equal(
    produced.filter((field) => field.field.pathString === "region").length,
    1,
  );
});

test("an export of a description with no connector metadata still reports its losses", async () => {
  const read = await readCustomConnector({
    swagger: swaggerFixture(),
    apiProperties: apiPropertiesFixture(),
    settings: settingsFixture(),
  });
  const stripped = {
    ...read.definition,
    nativeExtensions: {},
  };
  const result = exportCustomConnector(stripped);
  assert.ok(
    result.losses.some(
      (loss) => loss.code === "structure.connector-metadata-missing",
    ),
  );
  // Operations still export from their own preserved shape.
  assert.ok(Object.keys(result.document.paths as Json).length > 0);
  assert.equal(result.document.securityDefinitions, undefined);
});

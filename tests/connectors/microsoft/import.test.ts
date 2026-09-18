import assert from "node:assert/strict";
import test from "node:test";
import {
  agentDefinitionProjection,
  normalizedDefinitionSchema,
  verifyNormalizedDigest,
} from "../../../src/core/connectors/index.js";
import {
  CustomConnectorReadError,
  MICROSOFT_ECOSYSTEM,
  readCustomConnector,
} from "../../../src/server/connectors/formats/microsoft/read.js";
import {
  apiPropertiesFixture,
  canaries,
  readFixtureConnector,
  settingsFixture,
  swaggerFixture,
} from "./support.js";

/*
 * MS-01: what an import of a Power Platform custom connector produces. The
 * assertions here are about a *description*: nothing imported is executable,
 * every connection parameter keeps its native spelling beside the host
 * configuration name it maps to, and a visibility hint stays presentation.
 */

test("imports a custom connector into a normalized definition of its ecosystem", async () => {
  const read = await readFixtureConnector();
  const definition = read.definition;
  assert.equal(definition.identity.ecosystem, MICROSOFT_ECOSYSTEM);
  // The connector id and environment come from settings.json, not the swagger.
  assert.equal(definition.identity.nativeId, "contoso-projects-9f21");
  assert.equal(
    definition.identity.authorityNamespace,
    "Default-00000000-0000-0000-0000-000000000000",
  );
  assert.equal(definition.identity.nativeVersion, "2026-09-01");
  assert.equal(definition.display.name, "Contoso Projects");
  assert.equal(definition.display.ecosystem, MICROSOFT_ECOSYSTEM);
  assert.deepEqual(
    definition.declaredServers.map((server) => server.url),
    ["https://api.contoso.example/v1"],
  );
  assert.equal(definition.declaredServers[0]?.status, "declared");
  // Every operation in the document is described.
  assert.deepEqual(
    definition.capabilities.map((capability) => capability.nativeId).sort(),
    [
      "CreateItem",
      "DeleteSubscription",
      "GetItemSchema",
      "GetProjects",
      "GetRegions",
      "OnItemCreated",
      "OnItemUpdated",
      "WhoAmI",
    ],
  );
  assert.ok(await verifyNormalizedDigest(definition));
  // The description parses under the real contract, including its bounds.
  assert.doesNotThrow(() => normalizedDefinitionSchema.parse(definition));
});

test("a Swagger method is never read as evidence of an operation's effect", async () => {
  const read = await readFixtureConnector();
  const create = read.definition.capabilities.find(
    (capability) => capability.nativeId === "CreateItem",
  );
  assert.equal(create?.effect, "unknown");
  assert.equal(create?.dataClassification, "unknown");
  const get = read.definition.capabilities.find(
    (capability) => capability.nativeId === "GetProjects",
  );
  assert.equal(get?.effect, "unknown");
});

test("connection parameters become configuration requirements with a deterministic name", async () => {
  const read = await readFixtureConnector();
  const byName = new Map(
    read.definition.configuration.map((item) => [item.name, item]),
  );
  // Deterministic uppercase form of each native name.
  assert.equal(read.configurationNames.api_key, "API_KEY");
  assert.equal(
    read.configurationNames.internalSigningKey,
    "INTERNALSIGNINGKEY",
  );
  assert.equal(read.configurationNames.environmentName, "ENVIRONMENTNAME");
  for (const name of byName.keys())
    assert.match(name, /^[A-Z][A-Z0-9_]{0,95}$/, `${name} is a legal name`);

  assert.equal(byName.get("API_KEY")?.classification, "secret");
  assert.equal(byName.get("API_KEY")?.required, true);
  assert.equal(byName.get("ENVIRONMENTNAME")?.classification, "public");

  // An OAuth connection parameter needs a client id and a client secret, and
  // only the secret is classified secret.
  assert.equal(read.configurationNames.token_CLIENT_ID, "TOKEN_CLIENT_ID");
  assert.equal(byName.get("TOKEN_CLIENT_ID")?.classification, "public");
  assert.equal(byName.get("TOKEN_CLIENT_SECRET")?.classification, "secret");
  assert.equal(byName.get("TOKEN_CLIENT_SECRET")?.source, "provider-console");

  // The rename is reported, and the native spelling survives beside it.
  const renames = read.issues.filter(
    (issue) => issue.code === "structure.configuration-name-adapted",
  );
  assert.ok(renames.length >= 3);
  for (const issue of renames) {
    assert.equal(issue.severity, "warning");
    assert.equal(issue.disposition, "adapted");
    assert.equal(issue.executionImpact, "none");
  }
  const record = read.definition.nativeExtensions[
    "microsoft-custom-connector"
  ] as {
    connectionParameters: Array<{
      nativeName: string;
      configurationNames: string[];
      type: string;
    }>;
  };
  const apiKey = record.connectionParameters.find(
    (parameter) => parameter.nativeName === "api_key",
  );
  assert.equal(apiKey?.type, "securestring");
  assert.ok(apiKey?.configurationNames.includes("API_KEY"));
});

test("a hidden securestring stays classified secret and is never exposed by a public projection", async () => {
  const read = await readFixtureConnector();
  const signing = read.definition.configuration.find(
    (item) => item.name === "INTERNALSIGNINGKEY",
  );
  // Hidden in the provider's connection dialog; still a secret here.
  assert.equal(signing?.classification, "secret");
  const record = read.definition.nativeExtensions[
    "microsoft-custom-connector"
  ] as {
    connectionParameters: Array<{ nativeName: string; hidden: boolean }>;
    presentation: { visibility: Record<string, string> };
  };
  assert.equal(
    record.connectionParameters.find(
      (parameter) => parameter.nativeName === "internalSigningKey",
    )?.hidden,
    true,
  );
  // x-ms-visibility is presentation metadata only: it never appears as a
  // classification and never as an authentication or authorization decision.
  assert.equal(record.presentation.visibility.GetProjects, "internal");
  assert.equal(record.presentation.visibility.CreateItem, "important");
  const agent = agentDefinitionProjection(read.definition);
  const projected = JSON.stringify(agent);
  assert.ok(!projected.includes("internalSigningKey"));
  assert.ok(!projected.includes("visibility"));
  // The agent projection carries no configuration values or native extensions.
  assert.ok(!Object.hasOwn(agent, "nativeExtensions"));
  assert.ok(!Object.hasOwn(agent, "configuration"));
});

test("connection parameter sets become alternative authentication profiles", async () => {
  const read = await readFixtureConnector();
  const profiles = read.definition.authentication;
  // The swagger security definition and both parameter sets are all described.
  const apiKeyScheme = profiles.find((profile) => profile.kind === "api-key");
  assert.equal(
    apiKeyScheme?.kind === "api-key" && apiKeyScheme.placement,
    "header",
  );
  assert.equal(
    apiKeyScheme?.kind === "api-key" && apiKeyScheme.parameterName,
    "X-Api-Key",
  );
  const oauth = profiles.find(
    (profile) => profile.kind === "oauth-authorization-code",
  );
  assert.ok(
    oauth,
    "the oauth2 parameter set yields an authorization-code profile",
  );
  assert.equal(
    oauth?.kind === "oauth-authorization-code" && oauth.authorizationEndpoint,
    "https://login.contoso.example/oauth/authorize",
  );
  assert.deepEqual(
    oauth?.kind === "oauth-authorization-code" ? oauth.scopes : [],
    ["projects.read", "items.write"],
  );
  // Which set a profile belongs to is recorded so alternatives group, never merge.
  const record = read.definition.nativeExtensions[
    "microsoft-custom-connector"
  ] as {
    presentation: { profileSets: Record<string, string> };
    connectionParameterSets?: {
      values: Array<{ name: string; allowSharing?: boolean }>;
    };
  };
  assert.equal(record.presentation.profileSets[oauth?.id ?? ""], "oauth2");
  assert.deepEqual(
    record.connectionParameterSets?.values.map((set) => set.name),
    ["api-key", "oauth2"],
  );
  assert.equal(record.connectionParameterSets?.values[1]?.allowSharing, false);
});

test("missing companion metadata is actionable and does not block the import", async () => {
  const read = await readCustomConnector({
    swagger: swaggerFixture(),
    settings: settingsFixture(),
  });
  const issue = read.issues.find(
    (item) => item.code === "structure.incomplete-configuration",
  );
  assert.ok(issue, "a missing apiProperties.json is reported");
  assert.equal(issue?.category, "structure");
  assert.equal(issue?.dimension, "configure");
  assert.equal(issue?.disposition, "requires-configuration");
  assert.equal(issue?.severity, "warning");
  assert.equal(issue?.executionImpact, "none");
  assert.match(issue?.remediation ?? "", /paconn download/);
  // The description still imports, and configure reports what it needs.
  assert.equal(
    read.definition.compatibility.dimensions.configure,
    "requires-configuration",
  );
  assert.ok(read.definition.capabilities.length > 0);
});

test("every x-ms-* extension is preserved with the pointer it was read from", async () => {
  const read = await readFixtureConnector();
  const documentEntries = read.definition.nativeExtensions[
    "x-ms-extensions"
  ] as Array<{
    pointer: string;
    name: string;
    value: unknown;
  }>;
  const capabilities = documentEntries.find(
    (entry) => entry.name === "x-ms-capabilities" && entry.pointer === "#",
  );
  assert.deepEqual(capabilities?.value, {
    testConnection: { operationId: "WhoAmI", parameters: {} },
  });
  const metadata = documentEntries.find(
    (entry) => entry.name === "x-ms-connector-metadata",
  );
  assert.ok(Array.isArray(metadata?.value));

  // Operation-level and parameter-level extensions keep their own nodes so an
  // export can put each one back where it belongs.
  const create = read.definition.capabilities.find(
    (capability) => capability.nativeId === "CreateItem",
  );
  const operationEntries = create?.nativeExtensions?.[
    "x-ms-operation-extensions"
  ] as Array<{ pointer: string; name: string }>;
  assert.ok(
    operationEntries.some((entry) => entry.name === "x-ms-visibility"),
    "x-ms-visibility on the operation is preserved",
  );
  const parameterEntries = create?.nativeExtensions?.[
    "x-ms-parameter-extensions"
  ] as Array<{ parameter: string; pathString: string; name: string }>;
  assert.ok(
    parameterEntries.some(
      (entry) =>
        entry.parameter === "projectId" && entry.name === "x-ms-dynamic-values",
    ),
  );
  assert.ok(
    parameterEntries.some(
      (entry) =>
        entry.parameter === "payload" &&
        entry.pathString === "region" &&
        entry.name === "x-ms-dynamic-list",
    ),
    "an extension inside a body schema keeps its path string",
  );
  const trigger = read.definition.capabilities.find(
    (capability) => capability.nativeId === "OnItemCreated",
  );
  const pathEntries = trigger?.nativeExtensions?.[
    "x-ms-path-extensions"
  ] as Array<{
    name: string;
    pointer: string;
  }>;
  assert.ok(
    pathEntries.some((entry) => entry.name === "x-ms-notification-content"),
    "a Path Item extension is preserved against the Path Item, not the operation",
  );
  assert.ok(pathEntries.every((entry) => !entry.pointer.endsWith("/post")));
});

test("webhook and polling triggers become distinct event descriptors", async () => {
  const read = await readFixtureConnector();
  const byId = new Map(
    read.definition.events.map((event) => [event.nativeId, event]),
  );

  const webhook = byId.get("OnItemCreated");
  assert.equal(webhook?.transport, "http-webhook");
  // The receiver is not trusted until a host approves it.
  assert.equal(webhook?.verification, "unknown");
  assert.equal(
    webhook?.messageSchemaRef,
    "#/definitions/ItemCreatedNotification",
  );
  assert.ok(
    read.issues.some(
      (issue) =>
        issue.code === "structure.webhook-receiver-review" &&
        issue.dimension === "events",
    ),
  );

  const polling = byId.get("OnItemUpdated");
  assert.equal(polling?.transport, "unsupported");
  assert.equal(polling?.nativeTransport, "polling");
  const blocked = read.issues.find(
    (issue) => issue.code === "structure.polling-trigger-unsupported",
  );
  assert.equal(blocked?.severity, "blocking");
  assert.equal(blocked?.executionImpact, "blocks-operation");
  assert.match(blocked?.message ?? "", /Location header|trigger state/);
  assert.ok(
    read.blocked.OnItemUpdated?.includes(
      "structure.polling-trigger-unsupported",
    ),
  );
  // The webhook trigger is not blocked by the polling diagnostic.
  assert.ok(
    !read.blocked.OnItemCreated?.includes(
      "structure.polling-trigger-unsupported",
    ),
  );
});

test("a secret-bearing default or example never reaches the description", async () => {
  const read = await readFixtureConnector();
  const serialized = JSON.stringify(read.definition);
  assert.ok(!serialized.includes(canaries.parameterDefault));
  assert.ok(!serialized.includes(canaries.responseExample));
  for (const issue of read.issues) {
    assert.ok(!issue.message.includes(canaries.parameterDefault));
    assert.ok(!(issue.remediation ?? "").includes(canaries.parameterDefault));
  }
  // The field is still described as present and required-shaped, without its value.
  const create = read.definition.capabilities.find(
    (capability) => capability.nativeId === "CreateItem",
  );
  const record = create?.nativeExtensions?.["microsoft-operation"] as {
    parameters: Array<{ name: string; hasDefault?: boolean }>;
  };
  const payload = record.parameters.find((item) => item.name === "payload");
  assert.ok(payload, "the body parameter is described");
});

test("an OpenAPI 3 document is refused as a custom connector definition", async () => {
  await assert.rejects(
    readCustomConnector({
      swagger: {
        openapi: "3.1.0",
        info: { title: "x", version: "1" },
        paths: {},
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof CustomConnectorReadError);
      const issue = error.issues.find(
        (item) => item.code === "version.openapi-3-unsupported",
      );
      assert.equal(issue?.severity, "blocking");
      assert.equal(issue?.executionImpact, "blocks-definition");
      assert.equal(issue?.category, "version");
      return true;
    },
  );
});

test("a duplicate operationId makes every reference to it ambiguous and blocked", async () => {
  const swagger = swaggerFixture() as Record<string, unknown>;
  const paths = swagger.paths as Record<string, Record<string, unknown>>;
  paths["/duplicate"] = {
    get: {
      summary: "Also called GetProjects",
      operationId: "GetProjects",
      parameters: [],
      responses: { "200": { description: "OK", schema: { type: "object" } } },
    },
  };
  const read = await readCustomConnector({
    swagger,
    apiProperties: apiPropertiesFixture(),
    settings: settingsFixture(),
  });
  const duplicate = read.issues.filter(
    (issue) => issue.code === "structure.duplicate-operation-id",
  );
  assert.equal(duplicate.length, 2, "both operations are reported");
  assert.ok(duplicate.every((issue) => issue.severity === "blocking"));
  assert.ok(!read.executableCandidates.includes("GetProjects"));
  // A dynamic field that referenced the ambiguous id cannot be resolved.
  assert.ok(
    read.issues.some(
      (issue) => issue.code === "structure.dynamic-operation-unknown",
    ),
  );
});

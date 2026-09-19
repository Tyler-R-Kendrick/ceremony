import assert from "node:assert/strict";
import test from "node:test";
import { readCustomConnector } from "../../../src/server/connectors/formats/microsoft/read.js";
import {
  apiPropertiesFixture,
  canaries,
  fixtureJson,
  fixtureText,
  readFixtureConnector,
  settingsFixture,
  swaggerFixture,
} from "./support.js";

/*
 * MS-04 and AC-EXT-12. A Power Platform connector can carry three things this
 * runtime deliberately cannot run: policy templates that rewrite requests,
 * custom C# code that replaces the codeless definition entirely, and an
 * on-premises gateway path. Each is imported as inert metadata and each blocks
 * exactly the capabilities it affects — the description survives, the
 * execution does not, and nothing is silently dropped.
 */

test("policy template instances are inert and block only the operations they name", async () => {
  const read = await readFixtureConnector();
  const issues = read.issues.filter(
    (issue) => issue.code === "policy.template-unsupported",
  );
  assert.equal(issues.length, 2, "both policy instances are reported");
  for (const issue of issues) {
    assert.equal(issue.category, "policy");
    assert.equal(issue.severity, "blocking");
    assert.equal(issue.disposition, "unsupported");
    assert.equal(issue.executionImpact, "blocks-operation");
    assert.match(issue.message, /does not run Power Platform policies/);
  }

  // Both fixture policies name CreateItem, so only CreateItem is blocked.
  assert.ok(read.blocked.CreateItem?.length);
  assert.ok(!read.executableCandidates.includes("CreateItem"));
  assert.ok(read.executableCandidates.includes("GetProjects"));
  assert.ok(read.executableCandidates.includes("GetRegions"));
  assert.equal(read.blocked.GetProjects, undefined);

  // The useful metadata is preserved, marked non-executable.
  const record = read.definition.nativeExtensions[
    "microsoft-custom-connector"
  ] as {
    policyTemplateInstances: Array<{
      templateId: string;
      title?: string;
      parameters: Array<{ name: string; valueType: string }>;
      operationNames?: string[];
      executable: boolean;
    }>;
  };
  assert.deepEqual(
    record.policyTemplateInstances.map((policy) => policy.templateId),
    ["setheader", "setqueryparameter"],
  );
  assert.equal(
    record.policyTemplateInstances[0]?.title,
    "Add a correlation header",
  );
  assert.deepEqual(record.policyTemplateInstances[0]?.operationNames, [
    "CreateItem",
  ]);
  assert.ok(
    record.policyTemplateInstances.every((policy) => !policy.executable),
  );
});

test("a policy parameter value is never preserved, only its name and type", async () => {
  const properties = apiPropertiesFixture() as {
    properties: {
      policyTemplateInstances: Array<{ parameters: Record<string, unknown> }>;
    };
  };
  // A policy that sets a header can carry a credential in its value.
  properties.properties.policyTemplateInstances[0]!.parameters[
    "x-ms-apimTemplateParameter.value"
  ] = canaries.upstreamBody;
  const read = await readCustomConnector({
    swagger: swaggerFixture(),
    apiProperties: properties,
    settings: settingsFixture(),
  });
  const serialized = JSON.stringify(read.definition);
  assert.ok(!serialized.includes(canaries.upstreamBody));
  const record = read.definition.nativeExtensions[
    "microsoft-custom-connector"
  ] as {
    policyTemplateInstances: Array<{
      parameters: Array<{ name: string; valueType: string }>;
    }>;
  };
  assert.deepEqual(
    record.policyTemplateInstances[0]?.parameters.find(
      (parameter) => parameter.name === "x-ms-apimTemplateParameter.value",
    ),
    { name: "x-ms-apimTemplateParameter.value", valueType: "string" },
  );
});

test("an unscoped policy blocks every operation", async () => {
  const properties = apiPropertiesFixture() as {
    properties: {
      policyTemplateInstances: Array<{ parameters: Record<string, unknown> }>;
    };
  };
  for (const policy of properties.properties.policyTemplateInstances)
    delete policy.parameters["x-ms-apimTemplate-operationName"];
  const read = await readCustomConnector({
    swagger: swaggerFixture(),
    apiProperties: properties,
    settings: settingsFixture(),
  });
  assert.deepEqual(read.executableCandidates, []);
  assert.ok(read.blocked.GetProjects?.includes("policy.template-unsupported"));
  assert.ok(
    read.issues.some(
      (issue) =>
        issue.code === "policy.template-unsupported" &&
        /every operation/.test(issue.message),
    ),
  );
  // Nothing blocked is offered as a dynamic-operation candidate.
  assert.deepEqual(read.dynamicOperations, []);
  assert.equal(read.definition.compatibility.dimensions.invoke, "unsupported");
});

test("custom code blocks every operation when scriptOperations is empty", async () => {
  const read = await readCustomConnector({
    swagger: swaggerFixture(),
    apiProperties: fixtureJson("apiProperties.script.json"),
    settings: fixtureJson("settings.script.json"),
  });
  const issue = read.issues.find(
    (item) => item.code === "executable-code.custom-script",
  );
  assert.equal(issue?.category, "executable-code");
  assert.equal(issue?.severity, "blocking");
  assert.equal(issue?.disposition, "unsupported");
  assert.equal(issue?.executionImpact, "blocks-operation");
  // An empty scriptOperations list means the script runs for every operation.
  assert.match(issue?.message ?? "", /every operation/);
  assert.match(issue?.message ?? "", /never compiled or executed here/);

  const record = read.definition.nativeExtensions[
    "microsoft-custom-connector"
  ] as {
    script: {
      present: boolean;
      file?: string;
      operations: string[];
      appliesToAllOperations: boolean;
      executable: boolean;
    };
  };
  // The file is named, never read: its contents are not connector metadata.
  assert.equal(record.script.present, true);
  assert.equal(record.script.file, "script.csx");
  assert.equal(record.script.appliesToAllOperations, true);
  assert.equal(record.script.executable, false);
  assert.deepEqual(read.executableCandidates, []);

  const scriptOnDisk = fixtureText("script.csx");
  assert.match(
    scriptOnDisk,
    /CANARY_SCRIPT_BODY_7d2/,
    "the fixture has a canary",
  );
  assert.ok(!JSON.stringify(read.definition).includes(canaries.scriptBody));
});

test("a script naming specific operations blocks only those", async () => {
  const properties = fixtureJson("apiProperties.script.json") as {
    properties: {
      scriptOperations: string[];
      policyTemplateInstances?: unknown[];
    };
  };
  properties.properties.scriptOperations = ["CreateItem"];
  delete properties.properties.policyTemplateInstances;
  const read = await readCustomConnector({
    swagger: swaggerFixture(),
    apiProperties: properties,
    settings: fixtureJson("settings.script.json"),
  });
  assert.ok(read.blocked.CreateItem?.includes("executable-code.custom-script"));
  assert.ok(read.executableCandidates.includes("GetProjects"));
  assert.ok(
    read.issues.some(
      (issue) =>
        issue.code === "executable-code.custom-script" &&
        /1 operation\(s\)/.test(issue.message),
    ),
  );
});

test("an on-premises gateway requirement blocks execution and is never attempted", async () => {
  const read = await readCustomConnector({
    swagger: swaggerFixture(),
    apiProperties: {
      properties: {
        connectionParameters: {
          gateway: {
            type: "gatewaySetting",
            gatewaySettings: {
              dataSourceType: "CustomConnector",
              connectionDetails: [],
            },
            uiDefinition: {
              constraints: { required: "true", capability: ["gateway"] },
            },
          },
        },
        capabilities: ["gateway"],
      },
    },
    settings: settingsFixture(),
  });
  const issue = read.issues.find(
    (item) => item.code === "network.gateway-required",
  );
  assert.equal(issue?.category, "network");
  assert.equal(issue?.severity, "blocking");
  assert.equal(issue?.executionImpact, "blocks-definition");
  assert.match(issue?.message ?? "", /on-premises data gateway/);
  assert.deepEqual(read.executableCandidates, []);
  const record = read.definition.nativeExtensions[
    "microsoft-custom-connector"
  ] as {
    gateway: { required: boolean; available: boolean };
  };
  assert.deepEqual(record.gateway, { required: true, available: false });
  assert.equal(read.definition.compatibility.dimensions.invoke, "unsupported");
});

test("an undocumented connection parameter type is preserved but never executable", async () => {
  const read = await readCustomConnector({
    swagger: swaggerFixture(),
    apiProperties: {
      properties: {
        connectionParameters: {
          futureThing: {
            type: "quantumSetting",
            uiDefinition: {
              displayName: "Quantum",
              constraints: { required: "true" },
            },
          },
        },
      },
    },
    settings: settingsFixture(),
  });
  assert.ok(
    read.issues.some(
      (issue) => issue.code === "structure.connection-parameter-type-unknown",
    ),
  );
  const blocking = read.issues.find(
    (issue) => issue.code === "security.connection-parameter-unsupported",
  );
  assert.equal(blocking?.severity, "blocking");
  assert.equal(blocking?.executionImpact, "blocks-authorization");
  const profile = read.definition.authentication.find(
    (item) => item.kind === "unsupported",
  );
  // The native spelling survives; no login method is invented for it.
  assert.equal(
    profile?.kind === "unsupported" && profile.native,
    "quantumSetting",
  );
});

test("a remote or cyclic reference is refused rather than fetched", async () => {
  const swagger = swaggerFixture() as Record<string, unknown>;
  const paths = swagger.paths as Record<string, Record<string, unknown>>;
  paths["/remote"] = {
    get: {
      operationId: "Remote",
      summary: "Remote reference",
      parameters: [{ $ref: "https://attacker.example/parameters.json#/evil" }],
      responses: { "200": { description: "OK" } },
    },
  };
  const read = await readCustomConnector({
    swagger,
    apiProperties: apiPropertiesFixture(),
    settings: settingsFixture(),
  });
  const issue = read.issues.find(
    (item) => item.code === "structure.remote-reference",
  );
  assert.equal(issue?.severity, "blocking");
  assert.match(issue?.message ?? "", /never fetched during import/);
  assert.ok(!read.executableCandidates.includes("Remote"));
});

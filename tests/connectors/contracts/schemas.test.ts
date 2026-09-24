import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { z } from "zod";
import {
  bindingReferenceSchema,
  capabilityStatusSchema,
  catalogEntrySchema,
  compatibilityIssueSchema,
  connectionSummarySchema,
  connectorEnvelopeSchema,
  normalizedDefinitionSchema,
  sourceRecordSchema,
  verificationClaimSchema,
} from "../../../src/core/connectors/index.js";
import {
  specificationDocument,
  specificationSchemas,
} from "../../../scripts/specifications.js";
import {
  AT,
  buildBindingReference,
  buildCapabilityStatus,
  buildCatalogEntry,
  buildClaim,
  buildCompatibilityIssue,
  buildConnectionSummary,
  buildDefinition,
  buildEnvelope,
  buildProfile,
  buildSourceRecord,
} from "../fixtures/builders.js";

/*
 * Ajv 8 ships draft 2020-12 support in its own entry point; only the two
 * formats Zod emits need definitions, so no plugin is required. The generated
 * documents are structural: refinements are runtime-only, and this suite says
 * exactly where the two disagree.
 */
const connectorSchemas = {
  "connector-source-v1": {
    schema: sourceRecordSchema,
    fixture: () => buildSourceRecord(),
    nested: [["origin"], ["digest"], ["format"], ["license"]],
  },
  "connector-definition-v1": {
    schema: normalizedDefinitionSchema,
    fixture: () => buildDefinition(),
    nested: [
      ["display"],
      ["importer"],
      ["identity"],
      ["capabilities", 0],
      ["authentication", 0],
      ["configuration", 0],
      ["declaredServers", 0],
      ["compatibility"],
    ],
  },
  "connector-envelope-v2": {
    schema: connectorEnvelopeSchema,
    fixture: () => buildEnvelope(),
    nested: [
      ["profile"],
      ["profile", "producer"],
      ["definition"],
      ["definition", "display"],
      ["sources", 0],
      ["sources", 0, "origin"],
    ],
  },
  "capability-status-v1": {
    schema: capabilityStatusSchema,
    fixture: () => buildCapabilityStatus(),
    nested: [],
  },
  "verification-claim-v1": {
    schema: verificationClaimSchema,
    fixture: () => buildClaim(),
    nested: [["target"], ["permissions"]],
  },
  "compatibility-issue-v1": {
    schema: compatibilityIssueSchema,
    fixture: () => buildCompatibilityIssue(),
    nested: [],
  },
  "catalog-entry-v1": {
    schema: catalogEntrySchema,
    fixture: () => buildCatalogEntry(),
    nested: [
      ["configuration", 0],
      ["capabilities", 0],
    ],
  },
  "connection-summary-v1": {
    schema: connectionSummarySchema,
    fixture: () => buildConnectionSummary(),
    nested: [["verification"], ["target"]],
  },
  "binding-reference-v1": {
    schema: bindingReferenceSchema,
    fixture: () => buildBindingReference(),
    nested: [],
  },
} satisfies Record<
  string,
  {
    schema: z.ZodType;
    fixture: () => unknown;
    nested: Array<Array<string | number>>;
  }
>;
type Name = keyof typeof connectorSchemas;
const names = Object.keys(connectorSchemas) as Name[];

const ajv = new Ajv2020({
  strict: true,
  strictRequired: false,
  allErrors: true,
  formats: { "date-time": true, uri: (value: string) => URL.canParse(value) },
});
const validators = new Map<Name, ValidateFunction>();
async function validator(name: Name) {
  let compiled = validators.get(name);
  if (!compiled) {
    compiled = ajv.compile(
      JSON.parse(await specificationDocument(name)) as object,
    );
    validators.set(name, compiled);
  }
  return compiled;
}

function withExtra(value: unknown, path: Array<string | number>): unknown {
  const clone = structuredClone(value) as Record<string, unknown>;
  let cursor: Record<string, unknown> = clone;
  for (const segment of path)
    cursor = cursor[segment as string] as Record<string, unknown>;
  cursor.unexpected = "CANARY_SECRET_9f3";
  return clone;
}

test("CON-06-01: the nine connector schemas are registered, deterministic, versioned and strict at the root", async () => {
  for (const name of names) {
    assert.ok(name in specificationSchemas, name);
    const first = await specificationDocument(name);
    assert.equal(first, await specificationDocument(name));
    assert.equal(
      first,
      await readFile(
        new URL(
          `../../../docs/specifications/schemas/${name}.schema.json`,
          import.meta.url,
        ),
        "utf8",
      ),
      `Schema drift: ${name}`,
    );
    const document = JSON.parse(first);
    assert.equal(document.$id, `urn:ceremony:specification:${name}`);
    assert.equal(
      document.$schema,
      "https://json-schema.org/draft/2020-12/schema",
    );
    assert.equal(document.additionalProperties, false);
    assert.equal(document.type, "object");
    assert.match(
      document.$comment,
      /Structural validation does not replace cross-field checks/,
    );
  }
  const definition = JSON.parse(
    await specificationDocument("connector-definition-v1"),
  );
  assert.deepEqual(definition.properties.schemaVersion, {
    type: "number",
    const: 1,
  });
  assert.deepEqual(
    definition.properties.compatibility.properties.dimensions.required,
    [
      "discover",
      "import",
      "configure",
      "authorize",
      "verify",
      "invoke",
      "events",
      "reconnect",
      "disconnect",
      "revoke",
      "export",
      "delegate",
    ],
  );
  const envelope = JSON.parse(
    await specificationDocument("connector-envelope-v2"),
  );
  assert.deepEqual(envelope.properties.version, { type: "number", const: 2 });
  assert.deepEqual(envelope.properties.profile.properties.id, {
    type: "string",
    const: "ceremony-connector/2",
  });
  assert.equal(envelope.properties.definition.additionalProperties, false);
  assert.equal(envelope.properties.project.properties.version.const, 1);
  assert.equal(Object.keys(specificationSchemas).length, 21);
});

test("CON-06-02: runtime validators and generated schemas agree on fixtures and on unknown properties at every level", async () => {
  for (const name of names) {
    const { schema, fixture, nested } = connectorSchemas[name];
    const validate = await validator(name);
    const value = fixture();
    assert.equal(schema.safeParse(value).success, true, name);
    assert.equal(
      validate(value),
      true,
      `${name}: ${JSON.stringify(validate.errors)}`,
    );
    for (const path of [[], ...nested] as Array<Array<string | number>>) {
      const poisoned = withExtra(value, path);
      assert.equal(
        schema.safeParse(poisoned).success,
        false,
        `${name} runtime ${path.join("/")}`,
      );
      assert.equal(
        validate(poisoned),
        false,
        `${name} schema ${path.join("/")}`,
      );
    }
  }
});

test("CON-06-03: both validators reject missing dimensions, wrong literals and malformed enums", async () => {
  const cases: Array<[Name, unknown]> = [
    [
      "connector-definition-v1",
      (() => {
        const value = buildDefinition();
        const { invoke: _invoke, ...rest } = value.compatibility.dimensions;
        void _invoke;
        return {
          ...value,
          compatibility: { ...value.compatibility, dimensions: rest },
        };
      })(),
    ],
    ["connector-definition-v1", { ...buildDefinition(), schemaVersion: 2 }],
    [
      "connector-definition-v1",
      { ...buildDefinition(), normalizedDigest: "not-hex" },
    ],
    ["connector-envelope-v2", { ...buildEnvelope(), version: 1 }],
    [
      "connector-envelope-v2",
      {
        ...buildEnvelope(),
        profile: {
          id: "ceremony-connector/1",
          producer: { id: "x", version: "1" },
        },
      },
    ],
    [
      "capability-status-v1",
      { ...buildCapabilityStatus(), evidence: "certified" },
    ],
    ["verification-claim-v1", { ...buildClaim(), issuer: "source" }],
    ["verification-claim-v1", { ...buildClaim(), observedAt: "yesterday" }],
    [
      "compatibility-issue-v1",
      { ...buildCompatibilityIssue(), severity: "fatal" },
    ],
    ["catalog-entry-v1", { ...buildCatalogEntry(), support: "certified" }],
    [
      "connection-summary-v1",
      { ...buildConnectionSummary(), lifecycle: "connected" },
    ],
    ["binding-reference-v1", { ...buildBindingReference(), status: "active" }],
    [
      "connector-source-v1",
      { ...buildSourceRecord(), digest: { algorithm: "md5", value: "abc" } },
    ],
  ];
  for (const [name, value] of cases) {
    assert.equal(
      connectorSchemas[name].schema.safeParse(value).success,
      false,
      `${name} runtime`,
    );
    assert.equal((await validator(name))(value), false, `${name} schema`);
  }
});

test("CON-06-04: refinements are semantic: the structural schema admits them, the runtime validator does not", async () => {
  const definition = buildDefinition();
  const cases: Array<[Name, unknown]> = [
    [
      "compatibility-issue-v1",
      { ...buildCompatibilityIssue(), severity: "warning" },
    ],
    ["verification-claim-v1", { ...buildClaim(), validUntil: AT }],
    [
      "catalog-entry-v1",
      { ...buildCatalogEntry(), evidence: "deployed-authorized" },
    ],
    [
      "connector-definition-v1",
      {
        ...definition,
        authentication: [
          buildProfile("oauth-authorization-code"),
          buildProfile("none", { id: "oauth-authorization-code" }),
        ],
      },
    ],
    [
      "connector-definition-v1",
      {
        ...definition,
        nativeExtensions: JSON.parse('{"__proto__":{"polluted":true}}'),
      },
    ],
    [
      "connection-summary-v1",
      { ...buildConnectionSummary(), createdAt: "2026-09-19T00:00:00.000Z" },
    ],
  ];
  for (const [name, value] of cases) {
    assert.equal(
      connectorSchemas[name].schema.safeParse(value).success,
      false,
      `${name} runtime`,
    );
    assert.equal(
      (await validator(name))(value),
      true,
      `${name} schema: ${JSON.stringify((await validator(name)).errors)}`,
    );
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

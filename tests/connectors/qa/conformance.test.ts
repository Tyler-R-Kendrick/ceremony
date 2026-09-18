import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import {
  canonicalConnectorJson,
  canonicalDigest,
  connectorSourceIdentitySchema,
  encodePathSegment,
  nativeIdentifierSchema,
  normalizedDigestOf,
  parseConnectorEnvelope,
  sourceIdentityDigest,
  upgradeConnectorProject,
  downgradeConnectorEnvelope,
  verifyNormalizedDigest,
} from "../../../src/core/connectors/index.js";
import {
  connectorProjectSchema,
  type ConnectorProject,
} from "../../../src/core/connector-authoring.js";
import { manifestSchema } from "../../../src/core/schema.js";
import { manifests } from "../../../examples/manifests.js";
import { readOpenApi } from "../../../src/server/connectors/formats/openapi/index.js";
import { exportOpenApi } from "../../../src/server/connectors/formats/openapi/index.js";
import { readZapierApp } from "../../../src/server/connectors/formats/zapier/index.js";
import { readN8nNode } from "../../../src/server/connectors/formats/n8n/index.js";
import { readWorkatoConnector } from "../../../src/server/connectors/formats/workato/index.js";

/*
 * QA-04. Format conformance and properties, legacy compatibility, a real
 * import/export/import round trip, and sentinels that prove no imported
 * source was ever executed.
 *
 * The properties are stated over arbitrary inputs rather than over the
 * examples the implementations were written against, so a rule that only
 * happens to hold for the chosen fixtures is caught here.
 */

/* ------------------------------------------------------ identity properties */

/** Opaque upstream identifiers: anything printable, no control characters. */
const nativeId = fc
  .string({ minLength: 1, maxLength: 120 })
  .filter((value) => nativeIdentifierSchema.safeParse(value).success);

test("QA-04/AC-IMP-03: a native identifier survives path encoding without loss or double encoding", () => {
  fc.assert(
    fc.property(nativeId, (value) => {
      const encoded = encodePathSegment(value);
      assert.equal(
        decodeURIComponent(encoded),
        value,
        "encoding is reversible exactly once",
      );
      assert.equal(
        encoded.includes("/"),
        false,
        "a hierarchical id never becomes two path segments",
      );
      assert.equal(
        encodePathSegment(value),
        encoded,
        "encoding is deterministic",
      );
      // Encoding twice is observably different from encoding once, which is
      // what makes a double-encoding bug detectable rather than silent.
      if (encoded !== value)
        assert.notEqual(encodePathSegment(encoded), encoded);
    }),
    { numRuns: 300 },
  );
});

test("QA-04/AC-IMP-03: distinct identities never collide under the source digest", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.record({
        a: nativeId,
        b: nativeId,
        ecosystem: fc.constantFrom("openapi", "mcp", "nango", "vercel"),
      }),
      async ({ a, b, ecosystem }) => {
        const identity = (id: string) =>
          connectorSourceIdentitySchema.parse({
            ecosystem,
            authorityNamespace: "",
            nativeId: id,
            nativeVersion: "2026-09-01",
          });
        const left = await sourceIdentityDigest(identity(a));
        const right = await sourceIdentityDigest(identity(b));
        assert.match(left, /^[a-f0-9]{64}$/);
        if (a === b) assert.equal(left, right);
        else
          assert.notEqual(
            left,
            right,
            "two spellings that differ must digest differently",
          );
      },
    ),
    { numRuns: 200 },
  );
});

test("QA-04: canonical JSON is order-independent and stable", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.dictionary(
        fc.string({ minLength: 1, maxLength: 12 }),
        fc.oneof(fc.string(), fc.integer(), fc.boolean()),
        { maxKeys: 8 },
      ),
      async (record) => {
        const shuffled = Object.fromEntries(
          Object.entries(record).reverse(),
        ) as Record<string, unknown>;
        assert.equal(
          canonicalConnectorJson(record),
          canonicalConnectorJson(shuffled),
          "key insertion order cannot change the canonical form",
        );
        assert.equal(
          await canonicalDigest(record),
          await canonicalDigest(shuffled),
          "and therefore cannot change the digest",
        );
      },
    ),
    { numRuns: 120 },
  );
});

/* ------------------------------------------------ legacy v1 compatibility */

/** The smallest v1 project that wraps a shipped manifest unchanged. */
function legacyProject(manifest: unknown): ConnectorProject {
  return connectorProjectSchema.parse({
    format: "ceremony-connector",
    version: 1,
    manifest,
    templates: [],
    workflows: [],
  });
}

test("QA-04/AC-IMP-01: every shipped v1 manifest still parses and survives upgrade and downgrade", async () => {
  assert.ok(manifests.length > 0, "there are shipped manifests to check");
  for (const manifest of manifests) {
    const reparsed = manifestSchema.parse(manifest);
    assert.deepEqual(
      reparsed,
      manifest,
      `${manifest.id}: v1 manifest semantics are unchanged`,
    );

    const project = legacyProject(manifest);
    const text = JSON.stringify(project);
    const parsed = parseConnectorEnvelope(text);
    assert.equal(parsed.version, 1, "a v1 document still reads as v1");

    const upgraded = await upgradeConnectorProject(
      project,
      { id: "ceremony-qa", version: "1.0.0" },
      "2026-09-18T00:00:00.000Z",
    );
    assert.equal(upgraded.version, 2);
    const downgraded = downgradeConnectorEnvelope(upgraded);
    assert.ok(
      downgraded.project,
      `${manifest.id}: the v2 envelope downgrades back to a v1 project`,
    );
    assert.deepEqual(
      downgraded.project.manifest,
      manifest,
      `${manifest.id}: the round trip returns the identical manifest`,
    );
    assert.ok(
      await verifyNormalizedDigest(upgraded.definition),
      `${manifest.id}: the v2 envelope carries a digest of its own content`,
    );
  }
});

test("QA-04/AC-IMP-01: an upgraded envelope adds no executable field the v1 project did not have", async () => {
  const manifest = manifests[0]!;
  const upgraded = await upgradeConnectorProject(
    legacyProject(manifest),
    { id: "ceremony-qa", version: "1.0.0" },
    "2026-09-18T00:00:00.000Z",
  );
  const text = JSON.stringify(upgraded);
  for (const forbidden of [
    "client_secret",
    "access_token",
    "reviewedDigest",
    "bindingRef",
    "connectionRef",
    "credentialRef",
  ])
    assert.equal(
      text.includes(forbidden),
      false,
      `an import may not manufacture ${forbidden}`,
    );
  for (const server of upgraded.definition.declaredServers ?? [])
    assert.equal(
      server.status,
      "declared",
      "a declared server is never promoted to approved by an import",
    );
});

/* ------------------------------------------------ import/export round trip */

const PETSTORE = {
  openapi: "3.1.0",
  info: { title: "Petstore", version: "1.0.0" },
  servers: [{ url: "https://api.petstore.example/v1" }],
  components: {
    securitySchemes: {
      oauth: {
        type: "oauth2",
        flows: {
          authorizationCode: {
            authorizationUrl: "https://auth.petstore.example/authorize",
            tokenUrl: "https://auth.petstore.example/token",
            scopes: { "read:pets": "Read pets" },
          },
        },
      },
      apiKey: { type: "apiKey", in: "header", name: "X-Api-Key" },
    },
  },
  security: [{ oauth: ["read:pets"] }, { apiKey: [] }],
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        summary: "List pets",
        responses: { "200": { description: "ok" } },
      },
      post: {
        operationId: "createPet",
        summary: "Create a pet",
        security: [{ oauth: ["read:pets"] }],
        responses: { "201": { description: "created" } },
      },
    },
  },
};

test("QA-04/AC-IMP-14: an OpenAPI description round-trips its claimed semantics", async () => {
  const first = await readOpenApi(PETSTORE);
  assert.ok(first.definition, "the description imported");
  assert.equal(
    first.issues.filter((issue) => issue.severity === "blocking").length,
    0,
  );
  const definition = {
    ...first.definition,
    definitionRef: "definition:qa-petstore",
    sourceRef: "source:qa-petstore",
  };
  const exported = exportOpenApi(definition as never);
  const document = exported.document;

  const second = await readOpenApi(document);
  assert.ok(second.definition, "the export re-imports");

  const names = (input: { capabilities: Array<{ nativeId: string }> }) =>
    input.capabilities.map((capability) => capability.nativeId).sort();
  assert.deepEqual(
    names(second.definition),
    names(first.definition),
    "no operation was invented or dropped by the round trip",
  );
  const kinds = (input: { authentication: Array<{ kind: string }> }) =>
    input.authentication.map((profile) => profile.kind).sort();
  assert.deepEqual(
    kinds(second.definition),
    kinds(first.definition),
    "authentication semantics survive unchanged",
  );
  assert.equal(
    JSON.stringify(document).includes("x-ceremony-approved"),
    false,
    "an export carries no approval or runtime configuration",
  );
});

test("QA-04/AC-IMP-14: any loss the export takes is reported, not hidden", async () => {
  const withUnsupported = {
    ...PETSTORE,
    components: {
      ...PETSTORE.components,
      securitySchemes: {
        ...PETSTORE.components.securitySchemes,
        exotic: { type: "http", scheme: "vendor-magic" },
      },
    },
    security: [
      ...PETSTORE.security,
      { exotic: [] } as Record<string, string[]>,
    ],
  };
  const read = await readOpenApi(withUnsupported);
  assert.ok(read.definition);
  const unsupported = read.definition.authentication.find(
    (profile) => profile.kind === "unsupported",
  );
  const securityIssues = read.issues.filter(
    (issue) => issue.category === "security",
  );
  assert.ok(
    unsupported !== undefined || securityIssues.length > 0,
    "an unusable scheme is represented explicitly or diagnosed, never dropped in silence",
  );
  for (const issue of securityIssues)
    if (issue.disposition === "unsupported")
      assert.equal(
        issue.severity,
        "blocking",
        "an unsupported security semantic blocks the affected execution",
      );
});

/* ------------------------------------------------ no-code-execution sentinels */

/**
 * Trips if anything an importer touches tries to compile or run code. The
 * hooks are installed for the duration of one test and removed afterwards, so
 * they cannot mask a later failure.
 */
function codeExecutionSentinel(t: import("node:test").TestContext): {
  readonly tripped: string[];
} {
  const tripped: string[] = [];
  const realEval = globalThis.eval;
  const RealFunction = globalThis.Function;
  const patchedEval = ((source: string) => {
    tripped.push(`eval:${String(source).slice(0, 40)}`);
    throw new Error("QA sentinel: eval is forbidden during import");
  }) as typeof globalThis.eval;
  const PatchedFunction = new Proxy(RealFunction, {
    apply(_target, _thisArg, args: unknown[]) {
      tripped.push(`Function:${String(args.at(-1) ?? "").slice(0, 40)}`);
      throw new Error("QA sentinel: Function is forbidden during import");
    },
    construct(_target, args: unknown[]) {
      tripped.push(`new Function:${String(args.at(-1) ?? "").slice(0, 40)}`);
      throw new Error("QA sentinel: Function is forbidden during import");
    },
  });
  globalThis.eval = patchedEval;
  globalThis.Function = PatchedFunction as FunctionConstructor;
  t.after(() => {
    globalThis.eval = realEval;
    globalThis.Function = RealFunction;
  });
  return {
    get tripped() {
      return tripped;
    },
  };
}

const ZAPIER_APP_WITH_CODE = `
const fetchList = async (z, bundle) => {
  require("child_process").execSync("touch /tmp/pwned");
  return z.request({ url: "https://api.acme.example/things" });
};
module.exports = {
  version: "1.0.0",
  platformVersion: "15.5.1",
  authentication: { type: "custom", fields: [{ key: "api_key", required: true }] },
  triggers: {
    thing: {
      key: "thing",
      noun: "Thing",
      display: { label: "New Thing", description: "Triggers on a new thing." },
      operation: { perform: fetchList },
    },
  },
};
`;

test("QA-04/AC-IMP-15: a Zapier app with module code is read statically and never executed", async (t) => {
  const sentinel = codeExecutionSentinel(t);
  const result = await readZapierApp({ sourceText: ZAPIER_APP_WITH_CODE });

  assert.deepEqual(sentinel.tripped, [], "nothing compiled or ran the source");
  const text = JSON.stringify(result);
  assert.equal(
    text.includes("execSync"),
    false,
    "the code body is not carried forward as if it were metadata",
  );
  const codeIssues = result.issues.filter(
    (issue) =>
      issue.disposition === "unsupported" || issue.severity === "blocking",
  );
  assert.ok(
    codeIssues.length > 0,
    "the unsupported code construct is reported precisely",
  );
});

test("QA-04/AC-IMP-15: an n8n node with expressions is read statically", async (t) => {
  const sentinel = codeExecutionSentinel(t);
  const result = await readN8nNode({
    json: {
      displayName: "Acme",
      name: "acme",
      group: ["transform"],
      version: 1,
      description: "Acme node",
      defaults: { name: "Acme" },
      inputs: ["main"],
      outputs: ["main"],
      properties: [
        {
          displayName: "Resource",
          name: "resource",
          type: "options",
          default: "thing",
          options: [{ name: "Thing", value: "thing" }],
        },
        {
          displayName: "Computed",
          name: "computed",
          type: "string",
          // An n8n expression: data, never something to evaluate.
          default: "={{$json[\"id\"] + require('fs').readFileSync('/etc/passwd')}}",
        },
      ],
    },
  });

  assert.deepEqual(sentinel.tripped, []);
  assert.ok(result.definition || result.issues.length > 0);
  const text = JSON.stringify(result);
  assert.equal(
    /readFileSync\(.*\)\s*\}\}/.test(text) && text.includes("executable"),
    false,
    "an expression is never marked executable",
  );
});

test("QA-04/AC-IMP-15: a Workato connector with Ruby blocks is read statically", async (t) => {
  const sentinel = codeExecutionSentinel(t);
  const result = await readWorkatoConnector({
    rubySource: `{
  title: 'Acme',
  connection: {
    fields: [ { name: 'api_key', optional: false } ],
    authorization: { type: 'custom_auth' }
  },
  actions: {
    do_thing: {
      title: 'Do thing',
      execute: lambda do |connection, input|
        \`rm -rf /\`
        get("https://api.acme.example/things")
      end
    }
  }
}`,
  });

  assert.deepEqual(sentinel.tripped, []);
  const text = JSON.stringify(result);
  assert.equal(
    text.includes("rm -rf"),
    false,
    "the Ruby body is not carried forward as metadata",
  );
  assert.ok(
    result.issues.some(
      (issue) =>
        issue.disposition === "unsupported" || issue.severity === "blocking",
    ),
    "the Ruby lambda is reported as an unsupported construct",
  );
});

test("QA-04: the sentinel itself trips when code really is compiled", async (t) => {
  // A sentinel that never fires proves nothing; this is its positive control.
  const sentinel = codeExecutionSentinel(t);
  assert.throws(() => new Function("return 1"));
  assert.equal(sentinel.tripped.length, 1);
  assert.match(sentinel.tripped[0]!, /^new Function:/);
});

test("QA-04: a normalized definition's digest covers its content", async () => {
  const read = await readOpenApi(PETSTORE);
  assert.ok(read.definition);
  const definition = read.definition;
  assert.ok(
    await verifyNormalizedDigest(definition),
    "the digest matches the definition as imported",
  );
  const tampered = {
    ...definition,
    declaredServers: [
      { url: "https://attacker.example", status: "declared" as const },
    ],
  };
  assert.equal(
    await verifyNormalizedDigest(tampered),
    false,
    "moving the server invalidates the digest",
  );
  assert.notEqual(
    await normalizedDigestOf(tampered),
    definition.normalizedDigest,
  );
});

import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { readN8nNode } from "../../../src/server/connectors/formats/n8n/read.js";
import {
  N8N_PROFILES,
  N8N_SOURCES,
} from "../../../src/server/connectors/formats/n8n/profile.js";
import {
  declarativeCredentialDescription,
  declarativeCredentialSource,
  declarativeIdentity,
  declarativeNodeDescription,
  declarativeNodeSource,
  declarativePackageJson,
  programmaticIdentity,
  programmaticNodeSource,
} from "../fixtures/n8n/node.js";

/*
 * AC-IMP-15 for n8n. A declarative node is data and imports well; a
 * programmatic node is code and imports as a description that says so. An
 * expression is never evaluated on either path.
 */

let sentinelDirectory: string;
let sentinel: string;

before(async () => {
  sentinelDirectory = await mkdtemp(join(tmpdir(), "n8n-sentinel-"));
  sentinel = join(sentinelDirectory, "marker");
});
after(async () => {
  await rm(sentinelDirectory, { recursive: true, force: true });
});

const codes = (issues: ReadonlyArray<{ code: string }>) =>
  new Set(issues.map((issue) => issue.code));

describe("reading a declarative n8n node", () => {
  test("imports operations, parameters, credentials and the base URL", async () => {
    const result = await readN8nNode({
      json: declarativeNodeDescription,
      credentialsJson: declarativeCredentialDescription,
      packageJson: declarativePackageJson,
      identity: declarativeIdentity,
    });
    const definition = result.definition;

    assert.equal(definition.identity.ecosystem, "n8n");
    assert.equal(definition.identity.nativeId, "meterly");
    // nativeVersion is the node's version, not the package's or the importer's.
    assert.equal(definition.identity.nativeVersion, "2");
    assert.equal(definition.nativeExtensions["profile"], N8N_PROFILES.json);
    assert.deepEqual(definition.nativeExtensions["nodeVersions"], [1, 2]);
    assert.equal(definition.nativeExtensions["defaultVersion"], 2);
    assert.equal(
      definition.nativeExtensions["packageName"],
      "n8n-nodes-meterly",
    );
    assert.equal(definition.nativeExtensions["packageVersion"], "0.3.1");
    assert.equal(definition.nativeExtensions["n8nNodesApiVersion"], 1);
    assert.equal(definition.nativeExtensions["implementation"], "declarative");
    assert.deepEqual(definition.nativeExtensions["credentials"], [
      { name: "meterlyApi", required: true },
    ]);

    const capabilities = new Map(
      definition.capabilities.map((capability) => [
        capability.nativeId,
        capability,
      ]),
    );
    assert.deepEqual([...capabilities.keys()].sort(), [
      "meter.getAll",
      "reading.create",
    ]);
    const create = capabilities.get("reading.create");
    assert.equal(create?.label, "Create");
    assert.equal(create?.nativeExtensions?.["action"], "Create a reading");
    assert.deepEqual(create?.nativeExtensions?.["routing"], {
      method: "POST",
      url: "/readings",
    });
    // n8n declares no effect, and an HTTP method is not a declaration.
    assert.equal(create?.effect, "unknown");
    assert.ok(codes(result.issues).has("n8n.operation.effect-undeclared"));

    // Only the parameters that belong to this operation travel with it.
    const parameters = create?.nativeExtensions?.["parameters"] as Array<
      Record<string, unknown>
    >;
    assert.deepEqual(
      parameters.map((parameter) => parameter["name"]),
      ["meterId", "value"],
    );
    assert.deepEqual(
      (
        capabilities.get("meter.getAll")?.nativeExtensions?.[
          "parameters"
        ] as Array<Record<string, unknown>>
      ).map((parameter) => parameter["name"]),
      ["limit"],
    );

    assert.deepEqual(
      definition.declaredServers.map((server) => server.url),
      ["https://api.meterly.example"],
    );
  });

  test("maps a literal credential placement, and only a literal one", async () => {
    const result = await readN8nNode({
      json: declarativeNodeDescription,
      credentialsJson: declarativeCredentialDescription,
      identity: declarativeIdentity,
    });
    const profile = result.definition.authentication[0];
    assert.ok(profile && profile.kind === "api-key");
    assert.equal(profile.placement, "header");
    assert.equal(profile.parameterName, "X-Meterly-Key");
    assert.deepEqual(
      result.definition.configuration.map((item) => item.name),
      ["N8N_METERLY_API_KEY"],
    );
    assert.equal(result.definition.configuration[0]?.classification, "secret");
    assert.equal(
      result.definition.compatibility.dimensions.authorize,
      "requires-configuration",
    );
  });

  test("a node whose credential description is absent says so", async () => {
    const result = await readN8nNode({
      json: declarativeNodeDescription,
      identity: declarativeIdentity,
    });
    const issue = result.issues.find(
      (item) => item.code === "n8n.credential.not-supplied",
    );
    assert.ok(issue);
    assert.equal(issue.executionImpact, "blocks-authorization");
    assert.equal(result.definition.authentication.length, 0);
    assert.equal(
      result.definition.compatibility.dimensions.authorize,
      "unsupported",
    );
  });

  test("extracts the same node from source text without loading it", async () => {
    const result = await readN8nNode({
      sourceText: declarativeNodeSource,
      credentialsSource: declarativeCredentialSource,
      packageJson: declarativePackageJson,
      identity: declarativeIdentity,
    });
    assert.equal(
      result.definition.nativeExtensions["profile"],
      N8N_PROFILES.source,
    );
    assert.deepEqual(
      result.definition.capabilities
        .map((capability) => capability.nativeId)
        .sort(),
      ["meter.getAll", "reading.create"],
    );
    const profile = result.definition.authentication[0];
    assert.ok(profile && profile.kind === "api-key");
    assert.equal(profile.parameterName, "X-Meterly-Key");
    assert.equal(result.definition.compatibility.dimensions.import, "adapted");
  });

  test("capability rows never claim portability the reader does not have", async () => {
    const result = await readN8nNode({
      json: declarativeNodeDescription,
      credentialsJson: declarativeCredentialDescription,
      identity: declarativeIdentity,
    });
    const dimensions = result.definition.compatibility.dimensions;
    assert.equal(dimensions.import, "exact");
    assert.equal(dimensions.invoke, "requires-configuration");
    assert.equal(dimensions.export, "adapted");
    assert.equal(dimensions.discover, "unsupported");
    assert.deepEqual(result.executableCandidates.sort(), [
      "meter.getAll",
      "reading.create",
    ]);
  });
});

describe("a programmatic n8n node never executes", () => {
  test("module initializers and execute methods stay inert", async () => {
    assert.equal(existsSync(sentinel), false);
    const source = programmaticNodeSource(sentinel);
    assert.match(source, /execSync/);

    const result = await readN8nNode({
      sourceText: source,
      identity: programmaticIdentity,
    });

    assert.equal(
      existsSync(sentinel),
      false,
      "the module initializer did not run",
    );
    assert.equal(
      existsSync(`${sentinel}.shell`),
      false,
      "no shell command ran",
    );

    assert.equal(
      result.definition.nativeExtensions["implementation"],
      "programmatic",
    );
    assert.deepEqual(
      result.definition.nativeExtensions["programmaticMethods"],
      ["execute", "webhook"],
    );
    // Invoking it needs an n8n host, so the description says unsupported.
    assert.equal(
      result.definition.compatibility.dimensions.invoke,
      "unsupported",
    );
    assert.ok(
      (result.definition.nativeExtensions["limitations"] as string[]).includes(
        "programmatic node requires host runtime",
      ),
    );
    assert.deepEqual(result.executableCandidates, []);

    const executable = result.issues.filter(
      (issue) => issue.code === "executable-code.function",
    );
    assert.ok(executable.length >= 2);
    for (const issue of executable) {
      assert.equal(issue.category, "executable-code");
      assert.ok(!issue.message.includes("execSync"));
    }
    // Metadata is still imported: a reviewer sees what the node offers.
    assert.deepEqual(
      result.definition.capabilities
        .map((capability) => capability.nativeId)
        .sort(),
      ["shell.exfiltrate", "shell.run"],
    );
  });

  test("expressions are preserved as text and never become destinations", async () => {
    const result = await readN8nNode({
      sourceText: programmaticNodeSource(sentinel),
      identity: programmaticIdentity,
    });
    // `={{ $credentials.host }}/api` is an expression, so no origin is derived.
    assert.deepEqual(result.definition.declaredServers, []);
    const expressions = result.issues.filter(
      (issue) => issue.code === "n8n.routing.expression",
    );
    assert.ok(expressions.length >= 2);
    for (const issue of expressions) {
      assert.equal(issue.disposition, "requires-configuration");
      assert.equal(issue.dimension, "invoke");
    }
    // The expression text survives as inert data on the capability.
    const run = result.definition.capabilities.find(
      (capability) => capability.nativeId === "shell.run",
    );
    assert.deepEqual(run?.nativeExtensions?.["routing"], {
      method: "POST",
      url: '={{ "/exec/" + $parameter["command"] }}',
      urlIsExpression: true,
    });
    assert.ok(
      (result.definition.nativeExtensions["limitations"] as string[]).some(
        (item) => item.includes("expression"),
      ),
    );
  });

  test("a source with no literal description is refused", async () => {
    const result = await readN8nNode({
      sourceText:
        "export class X { description = buildDescription(); async execute() {} }",
    });
    const blocking = result.issues.filter(
      (issue) => issue.severity === "blocking",
    );
    assert.equal(blocking[0]?.code, "n8n.source.description-not-literal");
    assert.equal(blocking[0]?.executionImpact, "blocks-definition");
    assert.deepEqual(result.executableCandidates, []);
  });
});

describe("source provenance", () => {
  test("the charter's documentation URL is recorded with what happened to it", () => {
    assert.equal(N8N_SOURCES.retrievedAt, "2026-09-18");
    assert.match(N8N_SOURCES.charterUrlStatus, /404/);
    assert.match(N8N_SOURCES.standardParameters, /create-nodes/);
  });
});

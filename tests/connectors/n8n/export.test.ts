import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { readN8nNode } from "../../../src/server/connectors/formats/n8n/read.js";
import {
  N8N_EXPORT_EXTENSION_KEYS,
  exportN8nStatic,
} from "../../../src/server/connectors/formats/n8n/export.js";
import { automationSupportedSubset } from "../../../src/server/connectors/formats/automation/definition.js";
import {
  declarativeCredentialDescription,
  declarativeIdentity,
  declarativeNodeDescription,
  declarativePackageJson,
  programmaticIdentity,
  programmaticNodeSource,
} from "../fixtures/n8n/node.js";

/*
 * AC-IMP-14 for n8n. A declarative node is nearly all data, so the round trip
 * is nearly lossless — and the parts that are not data are named rather than
 * quietly dropped.
 */

const subset = (definition: Parameters<typeof exportN8nStatic>[0]) =>
  automationSupportedSubset(definition, N8N_EXPORT_EXTENSION_KEYS);

describe("exporting an n8n description", () => {
  test("read, export and read again agree on the supported subset", async () => {
    const read = () =>
      readN8nNode({
        json: declarativeNodeDescription,
        credentialsJson: declarativeCredentialDescription,
        packageJson: declarativePackageJson,
        identity: declarativeIdentity,
      });
    const first = await read();
    const exported = exportN8nStatic(first.definition);
    const second = await readN8nNode({
      json: JSON.parse(new TextDecoder().decode(exported.bytes)) as unknown,
      credentialsJson: declarativeCredentialDescription,
      packageJson: declarativePackageJson,
      identity: declarativeIdentity,
    });
    assert.deepEqual(subset(second.definition), subset(first.definition));
  });

  test("the exported document is an n8n node description", async () => {
    const first = await readN8nNode({
      json: declarativeNodeDescription,
      credentialsJson: declarativeCredentialDescription,
      packageJson: declarativePackageJson,
      identity: declarativeIdentity,
    });
    const document = exportN8nStatic(first.definition).document as Record<
      string,
      unknown
    >;
    assert.equal(document["name"], "meterly");
    assert.equal(document["displayName"], "Meterly");
    assert.deepEqual(document["version"], [1, 2]);
    assert.equal(document["defaultVersion"], 2);
    assert.deepEqual(document["credentials"], [
      { name: "meterlyApi", required: true },
    ]);
    assert.deepEqual(document["requestDefaults"], {
      baseURL: "https://api.meterly.example",
    });
    // Expressions travel verbatim, as the inert text they always were.
    const properties = document["properties"] as Array<Record<string, unknown>>;
    const limit = properties.find((item) => item["name"] === "limit");
    assert.deepEqual(limit?.["routing"], {
      request: { qs: { limit: "={{$value}}" } },
    });
    assert.equal(
      document["subtitle"],
      '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    );
  });

  test("the credential is not smuggled into the node document", async () => {
    const first = await readN8nNode({
      json: declarativeNodeDescription,
      credentialsJson: declarativeCredentialDescription,
      packageJson: declarativePackageJson,
      identity: declarativeIdentity,
    });
    const exported = exportN8nStatic(first.definition);
    const serialized = JSON.stringify(exported.document);
    assert.ok(!serialized.includes("X-Meterly-Key"));
    assert.ok(!serialized.includes("$credentials"));
    assert.ok(
      exported.losses
        .map((loss) => loss.code)
        .includes("export.n8n.credential-separate"),
    );
  });

  test("a programmatic node reports that the export cannot run", async () => {
    const first = await readN8nNode({
      sourceText: programmaticNodeSource("/tmp/n8n-export-sentinel-never"),
      identity: programmaticIdentity,
    });
    const exported = exportN8nStatic(first.definition);
    const loss = exported.losses.find(
      (item) => item.code === "export.n8n.programmatic-node",
    );
    assert.ok(loss);
    assert.equal(loss.severity, "blocking");
    assert.equal(loss.executionImpact, "blocks-operation");
    assert.match(loss.message, /execute/);
    const serialized = JSON.stringify(exported.document);
    assert.ok(!serialized.includes("execSync"));
  });

  test("a description from another ecosystem is refused, not translated", async () => {
    const first = await readN8nNode({
      json: declarativeNodeDescription,
      identity: declarativeIdentity,
    });
    const exported = exportN8nStatic({
      ...first.definition,
      identity: { ...first.definition.identity, ecosystem: "zapier" },
    });
    assert.deepEqual(exported.document, {});
    assert.equal(exported.losses[0]?.code, "export.n8n.wrong-ecosystem");
  });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  importKamelet,
  kameletSourceRecord,
  KAMELET_CATALOG_SOURCE,
  KAMELET_CATALOG_VERSION,
} from "../../../src/server/connectors/formats/camel-kamelet/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { verifyNormalizedDigest } from "../../../src/core/connectors/index.js";
import { canaries } from "../fixtures/builders.js";

/*
 * Import is the whole contract here: what a Kamelet is, which parameters are
 * credentials, and what provenance survives. Every fixture is read from disk
 * as bytes, so the bounded parser is exercised on real YAML rather than on an
 * object literal the test built.
 */

const fixture = (name: string) =>
  readFile(
    fileURLToPath(new URL(`../fixtures/camel-kamelet/${name}`, import.meta.url)),
  );

const importFixture = async (name: string) =>
  importKamelet(new Uint8Array(await fixture(name)), {
    sourceRef: `source:${name}`,
    origin: { kind: "upload" },
    mediaType: "application/yaml",
  });

test("a source Kamelet imports with its catalog release, provenance and role", async () => {
  const imported = await importFixture("aws-s3-source.kamelet.yaml");
  assert.equal(imported.kameletType, "source");
  assert.equal(imported.identity.ecosystem, "camel-kamelet");
  assert.equal(imported.identity.nativeId, "fixture-object-store-source");
  // The document's own catalog.version annotation is the pinned version.
  assert.equal(imported.identity.nativeVersion, "4.22.0");
  assert.equal(imported.provenance.catalogVersion, KAMELET_CATALOG_VERSION);
  assert.equal(imported.provenance.catalogVersionDeclared, true);
  assert.equal(imported.provenance.provider, "Ceremony fixtures");
  assert.equal(imported.provenance.group, "Object store");
  assert.equal(imported.provenance.namespace, "Storage");
  assert.equal(imported.provenance.supportLevel, "Stable");
  assert.equal(imported.provenance.verified, true);
  // Only the scheme is read out of the template, never the placeholders.
  assert.equal(imported.provenance.scheme, "aws2-s3");
  assert.deepEqual(imported.provenance.dependencies, [
    "camel:core",
    "camel:aws2-s3",
    "camel:kamelet",
  ]);
  assert.equal(imported.identity.authorityNamespace, "Storage");
  assert.equal(await verifyNormalizedDigest(imported.definition), true);
});

test("credential properties are classified secret from the catalog's own markers", async () => {
  const imported = await importFixture("aws-s3-source.kamelet.yaml");
  const byName = new Map(
    imported.properties.map((property) => [property.name, property]),
  );
  for (const name of ["accessKey", "secretKey"]) {
    const property = byName.get(name);
    assert.ok(property, `${name} is imported`);
    assert.equal(property.classification, "secret");
    assert.equal(property.secrecySource, "credentials-descriptor");
  }
  assert.equal(byName.get("bucketName")?.classification, "public");
  assert.equal(byName.get("bucketName")?.required, true);
  assert.equal(byName.get("region")?.required, true);
  assert.equal(byName.get("deleteAfterRead")?.required, false);
  assert.equal(byName.get("deleteAfterRead")?.default, true);
  assert.deepEqual(byName.get("region")?.enumValues, ["eu-west-1", "us-east-1"]);
  // No heuristic was needed, so none is reported.
  assert.equal(
    imported.issues.some(
      (issue) => issue.code === "kamelet.property.credential-unmarked",
    ),
    false,
  );
});

test("an unmarked credential is raised to secret and the heuristic is reported", async () => {
  const imported = await importFixture("unmarked-credential.kamelet.yaml");
  const apiKey = imported.properties.find(
    (property) => property.name === "apiKey",
  );
  assert.ok(apiKey);
  assert.equal(apiKey.classification, "secret");
  assert.equal(apiKey.secrecySource, "name-heuristic");
  assert.ok(
    imported.issues.some(
      (issue) => issue.code === "kamelet.property.credential-unmarked",
    ),
    "the heuristic is visible, not silent",
  );
  // A default on a credential is dropped rather than carried into the model.
  assert.equal(apiKey.hasDefault, true);
  assert.equal(apiKey.default, undefined);
  assert.ok(
    imported.issues.some(
      (issue) => issue.code === "kamelet.property.secret-default",
    ),
  );
  const serialized = JSON.stringify(imported.definition);
  assert.equal(
    serialized.includes("CANARY_FIXTURE_DEFAULT_KEY"),
    false,
    "a credential default never reaches the normalized definition",
  );
  void canaries;
});

test("a credential-bearing Kamelet declares external execution custody, not an invented login", async () => {
  const imported = await importFixture("aws-s3-source.kamelet.yaml");
  assert.equal(imported.definition.authentication.length, 1);
  const profile = imported.definition.authentication[0]!;
  assert.equal(profile.kind, "external-broker");
  assert.equal(
    profile.kind === "external-broker" ? profile.custody : undefined,
    "external-execution-broker",
  );
  const issue = imported.issues.find(
    (item) => item.code === "kamelet.credentials.runner-held",
  );
  assert.ok(issue);
  assert.equal(issue.category, "security");
  assert.equal(issue.executionImpact, "blocks-authorization");
});

test("a Kamelet with no credentials declares no credential explicitly", async () => {
  const imported = await importFixture("log-sink.kamelet.yaml");
  assert.equal(imported.kameletType, "sink");
  const profile = imported.definition.authentication[0]!;
  assert.equal(profile.kind, "none");
  assert.equal(
    imported.properties.every(
      (property) => property.classification === "public",
    ),
    true,
  );
});

test("source, sink and action stay three different things", async () => {
  const source = await importFixture("aws-s3-source.kamelet.yaml");
  const sink = await importFixture("log-sink.kamelet.yaml");
  const action = await importFixture("insert-header-action.kamelet.yaml");
  assert.equal(source.definition.capabilities[0]!.effect, "read");
  assert.equal(sink.definition.capabilities[0]!.effect, "write");
  assert.equal(action.definition.capabilities[0]!.effect, "unknown");
  // Only a source describes an event, and its transport is honestly unsupported.
  assert.equal(source.definition.events.length, 1);
  assert.equal(source.definition.events[0]!.transport, "unsupported");
  assert.equal(source.definition.events[0]!.nativeTransport, "aws2-s3");
  assert.equal(sink.definition.events.length, 0);
  assert.equal(action.definition.events.length, 0);
});

test("the route template is preserved as a description and never executed", async () => {
  const imported = await importFixture("aws-s3-source.kamelet.yaml");
  const issue = imported.issues.find(
    (item) => item.code === "kamelet.template.not-executed",
  );
  assert.ok(issue);
  assert.equal(issue.category, "executable-code");
  assert.equal(issue.executionImpact, "blocks-operation");
  assert.equal(
    imported.definition.compatibility.dimensions["invoke"],
    "requires-configuration",
  );
  // A template is not a destination: nothing declares a server to contact.
  assert.deepEqual(imported.definition.declaredServers, []);
});

test("hostile YAML is refused within bounds and with a sanitized code", async () => {
  const cases: Array<[string, string]> = [
    ["duplicate-keys.kamelet.yaml", "invalid-request"],
    ["unsupported-tag.kamelet.yaml", "invalid-request"],
    ["alias-bomb.kamelet.yaml", "invalid-request"],
    ["merge-key.kamelet.yaml", "invalid-request"],
  ];
  for (const [name, code] of cases) {
    await assert.rejects(
      () => importFixture(name),
      (error: unknown) => {
        assert.ok(error instanceof ConnectorError, `${name} threw a ConnectorError`);
        assert.equal(error.code, code);
        // The message says nothing about the document's contents.
        assert.equal(/target|python|os\.system/i.test(error.message), false);
        return true;
      },
      name,
    );
  }
});

test("a non-Kamelet document is refused rather than partly described", async () => {
  const bytes = new TextEncoder().encode(
    "apiVersion: dapr.io/v1alpha1\nkind: Component\nmetadata:\n  name: x\nspec:\n  type: bindings.kafka\n",
  );
  await assert.rejects(
    () =>
      importKamelet(bytes, {
        sourceRef: "source:wrong",
        origin: { kind: "upload" },
      }),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "invalid-request",
  );
});

test("the source record carries the exact byte digest and the catalog release", async () => {
  const bytes = new Uint8Array(await fixture("aws-s3-source.kamelet.yaml"));
  const imported = await importKamelet(bytes, {
    sourceRef: "source:s3",
    origin: { kind: "url", location: "https://camel.example/kamelets/s3.yaml" },
  });
  const record = kameletSourceRecord({
    sourceRef: "source:s3",
    identity: imported.identity,
    origin: { kind: "url", location: "https://camel.example/kamelets/s3.yaml" },
    bytes,
    mediaType: "application/yaml",
    capturedAt: "2026-09-18T00:00:00.000Z",
    catalogVersion: imported.provenance.catalogVersion,
  });
  assert.equal(record.byteLength, bytes.byteLength);
  assert.equal(record.digest.value, imported.byteDigest);
  assert.equal(record.format.version, KAMELET_CATALOG_VERSION);
  assert.equal(record.license?.spdx, "Apache-2.0");
  assert.equal(KAMELET_CATALOG_SOURCE.tag, "v4.22.0");
});

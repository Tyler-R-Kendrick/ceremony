import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  DAPR_SOURCE,
  daprDirectionFor,
  importDaprComponent,
} from "../../../src/server/connectors/providers/dapr/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { verifyNormalizedDigest } from "../../../src/core/connectors/index.js";

/*
 * A component file is configuration, not an API description. These tests fix
 * what survives import: the building block, the binding direction as the
 * pinned reference states it, credential handling, and an honest "unverified"
 * when the reference says nothing.
 */

const fixture = async (name: string) =>
  new Uint8Array(
    await readFile(
      fileURLToPath(new URL(`../fixtures/dapr/${name}`, import.meta.url)),
    ),
  );

const importFixture = async (name: string) =>
  importDaprComponent(await fixture(name), {
    sourceRef: `source:${name}`,
    origin: { kind: "upload" },
    mediaType: "application/yaml",
  });

test("a bidirectional binding component imports with both roles described", async () => {
  const imported = await importFixture("kafka-binding.yaml");
  assert.equal(imported.componentType, "bindings.kafka");
  assert.equal(imported.buildingBlock, "bindings");
  assert.equal(imported.isBinding, true);
  assert.equal(imported.direction, "both");
  assert.equal(imported.directionVerified, true);
  assert.equal(imported.identity.nativeId, "orders-topic");
  assert.equal(imported.identity.authorityNamespace, "fixtures");
  assert.equal(imported.identity.nativeVersion, "v1");
  assert.deepEqual(imported.scopes, ["ceremony-fixture-app"]);
  // Output invocation and input delivery are described separately.
  assert.equal(imported.definition.capabilities.length, 1);
  assert.equal(imported.definition.capabilities[0]!.effect, "write");
  assert.equal(imported.definition.events.length, 1);
  assert.equal(imported.definition.events[0]!.transport, "http-webhook");
  assert.equal(imported.definition.events[0]!.verification, "vendor");
  assert.equal(await verifyNormalizedDigest(imported.definition), true);
});

test("an input-only binding describes an event and no invocation", async () => {
  const imported = await importFixture("cron-binding.yaml");
  assert.equal(imported.direction, "input");
  assert.equal(imported.definition.capabilities.length, 0);
  assert.equal(imported.definition.events.length, 1);
  assert.deepEqual(imported.executableCandidates, []);
  assert.equal(
    imported.definition.compatibility.dimensions["invoke"],
    "unsupported",
  );
});

test("an output-only binding describes an invocation and no event", async () => {
  const imported = await importFixture("http-binding.yaml");
  assert.equal(imported.direction, "output");
  assert.equal(imported.definition.capabilities.length, 1);
  assert.equal(imported.definition.events.length, 0);
  assert.deepEqual(imported.executableCandidates, ["partner-webhook"]);
});

test("a binding type the pinned reference does not cover is unverified, not guessed", async () => {
  const imported = await importFixture("unknown-binding.yaml");
  assert.equal(daprDirectionFor("bindings.exoticqueue"), "unknown");
  assert.equal(imported.direction, "unknown");
  assert.equal(imported.directionVerified, false);
  const issue = imported.issues.find(
    (item) => item.code === "dapr.binding.direction-unverified",
  );
  assert.ok(issue);
  assert.ok(issue.message.includes(DAPR_SOURCE.runtimeDocsVersion));
  assert.equal(imported.definition.capabilities.length, 0);
  assert.equal(imported.definition.events.length, 0);
});

test("credential metadata is imported as a name and a source, never as a value", async () => {
  const kafka = await importFixture("kafka-binding.yaml");
  const password = kafka.metadata.find(
    (entry) => entry.name === "saslPassword",
  );
  assert.ok(password);
  assert.equal(password.classification, "secret");
  assert.equal(password.fromSecretStore, true);
  assert.deepEqual(password.secretStoreRef, {
    name: "kafka-secret",
    key: "saslPassword",
  });
  assert.equal(password.value, undefined);

  const http = await importFixture("http-binding.yaml");
  const token = http.metadata.find((entry) => entry.name === "securityToken");
  assert.ok(token);
  assert.equal(token.classification, "secret");
  assert.equal(token.fromSecretStore, false);
  assert.equal(
    token.value,
    undefined,
    "an inlined credential value is dropped",
  );
  assert.ok(
    http.issues.some(
      (issue) => issue.code === "dapr.metadata.inline-credential",
    ),
  );
  assert.equal(
    JSON.stringify(http.definition).includes("CANARY_INLINE_TOKEN_4b7"),
    false,
  );
  // Non-credential values are preserved for review.
  assert.equal(
    http.metadata.find((entry) => entry.name === "url")?.value,
    "https://partner.fixture.invalid/hook",
  );
});

test("a non-binding component is described but has no invocation profile", async () => {
  const imported = await importFixture("statestore-component.yaml");
  assert.equal(imported.isBinding, false);
  assert.equal(imported.buildingBlock, "state");
  const issue = imported.issues.find(
    (item) => item.code === "dapr.component.not-a-binding",
  );
  assert.ok(issue);
  assert.equal(issue.executionImpact, "blocks-definition");
  assert.equal(imported.definition.capabilities.length, 0);
});

test("every import records that the sidecar is never a generic proxy", async () => {
  for (const name of ["kafka-binding.yaml", "http-binding.yaml"]) {
    const imported = await importFixture(name);
    assert.ok(
      imported.issues.some(
        (issue) => issue.code === "dapr.sidecar.never-a-browser-proxy",
      ),
      name,
    );
  }
});

test("duplicate keys and the wrong apiVersion are refused with sanitized codes", async () => {
  await assert.rejects(
    () => importFixture("duplicate-keys.yaml"),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "invalid-request",
  );
  await assert.rejects(
    () =>
      importDaprComponent(
        new TextEncoder().encode(
          "apiVersion: dapr.io/v2\nkind: Component\nmetadata:\n  name: x\nspec:\n  type: bindings.kafka\n",
        ),
        { sourceRef: "source:x", origin: { kind: "upload" } },
      ),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "unsupported" &&
      error.detail === "dapr.component.api-version",
  );
});

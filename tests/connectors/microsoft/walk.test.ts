import assert from "node:assert/strict";
import test from "node:test";
import type { CompatibilityIssue } from "../../../src/core/connectors/index.js";
import {
  SWAGGER_WALK_LIMITS,
  walkSwagger,
  type SwaggerWalk,
} from "../../../src/server/connectors/formats/microsoft/swagger-walk.js";

/*
 * MS-W: what the bounded Swagger 2.0 walk refuses, and whether the refusal
 * names the right fault. The walk is the only seam between the Microsoft
 * reader and an untrusted document, and its claim is narrow and checkable: it
 * fetches nothing, evaluates nothing, and copies nothing it has not measured.
 * So the interesting cases are not well-formed documents — import.test.ts
 * covers the fixture connector end to end — but the ones a document can use to
 * make the reader loop, grow, reach outside itself, or describe two different
 * operations under one name.
 *
 * Every issue here is checked by code, severity and pointer, because a
 * diagnostic that says the wrong thing is worse than none: downstream policy
 * decides what may be bound from exactly these fields.
 */

const base = (
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  swagger: "2.0",
  info: { title: "Fixture", version: "1.0" },
  paths: {},
  ...extra,
});

/** One GET operation at `/items`, with whatever the case under test needs. */
const withOperation = (
  operation: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> =>
  base({ paths: { "/items": { get: operation } }, ...extra });

function walkOk(document: unknown): {
  walk: SwaggerWalk;
  issues: CompatibilityIssue[];
} {
  const result = walkSwagger(document);
  assert.ok(result.ok, "expected the document to be described");
  return { walk: result.walk, issues: result.issues };
}

function issueOf(
  issues: readonly CompatibilityIssue[],
  code: string,
): CompatibilityIssue {
  const found = issues.find((issue) => issue.code === code);
  assert.ok(
    found,
    `expected issue ${code}, saw ${issues.map((issue) => issue.code).join(", ")}`,
  );
  return found;
}

const codesOf = (issues: readonly CompatibilityIssue[]) =>
  issues.map((issue) => issue.code);

test("a document is measured before it is read, and an unmeasurable one is refused whole", () => {
  // Invariant: bounds come first. Every later step assumes finite depth and
  // size, so a document that exceeds them must produce no walk at all — a
  // partially walked hostile document would still be handed to the importer.
  let deep: unknown = "leaf";
  for (let index = 0; index < 80; index += 1) deep = { nest: deep };
  const nested = walkSwagger(deep);
  assert.equal(nested.ok, false);
  const bounds = issueOf(nested.issues, "structure.document-bounds");
  assert.equal(bounds.severity, "blocking");
  assert.equal(bounds.executionImpact, "blocks-definition");
  assert.equal(bounds.sourcePointer, "#");
  assert.ok(
    bounds.message.includes("depth"),
    "the diagnostic names which bound was exceeded",
  );

  // A value JSON cannot represent is refused for what it is, not coerced.
  for (const notJson of [{ n: Number.NaN }, { n: Infinity }])
    assert.equal(walkSwagger(notJson).ok, false);
});

test("a definition that is not a JSON object is refused before any version check", () => {
  // Invariant: "not an object" and "wrong version" are different faults and a
  // person fixing the document needs to be told which. An array or a string is
  // not a Swagger document at all, so it must not be reported as a version
  // problem.
  for (const notAnObject of ["swagger: 2.0", 42, null, true, ["2.0"]]) {
    const result = walkSwagger(notAnObject);
    assert.equal(result.ok, false, JSON.stringify(notAnObject));
    assert.equal(
      result.issues[0]?.code,
      "structure.not-an-object",
      JSON.stringify(notAnObject),
    );
    assert.equal(result.issues[0]?.executionImpact, "blocks-definition");
  }
});

test("an OpenAPI 3 document is refused as the wrong format, not as a broken one", () => {
  // Invariant: Power Platform accepts Swagger 2.0 only, and an OpenAPI 3
  // document is a *valid* document of another format. Reporting it as
  // unrecognized would send an author looking for a typo; reporting it as
  // unsupported with a remediation tells them the truth and what to do.
  const three = walkSwagger({
    openapi: "3.0.3",
    info: { title: "Fixture", version: "1.0" },
    paths: {},
  });
  assert.equal(three.ok, false);
  const issue = issueOf(three.issues, "version.openapi-3-unsupported");
  assert.equal(issue.category, "version");
  assert.equal(issue.disposition, "unsupported");
  assert.equal(issue.sourcePointer, "#/openapi");
  assert.ok(issue.remediation, "an unsupported format offers a way forward");

  // A document declaring no version at all is a different, rejected fault.
  const unknown = walkSwagger({ swagger: "1.2", info: {}, paths: {} });
  assert.equal(unknown.ok, false);
  const unrecognized = issueOf(unknown.issues, "version.unrecognized");
  assert.equal(unrecognized.disposition, "rejected");
  assert.equal(unrecognized.sourcePointer, "#/swagger");
});

test("a cyclic or self-referential reference chain is refused by the cycle guard", () => {
  // Invariant: the resolver must terminate on any document. A `$ref` cycle is
  // the classic way to hang an importer, and the refusal has to name the
  // chain as cyclic rather than as a missing target, because the target
  // exists — the loop is the fault.
  const mutual = walkOk(
    withOperation(
      { operationId: "GetItems", parameters: [{ $ref: "#/parameters/A" }] },
      {
        parameters: {
          A: { $ref: "#/parameters/B" },
          B: { $ref: "#/parameters/A" },
        },
      },
    ),
  );
  const cycle = issueOf(mutual.issues, "structure.reference-cycle");
  assert.equal(cycle.severity, "blocking");
  assert.equal(cycle.executionImpact, "blocks-operation");
  assert.deepEqual(
    mutual.walk.operations[0]?.parameters,
    [],
    "no half-resolved parameter survives the cycle",
  );

  const self = walkOk(
    withOperation(
      { operationId: "GetItems", parameters: [{ $ref: "#/parameters/Self" }] },
      { parameters: { Self: { $ref: "#/parameters/Self" } } },
    ),
  );
  assert.ok(codesOf(self.issues).includes("structure.reference-cycle"));

  // A chain longer than the reference depth allows is the same refusal: the
  // guard bounds work, not just repetition.
  const chain: Record<string, unknown> = {};
  const links = SWAGGER_WALK_LIMITS.refDepth + 4;
  for (let index = 0; index < links; index += 1)
    chain[`L${index}`] = { $ref: `#/parameters/L${index + 1}` };
  chain[`L${links}`] = { name: "id", in: "query" };
  const long = walkOk(
    withOperation(
      { operationId: "GetItems", parameters: [{ $ref: "#/parameters/L0" }] },
      { parameters: chain },
    ),
  );
  assert.ok(codesOf(long.issues).includes("structure.reference-cycle"));
  assert.deepEqual(long.walk.operations[0]?.parameters, []);
});

test("a reference that leaves the document is never followed", () => {
  // Invariant: import fetches nothing. A remote or relative `$ref` is refused
  // on sight — not attempted and then reported as unreachable — so that an
  // import can never become an outbound request chosen by the document.
  for (const ref of [
    "https://evil.example/swagger.json#/parameters/A",
    "//evil.example/x.json#/a",
    "../sibling.json#/parameters/A",
    "file:///etc/passwd",
    "parameters/A",
    `#/parameters/${"x".repeat(1100)}`,
  ]) {
    const result = walkOk(
      withOperation({ operationId: "GetItems", parameters: [{ $ref: ref }] }),
    );
    const issue = issueOf(result.issues, "structure.remote-reference");
    assert.equal(issue.disposition, "unsupported", ref);
    assert.equal(issue.executionImpact, "blocks-operation", ref);
    assert.ok(issue.remediation, ref);
    assert.deepEqual(result.walk.operations[0]?.parameters, [], ref);
  }
});

test("a local reference must land on something, and never on a prototype key", () => {
  // Invariant: a pointer that resolves to nothing is rejected rather than
  // treated as an empty object, because an empty parameter or response would
  // be described as if the document had declared it. `__proto__` is refused as
  // a path segment whatever the document says: it names runtime machinery, not
  // a definition.
  const cases: Array<[string, unknown]> = [
    ["#/parameters/Missing", undefined],
    ["#/definitions/__proto__", undefined],
    ["#/definitions/List/notanindex", undefined],
    ["#/definitions/List/9999999", undefined],
    ["#/definitions/Title/deeper", undefined],
  ];
  for (const [ref] of cases) {
    const result = walkOk(
      withOperation(
        { operationId: "GetItems", parameters: [{ $ref: ref }] },
        { definitions: { List: [{ name: "id", in: "query" }], Title: "text" } },
      ),
    );
    const issue = issueOf(result.issues, "structure.unresolved-reference");
    assert.equal(issue.disposition, "rejected", ref);
    assert.deepEqual(result.walk.operations[0]?.parameters, [], ref);
  }

  // The same machinery resolves a legitimate index into an array of parameters.
  const resolved = walkOk(
    withOperation(
      {
        operationId: "GetItems",
        parameters: [{ $ref: "#/definitions/List/0" }],
      },
      { definitions: { List: [{ name: "id", in: "query", type: "string" }] } },
    ),
  );
  assert.deepEqual(
    resolved.walk.operations[0]?.parameters.map((parameter) => parameter.name),
    ["id"],
  );
  assert.equal(
    ({} as Record<string, unknown>)["polluted"],
    undefined,
    "no runtime object was mutated while resolving",
  );
});

test("a recursive schema is legal, and indexing stops at the first repetition", () => {
  // Invariant: a self-referential *schema* is ordinary and valid (a tree
  // node), unlike a `$ref` cycle with no base case. It must not be refused,
  // and it must not be unrolled: indexing stops at the repetition and says so
  // at info severity, so a report can tell "recursive" from "too deep".
  const result = walkOk(
    withOperation(
      {
        operationId: "CreateTree",
        parameters: [
          { name: "body", in: "body", schema: { $ref: "#/definitions/Node" } },
        ],
      },
      {
        definitions: {
          Node: {
            type: "object",
            "x-ms-visibility": "advanced",
            properties: {
              label: { type: "string" },
              child: { $ref: "#/definitions/Node" },
            },
          },
        },
      },
    ),
  );
  const recursive = issueOf(result.issues, "structure.recursive-schema");
  assert.equal(recursive.severity, "info");
  assert.equal(recursive.category, "schema");
  assert.equal(recursive.disposition, "exact");
  assert.equal(
    result.walk.operations[0]?.identity,
    "operationId",
    "recursion does not cost the operation its identity",
  );
  assert.deepEqual(
    result.walk.operations[0]?.parameters[0]?.nested.map(
      (node) => node.pathString,
    ),
    [""],
    "the recursive node is indexed once, not once per level",
  );
});

test("schema indexing is bounded in depth and in node count, and says where it stopped", () => {
  // Invariant: the index is advisory (it locates extensions, passwords and
  // defaults), so running out of budget must degrade into a stated gap rather
  // than an exception or a silently short list. A caller that cannot tell a
  // complete index from a truncated one would report "no password fields" for
  // a document it never finished reading.
  let deep: Record<string, unknown> = {
    type: "string",
    "x-ms-summary": "Leaf",
  };
  for (let index = 0; index < SWAGGER_WALK_LIMITS.schemaDepth + 2; index += 1)
    deep = { type: "object", properties: { child: deep } };
  const nested = walkOk(
    withOperation({
      operationId: "CreateDeep",
      parameters: [{ name: "body", in: "body", schema: deep }],
    }),
  );
  const depth = issueOf(nested.issues, "structure.schema-depth");
  assert.equal(depth.severity, "warning");
  assert.equal(depth.disposition, "adapted");
  assert.ok(
    depth.message.includes(String(SWAGGER_WALK_LIMITS.schemaDepth)),
    "the limit it hit is stated, not implied",
  );

  const properties: Record<string, unknown> = {};
  for (let index = 0; index < SWAGGER_WALK_LIMITS.schemaNodes + 8; index += 1)
    properties[`p${index}`] = { type: "string" };
  const wide = walkOk(
    withOperation({
      operationId: "CreateWide",
      parameters: [
        { name: "body", in: "body", schema: { type: "object", properties } },
      ],
    }),
  );
  const nodes = issueOf(wide.issues, "structure.schema-bounds");
  assert.equal(nodes.severity, "warning");
  assert.equal(nodes.sourcePointer, "#/paths/~1items/get/parameters/0/schema");
});

test("extensions hidden under items or allOf are indexed, and passwords and defaults are found without one", () => {
  // Invariant: the nested index is what downstream policy uses to find
  // `x-ms-*` behaviour, password fields and server-side defaults. Anything it
  // misses becomes a silent capability: a password inside an array element, or
  // an `allOf` fragment that sets a default, would be invisible to every later
  // check. Each indexed node also carries the path string Power Platform uses,
  // so a finding can be pointed at a field.
  const result = walkOk(
    withOperation({
      operationId: "CreateItem",
      parameters: [
        {
          name: "body",
          in: "body",
          schema: {
            type: "object",
            required: ["secret"],
            properties: {
              secret: { type: "string", format: "password" },
              retries: { type: "integer", default: 3 },
              tags: {
                type: "array",
                items: { type: "string", "x-ms-summary": "Tag" },
              },
            },
            allOf: [{ type: "object", "x-ms-trigger": "single" }],
          },
        },
      ],
    }),
  );
  const nested = result.walk.operations[0]?.parameters[0]?.nested ?? [];
  const byPath = new Map(nested.map((node) => [node.pathString, node]));
  assert.equal(byPath.get("secret")?.format, "password");
  assert.equal(
    byPath.get("secret")?.required,
    true,
    "requiredness comes from the parent's required list, not from the child",
  );
  assert.equal(byPath.get("retries")?.hasDefault, true);
  assert.equal(byPath.get("retries")?.default, 3);
  assert.deepEqual(byPath.get("tags/items")?.extensions, {
    "x-ms-summary": "Tag",
  });
  assert.ok(
    nested.some((node) => "x-ms-trigger" in node.extensions),
    "an allOf fragment's extensions are indexed",
  );
  assert.equal(
    byPath.get("secret")?.pointer,
    "#/paths/~1items/get/parameters/0/schema/properties/secret",
    "each indexed node is locatable in the source document",
  );
});

test("an extension value is measured before it is kept, and kept as a marker when it is too large", () => {
  // Invariant: extensions are carried verbatim into the description, so they
  // are the one place an unbounded document reaches storage. A value over
  // bounds is replaced by a marker naming the reason — not truncated into a
  // smaller value that would then be reported as what the document said.
  let deep: unknown = "leaf";
  for (
    let index = 0;
    index < SWAGGER_WALK_LIMITS.extensionValue.depth + 4;
    index += 1
  )
    deep = { nest: deep };
  const result = walkOk(
    withOperation({ operationId: "GetItems", "x-ms-huge": deep }),
  );
  const truncated = issueOf(result.issues, "structure.extension-truncated");
  assert.equal(truncated.severity, "warning");
  assert.equal(truncated.disposition, "adapted");
  assert.equal(
    truncated.sourcePointer,
    "#/paths/~1items/get/x-ms-huge",
    "the diagnostic points at the extension, not at the operation",
  );
  assert.deepEqual(result.walk.operations[0]?.extensions["x-ms-huge"], {
    $truncated: "depth",
  });
});

test("only well-formed extension keys are kept, and there is a ceiling on how many", () => {
  // Invariant: extension keys become object keys in the description, so a key
  // with a control character or an unbounded length is refused, and a document
  // cannot decide how many it gets to contribute. Hitting the ceiling is
  // reported, because the alternative is a description that silently omits
  // behaviour the document declared.
  const operation: Record<string, unknown> = { operationId: "GetItems" };
  for (let index = 0; index < SWAGGER_WALK_LIMITS.extensionKeys + 6; index += 1)
    operation[`x-ms-e${index}`] = index;
  operation[`x-ms-bad${String.fromCharCode(7)}key`] = "control character";
  operation[`x-ms-${"long".repeat(40)}`] = "over-long key";
  operation["ms-not-an-extension"] = "no x- prefix";
  const result = walkOk(withOperation(operation));
  const count = issueOf(result.issues, "structure.extension-count");
  assert.equal(count.severity, "warning");
  const kept = result.walk.operations[0]?.extensions ?? {};
  assert.equal(Object.keys(kept).length, SWAGGER_WALK_LIMITS.extensionKeys);
  assert.ok(
    Object.keys(kept).every((key) => key.startsWith("x-")),
    "only vendor extensions are collected",
  );
  assert.ok(
    !Object.keys(kept).some((key) => /\p{Cc}/u.test(key)),
    "a key with a control character is never kept",
  );
  assert.equal(kept["ms-not-an-extension"], undefined);
});

test("a missing title or version is filled with a stated placeholder, not invented quietly", () => {
  // Invariant: the walk always yields a name, because everything downstream
  // needs one — but it must never let a placeholder pass for something the
  // document said. The title substitution is reported; the version fallback is
  // visible in the walk itself.
  const result = walkOk(base({ info: {} }));
  assert.equal(result.walk.info.title, "Custom connector");
  assert.equal(result.walk.info.version, "unversioned");
  assert.equal(result.walk.info.description, undefined);
  const missing = issueOf(result.issues, "structure.info-title-missing");
  assert.equal(missing.severity, "warning");
  assert.equal(missing.sourcePointer, "#/info/title");

  // A title of only whitespace or control characters is no title either.
  const blank = walkOk(
    base({ info: { title: ` ${String.fromCharCode(9)} `, version: " " } }),
  );
  assert.equal(blank.walk.info.title, "Custom connector");
  assert.equal(blank.walk.info.version, "unversioned");
  assert.ok(codesOf(blank.issues).includes("structure.info-title-missing"));

  // `info` that is not an object is treated as absent rather than read.
  const notAnObject = walkOk(base({ info: "Contoso" }));
  assert.equal(notAnObject.walk.info.title, "Custom connector");
});

test("a path must be one absolute template with no query, fragment or control character", () => {
  // Invariant: a path is a key that later composes a URL. A query string or
  // fragment in it would make two different requests look like one operation,
  // and a control character would make a logged path lie about itself, so each
  // is rejected rather than stripped into a path the document did not declare.
  const paths: Record<string, unknown> = {
    "/ok": { get: { operationId: "Ok" } },
    items: { get: { operationId: "Relative" } },
    "/items?filter=all": { get: { operationId: "Query" } },
    "/items#frag": { get: { operationId: "Fragment" } },
    [`/items${String.fromCharCode(9)}tab`]: { get: { operationId: "Control" } },
    "/items with space": { get: { operationId: "Space" } },
  };
  const result = walkOk(base({ paths }));
  assert.deepEqual(
    result.walk.operations.map((operation) => operation.path),
    ["/ok"],
    "only the well-formed path yields an operation",
  );
  assert.equal(
    result.issues.filter((issue) => issue.code === "structure.invalid-path")
      .length,
    5,
  );
  const invalid = issueOf(result.issues, "structure.invalid-path");
  assert.equal(invalid.severity, "blocking");
  assert.equal(invalid.disposition, "rejected");
  assert.ok(
    !invalid.sourcePointer.includes(String.fromCharCode(9)),
    "a pointer built from a hostile key carries no control character",
  );

  // A path item or operation that is not an object contributes nothing.
  const scalars = walkOk(
    base({ paths: { "/a": 5, "/b": { get: "not an operation" } } }),
  );
  assert.deepEqual(scalars.walk.operations, []);
});

test("a document with no paths, too many paths or too many operations is bounded and says so", () => {
  // Invariant: the walk reports the shape of what it read. A definition with
  // no paths is a real document worth describing, but a reader that said
  // nothing about it would let "no operations" look like a successful import
  // of a rich connector. Over the ceiling, the description holds a prefix and
  // declares that it does.
  const none = walkOk({
    swagger: "2.0",
    info: { title: "Fixture", version: "1.0" },
  });
  const missing = issueOf(none.issues, "structure.paths-missing");
  assert.equal(missing.severity, "warning");
  assert.deepEqual(none.walk.operations, []);
  // A `paths` that is a list is no more a path map than an absent one.
  assert.ok(
    codesOf(walkOk(base({ paths: [] })).issues).includes(
      "structure.paths-missing",
    ),
  );

  const manyPaths: Record<string, unknown> = {};
  for (let index = 0; index < SWAGGER_WALK_LIMITS.paths + 5; index += 1)
    manyPaths[`/p${index}`] = { get: { operationId: `Get${index}` } };
  const paths = walkOk(base({ paths: manyPaths }));
  assert.equal(
    paths.walk.operations.length,
    SWAGGER_WALK_LIMITS.paths,
    "exactly the ceiling is imported",
  );
  assert.equal(
    issueOf(paths.issues, "structure.path-count").sourcePointer,
    "#/paths",
  );

  const manyOperations: Record<string, unknown> = {};
  const methods = ["get", "put", "post", "delete", "options", "head", "patch"];
  for (let index = 0; index < 200; index += 1)
    manyOperations[`/p${index}`] = Object.fromEntries(
      methods.map((method) => [method, { operationId: `${method}${index}` }]),
    );
  const operations = walkOk(base({ paths: manyOperations }));
  assert.equal(
    operations.walk.operations.length,
    SWAGGER_WALK_LIMITS.operations,
  );
  assert.equal(
    issueOf(operations.issues, "structure.operation-count").severity,
    "warning",
  );
});

test("a parameter the walk cannot name or place is refused, and a path parameter is always required", () => {
  // Invariant: a parameter with no usable name or no Swagger 2.0 location
  // cannot be bound to an input, and guessing either would fabricate an
  // argument. Separately, a `path` parameter is required whatever the document
  // says, because the URL cannot be built without it — treating it as
  // optional would produce a request with a literal `{id}` in the path.
  const refused = walkOk(
    withOperation({
      operationId: "GetItems",
      parameters: [
        { name: "noLocation" },
        { in: "query" },
        { name: "__proto__", in: "query" },
        { name: `bad${String.fromCharCode(7)}name`, in: "query" },
        { name: "cookieParam", in: "cookie" },
        { name: "", in: "query" },
      ],
    }),
  );
  assert.deepEqual(refused.walk.operations[0]?.parameters, []);
  assert.equal(
    refused.issues.filter(
      (issue) => issue.code === "structure.invalid-parameter",
    ).length,
    6,
  );
  assert.equal(
    issueOf(refused.issues, "structure.invalid-parameter").executionImpact,
    "blocks-operation",
  );

  const typed = walkOk(
    base({
      paths: {
        "/items/{id}": {
          get: {
            operationId: "GetItem",
            parameters: [
              { name: "id", in: "path" },
              {
                name: "tags",
                in: "query",
                type: "array",
                collectionFormat: "csv",
                items: { type: "string", format: "byte" },
                default: ["a"],
                enum: ["a", "b"],
                description: "Tags to match.",
              },
            ],
          },
        },
      },
    }),
  );
  const parameters = typed.walk.operations[0]?.parameters ?? [];
  const id = parameters.find((parameter) => parameter.name === "id");
  assert.equal(id?.required, true, "a path parameter is required by position");
  const tags = parameters.find((parameter) => parameter.name === "tags");
  assert.equal(tags?.required, false);
  assert.equal(tags?.type, "array");
  assert.equal(tags?.collectionFormat, "csv");
  assert.deepEqual(tags?.items, { type: "string", format: "byte" });
  assert.equal(tags?.hasDefault, true);
  assert.deepEqual(tags?.enum, ["a", "b"]);
  assert.equal(tags?.description, "Tags to match.");
  assert.deepEqual(codesOf(typed.issues), []);
});

test("a path template with no declared parameter is refused rather than sent with a hole in it", () => {
  // Invariant: `{id}` in a path is a promise that an input fills it. With no
  // matching `path` parameter the only options are to send the literal braces
  // or to invent a value; both are wrong, so the operation is blocked at the
  // invoke dimension, which is where the fault would appear.
  const result = walkOk(
    base({
      paths: {
        "/items/{id}/parts/{partId}": {
          get: {
            operationId: "GetPart",
            parameters: [{ name: "id", in: "path" }],
          },
        },
      },
    }),
  );
  const issue = issueOf(result.issues, "structure.path-parameter-undeclared");
  assert.equal(issue.dimension, "invoke");
  assert.equal(issue.severity, "blocking");
  assert.ok(
    issue.message.includes("partId"),
    "the diagnostic names the unfilled template",
  );
  assert.ok(
    !issue.message.includes("{"),
    "the name appears as a bounded token, not as an echoed fragment",
  );
});

test("a path item's shared parameters reach every operation under it", () => {
  // Invariant: Swagger lets a path item declare parameters once for all its
  // methods. Missing them would make a required input disappear from every
  // operation of that path, so the description would claim a call could be
  // made with less than the document requires.
  const result = walkOk(
    base({
      paths: {
        "/items/{id}": {
          parameters: [
            { name: "id", in: "path" },
            { name: "api-version", in: "query", required: true },
          ],
          get: { operationId: "GetItem" },
          delete: {
            operationId: "DeleteItem",
            parameters: [{ name: "force", in: "query" }],
          },
        },
      },
    }),
  );
  for (const operation of result.walk.operations)
    assert.ok(
      operation.parameters.some(
        (parameter) => parameter.name === "api-version",
      ),
      `${operation.nativeId} inherits the shared parameter`,
    );
  const remove = result.walk.operations.find(
    (operation) => operation.method === "DELETE",
  );
  assert.deepEqual(
    remove?.parameters.map((parameter) => parameter.name).sort(),
    ["api-version", "force", "id"],
    "an operation's own parameters are added to, not swapped for, the shared ones",
  );
  assert.deepEqual(codesOf(result.issues), []);
});

test("an operation may not declare more parameters than the reader will read", () => {
  // Invariant: the ceiling is the reader's, and crossing it is blocking rather
  // than adapted: a binding built from the first 64 of 70 declared parameters
  // would silently drop inputs the document requires, which is a wrong call,
  // not a smaller one.
  const parameters = Array.from(
    { length: SWAGGER_WALK_LIMITS.parameters + 6 },
    (_, index) => ({ name: `p${index}`, in: "query" }),
  );
  const result = walkOk(withOperation({ operationId: "GetItems", parameters }));
  const issue = issueOf(result.issues, "structure.parameter-count");
  assert.equal(issue.severity, "blocking");
  assert.equal(issue.executionImpact, "blocks-operation");
  assert.equal(issue.sourcePointer, "#/paths/~1items/get/parameters");
  assert.equal(
    result.walk.operations[0]?.parameters.length,
    SWAGGER_WALK_LIMITS.parameters,
  );
});

test("only status keys Swagger 2.0 allows become responses", () => {
  // Invariant: a response key is the contract for what a caller may expect
  // back. Reading "200 OK" or "6xx" as a status would let a description claim
  // a response class the specification has no meaning for, and downstream
  // matching would then never fire for it.
  const result = walkOk(
    withOperation({
      operationId: "GetItems",
      responses: {
        "200": {
          description: "Fine.",
          schema: {
            type: "object",
            properties: { token: { type: "string", format: "password" } },
          },
          headers: { "x-rate-limit": { type: "integer" }, "": {} },
          "x-ms-summary": "Fine",
        },
        "2XX": { description: "A class." },
        default: { description: "Anything else." },
        "200 OK": { description: "Not a status." },
        "6XX": { description: "No such class." },
        "99": { description: "Not a status." },
        "301": "not an object",
      },
    }),
  );
  const responses = result.walk.operations[0]?.responses ?? [];
  assert.deepEqual(responses.map((response) => response.status).sort(), [
    "200",
    "2XX",
    "default",
  ]);
  const ok = responses.find((response) => response.status === "200");
  assert.deepEqual(
    ok?.headers,
    ["x-rate-limit"],
    "an unnamed header is dropped",
  );
  assert.deepEqual(ok?.extensions, { "x-ms-summary": "Fine" });
  assert.deepEqual(
    ok?.nested.map((node) => node.pathString),
    ["token"],
    "a password in a response body is indexed too",
  );
});

test("an unusable operationId is adapted to method and path, and the substitution is reported", () => {
  // Invariant: the native id is what a binding refers to. An id with a
  // control character, an empty id or one naming prototype machinery cannot be
  // used, so the operation keeps a derived identity — and the report has to say
  // the identity is derived, or a caller would think it bound the declared id.
  for (const rawId of [
    `Get${String.fromCharCode(7)}Items`,
    "   ",
    "",
    "__proto__",
    "x".repeat(300),
    42,
  ]) {
    const result = walkOk(
      withOperation({ operationId: rawId as unknown as string }),
    );
    const operation = result.walk.operations[0];
    assert.equal(operation?.identity, "method-path", String(rawId));
    assert.equal(operation?.nativeId, "GET /items", String(rawId));
    const issue = issueOf(result.issues, "structure.invalid-operation-id");
    assert.equal(issue.severity, "warning", String(rawId));
    assert.equal(issue.sourcePointer, "#/paths/~1items/get/operationId");
  }

  // An operation with no operationId at all is not a fault; it is identified
  // the same way and reported as nothing.
  const absent = walkOk(withOperation({ summary: "List items." }));
  assert.equal(absent.walk.operations[0]?.nativeId, "GET /items");
  assert.equal(absent.walk.operations[0]?.identity, "method-path");
  assert.deepEqual(codesOf(absent.issues), []);
});

test("an operationId declared twice leaves both operations described and neither bindable", () => {
  // Invariant: this is the contested-name case. Dropping one operation would
  // lose evidence, keeping the id on both would let a binding pick a request
  // at random. Both stay described, both are re-identified by method and path,
  // both remember the contested id for diagnostics, and both are blocking so
  // nothing binds under that name.
  const result = walkOk(
    base({
      paths: {
        "/items": { get: { operationId: "Shared" } },
        "/others": {
          post: { operationId: "Shared" },
          get: { operationId: "Unique" },
        },
      },
    }),
  );
  const contested = result.walk.operations.filter(
    (operation) => operation.declaredOperationId === "Shared",
  );
  assert.equal(contested.length, 2);
  assert.deepEqual(contested.map((operation) => operation.nativeId).sort(), [
    "GET /items",
    "POST /others",
  ]);
  for (const operation of contested) {
    assert.equal(operation.ambiguous, true);
    assert.equal(operation.identity, "method-path");
  }
  const unique = result.walk.operations.find(
    (operation) => operation.nativeId === "Unique",
  );
  assert.equal(
    unique?.ambiguous,
    false,
    "an untouched operation is unaffected",
  );
  assert.equal(unique?.declaredOperationId, undefined);
  const duplicates = result.issues.filter(
    (issue) => issue.code === "structure.duplicate-operation-id",
  );
  assert.equal(duplicates.length, 2, "each contested operation is named");
  assert.equal(duplicates[0]?.severity, "blocking");
  assert.equal(duplicates[0]?.executionImpact, "blocks-operation");
});

test("a security requirement naming an undeclared scheme is refused at the authorize dimension", () => {
  // Invariant: a requirement is only meaningful against a declared scheme. A
  // requirement naming one that securityDefinitions does not declare cannot be
  // satisfied, and reporting it as satisfiable would let an operation be bound
  // with no credential at all.
  const result = walkOk(
    withOperation(
      {
        operationId: "GetItems",
        security: [{ oauth2: ["read"] }, { ghost: [] }, "not an object"],
      },
      {
        securityDefinitions: {
          oauth2: {
            type: "oauth2",
            flow: "accessCode",
            authorizationUrl: "https://login.example/authorize",
            tokenUrl: "https://login.example/token",
            scopes: {
              read: "Read items",
              [`bad${String.fromCharCode(7)}`]: "x",
            },
            description: "Delegated access.",
            "x-ms-client-id": "public",
          },
        },
      },
    ),
  );
  const unknown = issueOf(result.issues, "security.unknown-scheme");
  assert.equal(unknown.dimension, "authorize");
  assert.equal(unknown.severity, "blocking");
  assert.ok(unknown.message.includes("ghost"));

  const security = result.walk.operations[0]?.security;
  assert.equal(security?.source, "operation");
  assert.equal(security?.alternatives.length, 3);
  assert.deepEqual(security?.alternatives[0]?.schemes, [
    { scheme: "oauth2", scopes: ["read"], known: true },
  ]);
  assert.equal(security?.alternatives[1]?.schemes[0]?.known, false);
  assert.deepEqual(
    security?.alternatives[2]?.schemes,
    [],
    "an alternative that is not an object requires nothing rather than everything",
  );

  const declared = result.walk.securityDefinitions["oauth2"];
  assert.equal(declared?.flow, "accessCode");
  assert.equal(declared?.tokenUrl, "https://login.example/token");
  assert.equal(declared?.description, "Delegated access.");
  assert.deepEqual(
    Object.keys(declared?.scopes ?? {}),
    ["read"],
    "a scope name with a control character is not a scope",
  );
  assert.deepEqual(declared?.extensions, { "x-ms-client-id": "public" });
});

test("a security definition with no declared type is described as unknown, not assumed", () => {
  // Invariant: the type decides how a credential is presented. Guessing
  // "apiKey" from the presence of a `name` field would produce a binding that
  // sends a secret in a place the API never specified, so an undeclared type
  // is carried as "unknown" and an unusable definition is skipped entirely.
  const result = walkOk(
    base({
      securityDefinitions: {
        untyped: { name: "X-Api-Key", in: "header" },
        notAnObject: "apiKey",
        [`bad${String.fromCharCode(7)}name`]: { type: "apiKey" },
      },
    }),
  );
  const names = Object.keys(result.walk.securityDefinitions);
  assert.deepEqual(names, ["untyped"], "only a usable definition is described");
  const untyped = result.walk.securityDefinitions["untyped"];
  assert.equal(untyped?.type, "unknown");
  assert.equal(untyped?.parameterName, "X-Api-Key");
  assert.equal(untyped?.in, "header");
  assert.deepEqual(untyped?.scopes, {});

  // A scheme literally named `__proto__` never reaches the security reader at
  // all: the document is refused when it is measured, before interpretation.
  const polluted = walkSwagger(
    JSON.parse(
      '{"swagger":"2.0","info":{"title":"t","version":"1"},"paths":{},' +
        '"securityDefinitions":{"__proto__":{"type":"apiKey"}}}',
    ),
  );
  assert.equal(polluted.ok, false);
  assert.equal(polluted.issues[0]?.code, "structure.document-bounds");
  assert.ok(polluted.issues[0]?.message.includes("reserved-key"));
  assert.equal(
    ({} as Record<string, unknown>)["polluted"],
    undefined,
    "no runtime object was mutated",
  );
});

test("document-level defaults apply until an operation overrides them, and the source is recorded", () => {
  // Invariant: a report must be able to say *where* a requirement came from.
  // Flattening document security into every operation without recording the
  // source would make an operation look independently secured, and a later
  // change to the document-level requirement would silently change what every
  // binding relies on.
  const document = base({
    host: "api.contoso.example",
    basePath: "/v1",
    schemes: ["https", "http"],
    consumes: ["application/json"],
    produces: ["application/json"],
    security: [{ apiKey: [] }],
    securityDefinitions: {
      apiKey: { type: "apiKey", name: "key", in: "query" },
    },
    "x-ms-connector-metadata": [{ propertyName: "Website" }],
    paths: {
      "/inherits": { get: { operationId: "Inherits" } },
      "/overrides": {
        "x-ms-notification-content": { schema: { type: "object" } },
        post: {
          operationId: "Overrides",
          security: [],
          consumes: ["text/csv"],
          produces: ["text/csv"],
          deprecated: true,
          summary: "Upload rows.",
          description: "Uploads rows as CSV.",
          tags: ["bulk"],
        },
      },
    },
  });
  const result = walkOk(document);
  assert.equal(result.walk.host, "api.contoso.example");
  assert.equal(result.walk.basePath, "/v1");
  assert.deepEqual(result.walk.schemes, ["https", "http"]);
  assert.deepEqual(result.walk.extensions, {
    "x-ms-connector-metadata": [{ propertyName: "Website" }],
  });

  const inherits = result.walk.operations.find(
    (operation) => operation.nativeId === "Inherits",
  );
  assert.equal(inherits?.security.source, "document");
  assert.deepEqual(inherits?.consumes, ["application/json"]);
  assert.equal(inherits?.deprecated, false);

  const overrides = result.walk.operations.find(
    (operation) => operation.nativeId === "Overrides",
  );
  assert.equal(
    overrides?.security.source,
    "operation",
    "an empty operation security list is an override, not an absence",
  );
  assert.deepEqual(overrides?.security.alternatives, []);
  assert.deepEqual(overrides?.consumes, ["text/csv"]);
  assert.deepEqual(overrides?.produces, ["text/csv"]);
  assert.equal(overrides?.deprecated, true);
  assert.equal(overrides?.summary, "Upload rows.");
  assert.equal(overrides?.description, "Uploads rows as CSV.");
  assert.deepEqual(overrides?.tags, ["bulk"]);
  assert.deepEqual(
    overrides?.pathItemExtensions,
    { "x-ms-notification-content": { schema: { type: "object" } } },
    "a path-item extension stays attached to every operation of that item",
  );

  // With neither an operation nor a document requirement, the walk says so
  // rather than leaving a caller to infer that none was needed.
  const none = walkOk(withOperation({ operationId: "Open" }));
  assert.equal(none.walk.operations[0]?.security.source, "none");
  assert.deepEqual(none.walk.documentSecurity, undefined);
  assert.equal(none.walk.host, undefined);
  assert.equal(none.walk.basePath, undefined);

  // `security` that is not a list is not a requirement list.
  const malformed = walkOk(base({ security: { apiKey: [] } }));
  assert.equal(malformed.walk.documentSecurity, undefined);
});

test("a body schema is carried by reference to the document, never copied unmeasured", () => {
  // Invariant: the walk's comment claims it "copies nothing it has not
  // measured". A body schema is handed on as the value the document already
  // held — bounded once, at the document level — while the nested index is the
  // measured artefact. This pins that the schema reaching a caller is the
  // document's own value and not a reshaped one.
  const schema = {
    type: "object",
    properties: { id: { type: "string", "x-ms-summary": "Id" } },
  };
  const document = withOperation({
    operationId: "CreateItem",
    parameters: [{ name: "body", in: "body", schema }],
  });
  const result = walkOk(document);
  const parameter = result.walk.operations[0]?.parameters[0];
  assert.deepEqual(parameter?.schema, schema);
  assert.equal(
    parameter?.nested[0]?.pointer,
    "#/paths/~1items/get/parameters/0/schema/properties/id",
  );
  // A body parameter with no schema declares no body; nothing is invented.
  const bodiless = walkOk(
    withOperation({
      operationId: "CreateItem",
      parameters: [{ name: "body", in: "body" }],
    }),
  );
  assert.equal(bodiless.walk.operations[0]?.parameters[0]?.schema, undefined);
  assert.deepEqual(bodiless.walk.operations[0]?.parameters[0]?.nested, []);
});

test("an indexed node and a parameter describe only the facts the document states", () => {
  // Invariant: the walk fills nothing in. A schema node with no `type`, a
  // parameter with no `format`, an `items` with neither, and a response with no
  // description must all come back with those fields absent rather than with a
  // plausible default. Downstream policy reads these fields to decide what may
  // be bound, so an invented `type: "string"` or an invented description would
  // be a claim about the API that nobody made.
  const result = walkOk(
    withOperation({
      operationId: "CreateRows",
      parameters: [
        {
          name: "since",
          in: "query",
          type: "string",
          format: "date-time",
          items: {},
        },
        {
          name: "body",
          in: "body",
          // An array at the root of a body: the index has to name the element
          // even though there is no enclosing property to name it after.
          schema: {
            type: "array",
            items: { "x-ms-summary": "Row" },
          },
        },
      ],
      responses: { "204": {}, "200": { description: "Rows." } },
    }),
  );
  const parameters = result.walk.operations[0]?.parameters ?? [];
  const since = parameters.find((parameter) => parameter.name === "since");
  assert.equal(since?.format, "date-time");
  assert.deepEqual(since?.items, {}, "an empty items states nothing");
  assert.equal(since?.hasDefault, false);
  assert.equal(since?.description, undefined);

  const body = parameters.find((parameter) => parameter.name === "body");
  assert.deepEqual(
    body?.nested.map((node) => node.pathString),
    ["items"],
    "an element of a root array is indexed under `items`",
  );
  assert.equal(
    body?.nested[0]?.type,
    undefined,
    "an untyped node carries no type",
  );
  assert.equal(
    body?.nested[0]?.pointer,
    "#/paths/~1items/get/parameters/1/schema/items",
  );

  const responses = result.walk.operations[0]?.responses ?? [];
  const empty = responses.find((response) => response.status === "204");
  assert.equal(empty?.description, undefined);
  assert.deepEqual(empty?.headers, []);
  assert.deepEqual(codesOf(result.issues), []);
});

test("a schema member the walk cannot index is skipped without taking the schema with it", () => {
  // Invariant: the nested index is best-effort by design, but "best-effort"
  // must mean "skips the member", not "abandons the schema". A property whose
  // value is a string rather than a schema object, and a property name the
  // reader will not use as a path segment, are each stepped over while the
  // rest of the body is still indexed — otherwise one malformed member would
  // hide every password and extension beside it.
  const result = walkOk(
    withOperation({
      operationId: "CreateItem",
      parameters: [
        {
          name: "body",
          in: "body",
          schema: {
            type: "object",
            properties: {
              malformed: "string",
              [`bad${String.fromCharCode(7)}name`]: {
                type: "string",
                format: "password",
              },
              secret: { type: "string", format: "password" },
            },
          },
        },
      ],
    }),
  );
  assert.deepEqual(
    result.walk.operations[0]?.parameters[0]?.nested.map(
      (node) => node.pathString,
    ),
    ["secret"],
    "the indexable password is still found",
  );
  assert.deepEqual(codesOf(result.issues), []);
});

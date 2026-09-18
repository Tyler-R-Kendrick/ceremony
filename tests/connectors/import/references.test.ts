import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ReferenceResolver,
  createApprovedFetch,
  parseBoundedDocument,
} from "../../../src/server/connectors/import/index.js";
import { startHttpFixture } from "../doubles/http-fixture.js";
import {
  CANARY,
  assertNoCanary,
  encode,
  expectConnectorError,
  fixtureBytes,
  loopbackPolicy,
} from "./support.js";

/*
 * IMP-04. References resolve lazily against a bounded registry. A recursive
 * schema is a valid description, not an error; expansion is the bounded
 * operation, and the network is reachable only through an explicit hook.
 */

const DOC = "urn:ceremony:test:main";

async function resolverFor(name: string, options = {}) {
  const value = parseBoundedDocument(await fixtureBytes(name)).value;
  const resolver = new ReferenceResolver(options);
  resolver.register(DOC, value);
  return { resolver, value };
}

const at = (pointer = "") => ({ documentId: DOC, pointer });

test("a JSON pointer resolves within one document without expanding anything", async () => {
  const { resolver, value } = await resolverFor("petstore-openapi-3.1.yaml");
  const outcome = await resolver.resolve("#/components/schemas/Category", at("/x"));
  assert.equal(outcome.status, "resolved");
  assert.equal(outcome.status === "resolved" && outcome.documentId, DOC);
  assert.equal(outcome.status === "resolved" && outcome.external, false);
  const target = outcome.status === "resolved" ? outcome.value : undefined;
  assert.equal((target as { type: string }).type, "object");
  // Resolution returns the target as it stands: the self-reference inside it
  // is still a reference, because nothing was expanded.
  assert.deepEqual(
    (target as { properties: { parent: unknown } }).properties.parent,
    { $ref: "#/components/schemas/Category" },
  );
  // The whole document is addressable, including the empty pointer.
  const root = await resolver.resolve("#", at());
  assert.deepEqual(root.status === "resolved" ? root.value : undefined, value);
  const escaped = await resolver.resolve("#/paths/~1pets/get/operationId", at());
  assert.equal(escaped.status === "resolved" ? escaped.value : undefined, "listPets");
  // Array indexes resolve; out-of-range and non-numeric indexes do not.
  const server = await resolver.resolve("#/servers/0/url", at());
  assert.equal(
    server.status === "resolved" ? server.value : undefined,
    "https://api.petstore.example/v2",
  );
  for (const ref of ["#/servers/7", "#/servers/first", "#/servers/-1", "#/nope/x"]) {
    const missing = await resolver.resolve(ref, at());
    assert.equal(missing.status, "unresolved", ref);
    assert.equal(missing.status !== "resolved" && missing.issue.severity, "blocking");
  }
});

test("a recursive schema is preserved, reported as recursive and never expanded forever", async () => {
  const { resolver } = await resolverFor("recursive-schema.json");
  const expansion = await resolver.expand(
    (await resolverFor("recursive-schema.json")).value,
    at(),
  );
  assert.equal(expansion.complete, true);
  const recursive = expansion.issues.filter(
    (issue) => issue.code === "structure.recursive-schema",
  );
  assert.ok(recursive.length > 0);
  // Recursion is information, not a defect: it blocks nothing.
  for (const issue of recursive) {
    assert.equal(issue.severity, "info");
    assert.equal(issue.executionImpact, "none");
    assert.equal(issue.category, "structure");
  }
  assert.equal(
    expansion.issues.some((issue) => issue.severity === "blocking"),
    false,
  );
  // Where the cycle closes, a reference remains in place of infinite depth.
  const expanded = expansion.value as {
    properties: { left: { $ref?: string }; right: { properties: { root: unknown } } };
  };
  assert.equal(typeof expanded.properties.left.$ref, "string");
  assert.equal(expanded.properties.left.$ref?.startsWith(`${DOC}#`), true);
  // Resolving the recursive pointer itself still works, lazily, every time.
  for (let i = 0; i < 100; i++) {
    const step = await resolver.resolve("#/$defs/node", at());
    assert.equal(step.status, "resolved");
  }
});

test("an expansion that would exceed the bounds is refused with a blocking issue", async () => {
  // A chain that fans out: each level references the next four times.
  const document: Record<string, unknown> = { level8: { leaf: true } };
  for (let level = 7; level >= 0; level--)
    document[`level${level}`] = {
      a: { $ref: `#/level${level + 1}` },
      b: { $ref: `#/level${level + 1}` },
      c: { $ref: `#/level${level + 1}` },
      d: { $ref: `#/level${level + 1}` },
    };
  const resolver = new ReferenceResolver({
    limits: { maxExpansionNodes: 500 },
  });
  resolver.register(DOC, document);
  const refused = await resolver.expand({ $ref: "#/level0" }, at());
  assert.equal(refused.complete, false);
  assert.equal(refused.value, undefined);
  const issue = refused.issues.find(
    (item) => item.code === "reference.expansion-exceeds-bounds",
  );
  assert.ok(issue);
  assert.equal(issue.severity, "blocking");
  assert.equal(issue.executionImpact, "blocks-operation");

  // The same document with a depth budget instead of a node budget.
  const shallow = new ReferenceResolver({ limits: { maxExpansionDepth: 4 } });
  shallow.register(DOC, document);
  assert.equal((await shallow.expand({ $ref: "#/level0" }, at())).complete, false);

  // Lazy resolution of the same document stays cheap and keeps working.
  const lazy = new ReferenceResolver();
  lazy.register(DOC, document);
  assert.equal((await lazy.resolve("#/level0/a", at())).status, "resolved");
});

test("unresolved, unsupported, unsafe and unavailable references are distinct codes", async (t) => {
  const bytes = await fixtureBytes("malicious-private-refs.yaml");
  const value = parseBoundedDocument(bytes, { mediaType: "application/yaml" }).value as {
    components: { schemas: Record<string, { $ref: string }> };
  };
  const schemas = value.components.schemas;
  const fixture = await startHttpFixture(() => ({ body: { ok: true } }));
  t.after(() => fixture.close());
  const approved = createApprovedFetch(loopbackPolicy());
  t.after(() => approved.close());

  const resolver = new ReferenceResolver({
    fetchExternal: async (url) => {
      const response = await approved(url.href);
      return { bytes: new Uint8Array(await response.arrayBuffer()) };
    },
  });
  resolver.register(DOC, value);

  const outcomes: Record<string, string> = {};
  for (const [name, schema] of Object.entries(schemas)) {
    const outcome = await resolver.resolve(schema.$ref, at(`/components/schemas/${name}`));
    outcomes[name] = outcome.status;
    assertNoCanary(outcome);
  }
  // Every network-reachable target is refused by policy, not attempted.
  assert.equal(outcomes.Metadata, "unsafe");
  assert.equal(outcomes.Intranet, "unsafe");
  assert.equal(outcomes.Loopback, "unsafe");
  assert.equal(outcomes.Mapped, "unsafe");
  // Credentials in a reference are a policy refusal before any retrieval.
  assert.equal(outcomes.Credentialed, "unsafe");
  // A non-HTTP scheme and a plain-name fragment are unsupported forms.
  assert.equal(outcomes.LocalFile, "unsupported");
  assert.equal(outcomes.Anchor, "unsupported");
  // A pointer into a known document that names nothing is unresolved.
  assert.equal(outcomes.Missing, "unresolved");
  // A well-formed public reference is refused by the fixture-only policy too,
  // but as an unsafe destination rather than a malformed reference.
  assert.equal(outcomes.Public, "unsafe");
  assert.equal(fixture.requests.length, 0);

  // Each failure carries a blocking issue naming the $ref location.
  const codes = new Set(resolver.issues.map((issue) => issue.code));
  assert.deepEqual(
    [...codes].sort(),
    ["reference.unresolved", "reference.unsafe", "reference.unsupported"],
  );
  for (const issue of resolver.issues) {
    assert.equal(issue.severity, "blocking");
    assert.ok(issue.sourcePointer.endsWith("/$ref"));
    assertNoCanary(issue);
  }
});

test("external references need an explicit hook and stay inside the document budget", async (t) => {
  const served: string[] = [];
  const fixture = await startHttpFixture((request) => {
    served.push(request.url.pathname);
    const index = Number(request.url.pathname.match(/(\d+)/)?.[1] ?? "0");
    return {
      headers: { "content-type": "application/json" },
      body: {
        name: `doc${index}`,
        next: { $ref: `./doc${index + 1}.json#/name` },
      },
    };
  });
  t.after(() => fixture.close());
  const origin = fixture.origin;

  // Without a hook, an external reference is refused and nothing is contacted.
  const sealed = new ReferenceResolver();
  sealed.register(`${origin}/root.json`, { a: { $ref: "./doc0.json#/name" } });
  const refused = await sealed.resolve("./doc0.json#/name", {
    documentId: `${origin}/root.json`,
    pointer: "/a",
  });
  assert.equal(refused.status, "external-not-permitted");
  assert.equal(served.length, 0);

  const approved = createApprovedFetch(loopbackPolicy());
  t.after(() => approved.close());
  const resolver = new ReferenceResolver({
    limits: { maxExternalDocuments: 3 },
    fetchExternal: async (url) => {
      const response = await approved(url.href);
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        mediaType: response.headers.get("content-type") ?? undefined,
      };
    },
  });
  resolver.register(`${origin}/root.json`, { a: { $ref: "./doc0.json#/name" } });
  const from = { documentId: `${origin}/root.json`, pointer: "/a" };

  const first = await resolver.resolve("./doc0.json#/name", from);
  assert.equal(first.status, "resolved");
  assert.equal(first.status === "resolved" && first.value, "doc0");
  assert.equal(first.status === "resolved" && first.external, true);
  // A second reference to the same document is served from the registry.
  await resolver.resolve("./doc0.json#/next", from);
  assert.deepEqual(served, ["/doc0.json"]);

  // The budget counts documents, and the fourth is refused rather than fetched.
  assert.equal((await resolver.resolve("./doc1.json#/name", from)).status, "resolved");
  assert.equal((await resolver.resolve("./doc2.json#/name", from)).status, "resolved");
  const overBudget = await resolver.resolve("./doc3.json#/name", from);
  assert.equal(overBudget.status, "budget-exceeded");
  assert.deepEqual(served, ["/doc0.json", "/doc1.json", "/doc2.json"]);
  assert.equal(resolver.budget().externalDocuments, 3);

  // A chain of external references expands only as far as the budget allows.
  const chained = await resolver.expand({ $ref: "./doc0.json#" }, from);
  assert.equal(
    chained.issues.some((issue) => issue.code === "reference.budget-exceeded"),
    true,
  );
});

test("a byte budget bounds external documents even when the count does not", async (t) => {
  const fixture = await startHttpFixture(() => ({
    headers: { "content-type": "application/json" },
    body: { padding: "x".repeat(4096) },
  }));
  t.after(() => fixture.close());
  const approved = createApprovedFetch(loopbackPolicy());
  t.after(() => approved.close());
  const resolver = new ReferenceResolver({
    limits: { maxExternalBytes: 5_000 },
    fetchExternal: async (url) => ({
      bytes: new Uint8Array(await (await approved(url.href)).arrayBuffer()),
    }),
  });
  const root = `${fixture.origin}/root.json`;
  resolver.register(root, {});
  const from = { documentId: root, pointer: "" };
  assert.equal((await resolver.resolve("./a.json#/padding", from)).status, "resolved");
  const second = await resolver.resolve("./b.json#/padding", from);
  assert.equal(second.status, "budget-exceeded");
  assert.ok(resolver.budget().externalBytes > 4_000);
});

test("a retrieval failure is temporarily unavailable, not a missing reference", async (t) => {
  const fixture = await startHttpFixture((request) =>
    request.url.pathname === "/gone.json"
      ? { status: 404, body: { error: "gone" } }
      : { status: 503, body: { error: "later" } },
  );
  t.after(() => fixture.close());
  const approved = createApprovedFetch(loopbackPolicy());
  t.after(() => approved.close());
  const resolver = new ReferenceResolver({
    fetchExternal: async (url) => {
      const response = await approved(url.href);
      if (response.status === 404)
        throw new (await import("../../../src/server/connectors/errors.js")).ConnectorError(
          "not-found",
          { detail: "import.status-404" },
        );
      if (!response.ok)
        throw new (await import("../../../src/server/connectors/errors.js")).ConnectorError(
          "upstream-unavailable",
          { detail: "import.status-503" },
        );
      return { bytes: new Uint8Array(await response.arrayBuffer()) };
    },
  });
  const root = `${fixture.origin}/root.json`;
  resolver.register(root, {});
  const from = { documentId: root, pointer: "" };
  assert.equal((await resolver.resolve("./gone.json#/x", from)).status, "unresolved");
  assert.equal(
    (await resolver.resolve("./later.json#/x", from)).status,
    "temporarily-unavailable",
  );
  // A failed document is remembered: a retry in the same import does not
  // hammer the same unreachable location.
  await resolver.resolve("./later.json#/y", from);
  assert.equal(fixture.received("GET", "/later.json").length, 1);
});

test("an external document is parsed within the same bounds as an upload", async (t) => {
  const fixture = await startHttpFixture(() => ({
    headers: { "content-type": "application/json" },
    body: '{"a":1,"a":2}',
  }));
  t.after(() => fixture.close());
  const approved = createApprovedFetch(loopbackPolicy());
  t.after(() => approved.close());
  const resolver = new ReferenceResolver({
    fetchExternal: async (url) => ({
      bytes: new Uint8Array(await (await approved(url.href)).arrayBuffer()),
      mediaType: "application/json",
    }),
  });
  const root = `${fixture.origin}/root.json`;
  resolver.register(root, {});
  const outcome = await resolver.resolve("./dup.json#/a", {
    documentId: root,
    pointer: "",
  });
  assert.equal(outcome.status, "document-invalid");
  assert.equal(outcome.status !== "resolved" && outcome.detail, "json.duplicate-key");
});

test("the registry is bounded and rejects unusable document identities", async () => {
  const resolver = new ReferenceResolver({ limits: { maxDocuments: 2 } });
  resolver.register(DOC, {});
  resolver.register("https://schemas.example/a.json", {});
  await expectConnectorError(
    () => resolver.register("https://schemas.example/b.json", {}),
    "invalid-request",
    "reference.registry-full",
  );
  await expectConnectorError(
    () => resolver.register(DOC, {}),
    "conflict",
    "reference.document-duplicate",
  );
  const other = new ReferenceResolver();
  for (const id of [
    "https://user:pw@schemas.example/a.json",
    "https://schemas.example/a.json#/fragment",
    "ftp://schemas.example/a.json",
    "not a url",
    "",
  ])
    await expectConnectorError(
      () => other.register(id, {}),
      "invalid-request",
      "reference.document-id-invalid",
    );
});

test("reference strings are bounded and malformed forms are refused, not parsed", async () => {
  const resolver = new ReferenceResolver({
    limits: { maxRefLength: 64, maxPointerSegments: 4, maxResolutions: 6 },
  });
  resolver.register(DOC, { a: { b: 1 } });
  for (const ref of [
    "#/".padEnd(200, "x"),
    "#/a/b/c/d/e/f",
    "#/%zz",
    123 as unknown as string,
    "",
    `#/${CANARY} `,
  ]) {
    const outcome = await resolver.resolve(ref, at());
    assert.notEqual(outcome.status, "resolved");
    assertNoCanary(outcome);
  }
  // The resolution budget stops runaway reference chasing.
  const exhausted = await resolver.resolve("#/a/b", at());
  assert.equal(exhausted.status, "budget-exceeded");
});

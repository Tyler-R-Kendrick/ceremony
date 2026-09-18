import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  createApprovedFetch,
  parseBoundedDocument,
  ReferenceResolver,
  sanitizeGraph,
  type NetworkPolicy,
} from "../../../src/server/connectors/import/index.js";
import {
  applyOverlay,
  diffOverlay,
} from "../../../src/server/connectors/formats/overlay/index.js";
import { createMcpRegistryClient } from "../../../src/server/connectors/registries/mcp/index.js";
import { startHttpFixture } from "../doubles/http-fixture.js";

/*
 * SEC-02. Ingestion and network attacks, driven against the real reader, the
 * real reference resolver, the real approved fetcher and the real registry
 * client. Fixtures are loopback servers on ephemeral ports; DNS answers are
 * injected through the same lookup the socket uses, so a rebinding case
 * exercises production code rather than a parallel checker. Port 9 is never
 * used: a request to it never reaches DNS and would prove nothing.
 */

const enc = (value: string) => new TextEncoder().encode(value);
const CANARY = "CANARY_SECRET_ingestion_71b";

function refused(work: () => unknown): ConnectorError {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof ConnectorError, String(error));
    return error;
  }
  throw new Error("expected a refusal");
}

async function refusedAsync(work: () => Promise<unknown>): Promise<ConnectorError> {
  try {
    await work();
  } catch (error) {
    assert.ok(error instanceof ConnectorError, String(error));
    return error;
  }
  throw new Error("expected a refusal");
}

test("format is decided, never guessed, and the two readers cannot disagree", () => {
  // A declared specific media type is authoritative: YAML bytes announced as
  // JSON are a syntax failure, not a quiet reinterpretation.
  assert.equal(
    refused(() =>
      parseBoundedDocument(enc("openapi: 3.1.0\n"), {
        mediaType: "application/json",
      }),
    ).detail,
    "json.syntax",
  );
  // A media type neither reader owns is refused rather than sniffed.
  for (const mediaType of [
    "application/x-ruby",
    "application/xml",
    "text/html",
    "application/x-www-form-urlencoded",
  ])
    assert.equal(
      refused(() => parseBoundedDocument(enc("{}"), { mediaType })).detail,
      "document.media-type-unsupported",
      mediaType,
    );
  // A JSON body read by the YAML reader must agree with the JSON reader, and
  // both must refuse the duplicate that would let them disagree.
  const text = '{"a":1,"b":[true,null,"x"]}';
  assert.deepEqual(
    parseBoundedDocument(enc(text), { mediaType: "application/json" }).value,
    parseBoundedDocument(enc(text), { mediaType: "application/yaml" }).value,
  );
  assert.equal(
    refused(() =>
      parseBoundedDocument(enc('{"a":1,"a":2}'), {
        mediaType: "application/yaml",
      }),
    ).detail,
    "yaml.duplicate-key",
  );
  // YAML 1.2 core: no 1.1 boolean or sexagesimal reinterpretation, and an
  // explicit 1.1 directive is refused rather than silently downgraded.
  assert.deepEqual(
    parseBoundedDocument(enc("no: x\non: y\ny: z\nt: 12:30:00\n"), {
      mediaType: "application/yaml",
    }).value,
    { no: "x", on: "y", y: "z", t: "12:30:00" },
  );
  assert.equal(
    refused(() =>
      parseBoundedDocument(enc("%YAML 1.1\n---\na: y\n"), {
        mediaType: "application/yaml",
      }),
    ).detail,
    "yaml.version-unsupported",
  );
  // A file name is a hint, never a path.
  assert.equal(
    refused(() =>
      parseBoundedDocument(enc("{}"), { fileName: "../../etc/passwd.json" }),
    ).detail,
    "document.file-name-invalid",
  );
});

test("prototype pollution cannot survive any reader or the post-parse walk", () => {
  const before = Object.keys(Object.prototype).length;
  for (const [text, mediaType] of [
    ['{"__proto__":{"polluted":true}}', "application/json"],
    ['{"a":{"constructor":{"prototype":{"polluted":true}}}}', "application/json"],
    ['{"\\u005f\\u005fproto\\u005f\\u005f":1}', "application/json"],
    ["__proto__:\n  polluted: true\n", "application/yaml"],
    ["a:\n  prototype:\n    polluted: true\n", "application/yaml"],
  ] as const)
    assert.equal(
      refused(() => parseBoundedDocument(enc(text), { mediaType })).detail,
      "document.reserved-key",
      text,
    );
  // The post-parse walk is a second, independent gate: a graph handed to it
  // directly is refused too, and a foreign prototype is never copied.
  assert.equal(
    refused(() => sanitizeGraph(JSON.parse('{"__proto__":{"x":1}}'))).detail,
    "document.reserved-key",
  );
  const hostile = Object.create({ inherited: true }) as Record<string, unknown>;
  hostile["own"] = 1;
  assert.equal(
    refused(() => sanitizeGraph(hostile)).detail,
    "document.prototype-tampered",
  );
  const cyclic: Record<string, unknown> = {};
  cyclic["self"] = cyclic;
  assert.equal(
    refused(() => sanitizeGraph(cyclic)).detail,
    "document.circular-structure",
  );
  assert.equal(
    (Object.prototype as Record<string, unknown>)["polluted"],
    undefined,
  );
  assert.equal(Object.keys(Object.prototype).length, before);
});

test("schema complexity is bounded in depth, breadth, size and time", () => {
  const nest = (depth: number) => "[".repeat(depth) + "]".repeat(depth);
  assert.equal(
    refused(() => parseBoundedDocument(enc(nest(200)))).detail,
    "document.too-deep",
  );
  assert.equal(
    refused(() =>
      parseBoundedDocument(enc(nest(20)), { limits: { maxDepth: 4 } }),
    ).detail,
    "document.too-deep",
  );
  assert.equal(
    refused(() =>
      parseBoundedDocument(enc(JSON.stringify(Array.from({ length: 50 }, () => 1))), {
        limits: { maxNodes: 10 },
      }),
    ).detail,
    "document.too-many-nodes",
  );
  const wide = JSON.stringify(
    Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i])),
  );
  assert.equal(
    refused(() =>
      parseBoundedDocument(enc(wide), { limits: { maxKeysPerObject: 8 } }),
    ).detail,
    "document.too-many-keys",
  );
  assert.equal(
    refused(() =>
      parseBoundedDocument(enc(JSON.stringify({ a: "x".repeat(500) })), {
        limits: { maxStringLength: 16 },
      }),
    ).detail,
    "document.string-too-long",
  );
  assert.equal(
    refused(() =>
      parseBoundedDocument(enc(JSON.stringify({ ["k".repeat(80)]: 1 })), {
        limits: { maxKeyLength: 16 },
      }),
    ).detail,
    "document.key-too-long",
  );
  // A limits object a caller supplies can only narrow: it cannot switch a
  // bound off or push it past the module's own ceiling.
  for (const limits of [
    { maxDepth: 0 },
    { maxNodes: -1 },
    { maxBytes: Number.MAX_SAFE_INTEGER },
    { maxDepth: Number.POSITIVE_INFINITY },
    { maxKeysPerObject: 1.5 },
  ] as const)
    assert.equal(
      refused(() => parseBoundedDocument(enc("{}"), { limits })).detail,
      "document.limits-invalid",
      JSON.stringify(limits),
    );
  // A decompression bomb costs the ceiling, not the inflated size, and
  // compressed input is refused entirely unless the caller opted in.
  const bomb = gzipSync(Buffer.alloc(8 * 1024 * 1024, 0x20));
  assert.ok(bomb.byteLength < 64 * 1024, "the bomb must be small on the wire");
  assert.equal(
    refused(() => parseBoundedDocument(new Uint8Array(bomb))).detail,
    "document.compressed-refused",
  );
  assert.equal(
    refused(() =>
      parseBoundedDocument(new Uint8Array(bomb), {
        limits: { allowCompressed: true, maxBytes: 65_536 },
      }),
    ).detail,
    "document.decoded-too-large",
  );
  // YAML alias amplification is measured before expansion, not after.
  const laughs = [
    "a: &a [x,x,x,x,x,x,x,x,x]",
    "b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]",
    "c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]",
    "d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]",
    "e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]",
    "f: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]",
    "g: [*f,*f,*f,*f,*f,*f,*f,*f,*f]",
    "",
  ].join("\n");
  assert.equal(
    refused(() =>
      parseBoundedDocument(enc(laughs), { mediaType: "application/yaml" }),
    ).detail,
    "yaml.alias-expansion-exceeds-bounds",
  );
  // A self-referential alias is circular, not an infinite document.
  assert.equal(
    refused(() =>
      parseBoundedDocument(enc("a: &a [*a]\n"), {
        mediaType: "application/yaml",
      }),
    ).detail,
    "yaml.circular-alias",
  );
});

test("a recursive schema is valid, and expansion stops at the cycle", async () => {
  const resolver = new ReferenceResolver();
  const id = resolver.register("urn:fixture:recursive", {
    components: {
      schemas: {
        Node: {
          type: "object",
          properties: {
            child: { $ref: "#/components/schemas/Node" },
            name: { type: "string" },
          },
        },
      },
    },
  });
  const from = { documentId: id, pointer: "" };
  // Resolution is lazy: a recursive schema resolves as many times as asked
  // without growing, so recursion is not "invalid".
  for (let i = 0; i < 200; i++) {
    const outcome = await resolver.resolve("#/components/schemas/Node", from);
    assert.equal(outcome.status, "resolved");
  }
  // Expansion is the bounded operation: the cycle is reported once and left
  // as a reference rather than expanded forever.
  const expanded = await resolver.expand(
    { $ref: "#/components/schemas/Node" },
    from,
  );
  assert.equal(expanded.complete, true);
  assert.ok(
    expanded.issues.some((issue) => issue.code === "structure.recursive-schema"),
    expanded.issues.map((issue) => issue.code).join(","),
  );
  assert.ok(JSON.stringify(expanded.value).length < 4096);

  // A pointer cannot walk into prototype machinery, and an unknown document
  // is unresolved rather than fetched.
  for (const ref of [
    "#/__proto__",
    "#/components/schemas/Node/constructor",
    "#/components/schemas/Missing",
  ]) {
    const outcome = await resolver.resolve(ref, from);
    assert.notEqual(outcome.status, "resolved", ref);
  }
  // With no external hook, every external reference is refused; the refusal
  // is a recorded issue, not an exception that loses the rest of the import.
  const external = await resolver.resolve(
    "https://schemas.example/other.json#/a",
    from,
  );
  assert.equal(external.status, "external-not-permitted");
  // Non-http schemes never become a fetch.
  for (const ref of [
    "file:///etc/passwd#/a",
    "data:application/json,%7B%7D#/a",
    "ftp://x.example/a#/a",
  ]) {
    const outcome = await resolver.resolve(ref, from);
    assert.equal(outcome.status, "unsupported", ref);
  }
  // Userinfo in a reference is unsafe, not merely unsupported.
  const userinfo = await resolver.resolve(
    `https://user:${CANARY}@schemas.example/a.json#/a`,
    from,
  );
  assert.equal(userinfo.status, "unsafe");
  assert.ok(
    !JSON.stringify(userinfo).includes(CANARY),
    "a refusal must not echo the credential it refused",
  );

  // The resolution budget is finite even for a document that references
  // itself through a fan-out.
  const small = new ReferenceResolver({ limits: { maxResolutions: 3 } });
  const smallId = small.register("urn:fixture:small", { a: { b: 1 } });
  const place = { documentId: smallId, pointer: "" };
  const outcomes = [];
  for (let i = 0; i < 5; i++) outcomes.push(await small.resolve("#/a", place));
  assert.equal(outcomes.at(-1)?.status, "budget-exceeded");
});

test("an external reference goes through the approved fetcher and stays inside it", async (t) => {
  const inner = await startHttpFixture(() => ({
    body: { type: "object", properties: { a: { type: "string" } } },
    headers: { "content-type": "application/json" },
  }));
  t.after(() => inner.close());
  const policy: NetworkPolicy = {
    mode: "loopback-fixture",
    maxRedirects: 2,
    maxResponseBytes: 64 * 1024,
    timeoutMs: 5_000,
  };
  const approved = createApprovedFetch(policy);
  t.after(() => approved.close());
  let fetched = 0;
  const resolver = new ReferenceResolver({
    fetchExternal: async (url) => {
      fetched++;
      const response = await approved(url.href, { method: "GET" });
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        mediaType: "application/json",
      };
    },
    limits: { maxExternalDocuments: 1 },
  });
  const id = resolver.register("urn:fixture:root", {});
  const from = { documentId: id, pointer: "" };
  const ok = await resolver.resolve(`${inner.origin}/schema.json#/type`, from);
  assert.equal(ok.status, "resolved");
  assert.equal(ok.status === "resolved" && ok.value, "object");
  assert.equal(fetched, 1);
  // The external-document budget is a hard stop, not a soft preference.
  const second = await resolver.resolve(
    `${inner.origin}/other.json#/type`,
    from,
  );
  assert.equal(second.status, "budget-exceeded");
  // The fetcher refuses everything outside the fixture network class, and the
  // resolver records that as unsafe rather than temporarily unavailable.
  const wide = new ReferenceResolver({
    fetchExternal: async (url) => {
      const response = await approved(url.href, { method: "GET" });
      return { bytes: new Uint8Array(await response.arrayBuffer()) };
    },
  });
  const wideId = wide.register("urn:fixture:wide", {});
  for (const target of [
    "https://169.254.169.254/latest/meta-data/",
    "https://registry.example.com/schema.json",
    "http://10.0.0.7/schema.json",
  ]) {
    const outcome = await wide.resolve(`${target}#/a`, {
      documentId: wideId,
      pointer: "",
    });
    assert.equal(outcome.status, "unsafe", target);
  }
});

test("the approved fetcher refuses rebinding, cross-origin hops and travelling credentials", async (t) => {
  const sibling = await startHttpFixture((request) => ({
    body: { authorization: request.headers["authorization"] ?? null },
  }));
  t.after(() => sibling.close());
  const upstream = await startHttpFixture((request) => {
    if (request.url.pathname === "/redirect-away")
      return { status: 302, headers: { location: "https://evil.example/x" } };
    if (request.url.pathname === "/redirect-sibling")
      return { status: 302, headers: { location: `${sibling.origin}/landed` } };
    if (request.url.pathname === "/redirect-metadata")
      return {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      };
    if (request.url.pathname === "/redirect-file")
      return { status: 302, headers: { location: "file:///etc/passwd" } };
    if (request.url.pathname === "/redirect-self")
      return { status: 302, headers: { location: "/landing" } };
    if (request.url.pathname === "/landing")
      return {
        body: { authorization: request.headers["authorization"] ?? null },
      };
    if (request.url.pathname === "/big")
      return { body: "x".repeat(8192), headers: { "content-type": "text/plain" } };
    return { body: { ok: true } };
  });
  t.after(() => upstream.close());
  const policy: NetworkPolicy = {
    mode: "loopback-fixture",
    maxRedirects: 3,
    maxResponseBytes: 4096,
    timeoutMs: 5_000,
  };
  const approved = createApprovedFetch(policy);
  t.after(() => approved.close());

  // A redirect that leaves the first origin is refused even when the target
  // would be reachable, and a redirect into forbidden space names the address.
  for (const [path, detail] of [
    // A public origin is not even reachable in fixture mode; the most
    // specific objection is named, not a generic "denied".
    ["/redirect-away", "network.loopback-fixture-only"],
    ["/redirect-metadata", "network.loopback-fixture-only"],
    ["/redirect-file", "network.scheme-forbidden"],
    // A second loopback fixture is a different origin: reachable in this
    // network class, and still refused because the hop crosses origins.
    ["/redirect-sibling", "network.redirect-cross-origin"],
  ] as const) {
    const error = await refusedAsync(() =>
      approved(`${upstream.origin}${path}`, { redirect: "follow" }),
    );
    assert.equal(error.code, "network-policy", path);
    assert.equal(error.detail, detail, path);
  }
  // Credentials never travel across a redirect, same-origin included: the
  // responder chose the next destination, not the caller.
  const landed = await approved(`${upstream.origin}/redirect-self`, {
    redirect: "follow",
    headers: { authorization: `Bearer ${CANARY}`, cookie: `s=${CANARY}` },
  });
  assert.equal(landed.status, 200);
  assert.deepEqual(await landed.json(), { authorization: null });
  const landing = upstream.received("GET", "/landing")[0]!;
  assert.equal(landing.headers["authorization"], undefined);
  assert.equal(landing.headers["cookie"], undefined);
  // An administrator who lists the second origin gets the hop, and the
  // credential is still stripped: listing an origin is not trusting the
  // responder with the caller's authority.
  const crossing = createApprovedFetch({
    ...policy,
    allowedOrigins: [sibling.origin],
  });
  t.after(() => crossing.close());
  const crossed = await crossing(`${upstream.origin}/redirect-sibling`, {
    redirect: "follow",
    headers: { authorization: `Bearer ${CANARY}` },
  });
  assert.equal(crossed.status, 200);
  assert.deepEqual(await crossed.json(), { authorization: null });

  // The response ceiling is enforced while streaming.
  const tooLarge = await refusedAsync(() =>
    approved(`${upstream.origin}/big`).then((response) => response.text()),
  );
  assert.equal(tooLarge.detail, "network.response-too-large");

  // DNS rebinding: the hostname passes the URL check, and the answer the
  // socket would actually use is refused inside the lookup.
  const rebinding = createApprovedFetch({
    mode: "public",
    maxRedirects: 0,
    maxResponseBytes: 4096,
    timeoutMs: 5_000,
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
  });
  t.after(() => rebinding.close());
  const rebound = await refusedAsync(() =>
    rebinding("https://schemas.example/spec.json"),
  );
  assert.equal(rebound.code, "network-policy");
  assert.equal(rebound.detail, "network.dns-forbidden-address");
  // A mixed answer set is refused as a whole: the good answer does not
  // license the bad one.
  const mixed = createApprovedFetch({
    mode: "public",
    maxRedirects: 0,
    maxResponseBytes: 4096,
    timeoutMs: 5_000,
    lookup: async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "169.254.169.254", family: 4 },
    ],
  });
  t.after(() => mixed.close());
  assert.equal(
    (await refusedAsync(() => mixed("https://schemas.example/spec.json")))
      .detail,
    "network.dns-forbidden-address",
  );
});

test("an overlay cannot approve an endpoint, an issuer or a wider grant", () => {
  const approvedDocument = {
    openapi: "3.1.0",
    info: { title: "Service", version: "1" },
    servers: [{ url: "https://api.example.com" }],
    components: {
      securitySchemes: {
        oauth: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: "https://issuer.example.com/authorize",
              tokenUrl: "https://issuer.example.com/token",
              scopes: { read: "Read" },
            },
          },
        },
      },
    },
    security: [{ oauth: ["read"] }],
    paths: { "/items": { get: { operationId: "listItems" } } },
  };
  const hostile = {
    overlay: "1.1.0",
    info: { title: "Hostile", version: "1" },
    extends: "https://api.example.com/openapi.json",
    actions: [
      { target: "$.servers", update: [{ url: "https://exfil.example" }] },
      {
        target:
          "$.components.securitySchemes.oauth.flows.authorizationCode",
        update: {
          authorizationUrl: "https://attacker.example/authorize",
          tokenUrl: "https://attacker.example/token",
          scopes: { read: "Read", admin: "Everything" },
        },
      },
      { target: "$.security", update: [{ oauth: ["read", "admin"] }] },
    ],
  };
  const applied = applyOverlay(approvedDocument, hostile);
  assert.equal(applied.applied, true, "a structural transformation may apply");
  // Applying is not approving: the diff must name the security consequences
  // as blocking, so the earlier approval cannot cover the new document.
  const diff = diffOverlay(approvedDocument, applied.document);
  const security = diff.issues.filter((issue) => issue.category === "security");
  assert.ok(security.length >= 3, JSON.stringify(diff.changes));
  for (const issue of security) {
    assert.equal(issue.severity, "blocking", issue.code);
    assert.notEqual(issue.executionImpact, "none", issue.code);
  }
  const codes = security.map((issue) => issue.code);
  assert.ok(codes.includes("security.server-added"), codes.join(","));
  assert.ok(
    codes.some((code) => code.includes("scheme") || code.includes("scope")),
    codes.join(","),
  );
  // An overlay whose version the applier does not implement changes nothing.
  for (const version of ["2.0.0", "1.2.0", "latest", undefined]) {
    const result = applyOverlay(approvedDocument, {
      ...(version === undefined ? {} : { overlay: version }),
      actions: [{ target: "$.servers", update: [{ url: "https://x.example" }] }],
    });
    assert.equal(result.applied, false, String(version));
    assert.deepEqual(result.document, approvedDocument);
    assert.ok(
      result.issues.some((issue) => issue.severity === "blocking"),
      String(version),
    );
  }
  // An overlay written for a different document is refused when the source is
  // pinned and the host requires the match.
  const wrongTarget = applyOverlay(approvedDocument, hostile, {
    source: { identity: "https://other.example/openapi.json" },
    requireExtendsMatch: true,
  });
  assert.equal(wrongTarget.applied, false);
  assert.equal(wrongTarget.extends?.match, "mismatch");
});

test("catalog pagination is bounded even when a registry never stops", async (t) => {
  let pages = 0;
  const forever = await startHttpFixture((request) => {
    if (!request.url.pathname.endsWith("/servers")) return { status: 404, body: {} };
    pages++;
    return {
      body: {
        servers: [
          {
            server: {
              name: "io.example/endless",
              description: "d",
              version: `1.0.${pages}`,
            },
            _meta: {
              "io.modelcontextprotocol.registry/official": {
                status: "active",
                publishedAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:00Z",
                isLatest: true,
              },
            },
          },
        ],
        metadata: { count: 1, nextCursor: `cursor-${pages}` },
      },
    };
  });
  t.after(() => forever.close());
  const client = createMcpRegistryClient({
    baseUrl: forever.origin,
    fetch: (input, init) => fetch(input as RequestInfo, init),
  });
  const all = await client.listAll({}, { maxPages: 5 });
  assert.equal(all.complete, false);
  assert.equal(all.reason, "pages");
  assert.equal(all.pages.length, 5);
  assert.equal(pages, 5, "the client stops asking, the registry does not");
  assert.ok(all.nextCursor, "an incomplete result hands back where to resume");

  // A registry that echoes the cursor it was given is a loop, and the client
  // reports it rather than spinning.
  pages = 0;
  const loop = await startHttpFixture((request) => {
    if (!request.url.pathname.endsWith("/servers")) return { status: 404, body: {} };
    pages++;
    const cursor = request.url.searchParams.get("cursor") ?? "start";
    return {
      body: { servers: [], metadata: { count: 0, nextCursor: cursor } },
    };
  });
  t.after(() => loop.close());
  const looping = createMcpRegistryClient({
    baseUrl: loop.origin,
    fetch: (input, init) => fetch(input as RequestInfo, init),
  });
  const first = await looping.list({ cursor: "abc" });
  assert.equal(first.nextCursor, undefined);
  assert.ok(
    first.issues.some((issue) => issue.code === "registry.cursor.loop"),
    first.issues.map((issue) => issue.code).join(","),
  );
  // A caller cannot raise the page limit past the registry client's ceiling.
  await assert.rejects(
    () => looping.list({ limit: 1000 }),
    (error: unknown) =>
      error instanceof ConnectorError && error.detail === "registry.limit.invalid",
  );
  assert.throws(
    () =>
      createMcpRegistryClient({
        baseUrl: loop.origin,
        fetch,
        limits: { pageLimit: 5000 },
      }),
    (error: unknown) =>
      error instanceof ConnectorError && error.detail === "registry.limit.invalid",
  );
});

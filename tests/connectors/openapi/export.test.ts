import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileOperations,
  createOpenApiHttpAdapter,
  exportOpenApi,
  isReadResult,
  readOpenApi,
  securityRequirementsFor,
} from "../../../src/server/connectors/formats/openapi/index.js";
import {
  allStrings,
  harness,
  loopbackDestination,
  makeBinding,
  readFixture,
} from "./helpers.js";

/*
 * HTTP-06 / AC-IMP-14: export with loss reports, and read → import → export →
 * read round trips. The claimed semantics survive; the losses are explicit;
 * security-critical losses are blocking; and nothing private, unapproved or
 * example-borne leaves the deployment.
 */

const destination = loopbackDestination("https://origin.example.test", "api");

async function approve(
  name: string,
  options: Partial<Parameters<typeof compileOperations>[2]> = {},
) {
  const read = await readFixture(name);
  const compiled = compileOperations(read.definition, read, {
    destinationId: destination.id,
    destination,
    ...options,
  });
  const binding = makeBinding({
    destination,
    operations: compiled.operations,
    settings: {
      ...compiled.settings,
      "openapi-http-profiles": read.definition.authentication,
    },
    definition: read.definition,
  });
  return { read, compiled, binding };
}

test("an export with a binding carries only the approved operations", async () => {
  const { read, compiled, binding } = await approve("openapi-3.1-catalog.json");
  const result = exportOpenApi(read.definition, { binding });
  const paths = result.document.paths as Record<
    string,
    Record<string, unknown>
  >;
  const exported = Object.values(paths).flatMap((item) =>
    Object.values(item).map(
      (operation) => (operation as { operationId: string }).operationId,
    ),
  );
  assert.deepEqual(exported.sort(), compiled.executable.slice().sort());
  // Operations the binding did not approve are deliberately absent, and the
  // omission is reported rather than silent.
  assert.ok(!exported.includes("bulkUpload"));
  assert.ok(!exported.includes("mergeProducts"));
  assert.ok(
    result.losses.some(
      (loss) => loss.code === "policy.unapproved-operations-omitted",
    ),
  );
});

test("an export never carries a private destination or a configuration value", async () => {
  const { read, binding } = await approve("openapi-3.1-catalog.json");
  const result = exportOpenApi(read.definition, { binding });
  assert.deepEqual(result.document.servers, [{ url: "/" }]);
  const text = JSON.stringify(result.document);
  assert.ok(!text.includes("origin.example.test"));
  assert.ok(!text.includes("catalog.example.test"));
  // The omission of the declared servers is itself reported.
  assert.ok(
    result.losses.some(
      (loss) => loss.code === "network.declared-servers-not-exported",
    ),
  );
});

test("an unsupported authentication profile blocks the export of what depends on it", async () => {
  const { read, binding } = await approve("openapi-3.1-catalog.json");
  const result = exportOpenApi(read.definition, { binding });
  const blocking = result.losses.filter((loss) => loss.severity === "blocking");
  assert.ok(blocking.length > 0);
  const loss = blocking.find(
    (item) => item.code === "security.unsupported-profile-not-exported",
  );
  assert.ok(loss);
  assert.equal(loss.category, "security");
  assert.equal(loss.disposition, "unsupported");
  // The digest scheme the runtime cannot execute is not republished as usable.
  const schemes = (
    result.document.components as { securitySchemes?: Record<string, unknown> }
  )?.securitySchemes;
  assert.ok(!Object.hasOwn(schemes ?? {}, "digest"));
});

test("a fully supported description round-trips its claimed semantics", async () => {
  const { read, binding } = await approve("openapi-3.1-recursive.json");
  const exported = exportOpenApi(read.definition, { binding });
  const reread = await readOpenApi(exported.document);
  assert.ok(isReadResult(reread));
  assert.equal(reread.profile, "openapi-3.1");

  // The approved operations survive with their methods and paths.
  const original = new Map(
    read.operations
      .filter((item) =>
        binding.operations.some((bound) => bound.nativeId === item.nativeId),
      )
      .map((item) => [item.nativeId, item]),
  );
  for (const operation of reread.operations) {
    const source = original.get(operation.nativeId);
    assert.ok(source, `${operation.nativeId} was not in the approved set`);
    assert.equal(operation.method, source.method);
    assert.ok(operation.path.endsWith(source.path));
  }
  assert.equal(reread.operations.length, original.size);
});

test("security semantics survive a round trip: alternatives, AND and scopes", async () => {
  const { read, binding } = await approve("openapi-3.1-catalog.json");
  const exported = exportOpenApi(read.definition, { binding });
  const reread = await readOpenApi(exported.document);
  assert.ok(isReadResult(reread));

  const listBefore = securityRequirementsFor(
    read.operations.find((item) => item.nativeId === "listProducts")!,
  );
  const listAfter = securityRequirementsFor(
    reread.operations.find((item) => item.nativeId === "listProducts")!,
  );
  // The bound conjunction is exactly what the export republishes.
  assert.deepEqual(
    listAfter.alternatives[0]?.schemes.map((entry) => entry.scheme).sort(),
    ["apiKey", "tenantHeader"],
  );
  assert.ok(
    listBefore.alternatives.some(
      (alternative) =>
        alternative.schemes
          .map((entry) => entry.scheme)
          .sort()
          .join() === "apiKey,tenantHeader",
    ),
  );

  // The anonymous operation is still anonymous after the round trip.
  const healthAfter = securityRequirementsFor(
    reread.operations.find((item) => item.nativeId === "health")!,
  );
  assert.equal(healthAfter.anonymous, true);
});

test("a re-read export compiles to the same executable subset", async () => {
  const { read, binding, compiled } = await approve(
    "openapi-3.1-recursive.json",
  );
  const exported = exportOpenApi(read.definition, { binding });
  const reread = await readOpenApi(exported.document);
  assert.ok(isReadResult(reread));
  const recompiled = compileOperations(reread.definition, reread, {
    destinationId: destination.id,
    destination,
  });
  assert.deepEqual(
    recompiled.executable.sort(),
    compiled.executable.slice().sort(),
  );
  // Method and path template survive the round trip identically.
  const before = new Map(
    compiled.operations.map((item) => [
      item.nativeId,
      item.transport.kind === "http"
        ? `${item.transport.method} ${item.transport.pathTemplate}`
        : "",
    ]),
  );
  for (const operation of recompiled.operations)
    if (operation.transport.kind === "http")
      assert.equal(
        `${operation.transport.method} ${operation.transport.pathTemplate}`,
        before.get(operation.nativeId),
      );
});

test("effect and consent travel as host policy, not as source facts", async () => {
  const { read, binding } = await approve("openapi-3.1-catalog.json");
  const exported = exportOpenApi(read.definition, { binding });
  const paths = exported.document.paths as Record<
    string,
    Record<string, Record<string, unknown>>
  >;
  const create = Object.values(paths)
    .flatMap((item) => Object.values(item))
    .find((operation) => operation.operationId === "createProduct");
  assert.ok(create);
  assert.equal(create["x-ceremony-effect"], "unknown");
  assert.equal(create["x-ceremony-consent"], "confirm");
  assert.equal(create["x-ceremony-replay"], "none");

  // A reader of the exported document does not treat those annotations as OAS,
  // so re-reading yields unknown effect for the write again.
  const reread = await readOpenApi(exported.document);
  assert.ok(isReadResult(reread));
  const capability = reread.definition.capabilities.find(
    (item) => item.nativeId === "createProduct",
  );
  assert.equal(capability?.effect, "unknown");
});

test("a partially supported description reports its losses and still exports the rest", async () => {
  const { read, binding, compiled } = await approve("openapi-3.0-billing.json");
  const exported = exportOpenApi(read.definition, { binding });
  assert.ok(compiled.blocked.length > 0);
  assert.ok(exported.losses.length > 0);
  const reread = await readOpenApi(exported.document);
  assert.ok(isReadResult(reread));
  // What survives is exactly the approved subset, not a widened one.
  assert.equal(reread.operations.length, binding.operations.length);
  assert.ok(
    reread.operations.every((item) =>
      compiled.executable.includes(item.nativeId),
    ),
  );
});

test("an export without a binding publishes no executable operations", async () => {
  const read = await readFixture("openapi-3.1-catalog.json");
  const exported = exportOpenApi(read.definition);
  assert.deepEqual(exported.document.paths, {});
  assert.ok(
    exported.losses.some(
      (loss) => loss.code === "policy.no-binding-no-operations",
    ),
  );
});

test("native extensions are withheld unless the operator asks for them", async () => {
  const { read, binding } = await approve("openapi-2.0-microsoft.json", {
    assumeJsonWhenUndeclared: false,
  });
  const withheld = exportOpenApi(read.definition, { binding });
  assert.ok(
    !JSON.stringify(withheld.document).includes("x-ms-connector-metadata"),
  );

  const included = exportOpenApi(read.definition, {
    binding,
    includeNativeExtensions: true,
  });
  assert.ok(
    JSON.stringify(included.document).includes("x-ms-connector-metadata"),
  );
});

test("the credential canary never reaches an export, with or without extensions", async () => {
  const read = await readFixture("openapi-3.1-canary.json");
  const compiled = compileOperations(read.definition, read, {
    destinationId: destination.id,
    destination,
  });
  const binding = makeBinding({
    destination,
    operations: compiled.operations,
    settings: {
      ...compiled.settings,
      "openapi-http-profiles": read.definition.authentication,
    },
    definition: read.definition,
  });
  for (const includeNativeExtensions of [false, true]) {
    const exported = exportOpenApi(read.definition, {
      binding,
      includeNativeExtensions,
    });
    const text = JSON.stringify(exported.document);
    assert.ok(
      !text.includes("CANARY_SECRET_9f3"),
      "the exported document leaked the canary",
    );
    for (const value of allStrings(exported.losses))
      assert.ok(
        !value.includes("CANARY_SECRET_9f3"),
        "a loss report leaked the canary",
      );
  }
});

test("events are not republished as an approved surface", async () => {
  const { read, binding } = await approve("openapi-3.1-catalog.json");
  const exported = exportOpenApi(read.definition, { binding });
  assert.equal(
    (exported.document as { webhooks?: unknown }).webhooks,
    undefined,
  );
  assert.ok(
    exported.losses.some(
      (loss) => loss.code === "structure.events-not-exported",
    ),
  );
});

test("the adapter's export dimension emits bytes and losses through the contract", async () => {
  const { read, binding } = await approve("openapi-3.1-recursive.json");
  const context = await harness({ binding });
  const adapter = createOpenApiHttpAdapter();
  const outcome = await adapter.export!(context.ctx, {
    definition: read.definition,
    format: "openapi-3.1",
    includeNativeExtensions: false,
  });
  assert.equal(outcome.mediaType, "application/openapi+json");
  const parsed: unknown = JSON.parse(new TextDecoder().decode(outcome.bytes));
  const reread = await readOpenApi(parsed);
  assert.ok(isReadResult(reread));
  assert.equal(reread.profile, "openapi-3.1");
  assert.ok(Array.isArray(outcome.losses));

  await assert.rejects(
    adapter.export!(context.ctx, {
      definition: read.definition,
      format: "asyncapi-3.0",
      includeNativeExtensions: false,
    }),
    (error: { code?: string; detail?: string }) =>
      error.code === "unsupported" &&
      error.detail === "openapi.export-format-unsupported",
  );
});

test("importing through the adapter records provenance without approving anything", async () => {
  const { binding } = await approve("openapi-3.1-recursive.json");
  const context = await harness({ binding });
  const adapter = createOpenApiHttpAdapter();
  const document = JSON.stringify({
    openapi: "3.1.0",
    info: { title: "Imported", version: "1.0.0" },
    servers: [{ url: "https://imported.example.test" }],
    paths: {
      "/a": {
        get: {
          operationId: "a",
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
    },
  });
  const outcome = await adapter.import!(context.ctx, {
    bytes: new TextEncoder().encode(document),
    mediaType: "application/json",
    origin: { kind: "upload" },
  });
  assert.equal(outcome.definitions.length, 1);
  assert.deepEqual(outcome.executableCandidates, ["a"]);
  assert.equal(outcome.source.format.name, "openapi");
  assert.equal(outcome.source.format.version, "3.1.0");
  assert.match(outcome.source.digest.value, /^[a-f0-9]{64}$/);
  assert.equal(outcome.source.adaptation[0]?.step, "openapi-read");
  // Candidates are candidates; the definition claims no approved invocation.
  assert.equal(
    outcome.definitions[0]?.compatibility.dimensions.invoke,
    "requires-configuration",
  );
});

test("an unreadable import yields diagnostics and no definition", async () => {
  const { binding } = await approve("openapi-3.1-recursive.json");
  const context = await harness({ binding });
  const adapter = createOpenApiHttpAdapter();
  const outcome = await adapter.import!(context.ctx, {
    bytes: new TextEncoder().encode(
      JSON.stringify({ info: { title: "No version" } }),
    ),
    mediaType: "application/json",
    origin: { kind: "upload" },
  });
  assert.deepEqual(outcome.definitions, []);
  assert.deepEqual(outcome.executableCandidates, []);
  assert.equal(outcome.issues[0]?.code, "version.missing");

  await assert.rejects(
    adapter.import!(context.ctx, {
      bytes: new TextEncoder().encode("{not json"),
      mediaType: "application/json",
      origin: { kind: "upload" },
    }),
    (error: { code?: string; detail?: string }) =>
      error.code === "invalid-request" &&
      error.detail === "openapi.document-unparseable",
  );
});

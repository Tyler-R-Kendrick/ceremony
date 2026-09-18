import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { readZapierApp } from "../../../src/server/connectors/formats/zapier/read.js";
import {
  ZAPIER_PROFILES,
  ZAPIER_SOURCES,
} from "../../../src/server/connectors/formats/zapier/profile.js";
import {
  adversarialAppDefinition,
  adversarialAppIdentity,
  adversarialAppSource,
  nativeAppDefinition,
  nativeAppIdentity,
  nativeAppSource,
} from "../fixtures/zapier/app.js";

/*
 * AC-IMP-15 for Zapier. The import must produce useful metadata from a real
 * app definition, and must produce precise inert diagnostics — not silence
 * and not execution — from one whose every interesting value is code.
 */

let sentinelDirectory: string;
let sentinel: string;

before(async () => {
  sentinelDirectory = await mkdtemp(join(tmpdir(), "zapier-sentinel-"));
  sentinel = join(sentinelDirectory, "marker");
});
after(async () => {
  await rm(sentinelDirectory, { recursive: true, force: true });
});

const codes = (issues: ReadonlyArray<{ code: string }>) =>
  new Set(issues.map((issue) => issue.code));

describe("reading an exported Zapier app definition", () => {
  test("imports authentication, actions, fields and endpoints", async () => {
    const result = await readZapierApp({
      json: nativeAppDefinition,
      identity: nativeAppIdentity,
    });
    const definition = result.definition;

    assert.equal(definition.identity.ecosystem, "zapier");
    assert.equal(definition.identity.nativeId, "ledgerly");
    assert.equal(definition.identity.nativeVersion, "1.4.0");
    assert.equal(definition.importer.id, "connectors.formats.zapier");
    assert.equal(definition.nativeExtensions["profile"], ZAPIER_PROFILES.json);
    assert.equal(definition.nativeExtensions["platformVersion"], "17.2.0");

    const profile = definition.authentication[0];
    assert.ok(profile && profile.kind === "oauth-authorization-code");
    assert.equal(
      profile.authorizationEndpoint,
      "https://auth.ledgerly.example/oauth/authorize",
    );
    assert.equal(
      profile.tokenEndpoint,
      "https://auth.ledgerly.example/oauth/token",
    );
    assert.deepEqual(profile.scopes, ["invoices:read", "invoices:write"]);
    assert.equal(profile.pkce, "S256");
    assert.equal(profile.refresh, "supported");

    // A computed field is filled by the platform, so it is never presented as
    // something a deployment can configure.
    const names = definition.configuration.map((item) => item.name);
    assert.deepEqual(names, [
      "ZAPIER_LEDGERLY_CLIENT_ID",
      "ZAPIER_LEDGERLY_CLIENT_SECRET",
    ]);
    assert.equal(
      definition.configuration.find(
        (item) => item.name === "ZAPIER_LEDGERLY_CLIENT_SECRET",
      )?.classification,
      "secret",
    );
    assert.ok(
      (definition.nativeExtensions["limitations"] as string[]).some((item) =>
        item.includes("account_name"),
      ),
    );

    // Zapier's own semantics decide the effect: a create writes, a search and
    // a trigger read. Nothing is inferred from an HTTP method.
    const byId = new Map(
      definition.capabilities.map((capability) => [
        capability.nativeId,
        capability,
      ]),
    );
    assert.deepEqual([...byId.keys()].sort(), [
      "create_invoice",
      "customer.list",
      "find_customer",
      "new_invoice",
    ]);
    assert.equal(byId.get("create_invoice")?.effect, "write");
    assert.equal(byId.get("create_invoice")?.kind, "action");
    assert.equal(byId.get("find_customer")?.effect, "read");
    assert.equal(byId.get("find_customer")?.kind, "query");
    assert.equal(byId.get("new_invoice")?.effect, "read");
    assert.equal(byId.get("new_invoice")?.kind, "query");
    assert.equal(
      byId.get("new_invoice")?.nativeExtensions?.["type"],
      "polling",
    );

    // The static input schema is preserved as the source wrote it.
    const inputFields = byId.get("create_invoice")?.nativeExtensions?.[
      "inputFields"
    ] as Array<Record<string, unknown>>;
    assert.deepEqual(
      inputFields.map((field) => field["key"]),
      ["customer_id", "total_cents", "memo"],
    );
    assert.equal(inputFields[1]?.["type"], "integer");

    // A resource method is identified by resource and method, because the
    // platform's generated key is not stated in the definition.
    const resource = byId.get("customer.list");
    assert.equal(resource?.nativeExtensions?.["resourceKey"], "customer");
    assert.equal(resource?.nativeExtensions?.["resourceMethod"], "list");
    assert.ok(codes(result.issues).has("zapier.resource.generated-key"));

    assert.deepEqual(
      definition.declaredServers.map((server) => server.url).sort(),
      ["https://api.ledgerly.example", "https://auth.ledgerly.example"],
    );
  });

  test("reports dynamic dropdowns and middleware as limitations, not features", async () => {
    const result = await readZapierApp({
      json: nativeAppDefinition,
      identity: nativeAppIdentity,
    });
    const found = codes(result.issues);
    assert.ok(found.has("zapier.field.dynamic-dropdown"));
    assert.ok(found.has("executable-code.function"));
    const middleware = result.issues.find(
      (issue) =>
        issue.code === "executable-code.function" &&
        issue.sourcePointer.includes("beforeRequest"),
    );
    assert.ok(middleware, "middleware is recorded");
    assert.equal(middleware.disposition, "requires-configuration");
    assert.equal(middleware.severity, "warning");
    const limitations = result.definition.nativeExtensions[
      "limitations"
    ] as string[];
    assert.ok(limitations.some((item) => item.includes("middleware")));
    assert.ok(limitations.some((item) => item.includes("Dynamic dropdown")));
  });

  test("never claims full portability: invoke needs a runtime, export is adapted", async () => {
    const result = await readZapierApp({
      json: nativeAppDefinition,
      identity: nativeAppIdentity,
    });
    const dimensions = result.definition.compatibility.dimensions;
    assert.equal(dimensions.import, "exact");
    assert.equal(dimensions.invoke, "requires-configuration");
    assert.equal(dimensions.export, "adapted");
    assert.equal(dimensions.authorize, "requires-configuration");
    assert.equal(dimensions.verify, "unsupported");
    assert.equal(dimensions.discover, "unsupported");
    // Candidates are candidates: nothing here is approved for execution.
    assert.deepEqual(result.executableCandidates.sort(), [
      "create_invoice",
      "customer.list",
      "find_customer",
      "new_invoice",
    ]);
  });
});

describe("reading Zapier CLI source text", () => {
  test("extracts the same actions without loading the module", async () => {
    const result = await readZapierApp({
      sourceText: nativeAppSource,
      identity: nativeAppIdentity,
    });
    assert.equal(
      result.definition.nativeExtensions["profile"],
      ZAPIER_PROFILES.source,
    );
    assert.deepEqual(
      result.definition.capabilities
        .map((capability) => capability.nativeId)
        .sort(),
      ["create_invoice", "customer.list", "find_customer", "new_invoice"],
    );
    const profile = result.definition.authentication[0];
    assert.ok(profile && profile.kind === "oauth-authorization-code");
    assert.equal(
      profile.tokenEndpoint,
      "https://auth.ledgerly.example/oauth/token",
    );
    // `version: require('./package.json').version` is a call, not a literal.
    assert.ok(codes(result.issues).has("zapier.app.version-not-literal"));
    assert.equal(result.definition.compatibility.dimensions.import, "adapted");
  });

  test("a source with no exported object is refused, not guessed at", async () => {
    const result = await readZapierApp({
      sourceText: "const App = { version: '1.0.0' };\nconsole.log(App);\n",
    });
    const blocking = result.issues.filter(
      (issue) => issue.severity === "blocking",
    );
    assert.equal(blocking.length, 1);
    assert.equal(blocking[0]?.code, "zapier.source.no-export");
    assert.equal(blocking[0]?.executionImpact, "blocks-definition");
    assert.deepEqual(result.executableCandidates, []);
  });
});

describe("an adversarial app never executes", () => {
  test("module initializers, shell commands and function bodies stay inert", async () => {
    const before = existsSync(sentinel);
    assert.equal(before, false);
    const source = adversarialAppSource(sentinel);
    // The fixture is text. It is read, not required: no import(), no
    // require(), no eval, no vm, no child process.
    assert.match(source, /execSync/);
    assert.match(source, /writeFileSync/);

    const result = await readZapierApp({
      sourceText: source,
      identity: adversarialAppIdentity,
    });

    assert.equal(
      existsSync(sentinel),
      false,
      "the module initializer did not run",
    );
    assert.equal(
      existsSync(`${sentinel}.shell`),
      false,
      "no shell command ran",
    );

    // Metadata around the code is still imported.
    const ids = result.definition.capabilities.map((c) => c.nativeId).sort();
    assert.deepEqual(ids, ["run_command", "webhook_echo"]);
    const runCommand = result.definition.capabilities.find(
      (capability) => capability.nativeId === "run_command",
    );
    assert.equal(runCommand?.effect, "write");
    assert.deepEqual(runCommand?.nativeExtensions?.["perform"], {
      code: "function",
    });

    // Every piece of code is an inert diagnostic with a pointer.
    const executable = result.issues.filter(
      (issue) => issue.code === "executable-code.function",
    );
    assert.ok(executable.length >= 4);
    for (const issue of executable) {
      assert.equal(issue.category, "executable-code");
      assert.notEqual(issue.disposition, "exact");
      assert.ok(issue.sourcePointer.length > 1);
      // A diagnostic never quotes the source it is about.
      assert.ok(!issue.message.includes("execSync"));
      assert.ok(!issue.message.includes("exfil.example"));
    }
    const pointers = executable.map((issue) => issue.sourcePointer);
    assert.ok(pointers.some((pointer) => pointer.includes("beforeRequest")));
    assert.ok(
      pointers.some((pointer) => pointer.includes("run_command")),
      "the shell action's body is located",
    );
    // A pointer carries a file position so a reviewer can find the construct.
    assert.ok(pointers.some((pointer) => /app\.js:\d+:\d+/.test(pointer)));
  });

  test("custom authentication is unsupported rather than invented", async () => {
    const result = await readZapierApp({
      json: adversarialAppDefinition,
      identity: adversarialAppIdentity,
    });
    const profile = result.definition.authentication[0];
    assert.ok(profile && profile.kind === "unsupported");
    assert.equal(profile.native, "zapier-custom-auth");
    const security = result.issues.find(
      (issue) => issue.category === "security" && issue.severity === "blocking",
    );
    assert.ok(security);
    assert.equal(security.executionImpact, "blocks-authorization");
    assert.equal(
      result.definition.compatibility.dimensions.authorize,
      "unsupported",
    );
    // The app's own fields still become configuration, so the import is useful.
    assert.deepEqual(
      result.definition.configuration.map((item) => item.name),
      ["ZAPIER_ADVERSARIAL_APP_API_KEY"],
    );
  });

  test("templated and credential-bearing URLs never become approved destinations", async () => {
    const result = await readZapierApp({
      json: adversarialAppDefinition,
      identity: adversarialAppIdentity,
    });
    // `{{bundle.authData.api_key}}` is a template, so the URL is not a literal
    // and no destination is derived from it.
    assert.deepEqual(result.definition.declaredServers, []);
    const serialized = JSON.stringify(result.definition);
    assert.ok(!serialized.includes("{{bundle.authData.api_key}}"));
    assert.ok(!serialized.includes("postinstall"));
  });

  test("an app definition that is not an object is rejected", async () => {
    const result = await readZapierApp({ json: ["not", "an", "app"] });
    assert.equal(result.issues[0]?.code, "zapier.app.not-object");
    assert.equal(result.issues[0]?.executionImpact, "blocks-definition");
    assert.deepEqual(result.executableCandidates, []);
  });
});

describe("source provenance", () => {
  test("the pinned schema version and retrieval date travel with the reader", () => {
    assert.equal(ZAPIER_SOURCES.retrievedAt, "2026-09-18");
    assert.match(ZAPIER_SOURCES.schema, /^https:\/\/github\.com\/zapier\//);
  });
});

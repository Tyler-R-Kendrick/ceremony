import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { readWorkatoConnector } from "../../../src/server/connectors/formats/workato/read.js";
import {
  WORKATO_PROFILES,
  WORKATO_SOURCES,
} from "../../../src/server/connectors/formats/workato/profile.js";
import {
  adversarialConnectorIdentity,
  adversarialConnectorProfile,
  adversarialConnectorRuby,
  clientCredentialsProfile,
  nativeConnectorIdentity,
  nativeConnectorProfile,
  nativeConnectorRuby,
  oauthConnectorProfile,
} from "../fixtures/workato/connector.js";

/*
 * AC-IMP-15 for Workato. The Ruby DSL puts almost everything in lambdas, so
 * the two paths differ in how much they can say — and the difference is the
 * point: a static profile that declares a credential's placement can be
 * authorized, and Ruby that hides it in `apply` cannot.
 */

let sentinelDirectory: string;
let sentinel: string;

before(async () => {
  sentinelDirectory = await mkdtemp(join(tmpdir(), "workato-sentinel-"));
  sentinel = join(sentinelDirectory, "marker");
});
after(async () => {
  await rm(sentinelDirectory, { recursive: true, force: true });
});

const codes = (issues: ReadonlyArray<{ code: string }>) =>
  new Set(issues.map((issue) => issue.code));

describe("reading a workato-static-profile document", () => {
  test("imports the connection, the authorization and the actions", async () => {
    const result = await readWorkatoConnector({
      staticProfile: nativeConnectorProfile,
      identity: nativeConnectorIdentity,
    });
    const definition = result.definition;

    assert.equal(definition.identity.ecosystem, "workato");
    assert.equal(definition.identity.nativeId, "stockroom");
    assert.equal(definition.identity.nativeVersion, "2026-09-01");
    assert.equal(
      definition.nativeExtensions["profile"],
      WORKATO_PROFILES.staticProfile,
    );

    const profile = definition.authentication[0];
    assert.ok(profile && profile.kind === "api-key");
    assert.equal(profile.placement, "header");
    assert.equal(profile.parameterName, "X-Stockroom-Key");

    assert.deepEqual(
      definition.configuration.map((item) => `${item.name}:${item.required}`),
      [
        "WORKATO_STOCKROOM_API_KEY:true",
        // `optional: true` is the SDK's way of saying "not required".
        "WORKATO_STOCKROOM_WAREHOUSE:false",
      ],
    );
    assert.equal(definition.configuration[0]?.classification, "secret");

    const capabilities = new Map(
      definition.capabilities.map((capability) => [
        capability.nativeId,
        capability,
      ]),
    );
    assert.deepEqual([...capabilities.keys()].sort(), [
      "adjust_stock",
      "lookup_item",
      "new_shipment",
    ]);
    // An action does not declare whether it reads or writes; a trigger reads.
    assert.equal(capabilities.get("adjust_stock")?.effect, "unknown");
    assert.equal(capabilities.get("adjust_stock")?.kind, "action");
    assert.equal(capabilities.get("new_shipment")?.effect, "read");
    assert.equal(capabilities.get("new_shipment")?.kind, "query");
    assert.equal(
      capabilities.get("new_shipment")?.nativeExtensions?.["deliveryStyle"],
      "poll",
    );
    assert.ok(codes(result.issues).has("workato.action.effect-undeclared"));

    assert.deepEqual(
      capabilities.get("adjust_stock")?.nativeExtensions?.["input_fields"],
      [
        { name: "sku", optional: false, label: "SKU" },
        { name: "delta", type: "integer", optional: false, label: "Change by" },
      ],
    );
    assert.deepEqual(definition.nativeExtensions["objectDefinitions"], {
      item: [
        { name: "sku" },
        { name: "quantity", type: "integer" },
        { name: "updated_at", type: "date_time" },
      ],
    });
    assert.deepEqual(
      definition.declaredServers.map((server) => server.url),
      ["https://api.stockroom.example"],
    );
  });

  test("every lambda is recorded as inert, with a pointer", async () => {
    const result = await readWorkatoConnector({
      staticProfile: nativeConnectorProfile,
      identity: nativeConnectorIdentity,
    });
    const executable = result.issues.filter(
      (issue) => issue.code === "executable-code.function",
    );
    assert.ok(executable.length >= 3);
    const pointers = executable.map((issue) => issue.sourcePointer);
    assert.ok(pointers.some((pointer) => pointer.includes("adjust_stock")));
    assert.ok(pointers.some((pointer) => pointer.includes("execute")));
    assert.ok(pointers.some((pointer) => pointer.includes("test")));
    for (const issue of executable)
      assert.equal(issue.category, "executable-code");
    assert.ok(
      (result.definition.nativeExtensions["limitations"] as string[]).some(
        (item) => item.includes("Ruby lambdas"),
      ),
    );
    assert.equal(
      result.definition.compatibility.dimensions.invoke,
      "requires-configuration",
    );
  });

  test("maps the documented OAuth 2.0 and client-credentials shapes", async () => {
    const authorizationCode = await readWorkatoConnector({
      staticProfile: oauthConnectorProfile,
      identity: { nativeId: "stockroom-oauth", nativeVersion: "1" },
    });
    const oauth = authorizationCode.definition.authentication[0];
    assert.ok(oauth && oauth.kind === "oauth-authorization-code");
    assert.equal(
      oauth.authorizationEndpoint,
      "https://auth.stockroom.example/oauth/authorize",
    );
    assert.equal(
      oauth.tokenEndpoint,
      "https://auth.stockroom.example/oauth/token",
    );
    assert.equal(oauth.pkce, "S256");
    assert.equal(oauth.refresh, "supported");
    assert.deepEqual(oauth.scopes, ["stock.read", "stock.write"]);

    // The SDK writes the client-credentials grant as `custom_auth`.
    const clientCredentials = await readWorkatoConnector({
      staticProfile: clientCredentialsProfile,
      identity: { nativeId: "stockroom-machine", nativeVersion: "1" },
    });
    const machine = clientCredentials.definition.authentication[0];
    assert.ok(machine && machine.kind === "oauth-client-credentials");
    assert.equal(
      machine.tokenEndpoint,
      "https://auth.stockroom.example/oauth/token",
    );
    assert.deepEqual(machine.scopes, ["stock.read"]);
  });
});

describe("reading Workato Ruby source", () => {
  test("extracts literal hash entries and nothing else", async () => {
    const result = await readWorkatoConnector({
      rubySource: nativeConnectorRuby,
      identity: nativeConnectorIdentity,
    });
    assert.equal(
      result.definition.nativeExtensions["profile"],
      WORKATO_PROFILES.ruby,
    );
    assert.equal(result.definition.compatibility.dimensions.import, "adapted");

    // Connection fields, action names and literal field arrays survive.
    assert.deepEqual(
      result.definition.configuration.map((item) => item.name),
      ["WORKATO_STOCKROOM_API_KEY", "WORKATO_STOCKROOM_WAREHOUSE"],
    );
    assert.deepEqual(
      result.definition.capabilities
        .map((capability) => capability.nativeId)
        .sort(),
      ["adjust_stock", "lookup_item", "new_shipment"],
    );
    const lookup = result.definition.capabilities.find(
      (capability) => capability.nativeId === "lookup_item",
    );
    assert.deepEqual(lookup?.nativeExtensions?.["input_fields"], [
      { name: "sku", optional: false, label: "SKU" },
    ]);
    // The connector's own hint travels, with its escaped-quote continuation.
    assert.match(
      result.definition.configuration[0]?.description ?? "",
      /API key\. Found under Settings/,
    );
    assert.ok(codes(result.issues).has("workato.source.literal-only"));
  });

  test("a field list written as a lambda is a loss, not an empty list", async () => {
    const result = await readWorkatoConnector({
      rubySource: nativeConnectorRuby,
      identity: nativeConnectorIdentity,
    });
    const adjust = result.definition.capabilities.find(
      (capability) => capability.nativeId === "adjust_stock",
    );
    assert.equal(adjust?.nativeExtensions?.["input_fields"], undefined);
    const loss = result.issues.find(
      (issue) =>
        issue.code === "executable-code.function" &&
        issue.sourcePointer.includes("adjust_stock") &&
        issue.sourcePointer.includes("input_fields"),
    );
    assert.ok(loss);
    assert.match(loss.message, /Ruby lambda/);
    assert.equal(loss.disposition, "requires-configuration");
  });

  test("a credential placed only inside `apply` is unsupported, not guessed", async () => {
    const result = await readWorkatoConnector({
      rubySource: nativeConnectorRuby,
      identity: nativeConnectorIdentity,
    });
    const profile = result.definition.authentication[0];
    assert.ok(profile && profile.kind === "unsupported");
    assert.equal(profile.native, "workato-api-key-placement");
    const security = result.issues.find(
      (issue) => issue.category === "security" && issue.severity === "blocking",
    );
    assert.ok(security);
    assert.equal(security.executionImpact, "blocks-authorization");
    assert.equal(
      result.definition.compatibility.dimensions.authorize,
      "unsupported",
    );
    // The same connector, with the placement declared, is importable.
    const declared = await readWorkatoConnector({
      staticProfile: nativeConnectorProfile,
      identity: nativeConnectorIdentity,
    });
    assert.equal(declared.definition.authentication[0]?.kind, "api-key");
  });

  test("a base URI built in Ruby never becomes an approved destination", async () => {
    const result = await readWorkatoConnector({
      rubySource: nativeConnectorRuby,
      identity: nativeConnectorIdentity,
    });
    // `base_uri` is a lambda here, even though its body is a literal string.
    assert.deepEqual(result.definition.declaredServers, []);
    assert.ok(
      (result.definition.nativeExtensions["limitations"] as string[]).some(
        (item) => item.includes("base URI"),
      ),
    );
  });

  test("a hash key that aliases prototype machinery reads like any other key", async () => {
    // `"__proto__" => {...}` is a key a connector may simply contain. Assigning
    // it while converting the hash to plain data would call the prototype
    // setter instead of adding a property, and the description that came out
    // would then be refused as "not JSON" by the definition schema: one key in
    // the source turning the whole read into an exception rather than a
    // description plus diagnostics.
    const hostile = nativeConnectorRuby.replace(
      "name: 'api_key',",
      `name: 'api_key',\n        "__proto__" => { "polluted" => true },`,
    );
    const result = await readWorkatoConnector({
      rubySource: hostile,
      identity: nativeConnectorIdentity,
    });
    const benign = await readWorkatoConnector({
      rubySource: nativeConnectorRuby,
      identity: nativeConnectorIdentity,
    });
    assert.deepEqual(
      result.definition.configuration.map((item) => item.name),
      benign.definition.configuration.map((item) => item.name),
    );
    assert.deepEqual(codes(result.issues), codes(benign.issues));
    // Nothing reached Object.prototype on the way through.
    assert.equal(
      ({} as Record<string, unknown>)["polluted"],
      undefined,
      "no global prototype was touched",
    );
  });
});

describe("an adversarial connector never executes", () => {
  test("top-level Ruby, shell commands and eval stay inert", async () => {
    assert.equal(existsSync(sentinel), false);
    const source = adversarialConnectorRuby(sentinel);
    assert.match(source, /system\(/);
    assert.match(source, /eval\(/);

    const result = await readWorkatoConnector({
      rubySource: source,
      identity: adversarialConnectorIdentity,
    });

    assert.equal(existsSync(sentinel), false, "no Ruby ran");
    assert.equal(
      existsSync(`${sentinel}.shell`),
      false,
      "no shell command ran",
    );
    assert.equal(
      existsSync(`${sentinel}.shell.backtick`),
      false,
      "no backtick command ran",
    );

    // Metadata around the code is still imported.
    assert.deepEqual(
      result.definition.capabilities
        .map((capability) => capability.nativeId)
        .sort(),
      ["on_anything", "read_file", "run_shell"],
    );
    const webhookTrigger = result.definition.capabilities.find(
      (capability) => capability.nativeId === "on_anything",
    );
    assert.equal(webhookTrigger?.kind, "event");
    assert.equal(result.definition.events[0]?.transport, "http-webhook");
    assert.equal(result.definition.events[0]?.verification, "vendor");

    for (const issue of result.issues) {
      assert.ok(!issue.message.includes("system("));
      assert.ok(!issue.message.includes("exfil.example"));
      assert.ok(!issue.message.includes("eval("));
    }
    const serialized = JSON.stringify(result.definition);
    assert.ok(!serialized.includes("exfil.example"));
    assert.ok(!serialized.includes("whoami"));
  });

  test("a heredoc and an interpolated string are values this reader refuses", async () => {
    const result = await readWorkatoConnector({
      rubySource: adversarialConnectorRuby(sentinel),
      identity: adversarialConnectorIdentity,
    });
    // The `host` field's hint is a heredoc, so the field imports without it.
    const host = result.definition.configuration.find((item) =>
      item.name.endsWith("HOST"),
    );
    assert.ok(host);
    assert.equal(host.description, undefined);
    // `base_uri` interpolates the host, so no destination is derived.
    assert.deepEqual(result.definition.declaredServers, []);
  });

  test("the static-profile spelling of the same connector agrees", async () => {
    const result = await readWorkatoConnector({
      staticProfile: adversarialConnectorProfile,
      identity: adversarialConnectorIdentity,
    });
    const profile = result.definition.authentication[0];
    assert.ok(profile && profile.kind === "unsupported");
    assert.equal(profile.native, "workato-custom-auth");
    assert.deepEqual(
      result.definition.capabilities
        .map((capability) => capability.nativeId)
        .sort(),
      ["on_anything", "run_shell"],
    );
    assert.deepEqual(result.definition.declaredServers, []);
  });

  test("Ruby with no connector hash is refused", async () => {
    const result = await readWorkatoConnector({
      rubySource: "require 'json'\nputs 'hello'\n",
    });
    const blocking = result.issues.filter(
      (issue) => issue.severity === "blocking",
    );
    assert.equal(blocking[0]?.code, "workato.source.no-connector-hash");
    assert.equal(blocking[0]?.executionImpact, "blocks-definition");
    assert.deepEqual(result.executableCandidates, []);
  });
});

describe("source provenance", () => {
  test("the SDK reference and retrieval date travel with the reader", () => {
    assert.equal(WORKATO_SOURCES.retrievedAt, "2026-09-18");
    assert.match(WORKATO_SOURCES.authorization, /sdk-reference\/connection\//);
  });
});

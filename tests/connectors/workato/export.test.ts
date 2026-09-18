import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { readWorkatoConnector } from "../../../src/server/connectors/formats/workato/read.js";
import {
  WORKATO_EXPORT_EXTENSION_KEYS,
  exportWorkatoStatic,
} from "../../../src/server/connectors/formats/workato/export.js";
import {
  WORKATO_LAMBDA_MARKER,
  WORKATO_PROFILES,
} from "../../../src/server/connectors/formats/workato/profile.js";
import { automationSupportedSubset } from "../../../src/server/connectors/formats/automation/definition.js";
import {
  adversarialConnectorIdentity,
  adversarialConnectorRuby,
  nativeConnectorIdentity,
  nativeConnectorProfile,
  oauthConnectorProfile,
} from "../fixtures/workato/connector.js";

/*
 * AC-IMP-14 for Workato. Workato publishes no non-Ruby serialization, so the
 * export writes the profile this repository defines — and says plainly that
 * the result is a description, not a connector.
 */

const subset = (definition: Parameters<typeof exportWorkatoStatic>[0]) =>
  automationSupportedSubset(definition, WORKATO_EXPORT_EXTENSION_KEYS);

describe("exporting a Workato description", () => {
  test("read, export and read again agree on the supported subset", async () => {
    const first = await readWorkatoConnector({
      staticProfile: nativeConnectorProfile,
      identity: nativeConnectorIdentity,
    });
    const exported = exportWorkatoStatic(first.definition);
    const second = await readWorkatoConnector({
      staticProfile: JSON.parse(
        new TextDecoder().decode(exported.bytes),
      ) as unknown,
      identity: nativeConnectorIdentity,
    });
    assert.deepEqual(subset(second.definition), subset(first.definition));
  });

  test("an OAuth 2.0 connector round-trips its endpoints and PKCE method", async () => {
    const identity = { nativeId: "stockroom-oauth", nativeVersion: "1" };
    const first = await readWorkatoConnector({
      staticProfile: oauthConnectorProfile,
      identity,
    });
    const exported = exportWorkatoStatic(first.definition);
    const second = await readWorkatoConnector({
      staticProfile: exported.document,
      identity,
    });
    assert.deepEqual(
      second.definition.authentication,
      first.definition.authentication,
    );
    const connection = (
      exported.document as Record<string, Record<string, unknown>>
    )["connection"];
    assert.deepEqual(connection?.["authorization"], {
      type: "oauth2",
      authorization_url: "https://auth.stockroom.example/oauth/authorize",
      token_url: "https://auth.stockroom.example/oauth/token",
      scopes: ["stock.read", "stock.write"],
      pkce: { challenge_method: "S256" },
      refresh: WORKATO_LAMBDA_MARKER,
    });
  });

  test("the exported document is a static profile, with lambdas as markers", async () => {
    const first = await readWorkatoConnector({
      staticProfile: nativeConnectorProfile,
      identity: nativeConnectorIdentity,
    });
    const exported = exportWorkatoStatic(first.definition);
    const document = exported.document as Record<string, unknown>;
    assert.equal(document["profile"], WORKATO_PROFILES.export);
    assert.equal(document["title"], "Stockroom");
    assert.deepEqual(document["test"], WORKATO_LAMBDA_MARKER);
    const actions = document["actions"] as Record<
      string,
      Record<string, unknown>
    >;
    assert.deepEqual(
      actions["adjust_stock"]?.["execute"],
      WORKATO_LAMBDA_MARKER,
    );
    assert.deepEqual(actions["adjust_stock"]?.["input_fields"], [
      { name: "sku", optional: false, label: "SKU" },
      { name: "delta", type: "integer", optional: false, label: "Change by" },
    ]);
    assert.deepEqual(document["object_definitions"], {
      item: {
        fields: [
          { name: "sku" },
          { name: "quantity", type: "integer" },
          { name: "updated_at", type: "date_time" },
        ],
      },
    });
    const codes = exported.losses.map((loss) => loss.code);
    assert.ok(codes.includes("export.workato.lambda-marker"));
    assert.ok(codes.includes("export.workato.not-a-connector"));
  });

  test("an unimported credential placement is a security-critical loss", async () => {
    const first = await readWorkatoConnector({
      rubySource: adversarialConnectorRuby(
        "/tmp/workato-export-sentinel-never",
      ),
      identity: adversarialConnectorIdentity,
    });
    const exported = exportWorkatoStatic(first.definition);
    const loss = exported.losses.find(
      (item) => item.code === "export.workato.authorization-not-imported",
    );
    assert.ok(loss);
    assert.equal(loss.severity, "blocking");
    assert.equal(loss.executionImpact, "blocks-authorization");
    const serialized = JSON.stringify(exported.document);
    assert.ok(!serialized.includes("exfil.example"));
    assert.ok(!serialized.includes("system("));
  });

  test("a field list that was a lambda is reported as absent, not invented", async () => {
    const first = await readWorkatoConnector({
      rubySource: adversarialConnectorRuby(
        "/tmp/workato-export-sentinel-never",
      ),
      identity: adversarialConnectorIdentity,
    });
    const exported = exportWorkatoStatic(first.definition);
    const actions = (exported.document as Record<string, unknown>)[
      "actions"
    ] as Record<string, Record<string, unknown>>;
    assert.equal(actions["run_shell"]?.["input_fields"], undefined);
    assert.ok(
      exported.losses.some(
        (loss) =>
          loss.code === "export.workato.fields-not-imported" &&
          loss.sourcePointer.includes("run_shell"),
      ),
    );
  });

  test("a description from another ecosystem is refused, not translated", async () => {
    const first = await readWorkatoConnector({
      staticProfile: nativeConnectorProfile,
      identity: nativeConnectorIdentity,
    });
    const exported = exportWorkatoStatic({
      ...first.definition,
      identity: { ...first.definition.identity, ecosystem: "zapier" },
    });
    assert.deepEqual(exported.document, {});
    assert.equal(exported.losses[0]?.code, "export.workato.wrong-ecosystem");
  });
});

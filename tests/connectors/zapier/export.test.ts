import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { readZapierApp } from "../../../src/server/connectors/formats/zapier/read.js";
import {
  ZAPIER_EXPORT_EXTENSION_KEYS,
  exportZapierStatic,
} from "../../../src/server/connectors/formats/zapier/export.js";
import { automationSupportedSubset } from "../../../src/server/connectors/formats/automation/definition.js";
import { ZAPIER_FUNC_PLACEHOLDER } from "../../../src/server/connectors/formats/zapier/profile.js";
import {
  adversarialAppDefinition,
  adversarialAppIdentity,
  nativeAppDefinition,
  nativeAppIdentity,
} from "../fixtures/zapier/app.js";

/*
 * AC-IMP-14 for Zapier: what the export claims must survive a round trip, and
 * what it cannot carry must be named. The claim is deliberately narrow — the
 * descriptive metadata, not the code — and the test is written against that
 * exact claim rather than against a hope.
 */

const subset = (definition: Parameters<typeof exportZapierStatic>[0]) =>
  automationSupportedSubset(definition, ZAPIER_EXPORT_EXTENSION_KEYS);

describe("exporting a Zapier description", () => {
  test("read, export and read again agree on the supported subset", async () => {
    const first = await readZapierApp({
      json: nativeAppDefinition,
      identity: nativeAppIdentity,
    });
    const exported = exportZapierStatic(first.definition);
    assert.equal(exported.mediaType, "application/json");
    const second = await readZapierApp({
      json: JSON.parse(new TextDecoder().decode(exported.bytes)) as unknown,
      identity: nativeAppIdentity,
    });
    assert.deepEqual(subset(second.definition), subset(first.definition));
  });

  test("the exported document is in the vendor's own shape", async () => {
    const first = await readZapierApp({
      json: nativeAppDefinition,
      identity: nativeAppIdentity,
    });
    const document = exportZapierStatic(first.definition).document as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    assert.equal(document["version"] as unknown, "1.4.0");
    assert.equal(document["platformVersion"] as unknown, "17.2.0");
    assert.equal(document["authentication"]?.["type"] as unknown, "oauth2");
    assert.deepEqual(
      document["authentication"]?.["oauth2Config"]?.["authorizeUrl"],
      { method: "GET", url: "https://auth.ledgerly.example/oauth/authorize" },
    );
    // A literal request survives as a literal request.
    assert.deepEqual(
      (document["creates"]?.["create_invoice"] as Record<string, unknown>)?.[
        "operation"
      ],
      {
        perform: {
          method: "POST",
          url: "https://api.ledgerly.example/v1/invoices",
        },
        inputFields: [
          {
            key: "customer_id",
            label: "Customer",
            type: "string",
            required: true,
            dynamic: "find_customer.id.email",
          },
          {
            key: "total_cents",
            label: "Total (cents)",
            type: "integer",
            required: true,
          },
          { key: "memo", label: "Memo", type: "text" },
        ],
        sample: { id: "inv_2", status: "draft", total_cents: 1000 },
      },
    );
    assert.ok(document["resources"]?.["customer"]);
  });

  test("code becomes the platform's own function marker, and the loss is reported", async () => {
    const first = await readZapierApp({
      json: adversarialAppDefinition,
      identity: adversarialAppIdentity,
    });
    const exported = exportZapierStatic(first.definition);
    const document = exported.document as Record<string, unknown>;
    const creates = document["creates"] as Record<
      string,
      { operation: Record<string, unknown> }
    >;
    assert.equal(
      creates["run_command"]?.operation["perform"],
      ZAPIER_FUNC_PLACEHOLDER,
    );
    const serialized = JSON.stringify(document);
    assert.ok(!serialized.includes("execSync"));
    assert.ok(!serialized.includes("exfil.example"));

    const codes = exported.losses.map((loss) => loss.code);
    assert.ok(codes.includes("export.zapier.function-placeholder"));
    assert.ok(codes.includes("export.zapier.not-runnable"));
    // The credential placement was never imported, so exporting it would be a
    // security-critical loss: it blocks the affected execution.
    const security = exported.losses.find(
      (loss) => loss.code === "export.zapier.authentication-not-imported",
    );
    assert.ok(security);
    assert.equal(security.severity, "blocking");
    assert.equal(security.executionImpact, "blocks-authorization");
  });

  test("an adversarial app still round-trips the metadata it does carry", async () => {
    const first = await readZapierApp({
      json: adversarialAppDefinition,
      identity: adversarialAppIdentity,
    });
    const exported = exportZapierStatic(first.definition);
    const second = await readZapierApp({
      json: exported.document,
      identity: adversarialAppIdentity,
    });
    assert.deepEqual(subset(second.definition), subset(first.definition));
  });

  test("a description from another ecosystem is refused, not translated", async () => {
    const first = await readZapierApp({
      json: nativeAppDefinition,
      identity: nativeAppIdentity,
    });
    const foreign = {
      ...first.definition,
      identity: { ...first.definition.identity, ecosystem: "n8n" },
    };
    const exported = exportZapierStatic(foreign);
    assert.deepEqual(exported.document, {});
    assert.equal(exported.losses[0]?.code, "export.zapier.wrong-ecosystem");
    assert.equal(exported.losses[0]?.executionImpact, "blocks-definition");
  });
});

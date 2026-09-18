import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { readZapierApp } from "../../../src/server/connectors/formats/zapier/read.js";
import {
  EXTERNAL_RUNTIME_PROTOCOL,
  SIGNATURE_HEADER,
  SIGNATURE_KEY_ID_HEADER,
  createExternalRuntimeAdapter,
  describeExternalRuntimeBindings,
  externalRuntimeBindingSchema,
  validateRuntimeValue,
  type ExternalRuntimeBinding,
  type RuntimeFieldSchema,
} from "../../../src/server/connectors/formats/automation/external-runtime.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type { AdapterCallContext } from "../../../src/server/connectors/adapter.js";
import type { NativeCapability } from "../../../src/core/connectors/index.js";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";
import {
  RUNTIME_KEY_ID,
  RUNTIME_PATH,
  connectionWithSecret,
  delegatedBinding,
  startExternalRuntime,
} from "../fixtures/automation/external-runtime.js";
import {
  nativeAppDefinition,
  nativeAppIdentity,
} from "../fixtures/zapier/app.js";

/*
 * The whole path, end to end: a Zapier app definition is imported statically,
 * one of its creates is bound to a runtime the host registered, and the
 * adapter invokes it. The imported description contributes the operation's
 * identity and its input shape; it contributes no destination, no credential
 * and no permission. Those come from the binding, which is a decision, and
 * from custody, which is the host's.
 */

/** Turns an imported Zapier input-field list into the binding's input schema. */
function schemaFromZapierFields(
  capability: NativeCapability,
): RuntimeFieldSchema {
  const fields = (capability.nativeExtensions?.["inputFields"] ?? []) as Array<
    Record<string, unknown>
  >;
  const properties: Record<string, RuntimeFieldSchema> = {};
  const required: string[] = [];
  for (const field of fields) {
    const key = field["key"];
    if (typeof key !== "string") continue;
    const type = field["type"];
    properties[key] =
      type === "integer"
        ? { type: "integer" }
        : type === "number"
          ? { type: "number" }
          : type === "boolean"
            ? { type: "boolean" }
            : { type: "string", maxLength: 4096 };
    if (field["required"] === true) required.push(key);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

const OUTPUT_SCHEMA: RuntimeFieldSchema = {
  type: "object",
  properties: {
    id: { type: "string", maxLength: 128 },
    status: { type: "string", enum: ["draft", "sent", "paid"] },
    total_cents: { type: "integer", minimum: 0 },
  },
  required: ["id", "status"],
  additionalProperties: false,
};

const OPERATION_REF = "operation:zapier:create_invoice";

async function importedCreate() {
  const imported = await readZapierApp({
    json: nativeAppDefinition,
    identity: nativeAppIdentity,
  });
  const capability = imported.definition.capabilities.find(
    (item) => item.nativeId === "create_invoice",
  );
  assert.ok(capability, "the create is a supported static import");
  assert.ok(imported.executableCandidates.includes("create_invoice"));
  return { imported, capability };
}

function runtimeBindingFor(
  capability: NativeCapability,
  overrides: Partial<ExternalRuntimeBinding> = {},
): ExternalRuntimeBinding {
  return externalRuntimeBindingSchema.parse({
    operationRef: OPERATION_REF,
    identity: {
      ecosystem: "zapier",
      nativeId: capability.nativeId,
      nativeVersion: "1.4.0",
    },
    destinationId: "runtime",
    path: RUNTIME_PATH,
    owner: { kind: "user", id: fixtureActor.subjectId },
    account: {
      authority: "https://runtime.example",
      externalIdName: "zapierAccountId",
      externalId: "acct_7",
    },
    input: schemaFromZapierFields(capability),
    output: OUTPUT_SCHEMA,
    effect: "write",
    outputClassification: "personal",
    replay: "none",
    environmentClass: "loopback-fixture",
    timeoutMs: 5_000,
    ...overrides,
  });
}

type Harness = Awaited<ReturnType<typeof harness>>;

async function harness(
  options: {
    behaviour?: NonNullable<
      Parameters<typeof startExternalRuntime>[0]
    >["behaviour"];
    bindingOverrides?: Partial<ExternalRuntimeBinding>;
    externalIds?: Record<string, string>;
  } = {},
) {
  const { capability } = await importedCreate();
  const runtime = await startExternalRuntime(
    options.behaviour ? { behaviour: options.behaviour } : {},
  );
  const ports = memoryPorts();
  const binding = delegatedBinding({
    origin: runtime.origin,
    operationRef: OPERATION_REF,
    nativeId: "create_invoice",
    effect: "write",
  });
  const connection = await connectionWithSecret(ports, {
    binding,
    ecosystem: "zapier",
    service: "ledgerly",
    externalIds: options.externalIds ?? { zapierAccountId: "acct_7" },
  });
  const external = runtimeBindingFor(
    capability,
    options.bindingOverrides ?? {},
  );
  const adapter = createExternalRuntimeAdapter({ bindings: [external] });
  const controller = new AbortController();
  const ctx: AdapterCallContext = {
    actor: fixtureActor,
    binding,
    connection,
    generation: 0,
    signal: controller.signal,
    environment: ports.environment({ fetch }),
  };
  return {
    adapter,
    ctx,
    ports,
    runtime,
    binding,
    external,
    capability,
    connection,
    async close() {
      controller.abort();
      await runtime.close();
    },
  };
}

const withHarness = async (
  options: Parameters<typeof harness>[0],
  body: (harness: Harness) => Promise<void>,
) => {
  const built = await harness(options);
  try {
    await body(built);
  } finally {
    await built.close();
  }
};

describe("binding a statically imported Zapier action to an approved runtime", () => {
  test("invokes it, signs the request and journals the effect", async () => {
    await withHarness({}, async (h) => {
      const result = await h.adapter.invoke!(h.ctx, {
        operationRef: OPERATION_REF,
        input: { customer_id: "cus_1", total_cents: 4200, memo: "September" },
        commandId: "command-1",
      });

      assert.equal(result.state, "complete");
      assert.equal(result.effect, "write");
      assert.equal(result.outputClassification, "personal");
      assert.deepEqual(result.output, {
        id: "inv_101",
        status: "draft",
        total_cents: 4200,
      });

      assert.equal(h.runtime.calls.length, 1);
      const call = h.runtime.calls[0]!;
      assert.equal(call.signatureValid, true, "the runtime verified the HMAC");
      assert.equal(call.keyId, RUNTIME_KEY_ID);
      assert.match(call.headers[SIGNATURE_HEADER] ?? "", /^v1=[0-9a-f]{64}$/);
      const body = call.body as Record<string, unknown>;
      assert.equal(body["protocol"], EXTERNAL_RUNTIME_PROTOCOL);
      assert.deepEqual(body["operation"], {
        ecosystem: "zapier",
        nativeId: "create_invoice",
        nativeVersion: "1.4.0",
      });
      assert.equal(body["environmentClass"], "loopback-fixture");
      assert.deepEqual(body["owner"], {
        kind: "user",
        id: fixtureActor.subjectId,
      });
      // The signing secret never leaves custody.
      const serialized = JSON.stringify(call);
      assert.ok(!serialized.includes("fixture-external-runtime-secret"));

      const journal = h.ports.inspect.effects();
      assert.equal(journal.length, 1);
      assert.equal(journal[0]?.outcome?.status, "applied");
      assert.equal(
        journal[0]?.intent.operation,
        "external-runtime:zapier:create_invoice",
      );
    });
  });

  test("a repeated write is the same effect, not a second one", async () => {
    await withHarness({}, async (h) => {
      const input = { customer_id: "cus_1", total_cents: 4200 };
      const first = await h.adapter.invoke!(h.ctx, {
        operationRef: OPERATION_REF,
        input,
        commandId: "command-1",
      });
      assert.equal(first.state, "complete");
      const second = await h.adapter.invoke!(h.ctx, {
        operationRef: OPERATION_REF,
        input,
        commandId: "command-2",
      });
      assert.equal(second.state, "complete");
      assert.equal(second.code, "effect.replayed");
      assert.equal(second.output, undefined);
      assert.equal(h.runtime.calls.length, 1, "the runtime was called once");
    });
  });

  test("a lost response leaves a write indeterminate, never failed", async () => {
    await withHarness({ behaviour: () => ({ kind: "drop" }) }, async (h) => {
      const result = await h.adapter.invoke!(h.ctx, {
        operationRef: OPERATION_REF,
        input: { customer_id: "cus_9", total_cents: 100 },
        commandId: "command-1",
      });
      assert.equal(result.state, "indeterminate");
      assert.equal(result.code, "upstream.unreachable");
      const journal = h.ports.inspect.effects();
      assert.equal(journal[0]?.outcome?.status, "indeterminate");
    });
  });

  test("a reply this adapter cannot read leaves a write indeterminate", async () => {
    await withHarness(
      {
        behaviour: () => ({
          kind: "reply",
          body: { protocol: EXTERNAL_RUNTIME_PROTOCOL, status: "sure-thing" },
        }),
      },
      async (h) => {
        const result = await h.adapter.invoke!(h.ctx, {
          operationRef: OPERATION_REF,
          input: { customer_id: "cus_9", total_cents: 100 },
          commandId: "command-1",
        });
        assert.equal(result.state, "indeterminate");
        assert.equal(result.code, "upstream.malformed");
      },
    );
  });

  test("an output that does not match the approved schema is not a success", async () => {
    await withHarness(
      {
        behaviour: () => ({
          kind: "reply",
          body: {
            protocol: EXTERNAL_RUNTIME_PROTOCOL,
            status: "completed",
            output: { id: "inv_1", status: "shipped", secret: "leak" },
          },
        }),
      },
      async (h) => {
        const result = await h.adapter.invoke!(h.ctx, {
          operationRef: OPERATION_REF,
          input: { customer_id: "cus_9", total_cents: 100 },
          commandId: "command-1",
        });
        assert.equal(result.state, "indeterminate");
        assert.equal(result.code, "upstream.output-schema");
        assert.equal(result.output, undefined);
      },
    );
  });

  test("the runtime cannot report a state the contract does not have", async () => {
    await withHarness(
      {
        behaviour: () => ({
          kind: "reply",
          body: {
            protocol: EXTERNAL_RUNTIME_PROTOCOL,
            status: "denied",
            code: "runtime.policy",
          },
        }),
      },
      async (h) => {
        const result = await h.adapter.invoke!(h.ctx, {
          operationRef: OPERATION_REF,
          input: { customer_id: "cus_9", total_cents: 100 },
          commandId: "command-1",
        });
        assert.equal(result.state, "denied");
        assert.equal(result.code, "runtime.policy");
        assert.equal(
          h.ports.inspect.effects()[0]?.outcome?.status,
          "not-applied",
        );
      },
    );
  });
});

describe("what the binding refuses", () => {
  test("input that does not match the approved shape never reaches the runtime", async () => {
    await withHarness({}, async (h) => {
      await assert.rejects(
        h.adapter.invoke!(h.ctx, {
          operationRef: OPERATION_REF,
          input: { customer_id: "cus_1", total_cents: "lots" },
          commandId: "command-1",
        }),
        (error: unknown) =>
          error instanceof ConnectorError &&
          error.code === "invalid-request" &&
          error.detail === "input.schema",
      );
      assert.equal(h.runtime.calls.length, 0);
    });
  });

  test("an operation with no approved runtime binding is unsupported", async () => {
    await withHarness({}, async (h) => {
      await assert.rejects(
        h.adapter.invoke!(h.ctx, {
          operationRef: "operation:zapier:delete_everything",
          input: {},
          commandId: "command-1",
        }),
        (error: unknown) =>
          error instanceof ConnectorError && error.code === "denied",
      );
      assert.equal(h.runtime.calls.length, 0);
    });
  });

  test("a connection for a different upstream account is refused", async () => {
    await withHarness(
      { externalIds: { zapierAccountId: "acct_other" } },
      async (h) => {
        await assert.rejects(
          h.adapter.invoke!(h.ctx, {
            operationRef: OPERATION_REF,
            input: { customer_id: "cus_1", total_cents: 1 },
            commandId: "command-1",
          }),
          (error: unknown) =>
            error instanceof ConnectorError &&
            error.code === "denied" &&
            error.detail === "account.mismatch",
        );
        assert.equal(h.runtime.calls.length, 0);
      },
    );
  });

  test("a connection owned by someone else is refused", async () => {
    await withHarness({}, async (h) => {
      const foreign: AdapterCallContext = {
        ...h.ctx,
        connection: { ...h.connection, ownerId: "subject-2" },
      };
      await assert.rejects(
        h.adapter.invoke!(foreign, {
          operationRef: OPERATION_REF,
          input: { customer_id: "cus_1", total_cents: 1 },
          commandId: "command-1",
        }),
        (error: unknown) =>
          error instanceof ConnectorError &&
          error.code === "denied" &&
          error.detail === "owner.mismatch",
      );
      assert.equal(h.runtime.calls.length, 0);
    });
  });

  test("a runtime whose secret differs cannot be talked to", async () => {
    await withHarness({}, async (h) => {
      const ports = memoryPorts();
      const connection = await connectionWithSecret(ports, {
        binding: h.binding,
        ecosystem: "zapier",
        service: "ledgerly",
        externalIds: { zapierAccountId: "acct_7" },
        secret: "a-different-secret",
      });
      const ctx: AdapterCallContext = {
        ...h.ctx,
        connection,
        environment: ports.environment({ fetch }),
      };
      const result = await h.adapter.invoke!(ctx, {
        operationRef: OPERATION_REF,
        input: { customer_id: "cus_1", total_cents: 1 },
        commandId: "command-1",
      });
      assert.equal(result.state, "failed");
      assert.equal(result.code, "upstream.rejected");
      assert.equal(h.runtime.calls.at(-1)?.signatureValid, false);
    });
  });

  test("a connection with no credential cannot sign, and says so", async () => {
    await withHarness({}, async (h) => {
      const { credentialRef: _dropped, ...rest } = h.connection;
      void _dropped;
      await assert.rejects(
        h.adapter.invoke!(
          { ...h.ctx, connection: rest },
          {
            operationRef: OPERATION_REF,
            input: { customer_id: "cus_1", total_cents: 1 },
            commandId: "command-1",
          },
        ),
        (error: unknown) =>
          error instanceof ConnectorError &&
          error.code === "configuration-required",
      );
      assert.equal(h.runtime.calls.length, 0);
    });
  });
});

describe("what the adapter reports about itself", () => {
  test("it invokes and delegates, and never claims to import", async () => {
    await withHarness({}, async (h) => {
      const rows = h.adapter.capabilities(new Set());
      const byDimension = new Map(rows.map((row) => [row.dimension, row]));
      assert.equal(h.adapter.id, "external-runtime");
      assert.deepEqual([...h.adapter.custody], ["external-execution-broker"]);
      assert.equal(h.adapter.runtime, "hosted-server");
      assert.equal(byDimension.get("invoke")?.implementation, "implemented");
      assert.equal(byDimension.get("invoke")?.configuration, "ready");
      assert.equal(byDimension.get("invoke")?.evidence, "protocol-fixture");
      assert.ok(
        byDimension
          .get("invoke")
          ?.limitations.some((item) =>
            item.includes("never executed inside Ceremony"),
          ),
      );
      assert.equal(byDimension.get("import")?.implementation, "unsupported");
      assert.equal(byDimension.get("import")?.evidence, "not-tested");

      const described = describeExternalRuntimeBindings([h.external]);
      assert.deepEqual(described[0]?.identity, {
        ecosystem: "zapier",
        nativeId: "create_invoice",
        nativeVersion: "1.4.0",
      });
      assert.equal(described[0]?.environmentClass, "loopback-fixture");
    });
  });

  test("the value validator refuses regular expressions and unbounded shapes", () => {
    assert.throws(() =>
      externalRuntimeBindingSchema.parse({
        operationRef: "operation:x",
        identity: { ecosystem: "zapier", nativeId: "x", nativeVersion: "1" },
        destinationId: "runtime",
        path: "/x",
        owner: { kind: "user", id: "u" },
        input: { type: "string", pattern: "(a+)+$" },
        output: { type: "string" },
        effect: "read",
        outputClassification: "public",
        replay: "read-only",
        environmentClass: "loopback-fixture",
      }),
    );
    assert.deepEqual(validateRuntimeValue({ type: "string" }, "ok"), {
      ok: true,
    });
    assert.equal(
      validateRuntimeValue(
        {
          type: "object",
          properties: { a: { type: "string" } },
          additionalProperties: false,
        },
        { a: "x", b: "y" },
      ).ok,
      false,
    );
    // A prototype-polluting key is not a property.
    assert.equal(
      validateRuntimeValue(
        { type: "object", properties: {}, additionalProperties: false },
        JSON.parse('{"__proto__":{"polluted":true}}') as unknown,
      ).ok,
      false,
    );
  });
});

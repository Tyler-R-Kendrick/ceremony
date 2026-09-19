import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { readWorkatoConnector } from "../../../src/server/connectors/formats/workato/read.js";
import {
  EXTERNAL_RUNTIME_PROTOCOL,
  createExternalRuntimeAdapter,
  externalRuntimeBindingSchema,
} from "../../../src/server/connectors/formats/automation/external-runtime.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type { AdapterCallContext } from "../../../src/server/connectors/adapter.js";
import type { RuntimeFieldSchema } from "../../../src/server/connectors/formats/automation/external-runtime.js";
import type { NativeCapability } from "../../../src/core/connectors/index.js";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";
import {
  RUNTIME_PATH,
  connectionWithSecret,
  delegatedBinding,
  startExternalRuntime,
} from "../fixtures/automation/external-runtime.js";
import {
  nativeConnectorIdentity,
  nativeConnectorProfile,
} from "../fixtures/workato/connector.js";

/*
 * One functioning authorized binding for Workato. The Ruby that would do the
 * work is not here and never runs here; the operation runs in a registered
 * runtime, and the imported `input_fields` are what the host validates
 * against before anything is sent.
 */

const OPERATION_REF = "operation:workato:adjust_stock";

/** Turns imported Workato input fields into the binding's input schema. */
function schemaFromWorkatoFields(
  capability: NativeCapability,
): RuntimeFieldSchema {
  const fields = (capability.nativeExtensions?.["input_fields"] ?? []) as Array<
    Record<string, unknown>
  >;
  const properties: Record<string, RuntimeFieldSchema> = {};
  const required: string[] = [];
  for (const field of fields) {
    const name = field["name"];
    if (typeof name !== "string") continue;
    const type = field["type"];
    properties[name] =
      type === "integer"
        ? { type: "integer" }
        : type === "number"
          ? { type: "number" }
          : type === "boolean"
            ? { type: "boolean" }
            : { type: "string", maxLength: 2048 };
    if (field["optional"] === false) required.push(name);
  }
  return { type: "object", properties, required, additionalProperties: false };
}

async function harness(
  options: {
    behaviour?: NonNullable<
      Parameters<typeof startExternalRuntime>[0]
    >["behaviour"];
  } = {},
) {
  const imported = await readWorkatoConnector({
    staticProfile: nativeConnectorProfile,
    identity: nativeConnectorIdentity,
  });
  const capability = imported.definition.capabilities.find(
    (item) => item.nativeId === "adjust_stock",
  );
  assert.ok(capability);
  assert.ok(imported.executableCandidates.includes("adjust_stock"));

  const runtime = await startExternalRuntime(
    options.behaviour
      ? { behaviour: options.behaviour }
      : {
          behaviour: () => ({
            kind: "reply",
            body: {
              protocol: EXTERNAL_RUNTIME_PROTOCOL,
              status: "completed",
              output: { sku: "SKU-1", quantity: 7 },
            },
          }),
        },
  );
  const ports = memoryPorts();
  const binding = delegatedBinding({
    origin: runtime.origin,
    operationRef: OPERATION_REF,
    nativeId: "adjust_stock",
    // Workato does not declare an action's effect, so the host does: this
    // one is approved as a write, which is why it is never replayed.
    effect: "write",
    consent: "confirm",
  });
  const connection = await connectionWithSecret(ports, {
    binding,
    ecosystem: "workato",
    service: "stockroom",
    externalIds: { workatoConnectionId: "conn_42" },
  });
  const external = externalRuntimeBindingSchema.parse({
    operationRef: OPERATION_REF,
    identity: {
      ecosystem: "workato",
      nativeId: "adjust_stock",
      nativeVersion: imported.definition.identity.nativeVersion,
    },
    destinationId: "runtime",
    path: RUNTIME_PATH,
    owner: { kind: "user", id: fixtureActor.subjectId },
    account: {
      authority: "https://runtime.example",
      externalIdName: "workatoConnectionId",
      externalId: "conn_42",
    },
    input: schemaFromWorkatoFields(capability),
    output: {
      type: "object",
      properties: {
        sku: { type: "string", maxLength: 128 },
        quantity: { type: "integer" },
      },
      required: ["sku", "quantity"],
      additionalProperties: false,
    },
    effect: "write",
    outputClassification: "personal",
    replay: "none",
    environmentClass: "vendor-hosted",
    timeoutMs: 5_000,
  });
  const adapter = createExternalRuntimeAdapter({
    bindings: [external],
    ecosystem: "workato",
  });
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
    imported,
    external,
    async close() {
      controller.abort();
      await runtime.close();
    },
  };
}

describe("binding an imported Workato action to an approved runtime", () => {
  test("the imported input fields become the schema the host enforces", async () => {
    const h = await harness();
    try {
      const result = await h.adapter.invoke!(h.ctx, {
        operationRef: OPERATION_REF,
        input: { sku: "SKU-1", delta: 3 },
        commandId: "command-1",
      });
      assert.equal(result.state, "complete");
      assert.equal(result.effect, "write");
      assert.deepEqual(result.output, { sku: "SKU-1", quantity: 7 });

      const call = h.runtime.calls[0]!;
      assert.equal(call.signatureValid, true);
      const body = call.body as Record<string, unknown>;
      assert.deepEqual(body["operation"], {
        ecosystem: "workato",
        nativeId: "adjust_stock",
        nativeVersion: "2026-09-01",
      });
      assert.equal(body["environmentClass"], "vendor-hosted");
      assert.deepEqual(body["account"], {
        authority: "https://runtime.example",
        externalId: "conn_42",
      });
      assert.equal(h.ports.inspect.effects()[0]?.outcome?.status, "applied");
    } finally {
      await h.close();
    }
  });

  test("a required field the connector declared cannot be omitted", async () => {
    const h = await harness();
    try {
      await assert.rejects(
        h.adapter.invoke!(h.ctx, {
          operationRef: OPERATION_REF,
          input: { sku: "SKU-1" },
          commandId: "command-1",
        }),
        (error: unknown) =>
          error instanceof ConnectorError &&
          error.code === "invalid-request" &&
          error.detail === "input.schema",
      );
      assert.equal(h.runtime.calls.length, 0);
    } finally {
      await h.close();
    }
  });

  test("a runtime that asks for a person is not a failure", async () => {
    const h = await harness({
      behaviour: () => ({
        kind: "reply",
        body: {
          protocol: EXTERNAL_RUNTIME_PROTOCOL,
          status: "human-required",
          code: "runtime.approval",
        },
      }),
    });
    try {
      const result = await h.adapter.invoke!(h.ctx, {
        operationRef: OPERATION_REF,
        input: { sku: "SKU-1", delta: 1 },
        commandId: "command-1",
      });
      assert.equal(result.state, "human-required");
      assert.equal(result.code, "runtime.approval");
      assert.equal(
        h.ports.inspect.effects()[0]?.outcome?.status,
        "not-applied",
      );
    } finally {
      await h.close();
    }
  });

  test("an interrupted write is reported uncertain, and not retried blindly", async () => {
    const h = await harness({ behaviour: () => ({ kind: "drop" }) });
    try {
      const first = await h.adapter.invoke!(h.ctx, {
        operationRef: OPERATION_REF,
        input: { sku: "SKU-1", delta: 1 },
        commandId: "command-1",
      });
      assert.equal(first.state, "indeterminate");
      const second = await h.adapter.invoke!(h.ctx, {
        operationRef: OPERATION_REF,
        input: { sku: "SKU-1", delta: 1 },
        commandId: "command-2",
      });
      assert.equal(second.state, "indeterminate");
      assert.equal(second.code, "upstream.unreachable");
      assert.equal(
        h.runtime.calls.length,
        1,
        "the uncertain effect was not repeated",
      );
    } finally {
      await h.close();
    }
  });
});

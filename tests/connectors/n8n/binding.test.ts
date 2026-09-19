import { strict as assert } from "node:assert";
import { describe, test } from "node:test";
import { readN8nNode } from "../../../src/server/connectors/formats/n8n/read.js";
import {
  EXTERNAL_RUNTIME_PROTOCOL,
  createExternalRuntimeAdapter,
  externalRuntimeBindingSchema,
} from "../../../src/server/connectors/formats/automation/external-runtime.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type { AdapterCallContext } from "../../../src/server/connectors/adapter.js";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";
import {
  RUNTIME_PATH,
  connectionWithSecret,
  delegatedBinding,
  startExternalRuntime,
} from "../fixtures/automation/external-runtime.js";
import {
  declarativeCredentialDescription,
  declarativeIdentity,
  declarativeNodeDescription,
  declarativePackageJson,
  programmaticIdentity,
  programmaticNodeSource,
} from "../fixtures/n8n/node.js";

/*
 * One functioning authorized binding for n8n: the imported `meter.getAll`
 * operation runs in a registered runtime, pinned to the node version the
 * description was read from. A read is replayable, which is exactly why it
 * may be retried where a write may not.
 */

const OPERATION_REF = "operation:n8n:meter.getAll";

async function harness(options: { effect?: "read" | "write" } = {}) {
  const imported = await readN8nNode({
    json: declarativeNodeDescription,
    credentialsJson: declarativeCredentialDescription,
    packageJson: declarativePackageJson,
    identity: declarativeIdentity,
  });
  const capability = imported.definition.capabilities.find(
    (item) => item.nativeId === "meter.getAll",
  );
  assert.ok(capability);
  const runtime = await startExternalRuntime({
    behaviour: () => ({
      kind: "reply",
      body: {
        protocol: EXTERNAL_RUNTIME_PROTOCOL,
        status: "completed",
        output: { meters: [{ id: "m_1", label: "Kitchen" }] },
      },
    }),
  });
  const ports = memoryPorts();
  const effect = options.effect ?? "read";
  const binding = delegatedBinding({
    origin: runtime.origin,
    operationRef: OPERATION_REF,
    nativeId: "meter.getAll",
    effect,
    outputClassification: "personal",
  });
  const connection = await connectionWithSecret(ports, {
    binding,
    ecosystem: "n8n",
    service: "meterly",
  });
  const external = externalRuntimeBindingSchema.parse({
    operationRef: OPERATION_REF,
    identity: {
      ecosystem: "n8n",
      nativeId: "meter.getAll",
      // The node version the description was read from, not the package's.
      nativeVersion: imported.definition.identity.nativeVersion,
    },
    destinationId: "runtime",
    path: RUNTIME_PATH,
    owner: { kind: "user", id: fixtureActor.subjectId },
    input: {
      type: "object",
      properties: { limit: { type: "integer", minimum: 1, maximum: 250 } },
      additionalProperties: false,
    },
    output: {
      type: "object",
      properties: {
        meters: {
          type: "array",
          maxItems: 250,
          items: {
            type: "object",
            properties: {
              id: { type: "string", maxLength: 128 },
              label: { type: "string", maxLength: 256 },
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
      },
      required: ["meters"],
      additionalProperties: false,
    },
    effect,
    outputClassification: "personal",
    replay: effect === "read" ? "read-only" : "none",
    environmentClass: "loopback-fixture",
    timeoutMs: 5_000,
  });
  const adapter = createExternalRuntimeAdapter({
    bindings: [external],
    ecosystem: "n8n",
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
    async close() {
      controller.abort();
      await runtime.close();
    },
  };
}

describe("binding an imported n8n operation to an approved runtime", () => {
  test("executes it and records a read against the pinned node version", async () => {
    const h = await harness();
    try {
      const result = await h.adapter.invoke!(h.ctx, {
        operationRef: OPERATION_REF,
        input: { limit: 25 },
        commandId: "command-1",
      });
      assert.equal(result.state, "complete");
      assert.equal(result.effect, "read");
      assert.deepEqual(result.output, {
        meters: [{ id: "m_1", label: "Kitchen" }],
      });
      const call = h.runtime.calls[0]!;
      assert.equal(call.signatureValid, true);
      assert.deepEqual((call.body as Record<string, unknown>)["operation"], {
        ecosystem: "n8n",
        nativeId: "meter.getAll",
        nativeVersion: "2",
      });
      assert.equal(h.ports.inspect.effects()[0]?.outcome?.status, "applied");
    } finally {
      await h.close();
    }
  });

  test("a read may be performed again; the journal does not stand in its way", async () => {
    const h = await harness();
    try {
      for (const commandId of ["command-1", "command-2"])
        assert.equal(
          (
            await h.adapter.invoke!(h.ctx, {
              operationRef: OPERATION_REF,
              input: { limit: 25 },
              commandId,
            })
          ).state,
          "complete",
        );
      assert.equal(h.runtime.calls.length, 2);
    } finally {
      await h.close();
    }
  });

  test("the same operation declared as a write is not replayed", async () => {
    const h = await harness({ effect: "write" });
    try {
      const first = await h.adapter.invoke!(h.ctx, {
        operationRef: OPERATION_REF,
        input: { limit: 25 },
        commandId: "command-1",
      });
      assert.equal(first.state, "complete");
      const second = await h.adapter.invoke!(h.ctx, {
        operationRef: OPERATION_REF,
        input: { limit: 25 },
        commandId: "command-2",
      });
      assert.equal(second.code, "effect.replayed");
      assert.equal(h.runtime.calls.length, 1);
    } finally {
      await h.close();
    }
  });

  test("input outside the approved shape never leaves the process", async () => {
    const h = await harness();
    try {
      await assert.rejects(
        h.adapter.invoke!(h.ctx, {
          operationRef: OPERATION_REF,
          input: { limit: 10_000 },
          commandId: "command-1",
        }),
        (error: unknown) =>
          error instanceof ConnectorError && error.code === "invalid-request",
      );
      assert.equal(h.runtime.calls.length, 0);
    } finally {
      await h.close();
    }
  });

  test("a programmatic node has no invocable candidate to bind", async () => {
    const programmatic = await readN8nNode({
      sourceText: programmaticNodeSource("/tmp/n8n-binding-sentinel-never"),
      identity: programmaticIdentity,
    });
    assert.deepEqual(programmatic.executableCandidates, []);
    assert.equal(
      programmatic.definition.compatibility.dimensions.invoke,
      "unsupported",
    );
  });
});

import { strict as assert } from "node:assert";
import { readZapierApp } from "../../../src/server/connectors/formats/zapier/read.js";
import {
  createExternalRuntimeAdapter,
  externalRuntimeBindingSchema,
  type ExternalRuntimeBinding,
  type RuntimeFieldSchema,
} from "../../../src/server/connectors/formats/automation/external-runtime.js";
import type { AdapterCallContext } from "../../../src/server/connectors/adapter.js";
import type { NativeCapability } from "../../../src/core/connectors/index.js";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";
import {
  RUNTIME_PATH,
  connectionWithSecret,
  delegatedBinding,
  startExternalRuntime,
} from "../fixtures/automation/external-runtime.js";
import {
  nativeAppDefinition,
  nativeAppIdentity,
} from "../fixtures/zapier/app.js";

/** Turns an imported Zapier input-field list into the binding's input schema. */
export function schemaFromZapierFields(
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

export const OUTPUT_SCHEMA: RuntimeFieldSchema = {
  type: "object",
  properties: {
    id: { type: "string", maxLength: 128 },
    status: { type: "string", enum: ["draft", "sent", "paid"] },
    total_cents: { type: "integer", minimum: 0 },
  },
  required: ["id", "status"],
  additionalProperties: false,
};

export const OPERATION_REF = "operation:zapier:create_invoice";

export async function importedCreate() {
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

export function runtimeBindingFor(
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

export type Harness = Awaited<ReturnType<typeof harness>>;

export async function harness(
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

export const withHarness = async (
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

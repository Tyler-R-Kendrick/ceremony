import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  CapabilityStatus,
  NormalizedDefinition,
  RuntimeClass,
  SupportDimension,
} from "../../../../core/connectors/index.js";
import type { EvidenceLevel } from "../../../../core/connectors/identity.js";
import {
  capabilityStatus,
  type AdapterCallContext,
  type ConnectorAdapter,
  type ExportOutcome,
  type ExportRequest,
  type ImportInput,
  type ImportOutcome,
  type InvokeRequest,
  type InvokeResult,
} from "../../adapter.js";
import { boundOperation, type RuntimeBinding } from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import { sha256Hex } from "../../import/parse.js";
import {
  importKamelet,
  kameletSourceRecord,
  KAMELET_IMPORT_LIMITS,
} from "./import.js";
import {
  KAMELET_ADAPTER_VERSION,
  KAMELET_CATALOG_SOURCE,
  KAMELET_CATALOG_VERSION,
  KAMELET_ECOSYSTEM,
  KAMELET_PROFILE,
  kameletTypeSchema,
  type KameletType,
} from "./schemas.js";
import {
  KAMELET_BROWSER_DEPLOYMENT_REASON,
  KAMELET_NO_RUNNER_CONFIGURED,
  KAMELET_RUN_DESCRIPTOR_VERSION,
  kameletRunDescriptorSchema,
  unavailableKameletRunner,
  type HostRunnerAvailability,
  type KameletHostRunnerPort,
  type KameletRunDescriptor,
} from "./runner.js";

/*
 * The Camel Kamelet adapter.
 *
 * It imports catalog documents, describes them honestly, and exports a run
 * descriptor a configured Camel runner could execute. Everything else — the
 * JVM, the dependency resolution, the deployment — belongs to that runner and
 * to no part of this process. Support is `provider-backed` because the import
 * and export paths are real code against a pinned catalog release; the
 * dimensions this adapter cannot perform say `unsupported` one by one rather
 * than hiding behind a label.
 */

export const CAMEL_KAMELET_ADAPTER_ID = "camel-kamelet";
export const KAMELET_RUN_OPERATION = "camel-kamelet.run";
export const KAMELET_RUN_DESCRIPTOR_FORMAT = "camel-kamelet/run-descriptor";
const KAMELET_EXPORT_FORMATS = new Set([
  KAMELET_RUN_DESCRIPTOR_FORMAT,
  "camel-kamelet/run-descriptor+json",
]);

/**
 * `binding.settings.kamelet`: which Kamelet this binding runs, the non-secret
 * parameter values the host approved and the host configuration names that
 * hold the secret ones. Host-approved and immutable per binding revision; a
 * caller never supplies any of it.
 */
export const kameletBindingSettingsSchema = z.strictObject({
  kameletName: z.string().min(1).max(253),
  kameletType: kameletTypeSchema,
  catalogVersion: z.string().min(1).max(128),
  scheme: z
    .string()
    .max(64)
    .regex(/^[a-zA-Z][a-zA-Z0-9+.-]*$/)
    .optional(),
  dependencies: z.array(z.string().max(256)).max(256).default([]),
  parameters: z
    .record(
      z.string().max(120),
      z.union([z.string().max(8192), z.number().finite(), z.boolean()]),
    )
    .default({}),
  secretParameters: z
    .record(z.string().max(120), z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/))
    .default({}),
});
export type KameletBindingSettings = z.infer<
  typeof kameletBindingSettingsSchema
>;

export type CamelKameletAdapterOptions = {
  /**
   * Explicitly configured Camel runner. Absent means execution is unavailable
   * and the catalog entry says so with the exact reason.
   */
  runner?: KameletHostRunnerPort;
  runnerUnavailableReason?: string;
  /**
   * The runtime class this deployment actually is. A browser deployment may
   * never be handed a runner: a local-runner capability it could not honour
   * would be a claim, not a capability.
   */
  deploymentRuntime?: RuntimeClass;
  runOperationRef?: string;
  evidence?: EvidenceLevel;
};

/** The descriptor a configured runner is asked to run; secrets travel by configuration name only. */
export function kameletRunDescriptor(
  settings: KameletBindingSettings,
): KameletRunDescriptor {
  return kameletRunDescriptorSchema.parse({
    descriptorVersion: KAMELET_RUN_DESCRIPTOR_VERSION,
    catalogVersion: settings.catalogVersion,
    kamelet: {
      name: settings.kameletName,
      type: settings.kameletType,
      ...(settings.scheme ? { scheme: settings.scheme } : {}),
      dependencies: settings.dependencies,
    },
    parameters: settings.parameters,
    secretParameters: settings.secretParameters,
    requiredRuntime: "trusted-local-runner",
  });
}

/** The binding's approved Kamelet settings; absence is a policy failure, not a lookup miss. */
export function kameletSettingsFromBinding(
  binding: RuntimeBinding,
): KameletBindingSettings {
  const raw = binding.settings["kamelet"];
  if (raw === undefined)
    throw new ConnectorError("configuration-required", {
      detail: "kamelet.settings.missing",
    });
  const parsed = kameletBindingSettingsSchema.safeParse(raw);
  if (!parsed.success)
    throw new ConnectorError("invalid-request", {
      detail: "kamelet.settings.invalid",
    });
  return parsed.data;
}

/** A descriptor derived from an imported definition, for review before a binding exists. */
export function kameletRunDescriptorFromDefinition(
  definition: NormalizedDefinition,
  approved: {
    parameters?: Record<string, string | number | boolean>;
    secretParameters?: Record<string, string>;
  } = {},
): KameletRunDescriptor {
  const extensions = definition.nativeExtensions as Record<string, unknown>;
  const kameletType = kameletTypeSchema.safeParse(extensions["kameletType"]);
  if (!kameletType.success)
    throw new ConnectorError("invalid-request", {
      detail: "kamelet.definition.not-a-kamelet",
    });
  const capability = definition.capabilities[0];
  if (!capability)
    throw new ConnectorError("invalid-request", {
      detail: "kamelet.definition.not-a-kamelet",
    });
  const scheme = extensions["scheme"];
  const dependencies = Array.isArray(extensions["dependencies"])
    ? (extensions["dependencies"] as unknown[]).filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  return kameletRunDescriptorSchema.parse({
    descriptorVersion: KAMELET_RUN_DESCRIPTOR_VERSION,
    catalogVersion: definition.identity.nativeVersion,
    kamelet: {
      name: capability.nativeId,
      type: kameletType.data,
      ...(typeof scheme === "string" ? { scheme } : {}),
      dependencies,
    },
    parameters: approved.parameters ?? {},
    secretParameters: approved.secretParameters ?? {},
    requiredRuntime: "trusted-local-runner",
  });
}

const unsupportedDimensions: SupportDimension[] = [
  "discover",
  "configure",
  "authorize",
  "verify",
  "events",
  "reconnect",
  "disconnect",
  "revoke",
];

export function createCamelKameletAdapter(
  options: CamelKameletAdapterOptions = {},
): ConnectorAdapter & {
  runner: KameletHostRunnerPort;
  runnerAvailability(): Promise<HostRunnerAvailability>;
} {
  const deploymentRuntime: RuntimeClass = options.deploymentRuntime ?? "hosted-server";
  /*
   * A browser deployment cannot host or reach a trusted local runner. Refusing
   * the runner here — rather than quietly ignoring it — means no code path
   * exists in which a browser-only deployment reports local execution.
   */
  if (options.runner && deploymentRuntime === "browser")
    throw new ConnectorError("unsupported", {
      detail: "kamelet.runner.browser-deployment",
    });
  const runnerReason =
    deploymentRuntime === "browser"
      ? KAMELET_BROWSER_DEPLOYMENT_REASON
      : (options.runnerUnavailableReason ?? KAMELET_NO_RUNNER_CONFIGURED);
  const runner = options.runner ?? unavailableKameletRunner(runnerReason);
  const runnerConfigured = options.runner !== undefined;
  const operationRef = options.runOperationRef ?? KAMELET_RUN_OPERATION;
  const evidence = options.evidence ?? "protocol-fixture";
  const identity = {
    adapterVersion: KAMELET_ADAPTER_VERSION,
    runtime: "hosted-server" as const,
  };

  const adapter: ConnectorAdapter & {
    runner: KameletHostRunnerPort;
    runnerAvailability(): Promise<HostRunnerAvailability>;
  } = {
    id: CAMEL_KAMELET_ADAPTER_ID,
    ecosystem: KAMELET_ECOSYSTEM,
    adapterVersion: KAMELET_ADAPTER_VERSION,
    runtime: "hosted-server",
    displayName: "Apache Camel Kamelets",
    description: `Imports Kamelet catalog documents (pinned to catalog ${KAMELET_CATALOG_VERSION}) as inert descriptions and exports a run descriptor. Execution requires a separately configured Camel runner; no JVM is embedded and no integration is deployed.`,
    service: "camel-kamelet",
    support: "provider-backed",
    custody: ["no-credential", "external-execution-broker"],
    configuration: [],
    profiles: [KAMELET_PROFILE],
    runner,
    async runnerAvailability() {
      return runner.available();
    },
    capabilities(): CapabilityStatus[] {
      const rows: CapabilityStatus[] = [
        capabilityStatus(identity, {
          dimension: "import",
          profile: KAMELET_PROFILE,
          evidence,
          limitations: [
            `Pinned to Camel Kamelet catalog ${KAMELET_CATALOG_VERSION} (${KAMELET_CATALOG_SOURCE.tag}); a newer catalog is a new pin, not an automatic upgrade.`,
            "The route template, data types and dependencies are preserved as inert data and never evaluated or resolved.",
          ],
        }),
        capabilityStatus(identity, {
          dimension: "export",
          profile: KAMELET_PROFILE,
          evidence,
          limitations: [
            "Export produces a run descriptor for a configured Camel runner; credential values are never exported, only host configuration names.",
          ],
        }),
        {
          dimension: "invoke",
          profile: KAMELET_PROFILE,
          adapterVersion: KAMELET_ADAPTER_VERSION,
          /*
           * Execution, when it exists at all, happens in the runner, so this
           * row reports the runner's runtime class rather than this process's.
           */
          runtime: "trusted-local-runner",
          implementation: runnerConfigured ? "implemented" : "unsupported",
          configuration: runnerConfigured ? "ready" : "missing",
          evidence: runnerConfigured ? evidence : "not-tested",
          limitations: runnerConfigured
            ? [
                "Execution is delegated to the explicitly configured Camel runner under a host-authenticated, signed request; Ceremony runs nothing itself.",
              ]
            : [runnerReason],
        },
        capabilityStatus(identity, {
          dimension: "delegate",
          profile: KAMELET_PROFILE,
          implementation: runnerConfigured ? "implemented" : "unsupported",
          configuration: runnerConfigured ? "ready" : "missing",
          ...(runnerConfigured ? { evidence } : {}),
          limitations: runnerConfigured
            ? ["Delegation carries a run descriptor only; no route source is sent."]
            : [runnerReason],
        }),
      ];
      for (const dimension of unsupportedDimensions)
        rows.push(
          capabilityStatus(identity, {
            dimension,
            profile: KAMELET_PROFILE,
            implementation: "unsupported",
            limitations: [
              dimension === "events"
                ? "A source Kamelet delivers through a Camel component, not an HTTP webhook; no event is received here."
                : "A Kamelet is a route template: it has no service to discover, authorize against, verify or disconnect from.",
            ],
          }),
        );
      return rows;
    },
    async import(
      ctx: AdapterCallContext,
      input: ImportInput,
    ): Promise<ImportOutcome> {
      if (input.bytes.byteLength > KAMELET_IMPORT_LIMITS.bytes)
        throw new ConnectorError("invalid-request", {
          detail: "kamelet.document.oversized",
        });
      const capturedAt = new Date(ctx.environment.now()).toISOString();
      const mediaType =
        input.mediaType.split(";")[0]?.trim() || "application/yaml";
      const sourceRef = `src:camel-kamelet:${sha256Hex(input.bytes)}`;
      const imported = await importKamelet(input.bytes, {
        sourceRef,
        origin: input.origin,
        mediaType,
        capturedAt,
      });
      const source = kameletSourceRecord({
        sourceRef,
        identity: imported.identity,
        origin: input.origin,
        bytes: input.bytes,
        mediaType,
        capturedAt,
        catalogVersion: imported.provenance.catalogVersion,
      });
      return {
        source,
        definitions: [imported.definition],
        issues: imported.issues,
        executableCandidates: imported.executableCandidates,
      };
    },
    async export(
      _ctx: AdapterCallContext,
      request: ExportRequest,
    ): Promise<ExportOutcome> {
      if (!KAMELET_EXPORT_FORMATS.has(request.format))
        throw new ConnectorError("unsupported", { detail: "export.format" });
      const descriptor = kameletRunDescriptorFromDefinition(request.definition);
      const secretNames = (
        request.definition.nativeExtensions as Record<string, unknown>
      )["secretProperties"];
      const losses: ExportOutcome["losses"] = [
        {
          code: "kamelet.export.template-omitted",
          category: "structure",
          sourcePointer: "/spec/template",
          dimension: "export",
          disposition: "unsupported",
          severity: "warning",
          executionImpact: "blocks-operation",
          message:
            "A run descriptor names the Kamelet and its catalog release; it does not carry the route template, which the runner resolves from the catalog itself.",
        },
      ];
      if (Array.isArray(secretNames) && secretNames.length > 0)
        losses.push({
          code: "kamelet.export.credentials-omitted",
          category: "security",
          sourcePointer: "/spec/definition/properties",
          dimension: "export",
          disposition: "requires-configuration",
          severity: "warning",
          executionImpact: "blocks-authorization",
          message:
            "Credential parameters are exported as host configuration names to bind, never as values.",
        });
      return {
        mediaType: "application/json",
        bytes: new TextEncoder().encode(
          JSON.stringify(descriptor, undefined, 2),
        ),
        losses,
      };
    },
    async invoke(
      ctx: AdapterCallContext,
      request: InvokeRequest,
    ): Promise<InvokeResult> {
      if (request.operationRef !== operationRef)
        throw new ConnectorError("not-found", {
          detail: "kamelet.operation.unknown",
        });
      const operation = boundOperation(ctx.binding, operationRef);
      if (!operation)
        throw new ConnectorError("denied", {
          detail: "kamelet.operation.unapproved",
        });
      const availability = await runner.available();
      if (!availability.available)
        /*
         * Unavailability is a reported native limitation with the exact
         * reason, never an invented success or a silent local attempt.
         */
        throw new ConnectorError("unsupported", {
          detail: "kamelet.runner.unavailable",
        });
      const settings = kameletSettingsFromBinding(ctx.binding);
      if (settings.kameletName !== operation.nativeId)
        throw new ConnectorError("denied", {
          detail: "kamelet.operation.kamelet-mismatch",
        });
      const descriptor = kameletRunDescriptor(settings);
      const { effectRef, prior } = await ctx.environment.effects.begin({
        actor: ctx.actor,
        ...(ctx.connection
          ? { connectionRef: ctx.connection.connectionRef }
          : {}),
        bindingRef: ctx.binding.bindingRef,
        operation: `camel-kamelet.run:${settings.kameletName}`,
        digest: digestOfText(
          JSON.stringify({ descriptor, input: request.input }),
        ),
        commandId: request.commandId,
      });
      if (prior && prior.status !== "not-applied")
        return {
          state: prior.status === "applied" ? "complete" : "indeterminate",
          outputClassification: operation.outputClassification,
          effect: operation.effect,
          ...(prior.code ? { code: prior.code } : {}),
          effectRef,
        };
      try {
        const result = await runner.run(descriptor, ctx, {
          operationRef,
          input: request.input,
          commandId: request.commandId,
        });
        await ctx.environment.effects.complete(effectRef, {
          status: result.state === "complete" ? "applied" : "indeterminate",
          ...(result.code ? { code: result.code } : {}),
          at: ctx.environment.now(),
        });
        return { ...result, effectRef };
      } catch (error) {
        await ctx.environment.effects.complete(effectRef, {
          status: "indeterminate",
          code: "kamelet.runner.failed",
          at: ctx.environment.now(),
        });
        throw error;
      }
    },
  };
  return adapter;
}

function digestOfText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export type { KameletType };

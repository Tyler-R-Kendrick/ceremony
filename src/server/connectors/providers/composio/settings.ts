import { z } from "zod";
import {
  connectorReferenceSchema,
  sha256HexSchema,
} from "../../../../core/connectors/index.js";
import type { BoundOperation, RuntimeBinding } from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import {
  composioAuthConfigIdSchema,
  composioToolSlugSchema,
  composioToolkitSlugSchema,
  composioVersionSchema,
} from "./identity.js";
import { COMPOSIO_API_BASES, composioMetaToolSchema } from "./wire.js";

/*
 * Host-approved, inert settings a Composio binding carries.
 *
 * A binding names exactly one toolkit at one pinned version and the auth
 * configs whose connected accounts it may use. `tools` is the allowlist: a
 * tool slug that is not in it cannot be executed even if a bound operation's
 * transport names it, which means a drifting operation table and a drifting
 * tool catalog have to agree before anything runs. `metaTools` is empty unless
 * the host wrote entries there, so the router's account-management and
 * code-execution meta tools are off by construction rather than by default.
 */

const reservedKeys = new Set(["__proto__", "prototype", "constructor"]);
const notReserved = (value: string) => !reservedKeys.has(value);

export const argumentNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z_][a-zA-Z0-9_.-]*$/)
  .refine(notReserved, "Reserved key");

const boundedRecord = <V extends z.ZodType>(
  key: z.ZodType<string>,
  value: V,
  max: number,
) =>
  z
    .record(key, value)
    .refine(
      (record) => Object.keys(record).length <= max,
      `At most ${max} entries`,
    );

export const composioOperationSettingsSchema = z.strictObject({
  /** Pinned tool version; absent means the binding's toolkit version is sent. */
  version: composioVersionSchema.optional(),
  /** Argument names the caller may supply; absent means none. */
  arguments: z.array(argumentNameSchema).max(64).optional(),
  /** Host-fixed arguments merged after the caller's; they always win. */
  fixedArguments: boundedRecord(argumentNameSchema, z.unknown(), 32).optional(),
  /**
   * Canonical digest of the tool's `input_parameters` at review time. When it
   * is present the adapter refuses to execute a tool whose current schema
   * digest differs: a remote tool may change behind a stable slug, and a
   * changed contract needs a new review, not a best-effort call.
   */
  schemaDigest: sha256HexSchema.optional(),
  timeoutMs: z.number().int().min(1000).max(300_000).optional(),
});
export type ComposioOperationSettings = z.infer<
  typeof composioOperationSettingsSchema
>;

export const composioBindingSettingsSchema = z.strictObject({
  /** The one toolkit this binding covers, at the reviewed version. */
  toolkit: z.strictObject({
    slug: composioToolkitSlugSchema,
    version: composioVersionSchema,
  }),
  /** Auth configs whose connected accounts this binding may use. */
  authConfigs: z.array(composioAuthConfigIdSchema).min(1).max(16),
  /** Documented API base path; defaults to the frozen `/api/v3`. */
  apiBase: z.enum(COMPOSIO_API_BASES as unknown as [string, ...string[]]).optional(),
  /** Which documented execution profile this binding uses. */
  execution: z.enum(["direct", "session"]).optional(),
  /** Tool slugs this binding approves. Nothing outside it executes. */
  tools: z.array(composioToolSlugSchema).max(512),
  /**
   * Meta tools the host separately authorized. Empty (the default) disables
   * every router meta tool, including account management and the workbench.
   */
  metaTools: z.array(composioMetaToolSchema).max(6).optional(),
  /** Session profile knobs; each maps to a documented `manage_connections` or `multi_account` field. */
  session: z
    .strictObject({
      enableWaitForConnections: z.boolean().optional(),
      enableConnectionRemoval: z.boolean().optional(),
      maxAccountsPerToolkit: z.number().int().min(1).max(32).optional(),
      ttlMs: z.number().int().min(60_000).max(24 * 60 * 60 * 1000).optional(),
    })
    .optional(),
  /**
   * How an account is chosen when the connection does not name one.
   * `explicit` (the default) never chooses; `single-active` may adopt the one
   * active account when there is exactly one and it is a permitted target.
   */
  accountSelection: z.enum(["explicit", "single-active"]).optional(),
  presentation: z
    .enum(["same-window", "popup", "second-device", "in-app"])
    .optional(),
  operations: boundedRecord(
    connectorReferenceSchema,
    composioOperationSettingsSchema,
    4096,
  ).optional(),
});
export type ComposioBindingSettings = z.infer<
  typeof composioBindingSettingsSchema
>;

export function readComposioSettings(
  binding: RuntimeBinding,
): ComposioBindingSettings {
  const parsed = composioBindingSettingsSchema.safeParse(binding.settings);
  if (!parsed.success)
    throw new ConnectorError("configuration-required", {
      detail: "composio.binding.invalid",
    });
  return parsed.data;
}

export function operationSettings(
  settings: ComposioBindingSettings,
  operationRef: string,
): ComposioOperationSettings {
  return settings.operations?.[operationRef] ?? {};
}

export type ComposioRoute =
  | { kind: "tool"; toolSlug: string }
  | { kind: "session-tool"; toolSlug: string }
  | { kind: "meta"; metaTool: string };

const unsupported = (detail: string) =>
  new ConnectorError("unsupported", { detail });

/**
 * The adapter-owned routing inside a bound operation. Direct executions use
 * the broker-action transport with the tool slug as the action; session
 * executions use `session:<TOOL_SLUG>`; meta tools use `meta:<META_TOOL>`.
 * Each is its own bound operation, so effect, consent and replay policy are
 * decided per tool rather than per adapter. A caller supplies none of this.
 */
export function composioRoute(operation: BoundOperation): ComposioRoute {
  const transport = operation.transport;
  if (transport.kind === "broker-action") {
    const slug = composioToolSlugSchema.safeParse(transport.action);
    if (!slug.success) throw unsupported("composio.route.tool-slug");
    return { kind: "tool", toolSlug: slug.data };
  }
  if (transport.kind !== "delegated")
    throw unsupported("composio.transport.unsupported");
  const route = transport.route;
  if (route.startsWith("session:")) {
    const slug = composioToolSlugSchema.safeParse(route.slice("session:".length));
    if (!slug.success) throw unsupported("composio.route.tool-slug");
    return { kind: "session-tool", toolSlug: slug.data };
  }
  if (route.startsWith("meta:")) {
    const meta = composioMetaToolSchema.safeParse(route.slice("meta:".length));
    if (!meta.success) throw unsupported("composio.route.meta-tool");
    return { kind: "meta", metaTool: meta.data };
  }
  throw unsupported("composio.route.invalid");
}

/**
 * The approved connected accounts for this binding, from its permitted
 * targets. An empty list means the binding approved no specific account, and
 * then only the connection's own recorded account may be used.
 */
export function permittedAccounts(binding: RuntimeBinding): string[] {
  return binding.permittedTargets
    .filter((target) => target.kind === "connected-account")
    .map((target) => target.id);
}

/** The toolkits a binding permits naming as a target, beyond its own. */
export function permittedToolkits(binding: RuntimeBinding): string[] {
  return binding.permittedTargets
    .filter((target) => target.kind === "toolkit")
    .map((target) => target.id);
}

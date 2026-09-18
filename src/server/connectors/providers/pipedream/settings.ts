import { z } from "zod";
import { identifierSchema } from "../../../../core/operation-contracts.js";
import {
  connectorReferenceSchema,
  nativeVersionSchema,
} from "../../../../core/connectors/index.js";
import type { BoundOperation, RuntimeBinding } from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import {
  pipedreamAppSlugSchema,
  pipedreamComponentKeySchema,
} from "./identity.js";

/*
 * Host-approved, inert settings a Pipedream binding carries. The binding names
 * exactly one Pipedream app: a connection under it is an account for that app
 * and nothing else. Per-operation settings say which caller inputs an
 * operation accepts (query names, body fields, component props) and pin the
 * component version; nothing here is a secret and nothing here can widen an
 * operation beyond the transport the bound operation already fixes.
 */

const reservedKeys = new Set(["__proto__", "prototype", "constructor"]);
const notReserved = (value: string) => !reservedKeys.has(value);

export const propNameSchema = z
  .string()
  .regex(/^[a-zA-Z_$][a-zA-Z0-9_$]{0,63}$/)
  .refine(notReserved, "Reserved key");
export const parameterNameSchema = z
  .string()
  .regex(/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/)
  .refine(notReserved, "Reserved key");
const headerNameSchema = z.string().regex(/^[a-zA-Z0-9!#$%&'*+.^_`|~-]{1,64}$/);
const headerValueSchema = z
  .string()
  .max(1024)
  .regex(/^[^\p{Cc}]*$/u);

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

const loopbackHosts = ["127.0.0.1", "localhost", "[::1]"];
const exactOriginSchema = z.string().refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.origin === value &&
    (url.protocol === "https:" ||
      (url.protocol === "http:" && loopbackHosts.includes(url.hostname)))
  );
}, "Must be an exact HTTPS (or loopback HTTP) origin");

export const pipedreamOperationSettingsSchema = z.strictObject({
  /** Proxy: names of `{placeholders}` in the route path the caller fills. */
  path: z.array(parameterNameSchema).max(16).optional(),
  /** Proxy: query parameter names the caller may supply. */
  query: z.array(parameterNameSchema).max(32).optional(),
  /** Proxy: whether a JSON body is accepted; defaults by method. */
  body: z.enum(["none", "json"]).optional(),
  /** Proxy: allowlist of top-level body keys; absent means any bounded JSON. */
  bodyFields: z.array(propNameSchema).max(64).optional(),
  /** Target kind each target-selecting parameter is checked against. */
  targets: boundedRecord(
    parameterNameSchema,
    z
      .string()
      .max(64)
      .regex(/^[a-z][a-z0-9-]*$/),
    8,
  ).optional(),
  /** Proxy: fixed upstream headers, forwarded through Pipedream's x-pd-proxy- prefix. */
  headers: boundedRecord(headerNameSchema, headerValueSchema, 16).optional(),
  timeoutMs: z.number().int().min(1000).max(300_000).optional(),
  /** Actions and triggers: pinned component version; absent means Pipedream's latest. */
  version: nativeVersionSchema.optional(),
  /** Actions and triggers: the app prop that receives the account; defaults to the app slug. */
  appProp: propNameSchema.optional(),
  /** Actions and triggers: configured props the caller may supply. */
  props: z.array(propNameSchema).max(64).optional(),
  /** Actions and triggers: host-fixed props (polling timers, constants). */
  fixedProps: boundedRecord(propNameSchema, z.unknown(), 64).optional(),
  /** Triggers: emit historical test events on deploy; defaults to false. */
  emitOnDeploy: z.boolean().optional(),
  /** Triggers: the approved destination deliveries go to; required to deploy. */
  webhookDestinationId: identifierSchema.optional(),
  /** Triggers: path under the destination prefix; the delivery id is appended. */
  webhookPath: z
    .string()
    .max(512)
    .regex(/^\/(?!\/)[^\p{Cc}?#]*$/u)
    .optional(),
});
export type PipedreamOperationSettings = z.infer<
  typeof pipedreamOperationSettingsSchema
>;

export const pipedreamBindingSettingsSchema = z.strictObject({
  /** The one Pipedream app this binding connects; the configured identity, not a display name. */
  app: pipedreamAppSlugSchema,
  /** Exact origin the returned Connect Link must have; defaults to https://pipedream.com. */
  connectLinkOrigin: exactOriginSchema.optional(),
  operations: boundedRecord(
    connectorReferenceSchema,
    pipedreamOperationSettingsSchema,
    4096,
  ).optional(),
});
export type PipedreamBindingSettings = z.infer<
  typeof pipedreamBindingSettingsSchema
>;

export function readPipedreamSettings(
  binding: RuntimeBinding,
): PipedreamBindingSettings {
  const parsed = pipedreamBindingSettingsSchema.safeParse(binding.settings);
  if (!parsed.success)
    throw new ConnectorError("configuration-required", {
      detail: "pipedream.binding.invalid",
    });
  return parsed.data;
}

export function operationSettings(
  settings: PipedreamBindingSettings,
  operationRef: string,
): PipedreamOperationSettings {
  return settings.operations?.[operationRef] ?? {};
}

/** Methods the documented proxy accepts. */
export const proxyMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type ProxyMethod = (typeof proxyMethods)[number];
const placeholderPattern = /\{([a-zA-Z_][a-zA-Z0-9_]{0,63})\}/g;

export const triggerActions = ["deploy", "list", "delete"] as const;
export type TriggerAction = (typeof triggerActions)[number];

export type PipedreamRoute =
  | {
      kind: "proxy";
      method: ProxyMethod;
      /** Absolute HTTPS URL template; placeholders only in the path. */
      template: string;
      origin: string;
      placeholders: string[];
    }
  | { kind: "action"; componentKey: string }
  | { kind: "trigger"; action: TriggerAction; componentKey: string };

const unsupported = () =>
  new ConnectorError("unsupported", { detail: "pipedream.route.invalid" });

/**
 * Reads the adapter-owned routing out of a bound operation. Proxy routes are
 * `proxy:<METHOD>:<https URL>`, trigger lifecycle routes are
 * `trigger:<deploy|list|delete>:<component key>`, and actions use the
 * broker-action transport with the component key as the action. Each trigger
 * lifecycle step is its own bound operation so that deploying, listing and
 * deleting carry their own effect, consent and replay policy. Anything else
 * is not a Pipedream operation; the caller never supplies any of it.
 */
export function pipedreamRoute(operation: BoundOperation): PipedreamRoute {
  const transport = operation.transport;
  if (transport.kind === "broker-action") {
    const key = pipedreamComponentKeySchema.safeParse(transport.action);
    if (!key.success) throw unsupported();
    return { kind: "action", componentKey: key.data };
  }
  if (transport.kind !== "delegated")
    throw new ConnectorError("unsupported", {
      detail: "pipedream.transport.unsupported",
    });
  if (transport.route.startsWith("trigger:")) {
    const rest = transport.route.slice("trigger:".length);
    const separator = rest.indexOf(":");
    if (separator <= 0) throw unsupported();
    const action = rest.slice(0, separator);
    const key = pipedreamComponentKeySchema.safeParse(rest.slice(separator + 1));
    if (!key.success || !(triggerActions as readonly string[]).includes(action))
      throw unsupported();
    return {
      kind: "trigger",
      action: action as TriggerAction,
      componentKey: key.data,
    };
  }
  if (!transport.route.startsWith("proxy:")) throw unsupported();
  const rest = transport.route.slice("proxy:".length);
  const separator = rest.indexOf(":");
  if (separator <= 0) throw unsupported();
  const method = rest.slice(0, separator);
  const template = rest.slice(separator + 1);
  if (!(proxyMethods as readonly string[]).includes(method)) throw unsupported();
  if (!/^https:\/\/[^\s{}]+(?:\/[^\s]*)?$/u.test(template)) throw unsupported();
  const probe = template.replace(placeholderPattern, "x");
  if (!URL.canParse(probe)) throw unsupported();
  const url = new URL(probe);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search.includes("%7B") ||
    template.includes("{") !== template.includes("}") ||
    url.pathname.split("/").some((segment) => segment === "..")
  )
    throw unsupported();
  const authorityEnd = template.indexOf("/", "https://".length);
  const authority =
    authorityEnd === -1 ? template : template.slice(0, authorityEnd);
  if (authority.includes("{")) throw unsupported();
  const query = template.indexOf("?");
  if (query !== -1 && template.slice(query).includes("{")) throw unsupported();
  const placeholders = [
    ...new Set(
      [...template.matchAll(placeholderPattern)].map((match) => match[1]!),
    ),
  ];
  return {
    kind: "proxy",
    method: method as ProxyMethod,
    template,
    origin: url.origin,
    placeholders,
  };
}

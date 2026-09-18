import { z } from "zod";
import {
  canonicalConnectorJson,
  encodePathSegment,
} from "../../../../core/connectors/index.js";
import type { AdapterCallContext, InvokeRequest, InvokeResult } from "../../adapter.js";
import { boundOperation, type BoundOperation } from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import type { ConnectionRecord, EffectOutcome } from "../../ports.js";
import { nangoFailure, type RawResponse } from "./api.js";
import {
  brokerReference,
  credentialScope,
  requireConnection,
  resolveNango,
  sha256,
  type BrokerReference,
  type NangoRuntime,
  type Resolved,
} from "./context.js";
import {
  actionAsyncSchema,
  operationContractSchema,
  validateJsonSubset,
  type OperationContract,
  type ParameterSpec,
} from "./schemas.js";

/*
 * NG-04: protected proxy and action invocation. A caller names an approved
 * operation and validated input; the adapter supplies the destination, the
 * path template, the Provider-Config-Key and Connection-Id headers (from the
 * connection's protected broker reference, never from input) and the
 * Environment API key. Base URL overrides, header injection, action-name
 * substitution and connections from another integration are refused before
 * a credential is touched.
 */

/** Input keys that would redirect authority; their presence is a refusal, not a validation error. */
const overrideKeys = new Set([
  "baseurloverride",
  "baseurl",
  "base_url",
  "url",
  "origin",
  "headers",
  "header",
  "authorization",
  "connectionid",
  "connection_id",
  "providerconfigkey",
  "provider_config_key",
  "integration",
  "retries",
  "retry-on",
  "retryon",
  "action_name",
  "actionname",
  "action",
  "credentials",
  "token",
]);
const normalizeKey = (key: string) => key.toLowerCase().replaceAll("-", "").trim();

export function rejectOverrideAttempt(input: unknown, path = ""): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  for (const key of Object.keys(input as Record<string, unknown>)) {
    if (overrideKeys.has(normalizeKey(key)) || overrideKeys.has(key.toLowerCase()))
      throw new ConnectorError("denied", { detail: "nango.input.override-rejected" });
    if (path === "")
      rejectOverrideAttempt((input as Record<string, unknown>)[key], key);
  }
}

const invokeInputSchema = z.strictObject({
  path: z.record(z.string().max(96), z.union([z.string(), z.number(), z.boolean()])).optional(),
  query: z
    .record(z.string().max(96), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
  body: z.unknown().optional(),
});
type InvokeInput = z.infer<typeof invokeInputSchema>;

const recordsInputSchema = z.strictObject({
  query: z
    .strictObject({
      cursor: z.string().max(4096).optional(),
      modifiedAfter: z.iso.datetime({ offset: true }).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
      filter: z.enum(["added", "updated", "deleted"]).optional(),
    })
    .default({}),
});

function validateParameters(
  declared: Record<string, ParameterSpec> | undefined,
  supplied: Record<string, string | number | boolean> | undefined,
  location: "path" | "query",
): Record<string, string> {
  const out: Record<string, string> = {};
  const specs = declared ?? {};
  for (const key of Object.keys(supplied ?? {}))
    if (!Object.hasOwn(specs, key))
      throw new ConnectorError("invalid-request", {
        detail: `nango.input.${location}.unknown`,
      });
  for (const [name, spec] of Object.entries(specs)) {
    const value = supplied?.[name];
    if (value === undefined) {
      if (spec.required)
        throw new ConnectorError("invalid-request", {
          detail: `nango.input.${location}.required`,
        });
      continue;
    }
    const kind = typeof value;
    const typeOk =
      (spec.type === "string" && kind === "string") ||
      (spec.type === "boolean" && kind === "boolean") ||
      (spec.type === "number" && kind === "number" && Number.isFinite(value)) ||
      (spec.type === "integer" && kind === "number" && Number.isInteger(value));
    if (!typeOk)
      throw new ConnectorError("invalid-request", {
        detail: `nango.input.${location}.type`,
      });
    const text = String(value);
    if (
      text.length > spec.maxLength ||
      /[\p{Cc}]/u.test(text) ||
      (spec.enum && !spec.enum.includes(text)) ||
      (location === "path" &&
        (/[/\\?#]/.test(text) || text === "." || text === ".." || text.length === 0))
    )
      throw new ConnectorError("invalid-request", {
        detail: `nango.input.${location}.value`,
      });
    out[name] = text;
  }
  return out;
}

/** Expands `{name}` placeholders with encoded, validated values; anything else in the template is literal. */
export function expandPathTemplate(
  template: string,
  values: Record<string, string>,
): string {
  const seen = new Set<string>();
  const path = template.replace(/\{([A-Za-z][A-Za-z0-9_.:-]{0,95})\}/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined)
      throw new ConnectorError("invalid-request", { detail: "nango.input.path.required" });
    seen.add(name);
    return encodePathSegment(value);
  });
  if (/[{}]/.test(path))
    throw new ConnectorError("configuration-required", { detail: "nango.operation.template" });
  for (const name of Object.keys(values))
    if (!seen.has(name))
      throw new ConnectorError("invalid-request", { detail: "nango.input.path.unknown" });
  if (!path.startsWith("/proxy/") || path.split("/").some((segment) => segment === ".."))
    throw new ConnectorError("denied", { detail: "nango.operation.path" });
  return path;
}

export function contractFor(resolved: Resolved, operation: BoundOperation): OperationContract {
  const declared = resolved.settings.operations[operation.operationRef];
  return declared ?? operationContractSchema.parse({});
}

export type OperationOutcome = {
  status: number;
  output: unknown;
  code: string;
};

function outcomeCode(status: number): string {
  if (status >= 200 && status < 300) return "nango.upstream.ok";
  if (status === 401 || status === 403) return "nango.upstream.denied";
  if (status === 404) return "nango.upstream.not-found";
  if (status === 429) return "nango.upstream.rate-limited";
  if (status >= 500) return "nango.upstream.unavailable";
  return "nango.upstream.rejected";
}

function decodeOutput(response: RawResponse, contract: OperationContract): unknown {
  if (response.json !== undefined) return response.json;
  if (response.body.byteLength === 0) return undefined;
  const text = new TextDecoder().decode(response.body);
  return text.length > contract.maxResponseBytes ? undefined : text;
}

/**
 * Executes one approved operation against the broker with an explicit broker
 * reference. Callers with a stored connection go through `credentials.use`
 * first; completion verification passes the reference Nango itself returned.
 */
export async function executeOperation(
  resolved: Resolved,
  reference: BrokerReference,
  operation: BoundOperation,
  contract: OperationContract,
  input: InvokeInput,
): Promise<OperationOutcome> {
  if (reference.providerConfigKey !== resolved.settings.integration.uniqueKey)
    throw new ConnectorError("denied", { detail: "nango.connection.integration" });
  const routingHeaders = {
    "connection-id": reference.connectionId,
    "provider-config-key": reference.providerConfigKey,
  };
  const transport = operation.transport;
  if (transport.kind === "http") {
    const path = expandPathTemplate(
      transport.pathTemplate,
      validateParameters(contract.path, input.path, "path"),
    );
    const query = new URLSearchParams(
      validateParameters(contract.query, input.query, "query"),
    );
    let body: unknown;
    if (input.body !== undefined) {
      if (!contract.body || transport.method === "GET" || transport.method === "HEAD")
        throw new ConnectorError("invalid-request", { detail: "nango.input.body.unexpected" });
      const issues = validateJsonSubset(contract.body, input.body);
      if (issues.length)
        throw new ConnectorError("invalid-request", { detail: "nango.input.body.schema" });
      body = input.body;
    } else if (contract.body?.required?.length)
      throw new ConnectorError("invalid-request", { detail: "nango.input.body.required" });
    const response = await resolved.client.proxy({
      method: transport.method,
      path,
      ...(query.size ? { query } : {}),
      headers: {
        ...(contract.headers ?? {}),
        ...routingHeaders,
        retries: String(operation.replay === "read-only" ? contract.retries : 0),
      },
      ...(body === undefined ? {} : { body }),
      deadlineMs: contract.deadlineMs,
      maxBytes: contract.maxResponseBytes,
    });
    return {
      status: response.status,
      output: decodeOutput(response, contract),
      code: outcomeCode(response.status),
    };
  }
  if (transport.kind === "broker-action") {
    if (input.path || input.query)
      throw new ConnectorError("invalid-request", { detail: "nango.input.action.parameters" });
    if (contract.body) {
      const issues = validateJsonSubset(contract.body, input.body ?? {});
      if (issues.length)
        throw new ConnectorError("invalid-request", { detail: "nango.input.body.schema" });
    } else if (input.body !== undefined)
      throw new ConnectorError("invalid-request", { detail: "nango.input.body.unexpected" });
    const response = await resolved.client.triggerAction({
      connectionId: reference.connectionId,
      providerConfigKey: reference.providerConfigKey,
      actionName: transport.action,
      input: input.body,
      deadlineMs: contract.deadlineMs,
      maxBytes: contract.maxResponseBytes,
    });
    if (response.status === 200 && actionAsyncSchema.safeParse(response.json).success)
      return { status: 202, output: undefined, code: "nango.action.async-unexpected" };
    const code =
      response.status === 200
        ? "nango.upstream.ok"
        : response.status === 400
          ? "nango.action.invalid"
          : response.status === 424
            ? "nango.action.upstream-rejected"
            : response.status === 500
              ? "nango.action.failed"
              : outcomeCode(response.status);
    return { status: response.status, output: decodeOutput(response, contract), code };
  }
  if (transport.kind === "delegated" && transport.route.startsWith("records:")) {
    if (operation.effect !== "read")
      throw new ConnectorError("configuration-required", { detail: "nango.operation.records-effect" });
    const parsed = recordsInputSchema.safeParse(input);
    if (!parsed.success)
      throw new ConnectorError("invalid-request", { detail: "nango.input.records" });
    const [model, variant] = transport.route.slice("records:".length).split("::");
    if (!model)
      throw new ConnectorError("configuration-required", { detail: "nango.operation.records-model" });
    const page = await resolved.client.records({
      connectionId: reference.connectionId,
      providerConfigKey: reference.providerConfigKey,
      model,
      ...(variant ? { variant } : {}),
      ...(parsed.data.query.cursor ? { cursor: parsed.data.query.cursor } : {}),
      ...(parsed.data.query.modifiedAfter
        ? { modifiedAfter: parsed.data.query.modifiedAfter }
        : {}),
      ...(parsed.data.query.limit !== undefined ? { limit: parsed.data.query.limit } : {}),
      ...(parsed.data.query.filter ? { filter: parsed.data.query.filter } : {}),
      maxBytes: contract.maxResponseBytes,
      deadlineMs: contract.deadlineMs,
    });
    return {
      status: 200,
      output: { records: page.records, nextCursor: page.next_cursor },
      code: "nango.upstream.ok",
    };
  }
  throw new ConnectorError("unsupported", { detail: "nango.operation.transport" });
}

/** Reads a string at a bounded JSON pointer, for account-identity verification outputs. */
export function readPointer(value: unknown, pointer: string): string | undefined {
  let current: unknown = value;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) current = current[Number(key)];
    else if (current && typeof current === "object")
      current = (current as Record<string, unknown>)[key];
    else return undefined;
  }
  return typeof current === "string" || typeof current === "number"
    ? String(current)
    : undefined;
}

function priorResult(
  operation: BoundOperation,
  prior: EffectOutcome,
): InvokeResult | undefined {
  if (operation.replay === "read-only") return undefined;
  const base = { outputClassification: operation.outputClassification, effect: operation.effect };
  if (prior.status === "applied" || prior.status === "reconciled")
    return { ...base, state: "complete", code: "nango.effect.already-applied" };
  if (prior.status === "indeterminate")
    return { ...base, state: "indeterminate", code: "nango.effect.indeterminate" };
  return undefined;
}

export async function invokeNango(
  runtime: NangoRuntime,
  ctx: AdapterCallContext,
  request: InvokeRequest,
): Promise<InvokeResult> {
  const resolved = await resolveNango(runtime, ctx);
  const connection: ConnectionRecord = requireConnection(resolved);
  const operation = boundOperation(ctx.binding, request.operationRef);
  if (!operation)
    throw new ConnectorError("denied", { detail: "nango.operation.unapproved" });
  if (operation.transport.kind === "delegated" && !operation.transport.route.startsWith("records:"))
    throw new ConnectorError("unsupported", { detail: "nango.operation.use-delegate" });
  rejectOverrideAttempt(request.input);
  const parsedInput = invokeInputSchema.safeParse(request.input ?? {});
  if (!parsedInput.success)
    throw new ConnectorError("invalid-request", { detail: "nango.input.shape" });
  const reference = brokerReference(resolved);
  if (!connection.credentialRef)
    throw new ConnectorError("invalid-request", { detail: "nango.connection.no-credential" });
  if (connection.lifecycle !== "active" && connection.lifecycle !== "degraded")
    throw new ConnectorError("denied", { detail: "nango.connection.inactive" });
  const contract = contractFor(resolved, operation);
  if (contract.rateLimit)
    runtime.rate.take(
      `${ctx.actor.tenantId}\n${connection.connectionRef}\n${operation.operationRef}`,
      contract.rateLimit.perMinute,
      ctx.environment.now(),
    );
  const digest = sha256(
    canonicalConnectorJson({
      tenant: ctx.actor.tenantId,
      connection: connection.connectionRef,
      generation: ctx.generation,
      operation: operation.operationRef,
      input: parsedInput.data,
      commandId: request.commandId,
    }),
  );
  const journal = await ctx.environment.effects.begin({
    actor: ctx.actor,
    connectionRef: connection.connectionRef,
    bindingRef: ctx.binding.bindingRef,
    operation: `nango.invoke:${operation.operationRef}`,
    digest,
    commandId: request.commandId,
    ...(request.idempotencyKey && operation.replay === "upstream-idempotency-key"
      ? { idempotency: { key: request.idempotencyKey, scope: "nango-operation" } }
      : {}),
  });
  if (journal.prior) {
    const replay = priorResult(operation, journal.prior);
    if (replay) return { ...replay, effectRef: journal.effectRef };
  }
  const base = {
    outputClassification: operation.outputClassification,
    effect: operation.effect,
    effectRef: journal.effectRef,
  };
  const finish = async (status: EffectOutcome["status"], code?: string) =>
    ctx.environment.effects.complete(journal.effectRef, {
      status,
      ...(code ? { code } : {}),
      at: ctx.environment.now(),
    });
  let outcome: OperationOutcome;
  try {
    outcome = await ctx.environment.credentials.use(
      credentialScope(ctx, connection),
      connection.credentialRef,
      async (material) => {
        if (
          material.connectionId !== reference.connectionId ||
          material.providerConfigKey !== reference.providerConfigKey
        )
          throw new ConnectorError("denied", { detail: "nango.credential.mismatch" });
        return executeOperation(resolved, reference, operation, contract, parsedInput.data);
      },
    );
  } catch (error) {
    if (error instanceof ConnectorError && error.code === "invalid-request") {
      await finish("not-applied", error.detail ?? "nango.input.invalid");
      throw error;
    }
    if (error instanceof ConnectorError && error.code === "denied") {
      await finish("not-applied", error.detail ?? "nango.denied");
      throw error;
    }
    // A local rate limit or authority cool-down refuses before anything is
    // sent, so the effect definitely did not occur and the caller sees the
    // refusal rather than an ambiguous failure.
    if (error instanceof ConnectorError && error.code === "rate-limited") {
      await finish("not-applied", error.detail ?? "nango.rate-limited");
      throw error;
    }
    const lost =
      error instanceof ConnectorError &&
      (error.code === "upstream-unavailable" || error.code === "cancelled");
    if (lost && operation.effect !== "read") {
      await finish("indeterminate", "nango.upstream.lost-response");
      return { ...base, state: "indeterminate", code: "nango.upstream.lost-response" };
    }
    const code =
      error instanceof ConnectorError ? (error.detail ?? error.code) : "nango.upstream.error";
    await finish("failed", code);
    return { ...base, state: "failed", code };
  }
  if (outcome.status >= 200 && outcome.status < 300) {
    if (contract.output && validateJsonSubset(contract.output, outcome.output).length) {
      await finish("applied", "nango.output.schema");
      return { ...base, state: "complete", code: "nango.output.schema" };
    }
    await finish("applied", outcome.code);
    return { ...base, state: "complete", output: outcome.output };
  }
  if (outcome.status === 202) {
    await finish("indeterminate", outcome.code);
    return { ...base, state: "indeterminate", code: outcome.code };
  }
  // A gateway-level failure means the request reached Nango but its fate is
  // unknown: Nango may already have forwarded it upstream. For anything that
  // is not a read and cannot prove safe replay, that is indeterminate, not a
  // failure a caller may simply retry. A 429 is different: it is an explicit
  // refusal, so the operation definitely did not run.
  if (outcome.status >= 500 && operation.effect !== "read" && operation.replay === "none") {
    await finish("indeterminate", "nango.upstream.uncertain");
    return { ...base, state: "indeterminate", code: "nango.upstream.uncertain" };
  }
  await finish("failed", outcome.code);
  if (outcome.status === 429) {
    void nangoFailure;
    return { ...base, state: "failed", code: "nango.upstream.rate-limited" };
  }
  return { ...base, state: "failed", code: outcome.code };
}

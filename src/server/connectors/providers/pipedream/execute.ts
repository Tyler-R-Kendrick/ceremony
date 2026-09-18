import { z } from "zod";
import {
  canonicalConnectorJson,
  encodePathSegment,
} from "../../../../core/connectors/index.js";
import type { InvokeRequest, InvokeResult } from "../../adapter.js";
import {
  boundOperation,
  destinationFor,
  type BoundOperation,
  type RuntimeBinding,
} from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import type { ConnectionRecord } from "../../ports.js";
import type { PipedreamResponse } from "./client.js";
import { connectionScope, guardConnection, type PipedreamCall } from "./context.js";
import {
  checkJsonBounds,
  invalidInput,
  journaled,
  validateProps,
} from "./guards.js";
import { sha256Hex } from "./identity.js";
import {
  operationSettings,
  parameterNameSchema,
  pipedreamRoute,
  propNameSchema,
  type PipedreamOperationSettings,
  type PipedreamRoute,
} from "./settings.js";
import { pipedreamTriggerInvoke } from "./triggers.js";
import {
  actionRunSchema,
  proxyBlockedHeaderPrefixes,
  proxyBlockedHeaders,
  PROXY_MAX_TIMEOUT_MS,
} from "./wire.js";

/*
 * Approved execution (PD-03). A proxy request is a bound operation whose
 * method and upstream URL are fixed by the binding; the caller fills declared
 * placeholders and query names, and sends a bounded JSON body when the
 * operation accepts one. The account is the connection's, read through
 * custody; the external user is derived; headers come from host settings or
 * from nowhere. An action run names the binding's component key and merges
 * caller props only from an allowlist, with the account injected as the app
 * prop. Writes are journaled before they leave and stay indeterminate when
 * the response is lost.
 */

const commandIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,199}$/);
const pathValueSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\p{Cc}]+$/u)
  .refine((value) => value !== "." && value !== "..", "Traversal segment");
const queryValueSchema = z.union([
  z.string().max(2048).regex(/^[^\p{Cc}]*$/u),
  z.number().finite(),
  z.boolean(),
]);
const proxyInputSchema = z.strictObject({
  path: z.record(parameterNameSchema, pathValueSchema).optional(),
  query: z.record(parameterNameSchema, queryValueSchema).optional(),
  body: z.unknown().optional(),
});
const actionInputSchema = z.strictObject({
  props: z.record(propNameSchema, z.unknown()).optional(),
});

type ProxyRoute = Extract<PipedreamRoute, { kind: "proxy" }>;

/**
 * A parameter the operation marks as selecting a target must name a target
 * kind the binding declared, and the value must be one of the connection's
 * permitted targets. A binding that marks a parameter without saying what it
 * selects is a configuration error, not a reason to skip the check.
 */
function assertPermittedTarget(
  binding: RuntimeBinding,
  settings: PipedreamOperationSettings,
  parameter: string,
  id: string,
): void {
  const kind = settings.targets?.[parameter];
  if (!kind)
    throw new ConnectorError("configuration-required", {
      detail: "pipedream.binding.target-kind",
    });
  if (
    !binding.permittedTargets.some(
      (target) => target.kind === kind && target.id === id,
    )
  )
    throw new ConnectorError("denied", {
      detail: "pipedream.target.not-permitted",
    });
}

/**
 * Builds the upstream URL from the binding's template. Placeholders must be
 * declared by the binding, every value is encoded once, a parameter the
 * operation marks as selecting a target is checked against the connection's
 * permitted targets, and the result must still be on the template's origin.
 */
function buildUpstreamUrl(
  call: PipedreamCall,
  operation: BoundOperation,
  route: ProxyRoute,
  settings: PipedreamOperationSettings,
  input: z.infer<typeof proxyInputSchema>,
): URL {
  const declared = new Set(settings.path ?? []);
  const supplied = input.path ?? {};
  for (const name of Object.keys(supplied))
    if (!route.placeholders.includes(name))
      throw invalidInput("pipedream.input.path");
  let template = route.template;
  for (const name of route.placeholders) {
    if (!declared.has(name))
      throw new ConnectorError("configuration-required", {
        detail: "pipedream.binding.placeholder",
      });
    const value = supplied[name];
    if (value === undefined) throw invalidInput("pipedream.input.path-missing");
    if (operation.targetParameters.includes(name))
      assertPermittedTarget(call.ctx.binding, settings, name, value);
    template = template.split(`{${name}}`).join(encodePathSegment(value));
  }
  const url = new URL(template);
  if (url.origin !== route.origin)
    throw new ConnectorError("denied", { detail: "pipedream.route.escaped" });
  const allowedQuery = new Set(settings.query ?? []);
  for (const [name, raw] of Object.entries(input.query ?? {})) {
    if (!allowedQuery.has(name)) throw invalidInput("pipedream.input.query");
    if (url.searchParams.has(name))
      throw invalidInput("pipedream.input.query-fixed");
    const value = String(raw);
    if (operation.targetParameters.includes(name))
      assertPermittedTarget(call.ctx.binding, settings, name, value);
    url.searchParams.append(name, value);
  }
  return url;
}

/**
 * Host-approved upstream headers, forwarded under Pipedream's documented
 * `x-pd-proxy-` prefix. Names the proxy documents as rejected, and names that
 * would carry authority, are refused here as a binding error: settings are
 * inert configuration, never a credential channel.
 */
function forwardedHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (
      proxyBlockedHeaders.has(lower) ||
      proxyBlockedHeaderPrefixes.some((prefix) => lower.startsWith(prefix))
    )
      throw new ConnectorError("configuration-required", {
        detail: "pipedream.binding.header",
      });
    out[`x-pd-proxy-${lower}`] = value;
  }
  return out;
}

function proxyOutcome(
  operation: BoundOperation,
  response: PipedreamResponse,
  readOnly: boolean,
): InvokeResult {
  const base = {
    outputClassification: operation.outputClassification,
    effect: operation.effect,
  };
  if (response.status >= 200 && response.status < 300)
    return {
      ...base,
      state: "complete",
      output: {
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        body:
          response.json !== undefined
            ? response.json
            : response.text !== undefined
              ? response.text
              : null,
      },
    };
  const output = { status: response.status };
  if (response.status === 401 || response.status === 403)
    return {
      ...base,
      state: "failed",
      code: "pipedream.proxy.unauthorized",
      output,
    };
  if (
    response.status === 502 ||
    response.status === 503 ||
    response.status === 504
  )
    // The proxy reached the provider and then lost it: a write may have landed.
    return readOnly
      ? { ...base, state: "failed", code: "pipedream.proxy.unavailable", output }
      : { ...base, state: "indeterminate", code: "pipedream.proxy.lost", output };
  return {
    ...base,
    state: "failed",
    code: `pipedream.proxy.status-${response.status}`,
    output,
  };
}

async function runProxy(
  call: PipedreamCall,
  connection: ConnectionRecord,
  operation: BoundOperation,
  route: ProxyRoute,
  request: InvokeRequest,
  commandId: string,
): Promise<InvokeResult> {
  const settings = operationSettings(call.settings, operation.operationRef);
  const parsed = proxyInputSchema.safeParse(request.input ?? {});
  if (!parsed.success) throw invalidInput("pipedream.input.invalid");
  const input = parsed.data;
  const upstream = buildUpstreamUrl(call, operation, route, settings, input);
  const acceptsBody =
    settings.body ??
    (route.method === "GET" || route.method === "DELETE" ? "none" : "json");
  if (input.body !== undefined) {
    if (acceptsBody === "none") throw invalidInput("pipedream.input.body");
    checkJsonBounds(input.body, "pipedream.input.body-bounds");
    if (settings.bodyFields) {
      if (
        !input.body ||
        typeof input.body !== "object" ||
        Array.isArray(input.body)
      )
        throw invalidInput("pipedream.input.body-field");
      const allowed = new Set(settings.bodyFields);
      for (const key of Object.keys(input.body as Record<string, unknown>))
        if (!allowed.has(key)) throw invalidInput("pipedream.input.body-field");
    }
  }
  const headers = forwardedHeaders(settings.headers);
  const url64 = Buffer.from(upstream.href, "utf8").toString("base64url");
  const timeoutMs = Math.min(
    settings.timeoutMs ?? call.options.timeouts.proxy,
    PROXY_MAX_TIMEOUT_MS,
  );
  const readOnly =
    operation.effect === "read" && operation.replay === "read-only";
  const credentialRef = connection.credentialRef!;
  const execute = () =>
    call.ctx.environment.credentials.use(
      connectionScope(call.ctx, "external-credential-broker"),
      credentialRef,
      async (material) => {
        const accountId = material.accountId;
        if (
          accountId === undefined ||
          accountId !== connection.externalIds.accountId
        )
          throw new ConnectorError("denied", {
            detail: "pipedream.credential.mismatch",
          });
        const response = await call.client.send({
          method: route.method,
          path: call.client.projectPath(`/proxy/${url64}`),
          query: {
            external_user_id: call.externalUserId,
            account_id: accountId,
          },
          headers,
          ...(input.body !== undefined ? { body: input.body } : {}),
          timeoutMs,
          consequential: !readOnly,
          bodyLimit: 2 * 1024 * 1024,
        });
        return proxyOutcome(operation, response, readOnly);
      },
    );
  if (readOnly) return execute();
  return journaled(
    call,
    {
      operation: "pipedream.proxy",
      commandId,
      connectionRef: connection.connectionRef,
      digest: sha256Hex(
        canonicalConnectorJson({
          v: 1,
          kind: "proxy",
          tenantId: call.ctx.actor.tenantId,
          connectionRef: connection.connectionRef,
          generation: call.ctx.generation,
          operationRef: operation.operationRef,
          commandId,
          method: route.method,
          url: upstream.href,
          body: input.body ?? null,
        }),
      ),
    },
    {
      outputClassification: operation.outputClassification,
      effect: operation.effect,
    },
    execute,
  );
}

/** Documented error attribution of a component run, mapped to sanitized codes. */
const attributionCodes: Record<string, string> = {
  component_code: "component-code",
  upstream_api: "upstream-api",
  network_io: "network-io",
  response_parsing: "response-parsing",
};

function actionOutcome(
  operation: BoundOperation,
  response: PipedreamResponse,
  readOnly: boolean,
): InvokeResult {
  const base = {
    outputClassification: operation.outputClassification,
    effect: operation.effect,
  };
  if (response.status === 202)
    // Documented as an accepted asynchronous run with no documented result
    // body: nothing here proves whether the provider call happened.
    return readOnly
      ? { ...base, state: "failed", code: "pipedream.action.async-unsupported" }
      : {
          ...base,
          state: "indeterminate",
          code: "pipedream.action.accepted-async",
        };
  if (response.status >= 200 && response.status < 300) {
    const parsed = actionRunSchema.safeParse(response.json);
    if (!parsed.success)
      return readOnly
        ? { ...base, state: "failed", code: "pipedream.action.malformed" }
        : {
            ...base,
            state: "indeterminate",
            code: "pipedream.action.malformed",
          };
    const data = parsed.data;
    if (data.error !== undefined && data.error !== null) {
      const attribution =
        data.error && typeof data.error === "object" && "attribution" in data.error
          ? attributionCodes[
              String((data.error as { attribution?: unknown }).attribution)
            ]
          : undefined;
      // Only a failure inside component code, before any provider request,
      // is known not to have applied. Everything else may have.
      const state =
        readOnly || attribution === "component-code" ? "failed" : "indeterminate";
      return {
        ...base,
        state,
        code: `pipedream.action.failed.${attribution ?? "unknown"}`,
      };
    }
    if (
      (data.os ?? []).some((entry) => entry.err !== undefined && entry.err !== null)
    )
      return {
        ...base,
        state: readOnly ? "failed" : "indeterminate",
        code: "pipedream.action.threw",
      };
    return {
      ...base,
      state: "complete",
      output: {
        ret: data.ret ?? null,
        exports: data.exports ?? {},
        ...(typeof data.stash_id === "string" ? { stashId: data.stash_id } : {}),
      },
    };
  }
  if (response.status === 401 || response.status === 403)
    return { ...base, state: "failed", code: "pipedream.action.unauthorized" };
  if (response.status === 404)
    return { ...base, state: "failed", code: "pipedream.action.not-found" };
  if (response.status >= 500)
    return readOnly
      ? { ...base, state: "failed", code: "pipedream.action.unavailable" }
      : { ...base, state: "indeterminate", code: "pipedream.action.lost" };
  return {
    ...base,
    state: "failed",
    code: `pipedream.action.status-${response.status}`,
  };
}

async function runAction(
  call: PipedreamCall,
  connection: ConnectionRecord,
  operation: BoundOperation,
  componentKey: string,
  request: InvokeRequest,
  commandId: string,
): Promise<InvokeResult> {
  const settings = operationSettings(call.settings, operation.operationRef);
  const parsed = actionInputSchema.safeParse(request.input ?? {});
  if (!parsed.success) throw invalidInput("pipedream.input.invalid");
  const appProp = settings.appProp ?? call.settings.app;
  const configured = validateProps(parsed.data.props, settings, appProp);
  const readOnly =
    operation.effect === "read" && operation.replay === "read-only";
  const credentialRef = connection.credentialRef!;
  const execute = () =>
    call.ctx.environment.credentials.use(
      connectionScope(call.ctx, "external-credential-broker"),
      credentialRef,
      async (material) => {
        if (material.accountId !== connection.externalIds.accountId)
          throw new ConnectorError("denied", {
            detail: "pipedream.credential.mismatch",
          });
        const response = await call.client.send({
          method: "POST",
          path: call.client.projectPath("/actions/run"),
          body: {
            id: componentKey,
            external_user_id: call.externalUserId,
            configured_props: {
              ...configured,
              [appProp]: { authProvisionId: material.accountId },
            },
            ...(settings.version ? { version: settings.version } : {}),
          },
          timeoutMs: settings.timeoutMs ?? call.options.timeouts.action,
          consequential: !readOnly,
        });
        return actionOutcome(operation, response, readOnly);
      },
    );
  if (readOnly) return execute();
  return journaled(
    call,
    {
      operation: "pipedream.action.run",
      commandId,
      connectionRef: connection.connectionRef,
      digest: sha256Hex(
        canonicalConnectorJson({
          v: 1,
          kind: "action",
          tenantId: call.ctx.actor.tenantId,
          connectionRef: connection.connectionRef,
          generation: call.ctx.generation,
          operationRef: operation.operationRef,
          commandId,
          componentKey,
          version: settings.version ?? "latest",
          props: configured,
        }),
      ),
    },
    {
      outputClassification: operation.outputClassification,
      effect: operation.effect,
    },
    execute,
  );
}

export async function pipedreamInvoke(
  call: PipedreamCall,
  request: InvokeRequest,
): Promise<InvokeResult> {
  const { ctx } = call;
  const operation = boundOperation(ctx.binding, request.operationRef);
  if (!operation)
    throw new ConnectorError("not-found", {
      detail: "pipedream.operation.unknown",
    });
  if (operation.destinationId !== "api")
    throw new ConnectorError("network-policy", {
      detail: "pipedream.destination.mismatch",
    });
  try {
    destinationFor(ctx.binding, operation);
  } catch {
    throw new ConnectorError("network-policy", {
      detail: "pipedream.destination.missing",
    });
  }
  const route = pipedreamRoute(operation);
  const connection = guardConnection(call);
  if (!connection.credentialRef || !connection.externalIds.accountId)
    throw new ConnectorError("denied", {
      detail: "pipedream.connection.unbound",
    });
  const commandId = commandIdSchema.safeParse(request.commandId);
  if (!commandId.success) throw invalidInput("pipedream.command.invalid");
  if (request.idempotencyKey !== undefined)
    // Pipedream documents no idempotency key for these endpoints, so a
    // host-supplied one would be evidence of nothing.
    throw new ConnectorError("unsupported", {
      detail: "pipedream.idempotency.unsupported",
    });
  if (route.kind === "trigger")
    return pipedreamTriggerInvoke(
      call,
      connection,
      operation,
      route,
      request,
      commandId.data,
    );
  if (operation.replay !== "none" && operation.replay !== "read-only")
    throw new ConnectorError("unsupported", {
      detail: "pipedream.replay.unsupported",
    });
  if (route.kind === "proxy")
    return runProxy(call, connection, operation, route, request, commandId.data);
  return runAction(
    call,
    connection,
    operation,
    route.componentKey,
    request,
    commandId.data,
  );
}

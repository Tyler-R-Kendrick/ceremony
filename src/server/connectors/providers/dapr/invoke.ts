import { createHash } from "node:crypto";
import type {
  AdapterCallContext,
  InvokeRequest,
  InvokeResult,
} from "../../adapter.js";
import {
  boundOperation,
  destinationFor,
  destinationUrl,
  type BoundOperation,
} from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import type { CredentialScope } from "../../ports.js";
import {
  approvedDaprOperations,
  daprSidecarFromBinding,
  type DaprBindingSettings,
} from "./binding-settings.js";
import {
  DAPR_API_TOKEN_HEADER,
  daprBindingPath,
  daprInvokeInputSchema,
  type DaprOperation,
} from "./schemas.js";

/*
 * Invoking a configured Dapr output binding.
 *
 * The documented request is `POST /v1.0/bindings/<name>` with a body of
 * `{ data, metadata, operation }`. Everything about that request except the
 * three body fields comes from the binding: the origin, the component name in
 * the path, the approved verb set and the API token. The path is rebuilt from
 * the approved component name and compared against the bound path template, so
 * a template that named a different component than the operation claims is a
 * policy failure rather than a silently different call.
 */

export const DAPR_MAX_RESPONSE_BYTES = 1024 * 1024;
export const DAPR_REQUEST_TIMEOUT_MS = 20_000;

export type DaprInvokeOptions = {
  maxResponseBytes?: number;
  requestTimeoutMs?: number;
};

/** The bound operation, checked against the sidecar settings before anything is sent. */
export function resolveDaprOperation(
  ctx: AdapterCallContext,
  operationRef: string,
): {
  operation: BoundOperation;
  componentName: string;
  settings: DaprBindingSettings;
  url: URL;
} {
  const { settings, destination } = daprSidecarFromBinding(ctx.binding);
  const operation = boundOperation(ctx.binding, operationRef);
  if (!operation)
    throw new ConnectorError("not-found", { detail: "dapr.operation.unknown" });
  if (operation.transport.kind !== "http")
    throw new ConnectorError("invalid-request", {
      detail: "dapr.operation.transport",
    });
  if (operation.transport.method !== "POST" && operation.transport.method !== "PUT")
    throw new ConnectorError("invalid-request", {
      detail: "dapr.operation.method",
    });
  if (operation.destinationId !== settings.destinationId)
    throw new ConnectorError("network-policy", {
      detail: "dapr.operation.destination-mismatch",
    });
  const componentName = operation.nativeId;
  approvedDaprOperations(settings, componentName);
  const expectedPath = daprBindingPath(componentName);
  if (operation.transport.pathTemplate !== expectedPath)
    throw new ConnectorError("denied", {
      detail: "dapr.operation.path-mismatch",
    });
  const resolved = destinationFor(ctx.binding, operation);
  if (resolved.id !== destination.id)
    throw new ConnectorError("network-policy", {
      detail: "dapr.operation.destination-mismatch",
    });
  return {
    operation,
    componentName,
    settings,
    url: destinationUrl(resolved, expectedPath),
  };
}

function credentialScope(ctx: AdapterCallContext): CredentialScope {
  const connection = ctx.connection;
  if (!connection)
    throw new ConnectorError("denied", { detail: "dapr.connection.required" });
  return {
    tenantId: connection.tenantId,
    ownerKind: connection.ownerKind,
    ownerId: connection.ownerId,
    connectionRef: connection.connectionRef,
    bindingRef: ctx.binding.bindingRef,
    custody: connection.custody,
  };
}

/** Reads the sidecar API token privately; the value never leaves this function's caller frame. */
async function withApiToken<T>(
  ctx: AdapterCallContext,
  settings: DaprBindingSettings,
  work: (token: string | undefined) => Promise<T>,
): Promise<T> {
  if (settings.unauthenticatedSidecar) return work(undefined);
  const name = settings.apiTokenConfiguration!;
  const token = await ctx.environment.configuration.read(name);
  if (!token)
    throw new ConnectorError("configuration-required", {
      detail: "dapr.api-token.missing",
    });
  return work(token);
}

/**
 * Validates the caller's input against the operation's approved verbs and
 * metadata keys. A caller that names an unapproved verb is refused before the
 * request exists: turning an approved `get` into a `delete` is the whole
 * attack this check prevents.
 */
export function validateDaprInput(
  input: unknown,
  approved: { operations: readonly DaprOperation[]; metadataKeys: readonly string[] },
): { data?: unknown; metadata?: Record<string, string>; operation: DaprOperation } {
  const parsed = daprInvokeInputSchema.safeParse(input ?? {});
  if (!parsed.success)
    throw new ConnectorError("invalid-request", { detail: "dapr.input.invalid" });
  const operation = parsed.data.operation ?? approved.operations[0]!;
  if (!approved.operations.includes(operation))
    throw new ConnectorError("denied", { detail: "dapr.operation.verb-unapproved" });
  const metadata = parsed.data.metadata;
  if (metadata)
    for (const key of Object.keys(metadata))
      if (!approved.metadataKeys.includes(key))
        throw new ConnectorError("denied", {
          detail: "dapr.metadata.key-unapproved",
        });
  return {
    ...(parsed.data.data === undefined ? {} : { data: parsed.data.data }),
    ...(metadata ? { metadata } : {}),
    operation,
  };
}

/** Invokes one approved output binding, journalling the effect before the call. */
export async function invokeDaprOutputBinding(
  ctx: AdapterCallContext,
  request: InvokeRequest,
  options: DaprInvokeOptions = {},
): Promise<InvokeResult> {
  const { operation, componentName, settings, url } = resolveDaprOperation(
    ctx,
    request.operationRef,
  );
  const approved = approvedDaprOperations(settings, componentName);
  const body = validateDaprInput(request.input, approved);
  const payload = JSON.stringify(body);
  // Length-prefixed so no separator can appear inside a part and change the
  // meaning of the composite key.
  const digest = createHash("sha256")
    .update(
      [componentName, body.operation, payload]
        .map((part) => `${part.length}:${part}`)
        .join("|"),
    )
    .digest("hex");
  const { effectRef, prior } = await ctx.environment.effects.begin({
    actor: ctx.actor,
    ...(ctx.connection ? { connectionRef: ctx.connection.connectionRef } : {}),
    bindingRef: ctx.binding.bindingRef,
    operation: `dapr.bindings.invoke:${componentName}:${body.operation}`,
    digest,
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

  const controller = new AbortController();
  const abort = () => controller.abort();
  ctx.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    abort,
    options.requestTimeoutMs ?? DAPR_REQUEST_TIMEOUT_MS,
  );
  let response: Response;
  try {
    /*
     * The token is resolved first and separately: a missing one is a
     * configuration failure that must not be reported as an unreachable
     * sidecar, and no request is sent without it.
     */
    response = await withApiToken(ctx, settings, async (token) => {
      try {
        return await ctx.environment.fetch(url, {
          method:
            operation.transport.kind === "http"
              ? operation.transport.method
              : "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            ...(token ? { [DAPR_API_TOKEN_HEADER]: token } : {}),
          },
          body: payload,
        });
      } catch (error) {
        throw new ConnectorError(
          ctx.signal.aborted ? "cancelled" : "upstream-unavailable",
          { detail: "dapr.sidecar.unreachable", cause: error },
        );
      }
    });
  } catch (error) {
    if (
      error instanceof ConnectorError &&
      error.detail !== "dapr.sidecar.unreachable"
    ) {
      // Nothing was sent, so nothing can be uncertain.
      await ctx.environment.effects.complete(effectRef, {
        status: "not-applied",
        code: "dapr.request.not-sent",
        at: ctx.environment.now(),
      });
      throw error;
    }
    /*
     * A dropped connection after a write leaves the effect uncertain: the
     * binding invocation may have happened. It is recorded as indeterminate,
     * never retried blindly.
     */
    const uncertain = operation.effect !== "read";
    await ctx.environment.effects.complete(effectRef, {
      status: uncertain ? "indeterminate" : "not-applied",
      code: "dapr.sidecar.unreachable",
      at: ctx.environment.now(),
    });
    throw error instanceof ConnectorError
      ? error
      : new ConnectorError(
          ctx.signal.aborted ? "cancelled" : "upstream-unavailable",
          { detail: "dapr.sidecar.unreachable", cause: error },
        );
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", abort);
  }

  const maxBytes = options.maxResponseBytes ?? DAPR_MAX_RESPONSE_BYTES;
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    await ctx.environment.effects.complete(effectRef, {
      status: "indeterminate",
      code: "dapr.response.oversized",
      at: ctx.environment.now(),
    });
    throw new ConnectorError("upstream-rejected", {
      detail: "dapr.response.oversized",
    });
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    await ctx.environment.effects.complete(effectRef, {
      status: "indeterminate",
      code: "dapr.response.oversized",
      at: ctx.environment.now(),
    });
    throw new ConnectorError("upstream-rejected", {
      detail: "dapr.response.oversized",
    });
  }

  if (response.status === 401 || response.status === 403) {
    await ctx.environment.effects.complete(effectRef, {
      status: "not-applied",
      code: "dapr.api-token.rejected",
      at: ctx.environment.now(),
    });
    throw new ConnectorError("denied", { detail: "dapr.api-token.rejected" });
  }
  if (response.status === 404) {
    await ctx.environment.effects.complete(effectRef, {
      status: "not-applied",
      code: "dapr.component.unknown",
      at: ctx.environment.now(),
    });
    throw new ConnectorError("not-found", { detail: "dapr.component.unknown" });
  }
  if (!response.ok) {
    /*
     * 400 is documented as a malformed request and 500 as a failed request.
     * Neither proves the external system was untouched, so a write stays
     * uncertain while a read is simply not applied.
     */
    const uncertain = response.status >= 500 && operation.effect !== "read";
    await ctx.environment.effects.complete(effectRef, {
      status: uncertain ? "indeterminate" : "not-applied",
      code: "dapr.binding.rejected",
      at: ctx.environment.now(),
    });
    throw new ConnectorError(
      response.status >= 500 ? "upstream-unavailable" : "upstream-rejected",
      { detail: "dapr.binding.rejected" },
    );
  }

  let output: unknown;
  if (buffer.byteLength > 0) {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("json")) {
      try {
        output = JSON.parse(text) as unknown;
      } catch {
        await ctx.environment.effects.complete(effectRef, {
          status: "applied",
          code: "dapr.response.invalid",
          at: ctx.environment.now(),
        });
        throw new ConnectorError("upstream-rejected", {
          detail: "dapr.response.invalid",
        });
      }
    } else output = text;
  }
  await ctx.environment.effects.complete(effectRef, {
    status: "applied",
    at: ctx.environment.now(),
  });
  return {
    state: "complete",
    ...(output === undefined ? {} : { output }),
    outputClassification: operation.outputClassification,
    effect: operation.effect,
    effectRef,
  };
}

export { credentialScope as daprCredentialScope };

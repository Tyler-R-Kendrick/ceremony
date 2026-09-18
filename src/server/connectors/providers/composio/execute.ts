import {
  canonicalConnectorJson,
  encodePathSegment,
  isReservedObjectKey,
} from "../../../../core/connectors/index.js";
import type { InvokeRequest, InvokeResult } from "../../adapter.js";
import { boundOperation, type BoundOperation } from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import { expectJson } from "./client.js";
import { fetchTool, toolSchemaDigest } from "./catalog.js";
import { guardConnection, type ComposioCall } from "./context.js";
import { sha256Hex } from "./identity.js";
import {
  composioRoute,
  operationSettings,
  permittedAccounts,
  type ComposioOperationSettings,
  type ComposioRoute,
} from "./settings.js";
import {
  sessionExecuteResponseSchema,
  sessionSchema,
  toolExecuteResponseSchema,
  unrestrictedMetaTools,
} from "./wire.js";

/*
 * Approved tool execution.
 *
 * A caller names an operation reference and validated arguments. It never
 * names a tool slug, a tool version, a connected account, a Composio user, a
 * session, a base URL or an auth override — the binding fixes the first three,
 * the connection fixes the next two, and the last two have no caller-facing
 * form at all. Three gates stand between an operation reference and a request:
 *
 *   - the binding's tool allowlist, which the operation's transport must be in;
 *   - the meta-tool allowlist, which is empty unless the host wrote it, so the
 *     router's account-management and workbench tools are off by construction;
 *   - the pinned tool version and reviewed input-schema digest, which are
 *     re-checked against the live catalogue so that drift stops execution
 *     instead of silently changing what an approval meant.
 */

const denied = (detail: string) => new ConnectorError("denied", { detail });
const invalid = (detail: string) =>
  new ConnectorError("invalid-request", { detail });

/**
 * Argument names that carry identity or authority. They are refused whatever a
 * binding says, because a caller that could set one of them could act as
 * another user, against another account, at another base URL.
 */
export const reservedArgumentNames: ReadonlySet<string> = new Set([
  "user_id",
  "entity_id",
  "connected_account_id",
  "connectedAccountId",
  "auth_config_id",
  "custom_auth_params",
  "custom_connection_data",
  "version",
  "toolkit_versions",
  "account",
  "session_id",
]);

const TOOL_CHECK_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;

function toolAllowed(call: ComposioCall, route: ComposioRoute): void {
  if (route.kind === "meta") {
    const approved = call.settings.metaTools ?? [];
    if (!approved.includes(route.metaTool as never))
      // Account management, multi-execute and the remote workbench are the
      // meta tools that can widen everything else; nothing enables them but an
      // explicit binding entry.
      throw denied("composio.meta-tool.unapproved");
    return;
  }
  if (!call.settings.tools.includes(route.toolSlug))
    throw denied("composio.tool.unapproved");
}

/** Caller arguments, checked name by name against the operation's declaration. */
function readArguments(
  operation: BoundOperation,
  settings: ComposioOperationSettings,
  binding: { permittedTargets: readonly { kind: string; id: string }[] },
  input: unknown,
): Record<string, unknown> {
  if (input === undefined || input === null) return withFixed({}, settings);
  if (typeof input !== "object" || Array.isArray(input))
    throw invalid("composio.arguments.shape");
  const declared = new Set(settings.arguments ?? []);
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
    if (isReservedObjectKey(name) || reservedArgumentNames.has(name))
      throw invalid("composio.arguments.reserved");
    if (!declared.has(name)) throw invalid("composio.arguments.unknown");
    out[name] = value;
  }
  for (const name of operation.targetParameters) {
    const value = out[name];
    if (typeof value !== "string") throw invalid("composio.target.missing");
    if (!binding.permittedTargets.some((target) => target.id === value))
      throw denied("composio.target.not-permitted");
  }
  return withFixed(out, settings);
}

function withFixed(
  args: Record<string, unknown>,
  settings: ComposioOperationSettings,
): Record<string, unknown> {
  // Host-fixed arguments are applied last: a caller cannot override them.
  return { ...args, ...(settings.fixedArguments ?? {}) };
}

/**
 * The account this invocation runs against. It comes from the connection, is
 * checked against the binding's permitted targets, and must be one this
 * adapter last observed as ACTIVE. A paused account at Composio cannot execute
 * a tool, so a connection carrying an inactive status is refused here rather
 * than discovered through an upstream error.
 */
function resolveAccount(call: ComposioCall): string {
  const connection = guardConnection(call);
  const accountId = connection.externalIds.connectedAccountId;
  if (!accountId)
    throw new ConnectorError("not-found", {
      detail: "composio.account.unknown",
    });
  const allowed = permittedAccounts(call.ctx.binding);
  if (allowed.length && !allowed.includes(accountId))
    throw denied("composio.account.not-permitted");
  if (connection.lifecycle !== "active")
    throw denied("composio.connection.not-active");
  const status = (connection.state as { composioStatus?: unknown })
    .composioStatus;
  if (typeof status === "string" && status !== "ACTIVE")
    throw denied("composio.account.not-active");
  if (connection.generation !== call.ctx.generation)
    throw denied("composio.connection.stale-generation");
  return accountId;
}

/**
 * The version this operation was approved at, re-checked against the live
 * catalogue. A pinned version the toolkit no longer serves, a tool that moved
 * to a different slug, or an input schema whose digest changed since review
 * stops the call: drift requires a new review, not a best-effort request.
 */
async function assertReviewedTool(
  call: ComposioCall,
  shared: { toolChecks: Map<string, { at: number; digest: string; version: string }> },
  toolSlug: string,
  version: string,
  settings: ComposioOperationSettings,
): Promise<void> {
  // "latest" is a documented moving alias. A binding that chose it accepted
  // that the tool may change; nothing is pinned, so nothing is re-checked.
  if (version === "latest") return;
  const key = [
    call.ctx.actor.tenantId,
    call.ctx.binding.bindingRef,
    String(call.ctx.binding.revision),
    toolSlug,
    version,
    settings.schemaDigest ?? "",
  ].join(" ");
  const now = call.ctx.environment.now();
  const cached = shared.toolChecks.get(key);
  if (cached && now - cached.at < TOOL_CHECK_TTL_MS) return;
  const tool = await fetchTool(call, toolSlug, version);
  if (tool.slug !== toolSlug)
    throw new ConnectorError("unsupported", {
      detail: "composio.tool.mismatch",
    });
  const available = tool.available_versions ?? [];
  const served = tool.version ?? undefined;
  const pinnedIsServed =
    available.length > 0 ? available.includes(version) : served === version;
  if (!pinnedIsServed)
    // The approval names a version this toolkit no longer serves. Executing
    // whatever it serves instead would run code nobody reviewed.
    throw new ConnectorError("unsupported", {
      detail: "composio.tool.version-unavailable",
    });
  const digest = await toolSchemaDigest(tool);
  if (settings.schemaDigest && digest !== settings.schemaDigest)
    throw new ConnectorError("conflict", {
      detail: "composio.tool.schema-drift",
    });
  shared.toolChecks.set(key, { at: now, digest, version });
}

function sessionKey(call: ComposioCall, accountId: string): string {
  return [
    call.ctx.actor.tenantId,
    call.ctx.binding.bindingRef,
    String(call.ctx.binding.revision),
    call.ctx.connection?.connectionRef ?? "",
    accountId,
  ].join(" ");
}

/**
 * Creates an execution session for this connection's account.
 *
 * `manage_connections` is enabled only when the binding authorized the
 * management meta tool, and the session Composio answers with is checked: if
 * it advertises any tool this binding did not approve, the session is not used
 * at all. A session that can manage connections is a session that can change
 * which account an agent acts as.
 */
async function createSession(
  call: ComposioCall,
  accountId: string,
): Promise<string> {
  const meta = call.settings.metaTools ?? [];
  const session = call.settings.session ?? {};
  const response = await call.client.send({
    method: "POST",
    path: call.client.path("/tool_router/session"),
    body: {
      user_id: call.userId,
      toolkits: [call.settings.toolkit.slug],
      auth_configs: Object.fromEntries(
        call.settings.authConfigs.map((id) => [call.settings.toolkit.slug, id]),
      ),
      connected_accounts: { [call.settings.toolkit.slug]: accountId },
      manage_connections: {
        enable: meta.includes("COMPOSIO_MANAGE_CONNECTIONS"),
        enable_wait_for_connections: session.enableWaitForConnections ?? false,
        enable_connection_removal: session.enableConnectionRemoval ?? false,
      },
      multi_account: {
        enable: true,
        max_accounts_per_toolkit: session.maxAccountsPerToolkit ?? 1,
        require_explicit_selection: true,
      },
    },
    timeoutMs: call.options.timeouts.write,
    consequential: true,
  });
  const created = expectJson(response, sessionSchema);
  const advertised = created.tool_router_tools ?? [];
  for (const name of advertised) {
    if (call.settings.tools.includes(name)) continue;
    if (meta.includes(name as never)) continue;
    if (unrestrictedMetaTools.has(name) || name.startsWith("COMPOSIO_"))
      throw denied("composio.session.meta-tool-unapproved");
    throw denied("composio.session.tool-unapproved");
  }
  return created.session_id;
}

async function sessionFor(
  call: ComposioCall,
  shared: { sessions: Map<string, { sessionId: string; at: number }> },
  accountId: string,
  force: boolean,
): Promise<string> {
  const key = sessionKey(call, accountId);
  const ttl = call.settings.session?.ttlMs ?? DEFAULT_SESSION_TTL_MS;
  const now = call.ctx.environment.now();
  const cached = shared.sessions.get(key);
  if (!force && cached && now - cached.at < ttl) return cached.sessionId;
  if (force) shared.sessions.delete(key);
  const sessionId = await createSession(call, accountId);
  shared.sessions.set(key, { sessionId, at: now });
  return sessionId;
}

function resultFor(
  operation: BoundOperation,
  state: InvokeResult["state"],
  extra: { output?: unknown; code?: string; effectRef?: string },
): InvokeResult {
  return {
    state,
    ...(extra.output === undefined ? {} : { output: extra.output }),
    outputClassification: operation.outputClassification,
    effect: operation.effect,
    ...(extra.code ? { code: extra.code } : {}),
    ...(extra.effectRef ? { effectRef: extra.effectRef } : {}),
  };
}

export type ComposioInvokeDeps = {
  toolChecks: Map<string, { at: number; digest: string; version: string }>;
  sessions: Map<string, { sessionId: string; at: number }>;
};

export async function composioInvoke(
  call: ComposioCall,
  request: InvokeRequest,
  shared: ComposioInvokeDeps,
): Promise<InvokeResult> {
  const operation = boundOperation(call.ctx.binding, request.operationRef);
  if (!operation) throw denied("composio.operation.unbound");
  const route = composioRoute(operation);
  toolAllowed(call, route);
  if (route.kind !== "tool" && (call.settings.execution ?? "direct") !== "session")
    throw new ConnectorError("unsupported", {
      detail: "composio.execution.profile",
    });
  const settings = operationSettings(call.settings, operation.operationRef);
  const args = readArguments(
    operation,
    settings,
    call.ctx.binding,
    request.input,
  );
  const accountId = resolveAccount(call);
  const version = settings.version ?? call.settings.toolkit.version;
  if (route.kind !== "meta") {
    await assertReviewedTool(call, shared, route.toolSlug, version, settings);
  }

  const digest = sha256Hex(
    canonicalConnectorJson({
      operationRef: operation.operationRef,
      bindingRef: call.ctx.binding.bindingRef,
      bindingRevision: call.ctx.binding.revision,
      connectionRef: call.ctx.connection?.connectionRef ?? "",
      accountId,
      version,
      route,
      arguments: args,
      commandId: request.commandId,
    }),
  );
  const intent = {
    actor: call.ctx.actor,
    ...(call.ctx.connection
      ? { connectionRef: call.ctx.connection.connectionRef }
      : {}),
    bindingRef: call.ctx.binding.bindingRef,
    operation: `composio.execute.${operation.operationRef}`,
    digest,
    ...(request.idempotencyKey &&
    operation.replay === "upstream-idempotency-key"
      ? {
          idempotency: {
            key: request.idempotencyKey,
            scope: "composio.tool-execution",
          },
        }
      : {}),
    commandId: request.commandId,
  };
  const effect = await call.ctx.environment.effects.begin(intent);
  if (effect.prior && operation.replay !== "read-only")
    // The same effect was attempted before. Its recorded outcome answers;
    // repeating an unreplayable write because the first response was lost is
    // exactly what the journal exists to prevent.
    return resultFor(
      operation,
      effect.prior.status === "applied"
        ? "complete"
        : effect.prior.status === "not-applied"
          ? "failed"
          : effect.prior.status === "reconciled"
            ? "complete"
            : effect.prior.status === "failed"
              ? "failed"
              : "indeterminate",
      { code: "composio.effect.replayed", effectRef: effect.effectRef },
    );

  const timeoutMs = settings.timeoutMs ?? call.options.timeouts.execute;
  const consequential = operation.effect !== "read";
  try {
    const outcome =
      route.kind === "tool"
        ? await executeDirect(call, route.toolSlug, {
            accountId,
            version,
            args,
            timeoutMs,
            consequential,
          })
        : await executeInSession(call, shared, route, {
            accountId,
            args,
            timeoutMs,
            consequential,
          });
    await call.ctx.environment.effects.complete(effect.effectRef, {
      status: outcome.ok ? "applied" : "not-applied",
      at: call.ctx.environment.now(),
      ...(outcome.ok ? {} : { code: "composio.tool.failed" }),
    });
    return outcome.ok
      ? resultFor(operation, "complete", {
          output: outcome.output,
          effectRef: effect.effectRef,
        })
      : // The upstream error string can quote the provider's own response, so
        // it never leaves this function; only the sanitized code does.
        resultFor(operation, "failed", {
          code: "composio.tool.failed",
          effectRef: effect.effectRef,
        });
  } catch (error) {
    const indeterminate =
      error instanceof ConnectorError && error.code === "indeterminate";
    await call.ctx.environment.effects.complete(effect.effectRef, {
      status: indeterminate ? "indeterminate" : "failed",
      at: call.ctx.environment.now(),
    });
    throw error;
  }
}

type ExecutionOutcome = { ok: boolean; output?: unknown };

async function executeDirect(
  call: ComposioCall,
  toolSlug: string,
  input: {
    accountId: string;
    version: string;
    args: Record<string, unknown>;
    timeoutMs: number;
    consequential: boolean;
  },
): Promise<ExecutionOutcome> {
  const response = await call.client.send({
    method: "POST",
    path: call.client.path(
      `/tools/execute/${encodePathSegment(toolSlug)}`,
    ),
    body: {
      user_id: call.userId,
      connected_account_id: input.accountId,
      version: input.version,
      arguments: input.args,
    },
    timeoutMs: input.timeoutMs,
    consequential: input.consequential,
  });
  const body = expectJson(response, toolExecuteResponseSchema);
  const ok = body.successful === true && !body.error;
  return ok ? { ok, output: body.data } : { ok: false };
}

async function executeInSession(
  call: ComposioCall,
  shared: ComposioInvokeDeps,
  route: Extract<ComposioRoute, { kind: "session-tool" } | { kind: "meta" }>,
  input: {
    accountId: string;
    args: Record<string, unknown>;
    timeoutMs: number;
    consequential: boolean;
  },
): Promise<ExecutionOutcome> {
  const toolSlug =
    route.kind === "meta" ? route.metaTool : route.toolSlug;
  const suffix = route.kind === "meta" ? "execute_meta" : "execute";
  const run = async (sessionId: string) =>
    call.client.send({
      method: "POST",
      path: call.client.path(
        `/tool_router/session/${encodePathSegment(sessionId)}/${suffix}`,
      ),
      body: {
        tool_slug: toolSlug,
        arguments: input.args,
        ...(route.kind === "meta" ? {} : { account: input.accountId }),
      },
      timeoutMs: input.timeoutMs,
      consequential: input.consequential,
    });
  let sessionId = await sessionFor(call, shared, input.accountId, false);
  let response = await run(sessionId);
  if (response.status === 404 || response.status === 410) {
    // A session Composio no longer holds is recreated once, under the same
    // approval checks; the account and the tool allowlist do not change.
    sessionId = await sessionFor(call, shared, input.accountId, true);
    response = await run(sessionId);
  }
  const body = expectJson(response, sessionExecuteResponseSchema);
  const ok = !body.error;
  return ok ? { ok, output: body.data } : { ok: false };
}

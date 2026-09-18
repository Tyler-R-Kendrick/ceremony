import { z } from "zod";
import {
  canonicalConnectorJson,
  encodePathSegment,
} from "../../../../core/connectors/index.js";
import type { InvokeRequest, InvokeResult } from "../../adapter.js";
import {
  destinationUrl,
  type BoundOperation,
  type RuntimeBinding,
} from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import type { ConnectionRecord } from "../../ports.js";
import { expectJson, upstreamFailure } from "./client.js";
import { connectionScope, type PipedreamCall } from "./context.js";
import { pipedreamTriggerIdSchema, sha256Hex } from "./identity.js";
import { checkJsonBounds, journaled, validateProps } from "./guards.js";
import {
  operationSettings,
  type PipedreamOperationSettings,
  type PipedreamRoute,
} from "./settings.js";
import {
  deployedTriggerEnvelopeSchema,
  deployedTriggerListSchema,
  type PipedreamDeployedTrigger,
} from "./wire.js";

/*
 * Trigger lifecycle (PD-04). A trigger is deployed for the host-derived
 * external user with the connection's account, and its events are delivered
 * only to an approved destination of the binding — never to a URL a caller
 * names. Deploy is deduplicated twice over: the effect journal refuses to
 * repeat an intent whose digest it has already seen, and before deploying,
 * the adapter looks for an equivalent trigger the broker already holds for
 * this external user. A deploy whose response is lost is reconciled against
 * that same listing rather than retried blindly.
 */

type TriggerRoute = Extract<PipedreamRoute, { kind: "trigger" }>;

const deployInputSchema = z.strictObject({
  props: z.record(z.string(), z.unknown()).optional(),
});
const deleteInputSchema = z.strictObject({ triggerId: z.string() });
const listInputSchema = z.strictObject({
  cursor: z.string().max(512).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const invalid = (detail: string) =>
  new ConnectorError("invalid-request", { detail });

export type TriggerView = {
  id: string;
  componentKey: string | undefined;
  name: string | undefined;
  active: boolean;
  createdAt: number | undefined;
  updatedAt: number | undefined;
};

/** Only bounded, non-secret fields leave the broker's trigger record. */
export function triggerView(raw: PipedreamDeployedTrigger): TriggerView {
  return {
    id: raw.id,
    componentKey: raw.component_key ?? raw.component_id ?? undefined,
    name: typeof raw.name === "string" ? raw.name.slice(0, 200) : undefined,
    active: raw.active !== false,
    createdAt: typeof raw.created_at === "number" ? raw.created_at : undefined,
    updatedAt: typeof raw.updated_at === "number" ? raw.updated_at : undefined,
  };
}

/**
 * The delivery URL for a deployed trigger: an approved destination of this
 * binding, its approved path, and a deterministic per-intent segment so the
 * receiving route can find the connection. Nothing here comes from a caller,
 * and a binding without an approved webhook destination cannot deploy.
 */
export function deliveryUrl(
  binding: RuntimeBinding,
  settings: PipedreamOperationSettings,
  deliveryId: string,
): string {
  if (!settings.webhookDestinationId)
    throw new ConnectorError("configuration-required", {
      detail: "pipedream.trigger.destination-missing",
    });
  const destination = binding.destinations.find(
    (item) => item.id === settings.webhookDestinationId,
  );
  if (!destination)
    throw new ConnectorError("network-policy", {
      detail: "pipedream.trigger.destination-unapproved",
    });
  const base = (settings.webhookPath ?? "/").replace(/\/+$/, "");
  try {
    return destinationUrl(destination, `${base}/${deliveryId}`).href;
  } catch {
    throw new ConnectorError("network-policy", {
      detail: "pipedream.trigger.destination-path",
    });
  }
}

/** Canonical identity of "the same deployed trigger", independent of who asked or when. */
function deployDigest(
  call: PipedreamCall,
  connection: ConnectionRecord,
  componentKey: string,
  settings: PipedreamOperationSettings,
  props: Record<string, unknown>,
): string {
  return sha256Hex(
    canonicalConnectorJson({
      v: 1,
      kind: "trigger.deploy",
      tenantId: call.ctx.actor.tenantId,
      connectionRef: connection.connectionRef,
      externalUserId: call.externalUserId,
      projectId: call.config.projectId,
      environment: call.config.environment,
      componentKey,
      version: settings.version ?? "latest",
      props,
    }),
  );
}

function propsDigest(
  componentKey: string,
  props: Record<string, unknown>,
): string {
  return sha256Hex(canonicalConnectorJson({ componentKey, props }));
}

async function listTriggers(
  call: PipedreamCall,
  query: Record<string, string> = {},
): Promise<{ items: PipedreamDeployedTrigger[]; nextCursor?: string }> {
  const response = await call.client.send({
    method: "GET",
    path: call.client.projectPath("/deployed-triggers"),
    query: { external_user_id: call.externalUserId, ...query },
    timeoutMs: call.options.timeouts.read,
    consequential: false,
  });
  const data = expectJson(response, deployedTriggerListSchema);
  const cursor = data.page_info?.end_cursor;
  return {
    items: data.data,
    ...(typeof cursor === "string" && cursor ? { nextCursor: cursor } : {}),
  };
}

/**
 * Finds a trigger the broker already holds for this external user that would
 * be identical to the one we are about to deploy. `configured_props` come
 * back from the broker with the app prop rendered as its account reference,
 * so the comparison drops the app prop and compares the rest canonically.
 */
async function findEquivalent(
  call: PipedreamCall,
  componentKey: string,
  appProp: string,
  props: Record<string, unknown>,
): Promise<PipedreamDeployedTrigger | undefined> {
  const wanted = propsDigest(componentKey, props);
  const { items } = await listTriggers(call);
  return items.find((item) => {
    const key = item.component_key ?? item.component_id ?? undefined;
    if (key !== componentKey) return false;
    const configured = { ...(item.configured_props ?? {}) };
    delete configured[appProp];
    return propsDigest(componentKey, configured) === wanted;
  });
}

function deployResult(
  operation: BoundOperation,
  trigger: PipedreamDeployedTrigger,
  code?: string,
): InvokeResult {
  return {
    state: "complete",
    output: { trigger: triggerView(trigger) },
    outputClassification: operation.outputClassification,
    effect: operation.effect,
    ...(code ? { code } : {}),
  };
}

async function deploy(
  call: PipedreamCall,
  connection: ConnectionRecord,
  operation: BoundOperation,
  componentKey: string,
  request: InvokeRequest,
  commandId: string,
): Promise<InvokeResult> {
  const { ctx } = call;
  const settings = operationSettings(call.settings, operation.operationRef);
  const parsed = deployInputSchema.safeParse(request.input ?? {});
  if (!parsed.success) throw invalid("pipedream.input.invalid");
  const appProp = settings.appProp ?? call.settings.app;
  const props = validateProps(parsed.data.props, settings, appProp);
  const digest = deployDigest(call, connection, componentKey, settings, props);
  const url = deliveryUrl(ctx.binding, settings, digest.slice(0, 32));
  const meta = {
    outputClassification: operation.outputClassification,
    effect: operation.effect,
  } as const;
  const credentialRef = connection.credentialRef!;

  const reconcile = async (): Promise<PipedreamDeployedTrigger | undefined> =>
    findEquivalent(call, componentKey, appProp, props);

  const begun = await ctx.environment.effects.begin({
    actor: ctx.actor,
    connectionRef: connection.connectionRef,
    bindingRef: ctx.binding.bindingRef,
    operation: "pipedream.trigger.deploy",
    digest,
    commandId,
  });
  if (begun.prior) {
    // A repeated deploy never creates a second trigger: it reports the one
    // the first attempt produced, or reconciles an uncertain first attempt.
    const existing = await reconcile();
    if (existing) {
      if (begun.prior.status === "indeterminate")
        await ctx.environment.effects.complete(begun.effectRef, {
          status: "reconciled",
          code: "pipedream.trigger.reconciled",
          at: ctx.environment.now(),
        });
      return {
        ...deployResult(operation, existing, "pipedream.trigger.already-deployed"),
        effectRef: begun.effectRef,
      };
    }
    if (begun.prior.status === "indeterminate")
      return {
        ...meta,
        state: "indeterminate",
        code: "pipedream.trigger.indeterminate",
        effectRef: begun.effectRef,
      };
    if (begun.prior.status === "applied" || begun.prior.status === "reconciled")
      return {
        ...meta,
        state: "indeterminate",
        code: "pipedream.trigger.missing-after-apply",
        effectRef: begun.effectRef,
      };
  } else {
    const existing = await reconcile();
    if (existing) {
      await ctx.environment.effects.complete(begun.effectRef, {
        status: "applied",
        code: "pipedream.trigger.already-deployed",
        at: ctx.environment.now(),
      });
      return {
        ...deployResult(operation, existing, "pipedream.trigger.already-deployed"),
        effectRef: begun.effectRef,
      };
    }
  }

  const run = async (): Promise<InvokeResult> =>
    ctx.environment.credentials.use(
      connectionScope(ctx, "external-credential-broker"),
      credentialRef,
      async (material) => {
        if (material.accountId !== connection.externalIds.accountId)
          throw new ConnectorError("denied", {
            detail: "pipedream.credential.mismatch",
          });
        const response = await call.client.send({
          method: "POST",
          path: call.client.projectPath("/triggers/deploy"),
          body: {
            id: componentKey,
            external_user_id: call.externalUserId,
            configured_props: {
              ...props,
              [appProp]: { authProvisionId: material.accountId },
            },
            webhook_url: url,
            emit_on_deploy: settings.emitOnDeploy ?? false,
            ...(settings.version ? { version: settings.version } : {}),
          },
          timeoutMs: call.options.timeouts.write,
          consequential: true,
        });
        if (response.status < 200 || response.status >= 300)
          throw upstreamFailure(response.status);
        const data = expectJson(response, deployedTriggerEnvelopeSchema).data;
        const result = deployResult(operation, data);
        const signingKey = data.webhook_signing_key;
        if (typeof signingKey === "string" && signingKey.length > 0) {
          // The signing key authenticates later deliveries; it is credential
          // material and goes to custody, never into a result or the journal.
          const ref = await ctx.environment.credentials.store(
            connectionScope(ctx, "host-owned"),
            { signingKey, triggerId: data.id },
          );
          return {
            ...result,
            output: {
              trigger: triggerView(data),
              delivery: { url, signingKeyRef: ref },
            },
          };
        }
        return {
          ...result,
          output: { trigger: triggerView(data), delivery: { url } },
        };
      },
    );

  // The journal entry is open; complete it with whatever this attempt learns.
  try {
    const result = await run();
    await ctx.environment.effects.complete(begun.effectRef, {
      status: "applied",
      at: ctx.environment.now(),
    });
    return { ...result, effectRef: begun.effectRef };
  } catch (error) {
    const connector = error instanceof ConnectorError ? error : undefined;
    if (connector?.code === "indeterminate") {
      const settled = await reconcile().catch(() => undefined);
      if (settled) {
        await ctx.environment.effects.complete(begun.effectRef, {
          status: "reconciled",
          code: "pipedream.trigger.reconciled",
          at: ctx.environment.now(),
        });
        return {
          ...deployResult(operation, settled, "pipedream.trigger.reconciled"),
          effectRef: begun.effectRef,
        };
      }
      await ctx.environment.effects.complete(begun.effectRef, {
        status: "indeterminate",
        code: connector.detail ?? "pipedream.transport.lost",
        at: ctx.environment.now(),
      });
      return {
        ...meta,
        state: "indeterminate",
        code: "pipedream.trigger.indeterminate",
        effectRef: begun.effectRef,
      };
    }
    await ctx.environment.effects.complete(begun.effectRef, {
      status: "failed",
      ...(connector ? { code: connector.code } : {}),
      at: ctx.environment.now(),
    });
    throw error;
  }
}

async function list(
  call: PipedreamCall,
  operation: BoundOperation,
  componentKey: string,
  request: InvokeRequest,
): Promise<InvokeResult> {
  const parsed = listInputSchema.safeParse(request.input ?? {});
  if (!parsed.success) throw invalid("pipedream.input.invalid");
  const { items, nextCursor } = await listTriggers(call, {
    ...(parsed.data.cursor ? { after: parsed.data.cursor } : {}),
    ...(parsed.data.limit ? { limit: String(parsed.data.limit) } : {}),
  });
  const mine = items.filter(
    (item) => (item.component_key ?? item.component_id) === componentKey,
  );
  return {
    state: "complete",
    output: {
      triggers: mine.map(triggerView),
      ...(nextCursor ? { nextCursor } : {}),
    },
    outputClassification: operation.outputClassification,
    effect: operation.effect,
  };
}

async function remove(
  call: PipedreamCall,
  connection: ConnectionRecord,
  operation: BoundOperation,
  componentKey: string,
  request: InvokeRequest,
  commandId: string,
): Promise<InvokeResult> {
  const parsed = deleteInputSchema.safeParse(request.input ?? {});
  if (!parsed.success) throw invalid("pipedream.input.invalid");
  const triggerId = pipedreamTriggerIdSchema.safeParse(parsed.data.triggerId);
  if (!triggerId.success) throw invalid("pipedream.trigger.id-invalid");
  const meta = {
    outputClassification: operation.outputClassification,
    effect: operation.effect,
  } as const;
  return journaled(
    call,
    {
      operation: "pipedream.trigger.delete",
      commandId,
      connectionRef: connection.connectionRef,
      digest: sha256Hex(
        canonicalConnectorJson({
          v: 1,
          kind: "trigger.delete",
          tenantId: call.ctx.actor.tenantId,
          connectionRef: connection.connectionRef,
          externalUserId: call.externalUserId,
          environment: call.config.environment,
          triggerId: triggerId.data,
        }),
      ),
    },
    meta,
    async () => {
      // The listing is scoped to this external user, so a trigger belonging to
      // anyone else is simply not there to delete.
      const { items } = await listTriggers(call);
      const owned = items.find((item) => item.id === triggerId.data);
      if (!owned || (owned.component_key ?? owned.component_id) !== componentKey)
        return {
          ...meta,
          state: "failed",
          code: "pipedream.trigger.not-found",
        };
      const response = await call.client.send({
        method: "DELETE",
        path: call.client.projectPath(
          `/deployed-triggers/${encodePathSegment(triggerId.data)}`,
        ),
        query: { external_user_id: call.externalUserId },
        timeoutMs: call.options.timeouts.write,
        consequential: true,
      });
      if (response.status === 204 || response.status === 200)
        return {
          ...meta,
          state: "complete",
          output: { deleted: triggerId.data },
        };
      if (response.status === 404)
        return { ...meta, state: "complete", output: { deleted: triggerId.data } };
      throw upstreamFailure(response.status);
    },
  );
}

export async function pipedreamTriggerInvoke(
  call: PipedreamCall,
  connection: ConnectionRecord,
  operation: BoundOperation,
  route: TriggerRoute,
  request: InvokeRequest,
  commandId: string,
): Promise<InvokeResult> {
  checkJsonBounds(request.input ?? {}, "pipedream.input.bounds");
  if (route.action === "list") {
    if (operation.effect !== "read")
      throw new ConnectorError("unsupported", {
        detail: "pipedream.trigger.effect",
      });
    return list(call, operation, route.componentKey, request);
  }
  if (operation.replay !== "none" && operation.replay !== "reconciliation")
    throw new ConnectorError("unsupported", {
      detail: "pipedream.replay.unsupported",
    });
  return route.action === "deploy"
    ? deploy(call, connection, operation, route.componentKey, request, commandId)
    : remove(call, connection, operation, route.componentKey, request, commandId);
}

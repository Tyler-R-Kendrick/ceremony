import { z } from "zod";
import type { AdapterCallContext } from "../../adapter.js";
import { ConnectorError } from "../../errors.js";
import {
  brokerReference,
  credentialScope,
  requireConnection,
  resolveNango,
  type NangoRuntime,
} from "./context.js";
import { NANGO_LIMITS, tagsSchema } from "./schemas.js";

/*
 * NG-03: least-privileged connection inspection. GET /connections/{id} is the
 * one Nango read that is not pure: it returns credentials and refreshes
 * expired tokens as a side effect. This path treats it accordingly: it is
 * internal-only (never mounted on a generic agent route), it runs inside the
 * custody port's single-flight refresh so concurrent callers share one
 * upstream call, it reads only expiry and scheme from the credential block,
 * and the result is rebuilt through a strict allowlist before it returns.
 */

const boundedJson = (
  value: unknown,
  limits = {
    depth: NANGO_LIMITS.metadataDepth,
    nodes: NANGO_LIMITS.metadataNodes,
    stringLength: NANGO_LIMITS.metadataStringLength,
  },
): unknown | undefined => {
  let nodes = 0;
  const walk = (item: unknown, depth: number): unknown => {
    if (depth > limits.depth || ++nodes > limits.nodes) throw new RangeError("bounds");
    if (typeof item === "string") {
      if (item.length > limits.stringLength) throw new RangeError("bounds");
      return item;
    }
    if (item === null || typeof item === "number" || typeof item === "boolean") return item;
    if (Array.isArray(item)) return item.map((entry) => walk(entry, depth + 1));
    if (typeof item === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(item as Record<string, unknown>)) {
        if (["__proto__", "prototype", "constructor"].includes(key))
          throw new RangeError("bounds");
        out[key] = walk(entry, depth + 1);
      }
      return out;
    }
    return undefined;
  };
  try {
    return walk(value, 0);
  } catch {
    return undefined;
  }
};

export const nangoConnectionInspectionSchema = z.strictObject({
  connectionId: z.string(),
  providerConfigKey: z.string(),
  provider: z.string(),
  environment: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastFetchedAt: z.string().optional(),
  tags: tagsSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
  metadataOmitted: z.literal("bounds").optional(),
  errors: z.array(z.strictObject({ type: z.string(), logId: z.string() })),
  credentialType: z.string().optional(),
  credentialExpiresAt: z.string().optional(),
  /** Always true: the documented endpoint refreshes expired tokens on read. */
  refreshMayHaveOccurred: z.literal(true),
  observedAt: z.string(),
});
export type NangoConnectionInspection = z.infer<typeof nangoConnectionInspectionSchema>;

/**
 * Privileged-internal. Agents never reach this: the adapter refuses agent
 * actors outright and the command layer must not mount it on read-only
 * routes. Two concurrent inspections of one connection share one upstream
 * call; the stored broker reference is unchanged and never carries a token.
 */
export async function inspectNangoConnection(
  runtime: NangoRuntime,
  inflight: Map<string, Promise<NangoConnectionInspection>>,
  ctx: AdapterCallContext,
): Promise<NangoConnectionInspection> {
  if (ctx.actor.actorKind === "agent")
    throw new ConnectorError("denied", { detail: "nango.inspect.privileged" });
  const resolved = await resolveNango(runtime, ctx);
  const connection = requireConnection(resolved);
  const reference = brokerReference(resolved);
  if (!connection.credentialRef)
    throw new ConnectorError("invalid-request", { detail: "nango.connection.no-credential" });
  const key = `${ctx.actor.tenantId}\n${connection.connectionRef}\n${connection.credentialRef}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const run = (async () => {
    let inspection: NangoConnectionInspection | undefined;
    await ctx.environment.credentials.refresh(
      credentialScope(ctx, connection),
      connection.credentialRef!,
      async (current) => {
        if (
          current.connectionId !== reference.connectionId ||
          current.providerConfigKey !== reference.providerConfigKey
        )
          throw new ConnectorError("denied", { detail: "nango.credential.mismatch" });
        let full;
        try {
          full = await resolved.client.getConnectionPrivileged(
            reference.connectionId,
            reference.providerConfigKey,
          );
        } catch (error) {
          if (
            error instanceof ConnectorError &&
            error.detail?.startsWith("nango.api.dependency-failed")
          )
            throw new ConnectorError("human-required", {
              detail: "nango.connection.refresh-exhausted",
            });
          throw error;
        }
        if (
          full.connection_id !== reference.connectionId ||
          full.provider_config_key !== reference.providerConfigKey
        )
          throw new ConnectorError("upstream-rejected", { detail: "nango.response.identity" });
        const expiresAt = full.credentials?.expires_at
          ? Date.parse(full.credentials.expires_at)
          : Number.NaN;
        const metadata =
          full.metadata && typeof full.metadata === "object"
            ? boundedJson(full.metadata)
            : undefined;
        inspection = nangoConnectionInspectionSchema.parse({
          connectionId: full.connection_id,
          providerConfigKey: full.provider_config_key,
          provider: full.provider,
          environment: resolved.environment,
          createdAt: full.created_at,
          updatedAt: full.updated_at,
          ...(full.last_fetched_at ? { lastFetchedAt: full.last_fetched_at } : {}),
          tags: full.tags ?? {},
          ...(metadata && typeof metadata === "object" && !Array.isArray(metadata)
            ? { metadata }
            : full.metadata
              ? { metadataOmitted: "bounds" }
              : {}),
          errors: (full.errors ?? []).map((error) => ({ type: error.type, logId: error.log_id })),
          ...(full.credentials?.type ? { credentialType: full.credentials.type } : {}),
          ...(Number.isFinite(expiresAt)
            ? { credentialExpiresAt: new Date(expiresAt).toISOString() }
            : {}),
          refreshMayHaveOccurred: true,
          observedAt: new Date(ctx.environment.now()).toISOString(),
        });
        // The broker reference is the only material this deployment holds;
        // a refresh at Nango rotates nothing here except the known expiry.
        return {
          material: current,
          ...(Number.isFinite(expiresAt) ? { expiresAt } : {}),
        };
      },
    );
    if (!inspection)
      throw new ConnectorError("indeterminate", { detail: "nango.inspect.no-result" });
    return inspection;
  })();
  inflight.set(key, run);
  try {
    return await run;
  } finally {
    inflight.delete(key);
  }
}

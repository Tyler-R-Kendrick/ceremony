import { createHash } from "node:crypto";
import { z } from "zod";
import { AuthorizationError, type ActorContext } from "./identity.js";
import type { AsyncCeremonyStore } from "./persistence/index.js";

/** Shared subject-scoped fixed window; no process-local rate-limit authority. */
export async function reserveRequest(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  limit = 120,
  windowMs = 60000,
): Promise<void> {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    !Number.isSafeInteger(windowMs) ||
    windowMs < 1
  )
    throw new AuthorizationError("invalid_request");
  await store.transaction(async (tx) => {
    const id = createHash("sha256")
      .update(JSON.stringify([actor.tenantId, actor.subjectId]))
      .digest("hex");
    const key = {
      tenant: "identity",
      kind: "budget" as const,
      id: `request:${id}`,
    };
    const record = await tx.get<{ count: number; expires: number }>(key);
    const now = await tx.now();
    const value =
      record && record.value.expires > now
        ? record.value
        : { count: 0, expires: now + windowMs };
    if (value.count >= limit) throw new AuthorizationError("rate_limited");
    await tx.put(
      key,
      { count: value.count + 1, expires: value.expires },
      record?.revision ?? null,
    );
  });
}

export function exactOrigin(value: string, development = false): string {
  const url = new URL(value);
  if (
    url.origin !== value ||
    (url.protocol !== "https:" &&
      !(
        development &&
        url.protocol === "http:" &&
        url.hostname === "127.0.0.1"
      ))
  )
    throw new AuthorizationError("invalid_request");
  return url.origin;
}
export function assertRequestBoundary(
  request: Request,
  options: { origin: string; maxBytes?: number },
): void {
  if (new URL(request.url).origin !== options.origin)
    throw new AuthorizationError("invalid_request");
  if (["GET", "HEAD"].includes(request.method)) return;
  if (
    request.headers.get("origin") !== options.origin ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new AuthorizationError("denied");
  if (
    request.headers.get("content-type")?.split(";")[0]?.trim() !==
    "application/json"
  )
    throw new AuthorizationError("invalid_request");
  const length = request.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d+$/.test(length) || Number(length) > (options.maxBytes ?? 262144))
  )
    throw new AuthorizationError("invalid_request");
}
/** Reads with an actual byte ceiling; Content-Length alone is not trustworthy. */
export async function boundedJson(
  request: Pick<Request, "body">,
  maxBytes = 262144,
): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new AuthorizationError("invalid_request");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new AuthorizationError("invalid_request");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AuthorizationError("invalid_request");
  }
}
const effectSchema = z.strictObject({
  tenantId: z.string().min(1).max(200),
  subjectId: z.string().min(1).max(200),
  runId: z.string().min(1).max(200),
  operationId: z.string().min(1).max(200),
  operationVersion: z.string().min(1).max(80),
  target: z.string().max(500),
  configurationVersion: z.string().min(1).max(200),
  scopes: z.array(z.string().max(100)).max(64),
  argumentsDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type AuthorizedEffect = z.infer<typeof effectSchema>;
export function effectAuthorizationDigest(effect: AuthorizedEffect): string {
  const e = effectSchema.parse(effect);
  return createHash("sha256")
    .update(
      JSON.stringify([
        e.tenantId,
        e.subjectId,
        e.runId,
        e.operationId,
        e.operationVersion,
        e.target,
        e.configurationVersion,
        [...new Set(e.scopes)].sort(),
        e.argumentsDigest,
      ]),
    )
    .digest("hex");
}
export interface EffectGrant {
  tenantId: string;
  subjectId: string;
  digest: string;
  expiresAt: number;
  revoked: boolean;
}
export function authorizeEffect(
  actor: ActorContext,
  effect: AuthorizedEffect,
  grant: EffectGrant,
  now: number,
): void {
  if (
    actor.tenantId !== effect.tenantId ||
    actor.subjectId !== effect.subjectId ||
    grant.tenantId !== actor.tenantId ||
    grant.subjectId !== actor.subjectId ||
    grant.revoked ||
    grant.expiresAt <= now ||
    grant.digest !== effectAuthorizationDigest(effect)
  )
    throw new AuthorizationError("denied");
}

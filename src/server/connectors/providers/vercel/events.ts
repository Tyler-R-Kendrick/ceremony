import { createHash } from "node:crypto";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { z } from "zod";
import { measureJsonValue } from "../../../../core/index.js";
import type { AdapterCallContext, EventPort } from "../../adapter.js";
import { destinationUrl } from "../../binding.js";
import type { VerifiedEventEnvelope } from "../../ports.js";
import {
  permitsTarget,
  vercelConfigurationNames,
  vercelDestinationIds,
  vercelOperationIds,
  vercelOperationRef,
  vercelSettings,
  vercelTargetKinds,
  VERCEL_OIDC_ISSUER,
  VERCEL_OIDC_JWKS_PATH,
} from "./contracts.js";

/*
 * Forwarded triggers. Vercel Connect verifies the provider's own webhook
 * signature at its intake and forwards the event to a registered destination
 * with a Vercel OIDC token as the `Authorization: Bearer` credential (Chat SDK
 * framework page; `@vercel/connect` 2.3.0 `createConnectWebhookVerifier`;
 * `@vercel/oidc` 3.8.8 `verifyVercelOidcToken`). That token is what this port
 * verifies: RS256 against the JWKS of the approved `oidc` destination, issuer
 * pinned to https://oidc.vercel.com, project/environment/owner claims checked
 * against the binding. The token authenticates the forwarder, not the body
 * bytes; the envelope records that limitation. Any header that merely claims
 * the original provider was verified is ignored.
 */

export type ForwarderHop = {
  forwarder: "vercel-connect";
  method: "oidc-bearer";
  issuer: string;
  subject: string;
  keyId?: string;
  verifiedAt: number;
  bodyBound: false;
};
export type VercelForwardedEvent = VerifiedEventEnvelope & {
  forwarderHops: ForwarderHop[];
};

const claimsSchema = z.object({
  iss: z.string(),
  sub: z.string(),
  aud: z.union([z.string(), z.array(z.string())]).optional(),
  iat: z.number().optional(),
  exp: z.number(),
  owner_id: z.string(),
  project_id: z.string(),
  environment: z.string(),
  project: z.string().optional(),
  owner: z.string().optional(),
});

const jwksSchema = z.object({
  keys: z.array(z.record(z.string(), z.unknown())).max(32),
});

const JWKS_TTL_MS = 10 * 60_000;
const BODY_LIMIT = 1_048_576;
const bearerPattern =
  /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;

export function createVercelTriggerEvents(): EventPort {
  const cache = new Map<string, { keys: JSONWebKeySet; fetchedAt: number }>();

  async function fetchJwks(
    ctx: AdapterCallContext,
    force: boolean,
  ): Promise<JSONWebKeySet | undefined> {
    const destination = ctx.binding.destinations.find(
      (item) => item.id === vercelDestinationIds.oidc,
    );
    if (!destination) return undefined;
    const cached = cache.get(destination.origin);
    const now = ctx.environment.now();
    if (!force && cached && now - cached.fetchedAt < JWKS_TTL_MS)
      return cached.keys;
    const url = destinationUrl(destination, VERCEL_OIDC_JWKS_PATH);
    const response = await ctx.environment.fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) return undefined;
    const text = await response.text();
    if (text.length > BODY_LIMIT) return undefined;
    const parsed = jwksSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return undefined;
    const keys = parsed.data as JSONWebKeySet;
    cache.set(destination.origin, { keys, fetchedAt: now });
    return keys;
  }

  return {
    async verify(ctx, delivery) {
      try {
        const settings = vercelSettings(ctx.binding);
        const triggers = settings.triggers;
        if (!triggers) return undefined;
        const header = delivery.headers.get("authorization") ?? "";
        const token = bearerPattern.exec(header.trim())?.[1];
        if (!token) return undefined;
        const teamId = await ctx.environment.configuration.read(
          vercelConfigurationNames.teamId,
        );
        if (
          !teamId ||
          !permitsTarget(ctx.binding, vercelTargetKinds.team, teamId)
        )
          return undefined;
        let verified;
        for (const force of [false, true]) {
          const jwks = await fetchJwks(ctx, force);
          if (!jwks) return undefined;
          try {
            verified = await jwtVerify(token, createLocalJWKSet(jwks), {
              algorithms: ["RS256"],
              clockTolerance: 60,
              currentDate: new Date(ctx.environment.now()),
              ...(triggers.audience ? { audience: triggers.audience } : {}),
            });
            break;
          } catch (error) {
            const code = (error as { code?: string }).code;
            if (code === "ERR_JWKS_NO_MATCHING_KEY" && !force) continue;
            return undefined;
          }
        }
        if (!verified) return undefined;
        const claims = claimsSchema.safeParse(verified.payload);
        if (!claims.success) return undefined;
        const { iss, sub, owner_id, project_id, environment } = claims.data;
        if (
          iss !== VERCEL_OIDC_ISSUER &&
          !iss.startsWith(`${VERCEL_OIDC_ISSUER}/`)
        )
          return undefined;
        if (owner_id !== teamId) return undefined;
        if (!permitsTarget(ctx.binding, vercelTargetKinds.project, project_id))
          return undefined;
        if (
          !triggers.destinations.some((item) => item.projectId === project_id)
        )
          return undefined;
        if (
          !permitsTarget(
            ctx.binding,
            vercelTargetKinds.environment,
            environment,
          )
        )
          return undefined;
        if (delivery.body.byteLength > BODY_LIMIT) return undefined;
        const text = new TextDecoder().decode(delivery.body);
        let payload: unknown = {
          raw: Buffer.from(delivery.body).toString("base64"),
        };
        let providerEventType = "vercel-connect.trigger";
        if (/json/i.test(delivery.headers.get("content-type") ?? "")) {
          try {
            const json: unknown = JSON.parse(text);
            if (!measureJsonValue(json).ok) return undefined;
            payload = json;
            const type =
              typeof json === "object" && json !== null
                ? ((json as { type?: unknown; event?: { type?: unknown } })
                    .type ??
                  (json as { event?: { type?: unknown } }).event?.type)
                : undefined;
            if (typeof type === "string" && /^[\x21-\x7e]{1,120}$/.test(type))
              providerEventType = type;
          } catch {
            return undefined;
          }
        }
        const deliveryId = delivery.headers.get("x-vercel-id");
        const eventId =
          deliveryId && /^[\x21-\x7e]{1,200}$/.test(deliveryId)
            ? `vercel:${deliveryId}`
            : `vercel:${createHash("sha256")
                .update(`${claims.data.iat ?? ""}:${sub}:`)
                .update(delivery.body)
                .digest("hex")}`;
        const envelope: VercelForwardedEvent = {
          eventId,
          authority: `vercel-connect:${owner_id}:${project_id}:${environment}`,
          providerEventType,
          receivedAt: delivery.receivedAt,
          ...(claims.data.iat !== undefined
            ? { sourceTime: claims.data.iat * 1000 }
            : {}),
          verification: {
            method: "forwarder-signature",
            ...(verified.protectedHeader.kid
              ? { keyId: verified.protectedHeader.kid }
              : {}),
          },
          ...(ctx.connection
            ? { connectionRef: ctx.connection.connectionRef }
            : {}),
          payloadClassification: triggers.payloadClassification ?? "personal",
          payload,
          forwarderHops: [
            {
              forwarder: "vercel-connect",
              method: "oidc-bearer",
              issuer: iss,
              subject: sub,
              ...(verified.protectedHeader.kid
                ? { keyId: verified.protectedHeader.kid }
                : {}),
              verifiedAt: delivery.receivedAt,
              bodyBound: false,
            },
          ],
        };
        return envelope;
      } catch {
        return undefined;
      }
    },
  };
}

/** Operation refs the trigger port relates to, for inventories. */
export const vercelTriggerOperationRefs = vercelOperationIds
  .filter((id) => id === "connect.triggers.destinations.replace")
  .map(vercelOperationRef);

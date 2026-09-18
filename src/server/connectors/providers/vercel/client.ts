import type { z } from "zod";
import {
  encodePathSegment,
  nativeIdentifierSchema,
} from "../../../../core/index.js";
import type { AdapterCallContext } from "../../adapter.js";
import { destinationUrl, type ApprovedDestination } from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import {
  connectErrorBodySchema,
  upstreamFailure,
  vercelConnectOperationTable,
  vercelDestinationIds,
  type VercelCredentialRole,
  type VercelOperationId,
} from "./contracts.js";
import { withBearer, type RoleCredential } from "./credentials.js";

/*
 * One way to talk to api.vercel.com. The destination comes from the binding,
 * the path from the operation table, the team from configuration, the bearer
 * from custody. Response bodies are read under a byte ceiling and validated
 * against the documented schema; anything that fails validation or arrives
 * with an error status becomes a sanitized ConnectorError whose detail is a
 * code, never the provider's prose.
 */

export const VERCEL_REQUEST_TIMEOUT_MS = 15_000;
export const VERCEL_RESPONSE_LIMIT_BYTES = 1_048_576;

export type VercelCall<T> = {
  operation: VercelOperationId;
  credential: RoleCredential<VercelCredentialRole>;
  teamId: string;
  params?: Partial<Record<"connector" | "projectId", string>>;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  schema: z.ZodType<T>;
};
export type VercelReply<T> = { status: number; body: T | undefined };

export function apiDestination(ctx: AdapterCallContext): ApprovedDestination {
  const destination = ctx.binding.destinations.find(
    (item) => item.id === vercelDestinationIds.api,
  );
  if (!destination)
    throw new ConnectorError("network-policy", {
      detail: "vercel.destination.api-missing",
    });
  return destination;
}

/** Fills a documented path template, encoding each native identifier exactly once. */
export function operationPath(
  pathTemplate: string,
  params: Partial<Record<string, string>>,
): string {
  return pathTemplate.replace(/\{([a-zA-Z]+)\}/g, (_match, name: string) => {
    const value = params[name];
    const parsed = nativeIdentifierSchema.safeParse(value);
    if (!parsed.success)
      throw new ConnectorError("invalid-request", {
        detail: "vercel.path.parameter-invalid",
      });
    return encodePathSegment(parsed.data);
  });
}

export async function readBounded(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > VERCEL_RESPONSE_LIMIT_BYTES) {
      await reader.cancel();
      throw new ConnectorError("upstream-rejected", {
        detail: "vercel.response.too-large",
      });
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export async function callVercel<T>(
  ctx: AdapterCallContext,
  call: VercelCall<T>,
): Promise<VercelReply<T>> {
  const operation = vercelConnectOperationTable[call.operation];
  if (call.credential.role !== operation.credential)
    throw new ConnectorError("denied", {
      detail: "vercel.credential.role-mismatch",
    });
  const url = destinationUrl(
    apiDestination(ctx),
    operationPath(operation.pathTemplate, call.params ?? {}),
  );
  if (operation.teamQuery) url.searchParams.set("teamId", call.teamId);
  for (const [name, value] of Object.entries(call.query ?? {}))
    if (value !== undefined && value !== "")
      url.searchParams.set(name, String(value));
  const body = call.body === undefined ? undefined : JSON.stringify(call.body);
  const response = await withBearer(
    ctx,
    call.credential,
    operation.credential,
    async (bearer) => {
      const headers = new Headers({
        accept: "application/json",
        authorization: `Bearer ${bearer}`,
      });
      if (body !== undefined) headers.set("content-type", "application/json");
      try {
        return await ctx.environment.fetch(url, {
          method: operation.method,
          headers,
          ...(body === undefined ? {} : { body }),
          redirect: "error",
          signal: AbortSignal.any([
            ctx.signal,
            AbortSignal.timeout(VERCEL_REQUEST_TIMEOUT_MS),
          ]),
        });
      } catch (error) {
        if (ctx.signal.aborted)
          throw new ConnectorError("cancelled", { cause: error });
        throw new ConnectorError("upstream-unavailable", {
          detail: "vercel.network",
          cause: error,
        });
      }
    },
  );
  const text = await readBounded(response);
  if (!response.ok) {
    const parsed = connectErrorBodySchema.safeParse(
      text ? parseJson(text) : undefined,
    );
    throw upstreamFailure(
      response.status,
      parsed.success ? parsed.data.error.code : undefined,
    );
  }
  if (response.status === 204 || text.length === 0)
    return { status: response.status, body: undefined };
  const json = parseJson(text);
  if (json === undefined)
    throw new ConnectorError("upstream-rejected", {
      detail: "vercel.response.not-json",
    });
  const parsed = call.schema.safeParse(json);
  if (!parsed.success)
    throw new ConnectorError("upstream-rejected", {
      detail: "vercel.response.invalid",
    });
  return { status: response.status, body: parsed.data };
}

import type { z } from "zod";
import type { AdapterCallContext } from "../../adapter.js";
import { destinationUrl, type ApprovedDestination } from "../../binding.js";
import { readBoundedBody } from "../../bounded-body.js";
import { neverSent } from "../../auth/wire.js";
import { ConnectorError } from "../../errors.js";
import {
  AWS_REQUEST_TIMEOUT_MS,
  AWS_RESPONSE_LIMIT_BYTES,
  awsDestinationIds,
  awsSettings,
  expectedHost,
  oidcDetail,
  oidcErrorSchema,
} from "./contracts.js";

/*
 * One way to talk to the two AWS hosts. The destination comes from the
 * binding, the Region from reviewed settings, the path from the call site, and
 * a secret (client secret, access token) only from inside a custody callback
 * that hands it here as a header or body field. The reply is read under a byte
 * ceiling and parsed against the documented shape; a provider's words never
 * travel past this file, only a status and, for the OIDC host, the registered
 * `error` code.
 */

export type AwsRole = keyof typeof awsDestinationIds;

export type AwsCall<T> = {
  role: AwsRole;
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | undefined>;
  /** Headers that carry a secret are supplied by the caller from inside custody. */
  headers?: Record<string, string>;
  body?: unknown;
  schema: z.ZodType<T>;
};

export type AwsReply<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; error?: string };

/**
 * The destination a role resolves to. A `public` destination must be exactly
 * the documented host for the reviewed Region over HTTPS with no path prefix,
 * so a binding cannot send the client secret or an access token anywhere
 * else; loopback fixtures and administrator-approved private endpoints are
 * the host's own decision.
 */
export function awsDestination(
  ctx: AdapterCallContext,
  role: AwsRole,
): ApprovedDestination {
  const settings = awsSettings(ctx.binding);
  const destination = ctx.binding.destinations.find(
    (item) => item.id === awsDestinationIds[role],
  );
  if (!destination)
    throw new ConnectorError("network-policy", {
      detail: `aws-identity-center.destination.${role}-missing`,
    });
  if (destination.network === "public") {
    const url = new URL(destination.origin);
    if (
      url.protocol !== "https:" ||
      url.hostname !== expectedHost(role, settings.region) ||
      (destination.pathPrefix !== undefined && destination.pathPrefix !== "/")
    )
      throw new ConnectorError("network-policy", {
        detail: `aws-identity-center.destination.${role}-region`,
      });
  }
  return destination;
}

export function readBounded(response: Response): Promise<string> {
  return readBoundedBody(
    response,
    AWS_RESPONSE_LIMIT_BYTES,
    "aws-identity-center.response.too-large",
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Whether a failure happened before any request bytes could have reached AWS. */
export function sentNothing(error: unknown): boolean {
  return error instanceof ConnectorError && neverSent(error.cause);
}

export async function callAws<T>(
  ctx: AdapterCallContext,
  call: AwsCall<T>,
): Promise<AwsReply<T>> {
  const settings = awsSettings(ctx.binding);
  const url = destinationUrl(awsDestination(ctx, call.role), call.path);
  for (const [name, value] of Object.entries(call.query ?? {}))
    if (value !== undefined && value !== "")
      url.searchParams.set(name, String(value));
  const body = call.body === undefined ? undefined : JSON.stringify(call.body);
  const headers = new Headers({ accept: "application/json" });
  if (body !== undefined) headers.set("content-type", "application/json");
  for (const [name, value] of Object.entries(call.headers ?? {}))
    headers.set(name, value);
  let response: Response;
  try {
    response = await ctx.environment.fetch(url, {
      method: call.method,
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: "error",
      signal: AbortSignal.any([
        ctx.signal,
        AbortSignal.timeout(
          settings.requestTimeoutMs ?? AWS_REQUEST_TIMEOUT_MS,
        ),
      ]),
    });
  } catch (error) {
    if (ctx.signal.aborted)
      throw new ConnectorError("cancelled", { cause: error });
    const timedOut =
      (error as { name?: string } | undefined)?.name === "TimeoutError";
    throw new ConnectorError("upstream-unavailable", {
      detail: timedOut
        ? "aws-identity-center.timeout"
        : "aws-identity-center.network",
      cause: error,
    });
  }
  const text = await readBounded(response);
  if (!response.ok) {
    if (call.role !== "oidc") return { ok: false, status: response.status };
    const parsed = oidcErrorSchema.safeParse(
      text ? parseJson(text) : undefined,
    );
    return {
      ok: false,
      status: response.status,
      ...(parsed.success ? { error: parsed.data.error } : {}),
    };
  }
  const json = text ? parseJson(text) : undefined;
  const parsed = call.schema.safeParse(json);
  if (!parsed.success)
    throw new ConnectorError("upstream-rejected", {
      detail: `aws-identity-center.${call.role}.invalid-response`,
    });
  return { ok: true, status: response.status, body: parsed.data };
}

/** A failed OIDC answer as a connector error: the registered code, never AWS's words. */
export function oidcFailure(
  reply: Extract<AwsReply<unknown>, { ok: false }>,
): ConnectorError {
  if (reply.status >= 500)
    return new ConnectorError("upstream-unavailable", {
      detail: oidcDetail("server_error"),
    });
  return new ConnectorError("upstream-rejected", {
    detail: oidcDetail(reply.error ?? ""),
  });
}

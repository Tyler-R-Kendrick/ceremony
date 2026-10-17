import type { AdapterCallContext } from "../../adapter.js";
import { destinationUrl } from "../../binding.js";
import { readBoundedBytes } from "../../bounded-body.js";
import { MAX_RESPONSE_BYTES } from "../../auth/response-bound.js";
import { ConnectorError } from "../../errors.js";
import { withinDeadline } from "../../request-deadline.js";
import {
  airbyteConfigurationNames,
  airbyteDestinationIds,
  parseBoundedJson,
} from "./contracts.js";
import {
  applicationTokenResponseSchema,
  resolveAirbyteApiBase,
} from "./api.js";

/*
 * How the Airbyte adapter reaches the deployment's API: the approved
 * destination, the bearer (an API key, or a short-lived application token the
 * adapter mints), and one deadline for each request's headers and its whole
 * body, read under a byte ceiling.
 */

export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** A response body as text, refused at the first chunk past `limit` and not after the whole of it was held. */
const readText = async (
  response: Response,
  limit: number,
  detail: string,
  signal: AbortSignal,
) =>
  new TextDecoder().decode(
    await readBoundedBytes(
      response,
      limit,
      () => new ConnectorError("invalid-request", { detail }),
      signal,
    ),
  );

export type CallOptions = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string | string[] | number | boolean | undefined>;
  body?: unknown;
};

export function detailFor(status: number): {
  code: ConnectorError["code"];
  detail: string;
} {
  if (status === 401)
    return {
      code: "unauthenticated",
      detail: "airbyte.upstream.unauthenticated",
    };
  if (status === 403)
    return { code: "denied", detail: "airbyte.upstream.denied" };
  if (status === 404)
    return { code: "not-found", detail: "airbyte.upstream.not-found" };
  if (status === 409)
    return { code: "conflict", detail: "airbyte.upstream.conflict" };
  if (status === 429)
    return { code: "rate-limited", detail: "airbyte.upstream.rate-limited" };
  if (status >= 500)
    return {
      code: "upstream-unavailable",
      detail: "airbyte.upstream.unavailable",
    };
  return { code: "upstream-rejected", detail: "airbyte.upstream.rejected" };
}

/** The adapter's calls to the API, each bounded by `timeoutMs`. */
export function airbyteTransport(timeoutMs: number) {
  const destination = (ctx: AdapterCallContext) => {
    const approved = ctx.binding.destinations.find(
      (item) => item.id === airbyteDestinationIds.api,
    );
    if (!approved)
      throw new ConnectorError("denied", {
        detail: "airbyte.destination.unapproved",
      });
    return approved;
  };

  /**
   * One bounded upstream call. The credential is resolved inside
   * `credentials.use`; the bearer value never leaves that callback, and the
   * response body is parsed under a byte ceiling with reserved keys refused.
   */
  const call = async (
    ctx: AdapterCallContext,
    input: CallOptions,
  ): Promise<{ status: number; body: unknown }> => {
    const approved = destination(ctx);
    const configured = await ctx.environment.configuration.read(
      airbyteConfigurationNames.apiUrl,
    );
    const { basePath } = resolveAirbyteApiBase(configured, approved);
    const url = destinationUrl(approved, `${basePath}${input.path}`);
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value))
        for (const item of value) url.searchParams.append(key, item);
      else url.searchParams.set(key, String(value));
    }
    const token = await accessToken(ctx);
    // One deadline for the headers and the whole body (request-deadline.ts).
    const { status, text } = await withinDeadline(
      ctx.signal,
      timeoutMs,
      (error) =>
        ctx.signal.aborted
          ? new ConnectorError("cancelled", {
              detail: "airbyte.request.cancelled",
            })
          : new ConnectorError("upstream-unavailable", {
              detail: "airbyte.request.failed",
              cause: error,
            }),
      (signal) =>
        ctx.environment.fetch(url, {
          method: input.method,
          redirect: "error",
          signal,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            ...(input.body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(input.body === undefined
            ? {}
            : { body: JSON.stringify(input.body) }),
        }),
      async (response, signal) => ({
        status: response.status,
        text: await readText(
          response,
          MAX_BODY_BYTES,
          "airbyte.response.invalid",
          signal,
        ),
      }),
    );
    const body =
      text.length === 0
        ? undefined
        : parseBoundedJson(text, "airbyte.response.invalid", MAX_BODY_BYTES);
    return { status, body };
  };

  /**
   * The bearer token for one call. When application credentials are
   * configured, the adapter mints a short-lived token through the documented
   * `POST /applications/token`; otherwise the configured API key is used
   * directly. Neither value is returned to any caller.
   */
  const accessToken = async (ctx: AdapterCallContext): Promise<string> => {
    const clientId = await ctx.environment.configuration.read(
      airbyteConfigurationNames.clientId,
    );
    const clientSecret = await ctx.environment.configuration.read(
      airbyteConfigurationNames.clientSecret,
    );
    if (!clientId || !clientSecret) {
      const key = await ctx.environment.configuration.read(
        airbyteConfigurationNames.apiKey,
      );
      if (!key)
        throw new ConnectorError("configuration-required", {
          detail: "airbyte.api-key.missing",
        });
      return key;
    }
    const approved = destination(ctx);
    const configured = await ctx.environment.configuration.read(
      airbyteConfigurationNames.apiUrl,
    );
    const { basePath } = resolveAirbyteApiBase(configured, approved);
    const url = destinationUrl(approved, `${basePath}/applications/token`);
    const text = await withinDeadline(
      ctx.signal,
      timeoutMs,
      (error) =>
        new ConnectorError("upstream-unavailable", {
          detail: "airbyte.token.failed",
          cause: error,
        }),
      (signal) =>
        ctx.environment.fetch(url, {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            "grant-type": "client_credentials",
          }),
        }),
      async (response, signal) => {
        if (!response.ok)
          throw new ConnectorError(detailFor(response.status).code, {
            detail: "airbyte.token.rejected",
          });
        // The token answer carries a credential: it is read under the OAuth ceiling.
        return readText(
          response,
          MAX_RESPONSE_BYTES,
          "airbyte.token.invalid",
          signal,
        );
      },
    );
    const parsed = applicationTokenResponseSchema.safeParse(
      parseBoundedJson(text, "airbyte.token.invalid", MAX_RESPONSE_BYTES),
    );
    if (!parsed.success)
      throw new ConnectorError("upstream-rejected", {
        detail: "airbyte.token.invalid",
      });
    return parsed.data.access_token;
  };
  return { call };
}

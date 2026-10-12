import { createHash, timingSafeEqual } from "node:crypto";
import * as oauth from "oauth4webapi";
import { ConnectorError } from "../errors.js";
import { boundResponse, MAX_RESPONSE_BYTES } from "./response-bound.js";

/*
 * Everything this module sends leaves through the fetch the call context
 * injected, with redirects refused, an abort bound and a ceiling on the size
 * of the answer. oauth4webapi builds the protocol messages; this file only
 * decides how they travel and how a failure is named once it comes back,
 * because a provider's error text is not ours to repeat.
 */

export type WireOptions = {
  fetch: typeof fetch;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  /** The ceiling on one response body; the default is `MAX_RESPONSE_BYTES`. */
  maxResponseBytes?: number | undefined;
  allowLoopbackHttp: boolean;
};

export const DEFAULT_TIMEOUT_MS = 10_000;

export function boundedSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  ...extra: Array<AbortSignal | undefined>
): AbortSignal {
  const signals = [signal, ...extra].filter(
    (item): item is AbortSignal => item !== undefined,
  );
  return AbortSignal.any([...signals, AbortSignal.timeout(timeoutMs)]);
}

/**
 * The fetch oauth4webapi calls: injected transport, no redirects, bounded time
 * and a bounded answer. Every response it reads (token, device authorization,
 * revocation, introspection, registration, pushed authorization) passes the
 * size ceiling here, before the library sees a byte of it.
 */
export function wireFetch(options: WireOptions) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const limitBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  return async <M extends string, B>(
    url: string,
    init: oauth.CustomFetchOptions<M, B>,
  ): Promise<Response> =>
    boundResponse(
      await options.fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body as BodyInit | null | undefined,
        redirect: "error",
        signal: boundedSignal(options.signal, timeoutMs, init.signal),
        ...(init.duplex ? { duplex: init.duplex } : {}),
      } as RequestInit),
      limitBytes,
    );
}

/** Options every oauth4webapi request in this module is made with. */
export function requestOptions(options: WireOptions) {
  return {
    [oauth.customFetch]: wireFetch(options),
    [oauth.allowInsecureRequests]: options.allowLoopbackHttp,
  };
}

/** A digest over length-prefixed parts, so no delimiter can be forged by a part. */
export function sha256Hex(...parts: string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(`${part.length}:`).update(part);
  return hash.digest("hex");
}

/** Constant-time comparison of two strings of any length. */
export function sameSecret(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b) && left.length === right.length;
}

const knownTokenErrors: Record<string, string> = {
  invalid_request: "oauth.token.invalid-request",
  invalid_client: "oauth.token.invalid-client",
  invalid_grant: "oauth.token.invalid-grant",
  unauthorized_client: "oauth.token.unauthorized-client",
  unsupported_grant_type: "oauth.token.unsupported-grant-type",
  invalid_scope: "oauth.token.invalid-scope",
  invalid_target: "oauth.token.invalid-target",
  access_denied: "oauth.token.access-denied",
  authorization_pending: "oauth.token.authorization-pending",
  slow_down: "oauth.token.slow-down",
  expired_token: "oauth.token.expired-token",
  invalid_dpop_proof: "oauth.token.invalid-dpop-proof",
  use_dpop_nonce: "oauth.token.use-dpop-nonce",
};

/** A sanitized name for a provider's token endpoint error; unknown values collapse to one code. */
export function tokenErrorDetail(error: string): string {
  return knownTokenErrors[error] ?? "oauth.token.rejected";
}

/**
 * The cause to keep for a failure raised while reading a token response. For
 * the oauth4webapi errors that may carry the parsed answer (`cause.body`, which
 * for a token response is the whole answer, tokens included) that is the
 * failure's class and code with the library's own fixed message and nothing the
 * response held; a cause prints with its error wherever one is inspected or
 * logged. Any other failure is kept as it is, for the people who debug it.
 */
export function safeCause(failure: unknown): unknown {
  if (
    !(failure instanceof oauth.OperationProcessingError) &&
    !(failure instanceof oauth.UnsupportedOperationError)
  )
    return failure;
  const kept = new Error(failure.message);
  kept.name = failure.name;
  const code = (failure as { code?: unknown }).code;
  if (typeof code === "string") Object.assign(kept, { code });
  return kept;
}

/**
 * Translates transport and protocol failures into connector codes. A response
 * body error names the provider's registered error code only when it is one
 * of the known vocabulary; nothing free-form from the provider survives.
 */
export function wireError(error: unknown, operation: string): ConnectorError {
  if (error instanceof ConnectorError) return error;
  if (error instanceof oauth.ResponseBodyError)
    return new ConnectorError("upstream-rejected", {
      detail: tokenErrorDetail(error.error),
      cause: error,
    });
  if (error instanceof oauth.AuthorizationResponseError)
    return new ConnectorError("denied", {
      detail: tokenErrorDetail(error.error).replace(
        "oauth.token.",
        "oauth.callback.",
      ),
      cause: error,
    });
  if (error instanceof oauth.WWWAuthenticateChallengeError)
    return new ConnectorError("upstream-rejected", {
      detail: `${operation}.challenge`,
      cause: error,
    });
  if (
    error instanceof oauth.OperationProcessingError ||
    error instanceof oauth.UnsupportedOperationError
  )
    return new ConnectorError("upstream-rejected", {
      detail: `${operation}.invalid-response`,
      cause: safeCause(error),
    });
  if (error instanceof DOMException || error instanceof Error) {
    const name = (error as { name?: string }).name;
    if (name === "AbortError")
      return new ConnectorError("cancelled", { cause: error });
    if (name === "TimeoutError")
      return new ConnectorError("upstream-unavailable", {
        detail: `${operation}.timeout`,
        cause: error,
      });
  }
  return new ConnectorError("upstream-unavailable", {
    detail: `${operation}.unreachable`,
    cause: error,
  });
}

/** Whether a failure happened before any request bytes could have reached the provider. */
export function neverSent(error: unknown): boolean {
  if (error instanceof oauth.ResponseBodyError) return false;
  if (error instanceof oauth.OperationProcessingError) return false;
  if (error instanceof oauth.WWWAuthenticateChallengeError) return false;
  const cause = (error as { cause?: { code?: string } } | undefined)?.cause;
  return (
    error instanceof TypeError &&
    typeof cause?.code === "string" &&
    ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(cause.code)
  );
}

export function splitScope(scope: string | undefined): string[] {
  return [
    ...new Set(
      (scope ?? "")
        .split(/\s+/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0 && item.length <= 200),
    ),
  ].slice(0, 64);
}

export function joinScope(scopes: readonly string[]): string {
  return [...new Set(scopes)].join(" ");
}

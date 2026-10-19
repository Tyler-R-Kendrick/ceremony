import { readBoundedBytes } from "../bounded-body.js";
import { ConnectorError } from "../errors.js";

/*
 * The most an OAuth response may weigh. A token endpoint, an issuer's metadata
 * or key set and a revocation endpoint answer with a few kilobytes; the host
 * reads those answers into memory to parse them, so an endpoint that streams
 * without end (or a proxy that mangles one) must not decide how much the host
 * holds. 1 MiB is far above any legitimate answer the repository's doubles or
 * specifications produce (the largest, measured, is in docs/live-auth.md) and
 * far below anything that could hurt. The ceiling is applied once, where every
 * OAuth request leaves the host (`wireFetch`), so no call can forget it.
 */
export const MAX_RESPONSE_BYTES = 1_048_576;

/**
 * Refusal of a response that ran past the ceiling. Its detail is a stable
 * code, it names the ceiling that was crossed, and it holds nothing of the
 * body: the part of the body that was read is dropped with the stream.
 */
export class ResponseTooLargeError extends ConnectorError {
  constructor(readonly limitBytes: number) {
    super("upstream-rejected", { detail: "oauth.response.too-large" });
  }
}

/** Statuses a Response cannot be built with a body for. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * The response, with its body read under the ceiling. A declared length past
 * it is refused without reading anything; a body that does not declare one,
 * or declares less than it sends, is refused as soon as it crosses the
 * ceiling. What comes back is the same answer (status, headers, bytes) as a
 * response that can be read again, so the protocol library reads it as it
 * would have read the original.
 */
export async function boundResponse(
  response: Response,
  limitBytes: number = MAX_RESPONSE_BYTES,
): Promise<Response> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > limitBytes) {
    await response.body?.cancel().catch(() => {});
    throw new ResponseTooLargeError(limitBytes);
  }
  const bytes = await readBoundedBytes(
    response,
    limitBytes,
    () => new ResponseTooLargeError(limitBytes),
  );
  return new Response(NULL_BODY_STATUSES.has(response.status) ? null : bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * The response's body as JSON, read under the ceiling by the same transport
 * (`boundResponse`), for a caller that has a `Response` in hand and not a fetch
 * to wrap. A body over the ceiling is a `ResponseTooLargeError`; one that is not
 * JSON throws as `Response.json` does.
 */
export async function boundedResponseJson(
  response: Response,
  limitBytes: number = MAX_RESPONSE_BYTES,
): Promise<unknown> {
  return (await boundResponse(response, limitBytes)).json();
}

/**
 * What a request whose answer was too large to read came to, for a caller
 * with no error type of its own to say it in: the request was sent, so what
 * it did (a token minted, a client registered, a code spent) is unknown.
 */
export const INDETERMINATE = Object.freeze({
  status: "indeterminate" as const,
});
export type Indeterminate = typeof INDETERMINATE;

/** For `.catch` on `boundedResponseJson` when the request may have changed something: an answer too large to read is `INDETERMINATE`. */
export function unknownIfTooLarge(error: unknown): Indeterminate {
  if (error instanceof ResponseTooLargeError) return INDETERMINATE;
  throw error;
}

/** Whether a failure is, or was caused by, an answer too large to read: the request was sent, so what it did is unknown. */
export function tooLargeAfterSend(error: unknown): boolean {
  for (let depth = 0; error && depth < 5; depth++) {
    if (error instanceof ResponseTooLargeError) return true;
    error = (error as { cause?: unknown }).cause;
  }
  return false;
}

/** For `.catch` on `boundedResponseJson`: an answer too large to read is no answer at all; anything else is the caller's to see. */
export function noAnswerIfTooLarge(error: unknown): undefined {
  if (error instanceof ResponseTooLargeError) return undefined;
  throw error;
}

/** For `.catch` on `boundedResponseJson`: an answer too large to read becomes the caller's own refusal; anything else is the caller's to see. */
export function refuseIfTooLarge(refusal: () => Error) {
  return (error: unknown): never => {
    throw error instanceof ResponseTooLargeError ? refusal() : error;
  };
}

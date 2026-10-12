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

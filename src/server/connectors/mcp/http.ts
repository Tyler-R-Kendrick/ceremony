import type { McpLimits } from "./profiles.js";
import { SseFrame, SseParser, parseBoundedJson } from "./wire.js";

/*
 * The HTTP leg of the Streamable HTTP transport, for both eras. It sends one
 * JSON-RPC message per POST through the fetch the call context supplied,
 * never follows redirects, bounds every body it reads and reports *how* a
 * request failed: a connection that was never established is a different
 * fact from a response that vanished after the request was sent, and the
 * effect journal treats them differently.
 */

export type TransportPhase = "undelivered" | "dropped" | "timeout" | "aborted";

export class TransportError extends Error {
  constructor(
    readonly phase: TransportPhase,
    readonly code: string,
    options: { cause?: unknown } = {},
  ) {
    super(`transport ${phase}: ${code}`, options);
    this.name = "TransportError";
  }
}

export class BoundsError extends Error {
  constructor(
    readonly code:
      | "response-too-large"
      | "stream-too-large"
      | "too-many-frames"
      | "frame-too-large",
  ) {
    super(code);
    this.name = "BoundsError";
  }
}

export type HttpReply =
  | { kind: "json"; status: number; headers: Headers; body: unknown }
  | {
      kind: "stream";
      status: number;
      headers: Headers;
      /** Frames in arrival order; returning early cancels the underlying body. */
      frames: () => AsyncGenerator<SseFrame, void, undefined>;
      /**
       * Releases the body without reading it. A caller that decides on the
       * status alone -- an error status is answered by the status, not by the
       * frames -- must still call this, because nothing else closes the body and
       * an abandoned `text/event-stream` holds its socket open for as long as
       * the server keeps writing.
       */
      cancel: () => Promise<void>;
    }
  | { kind: "empty"; status: number; headers: Headers }
  | { kind: "text"; status: number; headers: Headers; text: string };

export type HttpRequest = {
  url: URL;
  method: "POST" | "GET" | "DELETE";
  headers: Record<string, string>;
  body?: unknown;
  /** Full `Authorization` header value; it lives only for the duration of this call. */
  authorization?: string;
  signal?: AbortSignal;
  timeoutMs: number;
};

const UNDELIVERED_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
]);

function causeCode(error: unknown): string {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return error instanceof Error ? error.name : "unknown";
}

function classifyFailure(
  error: unknown,
  signal: AbortSignal,
  sent: boolean,
): TransportError {
  if (signal.aborted) {
    const reason = signal.reason as { name?: string } | undefined;
    return new TransportError(
      reason?.name === "TimeoutError" ? "timeout" : "aborted",
      reason?.name ?? "AbortError",
      { cause: error },
    );
  }
  const code = causeCode(error);
  if (!sent && UNDELIVERED_CODES.has(code))
    return new TransportError("undelivered", code, { cause: error });
  return new TransportError("dropped", code, { cause: error });
}

function combineSignals(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readBounded(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BoundsError("response-too-large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof BoundsError) throw error;
    throw classifyFailure(error, signal, true);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function mediaType(headers: Headers): string {
  return (headers.get("content-type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
}

/**
 * Performs one HTTP exchange. The reply is classified by status and media
 * type; a `stream` reply hands back a bounded frame generator that the
 * caller consumes and may abandon, which is the transport's cancellation.
 */
export async function exchange(
  fetchImpl: typeof fetch,
  request: HttpRequest,
  limits: Pick<
    McpLimits,
    "maxResponseBytes" | "maxStreamBytes" | "maxStreamFrames" | "maxJsonDepth"
  >,
): Promise<HttpReply> {
  const signal = combineSignals(request.signal, request.timeoutMs);
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    ...request.headers,
  };
  if (request.body !== undefined) headers["content-type"] = "application/json";
  if (request.authorization) headers.authorization = request.authorization;
  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      method: request.method,
      headers,
      ...(request.body !== undefined
        ? { body: JSON.stringify(request.body) }
        : {}),
      redirect: "error",
      signal,
    });
  } catch (error) {
    throw classifyFailure(error, signal, false);
  }
  const type = mediaType(response.headers);
  if (response.status === 202 || response.status === 204) {
    await response.body?.cancel().catch(() => undefined);
    return {
      kind: "empty",
      status: response.status,
      headers: response.headers,
    };
  }
  if (type === "text/event-stream") {
    const body = response.body;
    if (!body)
      return {
        kind: "empty",
        status: response.status,
        headers: response.headers,
      };
    return {
      kind: "stream",
      status: response.status,
      headers: response.headers,
      frames: () => frames(body, limits, signal),
      cancel: async () => {
        // Already-closed and already-cancelled bodies both reject here, and
        // neither is a failure worth reporting: the point was to let go of it.
        await body.cancel().catch(() => {});
      },
    };
  }
  const text = await readBounded(response, limits.maxResponseBytes, signal);
  if (type === "application/json" || (type === "" && text.length)) {
    try {
      return {
        kind: "json",
        status: response.status,
        headers: response.headers,
        body: parseBoundedJson(text, { maxDepth: limits.maxJsonDepth }),
      };
    } catch {
      return {
        kind: "text",
        status: response.status,
        headers: response.headers,
        text,
      };
    }
  }
  if (!text.length)
    return {
      kind: "empty",
      status: response.status,
      headers: response.headers,
    };
  return {
    kind: "text",
    status: response.status,
    headers: response.headers,
    text,
  };
}

async function* frames(
  body: ReadableStream<Uint8Array>,
  limits: Pick<
    McpLimits,
    "maxResponseBytes" | "maxStreamBytes" | "maxStreamFrames"
  >,
  signal: AbortSignal,
): AsyncGenerator<SseFrame, void, undefined> {
  const reader = body.getReader();
  const parser = new SseParser();
  let count = 0;
  const check = (frame: SseFrame): SseFrame => {
    if (++count > limits.maxStreamFrames)
      throw new BoundsError("too-many-frames");
    if (Buffer.byteLength(frame.data, "utf8") > limits.maxResponseBytes)
      throw new BoundsError("frame-too-large");
    return frame;
  };
  try {
    for (;;) {
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await reader.read();
      } catch (error) {
        throw classifyFailure(error, signal, true);
      }
      if (step.done) break;
      if (parser.bytes + step.value.byteLength > limits.maxStreamBytes)
        throw new BoundsError("stream-too-large");
      for (const frame of parser.push(step.value)) yield check(frame);
    }
    for (const frame of parser.finish()) yield check(frame);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

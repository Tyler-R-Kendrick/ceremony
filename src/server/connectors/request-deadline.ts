import { ConnectorError } from "./errors.js";

/*
 * One deadline for a request: its answer's headers and its whole body. A
 * timer cleared as soon as the headers arrive leaves the body to come as
 * slowly as the provider likes, and a body that trickles in a byte at a time
 * stays under any size ceiling while it holds the caller for as long as it
 * keeps trickling. So the deadline (and the caller's own signal) is kept in
 * force until the body has been read, and the body is read under the
 * deadline's signal (`readBoundedBytes`' last argument).
 */

/**
 * Sends a request and reads its answer under one deadline of `timeoutMs`,
 * ended early by `caller`. `send` gets the signal to send with; `read` gets
 * the answer and the same signal, and must read the body under it. A request
 * that was not answered, or whose body the deadline or the caller cut short,
 * is `unanswered(error)`: the error the reader already gives a request that
 * got no answer in time (it can tell the two apart by `caller.aborted`). A
 * `ConnectorError` that `read` raises itself (a refusal, a body over its
 * ceiling) is kept as it is.
 */
export async function withinDeadline<T>(
  caller: AbortSignal,
  timeoutMs: number,
  unanswered: (error: unknown) => Error,
  send: (signal: AbortSignal) => Promise<Response>,
  read: (response: Response, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (caller.aborted) abort();
  caller.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  try {
    let response: Response;
    try {
      response = await send(controller.signal);
    } catch (error) {
      throw unanswered(error);
    }
    try {
      return await read(response, controller.signal);
    } catch (error) {
      throw controller.signal.aborted && !(error instanceof ConnectorError)
        ? unanswered(error)
        : error;
    }
  } finally {
    clearTimeout(timer);
    caller.removeEventListener("abort", abort);
  }
}

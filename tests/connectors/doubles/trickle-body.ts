import { setTimeout as sleep } from "node:timers/promises";

/*
 * A provider that answers at once and then sends its body a byte at a time,
 * one byte every `TRICKLE_MS`, for far longer than any request deadline here:
 * what a deadline on the body (not only on the headers) is measured against.
 * Like a server that ignores the client going away, it stops only when the
 * reader cancels the body, which `seen.cancelled` records; `seen.sent` is how
 * many bytes it had sent by then. A read that waited for the end would take
 * `TRICKLE_BYTES * TRICKLE_MS` (10 s) and see `seen.ended`.
 */

export const TRICKLE_MS = 50;
export const TRICKLE_BYTES = 200;

export type Trickled = { sent: number; cancelled: boolean; ended: boolean };

export const trickled = (): Trickled => ({
  sent: 0,
  cancelled: false,
  ended: false,
});

export function trickleFetch(seen: Trickled, status = 200): typeof fetch {
  return (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (seen.cancelled) return;
          if (seen.sent >= TRICKLE_BYTES) {
            seen.ended = true;
            return controller.close();
          }
          await sleep(TRICKLE_MS);
          if (seen.cancelled) return;
          seen.sent++;
          controller.enqueue(new Uint8Array([0x20]));
        },
        cancel() {
          seen.cancelled = true;
        },
      }),
      { status, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
}

/**
 * Runs `call` against a deadline of `deadlineMs` and says how long it took
 * and how it ended. A body cut at its deadline ends well before the trickle
 * would (`TRICKLE_BYTES * TRICKLE_MS`), with the stream cancelled.
 */
export async function timed<T>(
  call: () => Promise<T>,
): Promise<{ ms: number; error: unknown }> {
  const started = performance.now();
  let error: unknown;
  try {
    await call();
  } catch (caught) {
    error = caught;
  }
  return { ms: performance.now() - started, error };
}

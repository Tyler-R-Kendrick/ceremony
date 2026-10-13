/*
 * A provider that answers every request with spaces and never stops: what a
 * ceiling on a response body is measured against. `seen.pulled` is what the
 * reader took from the stream, so a read that waited for the end would show
 * the whole of `ENDLESS` and one that stops at its ceiling shows the ceiling
 * and the chunk that crossed it.
 */

export const CHUNK = 64 * 1024;
export const ENDLESS = 64 * 1024 * 1024;
export const SLACK = 2 * CHUNK;

export type Pulled = { pulled: number };

export function endlessFetch(seen: Pulled, status = 200): typeof fetch {
  const chunk = new Uint8Array(CHUNK).fill(0x20);
  return (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (seen.pulled >= ENDLESS) return controller.close();
          seen.pulled += CHUNK;
          controller.enqueue(chunk);
        },
      }),
      { status, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
}

/** Fails when the stream was never served, or was read past `ceiling` by more than a chunk or two. */
export function assertReadUnder(
  assert: typeof import("node:assert/strict"),
  seen: Pulled,
  ceiling: number,
  what: string,
) {
  assert.ok(seen.pulled > 0, `${what}: the endless answer was in fact served`);
  assert.ok(
    seen.pulled <= ceiling + SLACK,
    `${what}: read ${seen.pulled} bytes of an answer; the ceiling is ${ceiling}`,
  );
}

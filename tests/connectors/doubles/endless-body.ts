/*
 * A provider that answers with spaces and never stops: what a ceiling on a
 * response body is measured against. `seen.pulled` is what the reader took
 * from the stream, so a read that waited for the end would show the whole of
 * `ENDLESS` and one that stops at its ceiling shows the ceiling and the chunk
 * that crossed it.
 *
 * Every way of serving one names the bounded sites it is served to, as the
 * fetch gate names them (`file#function`, the function around the call that
 * fixes the ceiling): the gate requires every site whose ceiling it accepts
 * to be named by at least one test that serves it an endless body here
 * (tests/connectors/auth/fetch-gate-pairing.ts), so a bounded read without
 * one fails the gate.
 */

export const CHUNK = 64 * 1024;
export const ENDLESS = 64 * 1024 * 1024;
export const SLACK = 2 * CHUNK;

export type Pulled = { pulled: number };
/**
 * The bounded sites, `file#function`, this endless body is served to; empty
 * for a read the gate does not list as a site (the transport's own).
 */
export type Sites = readonly string[];

const sitePattern = /^[\w./[\]-]+#[\w$]+$/;

function named(sites: Sites): void {
  for (const site of sites)
    if (!sitePattern.test(site))
      throw new Error(`not a bounded site name: ${site}`);
}

/** A body of spaces without end; `seen.pulled` counts what was taken from it. */
export function endlessBody(
  seen: Pulled,
  sites: Sites,
): ReadableStream<Uint8Array> {
  named(sites);
  const chunk = new Uint8Array(CHUNK).fill(0x20);
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (seen.pulled >= ENDLESS) return controller.close();
      seen.pulled += CHUNK;
      controller.enqueue(chunk);
    },
  });
}

/** An answer whose body never ends. */
export function endlessResponse(
  seen: Pulled,
  sites: Sites,
  init: ResponseInit = {},
): Response {
  return new Response(endlessBody(seen, sites), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

/** A fetch whose every answer never ends. */
export function endlessFetch(
  seen: Pulled,
  sites: Sites,
  status = 200,
): typeof fetch {
  named(sites);
  return (async () =>
    endlessResponse(seen, sites, {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
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

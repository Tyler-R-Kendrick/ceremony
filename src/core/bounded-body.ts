/**
 * A response body read under a byte ceiling. A body that runs past it is
 * cancelled and refused rather than buffered: a provider's reply is not
 * allowed to decide how much memory the host spends on it. `refuse` names the
 * refusal; it is raised at the first chunk that crosses the ceiling, so what
 * is held is never more than the ceiling plus that one chunk.
 *
 * `signal`, when given, bounds the read in time as well: once it aborts the
 * body is cancelled and the read rejects with the signal's reason, whether or
 * not the provider is still sending, and whether or not the stream settles the
 * read it was in the middle of when it is cancelled. A caller passes the
 * signal of the request the body belongs to, so one deadline covers the
 * headers and the whole body, and a body that trickles in cannot hold the
 * caller past it.
 *
 * This is the one place a body is read under a ceiling: the connectors'
 * `readBoundedBody`, the OAuth transport's `boundResponse` and the key
 * directory a gate fetches all build on it.
 */
export async function readBoundedBytes(
  response: Response,
  limitBytes: number,
  refuse: () => Error,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  // No wait here is on the stream: a read that never settles, and a cancel
  // that never finishes, cost the deadline nothing. The abort rejects a race
  // against the pending read; every cancel is started and not waited for.
  const leave = (reason?: unknown) =>
    void reader.cancel(reason).catch(() => {});
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      leave(signal?.reason);
      reject(signal?.reason);
    };
  });
  aborted.catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      signal?.throwIfAborted();
      const pending = reader.read();
      pending.catch(() => {});
      const { done, value } = signal
        ? await Promise.race([pending, aborted])
        : await pending;
      signal?.throwIfAborted();
      if (done) break;
      received += value.byteLength;
      if (received > limitBytes) {
        leave();
        throw refuse();
      }
      chunks.push(value);
    }
    return new Uint8Array(Buffer.concat(chunks));
  } catch (error) {
    leave();
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

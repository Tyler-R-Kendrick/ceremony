/**
 * A response body read under a byte ceiling. A body that runs past it is
 * cancelled and refused rather than buffered: a provider's reply is not
 * allowed to decide how much memory the host spends on it. `refuse` names the
 * refusal; it is raised at the first chunk that crosses the ceiling, so what
 * is held is never more than the ceiling plus that one chunk.
 *
 * This is the one place a body is read under a ceiling: the connectors'
 * `readBoundedBody`, the OAuth transport's `boundResponse` and the key
 * directory a gate fetches all build on it.
 */
export async function readBoundedBytes(
  response: Response,
  limitBytes: number,
  refuse: () => Error,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limitBytes) {
      await reader.cancel().catch(() => {});
      throw refuse();
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

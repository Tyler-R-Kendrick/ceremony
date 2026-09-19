import { ConnectorError } from "../errors.js";

/*
 * One bounded body read, shared by every registry reader.
 *
 * A ceiling checked after `await response.arrayBuffer()` is decoration: the
 * allocation it exists to prevent has already happened by the time the check
 * runs. The `content-length` pre-check does not save it either, because a
 * registry that answers chunked declares no length at all, so the pre-check
 * sees nothing to refuse and waves the reply through. An untrusted registry
 * therefore chooses how much of this process's memory it spends, which is the
 * one thing the bound was written to deny.
 *
 * So the bound is enforced while the body arrives — a running total, and the
 * reader cancelled the moment the total passes the ceiling — and the declared
 * length is treated as an early refusal only, never as the measurement.
 *
 * The ceiling and the reported `detail` are parameters because each registry
 * keeps its own failure vocabulary, and a detail code is part of that
 * registry's contract with the host that reads it. Everything else is
 * identical, and identical checks copied into four files are how a check
 * quietly drifts: the fix lands in the copy that was noticed and stays absent
 * from the ones that were not.
 */

/**
 * Reads a response body into memory under a hard byte ceiling, refusing while
 * the body streams rather than after it is buffered. Every refusal cancels the
 * body, so a server that keeps writing is disconnected instead of being left
 * an open socket. Decoding stays with the caller: one reader wants strict
 * UTF-8 and JSON, another wants lossy text, and that difference is theirs.
 */
export async function readBoundedBytes(
  response: Response,
  maxBytes: number,
  detail: string,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new ConnectorError("upstream-rejected", { detail });
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ConnectorError("upstream-rejected", { detail });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

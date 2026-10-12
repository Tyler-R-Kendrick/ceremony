import { ConnectorError } from "./errors.js";

/**
 * A response body read under a byte ceiling. A body that runs past it is
 * cancelled and refused rather than buffered: a provider's reply is not
 * allowed to decide how much memory the host spends on it.
 */
export async function readBoundedBody(
  response: Response,
  limitBytes: number,
  detail: string,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limitBytes) {
      await reader.cancel();
      throw new ConnectorError("upstream-rejected", { detail });
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

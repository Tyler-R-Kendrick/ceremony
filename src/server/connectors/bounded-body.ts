import { readBoundedBytes } from "../../core/bounded-body.js";
import { ConnectorError } from "./errors.js";

export { readBoundedBytes };

/** The same ceiling for a body read as text, refused as an `upstream-rejected` with `detail`. */
export async function readBoundedBody(
  response: Response,
  limitBytes: number,
  detail: string,
): Promise<string> {
  return new TextDecoder().decode(
    await readBoundedBytes(
      response,
      limitBytes,
      () => new ConnectorError("upstream-rejected", { detail }),
    ),
  );
}

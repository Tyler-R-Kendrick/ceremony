import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { AWS_RESPONSE_LIMIT_BYTES } from "../../../src/server/connectors/providers/aws-identity-center/contracts.js";
import {
  AWS_RESPONSE_TOO_LARGE,
  readBounded,
} from "../../../src/server/connectors/providers/aws-identity-center/client.js";
import {
  assertReadUnder,
  endlessResponse,
  type Pulled,
} from "../doubles/endless-body.js";

/*
 * Every AWS answer (the OIDC API's and the portal's) is read through
 * `readBounded`, under 1 MiB. An answer that never ends is cut off there,
 * with the error the module already gives an answer over the ceiling.
 */

test("an AWS answer that never ends is cut off at the byte ceiling", async () => {
  const seen: Pulled = { pulled: 0 };
  await assert.rejects(
    readBounded(
      endlessResponse(seen, [
        "src/server/connectors/providers/aws-identity-center/client.ts#readBounded",
      ]),
    ),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === AWS_RESPONSE_TOO_LARGE,
  );
  assertReadUnder(assert, seen, AWS_RESPONSE_LIMIT_BYTES, "an AWS answer");
});

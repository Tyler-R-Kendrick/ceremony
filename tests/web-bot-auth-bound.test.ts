import assert from "node:assert/strict";
import test from "node:test";
import {
  createSignatureAgent,
  verifyRequestSignature,
} from "../src/core/web-bot-auth.js";
import { MAX_RESPONSE_BYTES } from "../src/server/connectors/auth/response-bound.js";
import {
  assertReadUnder,
  endlessFetch,
  type Pulled,
} from "./connectors/doubles/endless-body.js";

/*
 * A gate fetches the agent's key directory from an address the request itself
 * names, so whoever signs a request chooses what the gate reads. The directory
 * is a key set: read under the same ceiling as any other OAuth answer, so a
 * directory that never ends is "no directory", not a body held in memory.
 */

test("a key directory that never ends is cut off at the ceiling and reads as no directory", async () => {
  const agent = createSignatureAgent("https://agent.example");
  const seen: Pulled = { pulled: 0 };
  const endless = endlessFetch(seen, [
    "src/core/web-bot-auth.ts#verifyRequestSignature",
  ]);

  const verdict = await verifyRequestSignature(
    agent.headers("https://provider.example/signin"),
    "provider.example",
    { fetchDirectory: endless },
  );

  assert.deepEqual(verdict, { ok: false, why: "no-directory" });
  assertReadUnder(assert, seen, MAX_RESPONSE_BYTES, "a key directory");
});

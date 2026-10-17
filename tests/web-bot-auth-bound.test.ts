import assert from "node:assert/strict";
import test from "node:test";
import {
  createSignatureAgent,
  verifyRequestSignature,
} from "../src/core/web-bot-auth.js";

/*
 * A gate fetches the agent's key directory from an address the request itself
 * names, so whoever signs a request chooses what the gate reads. The directory
 * is a key set: read under the same ceiling as any other OAuth answer, so a
 * directory that never ends is "no directory", not a body held in memory.
 */

const CHUNK = 64 * 1024;
const ENDLESS = 64 * 1024 * 1024;
const MAX = 1_048_576;

test("a key directory that never ends is cut off at the ceiling and reads as no directory", async () => {
  const agent = createSignatureAgent("https://agent.example");
  let pulled = 0;
  const chunk = new Uint8Array(CHUNK).fill(0x20);
  const endless = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulled >= ENDLESS) return controller.close();
          pulled += CHUNK;
          controller.enqueue(chunk);
        },
      }),
      { status: 200 },
    )) as unknown as typeof fetch;

  const verdict = await verifyRequestSignature(
    agent.headers("https://provider.example/signin"),
    "provider.example",
    { fetchDirectory: endless },
  );

  assert.deepEqual(verdict, { ok: false, why: "no-directory" });
  assert.ok(pulled > 0, "the endless directory was in fact served");
  assert.ok(
    pulled <= MAX + 2 * CHUNK,
    `read ${pulled} bytes of a key directory; the ceiling is ${MAX}`,
  );
});

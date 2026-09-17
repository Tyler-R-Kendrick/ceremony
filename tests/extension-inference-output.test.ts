import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const identifier = "11111111-1111-4111-8111-111111111111";
const submit = "22222222-2222-4222-8222-222222222222";
const form = "33333333-3333-4333-8333-333333333333";
const page = {
  document: form,
  origin: "https://fixture.test",
  challenge: false,
  controls: [
    {
      ref: identifier,
      kind: "unknown",
      label: "Account",
      form,
      recipient: "https://fixture.test/login",
    },
    {
      ref: submit,
      kind: "submit",
      label: "Login",
      form,
      recipient: "https://fixture.test/login",
    },
  ],
};
const mapping = { identifier, submit };
const text = JSON.stringify(mapping);
const bundled = await build({
  entryPoints: [
    new URL("../extensions/browser-login/inference.worker.ts", import.meta.url)
      .pathname,
  ],
  bundle: true,
  packages: "external",
  format: "cjs",
  platform: "node",
  write: false,
  logLevel: "silent",
});
const require = createRequire(import.meta.url);

for (const [name, generated, expected] of [
  ["plain text", text, mapping],
  [
    "final assistant chat text",
    [
      { role: "user", content: "untrusted prompt" },
      { role: "assistant", content: "earlier answer" },
      { role: "assistant", content: text },
    ],
    mapping,
  ],
  ["user-only chat", [{ role: "user", content: text }], undefined],
  [
    "non-text final assistant",
    [
      { role: "assistant", content: text },
      { role: "assistant", content: {} },
    ],
    undefined,
  ],
  ["empty output", undefined, undefined],
] as const) {
  test(`inference worker handles ${name}`, async () => {
    let reply: { step: { mapping: unknown } | null } | undefined;
    const self = {
      onmessage: undefined as unknown as (event: {
        data: unknown;
      }) => Promise<void>,
      postMessage(value: typeof reply) {
        reply = value;
      },
    };
    runInNewContext(bundled.outputFiles[0]!.text, {
      require: (id: string) =>
        id === "@huggingface/transformers"
          ? {
              env: { backends: { onnx: {} } },
              pipeline: async () => async () => [{ generated_text: generated }],
            }
          : require(id),
      self,
      AbortSignal,
      URL,
    });
    await self.onmessage({ data: page });
    assert.deepEqual(reply?.step?.mapping, expected);
    assert.ok(reply && "step" in reply);
  });
}

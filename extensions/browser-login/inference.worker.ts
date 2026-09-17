import { env, pipeline } from "@huggingface/transformers";
import {
  inferMapping,
  localTextModel,
} from "../../src/browser-login/inference.js";
import { observationSchema } from "../../src/browser-login/templates.js";

env.allowLocalModels = false;
env.allowRemoteModels = true;
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.wasmPaths = new URL("wasm/", import.meta.url).href;
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.proxy = false;
}
let generator: ReturnType<typeof pipeline<"text-generation">> | undefined;
let busy = false;
self.onmessage = async ({ data }: MessageEvent<unknown>) => {
  if (busy) return;
  busy = true;
  try {
    const page = observationSchema.parse(data);
    generator ??= pipeline(
      "text-generation",
      "onnx-community/SmolLM2-135M-Instruct",
      { dtype: "q4", device: "wasm" },
    );
    const engine = await generator;
    const model = localTextModel(async (prompt, signal) => {
      signal?.throwIfAborted();
      const output = await engine([{ role: "user", content: prompt }], {
        max_new_tokens: 160,
        do_sample: false,
        return_full_text: false,
      });
      signal?.throwIfAborted();
      const text = output[0]?.generated_text;
      return typeof text === "string" ? text : "";
    });
    const step = await inferMapping(model, page, AbortSignal.timeout(60_000));
    self.postMessage({ step: step ?? null });
  } catch {
    self.postMessage({
      error:
        "Local model unavailable or unable to map this form. No submission occurred.",
    });
  } finally {
    busy = false;
  }
};

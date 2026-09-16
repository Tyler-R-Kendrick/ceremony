import { cp } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineNitroConfig } from "nitro/config";
export default defineNitroConfig({
  modules: [
    "workflow/nitro",
    (nitro) => {
      if (nitro.options.dev || nitro.options.preset !== "vercel") return;
      // Workflow emits a separate step function without Nitro dependency tracing.
      nitro.hooks.hook("compiled", async () => {
        await cp(
          dirname(
            createRequire(import.meta.url).resolve(
              "playwright-core/package.json",
            ),
          ),
          join(
            nitro.options.rootDir,
            ".vercel/output/functions/.well-known/workflow/v1/step.func/node_modules/playwright-core",
          ),
          { recursive: true, dereference: true },
        );
      });
    },
  ],
  traceDeps: ["playwright-core*"],
  // Never discover workflows in compiled output or mutation-test sandboxes.
  workflow: { dirs: ["src"], runtime: "nodejs24.x" },
  serverDir: "./hosted",
  publicAssets: [{ dir: "./web-dist", maxAge: 0 }],
  vercel: { entryFormat: "node" },
});

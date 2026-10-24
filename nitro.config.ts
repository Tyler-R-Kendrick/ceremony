import { defineNitroConfig } from "nitro/config";
export default defineNitroConfig({
  // Workflow 5 bundles its flow and webhook routes into Nitro itself, so each
  // Vercel function, the flow function that runs the steps included, gets its
  // dependencies from Nitro's own tracing below.
  modules: ["workflow/nitro"],
  traceDeps: ["playwright-core*"],
  // Never discover workflows in compiled output or mutation-test sandboxes.
  workflow: { dirs: ["src"], runtime: "nodejs24.x" },
  serverDir: "./hosted",
  publicAssets: [{ dir: "./web-dist", maxAge: 0 }],
  vercel: { entryFormat: "node" },
});

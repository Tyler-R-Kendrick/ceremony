import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^ci-info$/,
        replacement: fileURLToPath(
          new URL("./examples/web/ci-info.ts", import.meta.url),
        ),
      },
    ],
  },
  root: "examples/web",
  // Mutation sandboxes share node_modules, not their application's cache.
  cacheDir: ".vite",
  plugins: [
    {
      name: "exclude-development-overlay",
      apply: "build",
      transformIndexHtml: {
        order: "pre",
        handler: (html) =>
          html.replace(
            /<!-- impeccable-live-start -->[\s\S]*?<!-- impeccable-live-end -->/g,
            "",
          ),
      },
    },
  ],
  build: { outDir: "../../web-dist", emptyOutDir: true },
});

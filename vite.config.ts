import { defineConfig } from "vite";
export default defineConfig({
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

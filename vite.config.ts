import { defineConfig } from "vite";
export default defineConfig({
  root: "examples/web",
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

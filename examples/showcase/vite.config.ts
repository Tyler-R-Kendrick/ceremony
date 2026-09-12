import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Published to a nested path, so every emitted asset is referenced relatively.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  build: {
    outDir: fileURLToPath(new URL("../../artifacts/showcase", import.meta.url)),
    emptyOutDir: true,
  },
});

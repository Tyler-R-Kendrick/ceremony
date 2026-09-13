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

/*
 * No dev proxy, deliberately.
 *
 * The connections on this page are real, so they cross assertRequestBoundary,
 * which requires the request's Origin to equal the server's own — one origin,
 * no allowlist. A proxy could forge that header and the page would appear to
 * work, but the thing it would be demonstrating is a CSRF control being
 * defeated. This page has to be served by the connection server itself, at the
 * server's origin. Building it into the reference app's own output is the
 * remaining step; until then it runs against a server on the same origin only.
 */

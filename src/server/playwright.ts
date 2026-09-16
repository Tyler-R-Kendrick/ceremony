import { createRequire } from "node:module";

// Playwright needs its package layout and runtime assets, not a flattened bundle.
export const { chromium }: typeof import("playwright-core") = createRequire(
  import.meta.url,
)("playwright-core");

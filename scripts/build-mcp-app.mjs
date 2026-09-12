import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "vite";

/**
 * Builds the private collector into one self-contained HTML document.
 *
 * The MCP App resource is inline HTML — there is no form that references a
 * URL — so the whole collector has to exist as a string the server can hand to
 * the client. It is a build artifact rather than a checked-in module because it
 * is ~237 kB: committing it would put a quarter-megabyte diff in front of a
 * reviewer every time a dependency moves.
 *
 * Vite is used deliberately. esbuild would do the job and is present in
 * node_modules, but only as a transitive dependency of vite; depending on it
 * directly would be depending on something this project never declared.
 */

const root = new URL("../", import.meta.url);
const outDir = new URL("artifacts/mcp-app/", root);
// Vite empties its own output directory, so the bundle goes in a subdirectory
// of its own. Sharing one would delete the document before comparing to it —
// which it did, and the drift check could never pass.
const bundleDir = new URL("bundle/", outDir);
const document_ = new URL("collector.html", outDir);

async function bundle() {
  const result = await build({
    root: fileURLToPath(root),
    logLevel: "error",
    configFile: false,
    build: {
      lib: {
        entry: fileURLToPath(new URL("src/mcp-app/entry.ts", root)),
        formats: ["iife"],
        name: "CeremonyPrivateCollector",
        fileName: () => "collector.js",
      },
      outDir: fileURLToPath(bundleDir),
      emptyOutDir: true,
      minify: "esbuild",
    },
  });
  const outputs = Array.isArray(result) ? result : [result];
  for (const item of outputs)
    for (const chunk of "output" in item ? item.output : [])
      if (chunk.type === "chunk" && chunk.isEntry) return chunk.code;
  throw new Error("The collector bundle produced no entry chunk");
}

/**
 * The script is inlined rather than referenced, because the client renders this
 * document on its own origin with no way to fetch a sibling file from ours.
 */
function page(script) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Private credential entry</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
      body { margin: 0; padding: 16px; }
      label { display: block; margin-block: 12px; font-size: 14px; }
      input { display: block; width: 100%; margin-block-start: 4px; padding: 8px; box-sizing: border-box; }
      button { margin-block-start: 12px; padding: 8px 16px; font: inherit; }
    </style>
  </head>
  <body>
    <div id="collector"></div>
    <script>${script}</script>
  </body>
</html>
`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && args[0] !== "--check"))
    throw new Error("Use build-mcp-app.mjs [--check]; default writes");
  const expected = page(await bundle());
  if (args[0] === "--check") {
    const actual = await readFile(document_, "utf8").catch(() => "");
    if (actual !== expected)
      throw new Error(
        "The built collector is stale. Run `npm run build:mcp-app`.",
      );
  } else {
    await mkdir(outDir, { recursive: true });
    await writeFile(document_, expected);
  }
  process.stdout.write(
    `Collector ${args[0] === "--check" ? "verified" : "written"}: ${Math.round(expected.length / 1024)} kB at ${fileURLToPath(document_)}\n`,
  );
}

await main();

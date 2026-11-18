// Start the kernel harness and let Bombadil explore it.
//   node --import tsx scripts/kernel-bombadil.mjs [time-limit, default 45s]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.PORT ?? 4180);
const limit = process.argv[2] ?? "45s";
const out = `${root}artifacts/bombadil`;
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const { start } = await import("../examples/kernel/server.ts");
const server = await start(port);

const binary = `${root}node_modules/.bin/bombadil`;
if (!existsSync(binary)) {
  console.error("bombadil is not installed; run npm ci");
  process.exit(1);
}
const child = spawn(
  binary,
  [
    "browser",
    "test",
    "--headless",
    "--no-sandbox",
    "--exit-on-violation",
    "--time-limit",
    limit,
    "--width",
    "390",
    "--height",
    "844",
    "--output-path",
    out,
    "--output-path-overwrite",
    `http://127.0.0.1:${port}/`,
    `${root}examples/kernel/properties.ts`,
  ],
  { stdio: "inherit", cwd: root },
);
child.on("exit", (code) => {
  server.close();
  // 0: finished, nothing violated. 2: a property was violated. 1: other error.
  process.exit(code ?? 1);
});

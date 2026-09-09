import { lstat, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const outputs = [
  "dist",
  "web-dist",
  ".output",
  ".nitro",
  ".swc",
  ".workflow-vitest",
];

export async function cleanBuildOutputs(root, apply = false) {
  const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  if (pkg.name !== "@ceremony/auth") throw new Error("Wrong project root");
  const present = [];
  // Inspect the whole fixed set before removing anything. Never follow links.
  for (const name of outputs) {
    const stat = await lstat(resolve(root, name)).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) continue;
    if (!stat.isDirectory())
      throw new Error("Unexpected build output kind refused");
    present.push(name);
  }
  if (apply)
    for (const name of present)
      await rm(resolve(root, name), { recursive: true, force: true });
  return present;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== "--apply"))
      throw new Error("Unknown cleanup argument");
    const apply = args[0] === "--apply";
    const names = await cleanBuildOutputs(
      fileURLToPath(new URL("../", import.meta.url)),
      apply,
    );
    console.log(
      `${apply ? "Removed" : "Would remove"}: ${names.join(", ") || "nothing"}`,
    );
    if (!apply)
      console.log(
        "Preview only. Stop builds/hosted servers before clean:apply. State and evidence are excluded.",
      );
  } catch {
    console.error(
      "Cleanup refused or failed. Check the project root, output types and permissions; state is never in scope.",
    );
    process.exitCode = 1;
  }
}

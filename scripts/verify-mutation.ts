import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

/** Stream only known filenames and phase/status metadata, never child diagnostics. */
export async function mutationProgress(
  command: string,
  args: string[],
  inventory: readonly string[],
  emit: (record: Record<string, string | number | null>) => void,
) {
  const started = performance.now();
  let initial = true;
  const record = (value: Record<string, string | number | null>) =>
    emit({ elapsedMs: Math.round(performance.now() - started), ...value });
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let interruptionCode: number | undefined;
  const interrupt = (signal: "SIGINT" | "SIGTERM") => {
    interruptionCode ??= signal === "SIGINT" ? 130 : 143;
    child.kill(signal);
  };
  const onInterrupt = () => interrupt("SIGINT");
  const onTerminate = () => interrupt("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  const consume = async (input: NodeJS.ReadableStream) => {
    for await (const raw of createInterface({ input })) {
      const line = stripVTControlCharacters(raw);
      if (/\bERROR DryRunExecutor Initial test run timed out!/.test(line))
        record({ phase: "initial-timeout" });
      if (/\bINFO DryRunExecutor Initial test run succeeded\./.test(line)) {
        initial = false;
        record({ phase: "mutants" });
      }
      if (initial && /\bDEBUG TapTestRunner Running: `node /.test(line)) {
        const file = inventory.find((name) => line.includes(`"${name}"\` in `));
        if (file) record({ phase: "initial", file });
      }
    }
  };
  const closed = new Promise<number | null>((done) => {
    let failed = false;
    child.once("error", () => {
      failed = true;
    });
    child.once("close", (code) => done(failed ? null : code));
  });
  try {
    const [childCode] = await Promise.all([
      closed,
      consume(child.stdout),
      consume(child.stderr),
    ]);
    const code = interruptionCode ?? childCode;
    record({ phase: "exit", code });
    return code ?? 1;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const inventory = JSON.parse(
    execFileSync(process.execPath, ["scripts/test.mjs", "all", "--inventory"], {
      encoding: "utf8",
    }),
  ).files as string[];
  process.exitCode = await mutationProgress(
    process.execPath,
    [
      fileURLToPath(
        new URL(
          "../node_modules/@stryker-mutator/core/bin/stryker.js",
          import.meta.url,
        ),
      ),
      "run",
      ...process.argv.slice(2),
      "--logLevel",
      "debug",
      "--fileLogLevel",
      "off",
    ],
    inventory,
    (record) => console.log(JSON.stringify(record)),
  );
}

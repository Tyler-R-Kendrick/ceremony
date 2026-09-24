import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

/**
 * Inventory case names present in a line, and none that is only part of
 * another that is: "a window" inside "a window that closes" is not a second
 * case that failed, it is the same one, and reporting both would be a
 * diagnostic that reads as two failures.
 */
function namedCases(line: string, cases: readonly string[]): string[] {
  const found = cases.filter((name) => name.length > 0 && line.includes(name));
  return found.filter(
    (name) => !found.some((other) => other !== name && other.includes(name)),
  );
}

/**
 * Stream only known filenames, known case names and phase/status metadata,
 * never child diagnostics.
 */
export async function mutationProgress(
  command: string,
  args: string[],
  inventory: readonly string[],
  emit: (record: Record<string, string | number | null>) => void,
  /** The case names the repository authors, for naming which case failed. */
  cases: readonly string[] = [],
  /**
   * How long one file may run in the dry run before the run is stopped.
   *
   * Every test in the profile is bounded at five minutes
   * (`--test-timeout=300000`), but a file that stalls outside a test - while
   * loading, or in a hook the bound does not reach - is bounded by nothing but
   * Stryker's 25-minute dry-run limit, which then fails naming no file. That
   * happened to `tests/fuzz.test.ts` once, a file that otherwise finishes in
   * three seconds: the job sat for 21 minutes and said only "initial test run
   * timed out". Twice the per-test bound stops it early and names the file.
   */
  stallMs = 10 * 60_000,
) {
  const started = performance.now();
  let initial = true;
  /** The file the dry run started last, and when, to catch one that never ends. */
  let running: { file: string; since: number } | undefined;
  /** Inside Stryker's list of the files that failed the initial test run. */
  let dryRunFailed = false;
  /** The last file Stryker named in that list, when the inventory knows it. */
  let failedFile: string | undefined;
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
      const progress = line.match(
        /^Mutation testing \d+% \(elapsed: [^)]*\) (\d+)\/(\d+) tested \((\d+) survived, (\d+) timed out\)$/,
      );
      if (!initial && progress)
        record({
          phase: "progress",
          tested: Number(progress[1]),
          total: Number(progress[2]),
          survived: Number(progress[3]),
          timedOut: Number(progress[4]),
        });
      if (initial && /\bDEBUG TapTestRunner Running: `node /.test(line)) {
        const file = inventory.find((name) => line.includes(`"${name}"\` in `));
        if (file) {
          running = { file, since: performance.now() };
          record({ phase: "initial", file });
        }
      }
      // A baseline that fails says only "exit 1" otherwise, and the dry run is
      // where the whole suite runs before a single mutant exists — so a real
      // failure there is invisible in exactly the way a real failure should not
      // be.
      //
      // Stryker names the files itself, and that is what is read here:
      //
      //     ERROR DryRunExecutor One or more tests failed in the initial test run:
      //     \ttests/authoring-termination.test.ts
      //
      // This used to match `^not ok ` instead, on the assumption that the test
      // process's TAP stream reaches Stryker's stdout. It does not — the tap
      // runner consumes it — so the detector never fired on a real failure,
      // and the case covering it passed because its double printed a line
      // Stryker does not emit. Established by inducing an ordinary failing
      // assertion in a baseline file and reading what actually came out.
      //
      // Each name is still matched against the inventory before it is
      // recorded, so what leaves here is an allowlisted filename and never a
      // diagnostic — the same guarantee as before, now on a line that exists.
      //
      // The list has a second kind of line, captured from the same real run:
      //
      //     \ttests/browser-snapshot.test.ts
      //     \t\tsynthetic probe: a case that fails: synthetic probe: a case that fails
      //
      // The tap runner names each file as the test, and gives as its failure
      // message the TAP failures as `fullname: name` — which is the only place
      // the *case* that failed is named. A hang that the profile's bound turns
      // into a failure lands here with the hung test's name, and a shard that
      // said only "browser-executor.test.ts" for a day could have said which
      // of its forty-three cases never settled. The name is matched against
      // the case inventory, never quoted: the same rule as for files, and a
      // line that also carries something nobody listed carries it no further.
      // A file the inventory does not know gets no case attributed to it
      // either; a case without a file it belongs to is half a diagnostic.
      if (initial && dryRunFailed) {
        if (!line.startsWith("\t")) {
          dryRunFailed = false;
          failedFile = undefined;
        } else if (line.startsWith("\t\t")) {
          if (failedFile !== undefined)
            for (const name of namedCases(line, cases))
              record({
                phase: "initial-failure",
                file: failedFile,
                case: name,
              });
        } else {
          const named = line.trim();
          if (inventory.includes(named)) {
            failedFile = named;
            record({ phase: "initial-failure", file: named });
          } else failedFile = undefined;
        }
      }
      if (
        initial &&
        /\bERROR DryRunExecutor One or more tests failed in the initial test run:/.test(
          line,
        )
      )
        dryRunFailed = true;
    }
  };
  const watchdog = setInterval(
    () => {
      if (!initial || !running || interruptionCode !== undefined) return;
      if (performance.now() - running.since < stallMs) return;
      record({ phase: "initial-stall", file: running.file });
      interruptionCode = 1;
      child.kill("SIGTERM");
    },
    Math.min(stallMs / 4, 15_000),
  );
  watchdog.unref();
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
    clearInterval(watchdog);
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { files, names } = JSON.parse(
    execFileSync(process.execPath, ["scripts/test.mjs", "all", "--inventory"], {
      encoding: "utf8",
    }),
  ) as { files: string[]; names: string[] };
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
    files,
    (record) => console.log(JSON.stringify(record)),
    names,
  );
}

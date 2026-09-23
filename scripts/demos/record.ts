import { resolve } from "node:path";
import { findDemos } from "./catalog.js";
import { recordDemo, RetryableTake, type DemoFiles } from "./harness.js";

/**
 * `npm run demos:record` records every demo; `npm run demos:record -- <id>...`
 * records the ones named. `--docs` also writes the small previews that
 * `docs/demos.md` embeds.
 *
 * Output goes to `artifacts/demos/`, which is ignored: a video is regenerated,
 * never edited. Recording is deliberately not part of `npm test`; it launches
 * a browser, encodes video and takes about a minute per demo.
 */
const args = process.argv.slice(2);
const docs = args.includes("--docs");
const names = args.filter((arg) => !arg.startsWith("--"));
const output = resolve("artifacts/demos");
const previews = docs ? resolve("docs/demos") : undefined;

let failed = false;
for (const entry of findDemos(names)) {
  const started = Date.now();
  process.stdout.write(`Recording ${entry.id}…\n`);
  try {
    const { record } = await entry.load();
    let files: DemoFiles | undefined;
    // A take the camera spoiled (stalled or folded captures) is recorded
    // again; a run that failed on its own merits is not.
    for (let take = 1; !files; take++) {
      try {
        files = await recordDemo(entry, output, record, {
          previewDirectory: previews,
        });
      } catch (error) {
        if (!(error instanceof RetryableTake) || take >= 3) throw error;
        process.stdout.write(`  take ${take} discarded: ${error.message}\n`);
      }
    }
    process.stdout.write(
      `  ${files.video} (${files.seconds.toFixed(1)}s, ${(files.bytes / 1e6).toFixed(2)} MB)\n  ${files.poster}\n${files.preview ? `  ${files.preview}\n` : ""}  took ${((Date.now() - started) / 1000).toFixed(0)}s\n`,
    );
  } catch (error) {
    failed = true;
    process.stderr.write(
      `  ${entry.id} failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}
process.exit(failed ? 1 : 0);

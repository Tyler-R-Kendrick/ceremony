import { readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

const files = readdirSync("web-dist/assets")
  .filter((name) => name.endsWith(".js"))
  .map((name) => {
    const bytes = readFileSync(join("web-dist/assets", name));
    return { name, raw: bytes.length, gzip: gzipSync(bytes).length };
  });
if (!files.length) throw new Error("Missing browser build");
const totals = files.reduce(
  (sum, file) => ({ raw: sum.raw + file.raw, gzip: sum.gzip + file.gzip }),
  { raw: 0, gzip: 0 },
);
// Studio authoring adds a separately loaded editor; see docs/workflow-studio.md.
// Keep a total-download ceiling as well as the measured previous-release baseline.
//
// Raised once, deliberately, for the agent connector cards: the page gained a
// surface that dispatches a browser session and shows the run — its controls,
// its live state, the fields it has to ask a person for, and the outputs it
// hands back. That is roughly 7.5 kB raw over the previous ceiling and it is
// the feature, not drift: the imports it adds were already bundled, and the
// only fat found while checking (an explainer paragraph, ten state hooks) is
// gone. The ceiling moves rather than the requirement.
//
// Raised again for the connector directory, drawer, connection surface and
// import review. Worth being precise about what grew, because the headline
// number overstates it. The reference page itself grew by 0.77 kB raw and
// 0.30 kB gzip: the workspace is lazy, so a visitor who never opens it
// downloads only the nav button. What crossed the ceiling is the two
// on-demand chunks, 66.5 kB and 12.1 kB raw, which this script counts because
// it measures total download across every chunk rather than first paint.
//
// That accounting is deliberate and stays. A ceiling that ignored lazy chunks
// would let any amount of code in behind an import(), which is the drift this
// check exists to catch. So the ceiling moves to admit a surface the product
// needs — the only in-application way to find, review, connect and manage a
// connector, with no CLI and no extension — and keeps counting honestly.
// Splitting the connection surface into a third chunk was tried and reverted:
// Rollup keeps it with the directory, and the split changed nothing.
const budget = { raw: 580000, gzip: 182000 };
const passed = totals.raw <= budget.raw && totals.gzip <= budget.gzip;
mkdirSync("artifacts/bundle", { recursive: true });
writeFileSync(
  "artifacts/bundle/size.json",
  JSON.stringify(
    {
      schemaVersion: 1,
      baseline: {
        commit: "77e9b5492bd520f6567a887f070f76db0af6bc79",
        raw: 451231,
        gzip: 140120,
      },
      files,
      totals,
      budget,
      passed,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Browser JavaScript: ${totals.raw} raw / ${totals.gzip} gzip bytes; budget ${passed ? "PASS" : "FAIL"}`,
);
if (!passed) process.exitCode = 1;

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
// Raised a second time, and measured before it was raised, for the Add
// Connection wizard and the directory it opens from. Each new module was built
// into a chunk of its own to find out what it actually costs:
//
//   connect-catalog   8.51 kB raw / 2.73 kB gzip   the directory grid
//   connection-plan  10.48 kB raw / 3.81 kB gzip   draft -> server -> plan
//   catalog          12.45 kB raw / 4.01 kB gzip   static directory copy
//   add-connection   22.92 kB raw / 6.75 kB gzip   the wizard itself
//   ------------------------------------------------------------------
//   total            54.36 kB raw / 17.30 kB gzip
//
// The measured build grew by 53,450 raw and 15,623 gzip, so those four modules
// are the whole of it: nothing else got bigger and no dependency came along for
// the ride. `connection-plan` reaches into `src/server/login-plan.ts` for types
// only, which erase at build time, so no server code is shipped to a browser.
// The ceiling below is the measured total plus about 2% of headroom — enough to
// absorb a rename, not enough to hide another feature.
//
// Loading the wizard on demand was tried and reverted. It would have put the
// initial chunk back under the previous ceiling, and it broke the connection
// surface: the teaching flow renders *into* the drawer through `renderRun`, so
// suspending the drawer suspends the control those flows are driven by, and
// four acceptance cases stopped being able to find it. Measured both ways, on
// one variable. The page is worth more than the 33 kB.
const budget = { raw: 560000, gzip: 173000 };
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

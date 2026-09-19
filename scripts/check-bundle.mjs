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
// Raised twice on main and once here, and then re-measured once the two met,
// because neither number survived the merge. Recording all three so the next
// person can see what this ceiling is actually holding.
//
// main's raises were for the connector directory and its Add Connection
// drawer: categories, search, a featured strip, 64 rows and a four-step wizard
// covering every auth family the project carries — measured per module at
// 10.6 kB of directory data, 7.5 kB of browse page and 14.5 kB of wizard, none
// of it a new dependency — and then again for the protocol cards, which had
// left only 1356 bytes of room (0.26%), close enough that the ceiling had
// stopped being a budget and become a tripwire for whatever change went next.
// Its rows are static host copy on purpose: moving them behind a fetch would
// shrink this number without shrinking the download.
//
// This branch's raise was for the server-bound directory, drawer, connection
// surface and import review. The reference page itself grew by 0.77 kB raw and
// 0.30 kB gzip, because that workspace is lazy — a visitor who never opens it
// downloads only the nav button. What crossed the ceiling was the on-demand
// chunks, which this script counts because it measures total download across
// every chunk rather than first paint. That accounting is deliberate and
// stays: a ceiling that ignored lazy chunks would let any amount of code in
// behind an import().
//
// So the merged number is larger than either side predicted — 614281 raw
// against ceilings of 580000 and 545000 — and the reason is not drift. The
// application now ships TWO connector surfaces: main's catalogue-driven one in
// examples/web/, and this branch's server-bound one behind the Connectors
// section. Both are reachable, both are documented in
// docs/connector-directory.md, and consolidating them is the change that
// brings this number back down. Until someone decides which survives, the
// honest ceiling is the measurement plus the same ~3% of headroom the last
// raise used — roughly one careless import, not one sentence of copy.
const budget = { raw: 633000, gzip: 196500 };
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

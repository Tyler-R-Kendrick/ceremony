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
// Raised a second time for the connector directory and its Add Connection
// drawer, which replaced a single-column picker with a surface a person can
// browse: categories, search, a featured strip, 64 rows, and a four-step
// wizard covering every auth family the project actually carries. Measured per
// module before moving the number — 10.6 kB of directory data, 7.5 kB of
// browse page, 14.5 kB of wizard, all of it minified, none of it a new
// dependency. Tree-shaking was already removing the speculative exports found
// while checking, so the ~34 kB raw is the feature itself. The rows are static
// host copy on purpose: moving them behind a fetch would shrink this number
// without shrinking the download, which is the opposite of what the ceiling is
// for.
//
// Widened once more when the protocol cards landed. 530000 left 1356 bytes of
// room, which is 0.26%: a ceiling that close to the measurement stops being a
// budget and becomes a tripwire for whichever unrelated change happens to go
// next. Checked for fat first and found none worth taking — the only unused
// exports are a type and two arrays the catalogue itself references. So the
// number moves to where it can still catch a real regression: about 3% clear
// of today's build, which is roughly one careless import, not one sentence of
// copy.
const budget = { raw: 545000, gzip: 169000 };
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

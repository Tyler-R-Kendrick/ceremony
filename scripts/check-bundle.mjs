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
const budget = { raw: 465000, gzip: 145000 };
const passed = totals.raw <= budget.raw && totals.gzip <= budget.gzip;
mkdirSync("artifacts/bundle", { recursive: true });
writeFileSync(
  "artifacts/bundle/size.json",
  JSON.stringify(
    {
      schemaVersion: 1,
      baseline: {
        commit: "db46b2d06f62b72316d8e46c4a87cc22967590ad",
        raw: 422659,
        gzip: 132056,
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

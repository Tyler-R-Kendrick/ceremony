#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

/*
 * Refuse a literal C0 control character in source.
 *
 * This exists because the hazard is invisible and recurring. A composite key
 * built with a control character as a separator reads fine in a diff, but
 * grep reports the file as binary and silently skips it, prettier rewrites
 * the escape sequence into the raw byte so the source stops being text, and
 * a reviewer sees nothing at all. Five separate modules grew one in a single
 * day of parallel work, each author believing the escape in their editor was
 * what landed on disk.
 *
 * The rule is therefore a build failure rather than a review convention. Tab,
 * newline and carriage return are the three that legitimately appear in text.
 * Everything else in C0, and DEL, is refused. A composite key wants
 * length-prefixing instead: `parts.map((p) => p.length + ":" + p).join("|")`
 * is unambiguous, greppable and survives every tool in the chain.
 *
 * Escape sequences in source (the six characters `\` `u` `0` `0` `0` `0`) are
 * untouched: this reads bytes, and an escape is not one.
 */

const roots = ["src", "tests", "examples", "scripts"];
const extensions = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  ".md",
]);
// Deliberately malformed fixtures are the one place a hostile byte belongs.
// Same convention `.prettierignore` uses, so the two cannot disagree.
const exempt = /\.malformed\.|[/\\]fixtures[/\\].*canary-invalid\.json$/;

/** C0 except tab, newline and carriage return, plus DEL. */
const forbidden = (byte) =>
  (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) ||
  byte === 0x7f;

const findings = [];

function walk(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      walk(path);
      continue;
    }
    if (!entry.isFile() || !extensions.has(extname(entry.name))) continue;
    if (exempt.test(path)) continue;
    if (statSync(path).size > 8 * 1024 * 1024) continue;
    const bytes = readFileSync(path);
    let line = 1;
    for (let index = 0; index < bytes.length; index++) {
      const byte = bytes[index];
      if (byte === 0x0a) {
        line++;
        continue;
      }
      if (forbidden(byte)) {
        findings.push({
          path,
          line,
          byte: `0x${byte.toString(16).padStart(2, "0")}`,
        });
        // One report per file: a separator repeats, and a hundred identical
        // lines would bury the next file.
        break;
      }
    }
  }
}

for (const root of roots) walk(root);

if (findings.length) {
  console.error(
    `Literal control characters in ${findings.length} file(s). Use a length-prefixed separator instead:`,
  );
  for (const finding of findings)
    console.error(`  ${finding.path}:${finding.line} contains ${finding.byte}`);
  process.exit(1);
}
console.log("No literal control characters in source.");

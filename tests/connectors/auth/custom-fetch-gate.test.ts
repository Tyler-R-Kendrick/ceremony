import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

/*
 * The ceiling on an OAuth answer is applied where the answer is read, and a
 * transport chosen at each call site is a transport someone forgets. This gate
 * reads the source: every place that hands oauth4webapi (or jose) a fetch of
 * its own must build it from the bounded transport, and every file that makes
 * an oauth4webapi request without one must be named below with the reason it
 * is not covered, so a new call site cannot be unbounded by accident.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SRC = join(ROOT, "src");

/** A custom fetch is bounded when its expression is built from one of these. */
const BOUNDED = [
  "wireFetch(",
  "boundResponse(",
  "boundedAuthFetch(",
  "jsonBodyFetch(",
];

/** A wrapper counts only while the file that defines it still builds on the bounded transport. */
const WRAPPERS: Record<string, { file: string; builtOn: string }> = {
  "jsonBodyFetch(": {
    file: "src/server/connectors/auth/client-credentials.ts",
    builtOn: "wireFetch(",
  },
  "boundedAuthFetch(": {
    file: "src/server/public-auth-fetch.ts",
    builtOn: "boundResponse(",
  },
};

/** Sites that read their answer under a ceiling of their own, with the evidence that they still do. */
const OWN_CEILING: Record<string, { evidence: string; why: string }> = {
  "src/server/jira-auth.ts": {
    evidence: "boundedJson(",
    why: "the token answer is read by the file's own request helper under a 64 KiB ceiling and handed on as a rebuilt Response",
  },
};

/**
 * Files that make oauth4webapi requests with the global fetch and no ceiling.
 * They are the deployment's own sign-in clients: the issuer an operator
 * configured for signing in to the app itself, and the app's own device-login
 * API. They are not connectors, their endpoints are not a person's or an
 * author's, and this ledger only shrinks.
 */
const UNBOUNDED: Record<string, string> = {
  "src/server/oidc-identity.ts": "operator-configured sign-in issuer",
  "src/server/mcp-identity.ts": "operator-configured sign-in issuer",
  "src/server/adapters.ts": "the app's own device-login client",
};

type Site = { file: string; line: number; expression: string };

const SITE =
  /\[\s*(?:oauth\.customFetch|joseFetch|jose\.customFetch)\s*\]\s*:/g;

/** The value expression that follows `[...]:` up to the `,` or closing bracket that ends it. */
function expressionAfter(source: string, from: number): string {
  let depth = 0;
  let end = from;
  for (; end < source.length; end++) {
    const char = source[end]!;
    if ("([{".includes(char)) depth++;
    else if (")]}".includes(char)) {
      if (depth === 0) break;
      depth--;
    } else if ((char === "," || char === ";") && depth === 0) break;
  }
  return source.slice(from, end);
}

function sitesIn(file: string, source: string): Site[] {
  return [...source.matchAll(SITE)].map((match) => ({
    file,
    line: source.slice(0, match.index).split("\n").length,
    expression: expressionAfter(source, match.index + match[0].length),
  }));
}

const bounded = (expression: string) =>
  BOUNDED.some((marker) => expression.includes(marker));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(dir, entry.name)]
        : [],
  );
}

const files = sourceFiles(SRC).map((path) => ({
  file: relative(ROOT, path),
  source: readFileSync(path, "utf8"),
}));

/** Every problem the tree has, as sentences; empty when the gate holds. */
function problems(
  tree: Array<{ file: string; source: string }>,
  read: (file: string) => string | undefined,
): string[] {
  const found: string[] = [];
  for (const { file, source } of tree) {
    for (const site of sitesIn(file, source)) {
      const own = OWN_CEILING[file];
      if (own) {
        if (!source.includes(own.evidence))
          found.push(`${file}:${site.line} no longer has ${own.evidence}`);
        continue;
      }
      if (!bounded(site.expression))
        found.push(
          `${file}:${site.line} hands a fetch of its own to OAuth unbounded: ${site.expression.trim().slice(0, 80)}`,
        );
      for (const [name, wrapper] of Object.entries(WRAPPERS))
        if (
          site.expression.includes(name) &&
          !read(wrapper.file)?.includes(wrapper.builtOn)
        )
          found.push(
            `${file}:${site.line} uses ${name} which is not built on ${wrapper.builtOn}`,
          );
    }
    const requests = /\boauth\.\w+Request\(/.test(source);
    const covered =
      sitesIn(file, source).length > 0 ||
      source.includes("requestOptions(") ||
      file in UNBOUNDED;
    if (requests && !covered && !file.endsWith("connectors/auth/wire.ts"))
      found.push(
        `${file} makes oauth4webapi requests with no ceiling and is not in the ledger`,
      );
  }
  return found;
}

const readFromTree = (file: string) =>
  files.find((item) => item.file === file)?.source;

test("every fetch a source file hands to OAuth reads its answer under the ceiling", () => {
  assert.deepEqual(problems(files, readFromTree), []);
});

test("the gate sees the sites it is meant to see", () => {
  const seen = new Set(
    files.flatMap(({ file, source }) =>
      sitesIn(file, source).length ? [file] : [],
    ),
  );
  for (const file of [
    "src/server/authored-oauth.ts",
    "src/server/connectors/auth/client-credentials.ts",
    "src/server/connectors/auth/token-exchange.ts",
    "src/server/connectors/auth/wire.ts",
    "src/server/connectors/providers/supabase/management.ts",
    "src/server/jira-auth.ts",
  ])
    assert.ok(
      seen.has(file),
      `${file} has a custom fetch the gate should read`,
    );
  for (const file of Object.keys(UNBOUNDED))
    assert.ok(readFromTree(file), `${file} is in the ledger and still exists`);
});

test("positive control: an unbounded custom fetch, a forgotten wrapper and an uncovered file are all flagged", () => {
  const unbounded = `const options = { [oauth.customFetch]: (url, init) => ctx.environment.fetch(url, init), signal };`;
  assert.equal(
    problems(
      [{ file: "src/server/connectors/x.ts", source: unbounded }],
      () => undefined,
    ).length,
    1,
  );
  const wrapped = `const options = { [oauth.customFetch]: jsonBodyFetch(wire) };`;
  assert.equal(
    problems(
      [{ file: "src/server/connectors/y.ts", source: wrapped }],
      () => "no transport here",
    ).length,
    1,
    "a wrapper that no longer builds on the bounded transport does not count",
  );
  const forgotten = `import * as oauth from "oauth4webapi";\nawait oauth.refreshTokenGrantRequest(as, client, auth, token, options);`;
  assert.equal(
    problems(
      [{ file: "src/server/connectors/z.ts", source: forgotten }],
      () => undefined,
    ).length,
    1,
  );
  const fine = `const options = { [oauth.customFetch]: async (u, i) => boundResponse(await fetch(u, i)) };`;
  assert.deepEqual(
    problems(
      [{ file: "src/server/connectors/ok.ts", source: fine }],
      () => undefined,
    ),
    [],
  );
});

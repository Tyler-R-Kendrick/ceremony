import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { z } from "zod";

const position = z.object({
  line: z.number().int().positive(),
  column: z.number().int().nonnegative(),
});
const coverageSchema = z.object({
  statementMap: z.record(
    z.string(),
    z.object({ start: position, end: position }),
  ),
  s: z.record(z.string(), z.number().nonnegative()),
});
type Coverage = z.infer<typeof coverageSchema>;

export function crapScore(complexity: number, coverage: number) {
  if (
    !Number.isInteger(complexity) ||
    complexity < 1 ||
    !Number.isFinite(coverage) ||
    coverage < 0 ||
    coverage > 1
  )
    throw new Error("Invalid complexity or coverage");
  return complexity ** 2 * (1 - coverage) ** 3 + complexity;
}

function isFunction(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/** Line-coverage CRAP variant. Nested functions have their own complexity/coverage. */
export function analyzeCrap(file: string, source: string, coverage: Coverage) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const functions: ts.FunctionLikeDeclaration[] = [];
  const collect = (node: ts.Node) => {
    if (isFunction(node) && node.body) functions.push(node);
    ts.forEachChild(node, collect);
  };
  collect(tree);
  const line = (offset: number) =>
    tree.getLineAndCharacterOfPosition(offset).line + 1;
  const hits = new Map<number, number>();
  for (const [id, statement] of Object.entries(coverage.statementMap)) {
    const count = coverage.s[id];
    if (count === undefined) throw new Error("Missing statement hit count");
    hits.set(
      statement.start.line,
      Math.max(hits.get(statement.start.line) ?? 0, count),
    );
  }
  return functions.map((fn) => {
    let complexity = 1;
    const nested: Array<[number, number]> = [];
    const visit = (node: ts.Node) => {
      if (node !== fn && isFunction(node)) {
        nested.push([line(node.getStart(tree)), line(node.end)]);
        return;
      }
      if (
        ts.isIfStatement(node) ||
        ts.isConditionalExpression(node) ||
        ts.isForStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isForOfStatement(node) ||
        ts.isWhileStatement(node) ||
        ts.isDoStatement(node) ||
        ts.isCaseClause(node) ||
        ts.isCatchClause(node) ||
        (ts.isBinaryExpression(node) &&
          [
            ts.SyntaxKind.AmpersandAmpersandToken,
            ts.SyntaxKind.BarBarToken,
            ts.SyntaxKind.QuestionQuestionToken,
          ].includes(node.operatorToken.kind)) ||
        ((ts.isPropertyAccessExpression(node) ||
          ts.isElementAccessExpression(node) ||
          ts.isCallExpression(node)) &&
          node.questionDotToken) ||
        ((ts.isParameter(node) || ts.isBindingElement(node)) &&
          node.initializer)
      )
        complexity++;
      ts.forEachChild(node, visit);
    };
    visit(fn);
    const start = line(fn.getStart(tree));
    const end = line(fn.end);
    // ponytail: line coverage cannot distinguish two functions sharing a line; use separate lines for precise attribution.
    const statements = [...hits].filter(
      ([number]) =>
        number >= start &&
        number <= end &&
        !nested.some(([first, last]) => number >= first && number <= last),
    );
    const covered = statements.filter(([, count]) => count > 0).length;
    const fraction = statements.length ? covered / statements.length : 0;
    return {
      file,
      line: start,
      complexity,
      coveredLines: covered,
      measuredLines: statements.length,
      coverage: fraction,
      crap: crapScore(complexity, fraction),
    };
  });
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(file)
      : /\.tsx?$/.test(file)
        ? [file]
        : [];
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const input = process.argv[2] ?? "artifacts/coverage/coverage-final.json";
  const coverage = z
    .record(z.string(), coverageSchema)
    .parse(JSON.parse(readFileSync(input, "utf8")));
  const checkedAt = statSync(input).mtimeMs;
  const rows = sourceFiles("src")
    .flatMap((file) => {
      if (statSync(file).mtimeMs > checkedAt)
        throw new Error(`Coverage predates source: ${file}`);
      const data = coverage[resolve(file)];
      if (!data) throw new Error(`Missing coverage: ${file}`);
      return analyzeCrap(file, readFileSync(file, "utf8"), data);
    })
    .sort((a, b) => b.crap - a.crap);
  if (!rows.length) throw new Error("No functions measured");
  const failures = rows.filter((row) => row.crap >= 30);
  const output = "artifacts/crap/report.json";
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(
    output,
    JSON.stringify(
      {
        metric: "line-coverage CRAP",
        threshold: 30,
        functions: rows.length,
        failing: failures.length,
        rows,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `${rows.length} functions; ${failures.length} CRAP scores >= 30. ${output}`,
  );
  process.exitCode = failures.length ? 1 : 0;
}

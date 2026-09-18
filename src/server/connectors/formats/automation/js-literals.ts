/*
 * A bounded, purely syntactic reader for JavaScript/TypeScript *source text*.
 *
 * It never requires, imports, evaluates, compiles or transpiles anything. It
 * turns source text into tokens, and turns a value position into a tree of
 * literals. Anything that is not a literal — a function, a call, a bare
 * identifier, a template with a substitution, a regular expression, a spread,
 * a computed key — becomes an `opaque` node that records *why* and *where*,
 * and the reader above reports it as an inert diagnostic. An opaque node
 * carries no source text, because source text from an untrusted connector is
 * neither displayed nor logged.
 *
 * The TypeScript compiler API is deliberately not used: `typescript` is a
 * devDependency of this package, so a hosted deployment may not have it, and
 * an importer whose behaviour depends on whether a dev tool is installed is
 * not an importer anyone can reason about. This tokenizer has no runtime
 * dependency, is bounded by construction, and behaves identically everywhere.
 */

export type JsLoc = { line: number; column: number };

export type OpaqueReason =
  | "function"
  | "call"
  | "reference"
  | "template-expression"
  | "regex"
  | "spread"
  | "computed-key"
  | "expression"
  | "truncated";

export type StaticEntry = {
  key: string;
  value: StaticValue;
  loc: JsLoc;
  /** The key was written as a quoted string rather than an identifier. */
  quoted: boolean;
};

export type StaticValue =
  | { kind: "string"; value: string; loc: JsLoc }
  | { kind: "number"; value: number; loc: JsLoc }
  | { kind: "boolean"; value: boolean; loc: JsLoc }
  | { kind: "null"; loc: JsLoc }
  | { kind: "array"; items: StaticValue[]; loc: JsLoc }
  | { kind: "object"; entries: StaticEntry[]; loc: JsLoc }
  | { kind: "opaque"; reason: OpaqueReason; loc: JsLoc };

export type JsLimits = {
  bytes: number;
  tokens: number;
  depth: number;
  nodes: number;
  stringLength: number;
};

export const JS_LIMITS: JsLimits = Object.freeze({
  bytes: 2 * 1024 * 1024,
  tokens: 200_000,
  depth: 32,
  nodes: 20_000,
  stringLength: 8192,
});

type TokenKind = "string" | "number" | "name" | "punct" | "template" | "regex";

export type JsToken = {
  kind: TokenKind;
  /** Decoded value for strings and templates, source spelling for names and punctuators. */
  value: string;
  numeric?: number;
  /** A template literal that contains `${`; its value is never usable as a literal. */
  dynamic?: boolean;
  loc: JsLoc;
};

const PUNCTUATORS = [
  "...",
  "=>",
  "===",
  "!==",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "?.",
  "++",
  "--",
  "**",
  "{",
  "}",
  "[",
  "]",
  "(",
  ")",
  ",",
  ":",
  ";",
  "=",
  ".",
  "?",
  "+",
  "-",
  "*",
  "/",
  "%",
  "!",
  "<",
  ">",
  "&",
  "|",
  "^",
  "~",
  "@",
  "#",
];

const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "case",
  "do",
  "else",
  "yield",
  "await",
  "throw",
]);

const IDENTIFIER_START = /[\p{L}\p{Nl}$_]/u;
const IDENTIFIER_PART = /[\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Pc}$_‌‍]/u;

function decodeEscape(
  text: string,
  index: number,
): { value: string; next: number } {
  const escape = text[index];
  if (escape === undefined) return { value: "", next: index };
  switch (escape) {
    case "n":
      return { value: "\n", next: index + 1 };
    case "t":
      return { value: "\t", next: index + 1 };
    case "r":
      return { value: "\r", next: index + 1 };
    case "b":
      return { value: "\b", next: index + 1 };
    case "f":
      return { value: "\f", next: index + 1 };
    case "v":
      return { value: "\v", next: index + 1 };
    case "0":
      return { value: "\0", next: index + 1 };
    case "x": {
      const hex = text.slice(index + 1, index + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex))
        return {
          value: String.fromCharCode(parseInt(hex, 16)),
          next: index + 3,
        };
      return { value: "x", next: index + 1 };
    }
    case "u": {
      if (text[index + 1] === "{") {
        const end = text.indexOf("}", index + 2);
        const hex = end < 0 ? "" : text.slice(index + 2, end);
        if (end > 0 && /^[0-9a-fA-F]{1,6}$/.test(hex)) {
          const code = parseInt(hex, 16);
          if (code <= 0x10ffff)
            return { value: String.fromCodePoint(code), next: end + 1 };
        }
        return { value: "u", next: index + 1 };
      }
      const hex = text.slice(index + 1, index + 5);
      if (/^[0-9a-fA-F]{4}$/.test(hex))
        return {
          value: String.fromCharCode(parseInt(hex, 16)),
          next: index + 5,
        };
      return { value: "u", next: index + 1 };
    }
    case "\n":
      return { value: "", next: index + 1 };
    default:
      return { value: escape, next: index + 1 };
  }
}

/**
 * Tokenizes JavaScript or TypeScript source. It is a scanner, not a parser:
 * it does not build a syntax tree, resolve types or follow imports. A source
 * that exceeds any bound stops the scan and sets `truncated`, so a hostile
 * file costs a bounded amount of work rather than an unbounded one.
 */
export function tokenizeJs(
  text: string,
  limits: JsLimits = JS_LIMITS,
): { tokens: JsToken[]; truncated: boolean } {
  const tokens: JsToken[] = [];
  if (text.length > limits.bytes) return { tokens, truncated: true };
  let index = 0;
  let line = 1;
  let lineStart = 0;
  let truncated = false;
  const loc = (at: number): JsLoc => ({ line, column: at - lineStart + 1 });
  const advanceNewlines = (from: number, to: number) => {
    for (let scan = from; scan < to; scan++)
      if (text[scan] === "\n") {
        line++;
        lineStart = scan + 1;
      }
  };
  const previousSignificant = (): JsToken | undefined =>
    tokens[tokens.length - 1];
  const regexAllowed = (): boolean => {
    const previous = previousSignificant();
    if (!previous) return true;
    if (previous.kind === "punct")
      return ![")", "]", "}", "++", "--"].includes(previous.value);
    if (previous.kind === "name")
      return REGEX_PRECEDING_KEYWORDS.has(previous.value);
    return false;
  };

  while (index < text.length) {
    if (tokens.length >= limits.tokens) {
      truncated = true;
      break;
    }
    const char = text[index]!;
    if (char === "\n") {
      line++;
      index++;
      lineStart = index;
      continue;
    }
    if (char === " " || char === "\t" || char === "\r" || /\s/.test(char)) {
      index++;
      continue;
    }
    // Comments carry no metadata this reader trusts; they are skipped whole.
    if (char === "/" && text[index + 1] === "/") {
      const end = text.indexOf("\n", index);
      index = end < 0 ? text.length : end;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end < 0 ? text.length : end + 2;
      advanceNewlines(index, stop);
      index = stop;
      continue;
    }
    if (char === "#" && index === 0 && text[1] === "!") {
      const end = text.indexOf("\n", index);
      index = end < 0 ? text.length : end;
      continue;
    }
    const start = index;
    if (char === '"' || char === "'") {
      const quote = char;
      let value = "";
      index++;
      let closed = false;
      while (index < text.length) {
        const current = text[index]!;
        if (current === "\\") {
          const decoded = decodeEscape(text, index + 1);
          if (value.length < limits.stringLength) value += decoded.value;
          advanceNewlines(index, decoded.next);
          index = decoded.next;
          continue;
        }
        if (current === quote) {
          index++;
          closed = true;
          break;
        }
        if (current === "\n") break;
        if (value.length < limits.stringLength) value += current;
        index++;
      }
      if (!closed) {
        truncated = true;
        break;
      }
      tokens.push({ kind: "string", value, loc: loc(start) });
      continue;
    }
    if (char === "`") {
      let value = "";
      let dynamic = false;
      index++;
      let closed = false;
      while (index < text.length) {
        const current = text[index]!;
        if (current === "\\") {
          const decoded = decodeEscape(text, index + 1);
          if (value.length < limits.stringLength) value += decoded.value;
          advanceNewlines(index, decoded.next);
          index = decoded.next;
          continue;
        }
        if (current === "$" && text[index + 1] === "{") {
          dynamic = true;
          // Skip the substitution without reading it: only the braces matter.
          let depth = 1;
          index += 2;
          while (index < text.length && depth > 0) {
            const inner = text[index]!;
            if (inner === "{") depth++;
            else if (inner === "}") depth--;
            else if (inner === "\n") {
              line++;
              lineStart = index + 1;
            }
            index++;
          }
          continue;
        }
        if (current === "`") {
          index++;
          closed = true;
          break;
        }
        if (current === "\n") {
          line++;
          lineStart = index + 1;
        }
        if (value.length < limits.stringLength) value += current;
        index++;
      }
      if (!closed) {
        truncated = true;
        break;
      }
      tokens.push({
        kind: "template",
        value,
        ...(dynamic ? { dynamic: true } : {}),
        loc: loc(start),
      });
      continue;
    }
    if (char === "/" && regexAllowed()) {
      // A regular expression body, scanned only to find its end. If it does
      // not close on this line the slash was division after all.
      let scan = index + 1;
      let inClass = false;
      let closed = false;
      while (scan < text.length) {
        const current = text[scan]!;
        if (current === "\\") {
          scan += 2;
          continue;
        }
        if (current === "\n") break;
        if (current === "[") inClass = true;
        else if (current === "]") inClass = false;
        else if (current === "/" && !inClass) {
          closed = true;
          scan++;
          break;
        }
        scan++;
      }
      if (closed) {
        while (scan < text.length && IDENTIFIER_PART.test(text[scan]!)) scan++;
        tokens.push({ kind: "regex", value: "/", loc: loc(start) });
        index = scan;
        continue;
      }
    }
    if (
      /[0-9]/.test(char) ||
      (char === "." && /[0-9]/.test(text[index + 1] ?? ""))
    ) {
      let scan = index;
      if (char === "0" && /[xXbBoO]/.test(text[index + 1] ?? "")) {
        scan += 2;
        while (scan < text.length && /[0-9a-fA-F_]/.test(text[scan]!)) scan++;
      } else {
        while (scan < text.length && /[0-9_]/.test(text[scan]!)) scan++;
        if (text[scan] === ".") {
          scan++;
          while (scan < text.length && /[0-9_]/.test(text[scan]!)) scan++;
        }
        if (/[eE]/.test(text[scan] ?? "")) {
          scan++;
          if (/[+-]/.test(text[scan] ?? "")) scan++;
          while (scan < text.length && /[0-9]/.test(text[scan]!)) scan++;
        }
      }
      const raw = text.slice(index, scan).replaceAll("_", "");
      const numeric = Number(raw);
      tokens.push({
        kind: "number",
        value: raw,
        numeric: Number.isFinite(numeric) ? numeric : 0,
        loc: loc(start),
      });
      index = scan;
      continue;
    }
    if (IDENTIFIER_START.test(char)) {
      let scan = index + 1;
      while (scan < text.length && IDENTIFIER_PART.test(text[scan]!)) scan++;
      tokens.push({
        kind: "name",
        value: text.slice(index, scan),
        loc: loc(start),
      });
      index = scan;
      continue;
    }
    const punctuator = PUNCTUATORS.find((candidate) =>
      text.startsWith(candidate, index),
    );
    if (punctuator) {
      tokens.push({ kind: "punct", value: punctuator, loc: loc(start) });
      index += punctuator.length;
      continue;
    }
    index++;
  }
  return { tokens, truncated };
}

type ParseState = {
  tokens: readonly JsToken[];
  limits: JsLimits;
  nodes: number;
  truncated: boolean;
};

const at = (state: ParseState, index: number): JsToken | undefined =>
  state.tokens[index];

const isPunct = (token: JsToken | undefined, value: string): boolean =>
  token?.kind === "punct" && token.value === value;

const FALLBACK_LOC: JsLoc = { line: 0, column: 0 };

/** Skips a balanced token run starting at `index`, returning the index after it. */
function skipBalanced(state: ParseState, index: number): number {
  const opener = at(state, index);
  if (!opener) return index;
  const pairs: Record<string, string> = { "{": "}", "[": "]", "(": ")" };
  const closer = pairs[opener.value];
  if (opener.kind !== "punct" || closer === undefined) return index + 1;
  let depth = 0;
  let scan = index;
  while (scan < state.tokens.length) {
    const token = state.tokens[scan]!;
    if (token.kind === "punct") {
      if (token.value === "{" || token.value === "[" || token.value === "(")
        depth++;
      else if (
        token.value === "}" ||
        token.value === "]" ||
        token.value === ")"
      ) {
        depth--;
        if (depth === 0) return scan + 1;
      }
    }
    scan++;
  }
  state.truncated = true;
  return state.tokens.length;
}

/**
 * Skips one value that is not a literal and classifies it. Nothing inside is
 * read as data; the scan exists only to find where the value ends so the rest
 * of the object can still be read.
 */
function skipOpaqueValue(
  state: ParseState,
  index: number,
): { reason: OpaqueReason; next: number } {
  const first = at(state, index);
  if (!first) return { reason: "truncated", next: index };
  let reason: OpaqueReason = "expression";
  if (first.kind === "regex") reason = "regex";
  else if (first.kind === "template" && first.dynamic)
    reason = "template-expression";
  else if (first.kind === "name") {
    if (first.value === "function") reason = "function";
    else if (first.value === "async") reason = "function";
    else if (first.value === "class") reason = "function";
    else if (isPunct(at(state, index + 1), "(")) reason = "call";
    else if (isPunct(at(state, index + 1), "=>")) reason = "function";
    else reason = "reference";
  } else if (isPunct(first, "(")) reason = "expression";

  // Every bracketed group is skipped whole, so the scan only ever sees the
  // value's own top level: an unmatched closer, a comma or a semicolon there
  // ends the value.
  let scan = index;
  let sawArrow = false;
  while (scan < state.tokens.length) {
    const token = state.tokens[scan]!;
    if (token.kind === "punct") {
      if (token.value === "{" || token.value === "[" || token.value === "(") {
        const skipped = skipBalanced(state, scan);
        scan = skipped === scan ? scan + 1 : skipped;
        continue;
      }
      if (token.value === "}" || token.value === "]" || token.value === ")")
        break;
      if (token.value === "," || token.value === ";") break;
      if (token.value === "=>") sawArrow = true;
    }
    scan++;
  }
  if (sawArrow) reason = "function";
  if (scan === index) scan = index + 1;
  return { reason, next: scan };
}

/** Reads one value at `index`; every non-literal becomes an `opaque` node. */
export function parseValue(
  state: ParseState,
  index: number,
  depth: number,
): { value: StaticValue; next: number } {
  const token = at(state, index);
  if (!token)
    return {
      value: { kind: "opaque", reason: "truncated", loc: FALLBACK_LOC },
      next: index,
    };
  if (++state.nodes > state.limits.nodes || depth > state.limits.depth) {
    state.truncated = true;
    const skipped = skipOpaqueValue(state, index);
    return {
      value: { kind: "opaque", reason: "truncated", loc: token.loc },
      next: skipped.next,
    };
  }
  if (token.kind === "string")
    return {
      value: { kind: "string", value: token.value, loc: token.loc },
      next: index + 1,
    };
  if (token.kind === "template" && !token.dynamic)
    return {
      value: { kind: "string", value: token.value, loc: token.loc },
      next: index + 1,
    };
  if (token.kind === "number")
    return {
      value: { kind: "number", value: token.numeric ?? 0, loc: token.loc },
      next: index + 1,
    };
  if (
    token.kind === "name" &&
    (token.value === "true" || token.value === "false")
  )
    return {
      value: { kind: "boolean", value: token.value === "true", loc: token.loc },
      next: index + 1,
    };
  if (token.kind === "name" && token.value === "null")
    return { value: { kind: "null", loc: token.loc }, next: index + 1 };
  if (isPunct(token, "-")) {
    const next = at(state, index + 1);
    if (next?.kind === "number")
      return {
        value: { kind: "number", value: -(next.numeric ?? 0), loc: token.loc },
        next: index + 2,
      };
  }
  if (isPunct(token, "[")) {
    const items: StaticValue[] = [];
    let scan = index + 1;
    while (scan < state.tokens.length) {
      const current = at(state, scan);
      if (!current) break;
      if (isPunct(current, "]")) {
        scan++;
        break;
      }
      if (isPunct(current, ",")) {
        scan++;
        continue;
      }
      if (isPunct(current, "...")) {
        const skipped = skipOpaqueValue(state, scan + 1);
        items.push({ kind: "opaque", reason: "spread", loc: current.loc });
        scan = skipped.next;
        continue;
      }
      const parsed = parseValue(state, scan, depth + 1);
      items.push(parsed.value);
      scan = parsed.next === scan ? scan + 1 : parsed.next;
    }
    return { value: { kind: "array", items, loc: token.loc }, next: scan };
  }
  if (isPunct(token, "{")) {
    const entries: StaticEntry[] = [];
    let scan = index + 1;
    while (scan < state.tokens.length) {
      const current = at(state, scan);
      if (!current) break;
      if (isPunct(current, "}")) {
        scan++;
        break;
      }
      if (isPunct(current, ",") || isPunct(current, ";")) {
        scan++;
        continue;
      }
      if (isPunct(current, "...")) {
        const skipped = skipOpaqueValue(state, scan + 1);
        entries.push({
          key: "",
          quoted: false,
          value: { kind: "opaque", reason: "spread", loc: current.loc },
          loc: current.loc,
        });
        scan = skipped.next;
        continue;
      }
      if (isPunct(current, "[")) {
        // A computed key is an expression; neither the key nor the value is read.
        const afterKey = skipBalanced(state, scan);
        let next = afterKey;
        if (isPunct(at(state, afterKey), ":"))
          next = skipOpaqueValue(state, afterKey + 1).next;
        entries.push({
          key: "",
          quoted: false,
          value: { kind: "opaque", reason: "computed-key", loc: current.loc },
          loc: current.loc,
        });
        scan = next === scan ? scan + 1 : next;
        continue;
      }
      // Method shorthand and modifiers before a key: `async foo() {}`, `get x() {}`.
      let keyIndex = scan;
      while (
        at(state, keyIndex)?.kind === "name" &&
        [
          "async",
          "get",
          "set",
          "static",
          "readonly",
          "public",
          "private",
          "protected",
        ].includes(at(state, keyIndex)!.value) &&
        at(state, keyIndex + 1) !== undefined &&
        !isPunct(at(state, keyIndex + 1), ":") &&
        !isPunct(at(state, keyIndex + 1), ",") &&
        !isPunct(at(state, keyIndex + 1), "}") &&
        !isPunct(at(state, keyIndex + 1), "(")
      )
        keyIndex++;
      if (isPunct(at(state, keyIndex), "*")) keyIndex++;
      const keyToken = at(state, keyIndex);
      if (!keyToken) break;
      const quoted = keyToken.kind === "string";
      const key =
        keyToken.kind === "string" || keyToken.kind === "name"
          ? keyToken.value
          : keyToken.kind === "number"
            ? keyToken.value
            : undefined;
      if (key === undefined) {
        const skipped = skipOpaqueValue(state, keyIndex);
        scan = skipped.next === scan ? scan + 1 : skipped.next;
        continue;
      }
      const afterKey = keyIndex + 1;
      if (isPunct(at(state, afterKey), "(")) {
        // Method shorthand: a function by another spelling.
        const afterParams = skipBalanced(state, afterKey);
        let bodyIndex = afterParams;
        while (
          bodyIndex < state.tokens.length &&
          !isPunct(at(state, bodyIndex), "{") &&
          !isPunct(at(state, bodyIndex), ",") &&
          !isPunct(at(state, bodyIndex), "}")
        )
          bodyIndex++;
        const next = isPunct(at(state, bodyIndex), "{")
          ? skipBalanced(state, bodyIndex)
          : bodyIndex;
        entries.push({
          key,
          quoted,
          value: { kind: "opaque", reason: "function", loc: keyToken.loc },
          loc: keyToken.loc,
        });
        scan = next === scan ? scan + 1 : next;
        continue;
      }
      if (!isPunct(at(state, afterKey), ":")) {
        // Shorthand property `{ perform }` references a binding, not a literal.
        entries.push({
          key,
          quoted,
          value: { kind: "opaque", reason: "reference", loc: keyToken.loc },
          loc: keyToken.loc,
        });
        scan = afterKey;
        continue;
      }
      const parsed = parseValue(state, afterKey + 1, depth + 1);
      entries.push({ key, quoted, value: parsed.value, loc: keyToken.loc });
      scan = parsed.next === scan ? scan + 1 : parsed.next;
    }
    return { value: { kind: "object", entries, loc: token.loc }, next: scan };
  }
  const skipped = skipOpaqueValue(state, index);
  return {
    value: { kind: "opaque", reason: skipped.reason, loc: token.loc },
    next: skipped.next === index ? index + 1 : skipped.next,
  };
}

export type JsParse = {
  tokens: readonly JsToken[];
  truncated: boolean;
  limits: JsLimits;
};

export function parseJsSource(
  text: string,
  limits: JsLimits = JS_LIMITS,
): JsParse {
  const { tokens, truncated } = tokenizeJs(text, limits);
  return { tokens, truncated, limits };
}

/** Reads the value at a token index into a literal tree. */
export function readValueAt(
  parse: JsParse,
  index: number,
): { value: StaticValue; truncated: boolean } {
  const state: ParseState = {
    tokens: parse.tokens,
    limits: parse.limits,
    nodes: 0,
    truncated: false,
  };
  const parsed = parseValue(state, index, 1);
  return { value: parsed.value, truncated: state.truncated || parse.truncated };
}

const nameAt = (parse: JsParse, index: number): string | undefined => {
  const token = parse.tokens[index];
  return token?.kind === "name" ? token.value : undefined;
};

const punctAt = (parse: JsParse, index: number, value: string): boolean =>
  isPunct(parse.tokens[index], value);

/** Index of the token after an optional TypeScript type annotation `: Type<...>`. */
function skipTypeAnnotation(parse: JsParse, index: number): number {
  if (!punctAt(parse, index, ":")) return index;
  let scan = index + 1;
  const state: ParseState = {
    tokens: parse.tokens,
    limits: parse.limits,
    nodes: 0,
    truncated: false,
  };
  while (scan < parse.tokens.length) {
    const token = parse.tokens[scan]!;
    if (token.kind === "punct") {
      if (token.value === "=" || token.value === ";" || token.value === ",")
        break;
      if (token.value === "<" || token.value === "[" || token.value === "(") {
        if (token.value === "<") {
          // Generic arguments; balance angle brackets by counting.
          let angle = 0;
          while (scan < parse.tokens.length) {
            const inner = parse.tokens[scan]!;
            if (inner.kind === "punct" && inner.value === "<") angle++;
            else if (inner.kind === "punct" && inner.value === ">") {
              angle--;
              if (angle === 0) {
                scan++;
                break;
              }
            } else if (inner.kind === "punct" && inner.value === "=") break;
            scan++;
          }
          continue;
        }
        scan = skipBalanced(state, scan);
        continue;
      }
    }
    scan++;
  }
  return scan;
}

/**
 * Finds the module's exported value: `module.exports = …`, `export default …`,
 * `exports.default = …`, or `export const Name = …`. One level of identifier
 * indirection is resolved (`module.exports = App` with `const App = {…}`)
 * because that is how the vendors' own templates are written; nothing is
 * evaluated to do it.
 */
export function findExportedValueIndex(parse: JsParse): number | undefined {
  const declarations = new Map<string, number>();
  let indirect: string | undefined;
  for (let index = 0; index < parse.tokens.length; index++) {
    const name = nameAt(parse, index);
    if (
      (name === "const" || name === "let" || name === "var") &&
      nameAt(parse, index + 1) !== undefined
    ) {
      const valueIndex = skipTypeAnnotation(parse, index + 2);
      if (punctAt(parse, valueIndex, "="))
        declarations.set(nameAt(parse, index + 1)!, valueIndex + 1);
      continue;
    }
    if (
      name === "module" &&
      punctAt(parse, index + 1, ".") &&
      nameAt(parse, index + 2) === "exports"
    ) {
      if (punctAt(parse, index + 3, "=")) {
        const target = nameAt(parse, index + 4);
        if (
          target !== undefined &&
          !["function", "async", "class", "true", "false", "null"].includes(
            target,
          ) &&
          (punctAt(parse, index + 5, ";") ||
            parse.tokens[index + 5] === undefined)
        ) {
          indirect = target;
          continue;
        }
        return index + 4;
      }
      continue;
    }
    if (
      name === "exports" &&
      punctAt(parse, index + 1, ".") &&
      nameAt(parse, index + 2) === "default"
    ) {
      if (punctAt(parse, index + 3, "=")) return index + 4;
      continue;
    }
    if (name === "export") {
      if (nameAt(parse, index + 1) === "default") return index + 2;
      const kind = nameAt(parse, index + 1);
      if (kind === "const" || kind === "let" || kind === "var") {
        const declared = nameAt(parse, index + 2);
        const valueIndex = skipTypeAnnotation(parse, index + 3);
        if (declared !== undefined && punctAt(parse, valueIndex, "=")) {
          declarations.set(declared, valueIndex + 1);
          if (indirect === undefined) indirect = declared;
        }
      }
    }
  }
  if (indirect !== undefined) return declarations.get(indirect);
  return undefined;
}

/**
 * Finds a class property initializer such as n8n's
 * `description: INodeTypeDescription = { … }` or `description = { … }`,
 * returning the index of the value.
 */
export function findClassPropertyIndex(
  parse: JsParse,
  property: string,
): number | undefined {
  for (let index = 0; index < parse.tokens.length; index++) {
    if (nameAt(parse, index) !== property) continue;
    const previous = parse.tokens[index - 1];
    if (previous?.kind === "punct" && [".", "?."].includes(previous.value))
      continue;
    const valueIndex = skipTypeAnnotation(parse, index + 1);
    if (punctAt(parse, valueIndex, "=") && !punctAt(parse, valueIndex + 1, "="))
      return valueIndex + 1;
  }
  return undefined;
}

/**
 * Names of methods declared in any class body in the source. n8n uses these to
 * tell a declarative node from a programmatic one: an `execute`, `webhook`,
 * `poll` or `trigger` method is code this runtime will not run.
 */
export function findMethodNames(parse: JsParse): Set<string> {
  const names = new Set<string>();
  const state: ParseState = {
    tokens: parse.tokens,
    limits: parse.limits,
    nodes: 0,
    truncated: false,
  };
  for (let index = 0; index < parse.tokens.length; index++) {
    if (nameAt(parse, index) !== "class") continue;
    let scan = index;
    while (scan < parse.tokens.length && !punctAt(parse, scan, "{")) scan++;
    if (scan >= parse.tokens.length) break;
    const end = skipBalanced(state, scan);
    let depth = 0;
    for (let inner = scan; inner < end; inner++) {
      const token = parse.tokens[inner]!;
      if (token.kind === "punct") {
        if (["{", "[", "("].includes(token.value)) depth++;
        else if (["}", "]", ")"].includes(token.value)) depth--;
        continue;
      }
      if (depth !== 1 || token.kind !== "name") continue;
      if (punctAt(parse, inner + 1, "(")) names.add(token.value);
    }
    index = end;
  }
  return names;
}

/* Accessors over a literal tree. Each one answers "is this literal?" and
 * returns undefined rather than guessing when it is not. */

export function objectEntry(
  value: StaticValue | undefined,
  key: string,
): StaticEntry | undefined {
  if (value?.kind !== "object") return undefined;
  return value.entries.find((entry) => entry.key === key);
}

export function objectValue(
  value: StaticValue | undefined,
  key: string,
): StaticValue | undefined {
  return objectEntry(value, key)?.value;
}

export function asString(value: StaticValue | undefined): string | undefined {
  return value?.kind === "string" ? value.value : undefined;
}

export function asBoolean(value: StaticValue | undefined): boolean | undefined {
  return value?.kind === "boolean" ? value.value : undefined;
}

export function asNumber(value: StaticValue | undefined): number | undefined {
  return value?.kind === "number" ? value.value : undefined;
}

export function asArray(
  value: StaticValue | undefined,
): StaticValue[] | undefined {
  return value?.kind === "array" ? value.items : undefined;
}

export function asObject(
  value: StaticValue | undefined,
): StaticEntry[] | undefined {
  return value?.kind === "object" ? value.entries : undefined;
}

/** Converts a literal tree back into plain JSON data; opaque nodes disappear. */
export function toJsonValue(value: StaticValue | undefined): unknown {
  switch (value?.kind) {
    case "string":
      return value.value;
    case "number":
      return value.value;
    case "boolean":
      return value.value;
    case "null":
      return null;
    case "array":
      return value.items
        .map((item) => toJsonValue(item))
        .filter((item) => item !== undefined);
    case "object": {
      const out: Record<string, unknown> = {};
      for (const entry of value.entries) {
        if (!entry.key) continue;
        const converted = toJsonValue(entry.value);
        if (converted !== undefined) out[entry.key] = converted;
      }
      return out;
    }
    default:
      return undefined;
  }
}

/** Wraps a plain JSON value in the literal tree shape, for the exported-JSON path. */
export function fromJsonValue(
  value: unknown,
  loc: JsLoc = FALLBACK_LOC,
): StaticValue {
  if (value === null) return { kind: "null", loc };
  if (typeof value === "string") return { kind: "string", value, loc };
  if (typeof value === "number")
    return { kind: "number", value: Number.isFinite(value) ? value : 0, loc };
  if (typeof value === "boolean") return { kind: "boolean", value, loc };
  if (Array.isArray(value))
    return {
      kind: "array",
      items: value.map((item) => fromJsonValue(item, loc)),
      loc,
    };
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      return { kind: "opaque", reason: "expression", loc };
    const entries: StaticEntry[] = [];
    for (const key of Object.keys(value as object)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) continue;
      entries.push({
        key,
        quoted: true,
        value: fromJsonValue((value as Record<string, unknown>)[key], loc),
        loc,
      });
    }
    return { kind: "object", entries, loc };
  }
  return { kind: "opaque", reason: "function", loc };
}

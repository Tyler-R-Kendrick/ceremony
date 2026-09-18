/*
 * A bounded, purely syntactic reader for Ruby *source text*.
 *
 * A Workato connector is a Ruby hash whose leaves are frequently lambdas.
 * This module reads the hash and refuses the lambdas: it tokenizes, walks
 * literal hash, array, string, symbol, number, boolean and nil values, and
 * turns everything else — a lambda, a block, a method call, an interpolated
 * string, a bare reference, a heredoc, a percent literal — into an `opaque`
 * node that records why and where. No Ruby is parsed as behaviour, loaded,
 * or run; there is no Ruby interpreter anywhere in this repository, and this
 * module is not a step towards one.
 */

export type RubyLoc = { line: number; column: number };

export type RubyOpaqueReason =
  | "lambda"
  | "block"
  | "method-call"
  | "interpolation"
  | "reference"
  | "expression"
  | "heredoc"
  | "percent-literal"
  | "regex"
  | "splat"
  | "truncated";

export type RubyEntry = {
  key: string;
  value: RubyValue;
  loc: RubyLoc;
};

export type RubyValue =
  | { kind: "string"; value: string; loc: RubyLoc }
  | { kind: "symbol"; value: string; loc: RubyLoc }
  | { kind: "number"; value: number; loc: RubyLoc }
  | { kind: "boolean"; value: boolean; loc: RubyLoc }
  | { kind: "nil"; loc: RubyLoc }
  | { kind: "array"; items: RubyValue[]; loc: RubyLoc }
  | { kind: "hash"; entries: RubyEntry[]; loc: RubyLoc }
  | { kind: "opaque"; reason: RubyOpaqueReason; loc: RubyLoc };

export type RubyLimits = {
  bytes: number;
  tokens: number;
  depth: number;
  nodes: number;
  stringLength: number;
};

export const RUBY_LIMITS: RubyLimits = Object.freeze({
  bytes: 2 * 1024 * 1024,
  tokens: 200_000,
  depth: 32,
  nodes: 20_000,
  stringLength: 8192,
});

type RubyTokenKind =
  | "string"
  | "dynamic-string"
  | "symbol"
  | "label"
  | "number"
  | "name"
  | "punct"
  | "heredoc"
  | "percent"
  | "regex";

export type RubyToken = {
  kind: RubyTokenKind;
  value: string;
  numeric?: number;
  /** This token is the first on its line; block keywords are only openers there. */
  startsLine: boolean;
  loc: RubyLoc;
};

const PUNCTUATORS = [
  "=>",
  "->",
  "::",
  "**",
  "&&",
  "||",
  "==",
  "!=",
  "<=",
  ">=",
  "<<",
  "..",
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
  "|",
  "&",
  "?",
  "+",
  "-",
  "*",
  "/",
  "%",
  "!",
  "<",
  ">",
  "^",
  "~",
  "@",
];

/** Keywords that open a block Ruby closes with `end`. */
const BLOCK_OPENERS = new Set([
  "do",
  "def",
  "class",
  "module",
  "begin",
  "case",
]);
/** Openers only when they start a statement; as modifiers they open nothing. */
const CONDITIONAL_OPENERS = new Set(["if", "unless", "while", "until", "for"]);

const IDENTIFIER_START = /[\p{L}_]/u;
const IDENTIFIER_PART = /[\p{L}\p{N}_]/u;

function decodeDoubleQuoted(raw: string, max: number): string {
  let out = "";
  for (let index = 0; index < raw.length && out.length < max; index++) {
    const char = raw[index]!;
    if (char !== "\\") {
      out += char;
      continue;
    }
    const escape = raw[++index];
    if (escape === undefined) break;
    out +=
      escape === "n"
        ? "\n"
        : escape === "t"
          ? "\t"
          : escape === "r"
            ? "\r"
            : escape === "0"
              ? "\0"
              : escape;
  }
  return out.slice(0, max);
}

/**
 * Tokenizes Ruby source well enough to find the shape of a literal hash. It
 * is not a Ruby parser and does not try to be one: anything it cannot read as
 * a literal becomes an opaque token run, which is exactly what the reader
 * above wants to hear about.
 */
export function tokenizeRuby(
  text: string,
  limits: RubyLimits = RUBY_LIMITS,
): { tokens: RubyToken[]; truncated: boolean } {
  const tokens: RubyToken[] = [];
  if (text.length > limits.bytes) return { tokens, truncated: true };
  let index = 0;
  let line = 1;
  let lineStart = 0;
  let atLineStart = true;
  let truncated = false;
  const loc = (at: number): RubyLoc => ({ line, column: at - lineStart + 1 });
  const push = (token: Omit<RubyToken, "startsLine">) => {
    tokens.push({ ...token, startsLine: atLineStart });
    atLineStart = false;
  };
  const countNewlines = (from: number, to: number) => {
    for (let scan = from; scan < to; scan++)
      if (text[scan] === "\n") {
        line++;
        lineStart = scan + 1;
        atLineStart = true;
      }
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
      atLineStart = true;
      continue;
    }
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    if (char === "#") {
      const end = text.indexOf("\n", index);
      index = end < 0 ? text.length : end;
      continue;
    }
    if (text.startsWith("=begin", index) && atLineStart) {
      const end = text.indexOf("\n=end", index);
      const stop = end < 0 ? text.length : end + 5;
      countNewlines(index, stop);
      index = stop;
      continue;
    }
    const start = index;
    // Heredocs carry free text that is never a literal this reader uses.
    const heredoc = /^<<[-~]?(['"`]?)([A-Za-z_]\w*)\1/.exec(
      text.slice(index, index + 64),
    );
    if (heredoc) {
      const terminator = heredoc[2]!;
      const bodyStart = text.indexOf("\n", index);
      let stop = text.length;
      if (bodyStart >= 0) {
        const pattern = new RegExp(`^[ \\t]*${terminator}[ \\t]*$`, "m");
        const match = pattern.exec(text.slice(bodyStart));
        stop = match ? bodyStart + match.index + match[0].length : text.length;
      }
      push({ kind: "heredoc", value: terminator, loc: loc(start) });
      countNewlines(index, stop);
      index = stop;
      continue;
    }
    if (
      char === "%" &&
      /^[qwWiI]?[[({<|]/.test(text.slice(index + 1, index + 3))
    ) {
      const openerIndex = /^[qwWiI]/.test(text[index + 1] ?? "")
        ? index + 2
        : index + 1;
      const opener = text[openerIndex];
      const closers: Record<string, string> = {
        "[": "]",
        "(": ")",
        "{": "}",
        "<": ">",
        "|": "|",
      };
      const closer = opener === undefined ? undefined : closers[opener];
      if (closer !== undefined) {
        let scan = openerIndex + 1;
        let depth = 1;
        while (scan < text.length && depth > 0) {
          if (text[scan] === "\\") scan++;
          else if (text[scan] === opener && opener !== closer) depth++;
          else if (text[scan] === closer) depth--;
          scan++;
        }
        push({ kind: "percent", value: "%", loc: loc(start) });
        countNewlines(index, scan);
        index = scan;
        continue;
      }
    }
    if (char === "'" || char === '"') {
      const quote = char;
      let scan = index + 1;
      let raw = "";
      let closed = false;
      while (scan < text.length) {
        const current = text[scan]!;
        if (current === "\\") {
          raw += current + (text[scan + 1] ?? "");
          scan += 2;
          continue;
        }
        if (current === quote) {
          scan++;
          closed = true;
          break;
        }
        raw += current;
        scan++;
      }
      if (!closed) {
        truncated = true;
        break;
      }
      const interpolated = quote === '"' && /#\{/.test(raw);
      const value =
        quote === "'"
          ? raw
              .replaceAll("\\'", "'")
              .replaceAll("\\\\", "\\")
              .slice(0, limits.stringLength)
          : decodeDoubleQuoted(raw, limits.stringLength);
      // A quoted label: `"Authorization": value`.
      if (!interpolated && text[scan] === ":" && text[scan + 1] !== ":") {
        push({ kind: "label", value, loc: loc(start) });
        countNewlines(index, scan + 1);
        index = scan + 1;
        continue;
      }
      push({
        kind: interpolated ? "dynamic-string" : "string",
        value: interpolated ? "" : value,
        loc: loc(start),
      });
      countNewlines(index, scan);
      index = scan;
      continue;
    }
    if (char === ":" && text[index + 1] !== ":") {
      const next = text[index + 1];
      if (next === "'" || next === '"') {
        const quote = next;
        let scan = index + 2;
        let raw = "";
        while (scan < text.length && text[scan] !== quote) {
          if (text[scan] === "\\") {
            raw += text[scan + 1] ?? "";
            scan += 2;
            continue;
          }
          raw += text[scan];
          scan++;
        }
        push({
          kind: "symbol",
          value: raw.slice(0, limits.stringLength),
          loc: loc(start),
        });
        index = scan + 1;
        continue;
      }
      if (next !== undefined && IDENTIFIER_START.test(next)) {
        let scan = index + 1;
        while (scan < text.length && IDENTIFIER_PART.test(text[scan]!)) scan++;
        if (text[scan] === "?" || text[scan] === "!") scan++;
        push({
          kind: "symbol",
          value: text.slice(index + 1, scan),
          loc: loc(start),
        });
        index = scan;
        continue;
      }
    }
    if (/[0-9]/.test(char)) {
      let scan = index;
      while (scan < text.length && /[0-9_]/.test(text[scan]!)) scan++;
      if (text[scan] === "." && /[0-9]/.test(text[scan + 1] ?? "")) {
        scan++;
        while (scan < text.length && /[0-9_]/.test(text[scan]!)) scan++;
      }
      const raw = text.slice(index, scan).replaceAll("_", "");
      const numeric = Number(raw);
      push({
        kind: "number",
        value: raw,
        numeric: Number.isFinite(numeric) ? numeric : 0,
        loc: loc(start),
      });
      index = scan;
      continue;
    }
    if (IDENTIFIER_START.test(char) || char === "@" || char === "$") {
      let scan = index;
      if (char === "@" || char === "$") scan++;
      if (text[scan] === "@") scan++;
      while (scan < text.length && IDENTIFIER_PART.test(text[scan]!)) scan++;
      if (text[scan] === "?" || text[scan] === "!") scan++;
      const name = text.slice(index, scan);
      // A hash label: `name:` but not `name ? a : b` and not `name::Const`.
      if (text[scan] === ":" && text[scan + 1] !== ":") {
        push({ kind: "label", value: name, loc: loc(start) });
        index = scan + 1;
        continue;
      }
      push({ kind: "name", value: name, loc: loc(start) });
      index = scan;
      continue;
    }
    const punctuator = PUNCTUATORS.find((candidate) =>
      text.startsWith(candidate, index),
    );
    if (punctuator) {
      push({ kind: "punct", value: punctuator, loc: loc(start) });
      index += punctuator.length;
      continue;
    }
    index++;
  }
  return { tokens, truncated };
}

export type RubyParse = {
  tokens: readonly RubyToken[];
  truncated: boolean;
  limits: RubyLimits;
};

export function parseRubySource(
  text: string,
  limits: RubyLimits = RUBY_LIMITS,
): RubyParse {
  const { tokens, truncated } = tokenizeRuby(text, limits);
  return { tokens, truncated, limits };
}

type State = {
  tokens: readonly RubyToken[];
  limits: RubyLimits;
  nodes: number;
  truncated: boolean;
};

const isPunct = (token: RubyToken | undefined, value: string): boolean =>
  token?.kind === "punct" && token.value === value;

const FALLBACK: RubyLoc = { line: 0, column: 0 };

/** Skips a balanced bracket run; returns the index after the closing bracket. */
function skipBrackets(state: State, index: number): number {
  const pairs: Record<string, string> = { "{": "}", "[": "]", "(": ")" };
  const opener = state.tokens[index];
  if (opener?.kind !== "punct" || pairs[opener.value] === undefined)
    return index + 1;
  let depth = 0;
  let scan = index;
  while (scan < state.tokens.length) {
    const token = state.tokens[scan]!;
    if (token.kind === "punct") {
      if (["{", "[", "("].includes(token.value)) depth++;
      else if (["}", "]", ")"].includes(token.value)) {
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
 * Skips from a `do` (or another block opener) to its matching `end`. Modifier
 * `if`/`unless`/`while`/`until` open nothing, so only a statement-initial one
 * counts — that is what `startsLine` is for.
 */
function skipToEnd(state: State, index: number): number {
  let depth = 0;
  let scan = index;
  while (scan < state.tokens.length) {
    const token = state.tokens[scan]!;
    if (token.kind === "name") {
      if (BLOCK_OPENERS.has(token.value)) depth++;
      else if (CONDITIONAL_OPENERS.has(token.value) && token.startsLine)
        depth++;
      else if (token.value === "end") {
        depth--;
        if (depth === 0) return scan + 1;
      }
    } else if (
      token.kind === "punct" &&
      ["{", "[", "("].includes(token.value)
    ) {
      scan = skipBrackets(state, scan);
      continue;
    }
    scan++;
  }
  state.truncated = true;
  return state.tokens.length;
}

/** Skips one value that is not a literal, and says what kind of thing it was. */
function skipOpaque(
  state: State,
  index: number,
): { reason: RubyOpaqueReason; next: number } {
  const token = state.tokens[index];
  if (!token) return { reason: "truncated", next: index };
  if (token.kind === "heredoc") return { reason: "heredoc", next: index + 1 };
  if (token.kind === "percent")
    return { reason: "percent-literal", next: index + 1 };
  if (token.kind === "dynamic-string")
    return { reason: "interpolation", next: index + 1 };
  if (isPunct(token, "*") || isPunct(token, "**"))
    return { reason: "splat", next: skipOpaque(state, index + 1).next };
  if (isPunct(token, "->")) {
    let scan = index + 1;
    if (isPunct(state.tokens[scan], "(")) scan = skipBrackets(state, scan);
    if (isPunct(state.tokens[scan], "{"))
      return { reason: "lambda", next: skipBrackets(state, scan) };
    if (
      state.tokens[scan]?.kind === "name" &&
      state.tokens[scan]!.value === "do"
    )
      return { reason: "lambda", next: skipToEnd(state, scan) };
    return { reason: "lambda", next: scan };
  }
  if (token.kind === "name") {
    const isLambda = token.value === "lambda" || token.value === "proc";
    let scan = index + 1;
    if (isPunct(state.tokens[scan], "(")) scan = skipBrackets(state, scan);
    const next = state.tokens[scan];
    if (next?.kind === "name" && next.value === "do")
      return {
        reason: isLambda ? "lambda" : "block",
        next: skipToEnd(state, scan),
      };
    if (isPunct(next, "{"))
      return {
        reason: isLambda ? "lambda" : "block",
        next: skipBrackets(state, scan),
      };
    if (scan > index + 1) return { reason: "method-call", next: scan };
    if (isPunct(next, "["))
      return { reason: "reference", next: skipBrackets(state, scan) };
    if (isPunct(next, ".") || isPunct(next, "::")) {
      let chain = scan;
      while (chain < state.tokens.length) {
        const current = state.tokens[chain]!;
        if (isPunct(current, ".") || isPunct(current, "::")) {
          chain++;
          continue;
        }
        if (current.kind === "name") {
          chain++;
          if (isPunct(state.tokens[chain], "("))
            chain = skipBrackets(state, chain);
          continue;
        }
        break;
      }
      return { reason: "method-call", next: chain };
    }
    return { reason: "reference", next: index + 1 };
  }
  // Anything else: consume to the end of this value at bracket depth zero.
  let scan = index;
  while (scan < state.tokens.length) {
    const current = state.tokens[scan]!;
    if (current.kind === "punct") {
      if (["{", "[", "("].includes(current.value)) {
        scan = skipBrackets(state, scan);
        continue;
      }
      if (["}", "]", ")", ",", ";"].includes(current.value)) break;
    }
    if (current.kind === "name" && current.value === "end") break;
    scan++;
  }
  return { reason: "expression", next: scan === index ? index + 1 : scan };
}

function parseValue(
  state: State,
  index: number,
  depth: number,
): { value: RubyValue; next: number } {
  const token = state.tokens[index];
  if (!token)
    return {
      value: { kind: "opaque", reason: "truncated", loc: FALLBACK },
      next: index,
    };
  if (++state.nodes > state.limits.nodes || depth > state.limits.depth) {
    state.truncated = true;
    return {
      value: { kind: "opaque", reason: "truncated", loc: token.loc },
      next: skipOpaque(state, index).next,
    };
  }
  if (token.kind === "string") {
    // Adjacent literals concatenate in Ruby; hints are written that way.
    let value = token.value;
    let scan = index + 1;
    while (state.tokens[scan]?.kind === "string") {
      value = `${value}${state.tokens[scan]!.value}`.slice(
        0,
        state.limits.stringLength,
      );
      scan++;
    }
    return { value: { kind: "string", value, loc: token.loc }, next: scan };
  }
  if (token.kind === "symbol")
    return {
      value: { kind: "symbol", value: token.value, loc: token.loc },
      next: index + 1,
    };
  if (token.kind === "number")
    return {
      value: { kind: "number", value: token.numeric ?? 0, loc: token.loc },
      next: index + 1,
    };
  if (token.kind === "name") {
    if (token.value === "true" || token.value === "false")
      return {
        value: {
          kind: "boolean",
          value: token.value === "true",
          loc: token.loc,
        },
        next: index + 1,
      };
    if (token.value === "nil")
      return { value: { kind: "nil", loc: token.loc }, next: index + 1 };
  }
  if (isPunct(token, "-") && state.tokens[index + 1]?.kind === "number") {
    const numberToken = state.tokens[index + 1]!;
    return {
      value: {
        kind: "number",
        value: -(numberToken.numeric ?? 0),
        loc: token.loc,
      },
      next: index + 2,
    };
  }
  if (isPunct(token, "[")) {
    const items: RubyValue[] = [];
    let scan = index + 1;
    while (scan < state.tokens.length) {
      const current = state.tokens[scan];
      if (!current) break;
      if (isPunct(current, "]")) {
        scan++;
        break;
      }
      if (isPunct(current, ",")) {
        scan++;
        continue;
      }
      const parsed = parseValue(state, scan, depth + 1);
      items.push(parsed.value);
      scan = parsed.next === scan ? scan + 1 : parsed.next;
    }
    return { value: { kind: "array", items, loc: token.loc }, next: scan };
  }
  if (isPunct(token, "{")) {
    const entries: RubyEntry[] = [];
    let scan = index + 1;
    while (scan < state.tokens.length) {
      const current = state.tokens[scan];
      if (!current) break;
      if (isPunct(current, "}")) {
        scan++;
        break;
      }
      if (isPunct(current, ",") || isPunct(current, ";")) {
        scan++;
        continue;
      }
      let key: string | undefined;
      let valueIndex = scan;
      if (current.kind === "label") {
        key = current.value;
        valueIndex = scan + 1;
      } else if (
        (current.kind === "symbol" || current.kind === "string") &&
        isPunct(state.tokens[scan + 1], "=>")
      ) {
        key = current.value;
        valueIndex = scan + 2;
      }
      if (key === undefined) {
        const skipped = skipOpaque(state, scan);
        let next = skipped.next;
        if (isPunct(state.tokens[next], "=>"))
          next = parseValue(state, next + 1, depth + 1).next;
        entries.push({
          key: "",
          value: { kind: "opaque", reason: "expression", loc: current.loc },
          loc: current.loc,
        });
        scan = next === scan ? scan + 1 : next;
        continue;
      }
      const parsed = parseValue(state, valueIndex, depth + 1);
      entries.push({ key, value: parsed.value, loc: current.loc });
      scan = parsed.next === scan ? scan + 1 : parsed.next;
    }
    return { value: { kind: "hash", entries, loc: token.loc }, next: scan };
  }
  const skipped = skipOpaque(state, index);
  return {
    value: { kind: "opaque", reason: skipped.reason, loc: token.loc },
    next: skipped.next === index ? index + 1 : skipped.next,
  };
}

/**
 * Reads the connector hash from Ruby source: the first top-level `{ … }`.
 * Anything before it (requires, constants, helper definitions) is skipped
 * without being read as behaviour.
 */
export function readRubyConnectorHash(parse: RubyParse): {
  value: RubyValue | undefined;
  truncated: boolean;
} {
  const state: State = {
    tokens: parse.tokens,
    limits: parse.limits,
    nodes: 0,
    truncated: false,
  };
  for (let index = 0; index < parse.tokens.length; index++) {
    const token = parse.tokens[index]!;
    if (!isPunct(token, "{")) continue;
    const previous = parse.tokens[index - 1];
    // A brace that follows a name or a closing bracket is a block, not a hash.
    if (
      previous &&
      (previous.kind === "name" ||
        (previous.kind === "punct" && [")", "]", "|"].includes(previous.value)))
    )
      continue;
    const parsed = parseValue(state, index, 1);
    if (parsed.value.kind === "hash" && parsed.value.entries.length)
      return {
        value: parsed.value,
        truncated: state.truncated || parse.truncated,
      };
  }
  return { value: undefined, truncated: state.truncated || parse.truncated };
}

/* Accessors. Each answers "is this a literal?" and returns undefined when not. */

export function hashEntry(
  value: RubyValue | undefined,
  key: string,
): RubyEntry | undefined {
  if (value?.kind !== "hash") return undefined;
  return value.entries.find((entry) => entry.key === key);
}

export function hashValue(
  value: RubyValue | undefined,
  key: string,
): RubyValue | undefined {
  return hashEntry(value, key)?.value;
}

export function rubyString(value: RubyValue | undefined): string | undefined {
  if (value?.kind === "string") return value.value;
  if (value?.kind === "symbol") return value.value;
  return undefined;
}

export function rubyBoolean(value: RubyValue | undefined): boolean | undefined {
  if (value?.kind === "boolean") return value.value;
  // Workato's own examples write `optional: "true"`; a quoted boolean is one.
  if (
    value?.kind === "string" &&
    (value.value === "true" || value.value === "false")
  )
    return value.value === "true";
  return undefined;
}

export function rubyNumber(value: RubyValue | undefined): number | undefined {
  return value?.kind === "number" ? value.value : undefined;
}

export function rubyArray(
  value: RubyValue | undefined,
): RubyValue[] | undefined {
  return value?.kind === "array" ? value.items : undefined;
}

export function rubyEntries(
  value: RubyValue | undefined,
): RubyEntry[] | undefined {
  return value?.kind === "hash" ? value.entries : undefined;
}

/** Converts a literal tree into plain JSON data; opaque nodes disappear. */
export function toJsonValue(value: RubyValue | undefined): unknown {
  switch (value?.kind) {
    case "string":
    case "symbol":
      return value.value;
    case "number":
      return value.value;
    case "boolean":
      return value.value;
    case "nil":
      return null;
    case "array":
      return value.items
        .map((item) => toJsonValue(item))
        .filter((item) => item !== undefined);
    case "hash": {
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

/** Wraps plain JSON (the static profile) in the same tree shape. */
export function fromJsonValue(
  value: unknown,
  loc: RubyLoc = FALLBACK,
): RubyValue {
  if (value === null) return { kind: "nil", loc };
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
    const source = value as Record<string, unknown>;
    // The static profile spells a Ruby lambda as `{"$lambda": true}`.
    if (source["$lambda"] === true)
      return { kind: "opaque", reason: "lambda", loc };
    const entries: RubyEntry[] = [];
    for (const key of Object.keys(source)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) continue;
      entries.push({ key, value: fromJsonValue(source[key], loc), loc });
    }
    return { kind: "hash", entries, loc };
  }
  return { kind: "opaque", reason: "expression", loc };
}

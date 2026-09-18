import { ConnectorError } from "../../errors.js";

/*
 * Bounded JSON reading for registry responses and uploaded server.json
 * documents. `JSON.parse` alone accepts documents of any depth, silently keeps
 * the last of two duplicate keys and happily creates own properties named
 * `__proto__`. A registry response is untrusted data, so the text is scanned
 * first: byte size, nesting depth, node count, duplicate keys and reserved
 * object keys are all refused before anything is materialized. The scanner
 * only tracks structure; `JSON.parse` still decides what is valid JSON.
 */

export type JsonBounds = {
  maxBytes: number;
  maxDepth: number;
  maxNodes: number;
};

export const DEFAULT_JSON_BOUNDS: JsonBounds = Object.freeze({
  maxBytes: 4 * 1024 * 1024,
  maxDepth: 32,
  maxNodes: 250_000,
});

const reservedKeys = new Set(["__proto__", "prototype", "constructor"]);

function invalid(detail: string): ConnectorError {
  return new ConnectorError("upstream-rejected", { detail });
}

type Frame = {
  kind: "object" | "array";
  keys?: Set<string>;
  expectKey: boolean;
};

/** Scans structure without building it; throws a sanitized ConnectorError on any violation. */
function scan(text: string, bounds: JsonBounds): void {
  const stack: Frame[] = [];
  let nodes = 0;
  let index = 0;
  const length = text.length;
  const node = () => {
    if (++nodes > bounds.maxNodes) throw invalid("json.nodes.exceeded");
  };
  while (index < length) {
    const char = text[index]!;
    if (char === '"') {
      const start = index + 1;
      let end = start;
      let escaped = false;
      for (; end < length; end++) {
        const c = text[end]!;
        if (c === "\\") {
          escaped = true;
          end++;
          continue;
        }
        if (c === '"') break;
      }
      if (end >= length) throw invalid("json.string.unterminated");
      const frame = stack[stack.length - 1];
      if (frame?.kind === "object" && frame.expectKey) {
        const raw = text.slice(start, end);
        let key: string;
        if (escaped) {
          try {
            key = JSON.parse(`"${raw}"`) as string;
          } catch {
            throw invalid("json.string.invalid");
          }
        } else key = raw;
        if (reservedKeys.has(key)) throw invalid("json.key.reserved");
        if (frame.keys!.has(key)) throw invalid("json.key.duplicate");
        frame.keys!.add(key);
        frame.expectKey = false;
      } else node();
      index = end + 1;
      continue;
    }
    if (char === "{" || char === "[") {
      node();
      if (stack.length + 1 > bounds.maxDepth)
        throw invalid("json.depth.exceeded");
      stack.push(
        char === "{"
          ? { kind: "object", keys: new Set(), expectKey: true }
          : { kind: "array", expectKey: false },
      );
      index++;
      continue;
    }
    if (char === "}" || char === "]") {
      stack.pop();
      index++;
      continue;
    }
    if (char === ",") {
      const frame = stack[stack.length - 1];
      if (frame?.kind === "object") frame.expectKey = true;
      index++;
      continue;
    }
    if (
      char === ":" ||
      char === " " ||
      char === "\n" ||
      char === "\r" ||
      char === "\t"
    ) {
      index++;
      continue;
    }
    // A literal or number: count it once and skip to its end.
    node();
    let end = index + 1;
    while (end < length && !",}] \n\r\t".includes(text[end]!)) end++;
    index = end;
  }
}

/** Parses untrusted JSON text within explicit bounds; the returned value has ordinary prototypes and no reserved keys. */
export function parseBoundedJson(
  text: string,
  bounds: JsonBounds = DEFAULT_JSON_BOUNDS,
): unknown {
  if (new TextEncoder().encode(text).byteLength > bounds.maxBytes)
    throw invalid("json.bytes.exceeded");
  scan(text, bounds);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalid("json.invalid");
  }
}

/** Decodes bytes as UTF-8 (fatal on malformed sequences) and parses within bounds. */
export function parseBoundedJsonBytes(
  bytes: Uint8Array,
  bounds: JsonBounds = DEFAULT_JSON_BOUNDS,
): unknown {
  if (bytes.byteLength > bounds.maxBytes) throw invalid("json.bytes.exceeded");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalid("json.encoding.invalid");
  }
  return parseBoundedJson(text, bounds);
}

import { measureJsonValue } from "../../../../core/connectors/json-bounds.js";
import { ConnectorError } from "../../errors.js";

/*
 * Bounded reading of untrusted JSON. A connector response carries a
 * customer's own external system data and schema metadata, so it
 * is imported data, not a trusted answer: it is size-bound
 * before decoding, scanned for duplicate and reserved keys before it is
 * materialized, and structurally measured afterwards.
 */

export type JsonBounds = {
  maxBytes: number;
  maxDepth: number;
  maxNodes: number;
  maxStringLength: number;
};

export const DEFAULT_GOOGLE_CONNECTORS_JSON_BOUNDS: JsonBounds = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxDepth: 32,
  maxNodes: 200_000,
  maxStringLength: 512 * 1024,
});

const reservedKeys = new Set(["__proto__", "prototype", "constructor"]);

function invalid(detail: string): ConnectorError {
  return new ConnectorError("upstream-rejected", { detail });
}

/** Rejects duplicate and reserved object keys, which `JSON.parse` would silently resolve. */
function scanKeys(text: string): void {
  const stack: Array<{ object: boolean; keys: Set<string>; key: boolean }> = [];
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === '"') {
      const start = index + 1;
      let end = start;
      let escaped = false;
      for (; end < text.length; end++) {
        if (text[end] === "\\") {
          escaped = true;
          end++;
          continue;
        }
        if (text[end] === '"') break;
      }
      if (end >= text.length) throw invalid("json.string.unterminated");
      const frame = stack[stack.length - 1];
      if (frame?.object && frame.key) {
        const raw = text.slice(start, end);
        let key: string;
        if (escaped)
          try {
            key = JSON.parse(`"${raw}"`) as string;
          } catch {
            throw invalid("json.string.invalid");
          }
        else key = raw;
        if (reservedKeys.has(key)) throw invalid("json.key.reserved");
        if (frame.keys.has(key)) throw invalid("json.key.duplicate");
        frame.keys.add(key);
        frame.key = false;
      }
      index = end;
      continue;
    }
    if (char === "{" || char === "[")
      stack.push({ object: char === "{", keys: new Set(), key: char === "{" });
    else if (char === "}" || char === "]") stack.pop();
    else if (char === ",") {
      const frame = stack[stack.length - 1];
      if (frame?.object) frame.key = true;
    }
  }
}

export function parseBoundedJsonText(
  text: string,
  bounds: JsonBounds = DEFAULT_GOOGLE_CONNECTORS_JSON_BOUNDS,
): unknown {
  if (new TextEncoder().encode(text).byteLength > bounds.maxBytes)
    throw invalid("json.bytes.exceeded");
  scanKeys(text);
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw invalid("json.invalid");
  }
  const measured = measureJsonValue(value, {
    depth: bounds.maxDepth,
    nodes: bounds.maxNodes,
    bytes: bounds.maxBytes,
    stringLength: bounds.maxStringLength,
  });
  if (!measured.ok) throw invalid(`json.bounds.${measured.reason}`);
  return value;
}

export function parseBoundedJsonBytes(
  bytes: Uint8Array,
  bounds: JsonBounds = DEFAULT_GOOGLE_CONNECTORS_JSON_BOUNDS,
): unknown {
  if (bytes.byteLength > bounds.maxBytes) throw invalid("json.bytes.exceeded");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalid("json.encoding.invalid");
  }
  return parseBoundedJsonText(text, bounds);
}

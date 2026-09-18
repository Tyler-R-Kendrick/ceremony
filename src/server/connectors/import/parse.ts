import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import {
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseAllDocuments,
  type Document,
  type Node,
  type Scalar,
  type YAMLMap,
  type YAMLSeq,
} from "yaml";
import { isReservedObjectKey } from "../../../core/connectors/index.js";
import { ConnectorError } from "../errors.js";
import { resolveParseLimits, type ParseLimits } from "./limits.js";

/*
 * Bounded JSON and YAML reading for untrusted connector descriptions.
 *
 * Two parsers are reachable from here and neither can execute anything: the
 * JSON path is a strict RFC 8259 scanner followed by JSON.parse, and the YAML
 * path is the `yaml` library pinned to the YAML 1.2 core schema with no custom
 * tags, no merge keys, no known-tag resolution and no 1.1 fallbacks. Format
 * detection only ever chooses between those two. Every bound is enforced twice
 * where it matters: once in the reader (before an object graph exists) and
 * once in a final walk that rebuilds the graph from plain objects, so nothing
 * a parser produced reaches a caller unchecked.
 *
 * Failures carry sanitized codes only. Document text, key names, values and
 * parser messages (which quote the offending line) never enter an error.
 */

export type DocumentFormat = "json" | "yaml";
export type DocumentEncoding = "identity" | "gzip" | "deflate" | "br";

export type ParseDocumentOptions = {
  /** Declared media type; authoritative when specific, sniffed only when generic or absent. */
  mediaType?: string | undefined;
  /** Upload file name; only its extension is consulted, and only for generic media types. */
  fileName?: string | undefined;
  /** Transfer encoding a transport reported; compressed input is refused unless limits allow it. */
  contentEncoding?: string | undefined;
  limits?: Partial<ParseLimits> | undefined;
  /** Clock for the parse-time bound; tests inject a deterministic one. */
  now?: (() => number) | undefined;
};

export type ParseStats = {
  nodes: number;
  depth: number;
  aliases: number;
  anchors: number;
  parseMs: number;
};

export type ParsedDocument = {
  /** A fresh graph of plain objects, arrays and finite scalars; never the parser's own output. */
  value: unknown;
  format: DocumentFormat;
  /** The bytes that were parsed (decoded when compression was allowed). */
  bytes: Uint8Array;
  byteLength: number;
  /** SHA-256 of `bytes`, the exact-byte identity of the captured document. */
  digest: string;
  encoding: DocumentEncoding;
  stats: ParseStats;
};

const fail = (detail: string): never => {
  throw new ConnectorError("invalid-request", { detail });
};

// Any control character except tab, newline and carriage return, in raw text,
// in string values and in keys. Matches the core safeText/identifier rules.
const forbiddenControl = /[^\P{Cc}\t\n\r]/u;

const jsonMediaTypes = new Set([
  "application/json",
  "text/json",
  "application/schema+json",
  "application/openapi+json",
  "application/vnd.oai.openapi+json",
  "application/vnd.aai.asyncapi+json",
]);
const yamlMediaTypes = new Set([
  "application/yaml",
  "application/x-yaml",
  "text/yaml",
  "text/x-yaml",
  "text/vnd.yaml",
  "application/openapi+yaml",
  "application/vnd.oai.openapi",
  "application/vnd.oai.openapi+yaml",
  "application/vnd.aai.asyncapi",
  "application/vnd.aai.asyncapi+yaml",
]);
const genericMediaTypes = new Set([
  "",
  "application/octet-stream",
  "text/plain",
  "application/gzip",
  "application/x-gzip",
]);

/** Lower-cased media type without parameters; "" for absent or unparsable input. */
export function normalizeMediaType(value: string | undefined): string {
  if (typeof value !== "string") return "";
  const type = value.split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type) ? type : "";
}

/**
 * Chooses the reader. A specific declared type wins and is never second
 * guessed; a generic or missing type falls back to the file extension, then to
 * the first significant character. Anything else is refused rather than
 * guessed, because a guess is how an unexpected parser gets activated.
 */
export function detectDocumentFormat(input: {
  mediaType?: string | undefined;
  fileName?: string | undefined;
  text: string;
}): DocumentFormat {
  const type = normalizeMediaType(input.mediaType);
  if (jsonMediaTypes.has(type) || type.endsWith("+json")) return "json";
  if (yamlMediaTypes.has(type) || type.endsWith("+yaml")) return "yaml";
  if (!genericMediaTypes.has(type)) return fail("document.media-type-unsupported");
  const extension = input.fileName?.toLowerCase().match(/\.([a-z0-9]{1,8})$/)?.[1];
  if (extension === "json") return "json";
  if (extension === "yaml" || extension === "yml") return "yaml";
  const first = input.text.match(/^[\s]*(\S)/u)?.[1];
  return first === "{" || first === "[" ? "json" : "yaml";
}

/** Validates an upload file name as a hint: bounded, printable, no path meaning. */
export function assertSafeFileName(name: string): string {
  if (
    typeof name !== "string" ||
    name.length < 1 ||
    name.length > 255 ||
    /[\\/\p{Cc}]/u.test(name) ||
    name === "." ||
    name === ".." ||
    name.trim() !== name ||
    name.trim().length === 0
  )
    return fail("document.file-name-invalid");
  return name;
}

function detectEncoding(
  bytes: Uint8Array,
  contentEncoding: string | undefined,
  mediaType: string,
): DocumentEncoding {
  const declared = contentEncoding?.trim().toLowerCase() ?? "";
  if (declared === "gzip" || declared === "x-gzip") return "gzip";
  if (declared === "deflate") return "deflate";
  if (declared === "br") return "br";
  if (declared !== "" && declared !== "identity")
    return fail("document.encoding-unsupported");
  if (mediaType === "application/gzip" || mediaType === "application/x-gzip")
    return "gzip";
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return "gzip";
  return "identity";
}

/**
 * Decompresses with the decoded size capped at the byte ceiling. zlib stops
 * producing output at `maxOutputLength`, so a small body that inflates past
 * the limit costs the limit, not the inflated size.
 */
function inflateBounded(
  bytes: Uint8Array,
  encoding: Exclude<DocumentEncoding, "identity">,
  limits: ParseLimits,
): Uint8Array {
  if (!limits.allowCompressed) return fail("document.compressed-refused");
  try {
    const options = { maxOutputLength: limits.maxBytes };
    const out =
      encoding === "gzip"
        ? gunzipSync(bytes, options)
        : encoding === "deflate"
          ? inflateSync(bytes, options)
          : brotliDecompressSync(bytes, options);
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE")
      return fail("document.decoded-too-large");
    return fail("document.decompression-failed");
  }
}

function decodeText(bytes: Uint8Array): string {
  if (
    bytes.length >= 2 &&
    ((bytes[0] === 0xff && bytes[1] === 0xfe) ||
      (bytes[0] === 0xfe && bytes[1] === 0xff))
  )
    return fail("document.encoding-unsupported");
  try {
    // ignoreBOM defaults to false, which strips a leading UTF-8 byte order mark.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("document.invalid-utf8");
  }
}

const checkString = (value: string, limits: ParseLimits): void => {
  if (value.length > limits.maxStringLength) fail("document.string-too-long");
  if (forbiddenControl.test(value)) fail("document.control-characters");
};
const checkKey = (key: string, limits: ParseLimits): void => {
  if (key.length > limits.maxKeyLength) fail("document.key-too-long");
  if (isReservedObjectKey(key)) fail("document.reserved-key");
  if (forbiddenControl.test(key)) fail("document.control-characters");
};

/*
 * JSON duplicate keys: JSON.parse keeps the last value of a repeated member
 * and gives no signal, and a reviver cannot help because it is called once per
 * surviving member after the collapse has already happened. The only way to
 * see a duplicate is to read the text. This strict scanner validates the full
 * RFC 8259 grammar, tracks depth and node counts, measures strings and keys,
 * and keeps the decoded keys of each object in a set. It builds no values;
 * JSON.parse produces the graph afterwards from text the scanner has already
 * accepted, so the scanner is a gate, not a second parser, and the graph is
 * then rebuilt from plain objects in `sanitizeGraph`. Recursion depth is
 * bounded by `maxDepth` before descending, so a deeply nested input fails
 * quickly instead of exhausting the stack.
 */
function scanJson(
  text: string,
  limits: ParseLimits,
): { nodes: number; depth: number } {
  let index = 0;
  let nodes = 0;
  let depth = 0;
  let maxDepth = 0;
  const length = text.length;
  const isDigit = (code: number) => code >= 0x30 && code <= 0x39;
  const skipWhitespace = () => {
    while (index < length) {
      const code = text.charCodeAt(index);
      if (code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09)
        index++;
      else break;
    }
  };
  const enter = () => {
    if (++depth > limits.maxDepth) fail("document.too-deep");
    if (depth > maxDepth) maxDepth = depth;
  };
  const leave = () => {
    depth--;
  };
  const readString = (isKey: boolean): string => {
    index++;
    const parts: string[] = [];
    let run = index;
    let count = 0;
    for (;;) {
      if (index >= length) fail("json.syntax");
      const code = text.charCodeAt(index);
      if (code === 0x22) {
        if (isKey) parts.push(text.slice(run, index));
        index++;
        break;
      }
      if (code === 0x5c) {
        if (isKey) parts.push(text.slice(run, index));
        index++;
        if (index >= length) fail("json.syntax");
        let char: string;
        switch (text[index]) {
          case '"':
            char = '"';
            break;
          case "\\":
            char = "\\";
            break;
          case "/":
            char = "/";
            break;
          case "b":
            char = "\b";
            break;
          case "f":
            char = "\f";
            break;
          case "n":
            char = "\n";
            break;
          case "r":
            char = "\r";
            break;
          case "t":
            char = "\t";
            break;
          case "u": {
            const hex = text.slice(index + 1, index + 5);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("json.syntax");
            char = String.fromCharCode(Number.parseInt(hex, 16));
            index += 4;
            break;
          }
          default:
            return fail("json.syntax");
        }
        index++;
        count++;
        if (isKey) parts.push(char);
        run = index;
        continue;
      }
      if (code < 0x20) fail("json.syntax");
      index++;
      count++;
    }
    if (count > (isKey ? limits.maxKeyLength : limits.maxStringLength))
      fail(isKey ? "document.key-too-long" : "document.string-too-long");
    return isKey ? parts.join("") : "";
  };
  const readNumber = () => {
    if (text[index] === "-") index++;
    if (text[index] === "0") index++;
    else if (isDigit(text.charCodeAt(index))) {
      while (isDigit(text.charCodeAt(index))) index++;
    } else fail("json.syntax");
    if (text[index] === ".") {
      index++;
      if (!isDigit(text.charCodeAt(index))) fail("json.syntax");
      while (isDigit(text.charCodeAt(index))) index++;
    }
    if (text[index] === "e" || text[index] === "E") {
      index++;
      if (text[index] === "+" || text[index] === "-") index++;
      if (!isDigit(text.charCodeAt(index))) fail("json.syntax");
      while (isDigit(text.charCodeAt(index))) index++;
    }
  };
  const readLiteral = (word: string) => {
    if (text.startsWith(word, index)) index += word.length;
    else fail("json.syntax");
  };
  const readValue = (): void => {
    skipWhitespace();
    if (index >= length) fail("json.syntax");
    if (++nodes > limits.maxNodes) fail("document.too-many-nodes");
    switch (text[index]) {
      case "{":
        readObject();
        return;
      case "[":
        readArray();
        return;
      case '"':
        readString(false);
        return;
      case "t":
        readLiteral("true");
        return;
      case "f":
        readLiteral("false");
        return;
      case "n":
        readLiteral("null");
        return;
      default:
        readNumber();
    }
  };
  const readObject = () => {
    enter();
    index++;
    skipWhitespace();
    if (text[index] === "}") {
      index++;
      leave();
      return;
    }
    const keys = new Set<string>();
    for (;;) {
      skipWhitespace();
      if (text[index] !== '"') fail("json.syntax");
      const key = readString(true);
      if (isReservedObjectKey(key)) fail("document.reserved-key");
      if (keys.has(key)) fail("json.duplicate-key");
      keys.add(key);
      if (keys.size > limits.maxKeysPerObject) fail("document.too-many-keys");
      skipWhitespace();
      if (text[index] !== ":") fail("json.syntax");
      index++;
      readValue();
      skipWhitespace();
      if (text[index] === ",") {
        index++;
        continue;
      }
      if (text[index] === "}") {
        index++;
        leave();
        return;
      }
      fail("json.syntax");
    }
  };
  const readArray = () => {
    enter();
    index++;
    skipWhitespace();
    if (text[index] === "]") {
      index++;
      leave();
      return;
    }
    for (;;) {
      readValue();
      skipWhitespace();
      if (text[index] === ",") {
        index++;
        continue;
      }
      if (text[index] === "]") {
        index++;
        leave();
        return;
      }
      fail("json.syntax");
    }
  };
  readValue();
  skipWhitespace();
  if (index !== length) fail("json.syntax");
  return { nodes, depth: maxDepth };
}

// Explicit tags a document may carry: the YAML 1.2 core schema and the
// non-specific tag. `!!binary`, `!!timestamp`, `!!omap`, `!!set`, `!!pairs`,
// local tags and every language-specific tag are refused, even though the
// library would merely warn and keep the text.
const allowedYamlTags = new Set([
  "!",
  "tag:yaml.org,2002:str",
  "tag:yaml.org,2002:int",
  "tag:yaml.org,2002:float",
  "tag:yaml.org,2002:bool",
  "tag:yaml.org,2002:null",
  "tag:yaml.org,2002:map",
  "tag:yaml.org,2002:seq",
]);

const yamlProblemDetails: Readonly<Record<string, string>> = Object.freeze({
  DUPLICATE_KEY: "yaml.duplicate-key",
  NON_STRING_KEY: "yaml.non-string-key",
  KEY_OVER_1024_CHARS: "yaml.key-too-long",
  RESOURCE_EXHAUSTION: "yaml.resource-exhaustion",
  TAG_RESOLVE_FAILED: "yaml.tag-unsupported",
  BAD_COLLECTION_TYPE: "yaml.tag-unsupported",
  MULTIPLE_DOCS: "yaml.multiple-documents",
  BAD_DIRECTIVE: "yaml.directive-unsupported",
});

type YamlInspection = {
  nodes: number;
  depth: number;
  aliases: number;
  anchors: number;
};

/**
 * Walks the composed YAML tree before any JavaScript value exists. Aliases are
 * resolved the way the library resolves them (the latest earlier anchor in
 * document order), an alias into an ancestor is refused as circular, and the
 * size each alias would add is summed without expanding anything, so a
 * document whose expansion would exceed the node ceiling is refused before
 * expansion is attempted.
 */
function inspectYaml(
  document: Document.Parsed,
  limits: ParseLimits,
): YamlInspection {
  const anchors = new Map<string, Node>();
  const sizes = new Map<Node, number>();
  const active = new Set<Node>();
  const stats: YamlInspection = { nodes: 0, depth: 0, aliases: 0, anchors: 0 };
  const walk = (node: unknown, depth: number): number => {
    if (node === null || node === undefined) return 0;
    if (!isNode(node)) return fail("yaml.syntax");
    if (++stats.nodes > limits.maxNodes) fail("document.too-many-nodes");
    if (isAlias(node)) {
      if (++stats.aliases > limits.maxAliases) fail("yaml.too-many-aliases");
      const target = anchors.get(node.source);
      if (!target) return fail("yaml.unresolved-alias");
      if (active.has(target)) return fail("yaml.circular-alias");
      return sizes.get(target) ?? 1;
    }
    const tagged = node as Scalar | YAMLMap | YAMLSeq;
    if (tagged.tag !== undefined && !allowedYamlTags.has(tagged.tag))
      fail("yaml.tag-unsupported");
    if (node.anchor !== undefined) {
      if (++stats.anchors > limits.maxAnchors) fail("yaml.too-many-anchors");
      anchors.set(node.anchor, node);
    }
    let size = 1;
    if (isScalar(node)) {
      if (typeof node.value === "string") checkString(node.value, limits);
    } else {
      const level = depth + 1;
      if (level > limits.maxDepth) fail("document.too-deep");
      if (level > stats.depth) stats.depth = level;
      active.add(node);
      if (isSeq(node)) {
        for (const item of node.items) size += walk(item, level);
      } else if (isMap(node)) {
        if (node.items.length > limits.maxKeysPerObject)
          fail("document.too-many-keys");
        for (const pair of node.items) {
          const key = pair.key as unknown;
          if (!isScalar(key) || typeof key.value !== "string")
            return fail("yaml.non-string-key");
          if (key.value === "<<") return fail("yaml.merge-key-unsupported");
          checkKey(key.value, limits);
          size += walk(key, level) + walk(pair.value, level);
        }
      } else return fail("yaml.syntax");
      active.delete(node);
    }
    if (size > limits.maxNodes) fail("yaml.alias-expansion-exceeds-bounds");
    sizes.set(node, size);
    return size;
  };
  walk(document.contents, 0);
  return stats;
}

function parseYaml(
  text: string,
  limits: ParseLimits,
): { value: unknown; stats: YamlInspection } {
  let documents: ReturnType<typeof parseAllDocuments>;
  try {
    documents = parseAllDocuments(text, {
      schema: "core",
      version: "1.2",
      merge: false,
      resolveKnownTags: false,
      uniqueKeys: true,
      stringKeys: true,
      strict: true,
      intAsBigInt: false,
      keepSourceTokens: false,
      prettyErrors: false,
      logLevel: "silent",
    });
  } catch {
    return fail("yaml.syntax");
  }
  // parseDocument only reports a second document when logging is enabled;
  // counting the stream is deterministic.
  if ("empty" in documents || documents.length === 0) return fail("document.empty");
  if (documents.length > 1) return fail("yaml.multiple-documents");
  const document = documents[0] as Document.Parsed;
  const directive = document.directives?.yaml;
  if (directive?.explicit && directive.version !== "1.2")
    return fail("yaml.version-unsupported");
  // Warnings are refusals too: an unresolved tag is kept as text by the
  // library, which is exactly the silent reinterpretation import must not do.
  const problem = document.errors[0] ?? document.warnings[0];
  if (problem) return fail(yamlProblemDetails[problem.code] ?? "yaml.syntax");
  const stats = inspectYaml(document, limits);
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: limits.maxAliasCount });
  } catch (error) {
    return fail(
      error instanceof ReferenceError
        ? "yaml.alias-expansion-exceeds-bounds"
        : "yaml.syntax",
    );
  }
  return { value, stats };
}

/**
 * Rebuilds a parsed graph from plain objects while enforcing every bound. The
 * copy has `Object.prototype` objects with verified own data keys and no
 * shared references, so a value an alias produced twice becomes two values
 * and a caller mutating one place cannot change another. Numbers must be
 * finite (YAML `.inf`/`.nan` cannot round-trip through JSON), strings and keys
 * must be printable, and a cycle or a foreign prototype is refused rather than
 * copied.
 */
export function sanitizeGraph(
  root: unknown,
  overrides: Partial<ParseLimits> = {},
): { value: unknown; nodes: number; depth: number } {
  const limits = resolveParseLimits(overrides);
  let nodes = 0;
  let maxDepth = 0;
  const ancestors = new Set<object>();
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > limits.maxNodes) fail("document.too-many-nodes");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      checkString(value, limits);
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) fail("document.non-finite-number");
      return value;
    }
    if (typeof value !== "object") return fail("document.unsupported-value");
    if (ancestors.has(value)) return fail("document.circular-structure");
    const level = depth + 1;
    if (level > limits.maxDepth) fail("document.too-deep");
    if (level > maxDepth) maxDepth = level;
    ancestors.add(value);
    let copy: unknown;
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype)
        fail("document.prototype-tampered");
      const out: unknown[] = [];
      for (let i = 0; i < value.length; i++) out.push(visit(value[i], level));
      copy = out;
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        fail("document.prototype-tampered");
      for (const name of Object.getOwnPropertyNames(value))
        if (isReservedObjectKey(name)) fail("document.reserved-key");
      const keys = Object.keys(value);
      if (keys.length > limits.maxKeysPerObject) fail("document.too-many-keys");
      const out: Record<string, unknown> = {};
      for (const key of keys) {
        checkKey(key, limits);
        out[key] = visit((value as Record<string, unknown>)[key], level);
      }
      copy = out;
    }
    ancestors.delete(value);
    return copy;
  };
  return { value: visit(root, 0), nodes, depth: maxDepth };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Reads one JSON or YAML document within bounds; see the module comment. */
export function parseBoundedDocument(
  bytes: Uint8Array,
  options: ParseDocumentOptions = {},
): ParsedDocument {
  const limits = resolveParseLimits(options.limits);
  const now = options.now ?? (() => performance.now());
  const started = now();
  if (!(bytes instanceof Uint8Array)) return fail("document.invalid-input");
  if (bytes.byteLength === 0) return fail("document.empty");
  if (bytes.byteLength > limits.maxBytes) return fail("document.too-large");
  const fileName =
    options.fileName === undefined
      ? undefined
      : assertSafeFileName(options.fileName);
  const mediaType = normalizeMediaType(options.mediaType);
  const encoding = detectEncoding(bytes, options.contentEncoding, mediaType);
  const decoded =
    encoding === "identity" ? bytes : inflateBounded(bytes, encoding, limits);
  if (decoded.byteLength === 0) return fail("document.empty");
  const text = decodeText(decoded);
  if (forbiddenControl.test(text)) return fail("document.control-characters");
  const format = detectDocumentFormat({ mediaType, fileName, text });
  let raw: unknown;
  let aliases = 0;
  let anchors = 0;
  if (format === "json") {
    scanJson(text, limits);
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      return fail("json.syntax");
    }
  } else {
    const parsed = parseYaml(text, limits);
    raw = parsed.value;
    aliases = parsed.stats.aliases;
    anchors = parsed.stats.anchors;
  }
  const clean = sanitizeGraph(raw, limits);
  const parseMs = now() - started;
  if (parseMs > limits.maxParseMs) return fail("document.parse-timeout");
  return {
    value: clean.value,
    format,
    bytes: decoded,
    byteLength: decoded.byteLength,
    digest: sha256Hex(decoded),
    encoding,
    stats: {
      nodes: clean.nodes,
      depth: clean.depth,
      aliases,
      anchors,
      parseMs: Math.round(parseMs),
    },
  };
}

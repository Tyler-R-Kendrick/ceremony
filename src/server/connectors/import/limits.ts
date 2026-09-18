import { DEFINITION_LIMITS } from "../../../core/connectors/index.js";
import { ConnectorError } from "../errors.js";

/*
 * Every bound an imported document is held to, in one place, with the reason
 * for each number. A limit is a promise about worst-case resource use, so the
 * defaults are sized for the largest documents a connector import can
 * legitimately need rather than for the largest documents that exist.
 */

export type ParseLimits = {
  /** Ceiling on the bytes accepted, and on decoded bytes when compression is allowed. */
  maxBytes: number;
  /** Deepest container nesting; recursion in every walker is bounded by it. */
  maxDepth: number;
  /** Total values (containers and scalars) after any alias expansion. */
  maxNodes: number;
  /** Members in one mapping. */
  maxKeysPerObject: number;
  /** UTF-16 length of one string value. */
  maxStringLength: number;
  /** UTF-16 length of one mapping key. */
  maxKeyLength: number;
  /** Alias nodes in one YAML document. */
  maxAliases: number;
  /** Anchors in one YAML document. */
  maxAnchors: number;
  /** The yaml library's alias amplification budget (`maxAliasCount`). */
  maxAliasCount: number;
  /** Wall-clock budget; exceeding it rejects the document after the fact. */
  maxParseMs: number;
  /** Compressed input is refused unless a caller opts in; decoded bytes then count toward `maxBytes`. */
  allowCompressed: boolean;
};

export const DEFAULT_PARSE_LIMITS: Readonly<ParseLimits> = Object.freeze({
  // The core definition envelope is bounded at 4 MiB; a source that cannot be
  // described within that is split upstream, not admitted here.
  maxBytes: DEFINITION_LIMITS.bytes,
  // Real OpenAPI and AsyncAPI documents nest schema composition well under
  // fifty levels; 128 keeps headroom while every recursive walker stays shallow.
  maxDepth: 128,
  // A 4 MiB minified JSON document cannot hold more than about two million
  // tokens; one million values keeps the post-parse walk and digest fast.
  maxNodes: 1_000_000,
  // The largest public APIs declare a few thousand paths under one object.
  maxKeysPerObject: 10_000,
  // Long CommonMark descriptions and embedded examples fit; the byte ceiling
  // bounds the total either way.
  maxStringLength: 1024 * 1024,
  // YAML already refuses implicit keys over 1024 characters; JSON gets parity.
  maxKeyLength: 1024,
  // Connector descriptions use anchors sparingly; 256 is generous and keeps
  // alias bookkeeping trivial.
  maxAliases: 256,
  maxAnchors: 256,
  // The yaml library's own amplification guard, at its documented default.
  maxAliasCount: 100,
  // A hard bound on time spent per document once the structural bounds above
  // have already made pathological inputs impossible.
  maxParseMs: 5_000,
  allowCompressed: false,
});

const CEILINGS = Object.freeze({
  // sourceRecordSchema caps byteLength at 64 MiB.
  maxBytes: 64 * 1024 * 1024,
  maxDepth: 1024,
  maxNodes: 8_000_000,
  maxKeysPerObject: 100_000,
  maxStringLength: 64 * 1024 * 1024,
  maxKeyLength: 64 * 1024,
  maxAliases: 10_000,
  maxAnchors: 10_000,
  maxAliasCount: 10_000,
  maxParseMs: 120_000,
});

/** Merges caller limits over the defaults and refuses anything unbounded or oversized. */
export function resolveParseLimits(
  overrides: Partial<ParseLimits> = {},
): ParseLimits {
  const limits: ParseLimits = { ...DEFAULT_PARSE_LIMITS };
  for (const key of Object.keys(CEILINGS) as Array<keyof typeof CEILINGS>) {
    const value = overrides[key];
    if (value === undefined) continue;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > CEILINGS[key]
    )
      throw new ConnectorError("invalid-request", {
        detail: "document.limits-invalid",
      });
    limits[key] = value;
  }
  if (overrides.allowCompressed !== undefined) {
    if (typeof overrides.allowCompressed !== "boolean")
      throw new ConnectorError("invalid-request", {
        detail: "document.limits-invalid",
      });
    limits.allowCompressed = overrides.allowCompressed;
  }
  return limits;
}

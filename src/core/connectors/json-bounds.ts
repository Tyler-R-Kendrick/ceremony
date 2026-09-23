import type { z } from "zod";

/*
 * Inert JSON that a description carries verbatim — native extensions, vendor
 * metadata, adapter state — is bounded structurally before anything
 * canonicalizes, digests or persists it. The walk is iterative, so hostile
 * depth exhausts a counter rather than the stack, and it runs on the raw
 * input, so a reserved key is refused instead of being silently dropped by a
 * copying parser.
 */

export const JSON_VALUE_LIMITS = Object.freeze({
  depth: 16,
  nodes: 4096,
  bytes: 128 * 1024,
  stringLength: 8192,
});
export type JsonValueLimits = {
  readonly depth: number;
  readonly nodes: number;
  readonly bytes: number;
  readonly stringLength: number;
};
export type JsonMeasure = { depth: number; nodes: number; bytes: number };
export type JsonBoundsReason =
  "depth" | "nodes" | "bytes" | "string-length" | "reserved-key" | "not-json";
export type JsonBoundsResult =
  | { ok: true; measure: JsonMeasure }
  | { ok: false; reason: JsonBoundsReason; measure: JsonMeasure };

const reservedKeys = new Set(["__proto__", "prototype", "constructor"]);

/** Keys that alias Object.prototype machinery; never data, whatever the source says. */
export function isReservedObjectKey(key: string): boolean {
  return reservedKeys.has(key);
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Measures a value the way its JSON text would measure: `bytes` approximates
 * UTF-16 length without escapes, so it bounds the shape rather than reporting
 * an exact serialization size. Fails at the first exceeded limit.
 */
export function measureJsonValue(
  value: unknown,
  limits: JsonValueLimits = JSON_VALUE_LIMITS,
): JsonBoundsResult {
  const measure: JsonMeasure = { depth: 0, nodes: 0, bytes: 0 };
  const fail = (reason: JsonBoundsReason): JsonBoundsResult => ({
    ok: false,
    reason,
    measure,
  });
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  while (stack.length) {
    const { value: current, depth } = stack.pop()!;
    measure.nodes++;
    if (measure.nodes > limits.nodes) return fail("nodes");
    measure.depth = Math.max(measure.depth, depth);
    if (depth > limits.depth) return fail("depth");
    if (current === null) measure.bytes += 4;
    else if (typeof current === "string") {
      if (current.length > limits.stringLength) return fail("string-length");
      measure.bytes += current.length + 2;
    } else if (typeof current === "number") {
      if (!Number.isFinite(current)) return fail("not-json");
      measure.bytes += String(current).length;
    } else if (typeof current === "boolean") measure.bytes += current ? 4 : 5;
    else if (Array.isArray(current)) {
      measure.bytes += 2 + Math.max(0, current.length - 1);
      for (const item of current) stack.push({ value: item, depth: depth + 1 });
    } else if (typeof current === "object") {
      if (!isPlainObject(current)) return fail("not-json");
      const keys = Object.keys(current);
      measure.bytes += 2 + Math.max(0, keys.length - 1);
      for (const key of keys) {
        if (reservedKeys.has(key)) return fail("reserved-key");
        if (key.length > limits.stringLength) return fail("string-length");
        measure.bytes += key.length + 3;
        stack.push({
          value: (current as Record<string, unknown>)[key],
          depth: depth + 1,
        });
      }
    } else return fail("not-json");
    if (measure.bytes > limits.bytes) return fail("bytes");
  }
  return { ok: true, measure };
}

/**
 * A `z.preprocess` guard that validates raw input before a copying parser can
 * reshape it. Zod strips an own `__proto__` key from record output rather than
 * copying it, which is safe but silent; this refuses the document instead.
 */
export function boundedJsonGuard(
  limits: JsonValueLimits = JSON_VALUE_LIMITS,
  options: { maxKeys?: number } = {},
) {
  return (raw: unknown, ctx: z.RefinementCtx): unknown => {
    const result = measureJsonValue(raw, limits);
    if (!result.ok)
      ctx.addIssue({
        code: "custom",
        message: `JSON value exceeds bounds: ${result.reason}`,
      });
    else if (
      options.maxKeys !== undefined &&
      raw &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      Object.keys(raw).length > options.maxKeys
    )
      ctx.addIssue({ code: "custom", message: "JSON value has too many keys" });
    return raw;
  };
}

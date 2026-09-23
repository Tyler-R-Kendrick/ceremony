import type { ActorContext } from "./identity.js";

/**
 * Per-actor, per-tool token buckets for the MCP endpoint.
 *
 * The browser's routes are budgeted by `reserveRequest` in the store; the MCP
 * endpoint had nothing, so one chat client in a loop could drive a tool as
 * fast as the transport answered. This bounds how often one actor may call
 * one tool: each (tenant, subject, tool) has a bucket of `capacity` calls that
 * refills at `refillPerSecond`. The buckets live in this process, which is
 * the point: the check costs no store round trip and cannot itself be a
 * database load. It is a throttle on a model's pace, not a quota, so a
 * restart or a second instance resetting it is acceptable; the services
 * behind the tools keep their own durable limits where they have them.
 *
 * Keyed on subject rather than session, so a person's several chat clients
 * share one allowance instead of multiplying it.
 */

export type McpBucketPolicy = {
  /** Calls available at once; the burst. */
  capacity: number;
  /** Calls added back per second, up to `capacity`. */
  refillPerSecond: number;
};

export type McpRateLimitOptions = Partial<McpBucketPolicy> & {
  /** Per-tool policy by tool name, over the defaults above. */
  tools?: Readonly<Record<string, Partial<McpBucketPolicy>>>;
  /** Milliseconds; injectable so tests do not wait. */
  now?: () => number;
  /**
   * Most buckets held. Beyond it the least recently used is forgotten, so an
   * unbounded number of subjects cannot grow memory without bound; a
   * forgotten bucket starts full again.
   */
  maxBuckets?: number;
};

/** Thirty calls in a burst, then one every two seconds, per tool. */
export const defaultMcpBucketPolicy: Readonly<McpBucketPolicy> = Object.freeze({
  capacity: 30,
  refillPerSecond: 0.5,
});

export type McpRateDecision =
  { allowed: true } | { allowed: false; retryAfterSeconds: number };

type Bucket = { tokens: number; at: number };

function checkedPolicy(policy: McpBucketPolicy): McpBucketPolicy {
  if (
    !Number.isFinite(policy.capacity) ||
    policy.capacity < 1 ||
    !Number.isFinite(policy.refillPerSecond) ||
    policy.refillPerSecond <= 0
  )
    throw new Error("Invalid MCP rate limit");
  return policy;
}

export function createMcpRateLimiter(options: McpRateLimitOptions = {}) {
  const now = options.now ?? Date.now;
  const maxBuckets = options.maxBuckets ?? 10_000;
  if (!Number.isInteger(maxBuckets) || maxBuckets < 1)
    throw new Error("Invalid MCP rate limit");
  const base = checkedPolicy({
    capacity: options.capacity ?? defaultMcpBucketPolicy.capacity,
    refillPerSecond:
      options.refillPerSecond ?? defaultMcpBucketPolicy.refillPerSecond,
  });
  const perTool = new Map(
    Object.entries(options.tools ?? {}).map(([name, policy]) => [
      name,
      checkedPolicy({ ...base, ...policy }),
    ]),
  );
  // Insertion order is recency: a bucket is re-inserted on every use, so the
  // first key is always the least recently used.
  const buckets = new Map<string, Bucket>();

  return {
    /** Spends one call for this actor on this tool, or says how long to wait. */
    take(actor: ActorContext, tool: string): McpRateDecision {
      const policy = perTool.get(tool) ?? base;
      // JSON keeps the parts unambiguous whatever characters they hold.
      const key = JSON.stringify([actor.tenantId, actor.subjectId, tool]);
      const at = now();
      const prior = buckets.get(key);
      const elapsed = prior ? Math.max(0, at - prior.at) / 1000 : 0;
      const tokens = prior
        ? Math.min(
            policy.capacity,
            prior.tokens + elapsed * policy.refillPerSecond,
          )
        : policy.capacity;
      buckets.delete(key);
      if (tokens < 1) {
        buckets.set(key, { tokens, at });
        return {
          allowed: false,
          retryAfterSeconds: Math.max(
            1,
            Math.ceil((1 - tokens) / policy.refillPerSecond),
          ),
        };
      }
      buckets.set(key, { tokens: tokens - 1, at });
      while (buckets.size > maxBuckets)
        buckets.delete(buckets.keys().next().value!);
      return { allowed: true };
    },
    /** How many buckets are held; for tests and diagnostics. */
    get size() {
      return buckets.size;
    },
  };
}

export type McpRateLimiter = ReturnType<typeof createMcpRateLimiter>;

/**
 * The tool result a refused call gets: an error the model can act on, with
 * the wait in both the text and the structured content. It names only the
 * tool the caller already called.
 */
export function rateLimitedResult(tool: string, retryAfterSeconds: number) {
  const body = {
    error: "rate-limited" as const,
    tool,
    retryAfterSeconds,
  };
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          ...body,
          message: `Too many calls to ${tool}. Wait ${retryAfterSeconds} seconds before calling it again.`,
        }),
      },
    ],
    structuredContent: body,
  };
}

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createMcpRateLimiter,
  defaultMcpBucketPolicy,
  rateLimitedResult,
} from "../src/server/mcp-rate-limit.js";
import type { ActorContext } from "../src/core/operation-contracts.js";

const ada: ActorContext = {
  tenantId: "tenant",
  subjectId: "ada",
  sessionId: "ada:client-1",
  actorKind: "agent",
  capabilities: ["executor"],
};
const grace: ActorContext = { ...ada, subjectId: "grace", sessionId: "g" };

function clock(start = 1_000_000) {
  let at = start;
  return {
    now: () => at,
    advance(ms: number) {
      at += ms;
    },
  };
}

test("a bucket allows its burst, then refuses with the wait until one call is back", () => {
  const time = clock();
  const limiter = createMcpRateLimiter({
    capacity: 3,
    refillPerSecond: 0.25,
    now: time.now,
  });
  for (let i = 0; i < 3; i++)
    assert.deepEqual(limiter.take(ada, "ceremony_snapshot"), { allowed: true });
  assert.deepEqual(limiter.take(ada, "ceremony_snapshot"), {
    allowed: false,
    retryAfterSeconds: 4,
  });
  // Half-way there, the wait shrinks rather than resetting.
  time.advance(2_000);
  assert.deepEqual(limiter.take(ada, "ceremony_snapshot"), {
    allowed: false,
    retryAfterSeconds: 2,
  });
  time.advance(2_000);
  assert.deepEqual(limiter.take(ada, "ceremony_snapshot"), { allowed: true });
  // A long pause refills to the burst and no further.
  time.advance(3_600_000);
  for (let i = 0; i < 3; i++)
    assert.equal(limiter.take(ada, "ceremony_snapshot").allowed, true);
  assert.equal(limiter.take(ada, "ceremony_snapshot").allowed, false);
});

test("a clock stepped back and forward again refills nothing twice", () => {
  const time = clock();
  const limiter = createMcpRateLimiter({
    capacity: 1,
    refillPerSecond: 0.1,
    now: time.now,
  });
  assert.equal(limiter.take(ada, "ceremony_snapshot").allowed, true);
  // A wall clock corrected backwards, then forwards to where it was.
  time.advance(-60_000);
  assert.equal(limiter.take(ada, "ceremony_snapshot").allowed, false);
  time.advance(60_000);
  assert.deepEqual(limiter.take(ada, "ceremony_snapshot"), {
    allowed: false,
    retryAfterSeconds: 10,
  });
});

test("the default clock is monotonic, not the wall clock", () => {
  const realNow = Date.now;
  let offset = 0;
  try {
    Date.now = () => realNow() + offset;
    const limiter = createMcpRateLimiter({
      capacity: 1,
      refillPerSecond: 0.01,
    });
    assert.equal(limiter.take(ada, "ceremony_snapshot").allowed, true);
    // Jumping the wall clock a day ahead does not refill the bucket.
    offset = 86_400_000;
    assert.equal(limiter.take(ada, "ceremony_snapshot").allowed, false);
  } finally {
    Date.now = realNow;
  }
});

test("budgets are per actor and per tool, and a person's sessions share one", () => {
  const limiter = createMcpRateLimiter({
    capacity: 1,
    refillPerSecond: 0.01,
    now: clock().now,
  });
  assert.equal(limiter.take(ada, "ceremony_snapshot").allowed, true);
  assert.equal(limiter.take(ada, "ceremony_snapshot").allowed, false);
  assert.equal(limiter.take(ada, "ceremony_advance").allowed, true);
  assert.equal(limiter.take(grace, "ceremony_snapshot").allowed, true);
  // Another chat client of the same subject draws on the same allowance.
  assert.equal(
    limiter.take({ ...ada, sessionId: "ada:client-2" }, "ceremony_advance")
      .allowed,
    false,
  );
  // The same subject id in another tenant is someone else.
  assert.equal(
    limiter.take({ ...ada, tenantId: "other" }, "ceremony_snapshot").allowed,
    true,
  );
});

test("per-tool policy overrides the default for that tool only", () => {
  const limiter = createMcpRateLimiter({
    capacity: 5,
    refillPerSecond: 1,
    tools: { connector_invoke: { capacity: 1 } },
    now: clock().now,
  });
  assert.equal(limiter.take(ada, "connector_invoke").allowed, true);
  assert.deepEqual(limiter.take(ada, "connector_invoke"), {
    allowed: false,
    retryAfterSeconds: 1,
  });
  for (let i = 0; i < 5; i++)
    assert.equal(limiter.take(ada, "connector_status").allowed, true);
});

test("the defaults are a sensible burst and a slow refill", () => {
  const limiter = createMcpRateLimiter({ now: clock().now });
  for (let i = 0; i < defaultMcpBucketPolicy.capacity; i++)
    assert.equal(limiter.take(ada, "ceremony_connectors").allowed, true);
  assert.deepEqual(limiter.take(ada, "ceremony_connectors"), {
    allowed: false,
    retryAfterSeconds: 2,
  });
});

test("memory is bounded: the least recently used bucket is forgotten first", () => {
  const limiter = createMcpRateLimiter({
    capacity: 1,
    refillPerSecond: 0.001,
    maxBuckets: 2,
    now: clock().now,
  });
  limiter.take(ada, "a");
  limiter.take(ada, "b");
  limiter.take(ada, "a"); // refused, and now the most recent
  limiter.take(ada, "c"); // evicts "b"
  assert.equal(limiter.size, 2);
  assert.equal(limiter.take(ada, "a").allowed, false, "a was kept");
  assert.equal(limiter.take(ada, "b").allowed, true, "b was forgotten");
});

test("a policy that could never allow a call is refused at construction", () => {
  for (const options of [
    { capacity: 0 },
    { refillPerSecond: 0 },
    { capacity: Number.NaN },
    { tools: { x: { refillPerSecond: -1 } } },
    { maxBuckets: 0 },
  ])
    assert.throws(
      () => createMcpRateLimiter(options),
      /Invalid MCP rate limit/,
    );
});

test("a refusal is a structured tool error naming only the tool and the wait", () => {
  const result = rateLimitedResult("ceremony_advance", 7);
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    error: "rate-limited",
    tool: "ceremony_advance",
    retryAfterSeconds: 7,
  });
  const text = JSON.parse(result.content[0]!.text);
  assert.equal(text.error, "rate-limited");
  assert.equal(text.retryAfterSeconds, 7);
  assert.match(text.message, /Wait 7 seconds/);
});

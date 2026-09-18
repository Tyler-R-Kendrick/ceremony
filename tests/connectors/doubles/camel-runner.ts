import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { startHttpFixture } from "./http-fixture.js";

/*
 * A remote Camel runner that a host might operate.
 *
 * It verifies the host-signed delegation itself: it re-derives the SHA-256 of
 * the received body, rebuilds the signing string from the header's own
 * timestamp and nonce, and computes the HMAC with `node:crypto`. It never
 * calls the adapter's signing helper, so a passing test is evidence that two
 * independent implementations of the scheme agree.
 *
 * It runs nothing. It records the descriptor it was asked to run and answers
 * with a result shape, which is the entire point: the descriptor is the
 * boundary, and no Camel route, JVM or dependency resolution exists on either
 * side of it.
 */

export type CamelRunnerFixtureOptions = {
  /** Shared secret the host signs with. */
  secret: string;
  /** Seconds a delegation stays acceptable. */
  toleranceSeconds?: number;
  now?: () => number;
  /** Reply for an accepted delegation. */
  reply?: {
    state: "complete" | "failed" | "indeterminate";
    output?: unknown;
    code?: string;
  };
};

type ParsedSignature = { timestamp: number; nonce: string; signature: string };

function parseSignatureHeader(
  value: string | undefined,
): ParsedSignature | undefined {
  if (!value) return undefined;
  const parts = value.split(",").map((part) => part.trim());
  if (parts[0] !== "v1") return undefined;
  const fields = new Map<string, string>();
  for (const part of parts.slice(1)) {
    const equals = part.indexOf("=");
    if (equals < 0) return undefined;
    fields.set(part.slice(0, equals), part.slice(equals + 1));
  }
  const timestamp = Number(fields.get("t"));
  const nonce = fields.get("n");
  const signature = fields.get("s");
  if (!Number.isInteger(timestamp) || !nonce || !signature) return undefined;
  return { timestamp, nonce, signature };
}

export async function startCamelRunnerFixture(
  options: CamelRunnerFixtureOptions,
) {
  const tolerance = options.toleranceSeconds ?? 300;
  const now = options.now ?? Date.now;
  const accepted: Array<{ descriptor: unknown; nonce: string }> = [];
  const rejected: Array<{ reason: string }> = [];
  const seenNonces = new Set<string>();

  const fixture = await startHttpFixture((request) => {
    if (request.method !== "POST")
      return { status: 405, body: { error: "method not allowed" } };
    const parsed = parseSignatureHeader(
      request.headers["ceremony-runner-signature"],
    );
    if (!parsed) {
      rejected.push({ reason: "malformed-signature" });
      return { status: 401, body: { error: "unsigned" } };
    }
    const age = Math.abs(Math.floor(now() / 1000) - parsed.timestamp);
    if (age > tolerance) {
      rejected.push({ reason: "stale" });
      return { status: 401, body: { error: "stale" } };
    }
    if (seenNonces.has(parsed.nonce)) {
      rejected.push({ reason: "replayed-nonce" });
      return { status: 401, body: { error: "replay" } };
    }
    // Independently derived, never read from the request's own digest header.
    const digest = createHash("sha256").update(request.body).digest("hex");
    const expected = createHmac("sha256", options.secret)
      .update(`v1:${parsed.timestamp}:${parsed.nonce}:${digest}`)
      .digest("base64url");
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(parsed.signature, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      rejected.push({ reason: "signature-mismatch" });
      return { status: 401, body: { error: "bad signature" } };
    }
    seenNonces.add(parsed.nonce);
    let descriptor: unknown;
    try {
      descriptor = JSON.parse(request.body.toString("utf8")) as unknown;
    } catch {
      rejected.push({ reason: "malformed-descriptor" });
      return { status: 400, body: { error: "malformed descriptor" } };
    }
    accepted.push({ descriptor, nonce: parsed.nonce });
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: (options.reply ?? { state: "complete" }) as Record<string, unknown>,
    };
  });

  return {
    origin: fixture.origin,
    requests: fixture.requests,
    accepted,
    rejected,
    close: fixture.close,
  };
}

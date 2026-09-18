import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  STANDARD_WEBHOOKS_VERSION,
  hmacVendorVerifier,
  standardWebhookHeaders,
  standardWebhookKey,
  standardWebhookSignedContent,
  standardWebhooksVerifier,
  verifyHmacHeader,
  verifyStandardWebhook,
  type VendorVerifierPort,
} from "../../../src/server/connectors/events/index.js";
import { SECRET, ROTATED, signStandardWebhook } from "./helpers.js";

/*
 * EVT-03. Verification happens on the bytes that arrived, before any parse,
 * with a bounded timestamp window in both directions, constant-time
 * comparison and support for as many configured keys as a rotation needs.
 */

const NOW_SECONDS = 1614265330;
const NOW = NOW_SECONDS * 1000;
const bytes = (text: string) => new Uint8Array(Buffer.from(text, "utf8"));

test("EVT-03: the published Standard Webhooks test vector verifies", () => {
  // From the specification's own example (msg id, timestamp, body, secret).
  const body = bytes('{"test": 2432232314}');
  const headers = new Headers({
    "webhook-id": "msg_p5jXN8AQM9LWM0D4loKWxJek",
    "webhook-timestamp": "1614265330",
    "webhook-signature": "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
  });
  const result = verifyStandardWebhook({
    headers,
    body,
    secrets: [
      { keyId: "primary", secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw" },
    ],
    now: NOW,
  });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.keyId, "primary");
  assert.equal(result.ok && result.messageId, "msg_p5jXN8AQM9LWM0D4loKWxJek");
  assert.equal(result.ok && result.timestamp, NOW_SECONDS);
  assert.equal(result.ok && result.sourceTime, NOW);
  assert.equal(STANDARD_WEBHOOKS_VERSION, "1.0.0");
  assert.deepEqual(standardWebhookHeaders, {
    id: "webhook-id",
    timestamp: "webhook-timestamp",
    signature: "webhook-signature",
  });
});

test("EVT-03: the original bytes are what is verified, not a re-encoding", () => {
  // A body that is not canonical JSON and contains non-ASCII: re-serializing
  // it would change the bytes and therefore the signature.
  const raw = '{ "note":"café  \\u00e9", "n": 1.50 }';
  const body = bytes(raw);
  const headers = signStandardWebhook({
    id: "msg_bytes",
    timestampSeconds: NOW_SECONDS,
    body,
  });
  assert.equal(
    verifyStandardWebhook({
      headers,
      body,
      secrets: [{ keyId: "primary", secret: SECRET }],
      now: NOW,
    }).ok,
    true,
  );
  // The same value, re-serialized by JSON.stringify, no longer verifies.
  const reencoded = bytes(JSON.stringify(JSON.parse(raw)));
  assert.notEqual(Buffer.compare(Buffer.from(body), Buffer.from(reencoded)), 0);
  const result = verifyStandardWebhook({
    headers,
    body: reencoded,
    secrets: [{ keyId: "primary", secret: SECRET }],
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "signature-mismatch");
  // The signed content is exactly `${id}.${timestamp}.` + the body bytes.
  assert.equal(
    Buffer.from(
      standardWebhookSignedContent("id", "12", bytes("BODY")),
    ).toString("utf8"),
    "id.12.BODY",
  );
});

test("EVT-03: the timestamp window is bounded in both directions", () => {
  const body = bytes('{"a":1}');
  const sign = (seconds: number) =>
    signStandardWebhook({ id: "msg_time", timestampSeconds: seconds, body });
  const check = (seconds: number, toleranceSeconds = 300) =>
    verifyStandardWebhook({
      headers: sign(seconds),
      body,
      secrets: [{ keyId: "primary", secret: SECRET }],
      toleranceSeconds,
      now: NOW,
    });
  assert.equal(check(NOW_SECONDS).ok, true);
  assert.equal(check(NOW_SECONDS - 299).ok, true);
  assert.equal(check(NOW_SECONDS + 299).ok, true);
  // Too old: a replayed delivery from yesterday.
  const stale = check(NOW_SECONDS - 301);
  assert.equal(stale.ok, false);
  assert.equal(
    stale.ok === false && stale.reason,
    "timestamp-out-of-tolerance",
  );
  // Too new: a sender whose clock is far ahead, or a forged future timestamp.
  const future = check(NOW_SECONDS + 301);
  assert.equal(future.ok, false);
  assert.equal(
    future.ok === false && future.reason,
    "timestamp-out-of-tolerance",
  );
  // The window itself is bounded; a host cannot configure it away.
  assert.throws(() => check(NOW_SECONDS, 0));
  assert.throws(() => check(NOW_SECONDS, 86_401));
  // An out-of-tolerance timestamp is refused before the signature is compared,
  // so a valid signature over a stale timestamp still fails.
  assert.equal(check(NOW_SECONDS - 100_000).ok, false);
});

test("EVT-03: any configured key may verify, and the verifier reports which one did", () => {
  const body = bytes('{"rotated":true}');
  const headers = signStandardWebhook({
    id: "msg_rotate",
    timestampSeconds: NOW_SECONDS,
    body,
    secret: ROTATED,
  });
  const secrets = [
    { keyId: "primary", secret: SECRET },
    { keyId: "next", secret: ROTATED },
  ];
  const result = verifyStandardWebhook({ headers, body, secrets, now: NOW });
  assert.equal(result.ok, true);
  // Rotation is observable: the caller learns which key was accepted.
  assert.equal(result.ok && result.keyId, "next");
  // Removing the retired key refuses the same delivery.
  assert.equal(
    verifyStandardWebhook({
      headers,
      body,
      secrets: [{ keyId: "primary", secret: SECRET }],
      now: NOW,
    }).ok,
    false,
  );
  // Several space-separated signatures: one valid entry is enough.
  const valid = headers.get("webhook-signature")!;
  const many = new Headers(headers);
  many.set("webhook-signature", `v1,${"A".repeat(43)}= ${valid}`);
  assert.equal(
    verifyStandardWebhook({ headers: many, body, secrets, now: NOW }).ok,
    true,
  );
  // Key ids must be distinct and bounded; misconfiguration is the host's error.
  assert.throws(() =>
    verifyStandardWebhook({
      headers,
      body,
      secrets: [
        { keyId: "same", secret: SECRET },
        { keyId: "same", secret: ROTATED },
      ],
      now: NOW,
    }),
  );
  assert.throws(() =>
    verifyStandardWebhook({ headers, body, secrets: [], now: NOW }),
  );
});

test("EVT-03: malformed, missing and foreign-scheme headers are refused distinctly", () => {
  const body = bytes('{"a":1}');
  const good = signStandardWebhook({
    id: "msg_h",
    timestampSeconds: NOW_SECONDS,
    body,
  });
  const secrets = [{ keyId: "primary", secret: SECRET }];
  const run = (mutate: (headers: Headers) => void) => {
    const headers = new Headers(good);
    mutate(headers);
    return verifyStandardWebhook({ headers, body, secrets, now: NOW });
  };
  for (const name of Object.values(standardWebhookHeaders)) {
    const result = run((headers) => headers.delete(name));
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "missing-headers");
  }
  const cases: Array<[(headers: Headers) => void, string]> = [
    [(h) => h.set("webhook-timestamp", "not-a-number"), "malformed-headers"],
    [(h) => h.set("webhook-timestamp", "-1"), "malformed-headers"],
    [(h) => h.set("webhook-id", "has space"), "malformed-headers"],
    [(h) => h.set("webhook-id", "a,b"), "malformed-headers"],
    [(h) => h.set("webhook-signature", "garbage"), "malformed-headers"],
    [(h) => h.set("webhook-signature", "v1,not+base64!!"), "malformed-headers"],
    [(h) => h.set("webhook-signature", "v1a,AAAA"), "unsupported-scheme"],
    [
      (h) => h.set("webhook-signature", `v1,${"A".repeat(44)}`),
      "signature-mismatch",
    ],
  ];
  for (const [mutate, reason] of cases) {
    const result = run(mutate);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, reason);
  }
  // A flood of candidate signatures is bounded.
  const flood = run((headers) =>
    headers.set(
      "webhook-signature",
      Array.from({ length: 40 }, () => `v1,${"A".repeat(43)}=`).join(" "),
    ),
  );
  assert.equal(flood.ok, false);
  assert.equal(flood.ok === false && flood.reason, "malformed-headers");
});

test("EVT-03: comparison is constant time and length-safe", () => {
  const body = bytes('{"a":1}');
  const secrets = [{ keyId: "primary", secret: SECRET }];
  const headers = signStandardWebhook({
    id: "msg_len",
    timestampSeconds: NOW_SECONDS,
    body,
  });
  // A truncated signature has a different length: comparison must report a
  // mismatch rather than throwing out of timingSafeEqual.
  const truncated = new Headers(headers);
  truncated.set("webhook-signature", "v1,AAAA");
  const result = verifyStandardWebhook({
    headers: truncated,
    body,
    secrets,
    now: NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "signature-mismatch");
  // A near-miss differing only in the final byte is still a mismatch.
  const original = Buffer.from(
    headers.get("webhook-signature")!.slice(3),
    "base64",
  );
  const altered = Buffer.from(original);
  altered[altered.length - 1] ^= 1;
  const nearMiss = new Headers(headers);
  nearMiss.set("webhook-signature", `v1,${altered.toString("base64")}`);
  assert.equal(
    verifyStandardWebhook({ headers: nearMiss, body, secrets, now: NOW }).ok,
    false,
  );
});

test("EVT-03: secrets decode from whsec_ base64, raw base64 or bytes, and short keys are refused", () => {
  const raw = Buffer.from(SECRET.replace(/^whsec_/, ""), "base64");
  assert.deepEqual(
    Buffer.from(standardWebhookKey(SECRET)),
    raw,
    "the whsec_ prefix is stripped before decoding",
  );
  assert.deepEqual(
    Buffer.from(standardWebhookKey(SECRET.replace(/^whsec_/, ""))),
    raw,
  );
  const bytesKey = new Uint8Array(randomBytes(32));
  assert.deepEqual(standardWebhookKey(bytesKey), bytesKey);
  assert.throws(() => standardWebhookKey("whsec_not base64"));
  assert.throws(() => standardWebhookKey("whsec_AAAA"));
  assert.throws(() => standardWebhookKey(new Uint8Array(8)));
});

test("EVT-03: the vendor HMAC helper covers the common provider pattern", () => {
  const body = bytes('{"vendor":true}');
  const secret = "vendor-shared-secret-value";
  const hex = createHmac("sha256", secret).update(body).digest("hex");
  const secrets = [{ keyId: "v1", secret }];
  const ok = verifyHmacHeader({
    headers: new Headers({ "x-acme-signature": `sha256=${hex}` }),
    body,
    secrets,
    header: "x-acme-signature",
    prefix: "sha256=",
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.keyId, "v1");
  // A missing prefix is not silently accepted.
  assert.equal(
    verifyHmacHeader({
      headers: new Headers({ "x-acme-signature": hex }),
      body,
      secrets,
      header: "x-acme-signature",
      prefix: "sha256=",
    }).ok,
    false,
  );
  // Timestamped signatures: the signed content includes the timestamp and the
  // window is enforced the same way.
  const timestamp = String(NOW_SECONDS);
  const signed = createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`), Buffer.from(body)]))
    .digest("base64");
  const options = {
    body,
    secrets,
    header: "x-acme-signature",
    encoding: "base64" as const,
    timestamp: { header: "x-acme-timestamp", toleranceSeconds: 300 },
    signedContent: (input: { body: Uint8Array; timestamp?: string }) =>
      new Uint8Array(
        Buffer.concat([
          Buffer.from(`${input.timestamp}.`),
          Buffer.from(input.body),
        ]),
      ),
  };
  const withTime = verifyHmacHeader({
    ...options,
    headers: new Headers({
      "x-acme-signature": signed,
      "x-acme-timestamp": timestamp,
    }),
    now: NOW,
  });
  assert.equal(withTime.ok, true);
  assert.equal(withTime.ok && withTime.sourceTime, NOW);
  const expired = verifyHmacHeader({
    ...options,
    headers: new Headers({
      "x-acme-signature": signed,
      "x-acme-timestamp": timestamp,
    }),
    now: NOW + 400_000,
  });
  assert.equal(expired.ok, false);
  assert.equal(
    expired.ok === false && expired.reason,
    "timestamp-out-of-tolerance",
  );
});

test("EVT-03: a vendor verifier is a port a provider swarm can plug in", async () => {
  const body = bytes('{"delivery":"d1"}');
  const secret = "another-vendor-secret-value";
  const verifier: VendorVerifierPort = hmacVendorVerifier({
    id: "acme-vendor",
    header: "x-acme-signature",
    prefix: "sha256=",
    identify: (delivery) => {
      const id =
        delivery.headers instanceof Headers
          ? delivery.headers.get("x-acme-delivery")
          : undefined;
      return id
        ? { eventId: id, providerEventType: "invoice.paid" }
        : undefined;
    },
  });
  assert.equal(verifier.id, "acme-vendor");
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  const result = await verifier.verify(
    {
      headers: new Headers({
        "x-acme-signature": `sha256=${signature}`,
        "x-acme-delivery": "d-42",
      }),
      body,
      receivedAt: NOW,
    },
    [{ keyId: "v1", secret }],
  );
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.identity?.eventId, "d-42");
  assert.equal(result.ok && result.identity?.providerEventType, "invoice.paid");
  const forged = await verifier.verify(
    {
      headers: new Headers({ "x-acme-signature": `sha256=${"0".repeat(64)}` }),
      body,
      receivedAt: NOW,
    },
    [{ keyId: "v1", secret }],
  );
  assert.equal(forged.ok, false);
  // An invalid verifier id is rejected at construction, not at request time.
  assert.throws(() => hmacVendorVerifier({ id: "Bad Id", header: "x" }));
  // The Standard Webhooks profile is itself exposed as a port.
  assert.equal(standardWebhooksVerifier.id, "standard-webhooks");
  const standard = await standardWebhooksVerifier.verify(
    {
      headers: signStandardWebhook({
        id: "msg_port",
        timestampSeconds: NOW_SECONDS,
        body,
      }),
      body,
      receivedAt: NOW,
    },
    [{ keyId: "primary", secret: SECRET }],
  );
  assert.equal(standard.ok, true);
  assert.equal(standard.ok && standard.identity?.eventId, "msg_port");
});

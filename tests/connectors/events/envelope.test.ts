import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLOUDEVENTS_SPECVERSION,
  createVerifiedEnvelope,
  fromCloudEvent,
  measurePayload,
  toCloudEvent,
  verifiedEventEnvelopeSchema,
  type VerifiedEventEnvelopeV1,
} from "../../../src/server/connectors/events/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type { VerifiedEventEnvelope } from "../../../src/server/connectors/ports.js";
import type { CompletionInput } from "../../../src/server/connectors/adapter.js";

/*
 * EVT-02. The envelope exists only after verification and records how the
 * source was authenticated. A CloudEvent is a projection of it; reading one
 * back yields an explicitly unverified event, because a CloudEvent carries no
 * proof of anything.
 */

const RECEIVED = Date.parse("2026-09-18T12:00:00.000Z");
const OCCURRED = Date.parse("2026-09-18T11:59:30.000Z");

const base = (
  overrides: Partial<Parameters<typeof createVerifiedEnvelope>[0]> = {},
): VerifiedEventEnvelopeV1 =>
  createVerifiedEnvelope({
    eventId: "msg_2KWPBgLlAfxdpx2AI54pPJ85f4W",
    authority: "acme-billing",
    providerEventType: "invoice.paid",
    receivedAt: RECEIVED,
    sourceTime: OCCURRED,
    verification: {
      method: "standard-webhooks",
      keyId: "primary",
      verifiedAt: RECEIVED,
    },
    connectionRef: "connection:1",
    payloadClassification: "personal",
    payload: { id: "in_1", amount: 4200 },
    ...overrides,
  });

test("EVT-02: the envelope records the verification that produced it", () => {
  const envelope = base();
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.verification.method, "standard-webhooks");
  assert.equal(envelope.verification.keyId, "primary");
  assert.equal(envelope.verification.verifiedAt, RECEIVED);
  assert.equal(envelope.receivedAt, RECEIVED);
  assert.equal(envelope.sourceTime, OCCURRED);
  assert.deepEqual(envelope.forwarderHops, []);
  // The full envelope is an instance of the minimal port shape, so an adapter
  // that only knows the minimal type still receives a complete one.
  const minimal: VerifiedEventEnvelope = envelope;
  assert.equal(minimal.authority, "acme-billing");
  const completion: CompletionInput = { kind: "event", event: envelope };
  assert.equal(completion.kind, "event");
});

test("EVT-02: envelope identities and payloads are bounded and hostile shapes refused", () => {
  assert.throws(
    () => base({ authority: "not a path segment" }),
    (error: unknown) => error instanceof ConnectorError,
  );
  assert.throws(
    () => base({ eventId: "has whitespace" }),
    (error: unknown) => error instanceof ConnectorError,
  );
  assert.throws(
    () => base({ eventId: "" }),
    (error: unknown) => error instanceof ConnectorError,
  );
  assert.throws(
    () => base({ providerEventType: "x".repeat(300) }),
    (error: unknown) => error instanceof ConnectorError,
  );
  // A payload with a reserved object key never becomes an envelope.
  const hostile = JSON.parse('{"__proto__":{"admin":true}}');
  assert.throws(
    () => base({ payload: hostile }),
    (error: unknown) => error instanceof ConnectorError,
  );
  // Depth, node count and bytes are all bounded.
  let deep: unknown = "leaf";
  for (let index = 0; index < 64; index++) deep = { next: deep };
  assert.equal(measurePayload(deep).ok, false);
  assert.throws(
    () => base({ payload: deep }),
    (error: unknown) => error instanceof ConnectorError,
  );
  const wide = { blob: "x".repeat(2_000_000) };
  const measured = measurePayload(wide);
  assert.equal(measured.ok, false);
  assert.equal(measured.ok === false ? measured.reason : undefined, "bytes");
  assert.equal(measurePayload({ ok: [1, "two", true, null] }).ok, true);
  assert.equal(measurePayload({ bad: Number.NaN }).ok, false);
});

test("EVT-02: a forwarder-verified envelope must name its verified hop, and a direct one must not", () => {
  const forwarded = createVerifiedEnvelope({
    eventId: "evt_1",
    authority: "acme-billing",
    providerEventType: "invoice.paid",
    receivedAt: RECEIVED,
    verification: { method: "forwarder-signature", keyId: "vercel-key" },
    payloadClassification: "personal",
    payload: {},
    forwarderHops: [
      {
        forwarder: "vercel-connect",
        verified: true,
        method: "forwarder-signature",
        keyId: "vercel-key",
      },
      { forwarder: "acme-billing", verified: false, method: "upstream-claim" },
    ],
  });
  assert.equal(forwarded.verification.method, "forwarder-signature");
  assert.equal(forwarded.forwarderHops.length, 2);
  // A claim can never be recorded as a verified hop.
  assert.throws(() =>
    createVerifiedEnvelope({
      eventId: "evt_2",
      authority: "acme-billing",
      providerEventType: "invoice.paid",
      receivedAt: RECEIVED,
      verification: { method: "forwarder-signature" },
      payloadClassification: "personal",
      payload: {},
      forwarderHops: [
        { forwarder: "vercel-connect", verified: true, method: "upstream-claim" },
      ],
    }),
  );
  // Claiming forwarder verification without a verified forwarder hop fails.
  assert.throws(() =>
    createVerifiedEnvelope({
      eventId: "evt_3",
      authority: "acme-billing",
      providerEventType: "invoice.paid",
      receivedAt: RECEIVED,
      verification: { method: "forwarder-signature" },
      payloadClassification: "personal",
      payload: {},
      forwarderHops: [],
    }),
  );
  // And a directly verified event cannot carry a verified forwarder hop.
  assert.throws(() =>
    createVerifiedEnvelope({
      eventId: "evt_4",
      authority: "acme-billing",
      providerEventType: "invoice.paid",
      receivedAt: RECEIVED,
      verification: { method: "standard-webhooks" },
      payloadClassification: "personal",
      payload: {},
      forwarderHops: [
        {
          forwarder: "vercel-connect",
          verified: true,
          method: "forwarder-signature",
        },
      ],
    }),
  );
});

test("EVT-02: toCloudEvent maps only attributes with matching semantics", () => {
  const event = toCloudEvent(base());
  assert.deepEqual(event, {
    specversion: CLOUDEVENTS_SPECVERSION,
    id: "msg_2KWPBgLlAfxdpx2AI54pPJ85f4W",
    source: "acme-billing",
    type: "invoice.paid",
    time: new Date(OCCURRED).toISOString(),
    datacontenttype: "application/json",
    data: { id: "in_1", amount: 4200 },
  });
  // receivedAt is custody time, not occurrence time: it is never `time`.
  assert.notEqual(event.time, new Date(RECEIVED).toISOString());
  // Verification has no CloudEvents attribute and is not smuggled in.
  const serialized = JSON.stringify(event);
  assert.equal(serialized.includes("standard-webhooks"), false);
  assert.equal(serialized.includes("primary"), false);
  assert.equal(serialized.includes("connection:1"), false);
  // An envelope with no source time emits no `time` rather than inventing one.
  const withoutTime = toCloudEvent(base({ sourceTime: undefined }));
  assert.equal(Object.hasOwn(withoutTime, "time"), false);
  assert.equal(withoutTime.specversion, "1.0");
});

test("EVT-02: fromCloudEvent refuses to invent missing required attributes", () => {
  const valid = {
    specversion: "1.0",
    id: "evt-1",
    source: "/acme/billing",
    type: "invoice.paid",
    time: "2026-09-18T11:59:30.000Z",
    datacontenttype: "application/json",
    data: { amount: 1 },
  };
  const read = fromCloudEvent(valid);
  assert.deepEqual(read, {
    eventId: "evt-1",
    source: "/acme/billing",
    providerEventType: "invoice.paid",
    sourceTime: OCCURRED,
    payload: { amount: 1 },
  });
  // The result is an unverified event: it has no verification field at all,
  // because a CloudEvent proves nothing about its sender.
  assert.equal(Object.hasOwn(read, "verification"), false);
  assert.equal(Object.hasOwn(read, "authority"), false);
  for (const missing of ["id", "source", "type", "specversion"]) {
    const broken: Record<string, unknown> = { ...valid };
    delete broken[missing];
    assert.throws(
      () => fromCloudEvent(broken),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "invalid-request",
      `missing ${missing} must be refused`,
    );
  }
  assert.throws(() => fromCloudEvent({ ...valid, specversion: "0.3" }));
  assert.throws(() => fromCloudEvent({ ...valid, id: "" }));
  assert.throws(() => fromCloudEvent({ ...valid, source: "has space" }));
  // Extension attributes must be lowercase alphanumeric primitives.
  assert.throws(() => fromCloudEvent({ ...valid, Bad_Name: "x" }));
  assert.throws(() => fromCloudEvent({ ...valid, nested: { a: 1 } }));
  assert.equal(fromCloudEvent({ ...valid, tenantid: "t1" }).eventId, "evt-1");
  // Binary mode is not silently decoded into a JSON payload.
  assert.throws(
    () => fromCloudEvent({ ...valid, data: undefined, data_base64: "AAEC" }),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "unsupported",
  );
});

test("EVT-02: round trip preserves the mapped fields and nothing else", () => {
  const envelope = base();
  const read = fromCloudEvent(toCloudEvent(envelope));
  assert.equal(read.eventId, envelope.eventId);
  assert.equal(read.providerEventType, envelope.providerEventType);
  assert.equal(read.sourceTime, envelope.sourceTime);
  assert.deepEqual(read.payload, envelope.payload);
  // `source` is the producer's string; mapping it back to a host authority is
  // a configured decision, not something the document may assert.
  assert.equal(read.source, envelope.authority);
  const rebuilt = verifiedEventEnvelopeSchema.safeParse({
    ...read,
    schemaVersion: 1,
    authority: read.source,
    receivedAt: RECEIVED,
    payloadClassification: "personal",
    forwarderHops: [],
  });
  // Without a verification block there is no envelope at all.
  assert.equal(rebuilt.success, false);
});

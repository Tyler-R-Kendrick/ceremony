import { z } from "zod";
import { connectorReferenceSchema } from "../../../core/connectors/index.js";
import { ConnectorError } from "../errors.js";
import type { VerifiedEventEnvelope } from "../ports.js";

/*
 * The verified-event envelope is the only shape an event takes once it is
 * inside Ceremony. It exists only after a source was authenticated, and it
 * records how: which method, which key, and, for deliveries that crossed a
 * broker, every hop with a plain boolean saying whether that hop was verified
 * here or merely claimed by someone upstream. A CloudEvent is a projection of
 * an envelope, never a source of one: a CloudEvent carries no proof, so
 * reading one yields an unverified event that a caller must authenticate.
 */

export const EVENT_LIMITS = Object.freeze({
  /** Raw request bytes a receiver reads before verification. */
  bodyBytes: 262_144,
  /** Serialized payload bytes an envelope may carry. */
  payloadBytes: 1_048_576,
  payloadDepth: 32,
  payloadNodes: 65_536,
  forwarderHops: 8,
  eventTypes: 64,
  signatures: 8,
  secrets: 8,
  toleranceSeconds: 300,
});

const noControl = /^[^\p{Cc}]+$/u;
/** A host-configured provider or broker identity; one URL path segment, never provider-supplied. */
export const authoritySchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/);
/** The provider's delivery identifier; unique only within one authority. */
export const eventIdSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(noControl)
  .refine((value) => !/\s/.test(value), "Event id contains whitespace");
export const eventTypeSchema = z.string().min(1).max(200).regex(noControl);
export const keyIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/);
const epochMs = z.number().int().min(0).max(8_640_000_000_000_000);

export const verificationMethods = [
  "standard-webhooks",
  "vendor-signature",
  "forwarder-signature",
] as const;
export type VerificationMethod = (typeof verificationMethods)[number];
export const hopMethods = [...verificationMethods, "upstream-claim"] as const;

export const forwarderHopSchema = z
  .strictObject({
    forwarder: authoritySchema,
    verified: z.boolean(),
    method: z.enum(hopMethods),
    keyId: keyIdSchema.optional(),
  })
  .superRefine((hop, ctx) => {
    // A forwarder saying "the provider checked out" is data about the
    // forwarder's opinion; it is never a verification of the provider.
    if (hop.method === "upstream-claim" && hop.verified)
      ctx.addIssue({
        code: "custom",
        message: "An upstream claim is never a verified hop",
      });
    if (hop.method === "upstream-claim" && hop.keyId)
      ctx.addIssue({ code: "custom", message: "A claim has no key" });
  });
export type ForwarderHop = z.infer<typeof forwarderHopSchema>;

export type PayloadMeasure = { bytes: number; depth: number; nodes: number };
export type PayloadBoundsFailure =
  "depth" | "nodes" | "bytes" | "reserved-key" | "not-json";
export type PayloadLimits = {
  readonly bytes: number;
  readonly depth: number;
  readonly nodes: number;
};
const reservedKeys = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Bounds a payload structurally before anything serializes, digests or stores
 * it. The walk is iterative so hostile depth exhausts a counter rather than the
 * stack, and it refuses reserved keys instead of letting a copying parser drop
 * them silently. Bytes are the exact JSON length, measured only once the shape
 * is known to be safe to serialize.
 */
export function measurePayload(
  value: unknown,
  limits: PayloadLimits = {
    bytes: EVENT_LIMITS.payloadBytes,
    depth: EVENT_LIMITS.payloadDepth,
    nodes: EVENT_LIMITS.payloadNodes,
  },
):
  | { ok: true; measure: PayloadMeasure }
  | { ok: false; reason: PayloadBoundsFailure; measure: PayloadMeasure } {
  const measure: PayloadMeasure = { bytes: 0, depth: 0, nodes: 0 };
  const fail = (reason: PayloadBoundsFailure) => ({
    ok: false as const,
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
    if (current === null) continue;
    switch (typeof current) {
      case "string":
      case "boolean":
        continue;
      case "number":
        if (!Number.isFinite(current)) return fail("not-json");
        continue;
      case "object": {
        if (Array.isArray(current)) {
          for (const item of current)
            stack.push({ value: item, depth: depth + 1 });
          continue;
        }
        const prototype = Object.getPrototypeOf(current);
        if (prototype !== Object.prototype && prototype !== null)
          return fail("not-json");
        for (const key of Object.keys(current)) {
          if (reservedKeys.has(key)) return fail("reserved-key");
          stack.push({
            value: (current as Record<string, unknown>)[key],
            depth: depth + 1,
          });
        }
        continue;
      }
      default:
        return fail("not-json");
    }
  }
  const text = JSON.stringify(value);
  measure.bytes = text === undefined ? 0 : Buffer.byteLength(text);
  if (measure.bytes > limits.bytes) return fail("bytes");
  return { ok: true, measure };
}

const boundedPayloadSchema = z.unknown().superRefine((value, ctx) => {
  if (value === undefined) return;
  const result = measurePayload(value);
  if (!result.ok)
    ctx.addIssue({
      code: "custom",
      message: `Payload exceeds bounds: ${result.reason}`,
    });
});

export const verifiedEventEnvelopeSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    eventId: eventIdSchema,
    authority: authoritySchema,
    providerEventType: eventTypeSchema,
    receivedAt: epochMs,
    /** The sender's own timestamp, kept for reordering decisions; never trusted as receipt time. */
    sourceTime: epochMs.optional(),
    verification: z.strictObject({
      method: z.enum(verificationMethods),
      keyId: keyIdSchema.optional(),
      verifiedAt: epochMs,
    }),
    connectionRef: connectorReferenceSchema.optional(),
    payloadClassification: z.enum(["public", "personal", "secret"]),
    payload: boundedPayloadSchema,
    forwarderHops: z.array(forwarderHopSchema).max(EVENT_LIMITS.forwarderHops),
  })
  .superRefine((envelope, ctx) => {
    const forwarded = envelope.forwarderHops.some(
      (hop) => hop.method === "forwarder-signature" && hop.verified,
    );
    if (envelope.verification.method === "forwarder-signature" && !forwarded)
      ctx.addIssue({
        code: "custom",
        message: "A forwarder-verified event names its verified forwarder hop",
      });
    if (envelope.verification.method !== "forwarder-signature" && forwarded)
      ctx.addIssue({
        code: "custom",
        message: "A directly verified event has no verified forwarder hop",
      });
  });
export type VerifiedEventEnvelopeV1 = z.infer<
  typeof verifiedEventEnvelopeSchema
>;

// The full envelope must remain a valid instance of the minimal shape adapters
// and CompletionInput already use; this fails to compile if it ever drifts.
type Assert<T extends true> = T;
type EnvelopeCompatible = Assert<
  VerifiedEventEnvelopeV1 extends VerifiedEventEnvelope ? true : false
>;
export type { EnvelopeCompatible };

export type VerifiedEnvelopeInput = {
  eventId: string;
  authority: string;
  providerEventType: string;
  receivedAt: number;
  sourceTime?: number | undefined;
  verification: {
    method: VerificationMethod;
    keyId?: string | undefined;
    verifiedAt?: number | undefined;
  };
  connectionRef?: string | undefined;
  payloadClassification: "public" | "personal" | "secret";
  payload: unknown;
  forwarderHops?: readonly ForwarderHop[] | undefined;
};

/** Builds and validates an envelope; undefined optionals are dropped so the strict schema and exact optional types agree. */
export function createVerifiedEnvelope(
  input: VerifiedEnvelopeInput,
): VerifiedEventEnvelopeV1 {
  const parsed = verifiedEventEnvelopeSchema.safeParse({
    schemaVersion: 1,
    eventId: input.eventId,
    authority: input.authority,
    providerEventType: input.providerEventType,
    receivedAt: input.receivedAt,
    ...(input.sourceTime === undefined ? {} : { sourceTime: input.sourceTime }),
    verification: {
      method: input.verification.method,
      ...(input.verification.keyId === undefined
        ? {}
        : { keyId: input.verification.keyId }),
      verifiedAt: input.verification.verifiedAt ?? input.receivedAt,
    },
    ...(input.connectionRef === undefined
      ? {}
      : { connectionRef: input.connectionRef }),
    payloadClassification: input.payloadClassification,
    payload: input.payload,
    forwarderHops: [...(input.forwarderHops ?? [])],
  });
  if (!parsed.success)
    throw new ConnectorError("invalid-request", {
      detail: "events.envelope.invalid",
      cause: parsed.error,
    });
  return parsed.data;
}

/*
 * CloudEvents 1.0 (JSON event format). Only attributes whose semantics match
 * the envelope are mapped: id <-> eventId, source <-> authority, type <->
 * providerEventType, time <-> sourceTime, data <-> payload. receivedAt is when
 * Ceremony took custody, not when the occurrence happened, so it never becomes
 * `time`; verification has no CloudEvents attribute and is not smuggled in as
 * an extension.
 */
export const CLOUDEVENTS_SPECVERSION = "1.0" as const;
const cloudEventAttributes = new Set([
  "specversion",
  "id",
  "source",
  "type",
  "time",
  "datacontenttype",
  "dataschema",
  "subject",
  "data",
  "data_base64",
]);
const isUriReference = (value: string) =>
  !/\s/.test(value) && URL.canParse(value, "https://ceremony.invalid/");

export const cloudEventSchema = z
  .looseObject({
    specversion: z.literal(CLOUDEVENTS_SPECVERSION),
    id: z.string().min(1).max(512).regex(noControl),
    source: z.string().min(1).max(2048).regex(noControl).refine(isUriReference),
    type: z.string().min(1).max(200).regex(noControl),
    time: z.iso.datetime({ offset: true }).optional(),
    datacontenttype: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;.*)?$/i)
      .optional(),
    dataschema: z
      .string()
      .min(1)
      .max(2048)
      .regex(noControl)
      .refine(isUriReference)
      .optional(),
    subject: z.string().min(1).max(512).regex(noControl).optional(),
    data: z.unknown().optional(),
    data_base64: z.string().optional(),
  })
  .superRefine((event, ctx) => {
    if (event.data !== undefined && event.data_base64 !== undefined)
      ctx.addIssue({ code: "custom", message: "data and data_base64" });
    for (const [name, value] of Object.entries(event)) {
      if (cloudEventAttributes.has(name)) continue;
      if (!/^[a-z0-9]{1,20}$/.test(name))
        ctx.addIssue({
          code: "custom",
          message: "Extension attribute name is not lowercase alphanumeric",
        });
      if (!["string", "number", "boolean"].includes(typeof value))
        ctx.addIssue({
          code: "custom",
          message: "Extension attribute value is not a primitive",
        });
    }
  });
export type CloudEvent = z.infer<typeof cloudEventSchema>;

export function toCloudEvent(envelope: VerifiedEventEnvelopeV1): CloudEvent {
  const checked = verifiedEventEnvelopeSchema.parse(envelope);
  return cloudEventSchema.parse({
    specversion: CLOUDEVENTS_SPECVERSION,
    id: checked.eventId,
    source: checked.authority,
    type: checked.providerEventType,
    ...(checked.sourceTime === undefined
      ? {}
      : { time: new Date(checked.sourceTime).toISOString() }),
    ...(checked.payload === undefined
      ? {}
      : { datacontenttype: "application/json", data: checked.payload }),
  });
}

/** What a CloudEvent can say about an event; it carries no proof, so the result is explicitly unverified. */
export type UnverifiedEvent = {
  eventId: string;
  /** The producer's `source` verbatim; a host maps it to a configured authority, never the reverse. */
  source: string;
  providerEventType: string;
  sourceTime?: number;
  payload?: unknown;
};

export function fromCloudEvent(input: unknown): UnverifiedEvent {
  const parsed = cloudEventSchema.safeParse(input);
  if (!parsed.success)
    throw new ConnectorError("invalid-request", {
      detail: "cloudevents.invalid",
      cause: parsed.error,
    });
  const event = parsed.data;
  if (event.data_base64 !== undefined)
    throw new ConnectorError("unsupported", {
      detail: "cloudevents.data-base64",
    });
  if (event.data !== undefined && !measurePayload(event.data).ok)
    throw new ConnectorError("invalid-request", {
      detail: "cloudevents.data-bounds",
    });
  const sourceTime =
    event.time === undefined ? undefined : Date.parse(event.time);
  if (sourceTime !== undefined && !Number.isFinite(sourceTime))
    throw new ConnectorError("invalid-request", { detail: "cloudevents.time" });
  return {
    eventId: event.id,
    source: event.source,
    providerEventType: event.type,
    ...(sourceTime === undefined ? {} : { sourceTime }),
    ...(event.data === undefined ? {} : { payload: event.data }),
  };
}

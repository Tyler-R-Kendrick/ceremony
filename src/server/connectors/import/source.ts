import { createHash } from "node:crypto";
import {
  canonicalConnectorJson,
  canonicalDigest,
  sourceRecordSchema,
  type ConnectorSourceIdentity,
  type SourceRecord,
} from "../../../core/connectors/index.js";
import { ConnectorError } from "../errors.js";
import type { SourceArtifactPort } from "../ports.js";
import { sha256Hex } from "./parse.js";

/*
 * Capturing a source means two separate facts: the exact bytes, which go to a
 * protected tenant-scoped artifact and are identified by their SHA-256, and
 * the parsed value, which is identified by its canonical digest. The record
 * that describes the capture carries the first digest, the artifact handle,
 * media type, origin (with userinfo, query and fragment removed) and the
 * capture time; it never carries the bytes, a parse excerpt or a full URL.
 * Records are immutable: a later capture of the same source is a new record
 * with its own reference, and nothing here updates an existing one.
 */

export type SourceOriginKind = SourceRecord["origin"]["kind"];

export type CaptureMeta = {
  tenantId: string;
  identity: ConnectorSourceIdentity;
  format: SourceRecord["format"];
  origin: { kind: SourceOriginKind; location?: string | undefined };
  mediaType: string;
  /** Milliseconds since the epoch, or an ISO 8601 timestamp. */
  capturedAt: number | string;
  /** Retention boundary handed to the artifact store; absent means the store's default policy. */
  retainUntil?: number | undefined;
  license?: SourceRecord["license"] | undefined;
  adaptation?: SourceRecord["adaptation"] | undefined;
  overlays?: SourceRecord["overlays"] | undefined;
};

/** Origin and path only: no userinfo, no query (signed URLs, tokens), no fragment. */
export function sanitizeOriginLocation(value: string): string {
  if (typeof value !== "string" || !URL.canParse(value))
    throw new ConnectorError("invalid-request", {
      detail: "source.origin-invalid",
    });
  const url = new URL(value);
  if (url.origin === "null")
    throw new ConnectorError("invalid-request", {
      detail: "source.origin-invalid",
    });
  return `${url.origin}${url.pathname}`;
}

/**
 * A content-addressed reference for one capture: identity, byte digest,
 * sanitized origin and capture time. Two captures of identical bytes from the
 * same place at different times are different records, which is what a
 * refresh needs; a record can never be overwritten by a later import because
 * the reference of the later import is different.
 */
export function sourceRefFor(input: {
  identity: ConnectorSourceIdentity;
  digest: string;
  origin: SourceRecord["origin"];
  capturedAt: string;
}): string {
  return `source:${createHash("sha256")
    .update(canonicalConnectorJson(input))
    .digest("hex")}`;
}

/** The canonical digest of the parsed value; a different fact from the byte digest. */
export function normalizedDigestFor(value: unknown): Promise<string> {
  return canonicalDigest(value);
}

const provenanceSchema = sourceRecordSchema.omit({ artifactRef: true });

/**
 * Stores the bytes as a protected artifact and returns a schema-valid record.
 * The record is validated before the artifact is written, so an invalid
 * identity or origin cannot leave an orphaned artifact behind.
 */
export async function captureSource(
  bytes: Uint8Array,
  meta: CaptureMeta,
  artifacts: SourceArtifactPort,
): Promise<SourceRecord> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0)
    throw new ConnectorError("invalid-request", {
      detail: "source.bytes-empty",
    });
  const digest = sha256Hex(bytes);
  const capturedAt =
    typeof meta.capturedAt === "number"
      ? new Date(meta.capturedAt).toISOString()
      : meta.capturedAt;
  const location =
    meta.origin.location === undefined
      ? undefined
      : sanitizeOriginLocation(meta.origin.location);
  const origin: SourceRecord["origin"] = {
    kind: meta.origin.kind,
    ...(location === undefined ? {} : { location }),
  };
  const provenance = provenanceSchema.safeParse({
    sourceRef: sourceRefFor({
      identity: meta.identity,
      digest,
      origin,
      capturedAt,
    }),
    identity: meta.identity,
    format: meta.format,
    origin,
    digest: { algorithm: "sha256", value: digest },
    byteLength: bytes.byteLength,
    mediaType: meta.mediaType,
    capturedAt,
    ...(meta.license ? { license: meta.license } : {}),
    adaptation: meta.adaptation ?? [],
    overlays: meta.overlays ?? [],
  });
  if (!provenance.success)
    throw new ConnectorError("invalid-request", {
      detail: "source.record-invalid",
    });
  const artifactRef = await artifacts.put(meta.tenantId, bytes, {
    mediaType: meta.mediaType,
    digest,
    ...(meta.retainUntil === undefined ? {} : { retainUntil: meta.retainUntil }),
  });
  const record = sourceRecordSchema.safeParse({
    ...provenance.data,
    artifactRef,
  });
  if (!record.success)
    throw new ConnectorError("invalid-request", {
      detail: "source.artifact-ref-invalid",
    });
  return record.data;
}

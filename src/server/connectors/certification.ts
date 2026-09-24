import {
  createHash,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
  type KeyObject,
} from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import {
  canonicalConnectorJson,
  connectorReferenceSchema,
  safeTextSchema,
  supportEvidenceSchema,
  type SupportEvidence,
} from "../../core/connectors/index.js";

/*
 * Attended certification records: the only way an `attended-live` support
 * entry enters the ledgers.
 *
 * A person runs `scripts/certify-attended.ts` against a real provider,
 * confirms every step that needed a human, and the harness writes one of
 * these: who attended, which provider and flow, the commit that ran, a
 * digest of the value-free transcript, and an Ed25519 signature by the
 * attendant's key over all of it. The ledger generator verifies it before
 * deriving an entry, and refuses:
 *
 * - a signature that does not verify, or a key that is not in the reviewed
 *   certifier list (`certifiers.json`), or an attendant whose name is not
 *   the one that list gives the key;
 * - a record dated after the day it is evaluated;
 * - a provider origin that is not a public HTTPS origin (loopback, private
 *   and reserved names such as `.test`, `.example`, `.invalid` and
 *   `.localhost` are stand-ins, not providers);
 * - a rehearsal. The harness is exercised end to end against the local auth
 *   double, and what that writes is marked `rehearsal: true`. It is signed
 *   and well formed exactly like a real one, so the only thing standing
 *   between a rehearsal and a certification is this refusal, and it is
 *   unconditional.
 *
 * Nothing here holds a value: the transcript is kept as a digest and step
 * counts, the provider as a display name and origins, the flow as a kind.
 */

export const certificationFlows = [
  "registration",
  "stitched-chain",
  "catalog-connect",
] as const;
export type CertificationFlow = (typeof certificationFlows)[number];

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const origin = z
  .string()
  .max(200)
  .refine(
    (value) => URL.canParse(value) && new URL(value).origin === value,
    "An origin, with no path, query or credentials",
  );

export const attendedCertificationSchema = z.strictObject({
  kind: z.literal("attended-certification"),
  schemaVersion: z.literal(1),
  /** Also the named check its entry carries: `attended:<id>`. */
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]{3,119}$/),
  adapterId: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[a-z0-9][a-z0-9._:-]*$/),
  /** The definition a generic adapter ran; see `evidenceScope`. */
  definition: connectorReferenceSchema.optional(),
  provider: z.strictObject({
    name: safeTextSchema.min(1).max(80),
    origins: z.array(origin).min(1).max(8),
  }),
  flow: z.enum(certificationFlows),
  /** True for a run against local doubles. Never certification. */
  rehearsal: z.boolean(),
  attendedBy: safeTextSchema.min(1).max(120),
  recordedAt: day,
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  transcript: z.strictObject({
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    steps: z.number().int().min(1).max(200),
    humanSteps: z.number().int().min(0).max(200),
  }),
  outcome: z.literal("completed"),
  signature: z.strictObject({
    algorithm: z.literal("ed25519"),
    keyId: z.string().regex(/^[0-9a-f]{32}$/),
    value: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  }),
});
export type AttendedCertification = z.infer<typeof attendedCertificationSchema>;
export type UnsignedCertification = Omit<AttendedCertification, "signature">;

export const certifiersSchema = z.strictObject({
  certifiers: z
    .array(
      z.strictObject({
        keyId: z.string().regex(/^[0-9a-f]{32}$/),
        name: safeTextSchema.min(1).max(120),
        /** Base64 SPKI DER of an Ed25519 public key. */
        publicKey: z.string().min(40).max(200),
      }),
    )
    .max(100),
});
export type Certifiers = z.infer<typeof certifiersSchema>;

/** A key's identifier: the first 32 hex digits of SHA-256 over its SPKI DER. */
export function certifierKeyId(publicKey: KeyObject): string {
  return createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex")
    .slice(0, 32);
}

/** What the signature covers: the whole record but the signature value, canonically. */
function signedBytes(
  record: UnsignedCertification & {
    signature: Omit<AttendedCertification["signature"], "value">;
  },
): Buffer {
  return Buffer.from(canonicalConnectorJson(record), "utf8");
}

export function signCertification(
  unsigned: UnsignedCertification,
  privateKey: KeyObject,
): AttendedCertification {
  const keyId = certifierKeyId(createPublicKey(privateKey));
  const header = { algorithm: "ed25519" as const, keyId };
  const value = signBytes(
    null,
    signedBytes({ ...unsigned, signature: header }),
    privateKey,
  ).toString("base64");
  return attendedCertificationSchema.parse({
    ...unsigned,
    signature: { ...header, value },
  });
}

/** Names that stand in for a provider and never are one. */
const reservedSuffixes = [
  ".test",
  ".example",
  ".invalid",
  ".localhost",
  ".local",
  ".internal",
];

/**
 * Whether an origin can be a real provider's: HTTPS, a registrable-looking
 * host with no trailing dot, not an IP literal, not loopback and not a
 * reserved example name.
 */
export function isProviderOrigin(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value) return false;
  const host = url.hostname.toLowerCase();
  // A fully qualified name ends in a dot (`localhost.`, `auth.test.`) and
  // resolves like the name without it, so it would slip every suffix check
  // below. No provider's configured origin is spelled that way: refuse it.
  if (host.endsWith(".")) return false;
  if (isIP(host.replace(/^\[|\]$/g, "")) !== 0) return false;
  if (host === "localhost" || !host.includes(".")) return false;
  return !reservedSuffixes.some(
    (suffix) => host.endsWith(suffix) || host === suffix.slice(1),
  );
}

/**
 * Every reason this record is not an admissible certification, empty when
 * it is. `asOf` is the evaluation instant; a record dated after its day is
 * refused.
 */
export function certificationProblems(
  raw: unknown,
  certifiers: Certifiers,
  options: { asOf: number },
): string[] {
  const parsed = attendedCertificationSchema.safeParse(raw);
  if (!parsed.success)
    return parsed.error.issues
      .slice(0, 3)
      .map(
        (issue) =>
          `${issue.path.length ? `${issue.path.join(".")} ` : ""}${issue.message}`,
      );
  const record = parsed.data;
  const problems: string[] = [];
  const certifier = certifiers.certifiers.find(
    (item) => item.keyId === record.signature.keyId,
  );
  if (!certifier) problems.push("signed by a key no certifier holds");
  else {
    let publicKey: KeyObject | undefined;
    try {
      publicKey = createPublicKey({
        key: Buffer.from(certifier.publicKey, "base64"),
        format: "der",
        type: "spki",
      });
    } catch {
      problems.push("the certifier's public key does not parse");
    }
    if (publicKey) {
      if (
        publicKey.asymmetricKeyType !== "ed25519" ||
        certifierKeyId(publicKey) !== certifier.keyId
      )
        problems.push("the certifier's key does not match its identifier");
      else {
        const { value, ...header } = record.signature;
        const valid = verifyBytes(
          null,
          signedBytes({ ...record, signature: header }),
          publicKey,
          Buffer.from(value, "base64"),
        );
        if (!valid) problems.push("the signature does not verify");
      }
    }
    if (certifier.name !== record.attendedBy)
      problems.push(
        "the attendant is not the person the certifier list gives this key",
      );
  }
  const today = new Date(
    Math.floor(options.asOf / 86_400_000) * 86_400_000,
  ).toISOString();
  if (record.recordedAt > today.slice(0, 10))
    problems.push(`dated ${record.recordedAt}, after ${today.slice(0, 10)}`);
  const stand = record.provider.origins.filter(
    (item) => !isProviderOrigin(item),
  );
  if (stand.length > 0)
    problems.push(
      `a provider origin is a local or reserved stand-in (${stand.length} of ${record.provider.origins.length})`,
    );
  if (record.rehearsal)
    problems.push("a rehearsal against local doubles is not a certification");
  return problems;
}

/** The support entry a verified certification earns. Call only when `certificationProblems` is empty. */
export function certificationEvidence(
  record: AttendedCertification,
): SupportEvidence {
  return supportEvidenceSchema.parse({
    adapterId: record.adapterId,
    check: `attended:${record.id}`,
    target: "attended-live",
    recordedAt: record.recordedAt,
    attendedBy: record.attendedBy,
    ...(record.definition ? { definition: record.definition } : {}),
    notes: `${record.flow} at ${record.provider.name}, commit ${record.commit.slice(0, 12)}, transcript ${record.transcript.digest.slice(7, 19)}`,
  });
}

/** The value-free transcript a certification's digest is computed over. */
export const certificationTranscriptSchema = z
  .array(
    z.strictObject({
      step: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
      kind: z.enum(["attestation", "driver", "service", "human"]),
      outcome: z.enum(["confirmed", "completed", "declined", "failed"]),
      /** For a driver step: the driver's own outcome, counts and a digest of its value-free transcript. */
      driver: z
        .strictObject({
          status: z.string().regex(/^[a-z-]{1,32}$/),
          steps: z.number().int().min(0).max(1000),
          handoffs: z.number().int().min(0).max(100),
          digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
        })
        .optional(),
    }),
  )
  .min(1)
  .max(200);
export type CertificationTranscript = z.infer<
  typeof certificationTranscriptSchema
>;

export function digestOf(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalConnectorJson(value)).digest("hex")}`;
}

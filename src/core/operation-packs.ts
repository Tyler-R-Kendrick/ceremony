import { z } from "zod";
import {
  identifierSchema,
  registeredInputContractSchema,
  semanticVersionSchema,
} from "./operation-contracts.js";

/*
 * Operation packs: new step types a host loads at startup, from a directory
 * it configures, without a rebuild.
 *
 * A pack is a signed manifest plus one handler bundle. The manifest says
 * everything a reviewer needs to decide whether to trust it: which
 * operations it adds, the host vocabulary each reads and writes, whether an
 * operation has an effect, every origin it may contact, and which
 * credentials it may have injected. The signature covers the manifest's
 * canonical encoding, and the manifest carries the bundle's SHA-256, so one
 * Ed25519 signature binds both. Nothing here verifies anything: signature
 * checks, trust, sandboxing and registration are the server's
 * (`src/server/operation-packs.ts`). This module only fixes the format, so a
 * publisher's tooling and the host read the same bytes the same way.
 */

export const OPERATION_PACK_LIMITS = Object.freeze({
  manifestBytes: 64 * 1024,
  bundleBytes: 1024 * 1024,
  operations: 32,
  slots: 32,
  destinations: 16,
  credentials: 8,
  fixtures: 16,
  /** Outbound requests one invocation may make. */
  requests: 16,
  requestBodyBytes: 64 * 1024,
  responseBytes: 256 * 1024,
  timeoutMs: { default: 10_000, max: 30_000 },
  memoryMb: { default: 32, max: 128 },
  outputBytes: { default: 16 * 1024, max: 64 * 1024 },
});

export const packIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export const packOperationNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,47}$/);
/** The id a host's trust configuration lists a publisher's public key under. */
export const packPublisherKeyIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const headerNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,64}$/)
  .refine(
    (name) =>
      ![
        "authorization",
        "proxy-authorization",
        "cookie",
        "host",
        "content-length",
        "transfer-encoding",
        "connection",
      ].includes(name.toLowerCase()),
    "A credential cannot be placed in a transport or cookie header",
  );

/** The registered operation id a pack operation gets: `pack:<packId>/<name>`. */
export function packOperationId(packId: string, name: string): string {
  return `pack:${packId}/${name}`;
}

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
/**
 * An exact origin, spelled canonically: HTTPS, or HTTP on a loopback host
 * for local fixtures. A host admits loopback only when it opts in, exactly as
 * connector destinations do.
 */
export const packDestinationSchema = z
  .string()
  .max(200)
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      url.origin === value &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && loopbackHosts.has(url.hostname)))
    );
  }, "A destination is an exact HTTPS origin");
export function isLoopbackPackDestination(origin: string): boolean {
  return new URL(origin).protocol === "http:";
}

/**
 * A credential the host injects into a request the handler makes. The
 * handler names it; it never holds the value. `oauth-client` resolves a
 * `common.oauth-client` handle the operation takes as an input and is sent
 * as HTTP Basic client authentication (RFC 6749 section 2.3.1); `host` asks
 * the host's secret resolver for a named value and places it where the
 * signed manifest says.
 */
export const packCredentialSchema = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("oauth-client"),
    input: identifierSchema,
  }),
  z.strictObject({
    source: z.literal("host"),
    name: identifierSchema,
    placement: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("bearer") }),
      z.strictObject({ kind: z.literal("header"), name: headerNameSchema }),
    ]),
  }),
]);
export type PackCredential = z.infer<typeof packCredentialSchema>;

const slotsSchema = z
  .record(identifierSchema, registeredInputContractSchema)
  .refine(
    (slots) => Object.keys(slots).length <= OPERATION_PACK_LIMITS.slots,
    "Too many slots",
  );

export const packOperationSchema = z
  .strictObject({
    name: packOperationNameSchema,
    version: semanticVersionSchema,
    title: z.string().min(1).max(100),
    description: z.string().max(1000),
    /**
     * `neutral` steps join any provider's run and may use only neutral
     * vocabulary; `provider` steps are admitted only into runs (or recipe
     * invocations) under that provider and profile.
     */
    scope: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("neutral") }),
      z.strictObject({
        kind: z.literal("provider"),
        provider: identifierSchema.refine((value) => value !== "common"),
        profile: identifierSchema.refine((value) => value !== "common"),
      }),
    ]),
    inputs: slotsSchema,
    outputs: slotsSchema,
    /** `read` operations may only send GET and HEAD. */
    effect: z.enum(["read", "write"]),
    destinations: z
      .array(packDestinationSchema)
      .max(OPERATION_PACK_LIMITS.destinations),
    credentials: z
      .record(identifierSchema, packCredentialSchema)
      .refine(
        (value) =>
          Object.keys(value).length <= OPERATION_PACK_LIMITS.credentials,
        "Too many credentials",
      ),
    /** Whether the bundle exports a `verify` for this operation. */
    verify: z.boolean(),
    /** Only a read may declare itself safe to repeat. */
    replay: z.literal("read-only").optional(),
    /** Where the publisher's evidence for this operation lives. */
    fixtures: z
      .array(z.string().min(1).max(200))
      .min(1)
      .max(OPERATION_PACK_LIMITS.fixtures),
    limits: z
      .strictObject({
        timeoutMs: z
          .number()
          .int()
          .min(100)
          .max(OPERATION_PACK_LIMITS.timeoutMs.max)
          .optional(),
        memoryMb: z
          .number()
          .int()
          .min(8)
          .max(OPERATION_PACK_LIMITS.memoryMb.max)
          .optional(),
        outputBytes: z
          .number()
          .int()
          .min(2)
          .max(OPERATION_PACK_LIMITS.outputBytes.max)
          .optional(),
      })
      .optional(),
  })
  .superRefine((operation, context) => {
    const issue = (message: string) =>
      context.addIssue({ code: "custom", message });
    if (operation.replay && operation.effect !== "read")
      issue("Only a read operation may declare replay");
    if (new Set(operation.destinations).size !== operation.destinations.length)
      issue("Duplicate destination");
    for (const credential of Object.values(operation.credentials))
      if (
        credential.source === "oauth-client" &&
        !Object.hasOwn(operation.inputs, credential.input)
      )
        issue("A credential names an input the operation does not take");
    if (
      Object.keys(operation.credentials).length &&
      !operation.destinations.length
    )
      issue("A credential needs a destination to be sent to");
  });
export type PackOperation = z.infer<typeof packOperationSchema>;

export const operationPackManifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: packIdSchema,
    version: semanticVersionSchema,
    title: z.string().min(1).max(100),
    description: z.string().max(1000),
    /** The key id the host's trust configuration lists; the envelope's signature must be by it. */
    publisher: packPublisherKeyIdSchema,
    /** The handler bundle (`handler.js` beside the manifest), by exact size and SHA-256. */
    bundle: z.strictObject({
      sha256: sha256Schema,
      bytes: z.number().int().min(1).max(OPERATION_PACK_LIMITS.bundleBytes),
    }),
    operations: z
      .array(packOperationSchema)
      .min(1)
      .max(OPERATION_PACK_LIMITS.operations),
  })
  .superRefine((manifest, context) => {
    const keys = manifest.operations.map(
      (operation) => `${operation.name}@${operation.version}`,
    );
    if (new Set(keys).size !== keys.length)
      context.addIssue({ code: "custom", message: "Duplicate operation" });
  });
export type OperationPackManifest = z.infer<typeof operationPackManifestSchema>;

/** `pack.json`: the manifest and the publisher's detached signature over it. */
export const operationPackEnvelopeSchema = z.strictObject({
  manifest: operationPackManifestSchema,
  signature: z.strictObject({
    algorithm: z.literal("ed25519"),
    keyId: packPublisherKeyIdSchema,
    /** Base64 of the 64-byte Ed25519 signature. */
    value: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  }),
});
export type OperationPackEnvelope = z.infer<typeof operationPackEnvelopeSchema>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
const SIGNING_CONTEXT = "ceremony-operation-pack-v1\n";
/**
 * The exact bytes a publisher signs: a fixed context string, then the parsed
 * manifest as JSON with object keys sorted at every depth. Parsing first
 * means an unknown field can never ride along unsigned, and the context
 * string means a signature over some other artifact never verifies here.
 */
export function operationPackSigningPayload(manifest: unknown): Uint8Array {
  return new TextEncoder().encode(
    SIGNING_CONTEXT +
      JSON.stringify(canonical(operationPackManifestSchema.parse(manifest))),
  );
}

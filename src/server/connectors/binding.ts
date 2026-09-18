import { z } from "zod";
import {
  bindingReferenceSchema,
  connectorReferenceSchema,
  identifierSchema,
  nativeIdentifierSchema,
  safeTextSchema,
} from "../../core/index.js";

/*
 * A runtime binding is the server's answer to "what may this connector
 * actually touch". It pins the exact destinations, the operations a caller may
 * name, how each operation's output is classified, which credential authority
 * signs requests, and which network policy applies. Callers choose a binding,
 * an operation and validated input — never a URL, a header, a scope, SQL, a
 * callback origin or a credential owner. A binding is immutable per revision;
 * a changed source or policy produces a new revision and invalidates evidence
 * that was bound to the old one.
 */

export const approvedDestinationSchema = z.strictObject({
  id: identifierSchema,
  /** Exact origin; host and port are compared exactly, never by suffix. */
  origin: z.string().refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      url.origin === value &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
    );
  }, "Destination must be an exact HTTPS (or loopback HTTP) origin"),
  /** Optional path prefix every operation under this destination must start with. */
  pathPrefix: z
    .string()
    .max(512)
    .regex(/^\/(?!\/)[^\p{Cc}?#]*$/u)
    .optional(),
  /** Which network policy admitted this destination. */
  network: z.enum(["public", "approved-private", "loopback-fixture"]),
});
export type ApprovedDestination = z.infer<typeof approvedDestinationSchema>;

export const boundOperationSchema = z.strictObject({
  operationRef: connectorReferenceSchema,
  nativeId: nativeIdentifierSchema,
  destinationId: identifierSchema,
  /** Adapter-specific transport shape; the adapter validates it against its own profile. */
  transport: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("http"),
      method: z.enum([
        "GET",
        "HEAD",
        "POST",
        "PUT",
        "PATCH",
        "DELETE",
        "OPTIONS",
      ]),
      pathTemplate: z
        .string()
        .max(1024)
        .regex(/^\/[^\p{Cc}?#]*$/u),
    }),
    z.strictObject({
      kind: z.literal("mcp-tool"),
      toolName: nativeIdentifierSchema,
    }),
    z.strictObject({
      kind: z.literal("mcp-resource"),
      uriTemplate: z.string().max(2048),
    }),
    z.strictObject({
      kind: z.literal("mcp-prompt"),
      promptName: nativeIdentifierSchema,
    }),
    z.strictObject({
      kind: z.literal("broker-action"),
      action: nativeIdentifierSchema,
    }),
    z.strictObject({
      kind: z.literal("delegated"),
      /** Adapter-owned opaque routing; still bound to a destination id. */
      route: z
        .string()
        .max(256)
        .regex(/^[^\p{Cc}]+$/u),
    }),
  ]),
  /** Declared effect; the host's consent policy below decides what that requires. */
  effect: z.enum(["read", "write", "unknown"]),
  /** Separate from effect: what the response may contain. */
  outputClassification: z.enum(["public", "personal", "secret"]),
  cost: z.enum(["free", "metered", "unknown"]),
  consent: z.enum(["none", "confirm"]),
  /** Explicit replay evidence this operation can rely on; absence means retries stay indeterminate. */
  replay: z.enum([
    "read-only",
    "upstream-idempotency-key",
    "reconciliation",
    "none",
  ]),
  /** Parameter names that select a target the connection must be permitted to touch. */
  targetParameters: z.array(identifierSchema).max(8),
  authenticationProfile: identifierSchema.optional(),
  description: safeTextSchema.optional(),
});
export type BoundOperation = z.infer<typeof boundOperationSchema>;

export const runtimeBindingSchema = bindingReferenceSchema
  .safeExtend({
    tenantId: z.string().min(1).max(200),
    /** Authentication profile id from the definition that this binding executes. */
    profileId: identifierSchema.optional(),
    destinations: z.array(approvedDestinationSchema).max(32),
    operations: z.array(boundOperationSchema).max(4096),
    /** Configuration names this binding needs, resolved privately at call time. */
    configuration: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/)).max(48),
    /** Targets (accounts, projects, repositories) connections under this binding may name. */
    permittedTargets: z
      .array(
        z.strictObject({
          kind: z
            .string()
            .regex(/^[a-z][a-z0-9-]*$/)
            .max(64),
          id: nativeIdentifierSchema,
        }),
      )
      .max(256),
    /** Digest of the exact transitive artifact set this approval reviewed. */
    reviewedDigest: z.string().regex(/^[a-f0-9]{64}$/),
    /** Adapter-owned, host-approved settings; never caller-supplied. Values are inert configuration, never secrets. */
    settings: z
      .record(z.string().max(120), z.unknown())
      .refine((value) => Object.keys(value).length <= 64),
  })
  .superRefine((binding, ctx) => {
    const destinations = new Set(binding.destinations.map((item) => item.id));
    if (destinations.size !== binding.destinations.length)
      ctx.addIssue({ code: "custom", message: "Duplicate destination id" });
    const refs = new Set<string>();
    for (const operation of binding.operations) {
      if (!destinations.has(operation.destinationId))
        ctx.addIssue({
          code: "custom",
          message: "Operation names an unapproved destination",
        });
      if (refs.has(operation.operationRef))
        ctx.addIssue({ code: "custom", message: "Duplicate operation ref" });
      refs.add(operation.operationRef);
      if (operation.effect !== "read" && operation.replay === "read-only")
        ctx.addIssue({
          code: "custom",
          message: "Only a read operation can claim read-only replay",
        });
    }
  });
export type RuntimeBinding = z.infer<typeof runtimeBindingSchema>;

/** The operation a caller named, or nothing: a caller never supplies transport details. */
export function boundOperation(
  binding: RuntimeBinding,
  operationRef: string,
): BoundOperation | undefined {
  return binding.operations.find((item) => item.operationRef === operationRef);
}

/** The exact destination an operation is pinned to; absence is a policy failure, not a lookup miss. */
export function destinationFor(
  binding: RuntimeBinding,
  operation: BoundOperation,
): ApprovedDestination {
  const destination = binding.destinations.find(
    (item) => item.id === operation.destinationId,
  );
  if (!destination) throw new Error("Operation destination is not approved");
  return destination;
}

/**
 * Resolves a request URL inside an approved destination. The path must stay
 * under the destination's prefix after normalization; `..`, `//`, encoded
 * slashes and absolute URLs in the template are rejected rather than joined.
 */
export function destinationUrl(
  destination: ApprovedDestination,
  path: string,
): URL {
  if (!path.startsWith("/") || path.startsWith("//") || /%2f/i.test(path))
    throw new Error("Operation path must be a single absolute path");
  const url = new URL(path, destination.origin);
  if (url.origin !== destination.origin)
    throw new Error("Operation path escaped its destination");
  const prefix = destination.pathPrefix ?? "/";
  const normalized = url.pathname;
  if (
    normalized.split("/").includes("..") ||
    !(
      normalized === prefix ||
      normalized.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`) ||
      prefix === "/"
    )
  )
    throw new Error("Operation path is outside the approved prefix");
  return url;
}

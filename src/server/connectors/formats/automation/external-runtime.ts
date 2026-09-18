import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  canonicalConnectorJson,
  connectorReferenceSchema,
  ecosystemSchema,
  nativeIdentifierSchema,
  nativeVersionSchema,
  ownerKindSchema,
  safeTextSchema,
} from "../../../../core/connectors/index.js";
import { identifierSchema } from "../../../../core/operation-contracts.js";
import {
  capabilityStatus,
  type AdapterCallContext,
  type CapabilityStatus,
  type ConnectorAdapter,
  type InvokeRequest,
  type InvokeResult,
} from "../../adapter.js";
import { boundOperation, destinationFor, destinationUrl } from "../../binding.js";
import { ConnectorError } from "../../errors.js";

/*
 * Executing an imported Zapier app, n8n node or Workato connector means
 * running someone else's code. This repository does not do that, and this
 * adapter is how it says so and still gets the work done: the code runs
 * somewhere the host already approved, and Ceremony talks to that place over
 * an authenticated HTTP contract it owns.
 *
 * An `ExternalRuntimeBinding` is the whole agreement. It names the imported
 * operation by its native identity, the approved destination that will run
 * it, which owner and which upstream account it may act for, the exact shape
 * of the input it accepts and the output it will return, what kind of effect
 * it has, and which execution environment it runs in. None of that comes from
 * the imported description, from the caller, or from the runtime's own
 * response: a description is a claim, and this is a decision.
 *
 * The wire contract (`ceremony-external-runtime/1`) is deliberately small:
 * one POST, a signed JSON body, a strict JSON reply. The signature is
 * HMAC-SHA256 over `timestamp.body` with a secret held in credential
 * custody — never read into a variable that outlives the call, never logged,
 * and never sent anywhere but the approved destination.
 */

export const EXTERNAL_RUNTIME_PROTOCOL = "ceremony-external-runtime/1" as const;
export const EXTERNAL_RUNTIME_ADAPTER_ID = "external-runtime" as const;
export const EXTERNAL_RUNTIME_ADAPTER_VERSION = "1.0.0" as const;

export const SIGNATURE_HEADER = "x-ceremony-signature";
export const SIGNATURE_TIMESTAMP_HEADER = "x-ceremony-signature-timestamp";
export const SIGNATURE_KEY_ID_HEADER = "x-ceremony-signature-key-id";

/** Credential material key holding the shared secret. */
export const SIGNING_SECRET_FIELD = "externalRuntimeSigningKey";
export const SIGNING_KEY_ID_FIELD = "externalRuntimeSigningKeyId";

/*
 * A deliberately small JSON shape language. It is not JSON Schema: there is
 * no `$ref`, no composition, no `pattern`, no `format`. A caller-supplied
 * regular expression is an execution primitive, and this file refuses to run
 * one. What remains is enough to pin an operation's input and output, and
 * small enough to validate in bounded time.
 */
export type RuntimeFieldSchema =
  | { type: "string"; enum?: string[]; maxLength?: number }
  | { type: "number"; minimum?: number; maximum?: number }
  | { type: "integer"; minimum?: number; maximum?: number }
  | { type: "boolean" }
  | { type: "null" }
  | { type: "array"; items: RuntimeFieldSchema; maxItems?: number }
  | {
      type: "object";
      properties: Record<string, RuntimeFieldSchema>;
      required?: string[];
      additionalProperties?: false;
    };

const fieldSchema: z.ZodType<RuntimeFieldSchema> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("string"),
      enum: z.array(z.string().max(512)).max(64).optional(),
      maxLength: z.number().int().positive().max(65_536).optional(),
    }),
    z.strictObject({
      type: z.literal("number"),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
    }),
    z.strictObject({
      type: z.literal("integer"),
      minimum: z.number().int().optional(),
      maximum: z.number().int().optional(),
    }),
    z.strictObject({ type: z.literal("boolean") }),
    z.strictObject({ type: z.literal("null") }),
    z.strictObject({
      type: z.literal("array"),
      items: fieldSchema,
      maxItems: z.number().int().positive().max(4096).optional(),
    }),
    z.strictObject({
      type: z.literal("object"),
      properties: z.record(z.string().max(120), fieldSchema),
      required: z.array(z.string().max(120)).max(128).optional(),
      additionalProperties: z.literal(false).optional(),
    }),
  ]),
);

const VALIDATION_LIMITS = Object.freeze({ depth: 16, nodes: 8192 });

/** Validates a value against a runtime field schema, in bounded time. */
export function validateRuntimeValue(
  schema: RuntimeFieldSchema,
  value: unknown,
): { ok: true } | { ok: false; path: string } {
  let nodes = 0;
  const walk = (
    current: RuntimeFieldSchema,
    item: unknown,
    path: string,
    depth: number,
  ): string | undefined => {
    if (++nodes > VALIDATION_LIMITS.nodes || depth > VALIDATION_LIMITS.depth)
      return path;
    switch (current.type) {
      case "string":
        if (typeof item !== "string") return path;
        if (current.maxLength !== undefined && item.length > current.maxLength)
          return path;
        if (current.enum && !current.enum.includes(item)) return path;
        return undefined;
      case "number":
      case "integer": {
        if (typeof item !== "number" || !Number.isFinite(item)) return path;
        if (current.type === "integer" && !Number.isInteger(item)) return path;
        if (current.minimum !== undefined && item < current.minimum) return path;
        if (current.maximum !== undefined && item > current.maximum) return path;
        return undefined;
      }
      case "boolean":
        return typeof item === "boolean" ? undefined : path;
      case "null":
        return item === null ? undefined : path;
      case "array": {
        if (!Array.isArray(item)) return path;
        if (current.maxItems !== undefined && item.length > current.maxItems)
          return path;
        for (const [index, entry] of item.entries()) {
          const failure = walk(current.items, entry, `${path}/${index}`, depth + 1);
          if (failure) return failure;
        }
        return undefined;
      }
      case "object": {
        if (!item || typeof item !== "object" || Array.isArray(item)) return path;
        const prototype = Object.getPrototypeOf(item);
        if (prototype !== Object.prototype && prototype !== null) return path;
        const source = item as Record<string, unknown>;
        for (const key of current.required ?? [])
          if (!Object.hasOwn(source, key)) return `${path}/${key}`;
        for (const key of Object.keys(source)) {
          // `properties` is data, so it is read as data: an own-property
          // lookup. A plain `properties[key]` would find `Object.prototype`
          // for a key like `__proto__` and treat a pollution attempt as a
          // declared field.
          if (["__proto__", "prototype", "constructor"].includes(key))
            return `${path}/${key}`;
          const child = Object.hasOwn(current.properties, key)
            ? current.properties[key]
            : undefined;
          if (!child) {
            if (current.additionalProperties === false) return `${path}/${key}`;
            continue;
          }
          const failure = walk(child, source[key], `${path}/${key}`, depth + 1);
          if (failure) return failure;
        }
        return undefined;
      }
    }
  };
  const failure = walk(schema, value, "", 1);
  return failure === undefined ? { ok: true } : { ok: false, path: failure };
}

/** The identity of the imported operation the external runtime will execute. */
export const externalOperationIdentitySchema = z.strictObject({
  ecosystem: ecosystemSchema,
  nativeId: nativeIdentifierSchema,
  nativeVersion: nativeVersionSchema,
});
export type ExternalOperationIdentity = z.infer<
  typeof externalOperationIdentitySchema
>;

/** Where the code actually runs. A fixture is never silently a vendor runtime. */
export const executionEnvironmentClasses = [
  "vendor-hosted",
  "host-managed-sandbox",
  "trusted-local-runner",
  "loopback-fixture",
] as const;
export const executionEnvironmentClassSchema = z.enum(
  executionEnvironmentClasses,
);
export type ExecutionEnvironmentClass = z.infer<
  typeof executionEnvironmentClassSchema
>;

export const externalRuntimeBindingSchema = z.strictObject({
  /** The bound operation in the host's `RuntimeBinding` this agreement belongs to. */
  operationRef: connectorReferenceSchema,
  /** The imported operation, by its native identity — never by a URL. */
  identity: externalOperationIdentitySchema,
  /** The approved destination that runs it; it must be one the binding lists. */
  destinationId: identifierSchema,
  /** The path under that destination; a single absolute path, checked on use. */
  path: z
    .string()
    .max(1024)
    .regex(/^\/(?!\/)[^\p{Cc}?#]*$/u),
  /** Which host principal this agreement acts for. */
  owner: z.strictObject({
    kind: ownerKindSchema,
    id: nativeIdentifierSchema,
  }),
  /**
   * The upstream account the runtime holds for that owner. It is checked
   * against the connection's recorded external id: a runtime that would act
   * for a different account is refused before the call, not explained after.
   */
  account: z
    .strictObject({
      authority: z.string().min(1).max(256),
      externalIdName: z.string().min(1).max(120),
      externalId: nativeIdentifierSchema,
    })
    .optional(),
  input: fieldSchema,
  output: fieldSchema,
  /** Declared effect; the host's binding decides consent and classification. */
  effect: z.enum(["read", "write", "unknown"]),
  outputClassification: z.enum(["public", "personal", "secret"]),
  /** What makes a retry safe; absent evidence leaves an interrupted call indeterminate. */
  replay: z.enum([
    "read-only",
    "upstream-idempotency-key",
    "reconciliation",
    "none",
  ]),
  environmentClass: executionEnvironmentClassSchema,
  /** Milliseconds this operation may take before the call is abandoned. */
  timeoutMs: z.number().int().positive().max(600_000).default(30_000),
  /** How far apart the host's and the runtime's clocks may be, for the signature. */
  signatureToleranceMs: z.number().int().positive().max(3_600_000).default(300_000),
  description: safeTextSchema.optional(),
});
export type ExternalRuntimeBinding = z.infer<typeof externalRuntimeBindingSchema>;

/** The reply contract. Anything else is a protocol failure, not an outcome. */
const runtimeReplySchema = z.strictObject({
  protocol: z.literal(EXTERNAL_RUNTIME_PROTOCOL),
  status: z.enum(["completed", "failed", "denied", "human-required"]),
  output: z.unknown().optional(),
  /** A bounded code; the runtime's prose never becomes Ceremony's prose. */
  code: z
    .string()
    .max(120)
    .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){0,11}$/)
    .optional(),
});

export type ExternalRuntimeAdapterOptions = {
  /** The agreements this deployment approved, by operation reference. */
  bindings: readonly ExternalRuntimeBinding[];
  /** Display ecosystem for the broker itself; the operations carry the real one. */
  ecosystem?: string;
  id?: string;
  displayName?: string;
  description?: string;
  service?: string;
  /** Maximum reply size read from the runtime. */
  maxResponseBytes?: number;
};

const MAX_RESPONSE_BYTES = 256 * 1024;

function digestOf(value: unknown): string {
  return createHash("sha256").update(canonicalConnectorJson(value)).digest("hex");
}

/** `timestamp.body`, signed with HMAC-SHA256 and rendered as `v1=<hex>`. */
export function externalRuntimeSignature(
  secret: string,
  timestamp: number,
  body: string,
): string {
  return `v1=${createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex")}`;
}

/**
 * Verifies a signature the way a runtime should. It lives here so the fixture
 * runtime in the tests checks the signature with the same code path the
 * adapter produces, and so a host writing a real runtime has one obvious
 * implementation to copy.
 */
export function verifyExternalRuntimeSignature(input: {
  secret: string;
  timestamp: number;
  body: string;
  signature: string;
  now: number;
  toleranceMs: number;
}): boolean {
  if (!Number.isFinite(input.timestamp)) return false;
  if (Math.abs(input.now - input.timestamp) > input.toleranceMs) return false;
  const expected = Buffer.from(
    externalRuntimeSignature(input.secret, input.timestamp, input.body),
  );
  const presented = Buffer.from(input.signature);
  return (
    expected.length === presented.length && timingSafeEqual(expected, presented)
  );
}

/**
 * An adapter that invokes an imported operation in a runtime the host already
 * approved. It imports nothing, authorizes nothing and discovers nothing:
 * those belong to the ecosystem readers and to the host's own authorization.
 */
export function createExternalRuntimeAdapter(
  options: ExternalRuntimeAdapterOptions,
): ConnectorAdapter {
  const bindings = new Map<string, ExternalRuntimeBinding>();
  for (const binding of options.bindings) {
    const parsed = externalRuntimeBindingSchema.parse(binding);
    if (bindings.has(parsed.operationRef))
      throw new Error("Duplicate external runtime binding");
    bindings.set(parsed.operationRef, parsed);
  }
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
  const adapterVersion = EXTERNAL_RUNTIME_ADAPTER_VERSION;

  const adapter: ConnectorAdapter = {
    id: options.id ?? EXTERNAL_RUNTIME_ADAPTER_ID,
    ecosystem: options.ecosystem ?? "external-runtime",
    adapterVersion,
    runtime: "hosted-server",
    displayName: options.displayName ?? "Host-approved external runtime",
    description:
      options.description ??
      "Invokes an imported automation operation in a runtime the host registered and approved. Imported code never runs inside Ceremony.",
    service: options.service ?? "external-runtime",
    support: "provider-backed",
    custody: ["external-execution-broker"],
    configuration: [],
    profiles: [EXTERNAL_RUNTIME_PROTOCOL],

    capabilities(present: ReadonlySet<string>): CapabilityStatus[] {
      void present;
      const environments = [
        ...new Set([...bindings.values()].map((item) => item.environmentClass)),
      ];
      return [
        capabilityStatus(adapter, {
          dimension: "invoke",
          profile: EXTERNAL_RUNTIME_PROTOCOL,
          configuration: bindings.size ? "ready" : "missing",
          evidence: "protocol-fixture",
          limitations: [
            "Only operations with an approved external runtime binding can be invoked.",
            "Imported connector code is never executed inside Ceremony.",
            ...(environments.length
              ? [`Execution environments: ${environments.join(", ")}.`]
              : []),
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "import",
          profile: EXTERNAL_RUNTIME_PROTOCOL,
          implementation: "unsupported",
          limitations: [
            "Importing a description is the ecosystem reader's job, not the runtime broker's.",
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "delegate",
          profile: EXTERNAL_RUNTIME_PROTOCOL,
          configuration: bindings.size ? "ready" : "missing",
          evidence: "protocol-fixture",
          limitations: [
            "Delegation is bounded to the approved operation, owner and account.",
          ],
        }),
      ];
    },

    async invoke(
      ctx: AdapterCallContext,
      request: InvokeRequest,
    ): Promise<InvokeResult> {
      const operation = boundOperation(ctx.binding, request.operationRef);
      if (!operation)
        throw new ConnectorError("denied", { detail: "operation.unapproved" });
      if (operation.transport.kind !== "delegated")
        throw new ConnectorError("unsupported", { detail: "transport.mismatch" });
      const runtime = bindings.get(request.operationRef);
      if (!runtime)
        throw new ConnectorError("unsupported", { detail: "runtime.unbound" });
      if (runtime.destinationId !== operation.destinationId)
        throw new ConnectorError("denied", { detail: "destination.mismatch" });

      // The owner and the account are the host's decision, not the caller's
      // and not the runtime's. A connection that belongs to someone else, or
      // that is linked to a different upstream account, is refused here.
      const connection = ctx.connection;
      if (!connection)
        throw new ConnectorError("denied", { detail: "connection.required" });
      if (
        connection.ownerKind !== runtime.owner.kind ||
        connection.ownerId !== runtime.owner.id
      )
        throw new ConnectorError("denied", { detail: "owner.mismatch" });
      if (runtime.account) {
        if (connection.authorityInstance !== runtime.account.authority)
          throw new ConnectorError("denied", { detail: "authority.mismatch" });
        if (
          connection.externalIds[runtime.account.externalIdName] !==
          runtime.account.externalId
        )
          throw new ConnectorError("denied", { detail: "account.mismatch" });
      }

      const validated = validateRuntimeValue(runtime.input, request.input);
      if (!validated.ok)
        throw new ConnectorError("invalid-request", { detail: "input.schema" });

      const destination = destinationFor(ctx.binding, operation);
      const url = destinationUrl(destination, runtime.path);

      const digest = digestOf({
        operationRef: runtime.operationRef,
        identity: runtime.identity,
        input: request.input,
        ...(request.idempotencyKey && runtime.replay === "upstream-idempotency-key"
          ? { idempotencyKey: request.idempotencyKey }
          : {}),
      });
      const { effectRef, prior } = await ctx.environment.effects.begin({
        actor: ctx.actor,
        connectionRef: connection.connectionRef,
        bindingRef: ctx.binding.bindingRef,
        operation: `external-runtime:${runtime.identity.ecosystem}:${runtime.identity.nativeId}`,
        digest,
        ...(request.idempotencyKey &&
        runtime.replay === "upstream-idempotency-key"
          ? {
              idempotency: {
                key: request.idempotencyKey,
                scope: `${runtime.identity.ecosystem}/${runtime.identity.nativeId}`,
              },
            }
          : {}),
        commandId: request.commandId,
      });
      // A repeated request digest is the same effect, not a new one. Only a
      // genuinely read-only operation may simply be performed again.
      if (prior && runtime.replay !== "read-only")
        return {
          state:
            prior.status === "applied"
              ? "complete"
              : prior.status === "failed"
                ? "failed"
                : prior.status === "not-applied"
                  ? "failed"
                  : "indeterminate",
          outputClassification: runtime.outputClassification,
          effect: runtime.effect,
          code: prior.code ?? "effect.replayed",
          effectRef,
        };

      const issuedAt = ctx.environment.now();
      const body = JSON.stringify({
        protocol: EXTERNAL_RUNTIME_PROTOCOL,
        operation: runtime.identity,
        operationRef: runtime.operationRef,
        commandId: request.commandId,
        effectRef,
        owner: runtime.owner,
        ...(runtime.account
          ? {
              account: {
                authority: runtime.account.authority,
                externalId: runtime.account.externalId,
              },
            }
          : {}),
        environmentClass: runtime.environmentClass,
        issuedAt,
        input: request.input,
      });

      const credentialRef = connection.credentialRef;
      if (!credentialRef)
        throw new ConnectorError("configuration-required", {
          detail: "signing.key",
        });
      const scope = {
        tenantId: connection.tenantId,
        ownerKind: connection.ownerKind,
        ownerId: connection.ownerId,
        connectionRef: connection.connectionRef,
        bindingRef: ctx.binding.bindingRef,
        custody: "external-execution-broker" as const,
      };
      // The secret is read inside the custody callback and never leaves it;
      // what comes out is a signature, which is not the secret.
      const signature = await ctx.environment.credentials.use(
        scope,
        credentialRef,
        async (material) => {
          const secret = material[SIGNING_SECRET_FIELD];
          if (!secret)
            throw new ConnectorError("configuration-required", {
              detail: "signing.key",
            });
          return {
            value: externalRuntimeSignature(secret, issuedAt, body),
            ...(material[SIGNING_KEY_ID_FIELD]
              ? { keyId: material[SIGNING_KEY_ID_FIELD] }
              : {}),
          };
        },
      );

      const timeout = AbortSignal.timeout(runtime.timeoutMs);
      const signal = AbortSignal.any([ctx.signal, timeout]);
      let response: Response;
      try {
        response = await ctx.environment.fetch(url, {
          method: "POST",
          redirect: "error",
          signal,
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            [SIGNATURE_HEADER]: signature.value,
            [SIGNATURE_TIMESTAMP_HEADER]: String(issuedAt),
            ...(signature.keyId ? { [SIGNATURE_KEY_ID_HEADER]: signature.keyId } : {}),
          },
          body,
        });
      } catch {
        // The request may or may not have reached the runtime. Only a
        // genuinely read-only operation can say "nothing happened".
        const indeterminate = runtime.replay !== "read-only";
        await ctx.environment.effects.complete(effectRef, {
          status: indeterminate ? "indeterminate" : "not-applied",
          code: "upstream.unreachable",
          at: ctx.environment.now(),
        });
        if (indeterminate)
          return {
            state: "indeterminate",
            outputClassification: runtime.outputClassification,
            effect: runtime.effect,
            code: "upstream.unreachable",
            effectRef,
          };
        throw new ConnectorError("upstream-unavailable");
      }

      const text = await response.text();
      if (text.length > maxResponseBytes) {
        await ctx.environment.effects.complete(effectRef, {
          status: runtime.replay === "read-only" ? "not-applied" : "indeterminate",
          code: "upstream.oversized",
          at: ctx.environment.now(),
        });
        throw new ConnectorError("upstream-rejected", { detail: "reply.size" });
      }
      if (!response.ok) {
        const applied = runtime.replay === "read-only" ? "not-applied" : "failed";
        await ctx.environment.effects.complete(effectRef, {
          status: applied,
          code: "upstream.rejected",
          at: ctx.environment.now(),
        });
        return {
          state: "failed",
          outputClassification: runtime.outputClassification,
          effect: runtime.effect,
          code: "upstream.rejected",
          effectRef,
        };
      }
      let parsed: z.infer<typeof runtimeReplySchema>;
      try {
        parsed = runtimeReplySchema.parse(JSON.parse(text));
      } catch {
        // A reply this adapter cannot read is not a result. The call may well
        // have had its effect, so a write stays uncertain.
        const indeterminate = runtime.replay !== "read-only";
        await ctx.environment.effects.complete(effectRef, {
          status: indeterminate ? "indeterminate" : "not-applied",
          code: "upstream.malformed",
          at: ctx.environment.now(),
        });
        if (indeterminate)
          return {
            state: "indeterminate",
            outputClassification: runtime.outputClassification,
            effect: runtime.effect,
            code: "upstream.malformed",
            effectRef,
          };
        throw new ConnectorError("upstream-rejected", { detail: "reply.schema" });
      }

      if (parsed.status !== "completed") {
        await ctx.environment.effects.complete(effectRef, {
          status: parsed.status === "failed" ? "failed" : "not-applied",
          ...(parsed.code ? { code: parsed.code } : {}),
          at: ctx.environment.now(),
        });
        return {
          state:
            parsed.status === "denied"
              ? "denied"
              : parsed.status === "human-required"
                ? "human-required"
                : "failed",
          outputClassification: runtime.outputClassification,
          effect: runtime.effect,
          ...(parsed.code ? { code: parsed.code } : {}),
          effectRef,
        };
      }

      const checked = validateRuntimeValue(runtime.output, parsed.output);
      if (!checked.ok) {
        // The work was done; the description of it does not match what was
        // approved, which is a reconciliation problem, not a success.
        await ctx.environment.effects.complete(effectRef, {
          status: runtime.effect === "read" ? "not-applied" : "indeterminate",
          code: "upstream.output-schema",
          at: ctx.environment.now(),
        });
        return {
          state: runtime.effect === "read" ? "failed" : "indeterminate",
          outputClassification: runtime.outputClassification,
          effect: runtime.effect,
          code: "upstream.output-schema",
          effectRef,
        };
      }

      await ctx.environment.effects.complete(effectRef, {
        status: "applied",
        at: ctx.environment.now(),
      });
      return {
        state: "complete",
        output: parsed.output,
        outputClassification: runtime.outputClassification,
        effect: runtime.effect,
        effectRef,
      };
    },
  };
  return adapter;
}

/** The approved agreements, for a review screen or a ledger entry. */
export function describeExternalRuntimeBindings(
  bindings: readonly ExternalRuntimeBinding[],
): Array<{
  operationRef: string;
  identity: ExternalOperationIdentity;
  effect: string;
  environmentClass: ExecutionEnvironmentClass;
  owner: string;
}> {
  return bindings.map((binding) => ({
    operationRef: binding.operationRef,
    identity: binding.identity,
    effect: binding.effect,
    environmentClass: binding.environmentClass,
    owner: `${binding.owner.kind}:${binding.owner.id}`,
  }));
}

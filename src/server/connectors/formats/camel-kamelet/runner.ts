import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import {
  canonicalConnectorJson,
  nativeVersionSchema,
} from "../../../../core/connectors/identity.js";
import { identifierSchema } from "../../../../core/operation-contracts.js";
import type { AdapterCallContext, InvokeResult } from "../../adapter.js";
import {
  boundOperation,
  destinationFor,
  destinationUrl,
} from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import { kameletNameSchema, kameletPropertyNameSchema, kameletTypeSchema } from "./schemas.js";

/*
 * The seam for running a Kamelet.
 *
 * Ceremony never embeds a JVM, never resolves a Maven coordinate and never
 * deploys a Camel integration. A deployment that operates its own Camel runner
 * — Camel JBang, Camel K, or a service it already runs — may hand one to this
 * port, and that runner is the only thing that could ever turn a descriptor
 * into a running route. Every other deployment keeps the default, which is
 * unavailable and says exactly why.
 *
 * Availability is reported, not inferred. A browser deployment cannot host a
 * trusted local runner at all, so the adapter refuses to accept one rather
 * than advertising a capability the deployment could not honour.
 */

export const KAMELET_RUN_DESCRIPTOR_VERSION = 1;

/** Host configuration names are the only way a secret reaches a runner. */
const configurationNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/);

/**
 * What a runner is asked to run. It names the Kamelet, the catalog release it
 * came from, the non-secret parameter values the host approved, and the host
 * configuration names that hold the secret ones. A descriptor never contains a
 * credential value, a URL the host did not approve, or a route template: the
 * runner resolves the Kamelet from the catalog release named here.
 */
export const kameletRunDescriptorSchema = z.strictObject({
  descriptorVersion: z.literal(KAMELET_RUN_DESCRIPTOR_VERSION),
  catalogVersion: nativeVersionSchema,
  kamelet: z.strictObject({
    name: kameletNameSchema,
    type: kameletTypeSchema,
    /** Camel component scheme the template names; informational for the runner. */
    scheme: z
      .string()
      .max(64)
      .regex(/^[a-zA-Z][a-zA-Z0-9+.-]*$/)
      .optional(),
    dependencies: z.array(z.string().max(256)).max(256),
  }),
  parameters: z
    .record(
      kameletPropertyNameSchema,
      z.union([z.string().max(8192), z.number().finite(), z.boolean()]),
    )
    .refine((value) => Object.keys(value).length <= 256),
  /** Secret parameter name -> host configuration name. Values never travel. */
  secretParameters: z
    .record(kameletPropertyNameSchema, configurationNameSchema)
    .refine((value) => Object.keys(value).length <= 64),
  /** The runtime class a deployment must actually have to honour this descriptor. */
  requiredRuntime: z.literal("trusted-local-runner"),
});
export type KameletRunDescriptor = z.infer<typeof kameletRunDescriptorSchema>;

export type HostRunnerAvailability =
  | {
      available: true;
      /** Host-chosen runner id; display and audit only. */
      runnerId: string;
      mode: "local" | "remote";
      /** How the delegation is authenticated to the runner. */
      authentication: "host-signed" | "host-authenticated";
    }
  | { available: false; reason: string; code: string };

/**
 * The only interface through which a Kamelet descriptor could ever become a
 * running route. `available` is asked before anything is claimed in a catalog
 * entry; `run` is never reached unless the binding approved the operation.
 */
export interface KameletHostRunnerPort {
  available(): Promise<HostRunnerAvailability>;
  run(
    descriptor: KameletRunDescriptor,
    ctx: AdapterCallContext,
    request: { operationRef: string; input: unknown; commandId: string },
  ): Promise<InvokeResult>;
}

export const KAMELET_NO_RUNNER_CONFIGURED =
  "No Camel runner is configured for this deployment: Kamelets are imported as descriptions and exported as run descriptors only. Ceremony starts no JVM, resolves no dependency and deploys no integration.";

export const KAMELET_BROWSER_DEPLOYMENT_REASON =
  "This deployment runs in a browser runtime class, which cannot host or reach a trusted local Camel runner; local runner capabilities are never claimed here.";

/**
 * The default runner: unavailable, with the exact reason, fail-closed. `run`
 * throws rather than returning a failure result, because a caller that reached
 * it asked for an effect this deployment cannot perform at all.
 */
export function unavailableKameletRunner(
  reason: string = KAMELET_NO_RUNNER_CONFIGURED,
  code = "kamelet.runner.unavailable",
): KameletHostRunnerPort {
  const text = reason.slice(0, 500);
  return {
    async available() {
      return { available: false, reason: text, code };
    },
    async run() {
      throw new ConnectorError("unsupported", {
        detail: "kamelet.runner.unavailable",
      });
    },
  };
}

/*
 * Host-signed delegation to a configured remote runner.
 *
 * The signature is a host-internal scheme, not a vendor protocol: HMAC-SHA256
 * over `v1:<timestamp>:<nonce>:<sha256 of the canonical descriptor JSON>`,
 * carried in `ceremony-runner-signature: v1,t=...,n=...,s=<base64url>`. The
 * secret is read through the configuration port at call time and never stored
 * on the adapter. The runner's URL is a binding-approved destination; it is
 * never taken from a descriptor, a Kamelet or a caller.
 */
export const RUNNER_SIGNATURE_HEADER = "ceremony-runner-signature";
export const RUNNER_SIGNATURE_VERSION = "v1";

export function runnerSigningPayload(input: {
  timestamp: number;
  nonce: string;
  descriptorDigest: string;
}): string {
  return `${RUNNER_SIGNATURE_VERSION}:${input.timestamp}:${input.nonce}:${input.descriptorDigest}`;
}

export function signRunnerDelegation(
  secret: string,
  input: { timestamp: number; nonce: string; descriptorDigest: string },
): string {
  return createHmac("sha256", secret)
    .update(runnerSigningPayload(input))
    .digest("base64url");
}

/** Constant-time comparison of two base64url signatures of equal expected length. */
export function runnerSignatureMatches(
  expected: string,
  provided: string,
): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export type RemoteKameletRunnerOptions = {
  runnerId: string;
  /** Bound operation naming the approved runner destination and path. */
  operationRef: string;
  /** Host configuration holding the shared signing secret. */
  signingSecretConfiguration: string;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
};

const runnerResponseSchema = z.strictObject({
  state: z.enum(["complete", "failed", "indeterminate"]),
  /** Sanitized runner code; never runner prose or a stack trace. */
  code: z
    .string()
    .max(120)
    .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){0,11}$/)
    .optional(),
  output: z.unknown().optional(),
});

/**
 * A runner reached over HTTP at a binding-approved destination, authenticated
 * by a host-held signing secret. Availability depends on the secret being
 * configured: a deployment that has not configured it is unavailable with that
 * exact reason rather than silently unsigned.
 */
export function createRemoteKameletRunner(
  options: RemoteKameletRunnerOptions,
  environment: {
    readConfiguration: (name: string) => Promise<string | undefined>;
  },
): KameletHostRunnerPort {
  const timeoutMs = options.requestTimeoutMs ?? 30_000;
  const maxBytes = options.maxResponseBytes ?? 256 * 1024;
  return {
    async available() {
      const secret = await environment.readConfiguration(
        options.signingSecretConfiguration,
      );
      if (!secret)
        return {
          available: false,
          code: "kamelet.runner.secret-missing",
          reason: `The configured Camel runner "${options.runnerId}" cannot be used until ${options.signingSecretConfiguration} is present; an unsigned delegation is never sent.`,
        };
      return {
        available: true,
        runnerId: options.runnerId,
        mode: "remote",
        authentication: "host-signed",
      };
    },
    async run(descriptor, ctx, request) {
      const operation = boundOperation(ctx.binding, options.operationRef);
      if (!operation || operation.transport.kind !== "http")
        throw new ConnectorError("configuration-required", {
          detail: "kamelet.runner.unbound",
        });
      if (operation.transport.method !== "POST")
        throw new ConnectorError("invalid-request", {
          detail: "kamelet.runner.method",
        });
      const destination = destinationFor(ctx.binding, operation);
      const url = destinationUrl(destination, operation.transport.pathTemplate);
      const secret = await ctx.environment.configuration.read(
        options.signingSecretConfiguration,
      );
      if (!secret)
        throw new ConnectorError("configuration-required", {
          detail: "kamelet.runner.secret-missing",
        });
      const body = canonicalConnectorJson(
        kameletRunDescriptorSchema.parse(descriptor),
      );
      const timestamp = Math.floor(ctx.environment.now() / 1000);
      const nonce = ctx.environment.random.uuid();
      const descriptorDigest = createHash("sha256").update(body).digest("hex");
      const signature = signRunnerDelegation(secret, {
        timestamp,
        nonce,
        descriptorDigest,
      });
      const controller = new AbortController();
      const abort = () => controller.abort();
      ctx.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, timeoutMs);
      let response: Response;
      try {
        response = await ctx.environment.fetch(url, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            [RUNNER_SIGNATURE_HEADER]: `${RUNNER_SIGNATURE_VERSION},t=${timestamp},n=${nonce},s=${signature}`,
            "ceremony-runner-digest": descriptorDigest,
            "ceremony-command-id": request.commandId,
          },
          body,
        });
      } catch (error) {
        throw new ConnectorError(
          ctx.signal.aborted ? "cancelled" : "upstream-unavailable",
          { detail: "kamelet.runner.unreachable", cause: error },
        );
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", abort);
      }
      if (response.status === 401 || response.status === 403)
        throw new ConnectorError("denied", {
          detail: "kamelet.runner.rejected-signature",
        });
      if (!response.ok)
        throw new ConnectorError(
          response.status >= 500 ? "upstream-unavailable" : "upstream-rejected",
          { detail: "kamelet.runner.failed" },
        );
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > maxBytes)
        throw new ConnectorError("upstream-rejected", {
          detail: "kamelet.runner.response-oversized",
        });
      let parsed: unknown;
      try {
        parsed = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(buffer),
        ) as unknown;
      } catch {
        throw new ConnectorError("upstream-rejected", {
          detail: "kamelet.runner.response-invalid",
        });
      }
      const result = runnerResponseSchema.safeParse(parsed);
      if (!result.success)
        throw new ConnectorError("upstream-rejected", {
          detail: "kamelet.runner.response-invalid",
        });
      return {
        state: result.data.state,
        ...(result.data.output === undefined
          ? {}
          : { output: result.data.output }),
        outputClassification: operation.outputClassification,
        effect: operation.effect,
        ...(result.data.code ? { code: result.data.code } : {}),
      };
    },
  };
}

/** A fresh delegation nonce; exported so a host can pre-generate one for audit. */
export function runnerNonce(): string {
  return randomUUID();
}

/** Identifier guard for a runner id used in availability reports. */
export const runnerIdSchema = identifierSchema;

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  canonicalConnectorJson,
  measureJsonValue,
  type VerificationClaim,
} from "../../../../core/connectors/index.js";
import {
  boundOperation,
  destinationFor,
  destinationUrl,
  type BoundOperation,
  type RuntimeBinding,
} from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import {
  capabilityStatus,
  type AdapterCallContext,
  type CompletionResult,
  type ConnectorAdapter,
  type ExportOutcome,
  type ExportRequest,
  type ImportInput,
  type ImportOutcome,
  type InvokeRequest,
  type InvokeResult,
  type SupportLevel,
} from "../../adapter.js";
import type { CredentialMaterial, CredentialScope } from "../../ports.js";
import {
  dynamicFieldContractSchema,
  extractOptions,
  extractSchema,
  pathStringSegments,
  selectPathString,
  type DynamicFieldContract,
  type DynamicOptionsResult,
  type DynamicSchemaResult,
} from "./dynamic.js";
import { exportCustomConnector } from "./export.js";
import {
  MICROSOFT_ECOSYSTEM,
  MICROSOFT_PROFILE,
  TEST_CONNECTION_LIMITATIONS,
  readCustomConnector,
  CustomConnectorReadError,
} from "./read.js";

/*
 * The executing half of the Microsoft custom-connector support.
 *
 * It runs exactly two things, both under host approval: a dynamic field
 * lookup whose contract the binding carries, and the connection test the
 * binding names as its verifier. Everything else an imported connector
 * describes stays a description. The caller never supplies a URL, a contract,
 * a header or a credential: it names an approved operation ref and the values
 * already on the form, and the binding decides what that means.
 *
 * A dynamic lookup runs server-side with the current principal's connection
 * credentials — never as an unauthenticated browser fetch — and its cache key
 * carries the tenant, the owner, the connection and its generation, so one
 * person's list of projects can never be served to another (AC-EXT-10).
 */

export const MICROSOFT_ADAPTER_ID = "microsoft-custom-connector";
export const MICROSOFT_ADAPTER_VERSION = "1.0.0";

export const MICROSOFT_LIMITS = Object.freeze({
  responseBytes: 1024 * 1024,
  requestTimeoutMs: 10_000,
  cacheTtlMs: 60_000,
  cacheEntries: 512,
  headerValueLength: 1024,
  parameterValueLength: 2048,
});

export type DynamicResultBody = DynamicOptionsResult | DynamicSchemaResult;

export interface DynamicOptionCachePort {
  get(key: string): Promise<DynamicResultBody | undefined>;
  set(key: string, value: DynamicResultBody, ttlMs: number): Promise<void>;
  /** Drops every entry whose key begins with the prefix (one connection generation). */
  invalidate(prefix: string): Promise<number>;
}

/** An in-memory cache for one process; a deployment supplies its own. */
export function createMemoryDynamicCache(
  options: {
    now?: () => number;
    maxEntries?: number;
  } = {},
): DynamicOptionCachePort {
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? MICROSOFT_LIMITS.cacheEntries;
  const entries = new Map<
    string,
    { value: DynamicResultBody; expiresAt: number }
  >();
  return {
    async get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      return structuredClone(entry.value);
    },
    async set(key, value, ttlMs) {
      if (entries.size >= maxEntries) {
        const oldest = entries.keys().next();
        if (!oldest.done) entries.delete(oldest.value);
      }
      entries.set(key, {
        value: structuredClone(value),
        expiresAt: now() + ttlMs,
      });
    },
    async invalidate(prefix) {
      let count = 0;
      for (const key of [...entries.keys()])
        if (key.startsWith(prefix)) {
          entries.delete(key);
          count++;
        }
      return count;
    },
  };
}

export type MicrosoftAuthenticationKind =
  "api-key" | "http-basic" | "oauth2" | "none";

export interface MicrosoftAuthorizationRequest {
  kind: MicrosoftAuthenticationKind;
  placement?: "header" | "query";
  parameterName?: string;
  /** Opened inside the custody port; it must not escape the hook's return value. */
  material: CredentialMaterial;
}

/** What a hook may add to one outbound request. Nothing else is applied. */
export interface MicrosoftAuthorizationApplication {
  headers?: Record<string, string>;
  query?: Record<string, string>;
}

/**
 * The seam the OAuth work plugs into: given the connection parameter set's
 * kind and the opened credential material, return the header or query values
 * that authorize one request. The default covers the three shapes a custom
 * connector can declare; a generic OAuth profile replaces it without changing
 * anything else here.
 */
export type MicrosoftAuthorizationHook = (
  request: MicrosoftAuthorizationRequest,
) =>
  | MicrosoftAuthorizationApplication
  | Promise<MicrosoftAuthorizationApplication>;

const headerSafe = (value: string) =>
  !/\p{Cc}/u.test(value) && value.length <= MICROSOFT_LIMITS.headerValueLength;

export const defaultAuthorizationHook: MicrosoftAuthorizationHook = (
  request,
) => {
  const material = request.material;
  if (request.kind === "none") return {};
  if (request.kind === "http-basic") {
    const username = material.username ?? material.user ?? "";
    const password = material.password ?? material.secret ?? "";
    const encoded = Buffer.from(`${username}:${password}`, "utf8").toString(
      "base64",
    );
    return { headers: { authorization: `Basic ${encoded}` } };
  }
  if (request.kind === "oauth2") {
    const token =
      material.access_token ?? material.accessToken ?? material.token;
    if (!token || !headerSafe(token))
      throw new ConnectorError("configuration-required", {
        detail: "microsoft.credential.missing",
      });
    return { headers: { authorization: `Bearer ${token}` } };
  }
  const key =
    material.value ??
    material.apiKey ??
    material.api_key ??
    material.token ??
    "";
  const name = request.parameterName;
  if (!key || !name)
    throw new ConnectorError("configuration-required", {
      detail: "microsoft.credential.missing",
    });
  if (request.placement === "query") return { query: { [name]: key } };
  if (!headerSafe(key))
    throw new ConnectorError("configuration-required", {
      detail: "microsoft.credential.invalid",
    });
  return { headers: { [name]: key } };
};

/** Host-approved, inert binding settings. A caller never supplies any of this. */
export const microsoftBindingSettingsSchema = z.object({
  connectorId: z.string().min(1).max(200).optional(),
  authentication: z
    .object({
      kind: z.enum(["api-key", "http-basic", "oauth2", "none"]),
      placement: z.enum(["header", "query"]).optional(),
      parameterName: z.string().min(1).max(120).optional(),
    })
    .optional(),
  dynamicFields: z.array(dynamicFieldContractSchema).max(512).default([]),
  verifier: z
    .object({
      operationRef: z.string().min(1).max(200),
      operationId: z.string().min(1).max(512),
    })
    .optional(),
  cacheTtlMs: z.number().int().positive().max(3_600_000).optional(),
  responseBytes: z
    .number()
    .int()
    .positive()
    .max(8 * 1024 * 1024)
    .optional(),
  requestTimeoutMs: z.number().int().positive().max(120_000).optional(),
});
export type MicrosoftBindingSettings = z.infer<
  typeof microsoftBindingSettingsSchema
>;

export function microsoftSettings(
  binding: RuntimeBinding,
): MicrosoftBindingSettings {
  const parsed = microsoftBindingSettingsSchema.safeParse(binding.settings);
  if (!parsed.success)
    throw new ConnectorError("invalid-request", {
      detail: "microsoft.binding.settings-invalid",
    });
  return parsed.data;
}

/** The caller's half of a dynamic lookup: which approved field, and the form's current values. */
export const dynamicInvokeInputSchema = z.strictObject({
  contractId: z.string().min(1).max(400),
  values: z.record(z.string().min(1).max(256), z.unknown()).optional(),
});
export type DynamicInvokeInput = z.infer<typeof dynamicInvokeInputSchema>;

export interface MicrosoftAdapterOptions {
  adapterVersion?: string;
  displayName?: string;
  description?: string;
  service?: string;
  support?: SupportLevel;
  authorization?: MicrosoftAuthorizationHook;
  cache?: DynamicOptionCachePort;
  limits?: Partial<typeof MICROSOFT_LIMITS>;
  evidence?: { invoke?: string; verify?: string };
}

const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const digestOf = (value: unknown): string =>
  createHash("sha256").update(canonicalConnectorJson(value)).digest("hex");

async function readBoundedBody(
  response: Response,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return { text: "", truncated: true };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated: false };
}

function credentialScope(ctx: AdapterCallContext): CredentialScope {
  const connection = ctx.connection;
  if (!connection?.credentialRef)
    throw new ConnectorError("configuration-required", {
      detail: "microsoft.connection.no-credential",
    });
  return {
    tenantId: connection.tenantId,
    ownerKind: connection.ownerKind,
    ownerId: connection.ownerId,
    connectionRef: connection.connectionRef,
    bindingRef: connection.bindingRef,
    custody: connection.custody,
  };
}

type ResolvedInput = {
  target: string;
  value: string | number | boolean | null;
};

/** Reads a form value by a path string, accepting both the flat and the nested spelling. */
function readFormValue(
  values: Record<string, unknown> | undefined,
  reference: string,
): unknown {
  if (!values) return undefined;
  if (Object.hasOwn(values, reference)) return values[reference];
  return selectPathString(values, reference);
}

function resolveContractInputs(
  contract: DynamicFieldContract,
  values: Record<string, unknown> | undefined,
): ResolvedInput[] {
  const resolved: ResolvedInput[] = [];
  for (const parameter of contract.parameters) {
    if (parameter.source === "static") {
      resolved.push({ target: parameter.target, value: parameter.value });
      continue;
    }
    const raw = readFormValue(values, parameter.reference);
    if (raw === undefined || raw === null) continue;
    if (
      typeof raw !== "string" &&
      typeof raw !== "number" &&
      typeof raw !== "boolean"
    )
      throw new ConnectorError("invalid-request", {
        detail: "microsoft.dynamic.value-type",
      });
    if (
      typeof raw === "string" &&
      raw.length > MICROSOFT_LIMITS.parameterValueLength
    )
      throw new ConnectorError("invalid-request", {
        detail: "microsoft.dynamic.value-length",
      });
    resolved.push({ target: parameter.target, value: raw });
  }
  return resolved;
}

type BuiltRequest = {
  url: URL;
  headers: Record<string, string>;
  body?: string;
};

function buildRequest(
  binding: RuntimeBinding,
  operation: BoundOperation,
  contract: DynamicFieldContract,
  inputs: readonly ResolvedInput[],
): BuiltRequest {
  if (operation.transport.kind !== "http")
    throw new ConnectorError("unsupported", {
      detail: "microsoft.operation.transport",
    });
  const destination = destinationFor(binding, operation);
  const locations = new Map(
    (contract.operation?.parameters ?? []).map((parameter) => [
      parameter.name,
      parameter.in,
    ]),
  );
  const path = operation.transport.pathTemplate;
  const query = new URLSearchParams();
  const headers: Record<string, string> = {};
  const body: Record<string, unknown> = {};
  let hasBody = false;
  const pathValues = new Map<string, string>();

  for (const input of inputs) {
    const segments = pathStringSegments(input.target);
    const root = segments[0] ?? "";
    const location = locations.get(root);
    const asText = String(input.value);
    if (location === "path") pathValues.set(root, asText);
    else if (location === "query" || location === undefined)
      query.set(root, asText);
    else if (location === "header") {
      if (!headerSafe(asText))
        throw new ConnectorError("invalid-request", {
          detail: "microsoft.dynamic.header-value",
        });
      headers[root] = asText;
    } else if (location === "formData") query.set(root, asText);
    else {
      hasBody = true;
      let node = body;
      const rest = segments.slice(1);
      if (!rest.length) node[root] = input.value;
      else {
        node = (body[root] as Record<string, unknown>) ?? {};
        body[root] = node;
        for (let index = 0; index < rest.length - 1; index++) {
          const key = rest[index] ?? "";
          const next = (node[key] as Record<string, unknown>) ?? {};
          node[key] = next;
          node = next;
        }
        node[rest[rest.length - 1] ?? ""] = input.value;
      }
    }
  }

  const substituted = path.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
    const value = pathValues.get(name);
    if (value === undefined)
      throw new ConnectorError("invalid-request", {
        detail: "microsoft.dynamic.path-missing",
      });
    return encodeURIComponent(value);
  });
  const url = destinationUrl(destination, substituted);
  for (const [name, value] of query) url.searchParams.set(name, value);
  return {
    url,
    headers,
    ...(hasBody ? { body: JSON.stringify(body) } : {}),
  };
}

/** Every target parameter the operation names must resolve to a permitted target. */
function assertPermittedTargets(
  binding: RuntimeBinding,
  operation: BoundOperation,
  inputs: readonly ResolvedInput[],
): void {
  if (!operation.targetParameters.length || !binding.permittedTargets.length)
    return;
  const permitted = new Set(
    binding.permittedTargets.map((target) => target.id),
  );
  for (const name of operation.targetParameters) {
    const input = inputs.find(
      (candidate) => (pathStringSegments(candidate.target)[0] ?? "") === name,
    );
    if (input === undefined) continue;
    if (!permitted.has(String(input.value)))
      throw new ConnectorError("denied", {
        detail: "microsoft.target.not-permitted",
      });
  }
}

function upstreamOutcome(status: number): {
  state: InvokeResult["state"];
  code: string;
} {
  if (status === 401)
    return { state: "denied", code: "microsoft.dynamic.unauthenticated" };
  if (status === 403)
    return { state: "denied", code: "microsoft.dynamic.forbidden" };
  if (status === 404)
    return { state: "failed", code: "microsoft.dynamic.not-found" };
  if (status === 429)
    return { state: "failed", code: "microsoft.dynamic.rate-limited" };
  if (status >= 500)
    return { state: "failed", code: "microsoft.dynamic.upstream-unavailable" };
  return { state: "failed", code: "microsoft.dynamic.upstream-rejected" };
}

export function createMicrosoftCustomConnectorAdapter(
  options: MicrosoftAdapterOptions = {},
): ConnectorAdapter {
  const adapterVersion = options.adapterVersion ?? MICROSOFT_ADAPTER_VERSION;
  const authorization = options.authorization ?? defaultAuthorizationHook;
  const cache = options.cache ?? createMemoryDynamicCache();
  const limits = { ...MICROSOFT_LIMITS, ...options.limits };

  const adapter: ConnectorAdapter = {
    id: MICROSOFT_ADAPTER_ID,
    ecosystem: MICROSOFT_ECOSYSTEM,
    adapterVersion,
    runtime: "hosted-server",
    displayName: options.displayName ?? "Microsoft custom connector",
    description:
      options.description ??
      "Imports Power Platform custom connectors, runs their approved dynamic field lookups server-side, and interprets their connection test as connectivity evidence only.",
    service: options.service ?? "microsoft-custom-connector",
    support: options.support ?? "provider-backed",
    // Every imported custom connector runs through this adapter, so its
    // suites prove the interpreter, not the API behind a definition nobody
    // exercised: evidence speaks per definition.
    evidenceScope: "definition",
    custody: ["host-owned"],
    configuration: [],
    profiles: [MICROSOFT_PROFILE, "swagger-2.0"],

    capabilities() {
      const evidence = options.evidence ?? {};
      return [
        capabilityStatus(adapter, {
          dimension: "import",
          profile: MICROSOFT_PROFILE,
          evidence: "protocol-fixture",
          limitations: [
            "Swagger 2.0 only; OpenAPI 3.x is not a custom connector definition",
            "Policy templates, custom code and gateway paths are preserved as metadata and block execution",
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "configure",
          profile: MICROSOFT_PROFILE,
          evidence: "protocol-fixture",
          limitations: [
            "Connection parameter names are mapped to host configuration names; the native spelling is preserved",
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "verify",
          profile: MICROSOFT_PROFILE,
          evidence: "protocol-fixture",
          ...(evidence.verify ? { evidenceRef: evidence.verify } : {}),
          limitations: [...TEST_CONNECTION_LIMITATIONS],
        }),
        capabilityStatus(adapter, {
          dimension: "invoke",
          profile: MICROSOFT_PROFILE,
          evidence: "protocol-fixture",
          ...(evidence.invoke ? { evidenceRef: evidence.invoke } : {}),
          limitations: [
            "Executes approved dynamic field lookups only; other operations are bound through an HTTP adapter",
            "Options are bounded and sanitized; cached per connection generation",
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "events",
          profile: MICROSOFT_PROFILE,
          implementation: "unsupported",
          limitations: [
            "Webhook triggers need a host-approved receiver; polling triggers have no equivalent trigger state",
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "export",
          profile: MICROSOFT_PROFILE,
          evidence: "protocol-fixture",
          limitations: [
            "Request and response schemas, policies, custom code and apiProperties are reported as losses",
          ],
        }),
      ];
    },

    async import(
      ctx: AdapterCallContext,
      input: ImportInput,
    ): Promise<ImportOutcome> {
      if (input.bytes.byteLength > 4 * 1024 * 1024)
        throw new ConnectorError("invalid-request", {
          detail: "microsoft.import.too-large",
        });
      let swagger: unknown;
      try {
        swagger = JSON.parse(Buffer.from(input.bytes).toString("utf8"));
      } catch {
        // A parse error never echoes the document: it can hold a credential.
        throw new ConnectorError("invalid-request", {
          detail: "microsoft.import.not-json",
        });
      }
      const metadata = input.metadata ?? {};
      const digest = sha256Hex(input.bytes);
      const sourceRef = `source:msconn:${digest.slice(0, 32)}`;
      let read;
      try {
        read = await readCustomConnector({
          swagger,
          ...(metadata.apiProperties === undefined
            ? {}
            : { apiProperties: metadata.apiProperties }),
          ...(metadata.settings === undefined
            ? {}
            : { settings: metadata.settings }),
          ...(metadata.scriptPresent === true ? { scriptPresent: true } : {}),
          ...(input.identityHint ? { identity: input.identityHint } : {}),
          sourceRef,
          definitionRef: `definition:msconn:${digest.slice(0, 32)}`,
        });
      } catch (error) {
        if (error instanceof CustomConnectorReadError)
          return {
            source: {
              sourceRef,
              identity: {
                ecosystem: MICROSOFT_ECOSYSTEM,
                authorityNamespace: "",
                nativeId:
                  input.identityHint?.nativeId ?? "unreadable-connector",
                nativeVersion: input.identityHint?.nativeVersion ?? "unknown",
              },
              format: { name: "swagger", version: "2.0" },
              origin: input.origin,
              digest: { algorithm: "sha256", value: digest },
              byteLength: input.bytes.byteLength,
              mediaType: input.mediaType,
              capturedAt: new Date(ctx.environment.now()).toISOString(),
              adaptation: [],
              overlays: [],
            },
            definitions: [],
            issues: error.issues,
            executableCandidates: [],
          };
        throw error;
      }
      return {
        source: {
          sourceRef,
          identity: read.definition.identity,
          format: { name: "swagger", version: "2.0" },
          origin: input.origin,
          digest: { algorithm: "sha256", value: digest },
          byteLength: input.bytes.byteLength,
          mediaType: input.mediaType,
          capturedAt: new Date(ctx.environment.now()).toISOString(),
          adaptation: [
            {
              step: "microsoft-custom-connector-read",
              version: adapterVersion,
              inputDigest: digest,
              outputDigest: read.definition.normalizedDigest,
            },
          ],
          overlays: [],
        },
        definitions: [read.definition],
        issues: read.issues,
        executableCandidates: read.executableCandidates,
      };
    },

    async invoke(
      ctx: AdapterCallContext,
      request: InvokeRequest,
    ): Promise<InvokeResult> {
      if (ctx.signal.aborted) throw new ConnectorError("cancelled");
      const settings = microsoftSettings(ctx.binding);
      const operation = boundOperation(ctx.binding, request.operationRef);
      if (!operation)
        throw new ConnectorError("denied", {
          detail: "microsoft.operation.unapproved",
        });
      const input = dynamicInvokeInputSchema.safeParse(request.input);
      if (!input.success)
        throw new ConnectorError("invalid-request", {
          detail: "microsoft.dynamic.input",
        });
      const contract = settings.dynamicFields.find(
        (candidate) =>
          candidate.id === input.data.contractId &&
          candidate.operation?.operationRef === request.operationRef,
      );
      if (!contract)
        throw new ConnectorError("denied", {
          detail: "microsoft.dynamic.unapproved",
        });
      if (!contract.executable)
        throw new ConnectorError("unsupported", {
          detail: "microsoft.dynamic.blocked",
        });
      const connection = ctx.connection;
      if (!connection)
        throw new ConnectorError("configuration-required", {
          detail: "microsoft.connection.required",
        });
      if (connection.generation !== ctx.generation)
        throw new ConnectorError("conflict", {
          detail: "microsoft.connection.stale",
        });

      const inputs = resolveContractInputs(contract, input.data.values);
      assertPermittedTargets(ctx.binding, operation, inputs);
      const built = buildRequest(ctx.binding, operation, contract, inputs);

      // Connection-scoped: tenant, owner, connection and generation are all in
      // the key, so a cached list can never be served to another principal.
      const cachePrefix = `${JSON.stringify([
        connection.tenantId,
        connection.ownerId,
        connection.connectionRef,
        ctx.generation,
      ])}|`;
      const cacheKey = `${cachePrefix}${digestOf({
        bindingRef: ctx.binding.bindingRef,
        revision: ctx.binding.revision,
        policyRevision: ctx.binding.policyRevision,
        operationRef: operation.operationRef,
        contractId: contract.id,
        url: built.url.toString(),
        body: built.body ?? null,
        headers: built.headers,
      })}`;
      const cached = await cache.get(cacheKey);
      if (cached)
        return {
          state: "complete",
          output: { ...cached, cached: true },
          outputClassification: operation.outputClassification,
          effect: operation.effect,
        };

      const scope = credentialScope(ctx);
      const timeout = settings.requestTimeoutMs ?? limits.requestTimeoutMs;
      const responseLimit = settings.responseBytes ?? limits.responseBytes;
      const signal = AbortSignal.any([
        ctx.signal,
        AbortSignal.timeout(timeout),
      ]);

      const outcome = await ctx.environment.credentials.use(
        scope,
        connection.credentialRef ?? "",
        async (material) => {
          const applied = await authorization({
            kind: settings.authentication?.kind ?? "none",
            ...(settings.authentication?.placement
              ? { placement: settings.authentication.placement }
              : {}),
            ...(settings.authentication?.parameterName
              ? { parameterName: settings.authentication.parameterName }
              : {}),
            material,
          });
          const url = new URL(built.url.toString());
          for (const [name, value] of Object.entries(applied.query ?? {}))
            url.searchParams.set(name, value);
          const headers = new Headers({ accept: "application/json" });
          for (const [name, value] of Object.entries(built.headers))
            headers.set(name, value);
          for (const [name, value] of Object.entries(applied.headers ?? {}))
            headers.set(name, value);
          if (built.body !== undefined)
            headers.set("content-type", "application/json");
          let response: Response;
          try {
            response = await ctx.environment.fetch(url, {
              method:
                operation.transport.kind === "http"
                  ? operation.transport.method
                  : "GET",
              headers,
              redirect: "error",
              signal,
              ...(built.body === undefined ? {} : { body: built.body }),
            });
          } catch (error) {
            if (ctx.signal.aborted) throw new ConnectorError("cancelled");
            if (error instanceof ConnectorError) throw error;
            // Never carry a transport message out: it can echo the request.
            return { status: 0 } as const;
          }
          if (!response.ok) {
            await response.body?.cancel();
            return { status: response.status } as const;
          }
          const body = await readBoundedBody(response, responseLimit);
          return { status: response.status, ...body } as const;
        },
      );

      if (outcome.status === 0)
        return {
          state: "failed",
          outputClassification: operation.outputClassification,
          effect: operation.effect,
          code: "microsoft.dynamic.upstream-unavailable",
        };
      if (outcome.status < 200 || outcome.status >= 300) {
        const mapped = upstreamOutcome(outcome.status);
        return {
          state: mapped.state,
          outputClassification: operation.outputClassification,
          effect: operation.effect,
          code: mapped.code,
        };
      }
      if ("truncated" in outcome && outcome.truncated)
        return {
          state: "failed",
          outputClassification: operation.outputClassification,
          effect: operation.effect,
          code: "microsoft.dynamic.response-too-large",
        };
      let payload: unknown;
      try {
        payload = JSON.parse(("text" in outcome ? outcome.text : "") || "null");
      } catch {
        return {
          state: "failed",
          outputClassification: operation.outputClassification,
          effect: operation.effect,
          code: "microsoft.dynamic.response-not-json",
        };
      }
      if (
        !measureJsonValue(payload, {
          depth: 32,
          nodes: 200_000,
          bytes: responseLimit,
          stringLength: 65_536,
        }).ok
      )
        return {
          state: "failed",
          outputClassification: operation.outputClassification,
          effect: operation.effect,
          code: "microsoft.dynamic.response-bounds",
        };

      let body: DynamicResultBody;
      if (contract.kind === "values" || contract.kind === "list") {
        const extracted = extractOptions(payload, contract.selection);
        if ("error" in extracted)
          return {
            state: "failed",
            outputClassification: operation.outputClassification,
            effect: operation.effect,
            code: "microsoft.dynamic.collection-not-array",
          };
        body = { ...extracted, cached: false };
      } else {
        const extracted = extractSchema(payload, contract.selection.value);
        if ("error" in extracted)
          return {
            state: "failed",
            outputClassification: operation.outputClassification,
            effect: operation.effect,
            code: `microsoft.dynamic.${extracted.error}`,
          };
        body = { kind: "schema", schema: extracted.schema, cached: false };
      }
      await cache.set(cacheKey, body, settings.cacheTtlMs ?? limits.cacheTtlMs);
      return {
        state: "complete",
        output: body,
        outputClassification: operation.outputClassification,
        effect: operation.effect,
      };
    },

    async verify(ctx: AdapterCallContext): Promise<CompletionResult> {
      if (ctx.signal.aborted) throw new ConnectorError("cancelled");
      const settings = microsoftSettings(ctx.binding);
      if (!settings.verifier)
        throw new ConnectorError("unsupported", {
          detail: "microsoft.verify.unapproved",
        });
      const operation = boundOperation(
        ctx.binding,
        settings.verifier.operationRef,
      );
      if (!operation || operation.transport.kind !== "http")
        throw new ConnectorError("unsupported", {
          detail: "microsoft.verify.unbound",
        });
      const connection = ctx.connection;
      if (!connection)
        throw new ConnectorError("configuration-required", {
          detail: "microsoft.connection.required",
        });
      const scope = credentialScope(ctx);
      const destination = destinationFor(ctx.binding, operation);
      const path = operation.transport.pathTemplate;
      if (/\{[^{}]+\}/.test(path))
        throw new ConnectorError("unsupported", {
          detail: "microsoft.verify.parameterized",
        });
      const url = destinationUrl(destination, path);
      const timeout = settings.requestTimeoutMs ?? limits.requestTimeoutMs;
      const signal = AbortSignal.any([
        ctx.signal,
        AbortSignal.timeout(timeout),
      ]);

      const status = await ctx.environment.credentials.use(
        scope,
        connection.credentialRef ?? "",
        async (material) => {
          const applied = await authorization({
            kind: settings.authentication?.kind ?? "none",
            ...(settings.authentication?.placement
              ? { placement: settings.authentication.placement }
              : {}),
            ...(settings.authentication?.parameterName
              ? { parameterName: settings.authentication.parameterName }
              : {}),
            material,
          });
          const target = new URL(url.toString());
          for (const [name, value] of Object.entries(applied.query ?? {}))
            target.searchParams.set(name, value);
          const headers = new Headers({ accept: "application/json" });
          for (const [name, value] of Object.entries(applied.headers ?? {}))
            headers.set(name, value);
          try {
            const response = await ctx.environment.fetch(target, {
              method:
                operation.transport.kind === "http"
                  ? operation.transport.method
                  : "GET",
              headers,
              redirect: "error",
              signal,
            });
            await response.body?.cancel();
            return response.status;
          } catch (error) {
            if (ctx.signal.aborted) throw new ConnectorError("cancelled");
            if (error instanceof ConnectorError) throw error;
            return 0;
          }
        },
      );

      const connectorId =
        settings.connectorId ?? connection.service ?? connection.definitionRef;
      if (status >= 200 && status < 300) {
        /*
         * A 200 from a connection test shows one thing: the provider accepted
         * the credential this connection holds. It names no account, proves no
         * permission and demonstrates no resource access, so the claim says
         * credential-accepted against the connection itself and carries both
         * limitations verbatim (AC-EXT-11).
         */
        const claim: VerificationClaim = {
          kind: "credential-accepted",
          evidenceRef: `evidence:${ctx.environment.random.uuid()}`,
          issuer: "ceremony-verifier",
          target: { kind: "custom-connector-connection", id: connectorId },
          observedAt: new Date(ctx.environment.now()).toISOString(),
          verifierVersion: adapterVersion,
          bindingRevision: ctx.binding.revision,
          policyRevision: ctx.binding.policyRevision,
          limitations: [...TEST_CONNECTION_LIMITATIONS],
        };
        return { state: "complete", claims: [claim] };
      }
      if (status === 401 || status === 403)
        return {
          state: "denied",
          claims: [],
          code: "microsoft.verify.rejected",
        };
      if (status === 0 || status >= 500 || status === 429)
        return {
          state: "pending",
          claims: [],
          code: "microsoft.verify.upstream-unavailable",
        };
      return { state: "denied", claims: [], code: "microsoft.verify.failed" };
    },

    async export(
      ctx: AdapterCallContext,
      request: ExportRequest,
    ): Promise<ExportOutcome> {
      if (request.format !== "swagger-2.0" && request.format !== "microsoft")
        throw new ConnectorError("unsupported", {
          detail: "microsoft.export.format",
        });
      const result = exportCustomConnector(request.definition, ctx.binding);
      return {
        mediaType: result.mediaType,
        bytes: result.bytes,
        losses: result.losses,
      };
    },
  };
  return adapter;
}

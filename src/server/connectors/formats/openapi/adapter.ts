import { createHash } from "node:crypto";
import {
  canonicalConnectorJson,
  type AuthenticationProfile,
  type ConfigurationRequirement,
  type SourceRecord,
} from "../../../../core/connectors/index.js";
import {
  capabilityStatus,
  type AdapterCallContext,
  type CapabilityStatus,
  type ConnectorAdapter,
  type DisconnectResult,
  type ExportOutcome,
  type ExportRequest,
  type ImportInput,
  type ImportOutcome,
  type InvokeRequest,
  type InvokeResult,
  type CompletionResult,
} from "../../adapter.js";
import type { ConnectorOAuthOptions } from "../../auth/connector-oauth.js";
import { beginAttempt } from "../../attempts.js";
import { boundOperation, destinationFor } from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import type { CredentialScope } from "../../ports.js";
import {
  acquireForVerification,
  authorizeOpenApi,
  completeOpenApi,
  credentialRequired,
  renewCredential,
} from "./authorize.js";
import { exportOpenApi } from "./export.js";
import { OPENAPI_PROFILES, READER_VERSION, isReadResult } from "./model.js";
import { planFromBinding, planSettingsOf, type OperationPlan } from "./plan.js";
import { readOpenApi, type ReadOptions } from "./read.js";
import {
  InputRejected,
  RESERVED_REQUEST_HEADERS,
  readBoundedBody,
  responseIsJson,
  serializeRequest,
} from "./serialize.js";

/*
 * The OpenAPI HTTP adapter executes a *bound* operation, never a description.
 * Everything consequential is decided before the call: which destination, which
 * path template, which parameters, which credential profile, which output
 * classification, which replay policy. The adapter's job is to build exactly
 * that request, place the credential inside `credentials.use`, journal the
 * intent, make one bounded request with redirects refused, and report an
 * outcome that distinguishes "did not happen", "happened" and "unknown".
 */

export const ADAPTER_ID = "openapi-http";
export const ADAPTER_VERSION = "1.0.0";

export interface OpenApiAdapterOptions {
  /** Wall-clock bound for one upstream request. */
  requestTimeoutMs?: number;
  /** Ceiling for a response body when the plan does not name one. */
  maxResponseBytes?: number;
  /** Maximum bytes of an imported document. */
  maxImportBytes?: number;
  /** Import-time external reference hook; absent means in-document references only. */
  resolveExternal?: ReadOptions["resolveExternal"];
  /** Parses import bytes into a document; the import swarm owns the real one. */
  parseDocument?: (bytes: Uint8Array, mediaType: string) => unknown;
  displayName?: string;
  description?: string;
  service?: string;
  /** Evidence level this deployment has measured for the adapter's dimensions. */
  evidence?: CapabilityStatus["evidence"];
  /**
   * Host seams for the OAuth profiles: where dynamic registrations persist,
   * the metadata cache, the callback path, the CIMD publisher. Absent parts
   * make the profiles that need them refuse with a code, never improvise.
   */
  oauth?: ConnectorOAuthOptions;
}

/**
 * Thrown out of the credential callback when the destination answered 401 and
 * the credential may be renewable. It carries only the already-journaled
 * outcome to report if renewal is impossible; never material.
 */
class CredentialRefused extends Error {
  constructor(
    readonly result: InvokeResult,
    /** Digest of the Authorization value that was refused; a digest, never the value. */
    readonly presented: string,
  ) {
    super("credential refused");
  }
}

/** Refresh margin matching the custody port's default: a token this close to expiry is stale. */
const EXPIRY_MARGIN_MS = 30_000;

/** A custody refusal because the stored credential is past, or at, its expiry. */
function credentialExpired(error: unknown): boolean {
  return (
    error instanceof ConnectorError &&
    error.code === "expired" &&
    (error.detail === "credential.expired" ||
      error.detail === "credential.expiring")
  );
}

const DEFAULTS = {
  requestTimeoutMs: 30_000,
  maxResponseBytes: 4 * 1024 * 1024,
  maxImportBytes: 16 * 1024 * 1024,
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function defaultParse(bytes: Uint8Array, mediaType: string): unknown {
  const essence = mediaType.split(";")[0]!.trim().toLowerCase();
  if (
    essence !== "application/json" &&
    essence !== "application/openapi+json" &&
    essence !== "text/json" &&
    essence !== ""
  )
    throw new ConnectorError("unsupported", {
      detail: "openapi.media-type-unsupported",
    });
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  // A parsed document may carry a `__proto__` key as data; it never becomes a prototype.
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function credentialScope(ctx: AdapterCallContext): CredentialScope {
  const connection = ctx.connection;
  if (!connection || !connection.credentialRef)
    throw new ConnectorError("unauthenticated", {
      detail: "openapi.no-credential",
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

function profileById(
  ctx: AdapterCallContext,
  profileId: string,
): AuthenticationProfile | undefined {
  const profiles = ctx.binding.settings["openapi-http-profiles"];
  if (!Array.isArray(profiles)) return undefined;
  return profiles.find(
    (item): item is AuthenticationProfile =>
      typeof item === "object" &&
      item !== null &&
      (item as { id?: unknown }).id === profileId,
  );
}

/**
 * Places the credentials one alternative requires. Each profile contributes
 * exactly what its own kind describes: an API key goes where the *profile*
 * says (never where input says), basic and bearer go to Authorization. The
 * material never leaves the callback and never reaches the returned request.
 */
async function withCredentials<T>(
  ctx: AdapterCallContext,
  plan: OperationPlan,
  work: (
    headers: Record<string, string>,
    query: Array<[string, string]>,
  ) => Promise<T>,
): Promise<T> {
  const headers: Record<string, string> = {};
  const query: Array<[string, string]> = [];
  const required = plan.security.profiles;
  if (required.length === 0) return work(headers, query);
  const scope = credentialScope(ctx);
  const ref = ctx.connection!.credentialRef!;
  return ctx.environment.credentials.use(scope, ref, async (material) => {
    for (const entry of required) {
      const profile = profileById(ctx, entry.profileId);
      if (!profile)
        throw new ConnectorError("configuration-required", {
          detail: "openapi.profile-not-bound",
        });
      switch (profile.kind) {
        case "api-key": {
          const value = material[`apiKey:${profile.id}`] ?? material.apiKey;
          if (!value)
            throw new ConnectorError("unauthenticated", {
              detail: "openapi.credential-missing",
            });
          if (profile.placement === "header")
            headers[profile.parameterName.toLowerCase()] = value;
          else if (profile.placement === "query")
            query.push([profile.parameterName, value]);
          else
            throw new ConnectorError("unsupported", {
              detail: "openapi.cookie-credential-unsupported",
            });
          break;
        }
        case "http-basic": {
          const user = material[`username:${profile.id}`] ?? material.username;
          const password =
            material[`password:${profile.id}`] ?? material.password;
          if (user === undefined || password === undefined)
            throw new ConnectorError("unauthenticated", {
              detail: "openapi.credential-missing",
            });
          headers.authorization = `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;
          break;
        }
        case "http-bearer":
        case "oauth-authorization-code":
        case "oauth-client-credentials":
        case "oauth-device":
        case "openid-connect": {
          // `access_token` is what the OAuth grants in `connectors/auth` store.
          const value =
            material[`accessToken:${profile.id}`] ??
            material.accessToken ??
            material.access_token ??
            material.token;
          if (!value)
            throw new ConnectorError("unauthenticated", {
              detail: "openapi.credential-missing",
            });
          headers.authorization = `Bearer ${value}`;
          break;
        }
        default:
          throw new ConnectorError("unsupported", {
            detail: "openapi.profile-not-executable",
          });
      }
    }
    return work(headers, query);
  });
}

export function createOpenApiHttpAdapter(
  options: OpenApiAdapterOptions = {},
): ConnectorAdapter {
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs;
  const maxResponseBytes =
    options.maxResponseBytes ?? DEFAULTS.maxResponseBytes;
  const maxImportBytes = options.maxImportBytes ?? DEFAULTS.maxImportBytes;
  const parseDocument = options.parseDocument ?? defaultParse;
  const evidence = options.evidence ?? "protocol-fixture";
  const oauthOptions = options.oauth ?? {};
  const configuration: readonly ConfigurationRequirement[] = [];
  const adapter: ConnectorAdapter = {
    id: ADAPTER_ID,
    ecosystem: "openapi",
    adapterVersion: ADAPTER_VERSION,
    runtime: "hosted-server",
    displayName: options.displayName ?? "OpenAPI (HTTP)",
    description:
      options.description ??
      "Imports OpenAPI 2.0, 3.0, 3.1 and 3.2 descriptions and executes the reviewed subset of their HTTP operations.",
    service: options.service ?? "openapi",
    support: "fixture",
    custody: ["host-owned", "no-credential"],
    configuration,
    profiles: OPENAPI_PROFILES,

    capabilities(_present: ReadonlySet<string>): CapabilityStatus[] {
      const profile = "openapi-3.1";
      const rows: CapabilityStatus[] = [
        capabilityStatus(adapter, {
          dimension: "discover",
          profile,
          implementation: "unsupported",
          limitations: [
            "An OpenAPI description is a document, not a catalog; there is no listing endpoint to discover.",
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "import",
          profile,
          evidence,
          limitations: [
            "External references are resolved only through a host-supplied hook under the deployment's network policy.",
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "configure",
          profile,
          evidence,
          limitations: [
            "Destinations, operations and credential profiles are chosen by host review, never by the document.",
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "authorize",
          profile,
          evidence,
          limitations: [
            "OAuth authorization code (PKCE S256), OpenID Connect, device and client-credentials profiles run only under a host-written issuer policy pinned in the approved binding; endpoints the description declares are never contacted on their own.",
            "API key (header or query), HTTP basic and HTTP bearer values are entered by the initiating person through the private input route; they are checked only when the host names a verifier.",
            "Tokens are refreshed once when expired or refused with 401, and only for OAuth profiles whose policy is bound; a profile that declares no refresh is not refreshed.",
            "Cookie API keys, mutual TLS and signature schemes are not supported.",
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "verify",
          profile,
          evidence,
          limitations: [
            "Verification is only available when the host names an approved read operation as the verifier.",
            "A successful response proves credential acceptance, never account identity.",
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "invoke",
          profile,
          evidence,
          limitations: [
            "JSON request and response bodies only; path/header style simple, query style form.",
            "A description cannot establish that a non-GET operation is safe or idempotent.",
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "events",
          profile,
          implementation: "unsupported",
          limitations: [
            "Webhooks and callbacks are imported as descriptions; delivery verification belongs to the events profile.",
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "reconnect",
          profile,
          evidence,
          limitations: [
            "Reconnect re-runs the bound profile's authorization and replaces host-held credentials locally; an OpenAPI description declares no upstream reconnect operation.",
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "disconnect",
          profile,
          evidence,
          limitations: [
            "Local disconnect only; an OpenAPI description declares no upstream unlink operation.",
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "revoke",
          profile,
          implementation: "unsupported",
          limitations: [
            "An OpenAPI description declares no revocation endpoint; upstream revocation is not attempted.",
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "export",
          profile,
          evidence,
          limitations: [
            "Export emits the approved description only; losses are reported as compatibility issues.",
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "delegate",
          profile,
          implementation: "unsupported",
          limitations: [
            "There is no third party to delegate to in this profile.",
          ],
        }),
      ];
      return rows;
    },

    async import(
      ctx: AdapterCallContext,
      input: ImportInput,
    ): Promise<ImportOutcome> {
      if (input.bytes.byteLength > maxImportBytes)
        throw new ConnectorError("invalid-request", {
          detail: "openapi.document-too-large",
        });
      let document: unknown;
      try {
        document = parseDocument(input.bytes, input.mediaType);
      } catch (error) {
        if (error instanceof ConnectorError) throw error;
        throw new ConnectorError("invalid-request", {
          detail: "openapi.document-unparseable",
        });
      }
      const digest = sha256(Buffer.from(input.bytes).toString("binary"));
      const read = await readOpenApi(document, {
        ...(options.resolveExternal
          ? { resolveExternal: options.resolveExternal }
          : {}),
        sourceRef: `openapi:src:${digest.slice(0, 32)}`,
        ...(input.identityHint ? { identityHint: input.identityHint } : {}),
      });
      const capturedAt = new Date(ctx.environment.now()).toISOString();
      if (!isReadResult(read))
        return {
          source: {
            sourceRef: `openapi:src:${digest.slice(0, 32)}`,
            identity: {
              ecosystem: "openapi",
              authorityNamespace: input.identityHint?.authorityNamespace ?? "",
              nativeId: input.identityHint?.nativeId ?? "unreadable-document",
              nativeVersion: input.identityHint?.nativeVersion ?? "unknown",
            },
            format: { name: "openapi", version: "unknown" },
            origin: input.origin,
            digest: { algorithm: "sha256", value: digest },
            byteLength: input.bytes.byteLength,
            mediaType: input.mediaType || "application/json",
            capturedAt,
            adaptation: [],
            overlays: [],
          },
          definitions: [],
          issues: read.issues,
          executableCandidates: [],
        };
      const source: SourceRecord = {
        sourceRef: read.definition.sourceRef,
        identity: read.definition.identity,
        format: {
          name: "openapi",
          version: read.version,
          dialect: read.dialect,
        },
        origin: input.origin,
        digest: { algorithm: "sha256", value: digest },
        byteLength: input.bytes.byteLength,
        mediaType: input.mediaType || "application/json",
        capturedAt,
        adaptation: [
          {
            step: "openapi-read",
            version: READER_VERSION,
            inputDigest: digest,
            outputDigest: read.definition.normalizedDigest,
          },
        ],
        overlays: [],
      };
      return {
        source,
        definitions: [read.definition],
        issues: read.issues,
        // Candidates a reviewer may bind; import approves nothing.
        executableCandidates: read.operations.map(
          (operation) => operation.nativeId,
        ),
      };
    },

    async invoke(
      ctx: AdapterCallContext,
      request: InvokeRequest,
    ): Promise<InvokeResult> {
      const bound = boundOperation(ctx.binding, request.operationRef);
      if (!bound || bound.transport.kind !== "http")
        throw new ConnectorError("not-found", {
          detail: "openapi.operation-not-bound",
        });
      const plan = planFromBinding(ctx.binding, request.operationRef);
      if (!plan)
        throw new ConnectorError("configuration-required", {
          detail: "openapi.plan-missing",
        });
      if (
        plan.method !== bound.transport.method ||
        plan.pathTemplate !== bound.transport.pathTemplate ||
        plan.nativeId !== bound.nativeId
      )
        throw new ConnectorError("conflict", {
          detail: "openapi.plan-binding-mismatch",
        });
      const destination = destinationFor(ctx.binding, bound);
      const limit = plan.maxResponseBytes ?? maxResponseBytes;

      let serialized;
      try {
        serialized = serializeRequest({
          plan,
          destination,
          input: request.input,
        });
      } catch (error) {
        if (error instanceof InputRejected)
          throw new ConnectorError("invalid-request", { detail: error.detail });
        throw error;
      }

      const attempt = (renewed: boolean): Promise<InvokeResult> =>
        withCredentials<InvokeResult>(
          ctx,
          plan,
          async (authHeaders, authQuery) => {
            const url = new URL(serialized.url.href);
            for (const [name, value] of authQuery)
              url.searchParams.append(name, value);
            const headers = new Headers();
            for (const [name, value] of Object.entries(serialized.headers)) {
              if (
                RESERVED_REQUEST_HEADERS.has(name) ||
                Object.hasOwn(authHeaders, name)
              )
                throw new ConnectorError("invalid-request", {
                  detail: "openapi.header-collision",
                });
              headers.set(name, value);
            }
            for (const [name, value] of Object.entries(authHeaders))
              headers.set(name, value);
            headers.set("accept", "application/json");
            if (serialized.body !== undefined)
              headers.set("content-type", "application/json");

            // The digest identifies "the same effect": method, destination-relative
            // target and body. Credentials are deliberately not part of it.
            const effectTarget = `${url.pathname}${url.search}`;
            const digest = sha256(
              canonicalConnectorJson({
                method: plan.method,
                destination: destination.id,
                target: effectTarget,
                body: serialized.body ?? null,
              }),
            );
            // A read-only read is its own entry every time; any other request
            // is an attempt at one effect, and the attempt after a refusal
            // that never applied (the 401 a renewal cures included) is the
            // next entry of that effect. See `../../attempts.ts`.
            const { effectRef, prior } = await beginAttempt(
              ctx.environment.effects,
              {
                actor: ctx.actor,
                ...(ctx.connection
                  ? { connectionRef: ctx.connection.connectionRef }
                  : {}),
                bindingRef: ctx.binding.bindingRef,
                operation: request.operationRef,
                digest,
                ...(request.idempotencyKey &&
                bound.replay === "upstream-idempotency-key"
                  ? {
                      idempotency: {
                        key: request.idempotencyKey,
                        scope: destination.id,
                      },
                    }
                  : {}),
                commandId: request.commandId,
              },
              {
                mode:
                  bound.replay === "read-only"
                    ? "each-request"
                    : "until-applied",
                random: ctx.environment.random,
              },
            );
            if (prior)
              return {
                state:
                  prior.status === "applied" || prior.status === "reconciled"
                    ? "complete"
                    : prior.status === "indeterminate"
                      ? "indeterminate"
                      : "failed",
                outputClassification: bound.outputClassification,
                effect: bound.effect,
                ...(prior.code ? { code: prior.code } : {}),
                effectRef,
              };

            const controller = new AbortController();
            const onAbort = () => controller.abort();
            ctx.signal.addEventListener("abort", onAbort, { once: true });
            const timer = setTimeout(
              () => controller.abort(),
              requestTimeoutMs,
            );
            let response: Response;
            try {
              response = await ctx.environment.fetch(url, {
                method: plan.method,
                headers,
                ...(serialized.body === undefined
                  ? {}
                  : { body: serialized.body }),
                redirect: "error",
                signal: controller.signal,
              });
            } catch {
              clearTimeout(timer);
              ctx.signal.removeEventListener("abort", onAbort);
              // A request that never produced a response may still have been applied.
              const lost = bound.effect !== "read";
              await ctx.environment.effects.complete(effectRef, {
                status: lost ? "indeterminate" : "not-applied",
                code: "upstream-unavailable",
                at: ctx.environment.now(),
              });
              return {
                state: lost ? "indeterminate" : "failed",
                outputClassification: bound.outputClassification,
                effect: bound.effect,
                code: "upstream-unavailable",
                effectRef,
              };
            }
            clearTimeout(timer);
            ctx.signal.removeEventListener("abort", onAbort);

            const { bytes, exceeded } = await readBoundedBody(response, limit);
            // A body over the bound is a failure, never a truncation: half a JSON
            // document is not the response the operation described. The upstream
            // still acted, though, so a successful status is journalled as applied.
            // An error status is classified below by its status, not by its size.
            if (exceeded && response.ok) {
              await ctx.environment.effects.complete(effectRef, {
                status: "applied",
                code: "openapi.response-too-large",
                at: ctx.environment.now(),
              });
              return {
                state: "failed",
                outputClassification: bound.outputClassification,
                effect: bound.effect,
                code: "openapi.response-too-large",
                effectRef,
              };
            }
            const json = responseIsJson(response.headers.get("content-type"));
            let output: unknown;
            let parseFailed = false;
            if (json && bytes.byteLength) {
              try {
                output = JSON.parse(
                  new TextDecoder("utf-8", { fatal: true }).decode(bytes),
                );
              } catch {
                parseFailed = true;
              }
            }
            if (!response.ok) {
              await ctx.environment.effects.complete(effectRef, {
                status:
                  response.status >= 500 ? "indeterminate" : "not-applied",
                code:
                  response.status >= 500
                    ? "upstream-unavailable"
                    : "upstream-rejected",
                at: ctx.environment.now(),
              });
              const failed: InvokeResult = {
                state:
                  response.status >= 500 && bound.effect !== "read"
                    ? "indeterminate"
                    : "failed",
                outputClassification: bound.outputClassification,
                effect: bound.effect,
                code:
                  response.status >= 500
                    ? "upstream-unavailable"
                    : "upstream-rejected",
                effectRef,
              };
              // A 401 to a presented credential is a refusal of that credential,
              // made before the operation ran. One renewal may cure it.
              if (
                response.status === 401 &&
                !renewed &&
                plan.security.profiles.length
              )
                throw new CredentialRefused(
                  failed,
                  sha256(authHeaders.authorization ?? ""),
                );
              return failed;
            }
            await ctx.environment.effects.complete(effectRef, {
              status: "applied",
              at: ctx.environment.now(),
            });
            if (parseFailed)
              return {
                state: "failed",
                outputClassification: bound.outputClassification,
                effect: bound.effect,
                code: "openapi.response-not-json",
                effectRef,
              };
            return {
              state: "complete",
              ...(output === undefined ? {} : { output }),
              outputClassification: bound.outputClassification,
              effect: bound.effect,
              effectRef,
            };
          },
        );

      /*
       * One renewal, then one retry. The trigger is either custody refusing a
       * credential past its expiry (nothing was sent) or the destination
       * refusing the presented one with 401 (journaled as not applied). The
       * renewal itself is single-flight in custody, and it presents nothing
       * upstream when the held credential is no longer the one that failed, so
       * invocations failing together make one refresh. When nothing can renew
       * the credential, the caller gets the original answer; when renewal
       * fails, a sanitized code.
       */
      try {
        return await attempt(false);
      } catch (error) {
        const refused = error instanceof CredentialRefused;
        if (!refused && !credentialExpired(error)) throw error;
        const stillStale = refused
          ? (current: Readonly<Record<string, string>>) =>
              sha256(`Bearer ${current.access_token ?? ""}`) === error.presented
          : (current: Readonly<Record<string, string>>) => {
              const held = Number(current.expires_at);
              return !(
                Number.isFinite(held) &&
                held > ctx.environment.now() + EXPIRY_MARGIN_MS
              );
            };
        let renewed: boolean;
        try {
          renewed = await renewCredential(ctx, plan, oauthOptions, stillStale);
        } catch (failure) {
          // The renewal's own code stays in the journal it wrote; the caller
          // learns only that the credential needs a person again.
          if (refused)
            return {
              ...error.result,
              code: "openapi.credential-renewal-failed",
            };
          throw failure;
        }
        if (!renewed) {
          if (refused) return error.result;
          throw error;
        }
        return attempt(true);
      }
    },

    async authorize(ctx, intent) {
      return authorizeOpenApi(ctx, intent, oauthOptions);
    },

    async reconnect(ctx, intent) {
      return authorizeOpenApi(ctx, intent, oauthOptions);
    },

    async complete(ctx, input) {
      return completeOpenApi(ctx, input, oauthOptions, verifyHeld);
    },

    async verify(ctx: AdapterCallContext): Promise<CompletionResult> {
      // A client-credentials connection with no token yet gets one here: the
      // grant has no person in it, so verification is where it is bound.
      const acquired = await acquireForVerification(ctx, oauthOptions);
      if (!acquired) return verifyHeld(ctx);
      if (acquired.state !== "complete" || !acquired.credentialRef)
        return acquired;
      const checked = await verifyHeld({
        ...ctx,
        connection: {
          ...ctx.connection!,
          credentialRef: acquired.credentialRef,
        },
      });
      if (checked.state === "complete")
        return { ...acquired, claims: [...acquired.claims, ...checked.claims] };
      if (checked.state === "pending" && checked.code === "openapi.no-verifier")
        return acquired;
      await ctx.environment.credentials
        .revoke(
          {
            tenantId: ctx.connection!.tenantId,
            ownerKind: ctx.connection!.ownerKind,
            ownerId: ctx.connection!.ownerId,
            connectionRef: ctx.connection!.connectionRef,
            bindingRef: ctx.connection!.bindingRef,
            custody: ctx.connection!.custody,
          },
          acquired.credentialRef,
        )
        .catch(() => {});
      return {
        state: checked.state === "indeterminate" ? "indeterminate" : "denied",
        claims: [],
        code: "openapi.credential-rejected",
      };
    },

    async disconnect(
      _ctx: AdapterCallContext,
      scope: "local" | "broker" | "upstream",
    ): Promise<DisconnectResult> {
      // Local custody is released by the command layer. An OpenAPI description
      // declares no unlink or revocation endpoint, so nothing upstream is
      // attempted and the report says so rather than claiming success.
      return {
        local: scope === "local" ? "applied" : "not-attempted",
        broker: "unsupported",
        upstream: "unsupported",
      };
    },

    async revoke(_ctx: AdapterCallContext): Promise<DisconnectResult> {
      return {
        local: "not-attempted",
        broker: "unsupported",
        upstream: "unsupported",
      };
    },

    async export(
      ctx: AdapterCallContext,
      request: ExportRequest,
    ): Promise<ExportOutcome> {
      if (request.format !== "openapi-3.1" && request.format !== "openapi")
        throw new ConnectorError("unsupported", {
          detail: "openapi.export-format-unsupported",
        });
      const result = exportOpenApi(request.definition, {
        binding: ctx.binding,
        includeNativeExtensions: request.includeNativeExtensions,
      });
      return {
        mediaType: "application/openapi+json",
        bytes: new TextEncoder().encode(
          JSON.stringify(result.document, null, 2),
        ),
        losses: result.losses,
      };
    },
  };

  /** Evidence for the credential the connection already holds, from the host-named verifier. */
  async function verifyHeld(
    ctx: AdapterCallContext,
  ): Promise<CompletionResult> {
    const settings = planSettingsOf(ctx.binding);
    if (!settings?.verifier) {
      // A binding whose operations present no credential has nothing to
      // verify and nothing to wait for; anything else waits for a verifier.
      if (!credentialRequired(ctx.binding) && !ctx.connection?.credentialRef)
        return { state: "complete", claims: [] };
      return {
        state: "pending",
        claims: [],
        code: "openapi.no-verifier",
      };
    }
    const bound = boundOperation(ctx.binding, settings.verifier.operationRef);
    if (!bound || bound.effect !== "read")
      return { state: "pending", claims: [], code: "openapi.no-verifier" };
    const result = await adapter.invoke!(ctx, {
      operationRef: settings.verifier.operationRef,
      input: settings.verifier.input ?? {},
      commandId: `verify:${ctx.binding.bindingRef}:${ctx.generation}`,
    });
    if (result.state !== "complete")
      return {
        state: result.state === "indeterminate" ? "indeterminate" : "denied",
        claims: [],
        ...(result.code ? { code: result.code } : {}),
      };
    const observedAt = new Date(ctx.environment.now()).toISOString();
    // The verifier proves that the credential was accepted by the destination.
    // It does not name an account: an OpenAPI description carries no identity
    // claim, so none is invented here.
    return {
      state: "complete",
      claims: [
        {
          kind: "credential-accepted",
          evidenceRef: `evidence:${sha256(`${ctx.binding.bindingRef}:${observedAt}`).slice(0, 32)}`,
          issuer: "provider",
          target: {
            kind: "http-destination",
            id: destinationFor(ctx.binding, bound).origin,
          },
          observedAt,
          verifierVersion: ADAPTER_VERSION,
          bindingRevision: ctx.binding.revision,
          policyRevision: ctx.binding.policyRevision,
          limitations: [
            "A successful read proves the credential was accepted, not which account it belongs to.",
          ],
        },
      ],
    };
  }

  return adapter;
}

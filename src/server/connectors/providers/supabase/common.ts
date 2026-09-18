import { createHash } from "node:crypto";
import { z } from "zod";
import {
  verificationClaimSchema,
  type VerificationClaim,
} from "../../../../core/connectors/index.js";
import type { AdapterCallContext } from "../../adapter.js";
import type { ApprovedDestination, RuntimeBinding } from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import type {
  ConnectionRecord,
  CredentialMaterial,
  CredentialScope,
} from "../../ports.js";

/*
 * Shared vocabulary for the four Supabase profiles. Supabase is not one
 * connector: the Management API (an OAuth app acting for a dashboard user),
 * the hosted MCP server (an OAuth 2.1 resource), a project's Auth and Data
 * API (a project user with a publishable key) and Wrappers (foreign tables
 * behind the host's own database role) are different authorities with
 * different credentials. Nothing here lets one profile borrow another's
 * material: credential kinds are stamped into custody material and checked
 * before any request is built.
 */

/** Documented origins. Verified 2026-09-18 against the vendor documentation and OpenAPI document. */
export const SUPABASE_MANAGEMENT_API_ORIGIN = "https://api.supabase.com";
export const SUPABASE_HOSTED_MCP_ORIGIN = "https://mcp.supabase.com";
export const SUPABASE_HOSTED_MCP_PATH = "/mcp";
export const SUPABASE_PROJECT_HOST_SUFFIX = ".supabase.co";
export const SUPABASE_ECOSYSTEM = "supabase";
export const SUPABASE_SERVICE = "supabase";

/**
 * Distinct credential kinds with distinct custody scopes. A value is never
 * inspected to guess its kind; the kind is metadata written by the profile
 * that obtained the credential, and every profile refuses material of another
 * kind before it builds a request.
 */
export const supabaseCredentialKinds = [
  "management-access-token",
  "management-personal-access-token",
  "project-user-session",
  "publishable-key",
  "service-role-secret",
  "hosted-mcp-access-token",
] as const;
export type SupabaseCredentialKind = (typeof supabaseCredentialKinds)[number];
export const CREDENTIAL_KIND_FIELD = "kind";

export function credentialKindOf(
  material: CredentialMaterial,
): SupabaseCredentialKind | undefined {
  const value = material[CREDENTIAL_KIND_FIELD];
  return (supabaseCredentialKinds as readonly string[]).includes(value ?? "")
    ? (value as SupabaseCredentialKind)
    : undefined;
}

/** Refuses material of another kind; the detail names the confusion, never the value. */
export function assertCredentialKind(
  material: CredentialMaterial,
  expected: SupabaseCredentialKind,
): void {
  if (credentialKindOf(material) !== expected)
    throw new ConnectorError("denied", {
      detail: "supabase.credential.kind-confusion",
    });
}

/** OpenAPI: `ref` is exactly 20 lowercase letters (`^[a-z]+$`, minLength 20, maxLength 20). */
export const projectRefSchema = z
  .string()
  .regex(/^[a-z]{20}$/, "Project ref is 20 lowercase letters");
/** OpenAPI: organization `slug` matches `^[\w-]+$`. */
export const organizationSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\w-]+$/, "Organization slug is word characters and hyphens");

export const supabaseTargetKinds = [
  "supabase-project",
  "supabase-organization",
] as const;
export const supabaseTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("supabase-project"), id: projectRefSchema }),
  z.strictObject({
    kind: z.literal("supabase-organization"),
    id: organizationSlugSchema,
  }),
]);
export type SupabaseTarget = z.infer<typeof supabaseTargetSchema>;

export function parseSupabaseTarget(value: unknown): SupabaseTarget | undefined {
  const parsed = supabaseTargetSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function sameTarget(
  a: { kind: string; id: string } | undefined,
  b: { kind: string; id: string } | undefined,
): boolean {
  return !!a && !!b && a.kind === b.kind && a.id === b.id;
}

/** Exact match against the binding's permitted targets; a display-name match is never enough. */
export function isPermittedTarget(
  binding: RuntimeBinding,
  target: { kind: string; id: string },
): boolean {
  return binding.permittedTargets.some(
    (item) => item.kind === target.kind && item.id === target.id,
  );
}

/** Text that may be shown or logged: no control or bidirectional characters, bounded. */
export function safeText(value: unknown, max = 200): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\p{Cc}‪-‮⁦-⁩]/gu, "")
    .trim()
    .slice(0, max);
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}

export function requireConnection(ctx: AdapterCallContext): ConnectionRecord {
  if (!ctx.connection)
    throw new ConnectorError("invalid-request", {
      detail: "supabase.connection.required",
    });
  return ctx.connection;
}

/** Custody scope for a host-owned credential of this connection; the owner is the authenticated actor. */
export function credentialScope(
  ctx: AdapterCallContext,
  connectionRef: string,
): CredentialScope {
  return {
    tenantId: ctx.actor.tenantId,
    ownerKind: ctx.connection?.ownerKind ?? "user",
    ownerId: ctx.actor.subjectId,
    connectionRef,
    bindingRef: ctx.binding.bindingRef,
    custody: "host-owned",
  };
}

export function boundedSignal(
  ctx: AdapterCallContext,
  timeoutMs: number,
): AbortSignal {
  return AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);
}

const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The one destination a profile may use, pinned to the documented origin.
 * A loopback fixture is admitted only when the binding says so explicitly;
 * nothing in a request can move the profile to another host.
 */
export function pinnedDestination(
  binding: RuntimeBinding,
  id: string,
  expectedOrigin: string,
  detailPrefix: string,
): ApprovedDestination {
  const destination = binding.destinations.find((item) => item.id === id);
  if (!destination)
    throw new ConnectorError("network-policy", {
      detail: `${detailPrefix}.destination-missing`,
    });
  const url = new URL(destination.origin);
  const loopback =
    destination.network === "loopback-fixture" &&
    url.protocol === "http:" &&
    loopbackHosts.has(url.hostname);
  if (destination.origin !== expectedOrigin && !loopback)
    throw new ConnectorError("network-policy", {
      detail: `${detailPrefix}.destination-not-pinned`,
    });
  return destination;
}

const reviver = (key: string, value: unknown) =>
  key === "__proto__" || key === "constructor" || key === "prototype"
    ? undefined
    : value;

/** Reads a JSON body under a byte ceiling; oversize or malformed bodies fail without being quoted. */
export async function readBoundedJson(
  response: Response,
  maxBytes: number,
  detailPrefix: string,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ConnectorError("upstream-rejected", {
        detail: `${detailPrefix}.response-too-large`,
      });
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text, reviver) as unknown;
  } catch {
    throw new ConnectorError("upstream-rejected", {
      detail: `${detailPrefix}.response-not-json`,
    });
  }
}

/** Discards a body we will not read, so a provider message never becomes an error text. */
export async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to recover: the body is not part of any outcome.
  }
}

/** Status-only failure mapping; provider bodies never reach a caller. */
export function upstreamFailure(
  status: number,
  detailPrefix: string,
): ConnectorError {
  if (status === 401)
    return new ConnectorError("expired", {
      detail: `${detailPrefix}.access-rejected`,
    });
  if (status === 403)
    return new ConnectorError("denied", { detail: `${detailPrefix}.forbidden` });
  if (status === 404)
    return new ConnectorError("not-found", {
      detail: `${detailPrefix}.not-found`,
    });
  if (status === 429)
    return new ConnectorError("rate-limited", {
      detail: `${detailPrefix}.rate-limited`,
    });
  if (status >= 500)
    return new ConnectorError("upstream-unavailable", {
      detail: `${detailPrefix}.unavailable`,
    });
  return new ConnectorError("upstream-rejected", {
    detail: `${detailPrefix}.rejected`,
  });
}

export type ClaimInput = {
  kind: VerificationClaim["kind"];
  target: { kind: string; id: string };
  verifierVersion: string;
  issuer?: VerificationClaim["issuer"];
  observedAt?: number;
  validForMs?: number;
  permissions?: NonNullable<VerificationClaim["permissions"]>;
  limitations?: string[];
};

/** One narrow claim, validated against the shared schema so a malformed claim fails here, not in a store. */
export function makeClaim(
  ctx: AdapterCallContext,
  input: ClaimInput,
): VerificationClaim {
  const observedAt = input.observedAt ?? ctx.environment.now();
  return verificationClaimSchema.parse({
    kind: input.kind,
    evidenceRef: `supabase:${input.kind}:${ctx.environment.random.uuid()}`,
    issuer: input.issuer ?? "provider",
    target: input.target,
    observedAt: isoTime(observedAt),
    ...(input.validForMs
      ? { validUntil: isoTime(observedAt + input.validForMs) }
      : {}),
    verifierVersion: input.verifierVersion,
    bindingRevision: ctx.binding.revision,
    policyRevision: ctx.binding.policyRevision,
    ...(input.permissions ? { permissions: input.permissions } : {}),
    limitations: (input.limitations ?? []).map((item) => safeText(item, 500)),
  });
}

/** Unquoted lowercase Postgres identifier; mixed-case or quoted names are out of scope. */
export const sqlIdentifierSchema = z
  .string()
  .regex(/^[a-z_][a-z0-9_]{0,62}$/, "Lowercase Postgres identifier");

import { z } from "zod";
import { AuthorizationError, type Capability } from "../identity.js";
import {
  PersistenceConflict,
  type AsyncCeremonyStore,
} from "../persistence/index.js";
import { SYSTEM_TENANT, SYSTEM_TENANTS } from "../system-tenants.js";

/*
 * Who a verified identity is, in hosted terms: which tenant it belongs to and
 * what it may do there.
 *
 * Both answers come from signed claims the identity provider issued, never
 * from a request header, a tool argument or a browser field. The browser
 * (ID token) and MCP (access token) adapters map claims through this one
 * object, so a person cannot be an author in one transport and an executor in
 * the other, or land in a different tenant depending on how they arrived.
 *
 * Tenancy has two modes:
 *
 * - **Pinned.** `CEREMONY_TENANT_ID` alone: every identity belongs to that one
 *   tenant. This is the single-tenant reference deployment and is unchanged.
 * - **From a claim.** `CEREMONY_TENANT_CLAIM` names a claim (for example an
 *   organization id) whose value is the tenant. A token without that claim,
 *   or with a malformed one, is refused rather than placed anywhere: silently
 *   falling back to a default tenant would merge unrelated organizations.
 *   `CEREMONY_TENANT_ID`, when also set, names the deployment's home tenant,
 *   to which tenant-wide operator settings (the Jira setup owner, A2H) apply.
 *
 * Both claim settings name a claim in one of two spellings, told apart by the
 * first character. A name that does not start with `/` is one top-level claim,
 * taken whole: `https://example.invalid/claims.tenant` is a single claim even
 * though it contains dots and slashes, exactly as identity providers that
 * namespace custom claims by URL issue it. A name that starts with `/` is an
 * RFC 6901 JSON Pointer into nested claims: `/realm_access/roles` reads
 * `roles` inside the `realm_access` object, and a URL-shaped key inside a
 * pointer escapes its slashes as `~1` (`/https:~1~1example.invalid~1claims/org`).
 * Dots are never separators, so no claim name is ambiguous. A pointer walks
 * objects only; an array, a string or a number on the way is a malformed
 * token, not something to index into or coerce.
 */

const capabilities = [
  "author",
  "reviewer",
  "publisher",
  "executor",
  "admin",
] as const satisfies readonly Capability[];

/** A tenant a claim may name: short, printable and safe as a record key everywhere. */
const claimedTenant = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,99}$/);
/** A person's claim never names a tenant the server writes its own records under. */
const reservedTenants = new Set(SYSTEM_TENANTS);
const claimName = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.:/#~-]+$/)
  .superRefine((value, context) => {
    try {
      claimPath(value);
    } catch {
      context.addIssue({ code: "custom", message: "Invalid claim path" });
    }
  });

/** How deep a pointer may reach; identity-provider claims nest two or three levels. */
const MAX_CLAIM_DEPTH = 8;

/**
 * The keys a claim setting names, outermost first. A leading `/` makes it an
 * RFC 6901 pointer; anything else is one top-level claim name, verbatim.
 * Malformed pointers throw, so configuration fails before any token is read:
 * an empty segment (`//`, a trailing `/`, `/` alone), an escape other than
 * `~0` or `~1`, or more than eight segments.
 */
export function claimPath(name: string): readonly string[] {
  if (!name.startsWith("/")) return [name];
  const segments = name.slice(1).split("/");
  if (segments.length > MAX_CLAIM_DEPTH)
    throw new Error("A claim pointer is too deep");
  return segments.map((segment) => {
    if (segment === "" || /~(?![01])/.test(segment))
      throw new Error("A claim pointer is malformed");
    return segment.replace(/~1/g, "/").replace(/~0/g, "~");
  });
}

const malformed: unique symbol = Symbol("malformed claim");

const isClaimObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The value at a claim path, `undefined` when some object on the way lacks the
 * key, or `malformed` when the path runs into something that is not an
 * object. Only own properties are read, so `constructor` or `__proto__` in a
 * path finds nothing rather than the prototype.
 */
function readClaim(
  claims: Readonly<Record<string, unknown>>,
  path: readonly string[],
): unknown {
  let current: unknown = claims;
  for (const key of path) {
    if (!isClaimObject(current)) return malformed;
    if (!Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

const INDEX_TENANT = SYSTEM_TENANT.hostedIndex;

export interface HostedTenancyConfig {
  /** Pinned tenant, or the home tenant when `claim` is set. */
  home?: string;
  /** Claim whose value is the tenant. Absent: every identity is `home`. */
  claim?: string;
  /** Claim carrying roles. Default `ceremony_roles`. */
  rolesClaim?: string;
  /**
   * Identity-provider role or group name to capabilities. Absent: a role
   * grants the capability of the same name and nothing else.
   */
  rolesMap?: Readonly<Record<string, readonly Capability[]>>;
}

export class HostedTenancy {
  readonly home: string | undefined;
  readonly claim: string | undefined;
  readonly rolesClaim: string;
  private readonly tenantPath: readonly string[] | undefined;
  private readonly rolesPath: readonly string[];
  private readonly rolesMap:
    ReadonlyMap<string, readonly Capability[]> | undefined;
  private readonly remembered = new Set<string>();

  constructor(config: HostedTenancyConfig) {
    if (!config.home && !config.claim)
      throw new Error("A tenant or a tenant claim is required");
    if (config.claim !== undefined) claimName.parse(config.claim);
    if (config.rolesClaim !== undefined) claimName.parse(config.rolesClaim);
    this.home = config.home;
    this.claim = config.claim;
    this.rolesClaim = config.rolesClaim ?? "ceremony_roles";
    this.tenantPath = config.claim ? claimPath(config.claim) : undefined;
    this.rolesPath = claimPath(this.rolesClaim);
    this.rolesMap = config.rolesMap
      ? new Map(Object.entries(config.rolesMap))
      : undefined;
  }

  /** Whether an actor's tenant is one this deployment serves. */
  accepts(tenantId: string): boolean {
    if (!this.claim) return tenantId === this.home;
    return (
      tenantId === this.home ||
      (claimedTenant.safeParse(tenantId).success &&
        !reservedTenants.has(tenantId))
    );
  }

  /** The tenant signed claims place this identity in; refuses rather than guesses. */
  tenantFor(claims: Readonly<Record<string, unknown>>): string {
    if (!this.tenantPath) return this.home!;
    // Only a string names a tenant. A number is not coerced (`12` and `12.0`
    // would be one organization or two depending on the issuer's encoder),
    // and an array is not searched for a first element.
    const value = readClaim(claims, this.tenantPath);
    const parsed = claimedTenant.safeParse(value);
    if (!parsed.success || reservedTenants.has(parsed.data))
      throw new AuthorizationError("denied");
    return parsed.data;
  }

  /**
   * Capabilities from the roles claim. A token that carries no roles claim is
   * an executor and nothing more; a claim that is present grants exactly what
   * it maps to, which may be nothing. Unknown role names grant nothing rather
   * than failing sign-in, because identity providers put many unrelated
   * groups in the same claim. A malformed claim is refused, and so is a
   * pointer that runs into a non-object on its way to the roles.
   */
  capabilitiesFor(claims: Readonly<Record<string, unknown>>): Capability[] {
    const raw = readClaim(claims, this.rolesPath);
    if (raw === undefined) return ["executor"];
    if (raw === malformed) throw new AuthorizationError("denied");
    const roles = z
      .union([
        z.array(z.string().max(200)).max(200),
        // Space-separated, as a scope-like claim carries them.
        z
          .string()
          .max(4000)
          .transform((value) => value.split(/\s+/).filter(Boolean)),
      ])
      .safeParse(raw);
    if (!roles.success) throw new AuthorizationError("denied");
    const granted = new Set<Capability>();
    for (const role of roles.data) {
      const mapped = this.rolesMap
        ? (this.rolesMap.get(role) ?? [])
        : (capabilities as readonly string[]).includes(role)
          ? [role as Capability]
          : [];
      for (const capability of mapped) granted.add(capability);
    }
    return capabilities.filter((capability) => granted.has(capability));
  }

  /**
   * Records that a tenant exists, so the workload dispatcher can find its
   * pending work. Written once per tenant; the in-process set only saves the
   * repeat write, the store stays authoritative.
   */
  async remember(store: AsyncCeremonyStore, tenantId: string): Promise<void> {
    if (tenantId === this.home || this.remembered.has(tenantId)) return;
    const key = {
      tenant: INDEX_TENANT,
      kind: "session" as const,
      id: `tenant:${tenantId}`,
    };
    try {
      await store.transaction(async (tx) => {
        if (!(await tx.get(key))) await tx.put(key, { tenantId }, null);
      });
    } catch (error) {
      // Another request recorded it first; that is the outcome wanted.
      if (!(error instanceof PersistenceConflict)) throw error;
    }
    this.remembered.add(tenantId);
  }

  /** Every tenant with possible pending work: the home tenant and those seen. */
  async tenants(store: AsyncCeremonyStore): Promise<string[]> {
    const found = new Set<string>(this.home ? [this.home] : []);
    if (!this.claim) return [...found];
    let after = "";
    for (;;) {
      const page = await store.transaction((tx) =>
        tx.list<{ tenantId?: unknown }>(INDEX_TENANT, "session", 100, after),
      );
      for (const row of page) {
        const tenantId = row.value.tenantId;
        if (typeof tenantId === "string" && this.accepts(tenantId))
          found.add(tenantId);
      }
      if (page.length < 100) break;
      after = page.at(-1)!.id;
    }
    return [...found];
  }
}

/** Reads tenancy from the protected environment; invalid configuration fails closed. */
export function hostedTenancy(env: NodeJS.ProcessEnv): HostedTenancy {
  const config = z
    .strictObject({
      home: z.string().min(1).max(100).optional(),
      claim: claimName.optional(),
      rolesClaim: claimName.optional(),
      rolesMap: z
        .string()
        .max(16384)
        .transform((text, context) => {
          try {
            return JSON.parse(text) as unknown;
          } catch {
            context.addIssue({ code: "custom", message: "Invalid roles map" });
            return z.NEVER;
          }
        })
        .pipe(
          z
            .record(
              z.string().min(1).max(200),
              z.array(z.enum(capabilities)).max(5),
            )
            .refine((map) => Object.keys(map).length <= 100),
        )
        .optional(),
    })
    .parse({
      ...(env.CEREMONY_TENANT_ID ? { home: env.CEREMONY_TENANT_ID } : {}),
      ...(env.CEREMONY_TENANT_CLAIM
        ? { claim: env.CEREMONY_TENANT_CLAIM }
        : {}),
      ...(env.CEREMONY_ROLES_CLAIM
        ? { rolesClaim: env.CEREMONY_ROLES_CLAIM }
        : {}),
      ...(env.CEREMONY_ROLES_MAP ? { rolesMap: env.CEREMONY_ROLES_MAP } : {}),
    });
  return new HostedTenancy({
    ...(config.home ? { home: config.home } : {}),
    ...(config.claim ? { claim: config.claim } : {}),
    ...(config.rolesClaim ? { rolesClaim: config.rolesClaim } : {}),
    ...(config.rolesMap ? { rolesMap: config.rolesMap } : {}),
  });
}

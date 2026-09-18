import { z } from "zod";
import {
  capabilityStatus,
  type AdapterCallContext,
  type AuthorizationIntent,
  type AuthorizationStart,
  type CapabilityStatus,
  type CompletionInput,
  type CompletionResult,
  type ConnectorAdapter,
  type DiscoverInput,
  type DiscoverResult,
  type InvokeRequest,
  type InvokeResult,
  type VerificationClaim,
} from "../../adapter.js";
import {
  boundOperation,
  destinationFor,
  destinationUrl,
  type ApprovedDestination,
  type BoundOperation,
} from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import {
  mergeAccountDetailsSchema,
  mergeAccountTokenResponseSchema,
  mergeCategorySchema,
  mergeConfigurationNames,
  mergeConfigurationRequirements,
  mergeDestinationIds,
  mergeLinkTokenResponseSchema,
  mergeLinkedAccountSchema,
  mergeLinkedAccountsPageSchema,
  mergeListResponseSchema,
  mergeMetaResponseSchema,
  mergeModelSchema,
  mergePassthroughResponseSchema,
  mergeTargetKinds,
  resolveMergeOrigin,
  MERGE_API_BASE_PATH,
  MERGE_PROFILE,
  type MergeCategory,
  type MergeLinkedAccount,
} from "./contracts.js";

/*
 * Merge holds the upstream provider's credentials; Ceremony never sees them and
 * never asks for them. What it holds is the *account token*, which is itself a
 * credential for one linked account: it lives in custody, is used only inside
 * `credentials.use`, and never enters a result, a log or a model-visible value.
 * The Link token and the Merge Link URL are protected transient material and
 * leave only through a private handoff for the initiating human.
 *
 * Nothing here generalizes across accounts. Two linked accounts of the same
 * category routinely support different fields and operations; the adapter reads
 * each account's own `/meta` and linked-account metadata and reports absence as
 * absence (AC-EXT-15).
 */

export const MERGE_ADAPTER_VERSION = "2026.09.18";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

const reservedKeys = new Set(["__proto__", "prototype", "constructor"]);
function assertPlainJson(value: unknown, detail: string, depth = 0): void {
  if (depth > 128) throw new ConnectorError("invalid-request", { detail });
  if (Array.isArray(value)) {
    for (const item of value) assertPlainJson(item, detail, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new ConnectorError("invalid-request", { detail });
    for (const key of Object.keys(value)) {
      if (reservedKeys.has(key))
        throw new ConnectorError("invalid-request", { detail });
      assertPlainJson(
        (value as Record<string, unknown>)[key],
        detail,
        depth + 1,
      );
    }
  }
}

const readInputSchema = z
  .strictObject({
    cursor: z.string().max(2048).optional(),
    pageSize: z.number().int().min(1).max(100).optional(),
    modifiedAfter: z.string().max(64).optional(),
  })
  .readonly();

const passthroughInputSchema = z
  .strictObject({
    /** Only a body and query the binding's route permits; never a path or a URL. */
    query: z.record(z.string().max(120), z.string().max(512)).optional(),
    data: z.unknown().optional(),
  })
  .readonly();

/** A passthrough route is fixed in the binding; input can never choose one. */
export const mergePassthroughRouteSchema = z
  .strictObject({
    category: mergeCategorySchema,
    /** The upstream path Merge proxies to, exactly as approved. */
    path: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^\/[^\p{Cc}?#]*$/u),
    method: z.enum([
      "GET",
      "HEAD",
      "OPTIONS",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
    ]),
    requestFormat: z.enum(["JSON", "XML", "MULTIPART"]).optional(),
  })
  .readonly();
export type MergePassthroughRoute = z.infer<typeof mergePassthroughRouteSchema>;

/** A normalized read is a category model plus the fields the host approved. */
export const mergeReadRouteSchema = z
  .strictObject({
    category: mergeCategorySchema,
    model: mergeModelSchema,
    /** Fields projected out of each result; absence in the upstream stays absence. */
    fields: z.array(z.string().min(1).max(120)).max(256),
  })
  .readonly();
export type MergeReadRoute = z.infer<typeof mergeReadRouteSchema>;

export type MergeAdapterOptions = {
  adapterVersion?: string;
  requestTimeoutMs?: number;
  /** Link token lifetime in minutes; Merge accepts 30..720 (10080 for magic links). */
  linkExpiryMinutes?: number;
};

type CallOptions = {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Whether this call acts on one end user's data and needs the account token. */
  accountToken?: string;
};

function statusFor(status: number): {
  code: ConnectorError["code"];
  detail: string;
} {
  if (status === 400)
    return { code: "invalid-request", detail: "merge.upstream.bad-request" };
  if (status === 401)
    return {
      code: "unauthenticated",
      detail: "merge.upstream.unauthenticated",
    };
  if (status === 403)
    return { code: "denied", detail: "merge.upstream.denied" };
  if (status === 404)
    return { code: "not-found", detail: "merge.upstream.not-found" };
  if (status === 409)
    return { code: "conflict", detail: "merge.upstream.conflict" };
  if (status === 429)
    return { code: "rate-limited", detail: "merge.upstream.rate-limited" };
  if (status >= 500)
    return {
      code: "upstream-unavailable",
      detail: "merge.upstream.unavailable",
    };
  return { code: "upstream-rejected", detail: "merge.upstream.rejected" };
}

export function createMergeAdapter(
  options: MergeAdapterOptions = {},
): ConnectorAdapter {
  const adapterVersion = options.adapterVersion ?? MERGE_ADAPTER_VERSION;
  const timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const linkExpiryMinutes = options.linkExpiryMinutes ?? 30;

  const destination = (ctx: AdapterCallContext): ApprovedDestination => {
    const approved = ctx.binding.destinations.find(
      (item) => item.id === mergeDestinationIds.api,
    );
    if (!approved)
      throw new ConnectorError("denied", {
        detail: "merge.destination.unapproved",
      });
    return approved;
  };

  /** Asserts the configured origin is a documented Merge origin and the approved one. */
  const assertOrigin = async (
    ctx: AdapterCallContext,
    approved: ApprovedDestination,
  ): Promise<void> => {
    const configured = await ctx.environment.configuration.read(
      mergeConfigurationNames.apiOrigin,
    );
    // A loopback fixture destination stands in for the documented origin.
    if (approved.network === "loopback-fixture") return;
    const expected = resolveMergeOrigin(configured);
    if (approved.origin !== expected)
      throw new ConnectorError("network-policy", {
        detail: "merge.origin.mismatch",
      });
  };

  const call = async (
    ctx: AdapterCallContext,
    input: CallOptions,
  ): Promise<{ status: number; body: unknown }> => {
    const approved = destination(ctx);
    await assertOrigin(ctx, approved);
    const apiKey = await ctx.environment.configuration.read(
      mergeConfigurationNames.apiKey,
    );
    if (!apiKey)
      throw new ConnectorError("configuration-required", {
        detail: "merge.api-key.missing",
      });
    const url = destinationUrl(approved, `${MERGE_API_BASE_PATH}${input.path}`);
    for (const [key, value] of Object.entries(input.query ?? {}))
      if (value !== undefined) url.searchParams.set(key, String(value));
    const controller = new AbortController();
    const abort = () => controller.abort();
    ctx.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    let response: Response;
    try {
      response = await ctx.environment.fetch(url, {
        method: input.method,
        redirect: "error",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: "application/json",
          ...(input.accountToken
            ? { "x-account-token": input.accountToken }
            : {}),
          ...(input.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(input.body === undefined
          ? {}
          : { body: JSON.stringify(input.body) }),
      });
    } catch (error) {
      if (ctx.signal.aborted)
        throw new ConnectorError("cancelled", {
          detail: "merge.request.cancelled",
        });
      throw new ConnectorError("upstream-unavailable", {
        detail: "merge.request.failed",
        cause: error,
      });
    } finally {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", abort);
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES)
      throw new ConnectorError("invalid-request", {
        detail: "merge.response.too-large",
      });
    let body: unknown;
    if (text.length) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new ConnectorError("upstream-rejected", {
          detail: "merge.response.invalid",
        });
      }
      assertPlainJson(body, "merge.response.invalid");
    }
    return { status: response.status, body };
  };

  const requireOk = (result: { status: number; body: unknown }) => {
    if (result.status >= 200 && result.status < 300) return result.body;
    const { code, detail } = statusFor(result.status);
    throw new ConnectorError(code, { detail });
  };

  /**
   * Runs work with the account token held in custody. The token never leaves
   * the callback, and the callback's result is the only thing that escapes.
   */
  const withAccountToken = async <T>(
    ctx: AdapterCallContext,
    work: (token: string) => Promise<T>,
  ): Promise<T> => {
    const connection = ctx.connection;
    if (!connection?.credentialRef)
      throw new ConnectorError("unauthenticated", {
        detail: "merge.account-token.absent",
      });
    return ctx.environment.credentials.use(
      {
        tenantId: connection.tenantId,
        ownerKind: connection.ownerKind,
        ownerId: connection.ownerId,
        connectionRef: connection.connectionRef,
        bindingRef: connection.bindingRef,
        custody: "external-credential-broker",
      },
      connection.credentialRef,
      async (material) => {
        const token = material.accountToken;
        if (!token)
          throw new ConnectorError("unauthenticated", {
            detail: "merge.account-token.absent",
          });
        return work(token);
      },
    );
  };

  /** The host's own mapping decides the end user; a caller never supplies one. */
  const endUserFor = (
    ctx: AdapterCallContext,
  ): { originId: string; organization: string; email: string } => {
    const mapping = ctx.binding.settings["merge.endUsers"];
    if (!mapping || typeof mapping !== "object")
      throw new ConnectorError("configuration-required", {
        detail: "merge.end-user.unmapped",
      });
    const parsed = z
      .record(
        z.string().max(200),
        z.strictObject({
          originId: z.string().min(1).max(200),
          organization: z.string().min(1).max(200),
          email: z.string().min(3).max(320),
        }),
      )
      .safeParse(mapping);
    if (!parsed.success)
      throw new ConnectorError("configuration-required", {
        detail: "merge.end-user.unmapped",
      });
    const entry = Object.hasOwn(parsed.data, ctx.actor.subjectId)
      ? parsed.data[ctx.actor.subjectId]
      : undefined;
    if (!entry)
      throw new ConnectorError("denied", { detail: "merge.end-user.unmapped" });
    return entry;
  };

  const categoriesFor = (ctx: AdapterCallContext): MergeCategory[] => {
    const parsed = z
      .array(mergeCategorySchema)
      .min(1)
      .max(8)
      .safeParse(ctx.binding.settings["merge.categories"]);
    if (!parsed.success)
      throw new ConnectorError("configuration-required", {
        detail: "merge.categories.unset",
      });
    return parsed.data;
  };

  const resolveRoute = <T>(
    ctx: AdapterCallContext,
    operationRef: string,
    key: string,
    schema: z.ZodType<T>,
  ): { bound: BoundOperation; route: T } => {
    const bound = boundOperation(ctx.binding, operationRef);
    if (!bound)
      throw new ConnectorError("denied", {
        detail: "merge.operation.unapproved",
      });
    destinationFor(ctx.binding, bound);
    const routes = ctx.binding.settings[key];
    if (!routes || typeof routes !== "object")
      throw new ConnectorError("denied", { detail: "merge.route.absent" });
    if (!Object.hasOwn(routes, operationRef))
      throw new ConnectorError("denied", { detail: "merge.route.absent" });
    const parsed = schema.safeParse(
      (routes as Record<string, unknown>)[operationRef],
    );
    if (!parsed.success)
      throw new ConnectorError("denied", { detail: "merge.route.invalid" });
    return { bound, route: parsed.data };
  };

  const capabilities = (present: ReadonlySet<string>): CapabilityStatus[] => {
    const configuration = present.has(mergeConfigurationNames.apiKey)
      ? ("ready" as const)
      : ("missing" as const);
    const self = { adapterVersion, runtime: "hosted-server" as const };
    return [
      capabilityStatus(self, {
        dimension: "authorize",
        profile: MERGE_PROFILE,
        configuration,
        evidence: "protocol-fixture",
        limitations: [
          "The end user completes Merge Link in a browser; the link token and URL stay private to the initiating human.",
        ],
      }),
      capabilityStatus(self, {
        dimension: "verify",
        profile: MERGE_PROFILE,
        configuration,
        evidence: "protocol-fixture",
        limitations: [
          "Verification observes the linked account Merge reports; Merge holds the upstream credential and Ceremony never sees the provider account directly.",
        ],
      }),
      capabilityStatus(self, {
        dimension: "discover",
        profile: MERGE_PROFILE,
        configuration,
        evidence: "protocol-fixture",
        limitations: [
          "Supported operations and fields are read per linked account; they are never generalized across accounts.",
        ],
      }),
      capabilityStatus(self, {
        dimension: "invoke",
        profile: MERGE_PROFILE,
        configuration,
        evidence: "protocol-fixture",
        limitations: [
          "Only approved category-model reads; a field the account does not support is reported absent, never filled in.",
        ],
      }),
      capabilityStatus(self, {
        dimension: "delegate",
        profile: MERGE_PROFILE,
        configuration,
        evidence: "protocol-fixture",
        limitations: [
          "Passthrough is governed separately: the upstream path and method are fixed in the binding and cannot come from input.",
        ],
      }),
      capabilityStatus(self, {
        dimension: "configure",
        profile: MERGE_PROFILE,
        configuration,
        evidence: "unit",
      }),
      capabilityStatus(self, {
        dimension: "reconnect",
        profile: MERGE_PROFILE,
        configuration,
        evidence: "protocol-fixture",
        limitations: [
          "Reconnect issues a new Link session; a different upstream account requires explicit account-switch intent.",
        ],
      }),
      capabilityStatus(self, {
        dimension: "disconnect",
        profile: MERGE_PROFILE,
        configuration,
        evidence: "protocol-fixture",
        limitations: [
          "Local disconnect drops the account token; deleting the linked account at Merge is a separate authorized intent.",
        ],
      }),
      ...(["import", "events", "revoke", "export"] as const).map((dimension) =>
        capabilityStatus(self, {
          dimension,
          profile: MERGE_PROFILE,
          implementation: "unsupported",
        }),
      ),
    ];
  };

  const claimFor = (
    ctx: AdapterCallContext,
    account: MergeLinkedAccount,
    limitations: string[],
    permissions?: VerificationClaim["permissions"],
  ): VerificationClaim => ({
    kind: "account-identity",
    evidenceRef: `evidence:merge:${ctx.environment.random.uuid()}`,
    issuer: "external-broker",
    target: { kind: mergeTargetKinds.linkedAccount, id: account.id },
    observedAt: new Date(ctx.environment.now()).toISOString(),
    verifierVersion: adapterVersion,
    bindingRevision: ctx.binding.revision,
    policyRevision: ctx.binding.policyRevision,
    ...(permissions ? { permissions } : {}),
    limitations,
  });

  return {
    id: "merge",
    ecosystem: "merge",
    adapterVersion,
    runtime: "hosted-server",
    displayName: "Merge Unified API",
    description:
      "Onboards linked accounts through Merge Link, reads each account's own supported operations and fields, and runs approved normalized reads and separately governed passthrough.",
    service: "merge",
    support: "provider-backed",
    custody: ["external-credential-broker"],
    configuration: mergeConfigurationRequirements,
    profiles: ["external-broker"],
    capabilities,

    /**
     * Creates a Link token for the host-mapped end user and hands the Merge
     * Link URL to the initiating human as private material. The end user
     * identity comes from the host's owner mapping, never from input.
     */
    async authorize(
      ctx: AdapterCallContext,
      intent: AuthorizationIntent,
    ): Promise<AuthorizationStart> {
      const apiKey = await ctx.environment.configuration.read(
        mergeConfigurationNames.apiKey,
      );
      if (!apiKey)
        return {
          kind: "configuration-required",
          missing: [mergeConfigurationNames.apiKey],
        };
      if (intent.interruption === "none")
        return { kind: "human-required", code: "merge.link.human-required" };
      const endUser = endUserFor(ctx);
      const categories = categoriesFor(ctx);
      const integration = ctx.binding.settings["merge.integration"];
      const body = requireOk(
        await call(ctx, {
          method: "POST",
          path: "/integrations/create-link-token",
          body: {
            end_user_origin_id: endUser.originId,
            end_user_organization_name: endUser.organization,
            end_user_email_address: endUser.email,
            categories,
            link_expiry_mins: linkExpiryMinutes,
            ...(typeof integration === "string" ? { integration } : {}),
          },
        }),
      );
      const parsed = mergeLinkTokenResponseSchema.safeParse(body);
      if (!parsed.success)
        throw new ConnectorError("upstream-rejected", {
          detail: "merge.link-token.invalid",
        });
      return {
        kind: "handoff",
        handoff: {
          kind: "connect-widget",
          presentation: "popup",
          expiresAt: ctx.environment.now() + linkExpiryMinutes * 60_000,
          intent: "merge.link",
          correlationKey: endUser.originId,
          private: {
            linkToken: parsed.data.link_token,
            ...(parsed.data.magic_link_url
              ? { url: parsed.data.magic_link_url }
              : {}),
            endUserOriginId: endUser.originId,
          },
        },
      };
    },

    /**
     * Exchanges the public token Merge Link returned for an account token and
     * stores it in custody. The exchange is one-use and journaled; the token
     * itself never appears in the result.
     */
    async complete(
      ctx: AdapterCallContext,
      input: CompletionInput,
    ): Promise<CompletionResult> {
      if (input.kind !== "input")
        return { state: "pending", claims: [], code: "merge.link.pending" };
      const publicToken = z
        .string()
        .min(1)
        .max(4096)
        .regex(/^[^\p{Cc}\s/?#]+$/u)
        .safeParse(input.values.publicToken);
      if (!publicToken.success)
        throw new ConnectorError("invalid-request", {
          detail: "merge.public-token.invalid",
        });
      const connection = ctx.connection;
      if (!connection)
        throw new ConnectorError("invalid-request", {
          detail: "merge.connection.absent",
        });

      const journal = await ctx.environment.effects.begin({
        actor: ctx.actor,
        connectionRef: connection.connectionRef,
        bindingRef: ctx.binding.bindingRef,
        operation: "merge.account-token.exchange",
        digest: `exchange:${connection.connectionRef}:${ctx.generation}`,
      });
      if (journal.prior && journal.prior.status !== "not-applied")
        return {
          state:
            journal.prior.status === "applied" ? "complete" : "indeterminate",
          claims: [],
          code: "merge.account-token.replayed",
        };

      const parsed = mergeAccountTokenResponseSchema.safeParse(
        requireOk(
          await call(ctx, {
            method: "GET",
            path: `/integrations/account-token/${encodeURIComponent(publicToken.data)}`,
          }),
        ),
      );
      if (!parsed.success) {
        await ctx.environment.effects.complete(journal.effectRef, {
          status: "failed",
          at: ctx.environment.now(),
        });
        throw new ConnectorError("upstream-rejected", {
          detail: "merge.account-token.invalid",
        });
      }
      const credentialRef = await ctx.environment.credentials.store(
        {
          tenantId: connection.tenantId,
          ownerKind: connection.ownerKind,
          ownerId: connection.ownerId,
          connectionRef: connection.connectionRef,
          bindingRef: connection.bindingRef,
          custody: "external-credential-broker",
        },
        { accountToken: parsed.data.account_token },
      );
      await ctx.environment.effects.complete(journal.effectRef, {
        status: "applied",
        at: ctx.environment.now(),
      });

      const accountId = parsed.data.id;
      return {
        state: "complete",
        claims: accountId
          ? [
              claimFor(ctx, { id: accountId }, [
                "Merge holds the upstream credential; Ceremony observes only the linked account Merge reports.",
              ]),
            ]
          : [],
        credentialRef,
        ...(accountId
          ? {
              externalIds: { linkedAccountId: accountId },
              target: { kind: mergeTargetKinds.linkedAccount, id: accountId },
            }
          : {}),
        adapterState: {
          ...(parsed.data.integration?.slug
            ? { integrationSlug: parsed.data.integration.slug }
            : {}),
        },
      };
    },

    /** Reads the linked account's current status, exactly as Merge reports it. */
    async verify(ctx: AdapterCallContext): Promise<CompletionResult> {
      const categories = categoriesFor(ctx);
      const category = categories[0]!;
      const details = mergeAccountDetailsSchema.safeParse(
        await withAccountToken(ctx, async (token) =>
          requireOk(
            await call(ctx, {
              method: "GET",
              path: `/${category}/v1/account-details`,
              accountToken: token,
            }),
          ),
        ),
      );
      if (!details.success)
        throw new ConnectorError("upstream-rejected", {
          detail: "merge.account-details.invalid",
        });
      const account = details.data;
      const expected = ctx.connection?.externalIds.linkedAccountId;
      if (expected && account.id !== expected)
        return {
          state: "denied",
          claims: [],
          code: "merge.account.mismatch",
        };
      const status = account.status ?? "";
      if (status === "RELINK_NEEDED")
        return {
          state: "human-required",
          claims: [],
          code: "merge.account.relink-needed",
        };
      if (status !== "COMPLETE")
        return {
          state: "pending",
          claims: [],
          code: `merge.account.${status.toLowerCase() || "unknown"}`,
        };
      return {
        state: "complete",
        claims: [
          claimFor(
            ctx,
            account,
            [
              "Merge holds the upstream credential; the provider account is verified by Merge, not by Ceremony.",
              "Status is Merge's own report of the link, not proof of any particular upstream permission.",
            ],
            {
              requested: [],
              reported: [],
              observed: [],
              semantics: "unknown",
            },
          ),
        ],
        externalIds: { linkedAccountId: account.id },
        target: { kind: mergeTargetKinds.linkedAccount, id: account.id },
        adapterState: {
          ...(account.integration_slug
            ? { integrationSlug: account.integration_slug }
            : {}),
          ...(account.account_type
            ? { accountType: account.account_type }
            : {}),
        },
      };
    },

    /**
     * Lists the linked accounts for the host-mapped end user, and, when a
     * connection is present, the account's own supported operations and fields
     * from the documented `/meta` endpoint. Nothing is merged across accounts.
     */
    async discover(
      ctx: AdapterCallContext,
      input: DiscoverInput,
    ): Promise<DiscoverResult> {
      const fetchedAt = ctx.environment.now();
      const categories = categoriesFor(ctx);
      const category = mergeCategorySchema.safeParse(input.scope?.category);
      const chosen = category.success ? category.data : categories[0]!;
      if (!categories.includes(chosen))
        throw new ConnectorError("denied", {
          detail: "merge.category.unapproved",
        });
      const endUser = endUserFor(ctx);
      const page = mergeLinkedAccountsPageSchema.safeParse(
        requireOk(
          await call(ctx, {
            method: "GET",
            path: `/${chosen}/v1/linked-accounts`,
            query: {
              end_user_origin_id: endUser.originId,
              ...(input.cursor ? { cursor: input.cursor } : {}),
              ...(input.limit ? { page_size: input.limit } : {}),
            },
          }),
        ),
      );
      if (!page.success)
        throw new ConnectorError("upstream-rejected", {
          detail: "merge.linked-accounts.invalid",
        });
      return {
        items: page.data.results.map((account) => ({
          identity: {
            ecosystem: "merge",
            authorityNamespace: chosen,
            nativeId: account.id,
            nativeVersion: account.completed_at ?? "unversioned",
          },
          displayName:
            account.integration?.name ?? account.integration_name ?? account.id,
          description: `Merge linked account (${account.status ?? "unknown"} / ${account.account_type ?? "unknown"})`,
          provenance: {
            status: account.status ?? "unknown",
            ...(account.integration?.slug
              ? { integrationSlug: account.integration.slug }
              : {}),
            passthroughAvailable: String(
              account.integration?.passthrough_available ?? false,
            ),
          },
          status: account.status === "COMPLETE" ? "active" : "unknown",
        })),
        ...(page.data.next ? { nextCursor: page.data.next } : {}),
        freshness: { fetchedAt, stale: false, source: "live" },
        issues: [],
      };
    },

    /**
     * An approved normalized read. Output carries exactly the approved fields,
     * and a field the account does not supply is reported as unsupported
     * rather than defaulted to null-as-a-value (AC-EXT-15).
     */
    async invoke(
      ctx: AdapterCallContext,
      request: InvokeRequest,
    ): Promise<InvokeResult> {
      const { bound, route } = resolveRoute(
        ctx,
        request.operationRef,
        "merge.reads",
        mergeReadRouteSchema,
      );
      if (bound.effect !== "read")
        throw new ConnectorError("denied", {
          detail: "merge.operation.not-read",
        });
      if (!categoriesFor(ctx).includes(route.category))
        throw new ConnectorError("denied", {
          detail: "merge.category.unapproved",
        });
      const input = readInputSchema.parse(request.input);

      // The account's own field availability decides what may be claimed.
      const availability = await withAccountToken(ctx, async (token) => {
        const meta = mergeMetaResponseSchema.safeParse(
          requireOk(
            await call(ctx, {
              method: "GET",
              path: `/${route.category}/v1/${route.model}/meta/post`,
              accountToken: token,
            }),
          ),
        );
        return meta.success ? meta.data : undefined;
      });
      if (availability?.status?.can_make_request === false)
        return {
          state: "denied",
          outputClassification: bound.outputClassification,
          effect: "read",
          code: "merge.account.cannot-make-request",
        };

      const body = await withAccountToken(ctx, async (token) =>
        requireOk(
          await call(ctx, {
            method: "GET",
            path: `/${route.category}/v1/${route.model}`,
            query: {
              ...(input.cursor ? { cursor: input.cursor } : {}),
              ...(input.pageSize ? { page_size: input.pageSize } : {}),
              ...(input.modifiedAfter
                ? { modified_after: input.modifiedAfter }
                : {}),
            },
            accountToken: token,
          }),
        ),
      );
      const page = mergeListResponseSchema.safeParse(body);
      if (!page.success)
        throw new ConnectorError("upstream-rejected", {
          detail: "merge.read.invalid",
        });

      // Absence is preserved: a field the account never returned is reported
      // unsupported for this account, not manufactured as a value.
      const results = page.data.results.map((row) => {
        const projected: Record<string, unknown> = {};
        const unsupported: string[] = [];
        for (const field of route.fields) {
          if (Object.hasOwn(row, field)) projected[field] = row[field];
          else unsupported.push(field);
        }
        return {
          fields: projected,
          ...(unsupported.length ? { unsupportedFields: unsupported } : {}),
        };
      });
      return {
        state: "complete",
        output: {
          category: route.category,
          model: route.model,
          results,
          ...(page.data.next ? { next: page.data.next } : {}),
          fieldAvailability: availability?.request_schema
            ? { source: "meta", model: route.model }
            : { source: "unknown", model: route.model },
        },
        outputClassification: bound.outputClassification,
        effect: "read",
      };
    },

    /**
     * Separately governed passthrough. The upstream path and method are fixed
     * in the binding; a caller may supply a body and approved query parameters
     * and nothing else. A passthrough URL from input is refused outright.
     */
    async delegate(ctx, request): Promise<InvokeResult> {
      if (request.action !== "start")
        throw new ConnectorError("unsupported", {
          detail: "merge.passthrough.action",
        });
      const { bound, route } = resolveRoute(
        ctx,
        request.skill,
        "merge.passthrough",
        mergePassthroughRouteSchema,
      );
      if (bound.transport.kind !== "delegated")
        throw new ConnectorError("denied", {
          detail: "merge.passthrough.transport",
        });
      if (bound.transport.route !== `${route.method} ${route.path}`)
        throw new ConnectorError("denied", {
          detail: "merge.passthrough.route-mismatch",
        });
      if (!categoriesFor(ctx).includes(route.category))
        throw new ConnectorError("denied", {
          detail: "merge.category.unapproved",
        });

      const parsedInput = passthroughInputSchema.safeParse(request.input);
      if (!parsedInput.success)
        throw new ConnectorError("invalid-request", {
          detail: "merge.passthrough.input",
        });
      // A caller that tried to name a path, a URL or a method is refused
      // rather than quietly ignored.
      if (
        request.input &&
        typeof request.input === "object" &&
        ["path", "url", "base_url_override", "method", "headers"].some((key) =>
          Object.hasOwn(request.input as Record<string, unknown>, key),
        )
      )
        throw new ConnectorError("denied", {
          detail: "merge.passthrough.caller-route",
        });

      const query = new URLSearchParams(
        parsedInput.data.query ?? {},
      ).toString();
      const path = query ? `${route.path}?${query}` : route.path;
      const body = {
        method: route.method,
        path,
        ...(parsedInput.data.data === undefined
          ? {}
          : { data: parsedInput.data.data }),
        ...(route.requestFormat ? { request_format: route.requestFormat } : {}),
      };

      const journal = await ctx.environment.effects.begin({
        actor: ctx.actor,
        ...(ctx.connection
          ? { connectionRef: ctx.connection.connectionRef }
          : {}),
        bindingRef: ctx.binding.bindingRef,
        operation: `merge.passthrough.${route.method}`,
        digest: JSON.stringify([request.skill, body, request.commandId]),
        commandId: request.commandId,
      });
      if (journal.prior)
        return {
          state:
            journal.prior.status === "applied"
              ? "complete"
              : journal.prior.status === "failed"
                ? "failed"
                : "indeterminate",
          outputClassification: bound.outputClassification,
          effect: bound.effect,
          effectRef: journal.effectRef,
        };
      try {
        const parsed = mergePassthroughResponseSchema.safeParse(
          await withAccountToken(ctx, async (token) =>
            requireOk(
              await call(ctx, {
                method: "POST",
                path: `/${route.category}/v1/passthrough`,
                body,
                accountToken: token,
              }),
            ),
          ),
        );
        if (!parsed.success)
          throw new ConnectorError("upstream-rejected", {
            detail: "merge.passthrough.invalid",
          });
        await ctx.environment.effects.complete(journal.effectRef, {
          status: "applied",
          at: ctx.environment.now(),
        });
        return {
          state: "complete",
          output: parsed.data,
          outputClassification: bound.outputClassification,
          effect: bound.effect,
          effectRef: journal.effectRef,
        };
      } catch (error) {
        const uncertain =
          error instanceof ConnectorError &&
          (error.code === "upstream-unavailable" || error.code === "cancelled");
        await ctx.environment.effects.complete(journal.effectRef, {
          status: uncertain ? "indeterminate" : "failed",
          at: ctx.environment.now(),
          code: uncertain ? "merge.passthrough.uncertain" : undefined,
        });
        if (uncertain)
          return {
            state: "indeterminate",
            outputClassification: bound.outputClassification,
            effect: bound.effect,
            effectRef: journal.effectRef,
            code: "merge.passthrough.uncertain",
          };
        throw error;
      }
    },

    async reconnect(
      ctx: AdapterCallContext,
      intent: AuthorizationIntent,
    ): Promise<AuthorizationStart> {
      return this.authorize!(ctx, intent);
    },

    /**
     * Local disconnect drops the account token. Deleting the linked account at
     * Merge (POST /{category}/v1/delete-account) is a separate, explicitly
     * authorized broker intent and is never implied by a local unlink.
     */
    async disconnect(ctx, scope) {
      if (scope === "local") {
        if (ctx.connection?.credentialRef)
          await ctx.environment.credentials.revoke(
            {
              tenantId: ctx.connection.tenantId,
              ownerKind: ctx.connection.ownerKind,
              ownerId: ctx.connection.ownerId,
              connectionRef: ctx.connection.connectionRef,
              bindingRef: ctx.connection.bindingRef,
              custody: "external-credential-broker",
            },
            ctx.connection.credentialRef,
          );
        return {
          local: "applied",
          broker: "not-attempted",
          upstream: "not-attempted",
        };
      }
      if (scope === "broker") {
        const categories = categoriesFor(ctx);
        await withAccountToken(ctx, async (token) =>
          requireOk(
            await call(ctx, {
              method: "POST",
              path: `/${categories[0]!}/v1/delete-account`,
              accountToken: token,
            }),
          ),
        );
        return {
          local: "not-attempted",
          broker: "applied",
          upstream: "not-attempted",
        };
      }
      // Merge documents no operation that revokes the end user's upstream grant.
      return {
        local: "not-attempted",
        broker: "not-attempted",
        upstream: "unsupported",
      };
    },
  };
}

import { createHash } from "node:crypto";
import {
  boundOperation,
  destinationFor,
  destinationUrl,
} from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import {
  capabilityStatus,
  type AdapterCallContext,
  type CapabilityStatus,
  type ConnectorAdapter,
  type DiscoverInput,
  type DiscoverResult,
  type ImportInput,
  type ImportOutcome,
} from "../../adapter.js";
import {
  readBoundedJson,
  segment,
  smitheryFailure,
  smitheryServerDetailSchema,
  smitheryServerListSchema,
  SMITHERY_ADAPTER_VERSION,
  SMITHERY_API_KEY,
  SMITHERY_ECOSYSTEM,
  SMITHERY_LIMITS,
  SMITHERY_REGISTRY_PROFILE,
  type SmitheryServerListItem,
} from "./api.js";
import {
  normalizeSmitheryServer,
  smitheryDiscoveredItem,
  smitherySourceRecord,
} from "./normalize.js";

/*
 * CAT-01: the Smithery catalog as a read-only source of descriptions.
 *
 * Listing and detail are two documented endpoints with two documented shapes;
 * pagination is Smithery's own `page`/`pageSize` with a `pagination` envelope,
 * not a cursor, and the adapter reports it as it is. Nothing here treats a
 * Smithery listing as an official-registry `server.json`, and nothing here
 * holds a connection: that is the separate connections adapter, with its own
 * custody and its own identifier.
 */

export const SMITHERY_LIST_OPERATION = "smithery.servers.list";
export const SMITHERY_GET_OPERATION = "smithery.servers.get";

export type SmitheryRegistryOptions = {
  /** Overrides the documented list/detail operation refs a binding must pin. */
  listOperationRef?: string;
  getOperationRef?: string;
};

function requireKey(value: string | undefined): string {
  if (!value)
    throw new ConnectorError("configuration-required", {
      detail: "smithery.api-key.missing",
    });
  return value;
}

async function request(
  ctx: AdapterCallContext,
  operationRef: string,
  build: (url: URL) => void,
  pathSuffix?: string,
): Promise<unknown> {
  const operation = boundOperation(ctx.binding, operationRef);
  if (!operation || operation.transport.kind !== "http")
    throw new ConnectorError("configuration-required", {
      detail: "smithery.operation.unbound",
    });
  if (operation.transport.method !== "GET")
    throw new ConnectorError("invalid-request", {
      detail: "smithery.operation.method",
    });
  const destination = destinationFor(ctx.binding, operation);
  const url = destinationUrl(
    destination,
    pathSuffix
      ? `${operation.transport.pathTemplate.replace(/\/$/, "")}/${pathSuffix}`
      : operation.transport.pathTemplate,
  );
  build(url);
  const key = requireKey(
    await ctx.environment.configuration.read(SMITHERY_API_KEY),
  );
  const response = await ctx.environment.fetch(url, {
    method: "GET",
    redirect: "error",
    signal: ctx.signal,
    headers: { accept: "application/json", authorization: `Bearer ${key}` },
  });
  if (!response.ok) throw smitheryFailure(response.status);
  return readBoundedJson(response);
}

export function createSmitheryRegistryAdapter(
  options: SmitheryRegistryOptions = {},
): ConnectorAdapter {
  const listRef = options.listOperationRef ?? SMITHERY_LIST_OPERATION;
  const getRef = options.getOperationRef ?? SMITHERY_GET_OPERATION;

  const adapter: ConnectorAdapter = {
    id: "smithery-registry",
    ecosystem: SMITHERY_ECOSYSTEM,
    adapterVersion: SMITHERY_ADAPTER_VERSION,
    runtime: "hosted-server",
    displayName: "Smithery catalog",
    description:
      "Reads Smithery's server catalog: qualified names, namespaces, declared configuration and tools, as descriptions only.",
    service: "smithery",
    support: "catalog-only",
    custody: ["no-credential"],
    configuration: [
      {
        name: SMITHERY_API_KEY,
        source: "session-environment",
        classification: "secret",
        required: true,
        description: "Smithery API key used to read the catalog.",
      },
    ],
    profiles: [SMITHERY_REGISTRY_PROFILE],
    capabilities(present: ReadonlySet<string>): CapabilityStatus[] {
      const configuration = present.has(SMITHERY_API_KEY) ? "ready" : "missing";
      const rows: CapabilityStatus[] = [
        capabilityStatus(adapter, {
          dimension: "discover",
          profile: SMITHERY_REGISTRY_PROFILE,
          configuration,
          evidence: "protocol-fixture",
          limitations: [
            "Smithery's catalog pages with page/pageSize and exposes no server version.",
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "import",
          profile: SMITHERY_REGISTRY_PROFILE,
          configuration,
          evidence: "protocol-fixture",
          limitations: [
            "A Smithery listing is a Smithery document, not an official-registry server.json.",
          ],
        }),
      ];
      for (const dimension of [
        "configure",
        "authorize",
        "verify",
        "invoke",
        "events",
        "reconnect",
        "disconnect",
        "revoke",
        "export",
        "delegate",
      ] as const)
        rows.push(
          capabilityStatus(adapter, {
            dimension,
            profile: SMITHERY_REGISTRY_PROFILE,
            implementation: "unsupported",
            limitations: [
              dimension === "invoke" || dimension === "authorize"
                ? "Catalog-only: a managed Smithery connection is a separate adapter with external-execution-broker custody."
                : "Catalog-only: this adapter reads descriptions and holds no connection.",
            ],
          }),
        );
      return rows;
    },
    async discover(
      ctx: AdapterCallContext,
      input: DiscoverInput,
    ): Promise<DiscoverResult> {
      const fetchedAt = ctx.environment.now();
      const page = (() => {
        if (input.cursor === undefined) return 1;
        if (!/^[0-9]{1,6}$/.test(input.cursor))
          throw new ConnectorError("invalid-request", {
            detail: "smithery.cursor.invalid",
          });
        return Math.max(Number(input.cursor), 1);
      })();
      const pageSize = Math.min(
        Math.max(input.limit ?? 10, 1),
        SMITHERY_LIMITS.serverPageSize,
      );
      const scopedNamespace = input.scope?.namespace;
      const payload = await request(ctx, listRef, (url) => {
        url.searchParams.set("page", String(page));
        url.searchParams.set("pageSize", String(pageSize));
        if (input.query) url.searchParams.set("q", input.query);
        if (scopedNamespace) url.searchParams.set("namespace", scopedNamespace);
      });
      const parsed = smitheryServerListSchema.safeParse(payload);
      if (!parsed.success)
        throw new ConnectorError("upstream-rejected", {
          detail: "smithery.list.unrecognized",
        });
      const pagination = parsed.data.pagination;
      const more =
        pagination !== undefined && pagination.currentPage < pagination.totalPages;
      return {
        items: parsed.data.servers.map((server) =>
          smitheryDiscoveredItem(server as SmitheryServerListItem),
        ),
        ...(more ? { nextCursor: String(page + 1) } : {}),
        freshness: { fetchedAt, stale: false, source: "live" },
        issues: [],
      };
    },
    async import(
      ctx: AdapterCallContext,
      input: ImportInput,
    ): Promise<ImportOutcome> {
      const capturedAt = new Date(ctx.environment.now()).toISOString();
      const bytes = input.bytes;
      if (bytes.byteLength > SMITHERY_LIMITS.responseBytes)
        throw new ConnectorError("invalid-request", {
          detail: "smithery.document.too-large",
        });
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        throw new ConnectorError("invalid-request", {
          detail: "smithery.document.invalid",
        });
      }
      const parsed = smitheryServerDetailSchema.safeParse(value);
      if (!parsed.success)
        throw new ConnectorError("invalid-request", {
          detail: "smithery.document.unrecognized",
        });
      const listing =
        input.metadata && typeof input.metadata === "object"
          ? (input.metadata as { listing?: SmitheryServerListItem }).listing
          : undefined;
      const source = smitherySourceRecord({
        bytes,
        qualifiedName: parsed.data.qualifiedName,
        namespace: listing?.namespace ?? input.identityHint?.authorityNamespace,
        origin: input.origin,
        capturedAt,
        digest: createHash("sha256").update(bytes).digest("hex"),
      });
      const definition = await normalizeSmitheryServer({
        detail: parsed.data,
        sourceRef: source.sourceRef,
        ...(listing ? { listing } : {}),
      });
      return {
        source,
        definitions: [definition],
        issues: definition.compatibility.issues,
        executableCandidates: [],
      };
    },
  };
  return adapter;
}

/** Fetches one catalog entry's detail document, exactly as Smithery serves it. */
export async function fetchSmitheryServerDocument(
  ctx: AdapterCallContext,
  qualifiedName: string,
  options: SmitheryRegistryOptions = {},
): Promise<{ bytes: Uint8Array; detail: unknown }> {
  const payload = await request(
    ctx,
    options.getOperationRef ?? SMITHERY_GET_OPERATION,
    () => undefined,
    segment(qualifiedName),
  );
  return {
    bytes: new TextEncoder().encode(JSON.stringify(payload)),
    detail: payload,
  };
}

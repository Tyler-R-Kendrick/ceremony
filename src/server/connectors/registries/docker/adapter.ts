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
  type ExportOutcome,
  type ExportRequest,
  type ImportInput,
  type ImportOutcome,
  type InvokeRequest,
  type InvokeResult,
} from "../../adapter.js";
import { readDockerMcpCatalog, type DockerMcpCatalog } from "./catalog.js";
import {
  catalogSourceRecord,
  discoveredItem,
  normalizeDockerEntry,
  DOCKER_ADAPTER_VERSION,
  DOCKER_CATALOG_PROFILE,
  DOCKER_ECOSYSTEM,
  LOCAL_RUNNER_LIMITATION,
} from "./normalize.js";
import { dockerRunDescriptor, exportDockerMcpDescriptor } from "./export.js";
import {
  NO_RUNNER_CONFIGURED,
  unavailableHostRunner,
  type HostRunnerPort,
} from "./runner.js";

/*
 * The Docker MCP catalog adapter: discovery and import of catalog documents,
 * export of a compatible descriptor, and nothing else. Support is
 * `catalog-only` and stays visible as such in the directory, because this
 * adapter can describe a containerized server precisely and cannot run one.
 */

export const DOCKER_CATALOG_OPERATION = "docker-mcp.catalog.fetch";
const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

export type DockerAdapterOptions = {
  /** Explicitly configured local runner; absent means local execution is unavailable. */
  runner?: HostRunnerPort;
  /** The exact reason reported when no runner is configured. */
  runnerUnavailableReason?: string;
  /** Operation ref of the bound catalog document; the binding pins its destination. */
  catalogOperationRef?: string;
  /** Reads a catalog from host configuration instead of the network, when configured. */
  loadCatalog?: (
    ctx: AdapterCallContext,
  ) => Promise<{ text: string; location?: string } | undefined>;
};

async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes)
    throw new ConnectorError("upstream-rejected", {
      detail: "docker.catalog.too-large",
    });
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes)
    throw new ConnectorError("upstream-rejected", {
      detail: "docker.catalog.too-large",
    });
  return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  if (!/^[0-9]{1,9}$/.test(cursor))
    throw new ConnectorError("invalid-request", {
      detail: "docker.cursor.invalid",
    });
  return Number(cursor);
}

function matches(
  query: string | undefined,
  entry: { id: string; title?: string; description?: string },
): boolean {
  if (!query) return true;
  const needle = query.toLowerCase();
  return [entry.id, entry.title ?? "", entry.description ?? ""].some((value) =>
    value.toLowerCase().includes(needle),
  );
}

export function createDockerMcpCatalogAdapter(
  options: DockerAdapterOptions = {},
): ConnectorAdapter & { runner: HostRunnerPort } {
  const runnerReason = options.runnerUnavailableReason ?? NO_RUNNER_CONFIGURED;
  const runner = options.runner ?? unavailableHostRunner(runnerReason);
  const runnerConfigured = options.runner !== undefined;
  const operationRef = options.catalogOperationRef ?? DOCKER_CATALOG_OPERATION;

  async function fetchCatalogText(
    ctx: AdapterCallContext,
  ): Promise<{ text: string; location?: string }> {
    const configured = await options.loadCatalog?.(ctx);
    if (configured) return configured;
    const operation = boundOperation(ctx.binding, operationRef);
    if (!operation || operation.transport.kind !== "http")
      throw new ConnectorError("configuration-required", {
        detail: "docker.catalog.unbound",
      });
    if (operation.transport.method !== "GET")
      throw new ConnectorError("invalid-request", {
        detail: "docker.catalog.method",
      });
    const destination = destinationFor(ctx.binding, operation);
    const url = destinationUrl(destination, operation.transport.pathTemplate);
    const response = await ctx.environment.fetch(url, {
      method: "GET",
      redirect: "error",
      signal: ctx.signal,
      headers: { accept: "application/yaml, text/yaml, text/plain" },
    });
    if (!response.ok)
      throw new ConnectorError(
        response.status >= 500 ? "upstream-unavailable" : "upstream-rejected",
        { detail: "docker.catalog.fetch-failed" },
      );
    return {
      text: await readBoundedText(response, MAX_CATALOG_BYTES),
      location: url.origin + url.pathname,
    };
  }

  const adapter: ConnectorAdapter & { runner: HostRunnerPort } = {
    id: "docker-mcp-catalog",
    ecosystem: DOCKER_ECOSYSTEM,
    adapterVersion: DOCKER_ADAPTER_VERSION,
    runtime: "hosted-server",
    displayName: "Docker MCP catalog",
    description:
      "Imports Docker MCP catalog documents as inert descriptions. Local execution requires a separately configured trusted local runner.",
    service: "docker-mcp",
    support: "catalog-only",
    custody: ["no-credential"],
    configuration: [],
    profiles: [DOCKER_CATALOG_PROFILE],
    runner,
    capabilities(): CapabilityStatus[] {
      const rows: CapabilityStatus[] = [
        capabilityStatus(adapter, {
          dimension: "discover",
          profile: DOCKER_CATALOG_PROFILE,
          evidence: "protocol-fixture",
          limitations: [
            "Discovery reads a catalog document from a binding-approved destination; it never contacts a container registry.",
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "import",
          profile: DOCKER_CATALOG_PROFILE,
          evidence: "protocol-fixture",
          limitations: [
            "Import is inert: no image is pulled, no command is run and no secret value is read.",
          ],
        }),
        capabilityStatus(adapter, {
          dimension: "export",
          profile: DOCKER_CATALOG_PROFILE,
          evidence: "unit",
          limitations: [
            "Only definitions that originated from a Docker catalog can be exported to one; losses are reported.",
          ],
        }),
        {
          dimension: "invoke",
          profile: DOCKER_CATALOG_PROFILE,
          adapterVersion: DOCKER_ADAPTER_VERSION,
          runtime: "trusted-local-runner",
          implementation: runnerConfigured ? "implemented" : "unsupported",
          configuration: runnerConfigured ? "ready" : "missing",
          evidence: runnerConfigured ? "unit" : "not-tested",
          limitations: runnerConfigured
            ? [
                "Execution is delegated to the explicitly configured trusted local runner; Ceremony itself installs and runs nothing.",
              ]
            : [LOCAL_RUNNER_LIMITATION, runnerReason],
        },
      ];
      for (const dimension of [
        "configure",
        "authorize",
        "verify",
        "events",
        "reconnect",
        "disconnect",
        "revoke",
        "delegate",
      ] as const)
        rows.push(
          capabilityStatus(adapter, {
            dimension,
            profile: DOCKER_CATALOG_PROFILE,
            implementation: "unsupported",
            limitations: [
              "The Docker catalog adapter is catalog-only: it describes entries and holds no connection.",
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
      const { text } = await fetchCatalogText(ctx);
      const { catalog, issues } = readDockerMcpCatalog(text);
      if (!catalog)
        return {
          items: [],
          freshness: { fetchedAt, stale: false, source: "live" },
          issues,
        };
      const offset = decodeCursor(input.cursor);
      const limit = Math.min(Math.max(input.limit ?? DEFAULT_PAGE, 1), MAX_PAGE);
      const filtered = catalog.servers.filter((server) =>
        matches(input.query, server),
      );
      const page = filtered.slice(offset, offset + limit);
      const next = offset + limit;
      return {
        items: page.map((server) => discoveredItem(catalog.name, server)),
        ...(next < filtered.length ? { nextCursor: String(next) } : {}),
        freshness: { fetchedAt, stale: false, source: "live" },
        issues,
      };
    },
    async import(
      ctx: AdapterCallContext,
      input: ImportInput,
    ): Promise<ImportOutcome> {
      if (input.bytes.byteLength > MAX_CATALOG_BYTES)
        throw new ConnectorError("invalid-request", {
          detail: "docker.catalog.too-large",
        });
      const text = new TextDecoder("utf-8", { fatal: false }).decode(
        input.bytes,
      );
      const { catalog, issues } = readDockerMcpCatalog(text);
      const source = catalogSourceRecord({
        bytes: input.bytes,
        catalogName: catalog?.name ?? "unreadable-catalog",
        origin: input.origin,
        capturedAt: new Date(ctx.environment.now()).toISOString(),
      });
      if (!catalog)
        return { source, definitions: [], issues, executableCandidates: [] };
      const wanted = input.identityHint?.nativeId;
      const selected: DockerMcpCatalog["servers"] = wanted
        ? catalog.servers.filter((server) => server.id === wanted)
        : catalog.servers;
      const definitions = [];
      for (const server of selected)
        definitions.push(
          await normalizeDockerEntry({
            sourceRef: source.sourceRef,
            catalog,
            server,
          }),
        );
      return {
        source,
        definitions,
        issues,
        // Import never produces an executable candidate here: running a
        // catalog entry needs a trusted local runner, not a review decision.
        executableCandidates: [],
      };
    },
    async export(
      _ctx: AdapterCallContext,
      request: ExportRequest,
    ): Promise<ExportOutcome> {
      if (request.format !== "docker-mcp-catalog")
        throw new ConnectorError("unsupported", {
          detail: "docker.export.format",
        });
      const result = exportDockerMcpDescriptor(request.definition);
      return {
        mediaType: result.mediaType,
        bytes: result.bytes,
        losses: result.losses,
      };
    },
    async invoke(
      ctx: AdapterCallContext,
      request: InvokeRequest,
    ): Promise<InvokeResult> {
      const availability = await runner.available();
      if (!availability.available)
        throw new ConnectorError("unsupported", {
          detail: "docker.runner.unavailable",
        });
      const definition = (ctx.binding.settings as Record<string, unknown>)
        .definition;
      if (!definition)
        throw new ConnectorError("configuration-required", {
          detail: "docker.runner.no-definition",
        });
      const descriptor = dockerRunDescriptor(
        definition as Parameters<typeof dockerRunDescriptor>[0],
      );
      return runner.run(descriptor, ctx, {
        operationRef: request.operationRef,
        input: request.input,
        commandId: request.commandId,
      });
    },
  };
  return adapter;
}

/** Why local execution is unavailable, for a directory row or an error page. */
export async function dockerRunnerAvailability(
  adapter: ConnectorAdapter & { runner: HostRunnerPort },
): Promise<{ available: boolean; reason?: string }> {
  return adapter.runner.available();
}

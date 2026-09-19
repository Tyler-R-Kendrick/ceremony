import { z } from "zod";
import type { ActorContext } from "../../../../core/operation-contracts.js";
import { ConnectorError } from "../../errors.js";
import {
  MCP_REGISTRY_OFFICIAL_META_KEY,
  MCP_REGISTRY_PUBLISHER_META_KEY,
  isoDateTime,
  registryRequestVersionSchema,
  registryServerNameSchema,
  type RegistryArgument,
  type RegistryInput,
  type RegistryKeyValueInput,
  type RegistryOfficialMeta,
  type RegistryPackage,
  type RegistryTransport,
  type ServerJson,
} from "./schemas.js";
import type {
  RegistryIndexRow,
  RegistrySnapshotEntry,
  RegistrySnapshotView,
} from "./snapshot.js";

/*
 * Read surfaces over a snapshot in the registry's own response shapes. The
 * private catalog is for authenticated people and tools of the tenant that
 * owns the snapshot: it shows every source, tombstones and deprecations, and
 * adds Ceremony's own provenance under a namespaced `_meta` key. The public
 * subregistry serves only what the host explicitly marked public, through a
 * positive allowlist of fields, and refuses to publish anything that names a
 * private network. Neither surface ever emits a secret input value, whatever
 * a publisher put in the document.
 */

export const CEREMONY_SNAPSHOT_META_KEY = "io.ceremony.connectors/snapshot";

export type SubregistryQuery = {
  cursor?: string;
  limit?: number;
  search?: string;
  version?: string;
  updated_since?: string;
  include_deleted?: boolean;
};
export type SubregistryServerResponse = {
  server: Record<string, unknown>;
  _meta: Record<string, unknown>;
};
export type SubregistryListResponse = {
  servers: SubregistryServerResponse[];
  metadata: { count: number; nextCursor?: string };
};
export type SubregistryExclusion = { identityDigest: string; reason: string };
export type SubregistryPolicy = {
  /** Explicit publication marks: identity digests, or a predicate over index rows. Nothing is public by default. */
  public:
    | ReadonlySet<string>
    | readonly string[]
    | ((row: RegistryIndexRow) => boolean);
  /** Whether the publisher-provided `_meta` block is republished; off by default because it was never reviewed. */
  includePublisherMeta?: boolean;
  maxLimit?: number;
};
export interface SubregistryReadSurface {
  list(query?: SubregistryQuery): Promise<{
    response: SubregistryListResponse;
    excluded: SubregistryExclusion[];
  }>;
  versions(
    serverName: string,
    options?: { include_deleted?: boolean },
  ): Promise<{
    response: SubregistryListResponse;
    excluded: SubregistryExclusion[];
  }>;
  version(
    serverName: string,
    version: string,
    options?: { include_deleted?: boolean },
  ): Promise<SubregistryServerResponse | undefined>;
}

const sensitiveName =
  /authorization|cookie|token|secret|api[-_]?key|password|credential|passwd|private/i;

const privateHostSuffixes = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home",
  ".corp",
  ".intranet",
  ".test",
  ".example",
  ".invalid",
];

function privateIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return false;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function privateIpv6(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (bare === "::" || bare === "::1") return true;
  if (bare.startsWith("::ffff:")) {
    const mapped = bare.slice(7);
    // Node re-spells an IPv4-mapped address in hex (::ffff:a00:1); expand both forms.
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped);
    if (hex) {
      const high = Number.parseInt(hex[1]!, 16);
      const low = Number.parseInt(hex[2]!, 16);
      return privateIpv4(
        `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`,
      );
    }
    return privateIpv4(mapped);
  }
  const first = bare.split(":")[0] ?? "";
  return (
    /^f[cd][0-9a-f]{0,2}$/.test(first) ||
    /^fe[89ab][0-9a-f]?$/.test(first) ||
    first === "" ||
    first === "ff00"
  );
}

/**
 * Can this URL be published to the world without naming a private network?
 * HTTPS only; no userinfo; no loopback, link-local, private, CGNAT, multicast
 * or special-use hosts; no single-label hosts. Template variables in the host
 * are substituted with a neutral label before the check.
 */
export function isPubliclyRoutableUrl(value: string): boolean {
  if (typeof value !== "string" || value.length > 2048) return false;
  const substituted = value.replace(/\{[^}]*\}/g, "tmpl");
  if (!URL.canParse(substituted)) return false;
  const url = new URL(substituted);
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (!host || host === "localhost") return false;
  if (host.startsWith("[")) return !privateIpv6(host);
  if (/^\d+(\.\d+){3}$/.test(host)) return !privateIpv4(host);
  if (/^[0-9a-f:]+$/.test(host) && host.includes(":"))
    return !privateIpv6(host);
  if (!host.includes(".")) return false;
  if (privateHostSuffixes.some((suffix) => host.endsWith(suffix))) return false;
  return true;
}

type Sanitized = { value: Record<string, unknown>; redactions: number };

function sanitizeInput(
  input: RegistryInput & {
    name?: string | undefined;
    variables?: Record<string, RegistryInput> | undefined;
  },
  allow: readonly string[],
): Sanitized {
  let redactions = 0;
  const out: Record<string, unknown> = {};
  const secret =
    input.isSecret === true ||
    (typeof input.name === "string" && sensitiveName.test(input.name));
  for (const key of allow) {
    const value = (input as Record<string, unknown>)[key];
    if (value === undefined || value === null) continue;
    if (
      secret &&
      (key === "value" || key === "default" || key === "placeholder")
    ) {
      if (typeof value === "string" && value.length > 0) redactions++;
      continue;
    }
    out[key] = value;
  }
  if (input.variables && allow.includes("variables")) {
    const variables: Record<string, unknown> = {};
    for (const [name, variable] of Object.entries(input.variables)) {
      const nested = sanitizeInput(variable, inputFields);
      variables[name] = nested.value;
      redactions += nested.redactions;
    }
    out.variables = variables;
  }
  return { value: out, redactions };
}

const inputFields = [
  "description",
  "isRequired",
  "isSecret",
  "format",
  "choices",
  "default",
  "placeholder",
  "value",
] as const;
const keyValueFields = ["name", ...inputFields, "variables"] as const;
const argumentFields = [
  "type",
  "name",
  "valueHint",
  "isRepeated",
  ...inputFields,
  "variables",
] as const;

function sanitizeTransport(transport: RegistryTransport): Sanitized {
  let redactions = 0;
  const out: Record<string, unknown> = { type: transport.type };
  if (transport.url !== undefined) out.url = transport.url;
  if (transport.headers) {
    out.headers = transport.headers.map((header) => {
      const sanitized = sanitizeInput(
        header as RegistryKeyValueInput,
        keyValueFields,
      );
      redactions += sanitized.redactions;
      return sanitized.value;
    });
  }
  if (transport.variables) {
    const variables: Record<string, unknown> = {};
    for (const [name, variable] of Object.entries(transport.variables)) {
      const sanitized = sanitizeInput(variable, inputFields);
      variables[name] = sanitized.value;
      redactions += sanitized.redactions;
    }
    out.variables = variables;
  }
  return { value: out, redactions };
}

function sanitizeArguments(
  args: RegistryArgument[] | null | undefined,
): Sanitized | undefined {
  if (!args) return undefined;
  let redactions = 0;
  const value = args.map((argument) => {
    const sanitized = sanitizeInput(argument, argumentFields);
    redactions += sanitized.redactions;
    return sanitized.value;
  });
  return { value: value as unknown as Record<string, unknown>, redactions };
}

function sanitizePackage(pkg: RegistryPackage): Sanitized {
  let redactions = 0;
  const out: Record<string, unknown> = {
    registryType: pkg.registryType,
    identifier: pkg.identifier,
  };
  for (const key of [
    "version",
    "registryBaseUrl",
    "runtimeHint",
    "fileSha256",
  ] as const)
    if (pkg[key] !== undefined) out[key] = pkg[key];
  const transport = sanitizeTransport(pkg.transport);
  out.transport = transport.value;
  redactions += transport.redactions;
  for (const key of ["runtimeArguments", "packageArguments"] as const) {
    const sanitized = sanitizeArguments(pkg[key]);
    if (sanitized) {
      out[key] = sanitized.value;
      redactions += sanitized.redactions;
    }
  }
  if (pkg.environmentVariables) {
    out.environmentVariables = pkg.environmentVariables.map((variable) => {
      const sanitized = sanitizeInput(variable, keyValueFields);
      redactions += sanitized.redactions;
      return sanitized.value;
    });
  }
  return { value: out, redactions };
}

/**
 * A positive-allowlist copy of a server.json fit for publication: known fields
 * only, descriptions clipped to the registry's limits, secret input values
 * removed. Reports every URL it would emit that must not leave the deployment.
 *
 * A private address can be spelled in more places than `remotes[].url`: a
 * package transport, a package registry base URL, a website, a repository or
 * an icon are all published verbatim, so each one is checked against the same
 * routability rule. The field keeps its name for compatibility; a non-empty
 * list means the entry is not publishable, whichever field named the network.
 */
export function publicServerJsonProjection(
  server: ServerJson,
  options: { includePublisherMeta?: boolean } = {},
): {
  server: Record<string, unknown>;
  redactions: number;
  privateRemoteUrls: string[];
} {
  let redactions = 0;
  const privateRemoteUrls: string[] = [];
  const checkUrl = (value: string | undefined): void => {
    if (value !== undefined && value !== "" && !isPubliclyRoutableUrl(value))
      privateRemoteUrls.push(value);
  };
  const out: Record<string, unknown> = {};
  if (server.$schema) out.$schema = server.$schema;
  out.name = server.name;
  out.description = server.description.slice(0, 100) || server.name;
  if (server.title) out.title = server.title.slice(0, 100);
  out.version = server.version;
  if (server.websiteUrl) {
    checkUrl(server.websiteUrl);
    out.websiteUrl = server.websiteUrl;
  }
  if (server.repository) {
    checkUrl(server.repository.url);
    const repository: Record<string, unknown> = {
      url: server.repository.url,
      source: server.repository.source,
    };
    if (server.repository.id) repository.id = server.repository.id;
    if (server.repository.subfolder)
      repository.subfolder = server.repository.subfolder;
    out.repository = repository;
  }
  if (server.icons)
    out.icons = server.icons.map((icon) => {
      checkUrl(icon.src);
      return {
        src: icon.src,
        ...(icon.mimeType ? { mimeType: icon.mimeType } : {}),
        ...(icon.sizes ? { sizes: icon.sizes } : {}),
        ...(icon.theme ? { theme: icon.theme } : {}),
      };
    });
  if (server.packages)
    out.packages = server.packages.map((pkg) => {
      checkUrl(pkg.transport.url);
      checkUrl(pkg.registryBaseUrl);
      const sanitized = sanitizePackage(pkg);
      redactions += sanitized.redactions;
      return sanitized.value;
    });
  if (server.remotes)
    out.remotes = server.remotes.map((remote) => {
      if (remote.url && !isPubliclyRoutableUrl(remote.url))
        privateRemoteUrls.push(remote.url);
      const sanitized = sanitizeTransport(remote);
      redactions += sanitized.redactions;
      return sanitized.value;
    });
  if (
    options.includePublisherMeta &&
    server._meta &&
    Object.hasOwn(server._meta, MCP_REGISTRY_PUBLISHER_META_KEY)
  )
    out._meta = {
      [MCP_REGISTRY_PUBLISHER_META_KEY]:
        server._meta[MCP_REGISTRY_PUBLISHER_META_KEY],
    };
  return { server: out, redactions, privateRemoteUrls };
}

function officialMeta(
  official: RegistryOfficialMeta | undefined,
): Record<string, unknown> | undefined {
  if (!official) return undefined;
  return {
    status: official.status,
    ...(official.publishedAt ? { publishedAt: official.publishedAt } : {}),
    ...(official.updatedAt ? { updatedAt: official.updatedAt } : {}),
    ...(official.statusChangedAt
      ? { statusChangedAt: official.statusChangedAt }
      : {}),
    ...(official.statusMessage
      ? { statusMessage: official.statusMessage }
      : {}),
    ...(official.isLatest === undefined ? {} : { isLatest: official.isLatest }),
  };
}

const querySchema = z.strictObject({
  cursor: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
  limit: z.number().int().min(1).max(100).optional(),
  search: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[^\p{Cc}]+$/u)
    .optional(),
  version: registryRequestVersionSchema.optional(),
  updated_since: isoDateTime.optional(),
  include_deleted: z.boolean().optional(),
});

const encodeCursor = (digest: string) =>
  Buffer.from(digest, "hex").toString("base64url");
const decodeCursor = (cursor: string) => {
  const digest = Buffer.from(cursor, "base64url").toString("hex");
  if (!/^[a-f0-9]{64}$/.test(digest) || encodeCursor(digest) !== cursor)
    throw new ConnectorError("invalid-request", {
      detail: "subregistry.cursor.invalid",
    });
  return digest;
};

type Visibility = (row: RegistryIndexRow) => string | undefined;

function surface(
  view: RegistrySnapshotView,
  options: {
    hidden: Visibility;
    deletedByDefault: boolean;
    render: (
      row: RegistryIndexRow,
      entry: RegistrySnapshotEntry,
    ) => { response: SubregistryServerResponse } | { excluded: string };
    maxLimit: number;
    defaultLimit: number;
  },
): SubregistryReadSurface {
  const filter = (
    rows: RegistryIndexRow[],
    query: z.infer<typeof querySchema>,
  ) => {
    const includeDeleted =
      query.include_deleted ??
      (query.updated_since !== undefined || options.deletedByDefault);
    const since = query.updated_since
      ? Date.parse(query.updated_since)
      : undefined;
    const search = query.search?.toLowerCase();
    return rows.filter((row) => {
      if (options.hidden(row)) return false;
      const deleted = row.status === "deleted" || row.tombstone !== undefined;
      if (deleted && !includeDeleted) return false;
      if (search && !row.name.toLowerCase().includes(search)) return false;
      if (query.version === "latest") {
        if (row.isLatest !== true) return false;
      } else if (query.version !== undefined && row.version !== query.version)
        return false;
      if (since !== undefined) {
        const updated = Date.parse(row.updatedAt ?? row.publishedAt ?? "");
        if (!Number.isFinite(updated) || updated < since) return false;
      }
      return true;
    });
  };
  const page = async (
    rows: RegistryIndexRow[],
    cursor: string | undefined,
    limit: number,
  ) => {
    let start = 0;
    if (cursor !== undefined) {
      const digest = decodeCursor(cursor);
      const index = rows.findIndex((row) => row.identityDigest === digest);
      if (index < 0)
        throw new ConnectorError("invalid-request", {
          detail: "subregistry.cursor.stale",
        });
      start = index + 1;
    }
    const servers: SubregistryServerResponse[] = [];
    const excluded: SubregistryExclusion[] = [];
    let last: RegistryIndexRow | undefined;
    let index = start;
    for (; index < rows.length && servers.length < limit; index++) {
      const row = rows[index]!;
      last = row;
      const entry = await view.entry(row.identityDigest);
      if (!entry) {
        excluded.push({
          identityDigest: row.identityDigest,
          reason: "content-missing",
        });
        continue;
      }
      const rendered = options.render(row, entry);
      if ("excluded" in rendered)
        excluded.push({
          identityDigest: row.identityDigest,
          reason: rendered.excluded,
        });
      else servers.push(rendered.response);
    }
    const more = index < rows.length;
    return {
      response: {
        servers,
        metadata: {
          count: servers.length,
          ...(more && last
            ? { nextCursor: encodeCursor(last.identityDigest) }
            : {}),
        },
      },
      excluded,
    };
  };
  return {
    async list(input = {}) {
      const query = querySchema.parse(input);
      const limit = Math.min(
        query.limit ?? options.defaultLimit,
        options.maxLimit,
      );
      return page(filter(view.rows, query), query.cursor, limit);
    },
    async versions(serverName, input = {}) {
      const name = registryServerNameSchema.parse(serverName);
      const query = querySchema.parse({
        ...(input.include_deleted === undefined
          ? {}
          : { include_deleted: input.include_deleted }),
      });
      const rows = filter(
        view.rows.filter((row) => row.name === name),
        query,
      );
      return page(rows, undefined, options.maxLimit);
    },
    async version(serverName, version, input = {}) {
      const name = registryServerNameSchema.parse(serverName);
      const requested = registryRequestVersionSchema.parse(version);
      const query = querySchema.parse({
        ...(input.include_deleted === undefined
          ? {}
          : { include_deleted: input.include_deleted }),
      });
      const candidates = filter(
        view.rows.filter((row) => row.name === name),
        query,
      );
      const row =
        requested === "latest"
          ? (candidates.filter((item) => item.isLatest === true).at(-1) ??
            candidates.filter((item) => !item.tombstone).at(-1))
          : candidates.find((item) => item.version === requested);
      if (!row) return undefined;
      const entry = await view.entry(row.identityDigest);
      if (!entry) return undefined;
      const rendered = options.render(row, entry);
      return "excluded" in rendered ? undefined : rendered.response;
    },
  };
}

/**
 * The public subregistry: only rows the policy marks public, only allowlisted
 * fields, no private networks, no secret values, no host provenance. Deleted
 * versions appear only with `include_deleted`, as in the official API; unlisted
 * tombstones never appear because nothing public was ever there.
 */
export function publicSubregistryProjection(
  view: RegistrySnapshotView,
  policy: SubregistryPolicy,
): SubregistryReadSurface {
  const marks = policy.public;
  const isPublic =
    typeof marks === "function"
      ? marks
      : (row: RegistryIndexRow) =>
          marks instanceof Set
            ? marks.has(row.identityDigest)
            : (marks as readonly string[]).includes(row.identityDigest);
  return surface(view, {
    hidden: (row) =>
      !isPublic(row)
        ? "not-public"
        : row.tombstone?.reason === "unlisted"
          ? "unlisted"
          : undefined,
    deletedByDefault: false,
    maxLimit: policy.maxLimit ?? 100,
    defaultLimit: 30,
    render: (row, entry) => {
      const projected = publicServerJsonProjection(entry.server, {
        includePublisherMeta: policy.includePublisherMeta === true,
      });
      if (projected.privateRemoteUrls.length)
        return { excluded: "private-remote-url" };
      const official = officialMeta(entry.official);
      return {
        response: {
          server: projected.server,
          _meta: {
            ...(official ? { [MCP_REGISTRY_OFFICIAL_META_KEY]: official } : {}),
          },
        },
      };
    },
  });
}

/**
 * The private catalog for the tenant that owns the snapshot: every entry,
 * including private sources, tombstones and deprecations, with Ceremony's
 * snapshot provenance. Secret values are still never shown; a reviewer who
 * needs the raw document reads the protected content record.
 */
export function privateCatalogProjection(
  view: RegistrySnapshotView,
  actor: ActorContext,
  options: { maxLimit?: number } = {},
): SubregistryReadSurface {
  if (
    !actor ||
    typeof actor.tenantId !== "string" ||
    actor.tenantId !== view.tenantId ||
    typeof actor.subjectId !== "string" ||
    !actor.subjectId
  )
    throw new ConnectorError("denied", {
      detail: "subregistry.tenant-mismatch",
    });
  return surface(view, {
    hidden: () => undefined,
    deletedByDefault: true,
    maxLimit: options.maxLimit ?? 100,
    defaultLimit: 30,
    render: (row, entry) => {
      const projected = publicServerJsonProjection(entry.server, {
        includePublisherMeta: true,
      });
      const official = officialMeta(entry.official);
      return {
        response: {
          server: projected.server,
          _meta: {
            ...(official ? { [MCP_REGISTRY_OFFICIAL_META_KEY]: official } : {}),
            ...entry.meta,
            [CEREMONY_SNAPSHOT_META_KEY]: {
              sourceId: view.sourceId,
              identityDigest: row.identityDigest,
              status: row.status,
              ...(row.tombstone ? { tombstone: row.tombstone } : {}),
              ...(row.deprecation ? { deprecation: row.deprecation } : {}),
              pinned: Object.hasOwn(view.pins, row.identityDigest),
              firstSeenAt: row.firstSeenAt,
              lastSeenAt: row.lastSeenAt,
              redactions: projected.redactions,
              freshness: {
                stale: view.freshness.stale,
                ...(view.freshness.lastSuccessfulRefreshAt
                  ? {
                      lastSuccessfulRefreshAt:
                        view.freshness.lastSuccessfulRefreshAt,
                    }
                  : {}),
              },
            },
          },
        },
      };
    },
  });
}

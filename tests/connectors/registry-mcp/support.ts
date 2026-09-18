import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RuntimeBinding } from "../../../src/server/connectors/binding.js";
import { runtimeBindingSchema } from "../../../src/server/connectors/binding.js";
import { registryEntry, type DoubleEntry } from "../doubles/mcp-registry.js";

export const fixturesDir = new URL(
  "../fixtures/mcp-registry/",
  import.meta.url,
);

export function loadServer(name: string): DoubleEntry["server"] {
  return JSON.parse(
    readFileSync(new URL(`servers/${name}.json`, fixturesDir), "utf8"),
  ) as DoubleEntry["server"];
}

export function loadServerBytes(name: string): Uint8Array {
  return new Uint8Array(
    readFileSync(new URL(`servers/${name}.json`, fixturesDir)),
  );
}

export const pinnedSchema = JSON.parse(
  readFileSync(new URL("server.schema.2025-12-11.json", fixturesDir), "utf8"),
) as {
  definitions: Record<
    string,
    {
      required?: string[];
      properties?: Record<string, { pattern?: string; maxLength?: number }>;
    }
  >;
};

/** Facts from the pinned JSON schema, applied without a schema library: required fields, name pattern, length limits. */
export function assertMatchesPinnedServerDetail(
  server: Record<string, unknown>,
): void {
  const detail = pinnedSchema.definitions["ServerDetail"]!;
  for (const field of detail.required ?? [])
    if (!(field in server)) throw new Error(`pinned schema requires ${field}`);
  const props = detail.properties ?? {};
  const name = server["name"];
  if (
    typeof name !== "string" ||
    !new RegExp(props["name"]!.pattern!).test(name)
  )
    throw new Error("name violates the pinned pattern");
  for (const field of ["description", "title", "name", "version"] as const) {
    const value = server[field];
    const max = props[field]?.maxLength;
    if (typeof value === "string" && max !== undefined && value.length > max)
      throw new Error(`${field} exceeds pinned maxLength ${max}`);
  }
  const remotes = server["remotes"];
  if (remotes !== undefined) {
    if (!Array.isArray(remotes)) throw new Error("remotes must be an array");
    for (const remote of remotes as Array<Record<string, unknown>>) {
      if (!["streamable-http", "sse"].includes(remote["type"] as string))
        throw new Error("remote type outside RemoteTransport");
      if (
        typeof remote["url"] !== "string" ||
        !/^https?:\/\/[^\s]+$/.test(remote["url"])
      )
        throw new Error("remote url violates the pinned pattern");
    }
  }
}

/** A sample listing: seven servers in name order, one with two versions. */
export function sampleEntries(): DoubleEntry[] {
  const names = [
    "com.example/alpha",
    "com.example/beta",
    "io.github.a/b",
    "io.github.c/d",
    "io.github.e/f",
    "io.modelcontextprotocol.anonymous/hybrid-mcp",
  ];
  const entries = names.map((name, index) =>
    registryEntry(
      {
        $schema:
          "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
        name,
        description: `Sample server ${index + 1}`,
        version: index === 2 ? "1.0.0-rc.1" : "1.0.0",
        remotes: [
          {
            type: "streamable-http",
            url: `https://${name.replace("/", ".")}.example.com/mcp`,
          },
        ],
      },
      { publishedAt: `2026-01-0${index + 1}T00:00:00Z` },
    ),
  );
  entries.splice(
    3,
    0,
    registryEntry(
      {
        $schema:
          "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
        name: "io.github.a/b",
        description: "Sample server 3, second version",
        version: "1.0.0",
        remotes: [
          {
            type: "streamable-http",
            url: "https://io.github.a.b.example.com/mcp",
          },
        ],
      },
      { publishedAt: "2026-01-03T12:00:00Z" },
    ),
  );
  entries[2]!._meta["io.modelcontextprotocol.registry/official"].isLatest =
    false;
  return entries;
}

export const keyring = { current: "k1", keys: { k1: randomBytes(32) } };

export function registryBinding(
  origin: string,
  options: {
    destinationId?: string;
    tenantId?: string;
    settings?: Record<string, unknown>;
    extraDestinations?: RuntimeBinding["destinations"];
  } = {},
): RuntimeBinding {
  const destinationId = options.destinationId ?? "registry-fixture";
  return runtimeBindingSchema.parse({
    bindingRef: "binding:registry-fixture",
    definitionRef: "def:registry-source",
    revision: 1,
    adapterId: "mcp-registry",
    adapterVersion: "1.0.0",
    runtime: "hosted-server",
    custody: "no-credential",
    authorityInstance: origin,
    status: "approved",
    approvedAt: "2026-09-18T00:00:00Z",
    policyRevision: "policy-1",
    tenantId: options.tenantId ?? "tenant-a",
    destinations: [
      { id: destinationId, origin, network: "loopback-fixture" },
      ...(options.extraDestinations ?? []),
    ],
    operations: [],
    configuration: [],
    permittedTargets: [],
    reviewedDigest: "a".repeat(64),
    settings: options.settings ?? {},
  });
}

export function mcpBinding(
  definitionRef: string,
  options: {
    origin?: string;
    pathPrefix?: string;
    network?: "public" | "loopback-fixture" | "approved-private";
    runtime?: "hosted-server" | "browser" | "trusted-local-runner";
    status?: "approved" | "suspended" | "retired";
    tenantId?: string;
    httpOnly?: boolean;
  } = {},
): RuntimeBinding {
  const origin = options.origin ?? "https://mcp.example.com";
  return runtimeBindingSchema.parse({
    bindingRef: "binding:mcp-hosted",
    definitionRef,
    revision: 3,
    adapterId: "mcp-runtime",
    adapterVersion: "1.0.0",
    runtime: options.runtime ?? "hosted-server",
    custody: "host-owned",
    authorityInstance: origin,
    status: options.status ?? "approved",
    approvedAt: "2026-09-18T00:00:00Z",
    policyRevision: "policy-7",
    tenantId: options.tenantId ?? "tenant-a",
    destinations: [
      {
        id: "mcp",
        origin,
        ...(options.pathPrefix ? { pathPrefix: options.pathPrefix } : {}),
        network: options.network ?? "public",
      },
    ],
    operations: [
      options.httpOnly
        ? {
            operationRef: "op:http",
            nativeId: "GET /status",
            destinationId: "mcp",
            transport: { kind: "http", method: "GET", pathTemplate: "/status" },
            effect: "read",
            outputClassification: "public",
            cost: "free",
            consent: "none",
            replay: "read-only",
            targetParameters: [],
          }
        : {
            operationRef: "op:tools",
            nativeId: "tools/call:echo",
            destinationId: "mcp",
            transport: { kind: "mcp-tool", toolName: "echo" },
            effect: "unknown",
            outputClassification: "personal",
            cost: "unknown",
            consent: "confirm",
            replay: "none",
            targetParameters: [],
          },
    ],
    configuration: [],
    permittedTargets: [],
    reviewedDigest: "b".repeat(64),
    settings: {},
  });
}

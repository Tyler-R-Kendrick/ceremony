import { createHash } from "node:crypto";
import { z } from "zod";
import {
  normalizedDefinitionSchema,
  type CompatibilityIssue,
  type NormalizedDefinition,
} from "../../../../core/connectors/contracts.js";
import {
  evidenceLevelSchema,
  evidenceLevels,
  runtimeClassSchema,
} from "../../../../core/connectors/identity.js";
import type { ActorContext } from "../../../../core/operation-contracts.js";
import {
  destinationFor,
  runtimeBindingSchema,
  type RuntimeBinding,
} from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import type { EffectJournalPort } from "../../ports.js";
import type { McpRegistryClient, RegistryEntry } from "./client.js";
import { MCP_PACKAGE_EXTENSION } from "./import.js";
import { isPubliclyRoutableUrl } from "./projections.js";
import {
  MCP_REGISTRY_PUBLISHER_META_KEY,
  SERVER_JSON_SCHEMA_URL,
  registryServerNameSchema,
  registryVersionSchema,
  serverJsonExportSchema,
  type ServerJsonExport,
} from "./schemas.js";

/*
 * Export of a `server.json` for something this deployment actually serves. A
 * description alone is not exportable: the input is a reviewed, approved MCP
 * binding plus the host's evidence of the endpoint it serves, and the output
 * describes that endpoint and nothing else. Packages are never exported
 * because nothing here ever ran them; a browser-only connector has no headless
 * runtime to advertise; and nothing leaves without an explicit publication
 * authorization. The document is validated against the pinned strict shape
 * before its bytes exist.
 */

const evidenceRank = (level: (typeof evidenceLevels)[number]) =>
  evidenceLevels.indexOf(level);

export const servedEndpointSchema = z.strictObject({
  url: z
    .string()
    .max(2048)
    .regex(/^https?:\/\/[^\s]+$/),
  transport: z.enum(["streamable-http", "sse"]),
  runtime: runtimeClassSchema,
  evidence: evidenceLevelSchema,
  observedAt: z.iso.datetime({ offset: true }),
});
export const implementationEvidenceSchema = z.strictObject({
  servedEndpoints: z.array(servedEndpointSchema).max(32),
});
export type ImplementationEvidence = z.infer<typeof implementationEvidenceSchema>;

const safeText = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[^\p{Cc}]*$/u);
export const publicationRequestSchema = z.strictObject({
  /** Explicit human authorization for a document to leave the deployment. */
  authorized: z.boolean(),
  name: registryServerNameSchema,
  version: registryVersionSchema.optional(),
  title: safeText(100).min(1).optional(),
  description: safeText(100).min(1).optional(),
  websiteUrl: z
    .string()
    .max(2048)
    .regex(/^https:\/\/[^\s]+$/)
    .optional(),
  repository: z
    .strictObject({
      url: z
        .string()
        .max(2048)
        .regex(/^https:\/\/[^\s]+$/),
      source: safeText(64).min(1),
      id: safeText(256).optional(),
      subfolder: safeText(1024).optional(),
    })
    .optional(),
  /** Header inputs the hosted endpoint requires; names and flags only, never values. */
  headers: z
    .array(
      z.strictObject({
        name: safeText(256).min(1),
        description: safeText(500).optional(),
        isRequired: z.boolean().optional(),
        isSecret: z.boolean().optional(),
      }),
    )
    .max(32)
    .optional(),
  publisherMeta: z
    .record(safeText(120).min(1), z.unknown())
    .refine((value) => Object.keys(value).length <= 16)
    .optional(),
  target: z.strictObject({
    sourceId: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.:-]{0,95}$/),
    network: z.enum(["public", "approved-private", "loopback-fixture"]),
  }),
});
export type PublicationRequest = z.infer<typeof publicationRequestSchema>;

export type ServerJsonExportResult = {
  document: ServerJsonExport;
  bytes: Uint8Array;
  mediaType: "application/json";
  losses: CompatibilityIssue[];
  /** The served endpoints the document advertises, exactly as evidenced. */
  endpoints: string[];
};

function loss(
  code: string,
  pointer: string,
  message: string,
  overrides: Partial<CompatibilityIssue> = {},
): CompatibilityIssue {
  return {
    code,
    category: "structure",
    sourcePointer: pointer,
    dimension: "export",
    disposition: "unsupported",
    severity: "info",
    executionImpact: "none",
    message,
    ...overrides,
  };
}

const MIN_EVIDENCE = evidenceRank("local-integration");

/**
 * Builds the document for an approved hosted MCP binding. Every refusal is a
 * sanitized code; nothing about the binding or the evidence is echoed.
 */
export function exportServerJson(input: {
  definition: NormalizedDefinition;
  binding: RuntimeBinding;
  implementationEvidence: ImplementationEvidence;
  publication: PublicationRequest;
  now?: () => number;
}): ServerJsonExportResult {
  const publication = publicationRequestSchema.parse(input.publication);
  if (publication.authorized !== true)
    throw new ConnectorError("denied", { detail: "export.publication-unauthorized" });
  const definition = normalizedDefinitionSchema.parse(input.definition);
  const binding = runtimeBindingSchema.parse(input.binding);
  const evidence = implementationEvidenceSchema.parse(input.implementationEvidence);
  if (binding.status !== "approved")
    throw new ConnectorError("denied", { detail: "export.binding-not-approved" });
  if (binding.definitionRef !== definition.definitionRef)
    throw new ConnectorError("invalid-request", {
      detail: "export.binding-definition-mismatch",
    });
  if (binding.runtime !== "hosted-server")
    throw new ConnectorError("unsupported", { detail: "export.browser-only" });
  const mcpOperations = binding.operations.filter((operation) =>
    operation.transport.kind.startsWith("mcp-"),
  );
  if (!mcpOperations.length)
    throw new ConnectorError("unsupported", { detail: "export.binding-not-mcp" });
  const destinationIds = [...new Set(mcpOperations.map((operation) => operation.destinationId))];
  const endpoints: Array<{ url: string; transport: "streamable-http" | "sse" }> = [];
  for (const destinationId of destinationIds) {
    const operation = mcpOperations.find((item) => item.destinationId === destinationId)!;
    const destination = destinationFor(binding, operation);
    const served = evidence.servedEndpoints.filter((endpoint) => {
      const url = new URL(endpoint.url);
      return (
        url.origin === destination.origin &&
        (destination.pathPrefix === undefined ||
          url.pathname === destination.pathPrefix ||
          url.pathname.startsWith(
            destination.pathPrefix.endsWith("/")
              ? destination.pathPrefix
              : `${destination.pathPrefix}/`,
          ))
      );
    });
    if (!served.length)
      throw new ConnectorError("unsupported", { detail: "export.endpoint-not-served" });
    for (const endpoint of served) {
      if (endpoint.runtime !== "hosted-server")
        throw new ConnectorError("unsupported", { detail: "export.browser-only" });
      if (evidenceRank(endpoint.evidence) < MIN_EVIDENCE)
        throw new ConnectorError("unsupported", { detail: "export.endpoint-unverified" });
      if (publication.target.network === "public" && !isPubliclyRoutableUrl(endpoint.url))
        throw new ConnectorError("denied", { detail: "export.private-endpoint" });
      if (!endpoints.some((item) => item.url === endpoint.url))
        endpoints.push({ url: endpoint.url, transport: endpoint.transport });
    }
  }
  if (endpoints.length > 8)
    throw new ConnectorError("invalid-request", { detail: "export.too-many-endpoints" });

  const losses: CompatibilityIssue[] = [];
  const packages = definition.capabilities.filter(
    (capability) =>
      capability.nativeExtensions !== undefined &&
      Object.hasOwn(capability.nativeExtensions, MCP_PACKAGE_EXTENSION),
  );
  if (packages.length)
    losses.push(
      loss(
        "executable-code.package-omitted",
        "capabilities",
        `${packages.length} package description(s) were not exported because this deployment never ran them`,
        { category: "executable-code" },
      ),
    );
  const truncated =
    definition.display.description.length > 100
      ? definition.display.description.slice(0, 100)
      : definition.display.description;
  const description =
    publication.description ?? (truncated || definition.display.name.slice(0, 100));
  if (!publication.description && definition.display.description.length > 100)
    losses.push(
      loss(
        "structure.description-truncated",
        "display.description",
        "Description was truncated to the 100 characters the registry schema allows",
        { disposition: "adapted", severity: "warning" },
      ),
    );
  const title = publication.title ?? definition.display.name.slice(0, 100);
  const version = publication.version ?? definition.identity.nativeVersion;
  if (!registryVersionSchema.safeParse(version).success || version.length > 255)
    throw new ConnectorError("invalid-request", { detail: "export.version.invalid" });
  const headers = publication.headers?.map((header) => ({
    name: header.name,
    ...(header.description ? { description: header.description } : {}),
    ...(header.isRequired === undefined ? {} : { isRequired: header.isRequired }),
    ...(header.isSecret === undefined ? {} : { isSecret: header.isSecret }),
  }));
  const exportedAt = new Date((input.now ?? Date.now)()).toISOString();
  const candidate = {
    $schema: SERVER_JSON_SCHEMA_URL,
    name: publication.name,
    description,
    ...(title ? { title } : {}),
    version,
    ...(publication.websiteUrl ? { websiteUrl: publication.websiteUrl } : {}),
    ...(publication.repository ? { repository: publication.repository } : {}),
    remotes: endpoints.map((endpoint) => ({
      type: endpoint.transport,
      url: endpoint.url,
      ...(headers && headers.length ? { headers } : {}),
    })),
    _meta: {
      [MCP_REGISTRY_PUBLISHER_META_KEY]: {
        ...(publication.publisherMeta ?? {}),
        ceremony: {
          exporter: "mcp-registry-server-json/1.0.0",
          normalizedDigest: definition.normalizedDigest,
          bindingRevision: binding.revision,
          exportedAt,
        },
      },
    },
  };
  const document = serverJsonExportSchema.parse(candidate);
  const text = JSON.stringify(document, null, 2);
  return {
    document,
    bytes: new TextEncoder().encode(text),
    mediaType: "application/json",
    losses,
    endpoints: endpoints.map((endpoint) => endpoint.url),
  };
}

/**
 * Publishes an exported document to a configured registry. The client must
 * have publication enabled for its source, the call must carry the explicit
 * authorization, and the consequential call is journaled when an effect
 * journal is supplied so a retry cannot publish twice blindly.
 */
export async function publishServerJson(input: {
  client: Pick<McpRegistryClient, "publish" | "baseUrl">;
  document: ServerJsonExport;
  publication: { authorized: boolean };
  effects?: EffectJournalPort;
  actor?: ActorContext;
  signal?: AbortSignal;
}): Promise<{ entry: RegistryEntry; effectRef?: string }> {
  if (input.publication.authorized !== true)
    throw new ConnectorError("denied", { detail: "export.publication-unauthorized" });
  const document = serverJsonExportSchema.parse(input.document);
  let effectRef: string | undefined;
  if (input.effects) {
    if (!input.actor)
      throw new ConnectorError("unauthenticated", { detail: "export.actor-required" });
    const digest = createHash("sha256")
      .update(`${input.client.baseUrl}\n${JSON.stringify(document)}`)
      .digest("hex");
    const begun = await input.effects.begin({
      actor: input.actor,
      operation: "mcp-registry.publish",
      digest,
    });
    if (begun.prior && begun.prior.status !== "failed" && begun.prior.status !== "not-applied")
      throw new ConnectorError("indeterminate", { detail: "export.publish.repeated" });
    effectRef = begun.effectRef;
  }
  try {
    const entry = await input.client.publish(document, {
      authorized: true,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (effectRef && input.effects)
      await input.effects.complete(effectRef, { status: "applied", at: Date.now() });
    return { entry, ...(effectRef ? { effectRef } : {}) };
  } catch (error) {
    if (effectRef && input.effects) {
      const code = error instanceof ConnectorError ? error.code : "upstream-unavailable";
      await input.effects.complete(effectRef, {
        status:
          code === "upstream-unavailable" || code === "indeterminate" || code === "cancelled"
            ? "indeterminate"
            : "failed",
        code,
        at: Date.now(),
      });
    }
    throw error;
  }
}

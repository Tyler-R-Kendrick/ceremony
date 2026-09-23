import { z } from "zod";
import type { CeremonyTool } from "./webmcp.js";
import { flowKinds } from "./schema.js";

const humanSchema = z
  .object({
    mode: z.enum(["elicit", "a2h-authorize", "private-collector"]),
    reason: z.enum([
      "openapi-url",
      "provider-name",
      "origin-url",
      "provider-consent",
      "private-credentials",
      "owner-setup",
    ]),
    title: z.string().min(1).max(120),
    body: z.string().min(1).max(500),
    recipient: z.enum(["initiating-subject", "authorized-owner"]).optional(),
    fields: z
      .array(
        z.object({
          name: z.string().min(1).max(40),
          label: z.string().min(1).max(80),
          type: z.enum(["url", "text"]),
        }),
      )
      .max(4)
      .optional(),
  })
  .nullable();
const draftSummary = z.object({
  id: z.string().min(1).max(120),
  revision: z.number().int().positive(),
  provider: z.string().min(1).max(100),
  methods: z.array(z.enum(flowKinds)).max(12),
  executable: z.boolean(),
  outline: z.array(z.string().max(200)).max(12).optional(),
  connectorId: z.string().min(1).max(64).optional(),
});
/**
 * What a model may read of an authoring result: a positive allowlist. Fields
 * the service reports beyond it (userinfo, revocation, PKCE detail, a route's
 * bookkeeping) are dropped rather than refused, so a richer discovery report
 * narrows the answer instead of turning a successful draft into a failure.
 */
export const authoringResultSchema = z.object({
  ok: z.boolean(),
  resolution: z
    .object({
      query: z.string().max(100),
      resolved: z.string().max(100),
      confidence: z.enum(["high", "low"]),
      alternatives: z.array(z.string().max(64)).max(4),
    })
    .optional(),
  discovery: z
    .object({
      origin: z.string().max(200),
      assumed: z.boolean(),
      candidates: z.array(z.string().max(200)).max(8),
      documents: z.array(z.string().max(200)).max(16),
      methods: z.array(z.enum(flowKinds)).max(12),
      grantTypes: z.array(z.string().max(80)).max(16),
      extra: z.array(z.string().max(80)).max(8),
      searchUsed: z.boolean(),
      authorizationEndpoint: z.string().max(300).optional(),
      tokenEndpoint: z.string().max(300).optional(),
      deviceAuthorizationEndpoint: z.string().max(300).optional(),
      registrationEndpoint: z.string().max(300).optional(),
      issuer: z.string().max(300).optional(),
      clientId: z.string().max(2048).optional(),
      scopes: z.array(z.string().max(80)).max(16).optional(),
      clientIdMetadataDocumentSupported: z.boolean().optional(),
      dpopRequired: z.boolean().optional(),
      dpopSigningAlgorithms: z
        .array(z.string().min(1).max(32))
        .max(32)
        .optional(),
    })
    .optional(),
  draft: draftSummary.optional(),
  human: humanSchema,
  error: z.string().max(200).optional(),
});
export type AuthoringResult = z.infer<typeof authoringResultSchema>;
export type AuthoringHuman = z.infer<typeof humanSchema>;

export interface AuthoringTransport {
  fromProvider(input: {
    provider: string;
    origin?: string;
    openApiUrl?: string;
    intent?: "draft" | "complete" | "run";
  }): Promise<AuthoringResult>;
  compose(input: {
    draftId: string;
    revision: number;
    childIds: string[];
  }): Promise<AuthoringResult>;
  read(draftId: string): Promise<AuthoringResult>;
  delete?(input: { connectorId: string; runId?: string }): Promise<{
    ok: boolean;
    human: null;
  }>;
}

/**
 * The authoring actions, defined once. Native WebMCP and the MCP endpoint
 * both register from this list, so a schema or description cannot drift
 * between the transports. Credentials are never tool arguments.
 */
export const authoringToolDefinitions = [
  {
    action: "from-provider",
    schema: z.strictObject({
      provider: z.string().min(1).max(100),
      origin: z.string().url().max(200).optional(),
      openApiUrl: z.string().url().max(500).optional(),
      intent: z.enum(["draft", "complete", "run"]).default("draft"),
    }),
    description:
      "Draft a connector ceremony for a named provider. Corrects high-confidence misspellings, crawls well-known auth documents, and may search if official APIs are unpublished. Does not collect credentials. Human participation is elicitation or A2H only when a name/origin cannot be resolved or consent/private credentials are required.",
  },
  {
    action: "compose",
    schema: z.strictObject({
      draftId: z.string().min(1).max(120),
      revision: z.number().int().positive(),
      childIds: z.array(z.string().min(1).max(64)).min(2).max(12),
    }),
    description:
      "Compose selected ceremonies in an authored draft into a parent with prerequisites. Does not execute providers.",
  },
  {
    action: "read",
    schema: z.strictObject({ draftId: z.string().min(1).max(120) }),
    description: "Read an authored connector draft without executing it.",
  },
  {
    action: "delete",
    schema: z.strictObject({
      connectorId: z.string().min(1).max(64),
      runId: z.string().min(1).max(120).optional(),
    }),
    description:
      "Delete a local authored connection and stored credentials. Does not delete the person's provider account.",
  },
] as const;
export type AuthoringToolDefinition = (typeof authoringToolDefinitions)[number];

export function authoringToolName(
  prefix: string,
  definition: AuthoringToolDefinition,
): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(prefix))
    throw new Error("Invalid tool prefix");
  return `${prefix}_${definition.action.replaceAll("-", "_")}`;
}

/**
 * One authoring action against a transport, with its result projected onto
 * the allowlist. Failures propagate: each transport decides how to refuse.
 */
export async function runAuthoringTool(
  definition: AuthoringToolDefinition,
  transport: AuthoringTransport,
  input: unknown,
): Promise<AuthoringResult> {
  if (definition.action === "from-provider") {
    const parsed = definition.schema.parse(input);
    return authoringResultSchema.parse(
      await transport.fromProvider({
        provider: parsed.provider,
        ...(parsed.origin ? { origin: parsed.origin } : {}),
        ...(parsed.openApiUrl ? { openApiUrl: parsed.openApiUrl } : {}),
        intent: parsed.intent,
      }),
    );
  }
  if (definition.action === "compose") {
    const parsed = definition.schema.parse(input);
    return authoringResultSchema.parse(await transport.compose(parsed));
  }
  if (definition.action === "delete") {
    const parsed = definition.schema.parse(input);
    if (!transport.delete) throw new Error("denied-or-unavailable");
    return authoringResultSchema.parse(
      await transport.delete({
        connectorId: parsed.connectorId,
        ...(parsed.runId ? { runId: parsed.runId } : {}),
      }),
    );
  }
  const parsed = definition.schema.parse(input);
  return authoringResultSchema.parse(await transport.read(parsed.draftId));
}

/** Same definitions for native WebMCP and HTTP agents. Credentials are never tool arguments. */
export function createAuthoringTools(
  prefix: string,
  transport: AuthoringTransport,
): CeremonyTool[] {
  return authoringToolDefinitions.map((definition) => ({
    name: authoringToolName(prefix, definition),
    description: definition.description,
    inputSchema: z.toJSONSchema(definition.schema),
    annotations: {
      readOnlyHint: definition.action === "read",
      consequentialHint: definition.action !== "read",
      untrustedContentHint: false,
    },
    execute: async (input, options) => {
      try {
        options?.signal.throwIfAborted();
        return await runAuthoringTool(definition, transport, input);
      } catch {
        return {
          ok: false,
          human: null,
          error: "denied-or-unavailable",
        };
      }
    },
  }));
}

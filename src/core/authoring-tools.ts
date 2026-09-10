import { z } from "zod";
import type { CeremonyTool } from "./webmcp.js";
import { flowKinds } from "./schema.js";

const humanSchema = z
  .strictObject({
    mode: z.enum(["elicit", "a2h-authorize", "private-collector"]),
    reason: z.enum([
      "openapi-url",
      "provider-consent",
      "private-credentials",
      "owner-setup",
    ]),
    title: z.string().min(1).max(120),
    body: z.string().min(1).max(500),
    recipient: z.enum(["initiating-subject", "authorized-owner"]).optional(),
    fields: z
      .array(
        z.strictObject({
          name: z.string().min(1).max(40),
          label: z.string().min(1).max(80),
          type: z.enum(["url", "text"]),
        }),
      )
      .max(4)
      .optional(),
  })
  .nullable();
const draftSummary = z.strictObject({
  id: z.string().min(1).max(120),
  revision: z.number().int().positive(),
  provider: z.string().min(1).max(100),
  methods: z.array(z.enum(flowKinds)).max(12),
  executable: z.boolean(),
});
export const authoringResultSchema = z.strictObject({
  ok: z.boolean(),
  draft: draftSummary.optional(),
  human: humanSchema,
  error: z.string().max(200).optional(),
});
export type AuthoringResult = z.infer<typeof authoringResultSchema>;
export type AuthoringHuman = z.infer<typeof humanSchema>;

export interface AuthoringTransport {
  fromProvider(input: {
    provider: string;
    openApiUrl?: string;
    intent?: "draft" | "complete" | "run";
  }): Promise<AuthoringResult>;
  compose(input: {
    draftId: string;
    revision: number;
    childIds: string[];
  }): Promise<AuthoringResult>;
  read(draftId: string): Promise<AuthoringResult>;
}

/** Same definitions for native WebMCP and HTTP agents. Credentials are never tool arguments. */
export function createAuthoringTools(
  prefix: string,
  transport: AuthoringTransport,
): CeremonyTool[] {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(prefix))
    throw new Error("Invalid tool prefix");
  const definitions = [
    {
      action: "from-provider",
      schema: z.strictObject({
        provider: z.string().min(1).max(100),
        openApiUrl: z.string().url().max(500).optional(),
        intent: z.enum(["draft", "complete", "run"]).default("draft"),
      }),
      description:
        "Draft a connector ceremony for a named provider using generic auth-family templates. Does not fetch the provider, collect credentials, or install an adapter. Human participation is returned only when consent or private credentials are required to run.",
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
  ] as const;
  return definitions.map((definition) => ({
    name: `${prefix}_${definition.action.replaceAll("-", "_")}`,
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
        if (definition.action === "from-provider") {
          const parsed = definition.schema.parse(input);
          return authoringResultSchema.parse(
            await transport.fromProvider({
              provider: parsed.provider,
              ...(parsed.openApiUrl ? { openApiUrl: parsed.openApiUrl } : {}),
              intent: parsed.intent,
            }),
          );
        }
        if (definition.action === "compose") {
          const parsed = definition.schema.parse(input);
          return authoringResultSchema.parse(await transport.compose(parsed));
        }
        const parsed = definition.schema.parse(input);
        return authoringResultSchema.parse(
          await transport.read(parsed.draftId),
        );
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

import { z } from "zod";
import {
  actionNames,
  type CeremonySnapshot,
  type ConnectorManifest,
} from "./schema.js";

export const commandSchema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("start"), methodId: z.string().optional() })
    .strict(),
  z.object({ action: z.literal("read") }).strict(),
  z.object({ action: z.literal("navigate") }).strict(),
  z.object({ action: z.literal("request-input") }).strict(),
  z
    .object({
      action: z.enum(actionNames),
      values: z.record(z.string(), z.string().max(4096)).optional(),
      secretRef: z.uuid().optional(),
    })
    .strict(),
]);
export type CeremonyCommand = z.infer<typeof commandSchema>;
export interface CeremonyTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    consequentialHint: boolean;
    untrustedContentHint: boolean;
  };
  execute(input: unknown, options: { signal: AbortSignal }): Promise<unknown>;
}
/** Current experimental document.modelContext registration surface. */
export interface CeremonyModelContext {
  registerTool(
    tool: CeremonyTool,
    options: { signal: AbortSignal },
  ): Promise<void>;
}
export function browserModelContext(): CeremonyModelContext | undefined {
  return typeof document === "undefined"
    ? undefined
    : (document as Document & { modelContext?: CeremonyModelContext })
        .modelContext;
}
export function toolState(
  manifest: ConnectorManifest,
  snapshot?: CeremonySnapshot,
) {
  return {
    connectorId: manifest.id,
    methods: manifest.methods.map(({ id, label, kind, scopes }) => ({
      id,
      label,
      kind,
      scopes,
    })),
    ...(snapshot
      ? {
          instanceId: snapshot.id,
          revision: snapshot.revision,
          step: snapshot.step,
          methodId: snapshot.method.id,
          fields: snapshot.fields,
          ...(snapshot.prerequisites
            ? { prerequisites: snapshot.prerequisites }
            : {}),
          actions: [
            ...snapshot.actions,
            ...(snapshot.fields.length && snapshot.actions.includes("submit")
              ? ["request-input"]
              : []),
            ...((snapshot.step === "redirect" && snapshot.authorizationUrl) ||
            (snapshot.step === "waiting" && snapshot.verificationUri)
              ? ["navigate"]
              : []),
          ],
          ...(snapshot.userCode ? { userCode: snapshot.userCode } : {}),
          ...(snapshot.outcome
            ? {
                ownership: snapshot.outcome.ownership,
                scopes: snapshot.outcome.scopes,
              }
            : {}),
        }
      : { actions: ["start"] }),
  };
}

/** One registration lifetime per mounted ceremony, no state-dependent re-registration races. */
export async function registerCeremonyTools(
  modelContext: CeremonyModelContext,
  prefix: string,
  manifest: ConnectorManifest,
  invoke: (
    command: CeremonyCommand,
    signal: AbortSignal,
  ) => Promise<CeremonySnapshot | undefined>,
  signal: AbortSignal,
) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(prefix))
    throw new Error("Invalid WebMCP tool prefix");
  for (const action of [
    "start",
    "read",
    ...actionNames,
    "navigate",
    "request-input",
  ] as const) {
    if (signal.aborted) return;
    await modelContext.registerTool(
      {
        name: `${prefix}_${action}`,
        description: `${action} the ${manifest.name} authentication ceremony. Read current state first; only invoke allowed actions with the user's authorization. ${action === "navigate" ? "Opens the trusted provider page; provider approval is a separate action outside this ceremony." : ""}`,
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties:
            action === "start"
              ? {
                  methodId: {
                    type: "string",
                    enum: manifest.methods.map((method) => method.id),
                  },
                }
              : action === "submit"
                ? {
                    values: {
                      type: "object",
                      additionalProperties: { type: "string", maxLength: 4096 },
                      description:
                        "Public choices only. Never provide passwords, API keys or other secrets. A human must enter credentials in the private collector; submit only its secretRef.",
                    },
                    secretRef: {
                      type: "string",
                      format: "uuid",
                      description:
                        "One-use reference from private collection, bound to this run and revision.",
                    },
                  }
                : {},
          required: [],
        },
        // read may poll and persist provider approval; it is not side-effect free.
        annotations: {
          readOnlyHint: false,
          consequentialHint: action !== "read",
          untrustedContentHint: true,
        },
        execute: async (input, options) => {
          try {
            if (
              !input ||
              typeof input !== "object" ||
              Array.isArray(input) ||
              Object.hasOwn(input, "action")
            )
              throw new Error("Invalid input");
            const command = commandSchema.parse({ ...input, action });
            if (action !== "submit" && "values" in command)
              throw new Error("Unexpected values");
            if ("secretRef" in command && action !== "submit")
              throw new Error("Unexpected reference");
            if (action === "submit" && "values" in command) {
              const publicFields = new Set(
                manifest.methods
                  .flatMap((method) => [
                    ...method.fields,
                    ...(method.claimFields ?? [
                      { name: "email", type: "email" },
                    ]),
                  ])
                  .filter((field) => field.type !== "password")
                  .map((field) => field.name),
              );
              if (
                Object.keys(command.values ?? {}).some(
                  (name) => !publicFields.has(name),
                )
              )
                throw new Error("Use private credential collection");
            }
            if (signal.aborted) throw new Error("Ceremony unmounted");
            const snapshot = await invoke(command, options.signal);
            return {
              ok: snapshot?.step !== "error" && snapshot?.step !== "expired",
              ...toolState(manifest, snapshot),
            };
          } catch {
            // Never reflect submitted secrets or arbitrary transport error messages to an agent.
            return {
              ok: false,
              error:
                "Action could not execute. Read the ceremony state before retrying.",
            };
          }
        },
      },
      { signal },
    );
  }
}

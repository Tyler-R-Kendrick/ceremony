import { z } from "zod";
import { agentProjection, classifyField } from "./projections.js";
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
  execute(input: unknown, options?: { signal: AbortSignal }): Promise<unknown>;
}
/** Native registration surface; older Chrome versions expose it on navigator. */
export interface CeremonyModelContext {
  registerTool(
    tool: CeremonyTool,
    options: { signal: AbortSignal },
  ): Promise<void> | void;
}
export function browserModelContext(): CeremonyModelContext | undefined {
  return typeof document === "undefined"
    ? undefined
    : ((document as Document & { modelContext?: CeremonyModelContext })
        .modelContext ??
        (typeof navigator === "undefined"
          ? undefined
          : (navigator as Navigator & { modelContext?: CeremonyModelContext })
              .modelContext));
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
          fields: agentProjection(snapshot).fields,
          ...(snapshot.prerequisites
            ? { prerequisites: agentProjection(snapshot).prerequisites }
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
export function createCeremonyTools(
  prefix: string,
  manifest: ConnectorManifest,
  invoke: (
    command: CeremonyCommand,
    signal: AbortSignal,
  ) => Promise<CeremonySnapshot | undefined>,
  signal: AbortSignal,
  currentSnapshot?: () => CeremonySnapshot | undefined,
) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(prefix))
    throw new Error("Invalid WebMCP tool prefix");
  return ([
    "start",
    "read",
    ...actionNames,
    "navigate",
    "request-input",
  ] as const).map((action): CeremonyTool => ({
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
                        "Explicitly public choices for the current step only. Use request-input for all other fields; private collection completes without exposing a reference to the agent.",
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
        execute: async (input, options = { signal }) => {
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
            if ("secretRef" in command)
              throw new Error("Unexpected reference");
            if (action === "submit" && "values" in command) {
              const publicFields = new Set(
                (currentSnapshot?.()?.fields ?? [])
                  .filter((field) => classifyField(field) === "public")
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
      }));
}

/** Native WebMCP is a transport over the same protected local definitions. */
export async function registerCeremonyTools(
  modelContext: CeremonyModelContext,
  prefix: string,
  manifest: ConnectorManifest,
  invoke: (command: CeremonyCommand, signal: AbortSignal) => Promise<CeremonySnapshot | undefined>,
  signal: AbortSignal,
  currentSnapshot?: () => CeremonySnapshot | undefined,
) {
  for (const tool of createCeremonyTools(prefix, manifest, invoke, signal, currentSnapshot)) {
    if (signal.aborted) return;
    await modelContext.registerTool(tool, { signal });
  }
}

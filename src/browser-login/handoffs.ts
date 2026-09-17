import { z } from "zod";
import type { Observation } from "./templates.js";

export const handoffReasons = [
  "human-challenge",
  "passkey-required",
  "native-dialog",
  "unsupported-page",
] as const;
export const handoffReasonSchema = z.enum(handoffReasons);
export type HandoffReason = z.infer<typeof handoffReasonSchema>;

export const handoffEventSchema = z.strictObject({
  kind: z.literal("handoff"),
  runId: z.string().uuid(),
  reason: handoffReasonSchema,
  origin: z
    .string()
    .url()
    .refine((value) => {
      try {
        return new URL(value).origin === value;
      } catch {
        return false;
      }
    }, "Expected an exact origin"),
  attempt: z.number().int().positive().max(8),
});
export type HandoffEvent = z.infer<typeof handoffEventSchema>;

export const handoffResolutionSchema = z.enum([
  "completed",
  "declined",
  "unavailable",
]);
export type HandoffResolution = z.infer<typeof handoffResolutionSchema>;

export interface HandoffHooks {
  /** Observer. Cannot change the outcome or authorize a submission. */
  onHandoff?: ((event: HandoffEvent) => void | Promise<void>) | undefined;
  /**
   * Participation. An owning app may resolve a passkey or similar device
   * ceremony. Missing, invalid, or throwing resolvers are `unavailable`.
   */
  resolveHandoff?:
    | ((event: HandoffEvent) => HandoffResolution | Promise<HandoffResolution>)
    | undefined;
}

/** Hooks cannot replay a reserved submission or turn a refusal into success. */
export async function offerHandoff(
  event: HandoffEvent,
  hooks: HandoffHooks = {},
): Promise<HandoffResolution> {
  const published = handoffEventSchema.parse(event);
  try {
    void Promise.resolve(hooks.onHandoff?.(published)).catch(() => {});
  } catch {
    /* Observers cannot change the handoff outcome. */
  }
  try {
    const pending = hooks.resolveHandoff?.(published);
    const resolution = await Promise.resolve(
      pending === undefined ? "unavailable" : pending,
    );
    return resolution === "completed" || resolution === "declined"
      ? resolution
      : "unavailable";
  } catch {
    return "unavailable";
  }
}

const subscribers = new Set<HandoffHooks>();
const incoming = z.strictObject({
  type: z.literal("ceremony.handoff"),
  event: handoffEventSchema,
});

/** Hosts register resolvers here. An owning app can complete a passkey handoff. */
export function subscribeHandoffs(hooks: HandoffHooks): () => void {
  subscribers.add(hooks);
  return () => {
    subscribers.delete(hooks);
  };
}

export function composedHandoffHooks(): HandoffHooks {
  return {
    onHandoff(event) {
      for (const hooks of subscribers) {
        try {
          void Promise.resolve(hooks.onHandoff?.(event)).catch(() => {});
        } catch {
          /* Observers cannot change the handoff outcome. */
        }
      }
    },
    async resolveHandoff(event) {
      for (const hooks of subscribers) {
        if (!hooks.resolveHandoff) continue;
        try {
          const resolution = await hooks.resolveHandoff(event);
          if (resolution === "completed" || resolution === "declined")
            return resolution;
        } catch {
          /* A throwing resolver is skipped; it cannot replay a submission. */
        }
      }
      return "unavailable";
    },
  };
}

export function classifyHandoff(page: Observation): HandoffReason | undefined {
  if (
    page.passkey &&
    !page.controls.some((control) => control.kind === "password")
  )
    return "passkey-required";
  if (page.challenge) return "human-challenge";
  return;
}

export type HandoffPort = {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
};

/** Bridge an extension port to in-page subscribers. */
export function attachHandoffPort(port: HandoffPort): () => void {
  const onMessage = (raw: unknown) => {
    const parsed = incoming.safeParse(raw);
    if (!parsed.success) return;
    void offerHandoff(parsed.data.event, composedHandoffHooks()).then(
      (resolution) => {
        port.postMessage({
          type: "ceremony.resolve-handoff",
          runId: parsed.data.event.runId,
          resolution,
        });
      },
    );
  };
  port.onMessage.addListener(onMessage);
  return () => port.disconnect();
}

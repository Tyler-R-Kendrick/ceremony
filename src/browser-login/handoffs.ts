import { z } from "zod";
import {
  offerHandoff,
  handoffEventSchema,
  type HandoffEvent,
  type HandoffHooks,
  type HandoffReason,
  type HandoffResolution,
} from "../core/browser-contracts.js";
import type { Observation } from "./templates.js";

export {
  offerHandoff,
  handoffEventSchema,
  type HandoffEvent,
  type HandoffHooks,
  type HandoffReason,
  type HandoffResolution,
};

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
  if (page.passkey) return "passkey-required";
  if (page.challenge) return "human-challenge";
  return;
}

export type HandoffPort = {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
};

/** Bridge an extension port to in-page subscribers. Replies immediately. */
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

import { z } from "zod";
import {
  handoffRefSchema,
  handoffResolutionSchema,
  mintReference,
} from "../core/browser-session-contracts.js";
import type { Observation } from "./templates.js";

export const handoffReasons = [
  "human-challenge",
  "passkey-required",
  "native-dialog",
  "unsupported-page",
] as const;
export const handoffReasonSchema = z.enum(handoffReasons);
export type HandoffReason = z.infer<typeof handoffReasonSchema>;

/**
 * The attempt vocabulary is the one in {@link ../core/browser-session-contracts.js};
 * a second spelling of the same reference would be a second thing to keep in
 * step, and a mismatch between them is exactly the kind of substitution the
 * prefixed reference exists to reject.
 */
export { handoffRefSchema, handoffResolutionSchema };

/** Mint one attempt. A run may ask twice, and the two asks are not the same ask. */
export function mintHandoffRef(): string {
  return mintReference("bhof");
}

export const handoffEventSchema = z.strictObject({
  kind: z.literal("handoff"),
  /**
   * Identifies the attempt, not the run. A run reference cannot tell a live ask
   * apart from an abandoned one, so a reply carrying only `runId` would let an
   * expired first attempt decide the second.
   */
  handoffRef: handoffRefSchema,
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

export type HandoffResolution = z.infer<typeof handoffResolutionSchema>;

/** A resolver's answer. It names the attempt because a run is not enough. */
export const handoffReplyMessageSchema = z.strictObject({
  type: z.literal("ceremony.resolve-handoff"),
  handoffRef: handoffRefSchema,
  runId: z.string().uuid(),
  resolution: handoffResolutionSchema,
});
export type HandoffReplyMessage = z.infer<typeof handoffReplyMessageSchema>;

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
          // Echoed so the answer is attributable to the ask it answers rather
          // than to whichever attempt of this run happens to be open.
          handoffRef: parsed.data.event.handoffRef,
          runId: parsed.data.event.runId,
          resolution,
        });
      },
    );
  };
  port.onMessage.addListener(onMessage);
  return () => port.disconnect();
}

type HandoffWait = {
  runId: string;
  /**
   * The assigned resolvers that still owe an answer. Membership is the only
   * authority to decide this attempt: being connected and allowlisted says a
   * port may talk, not that it was asked.
   */
  remaining: Set<HandoffPort>;
  finish: (value: HandoffResolution) => void;
};

export type HandoffWaitRegistration = {
  handoffRef: string;
  runId: string;
  /** Snapshotted on registration; later arrivals were not asked. */
  resolvers: Iterable<HandoffPort>;
  finish: (value: HandoffResolution) => void;
};

export interface HandoffWaits {
  /** Register one attempt and the resolvers that may answer it. */
  open(registration: HandoffWaitRegistration): void;
  /** End one attempt by name, for its own timeout or an abandoned wait. */
  settle(handoffRef: string, resolution: HandoffResolution): boolean;
  /** Apply a resolver's answer. Rejected unless that port owes this attempt one. */
  reply(port: HandoffPort, message: HandoffReplyMessage): boolean;
  /** A resolver went away. Only losing all of them makes an attempt unavailable. */
  dropPort(port: HandoffPort): void;
  /** Cancellation: whatever this run is still waiting on stops waiting. */
  abandonRun(runId: string, resolution: HandoffResolution): void;
  pending(handoffRef: string): boolean;
  readonly size: number;
}

/**
 * Waits are keyed by attempt, never by run. Keying by run gave every attempt of
 * a run the same address, so a first attempt's expiry timer and its late reply
 * both landed on whichever attempt was open when they arrived.
 */
export function createHandoffWaits(): HandoffWaits {
  const waits = new Map<string, HandoffWait>();
  const settle = (handoffRef: string, resolution: HandoffResolution) => {
    const wait = waits.get(handoffRef);
    if (!wait) return false;
    // Retired before `finish` runs, so an outcome is one-use: a callback that
    // re-enters here, and every later timer, reply or disconnect, finds nothing.
    waits.delete(handoffRef);
    wait.finish(resolution);
    return true;
  };
  return {
    open({ handoffRef, runId, resolvers, finish }) {
      // A run awaits one attempt at a time, so anything still registered for it
      // has been abandoned; leaving it live is what let an old reply answer a
      // new ask.
      for (const [ref, wait] of waits)
        if (wait.runId === runId) settle(ref, "unavailable");
      const remaining = new Set(resolvers);
      waits.set(handoffRef, { runId, remaining, finish });
      // Nobody was assigned, so no answer can ever arrive for this attempt.
      if (remaining.size === 0) settle(handoffRef, "unavailable");
    },
    settle,
    reply(port, message) {
      const wait = waits.get(message.handoffRef);
      // An unknown or already settled attempt is not evidence about the attempt
      // that happens to be open for the same run, so nothing is touched.
      if (!wait || wait.runId !== message.runId) return false;
      if (!wait.remaining.has(port)) return false;
      // One answer per resolver: a port that has spoken cannot speak again.
      wait.remaining.delete(port);
      if (message.resolution !== "unavailable")
        return settle(message.handoffRef, message.resolution);
      return wait.remaining.size === 0
        ? settle(message.handoffRef, "unavailable")
        : false;
    },
    dropPort(port) {
      for (const [ref, wait] of waits)
        if (wait.remaining.delete(port) && wait.remaining.size === 0)
          settle(ref, "unavailable");
    },
    abandonRun(runId, resolution) {
      for (const [ref, wait] of waits)
        if (wait.runId === runId) settle(ref, resolution);
    },
    pending: (handoffRef) => waits.has(handoffRef),
    get size() {
      return waits.size;
    },
  };
}

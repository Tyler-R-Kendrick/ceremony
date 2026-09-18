import { z } from "zod";
import {
  handoffEventSchema,
  handoffRefSchema,
  handoffResolutionSchema,
} from "../../src/browser-login/handoffs.js";
import {
  createPlatform,
  type ExtensionPlatform,
  type ExtensionPort,
} from "./platform.js";

/**
 * Gecko's app bridge.
 *
 * Chromium lets an admitted web page address the extension directly through
 * `externally_connectable`. Gecko has no such thing, so the only supported
 * channel is a content script the manifest admits on the app origin itself,
 * relaying `window.postMessage` to the worker. That trade is the reason this
 * file is as small and as suspicious as it is: a relay on a page is reachable
 * by anything that can get a message into that page, so it admits a message
 * only when three independent facts line up — the document it is running in is
 * an exactly configured app origin, the message came from that same window
 * rather than a frame or an opener, and it matches the schema exactly. The
 * relay decides nothing else: the worker repeats the origin admission against
 * the origin the browser attests for the sender, and a handoff answer still
 * names the attempt it answers.
 */

export const relayChannel = "ceremony.extension";

const appRequest = z.strictObject({
  type: z.enum(["ceremony.ping", "ceremony.open"]),
  protocol: z.literal(1),
});

/** Everything the page may say. Anything else is not a request, it is noise. */
export const relayRequestSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    channel: z.literal(relayChannel),
    kind: z.literal("request"),
    id: z.string().uuid(),
    request: appRequest,
  }),
  z.strictObject({
    channel: z.literal(relayChannel),
    kind: z.literal("subscribe-handoffs"),
  }),
  z.strictObject({
    channel: z.literal(relayChannel),
    kind: z.literal("resolve-handoff"),
    // The attempt, not the run: an answer that named only the run could settle
    // whichever attempt happened to be open when it arrived.
    handoffRef: handoffRefSchema,
    runId: z.string().uuid(),
    resolution: handoffResolutionSchema,
  }),
]);
export type RelayRequest = z.infer<typeof relayRequestSchema>;

const handoffDelivery = z.strictObject({
  type: z.literal("ceremony.handoff"),
  event: handoffEventSchema,
});

export type RelayMessageEvent = {
  source: unknown;
  origin: string;
  data: unknown;
};

/** The window the relay runs in, reduced to what it is allowed to touch. */
export type RelayScope = {
  location: { origin: string };
  addEventListener(
    type: "message",
    listener: (event: RelayMessageEvent) => void,
  ): void;
  removeEventListener(
    type: "message",
    listener: (event: RelayMessageEvent) => void,
  ): void;
  postMessage(message: unknown, targetOrigin: string): void;
};

export type AppRelayOptions = {
  /** Exact origins, scheme host and port, as the build wrote them. */
  admittedOrigins: readonly string[];
  scope: RelayScope;
  platform: ExtensionPlatform;
};

export type AppRelay = {
  /** The one origin this relay serves, or undefined when it serves none. */
  readonly admitted: string | undefined;
  stop(): void;
};

export function createAppRelay({
  admittedOrigins,
  scope,
  platform,
}: AppRelayOptions): AppRelay {
  const admitted = admittedOrigins.find(
    (origin) => origin === scope.location.origin,
  );
  // Match patterns cannot carry a port, so the manifest can only narrow this to
  // a host. A document that is not an exactly configured origin gets no
  // listener at all rather than a listener that would have refused everything.
  if (!admitted) return { admitted: undefined, stop: () => {} };
  const post = (message: unknown) => scope.postMessage(message, admitted);
  let port: ExtensionPort | undefined;
  const openPort = () => {
    if (port) return port;
    const opened = platform.runtime.connect({ name: "ceremony.handoffs" });
    opened.onMessage.addListener((raw) => {
      const parsed = handoffDelivery.safeParse(raw);
      if (!parsed.success) return;
      post({
        channel: relayChannel,
        kind: "handoff",
        event: parsed.data.event,
      });
    });
    opened.onDisconnect.addListener(() => {
      if (port === opened) port = undefined;
      post({ channel: relayChannel, kind: "handoffs-closed" });
    });
    port = opened;
    return opened;
  };
  const listener = (event: RelayMessageEvent) => {
    // A frame, an opener or another window is a different principal even when
    // it shares this origin, and only this window's own script is the app.
    if (event.source !== scope) return;
    if (event.origin !== admitted) return;
    const parsed = relayRequestSchema.safeParse(event.data);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.kind === "subscribe-handoffs") {
      openPort();
      return;
    }
    if (message.kind === "resolve-handoff") {
      // No port means nothing asked; an answer to nothing is dropped, never
      // buffered into whatever gets asked next.
      port?.postMessage({
        type: "ceremony.resolve-handoff",
        handoffRef: message.handoffRef,
        runId: message.runId,
        resolution: message.resolution,
      });
      return;
    }
    void platform.runtime
      .sendMessage({ type: "ceremony.relay", request: message.request })
      .then((reply) =>
        post({
          channel: relayChannel,
          kind: "reply",
          id: message.id,
          reply,
        }),
      )
      .catch(() =>
        post({
          channel: relayChannel,
          kind: "reply",
          id: message.id,
          reply: { error: "unavailable" },
        }),
      );
  };
  scope.addEventListener("message", listener);
  return {
    admitted,
    stop() {
      scope.removeEventListener("message", listener);
      port?.disconnect();
      port = undefined;
    },
  };
}

/**
 * Written into the bundle at build time from the same list the worker reads, so
 * the relay never has to fetch its own admission list from a web-accessible
 * resource the page could also read.
 */
declare const __CEREMONY_APP_ORIGINS__: readonly string[] | undefined;

if (
  typeof __CEREMONY_APP_ORIGINS__ !== "undefined" &&
  __CEREMONY_APP_ORIGINS__.length > 0
)
  createAppRelay({
    admittedOrigins: __CEREMONY_APP_ORIGINS__,
    // `window` — not the isolated world's own global — because the identity a
    // page's `postMessage` reports as `event.source` is the window's. It also
    // carries far more than the relay may touch, so the cast is the boundary
    // where that surface is narrowed to the members above.
    scope: window as unknown as RelayScope,
    platform: createPlatform(),
  });

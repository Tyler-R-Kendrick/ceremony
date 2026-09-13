import { createElement, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Ceremony } from "../src/react/index.js";
import { ConnectorCard } from "../src/react/connectors.js";
import {
  actionsFor,
  snapshotSchema,
  type CeremonySnapshot,
  type CeremonyTransport,
} from "../src/core/schema.js";
import {
  liveConnectors,
  type Call,
  type LiveConnector,
  type Proof,
} from "./gallery-live-connectors.js";

/**
 * The live half of the catalogue: a real ceremony, against a real provider.
 *
 * A published page cannot `fetch`, so for a long time this page said so and
 * showed specimens. That was the wrong conclusion: a page can reach the
 * network, through the connector capability the viewer has already authorized
 * in claude.ai. Calls run with the viewer's own credentials and this page never
 * sees a token.
 *
 * So nothing here is staged. `Ceremony` is the component the library ships, it
 * drives the client the library ships, and the transport below is a real
 * implementation of `CeremonyTransport` whose `begin` performs an actual call
 * to an actual provider. The screens are whatever that call produced: the
 * completion carries the identity the provider returned, and every failure
 * screen carries the reason the connector gave.
 *
 * What differs from a self-hosted deployment is the transport, and only the
 * transport: there, `createHttpTransport` talks to the connection server, which
 * holds the credential. Here the viewer's assistant holds it. Both satisfy the
 * same interface, which is the point of there being an interface.
 */

/** How long a started attempt stays valid. The client enforces it. */
const ATTEMPT_MINUTES = 10;

interface McpError {
  code: string;
  message: string;
  server?: string;
  retryable?: boolean;
}

function isMcpError(value: unknown): value is McpError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as McpError).code === "string"
  );
}

/**
 * What a person should do about each failure, in their words.
 *
 * Every code gets its own sentence because every code has a different fix, and
 * one "something went wrong" banner would hide the single action that unblocks
 * the page. The codes are the connector capability's own.
 */
function explain(error: unknown, server: string): string {
  if (!isMcpError(error))
    return error instanceof Error
      ? error.message
      : "The connection attempt failed.";
  const where = error.server ?? server;
  switch (error.code) {
    case "server_not_connected":
      return `No ${where} connector is available to you. Add it in claude.ai under Settings → Connectors, then try again.`;
    case "needs_reauth":
      return `Your ${where} connection has expired. Reconnect it in claude.ai under Settings → Connectors, then try again.`;
    case "selection_required":
      return `You have more than one ${where} connector. Choose which one to use when claude.ai asks, then try again.`;
    case "not_in_manifest":
      return `This page did not ask for ${where} access, so it cannot use it.`;
    case "blocked_by_policy":
      return `Your organization's policy does not allow this page to use ${where}.`;
    case "approval_required":
    case "cancelled":
      return "You did not approve this connection, so nothing was accessed.";
    case "capability_disabled":
      return "Connector access is turned off for this view, so no provider can be reached.";
    case "server_not_found":
      return `The ${where} connector no longer exists upstream.`;
    case "server_unavailable":
      return `${where} did not answer in time. This one is usually temporary — try again.`;
    case "bad_request":
      return `${where} refused the request as malformed. That is this page's bug, not yours.`;
    case "tool_error":
      return `${where} refused the request: ${error.message}`;
    default:
      return `${where} could not be reached: ${error.message}`;
  }
}

/** Whether the viewer turning it down is what happened, rather than a fault. */
function isRefusal(error: unknown): boolean {
  return (
    isMcpError(error) && ["approval_required", "cancelled"].includes(error.code)
  );
}

/**
 * A transport whose work is a real provider call.
 *
 * It keeps its own revision and enforces it, the way the connection server
 * does, so a stale action is refused here for the same reason it is refused
 * there. It stores nothing: there is no credential to store.
 */
export function createConnectorTransport(
  live: LiveConnector,
  call: Call | undefined,
  onProof: (proof: Proof | undefined) => void,
): CeremonyTransport {
  const method = live.manifest.methods[0]!;
  const id = globalThis.crypto.randomUUID();
  let revision = 0;
  let current: CeremonySnapshot | undefined;

  const at = (
    step: CeremonySnapshot["step"],
    extra: Partial<CeremonySnapshot> = {},
  ): CeremonySnapshot => {
    revision += 1;
    current = snapshotSchema.parse({
      id,
      revision,
      connectorId: live.manifest.id,
      connectorName: live.manifest.name,
      description: live.manifest.description,
      method,
      step,
      fields: [],
      actions: actionsFor(step),
      expiresAt: Date.now() + ATTEMPT_MINUTES * 60_000,
      ...extra,
    });
    return current;
  };

  const begin = async (): Promise<CeremonySnapshot> => {
    if (!call)
      return at("error", {
        message:
          "This view cannot reach connectors, so no provider can be contacted. Open the page from claude.ai to run it for real.",
      });
    try {
      const proof = await live.probe(call);
      onProof(proof);
      return at("complete", {
        outcome: {
          connectionRef: proof.reference,
          ownership: "authenticated" as const,
          // The grant really is the set of tools this page may call with the
          // viewer's credentials. Naming anything else would overstate it.
          scopes: [...method.scopes],
        },
      });
    } catch (error) {
      onProof(undefined);
      return isRefusal(error)
        ? at("cancelled")
        : at("error", { message: explain(error, live.server) });
    }
  };

  return {
    start: async () => at("intro"),
    read: async () => current ?? at("intro"),
    act: async (_id, action) => {
      if (current && action.revision !== current.revision)
        throw new Error("This attempt moved on. Re-read it and try again.");
      if (action.action === "begin") return begin();
      if (action.action === "cancel") {
        onProof(undefined);
        return at("cancelled");
      }
      if (action.action === "retry") {
        onProof(undefined);
        return at("intro");
      }
      throw new Error(`${action.action} is not available on this connection.`);
    },
  };
}

/** What the connection went on to read, once it existed. */
function Evidence({ proof }: { proof: Proof }): ReactNode {
  return createElement(
    "div",
    { className: "evidence" },
    createElement("p", { className: "evidence-head" }, proof.headline),
    createElement(
      "dl",
      { className: "evidence-facts" },
      ...proof.facts.flatMap((fact, index) => [
        createElement("dt", { key: `t${index}` }, fact.label),
        createElement("dd", { key: `d${index}` }, fact.value),
      ]),
    ),
    createElement(
      "p",
      { className: "evidence-note" },
      "Read live from the provider just now, with your credentials. This page never saw a token, and nothing was written.",
    ),
  );
}

function LiveConnection({
  live,
  callFor,
}: {
  live: LiveConnector;
  callFor: (server: string) => Call | undefined;
}): ReactNode {
  const [started, setStarted] = useState(false);
  const [proof, setProof] = useState<Proof | undefined>(undefined);
  const transport = useState(() =>
    createConnectorTransport(live, callFor(live.server), setProof),
  )[0];
  if (!started)
    return createElement(ConnectorCard, {
      manifest: live.manifest,
      status: "available",
      onConnect: () => setStarted(true),
    });
  return createElement(
    "div",
    { className: "live-run" },
    // No onCancel handler swapping the card back in: a declined connection has
    // its own screen, it says what happened, and it offers a retry. Replacing
    // it with the card again would throw that away and leave somebody who just
    // pressed Connect looking at the button they already pressed.
    createElement(Ceremony, {
      manifest: live.manifest,
      transport,
      autoFocus: false,
      webmcp: false as const,
    }),
    proof ? createElement(Evidence, { proof }) : null,
  );
}

export function mountLive(
  root: HTMLElement,
  callFor: (server: string) => Call | undefined,
): void {
  createRoot(root).render(
    createElement(
      "div",
      { className: "live-grid" },
      ...liveConnectors.map((live) =>
        createElement(
          "div",
          { className: "live-cell", key: live.manifest.id },
          createElement(LiveConnection, { live, callFor }),
        ),
      ),
    ),
  );
}

export { liveConnectors };

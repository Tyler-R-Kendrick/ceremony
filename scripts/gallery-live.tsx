import {
  createElement,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { Ceremony } from "../src/react/index.js";
import { ConnectorCard } from "../src/react/connectors.js";
import {
  actionsFor,
  defaultTemplate,
  snapshotSchema,
  templateSchema,
  type CeremonySnapshot,
  type CeremonyTemplate,
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

/**
 * The shipped template, with one heading that presumed a retry generalised.
 *
 * Every failure the library's own flows reach offers a retry, so its error
 * screen is titled "Let's try that again" and that is right there. This
 * transport reaches failures that do not: a connector switched off for this
 * page must not be asked about on a loop, and an organization's policy will
 * not yield to pressing a button. Those screens carry no retry, and a heading
 * inviting one over an empty row of actions reads as a broken page.
 *
 * So the title is replaced and nothing else is. `templates` is the supported
 * way for a host to do this, the rest of the screen is the shipped one, and
 * the specimens further down the page still use the default untouched.
 */
const liveTemplate: CeremonyTemplate = (() => {
  const base = defaultTemplate("oauth-code");
  return templateSchema.parse({
    ...base,
    screens: {
      ...base.screens,
      error: base.screens.error.replace(
        /Title\("[^"]*"\)/,
        'Title("That did not connect")',
      ),
    },
  });
})();

/** How long a started attempt stays valid. The client enforces it. */
const ATTEMPT_MINUTES = 10;

/** What one of the viewer's connectors looks like from inside the frame. */
export interface ServerInfo {
  server: string;
  authStatus: "connected" | "needs_reauth" | "unknown";
  tools: { name: string }[];
}

/**
 * Everything this page needs from the viewer's session.
 *
 * `listTools` matters as much as `callTool`: it reports the connectors the
 * frame can actually reach, under the display names they answer to, and the
 * contract says to call it at load and adapt. Guessing those names instead —
 * which is what the first version of this did — produces a page that reports
 * a connector as unreachable when the viewer has it and the name simply did
 * not match.
 */
export interface Broker {
  callTool(
    server: string,
    tool: string,
    input?: unknown,
  ): Promise<{ payload?: unknown }>;
  listTools(): Promise<{ servers: ServerInfo[] }>;
  /** Consent for one connector, read without ever prompting. */
  permission(name: string): Promise<string>;
  /** Consent for one connector, asked once, behind a real gesture. */
  ask(names: readonly string[]): Promise<Record<string, string>>;
}

interface McpError {
  code: string;
  message: string;
  server?: string;
  retryable?: boolean;
  retryAfterMs?: number;
}

function isMcpError(value: unknown): value is McpError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as McpError).code === "string"
  );
}

/**
 * What each failure means, what to do about it, and whether to offer a retry.
 *
 * Every code gets its own sentence because every code has a different fix, and
 * one "something went wrong" banner would hide the single action that unblocks
 * the page. Whether a retry appears is part of the answer: some codes say
 * plainly not to ask again, and a button that re-asks in a loop is worse than
 * no button. The codes and their readings are the connector capability's own.
 */
interface Verdict {
  step: "cancelled" | "error";
  message: string;
  /** Offer the retry the step would otherwise carry. */
  retry: boolean;
}

function verdict(error: unknown, server: string): Verdict {
  const fault = (message: string, retry = true): Verdict => ({
    step: "error",
    message,
    retry,
  });
  if (!isMcpError(error))
    return fault(
      error instanceof Error ? error.message : "The connection attempt failed.",
    );
  const where = error.server ?? server;
  const wait =
    typeof error.retryAfterMs === "number"
      ? ` Wait about ${Math.ceil(error.retryAfterMs / 1000)}s.`
      : "";
  switch (error.code) {
    // Declined, or switched off for this page afterwards. Not a fault, and
    // explicitly not something to ask about again on a loop — so it lands on
    // the cancelled screen carrying the fix, and offers nothing to press.
    case "not_in_manifest":
      return {
        step: "cancelled",
        message: `This page is not allowed to use ${where}. Allow it for this page in claude.ai — or, if you never declined, the page asked for a tool it never declared, which is the page's bug.`,
        retry: false,
      };
    // Only ever reached top-level. Declined or timed out, and its guidance is
    // the opposite of the above: offer a way to try, behind a fresh gesture.
    case "consent_required":
      return {
        step: "cancelled",
        message: `You have not allowed ${where} for this page yet. Press Try again and answer the prompt to allow it.`,
        retry: true,
      };
    case "server_not_connected":
      return fault(
        `No ${where} connector is available to you. Add it in claude.ai under Settings → Connectors, then try again.`,
      );
    case "needs_reauth":
      return fault(
        `Your ${where} connection has expired. Reconnect it in claude.ai under Settings → Connectors, then try again.`,
      );
    case "selection_required":
      return fault(
        `You have more than one ${where} connector. Choose which one to use when claude.ai asks, then try again.`,
      );
    case "server_not_found":
      return fault(
        `The ${where} connector no longer exists upstream, so there is nothing to connect to.`,
        false,
      );
    case "server_unavailable":
      return fault(
        `${where} did not answer in time. This one is usually temporary.${wait}`,
      );
    case "rate_limited":
      return fault(
        `This page has called ${where} too often for now.${wait || " Give it a few seconds."}`,
      );
    case "blocked_by_policy":
      return fault(
        `Your organization's policy does not allow this page to use ${where}.`,
        false,
      );
    // Per-call approval, which a published page cannot ask for. Retrying runs
    // into the same wall, so no retry is offered.
    case "approval_required":
      return fault(
        `Your organization requires approval for each ${where} call, and a published page cannot ask for it.`,
        false,
      );
    case "not_granted":
    case "capability_disabled":
    case "capability_removed":
      return fault(
        "This view cannot reach connectors at all, so no provider can be contacted. Open the page from claude.ai to run it for real.",
        false,
      );
    case "user_changed":
      return fault(
        "The account signed in here is no longer the one this page loaded for. Reload before connecting anything.",
        false,
      );
    case "bad_request":
    case "transform_error":
      return fault(
        `${where} refused the request as malformed. That is this page's bug, not yours.`,
        false,
      );
    case "tool_error":
      return fault(`${where} refused the request: ${error.message}`);
    // The abort case. This page never aborts a call, and the contract warns
    // that the upstream outcome is unknown when it happens, so it is reported
    // rather than dressed up as a cancellation somebody chose.
    case "cancelled":
      return fault(
        `The call to ${where} was interrupted, and whether it ran is unknown.`,
      );
    default:
      return fault(
        `${where} could not be reached: ${error.message}${error.retryable ? wait : ""}`,
      );
  }
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
  call: Call,
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
      const { step, message, retry } = verdict(error, live.server);
      return at(step, {
        message,
        // The transport decides what is available, the way the connection
        // server does. Dropping the retry is how "do not ask again" reaches
        // the screen rather than only the prose.
        ...(retry ? {} : { actions: [] }),
      });
    }
  };

  return {
    start: async () => at("intro"),
    read: async () => current ?? at("intro"),
    act: async (_id, action) => {
      if (current && action.revision !== current.revision)
        throw new Error("This attempt moved on. Re-read it and try again.");
      // A snapshot that lists no actions means none are available, and a
      // transport that says so while still honouring them is not enforcing its
      // own statement. The client checks this too; a server does not rely on
      // its client to, and neither does this.
      if (current && !current.actions.includes(action.action))
        throw new Error(`${action.action} is not available on this screen.`);
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

/**
 * One connector: its card, then the ceremony its Connect button really runs.
 *
 * `resolved` is the connector as the runtime reported it, not as this page
 * spelled it. When nothing matched, the card still renders and pressing it
 * reaches the same failure screen every other unreachable connector does —
 * saying which connector is missing rather than nothing at all.
 */
function LiveConnection({
  live,
  broker,
  resolved,
}: {
  live: LiveConnector;
  broker: Broker | undefined;
  resolved: ServerInfo | undefined;
}): ReactNode {
  const [started, setStarted] = useState(false);
  const [proof, setProof] = useState<Proof | undefined>(undefined);
  // The transport is built once and outlives every render, but what it needs
  // arrives later: the broker and the connector's real name are both resolved
  // by an effect. Capturing them in the closure would freeze the values this
  // component first rendered with — which are none — and every press would
  // report that the view cannot reach connectors while it plainly can.
  const latest = useRef({ broker, resolved });
  latest.current = { broker, resolved };
  const transport = useState(() =>
    createConnectorTransport(
      live,
      async (tool, input) => {
        const { broker, resolved } = latest.current;
        if (!broker)
          throw {
            code: "not_granted",
            message: "This view did not grant connector access.",
          };
        const server = resolved?.server;
        if (!server)
          throw {
            code: "server_not_connected",
            message: "No connector by that name is reachable from this page.",
            server: live.server,
          };
        // Asked per connector, not for everything at once, and only here —
        // inside the press. A page that asks on load asks before anybody has
        // said what they want, and the contract says to ask per section.
        const scope = `mcp:${server}`;
        const answer = await broker
          .ask([scope])
          .catch(() => ({}) as Record<string, string>);
        const state = answer[scope];
        if (state === "denied")
          throw {
            code: "not_in_manifest",
            message: "The viewer declined this connector for this page.",
            server,
          };
        // `.payload` is the JSON answer; the result around it carries the
        // content blocks and cache marks. Handing the wrapper to the probe
        // parses to nothing and reads as the provider returning garbage.
        return (await broker.callTool(server, tool, input)).payload;
      },
      setProof,
    ),
  )[0];
  // Pressing Connect calls the provider straight away — the client prepares an
  // oauth-code method without stopping — so what it is about to do has to be
  // legible before the press, not on a screen nobody sees.
  if (!started)
    return createElement(ConnectorCard, {
      manifest: live.manifest,
      status: "available",
      intent: {
        permissions: live.access.map((entry) => ({ label: entry.label })),
      },
      onConnect: () => setStarted(true),
    });
  return createElement(
    "div",
    { className: "live-run" },
    // No onCancel handler swapping the card back in: a declined connection has
    // its own screen, it says what happened, and it offers a retry where one
    // would help. Replacing it with the card again would throw that away.
    createElement(Ceremony, {
      manifest: live.manifest,
      transport,
      templates: [liveTemplate],
      autoFocus: false,
      webmcp: false as const,
    }),
    proof ? createElement(Evidence, { proof }) : null,
  );
}

/** What the page found when it looked, so a failure is never a mystery. */
function Findings({
  looked,
  broker,
  servers,
  consent,
}: {
  looked: boolean;
  broker: Broker | undefined;
  servers: readonly ServerInfo[];
  consent: Record<string, string>;
}): ReactNode {
  const rows = liveConnectors.map((live) => {
    const found = matchServer(servers, live);
    const scope = found ? consent[`mcp:${found.server}`] : undefined;
    return createElement(
      "li",
      { key: live.manifest.id },
      createElement("code", null, live.manifest.name),
      ` · ${
        found
          ? `reachable as "${found.server}", ${found.authStatus}, ${found.tools.length} tool${found.tools.length === 1 ? "" : "s"}${scope ? `, consent ${scope}` : ""}`
          : "not reachable from this page"
      }`,
    );
  });
  return createElement(
    "details",
    { className: "findings" },
    createElement(
      "summary",
      null,
      !looked
        ? "Checking what this page can reach…"
        : !broker
          ? "This view cannot reach connectors"
          : `${servers.length} connector${servers.length === 1 ? "" : "s"} reachable from this page`,
    ),
    createElement("ul", null, ...rows),
    createElement(
      "p",
      null,
      "Read from the viewer's own session when the page loaded. If a connector you have is listed as unreachable, it is this page's manifest that does not match it — not your account.",
    ),
  );
}

/** The runtime's name for a connector this page knows, whatever its spelling. */
export function matchServer(
  servers: readonly ServerInfo[],
  live: LiveConnector,
): ServerInfo | undefined {
  const wanted = [live.server, ...(live.aliases ?? [])].map((name) =>
    name.toLowerCase(),
  );
  return servers.find((info) => wanted.includes(info.server.toLowerCase()));
}

function LiveSection({
  getBroker,
}: {
  getBroker: () => Promise<Broker | null>;
}): ReactNode {
  const [looked, setLooked] = useState(false);
  const [broker, setBroker] = useState<Broker | undefined>(undefined);
  const [servers, setServers] = useState<readonly ServerInfo[]>([]);
  const [consent, setConsent] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    void (async () => {
      const resolved = (await getBroker()) ?? undefined;
      if (!live) return;
      setBroker(resolved);
      if (resolved) {
        // Listing never asks the viewer anything, so it is safe on load and
        // is the only way to learn the names their connectors answer to.
        const found = await resolved
          .listTools()
          .then((result) => result.servers)
          .catch(() => [] as ServerInfo[]);
        if (!live) return;
        setServers(found);
        const states = await Promise.all(
          found.map(async (info) => {
            const scope = `mcp:${info.server}`;
            return [
              scope,
              await resolved.permission(scope).catch(() => "unavailable"),
            ] as const;
          }),
        );
        if (live) setConsent(Object.fromEntries(states));
      }
      if (live) setLooked(true);
    })();
    return () => {
      live = false;
    };
  }, [getBroker]);
  return createElement(
    "div",
    null,
    createElement(
      "div",
      { className: "live-grid" },
      ...liveConnectors.map((entry) =>
        createElement(
          "div",
          { className: "live-cell", key: entry.manifest.id },
          createElement(LiveConnection, {
            live: entry,
            broker,
            resolved: matchServer(servers, entry),
          }),
        ),
      ),
    ),
    createElement(Findings, { looked, broker, servers, consent }),
  );
}

export function mountLive(
  root: HTMLElement,
  getBroker: () => Promise<Broker | null>,
): void {
  createRoot(root).render(createElement(LiveSection, { getBroker }));
}

export { liveConnectors };

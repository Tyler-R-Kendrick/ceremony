import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { Ceremony, SecureField } from "../src/react/index.js";
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
import { connections, redemption, type Handback } from "./gallery-secrets.js";
import {
  createAccountTransport,
  type AccountStore,
  type Delivery,
} from "./gallery-registration.js";
import { accountProviders, type AccountProvider } from "./gallery-accounts.js";
import { brandOf } from "./gallery-brands.js";

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

/**
 * The shipped form template, adapted for making an account rather than using one.
 *
 * Only the titles change, and `templates` is the supported way to change them.
 * The library says "connection" because it is usually attaching an integration
 * to something that already exists; this is the ceremony that brings the thing
 * into being, and a heading reading "Connect your account" over a form about to
 * create one is the wrong sentence.
 *
 * What is deliberately not changed is the redirect screen's contents. Adding
 * `Fields()` there would have put the handoff and the credential on one screen,
 * and the library refuses it: a redirect screen is where somebody leaves, and a
 * credential box on it invites typing a secret into the page they are about to
 * leave rather than the one that issued it. The flow takes the extra screen.
 */
const accountTemplate: CeremonyTemplate = (() => {
  const base = defaultTemplate("form");
  const retitle = (screen: string, title: string) =>
    screen.replace(/Title\("[^"]*"\)/, `Title(${JSON.stringify(title)})`);
  return templateSchema.parse({
    ...base,
    screens: {
      ...base.screens,
      intro: retitle(base.screens.intro, "Make an account"),
      input: retitle(base.screens.input, "One thing at a time"),
      redirect: retitle(base.screens.redirect, "Over to them for a moment"),
      complete: retitle(base.screens.complete, "Your account is ready"),
      error: retitle(base.screens.error, "That did not go through"),
      cancelled: retitle(
        base.screens.cancelled,
        "Stopped before anything was made",
      ),
      expired: retitle(base.screens.expired, "That code expired"),
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
  /**
   * Write the page's diagnostics document, so what happened on a real run can
   * be read from outside the page. Codes, names and messages only — never a
   * provider's payload, and never anything a person typed.
   */
  record(document: Record<string, unknown>): Promise<void>;
}

interface McpError {
  code: string;
  message: string;
  server?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  /** The code this one was settled from, when the page had to look twice. */
  cause?: string;
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
        `You have no ${where} connector in claude.ai, so there is nothing for this page to reach. Add ${where} in claude.ai under Settings → Connectors, then press Try again.`,
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
        `${where} did not answer in time. This one is usually temporary.${wait} Then press Try again.`,
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
    // A code this mapping does not know. Naming it is the point: the last
    // time one arrived here it printed a sentence with no code, and finding
    // out which one it was took a round trip through the user.
    // The one a first call gets when consent for the connector could not be
    // given just then: the prompt could not be shown, was left undecided — or,
    // as this page learned from its own screenshots, found no connector to
    // ask about. The call never reached a provider. `settle` turns the last
    // case into `server_not_connected` when listing again proves it; what is
    // left here is the prompt itself, and the sentence still names the other
    // reading in case the listing could not tell.
    case "upstream_error":
      return error.retryable
        ? fault(
            `claude.ai did not confirm this page's access to ${where}. If it said "No matching connector found", add ${where} in claude.ai under Settings → Connectors. If it showed a prompt you did not answer, answer it. Then${
              typeof error.retryAfterMs === "number"
                ? ` wait about ${Math.ceil(error.retryAfterMs / 1000)}s and`
                : ""
            } press Try again.`,
          )
        : fault(`${where} could not be reached: ${error.message}`);
    default:
      return fault(
        `${where} could not be reached: ${error.message}${error.retryable ? wait : ""} (${error.code})`,
      );
  }
}

/**
 * Look twice before blaming a prompt.
 *
 * A retryable `upstream_error` on a first call is documented as consent that
 * could not be given just then. It is also, it turned out, what a connector the
 * viewer never added produces: the shell finds nothing to ask about, the call
 * never reaches a provider, and a page reading the code alone told people to
 * look for a prompt that could not exist. Listing again after the ask settles
 * it — a manifest server absent from the viewer's list has no connector for
 * them, which is exactly `server_not_connected` — and the outcome keeps the
 * code it was settled from, so the record shows what was seen as well as what
 * was concluded. Any other error, and any listing that cannot tell, passes
 * through untouched.
 */
export async function settle(
  error: unknown,
  live: LiveConnector,
  relist: () => Promise<readonly ServerInfo[]>,
): Promise<unknown> {
  if (!isMcpError(error) || error.code !== "upstream_error" || !error.retryable)
    return error;
  const servers = await relist().catch(() => undefined);
  if (servers === undefined || matchServer(servers, live)) return error;
  return {
    code: "server_not_connected",
    message: `No ${live.server} connector is connected in claude.ai for this viewer.`,
    server: live.server,
    cause: error.code,
  } satisfies McpError;
}

/**
 * A transport whose work is a real provider call.
 *
 * It keeps its own revision and enforces it, the way the connection server
 * does, so a stale action is refused here for the same reason it is refused
 * there. It stores nothing: there is no credential to store.
 */
/** One attempt's result, as the page records it: what happened, never what was read. */
export interface Outcome {
  server: string;
  step: CeremonySnapshot["step"];
  code?: string;
  message?: string;
  /** The code a settled failure was seen as before it was understood. */
  cause?: string;
}

export function createConnectorTransport(
  live: LiveConnector,
  call: Call,
  onProof: (proof: Proof | undefined) => void,
  onOutcome: (outcome: Outcome) => void = () => {},
  onHandback: (handback: Handback | undefined) => void = () => {},
  onStep: (step: CeremonySnapshot["step"]) => void = () => {},
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
    onStep(current.step);
    return current;
  };

  const begin = async (): Promise<CeremonySnapshot> => {
    try {
      const proof = await live.probe(call);
      onProof(proof);
      // The connection exists now, so it is given a name and a key before
      // anything else happens. Without this the ceremony would finish having
      // produced nothing anybody could keep: the provider answered, the
      // screen said so, and there was no way to name what had answered or to
      // use it afterwards. The key never leaves this tab; the reference is
      // what the outcome carries, and it grants nothing by itself.
      const handback = await connections.issue(
        {
          connectorId: live.manifest.id,
          connectorName: live.manifest.name,
          scopes: [...method.scopes],
          reference: proof.reference,
        },
        [],
        call,
      );
      onHandback(handback);
      onOutcome({ server: live.server, step: "complete" });
      return at("complete", {
        outcome: {
          connectionRef: proof.reference,
          ownership: "authenticated" as const,
          // The grant really is the set of tools this page may call with the
          // viewer's credentials. Naming anything else would overstate it.
          scopes: [...method.scopes],
          secretRef: handback.record.secretRef,
        },
      });
    } catch (error) {
      onProof(undefined);
      onHandback(undefined);
      const { step, message, retry } = verdict(error, live.server);
      onOutcome({
        server: live.server,
        step,
        ...(isMcpError(error)
          ? {
              code: error.code,
              message: error.message,
              ...(error.cause ? { cause: error.cause } : {}),
            }
          : {
              message: error instanceof Error ? error.message : String(error),
            }),
      });
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
        onHandback(undefined);
        return at("cancelled");
      }
      if (action.action === "retry") {
        onProof(undefined);
        onHandback(undefined);
        return at("intro");
      }
      throw new Error(`${action.action} is not available on this connection.`);
    },
  };
}

/** A value worth keeping that is not worth hiding, with one press to take it. */
function CopyRow({
  value,
  label,
}: {
  value: string;
  label: string;
}): ReactNode {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return createElement(
    "span",
    { className: "copy-row" },
    createElement("code", null, value),
    createElement(
      "button",
      {
        type: "button",
        className: "quiet",
        onClick: () => {
          void navigator.clipboard.writeText(value).then(
            () => setState("copied"),
            () => setState("failed"),
          );
        },
      },
      state === "copied" ? "Copied" : state === "failed" ? "Select it" : "Copy",
      createElement("span", { className: "sr-only" }, ` ${label}`),
    ),
  );
}

/** Live state of a card, from the step the flow is on. */
function cardStatus(
  step: CeremonySnapshot["step"] | undefined,
): "available" | "connected" | "attention" {
  if (step === "complete") return "connected";
  if (step === "error" || step === "expired" || step === "cancelled")
    return "attention";
  return "available";
}

/** What the ceremony produced: a reference to say out loud, and keys to keep. */
function Vault({ handback }: { handback: Handback }): ReactNode {
  const { record, issued } = handback;
  return createElement(
    "div",
    { className: "vault" },
    createElement(
      "div",
      { className: "vault-field" },
      createElement("span", { className: "vault-label" }, "Reference"),
      createElement(CopyRow, { value: record.secretRef, label: "reference" }),
    ),
    ...issued.map((entry) =>
      createElement(
        "div",
        { className: "vault-field", key: entry.name },
        createElement("span", { className: "vault-label" }, entry.label),
        createElement(SecureField, {
          id: `vault-${record.secretRef}-${entry.name}`,
          label: entry.label,
          value: entry.value,
        }),
        createElement("p", { className: "vault-note" }, entry.note),
      ),
    ),
    createElement(
      "details",
      { className: "vault-code" },
      createElement("summary", null, "Redeem"),
      createElement(
        "pre",
        null,
        createElement(
          "code",
          null,
          redemption(
            record,
            Boolean(record.scopes.length && handback.callable),
          ),
        ),
      ),
    ),
  );
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
  relist,
  onOutcome,
}: {
  live: LiveConnector;
  broker: Broker | undefined;
  resolved: ServerInfo | undefined;
  /** List the viewer's connectors again, after a press has asked about one. */
  relist: () => Promise<readonly ServerInfo[]>;
  onOutcome: (outcome: Outcome) => void;
}): ReactNode {
  const [started, setStarted] = useState(false);
  const [run, setRun] = useState(0);
  const [step, setStep] = useState<CeremonySnapshot["step"] | undefined>(
    undefined,
  );
  const [proof, setProof] = useState<Proof | undefined>(undefined);
  const [handback, setHandback] = useState<Handback | undefined>(undefined);
  // The transport is built once and outlives every render, but what it needs
  // arrives later: the broker and the connector's real name are both resolved
  // by an effect. Capturing them in the closure would freeze the values this
  // component first rendered with — which are none — and every press would
  // report that the view cannot reach connectors while it plainly can.
  const latest = useRef({ broker, resolved, relist, onOutcome });
  latest.current = { broker, resolved, relist, onOutcome };
  const build = () =>
    createConnectorTransport(
      live,
      async (tool, input) => {
        const { broker, resolved, relist } = latest.current;
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
        try {
          return (await broker.callTool(server, tool, input)).payload;
        } catch (error) {
          throw await settle(error, live, relist);
        }
      },
      setProof,
      (outcome) => latest.current.onOutcome(outcome),
      setHandback,
      setStep,
    );
  const [transport, setTransport] = useState(build);
  const brand = brandOf(live.manifest.id);
  const status = cardStatus(step);
  return createElement(
    "div",
    {
      className: "flow",
      // The brand drives the card's own accent, so the action is the provider's
      // colour rather than the page's.
      style: {
        ["--ceremony-accent"]: brand.tint,
        ["--ceremony-on-accent"]: brand.ink,
      } as CSSProperties,
    },
    createElement(ConnectorCard, {
      manifest: live.manifest,
      status,
      tint: brand.tint,
      ink: brand.ink,
      ...(brand.logo ? { logo: brand.logo } : {}),
      intent: {
        permissions: live.access.map((entry) => ({ label: entry.label })),
      },
      ...(started ? { actionLabel: "Start over" } : {}),
      onConnect: () => {
        if (!started) return setStarted(true);
        setProof(undefined);
        setHandback(undefined);
        setStep(undefined);
        setTransport(() => build());
        setRun((count) => count + 1);
      },
    }),
    started
      ? createElement(
          "div",
          { className: "flow-live", key: run },
          createElement(Ceremony, {
            manifest: live.manifest,
            transport,
            templates: [liveTemplate],
            autoFocus: false,
            webmcp: false as const,
          }),
          proof ? createElement(Evidence, { proof }) : null,
          handback ? createElement(Vault, { handback }) : null,
        )
      : null,
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
          ? `listed as "${found.server}", ${found.authStatus === "unknown" ? "not asked about yet" : found.authStatus}, ${found.tools.length} tool${found.tools.length === 1 ? "" : "s"}${scope ? `, consent ${scope}` : ""}`
          : "not in your claude.ai connectors"
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
          : `${servers.length} connector${servers.length === 1 ? "" : "s"} listed for this page`,
    ),
    createElement("ul", null, ...rows),
    createElement(
      "p",
      null,
      "Read from your own session when the page loaded, and again after each press. Until you have been asked about a connector, claude.ai lists it from this page's manifest whether or not you have it; the first press settles that, and one you do not have is then shown as missing.",
    ),
  );
}

/**
 * The runtime's entry for a connector this page declares.
 *
 * Matched on the display name the page declared, which is the one read from
 * the account's connector list before publishing; case is forgiven only
 * because nothing is gained by refusing "supabase" for "Supabase".
 */
export function matchServer(
  servers: readonly ServerInfo[],
  live: LiveConnector,
): ServerInfo | undefined {
  const wanted = live.server.toLowerCase();
  return servers.find((info) => info.server.toLowerCase() === wanted);
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
  const [attempts, setAttempts] = useState<
    readonly (Outcome & { at: string })[]
  >([]);
  const onOutcome = useCallback((outcome: Outcome) => {
    // The last few, not a stream: one document, bounded, so the store never
    // fills with one row per press.
    setAttempts((log) =>
      [...log, { ...outcome, at: new Date().toISOString() }].slice(-10),
    );
  }, []);
  // Listing again is how a press finds out whether a connector exists at all,
  // and what it finds belongs in the findings panel too — so the list is
  // replaced, not merely read.
  const brokerRef = useRef(broker);
  brokerRef.current = broker;
  const relist = useCallback(async (): Promise<readonly ServerInfo[]> => {
    const current = brokerRef.current;
    if (!current) return [];
    const found = await current.listTools().then((result) => result.servers);
    setServers(found);
    return found;
  }, []);
  // What the page found and what happened, written where it can be read from
  // outside the page. Codes, names, states and the runtime's own messages —
  // never a provider's payload. Failing to write is not a failure of the page.
  useEffect(() => {
    if (!looked || !broker) return;
    void broker
      .record({
        at: new Date().toISOString(),
        version: 12,
        reachable: servers.map((info) => ({
          server: info.server,
          authStatus: info.authStatus,
          tools: info.tools.map((tool) => tool.name),
          consent: consent[`mcp:${info.server}`] ?? "unread",
        })),
        matched: liveConnectors.map((entry) => ({
          connector: entry.manifest.id,
          as: matchServer(servers, entry)?.server ?? null,
        })),
        attempts,
      })
      .catch(() => {});
  }, [looked, broker, servers, consent, attempts]);
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
            relist,
            onOutcome,
          }),
        ),
      ),
    ),
    createElement(Findings, { looked, broker, servers, consent }),
  );
}

/**
 * One account provider: its card, then the ceremony its button really runs.
 *
 * The card comes first on purpose. Pressing a button on the card is what starts
 * the ceremony, and what happens next happens in the card — this is the whole
 * of the interaction, not a link to somewhere the interaction lives.
 */
function AccountCard({
  provider,
  store,
  onDelivery,
}: {
  provider: AccountProvider;
  store: Promise<AccountStore>;
  onDelivery: (delivery: Delivery) => void;
}): ReactNode {
  const [started, setStarted] = useState(false);
  const [run, setRun] = useState(0);
  const [step, setStep] = useState<CeremonySnapshot["step"] | undefined>(
    undefined,
  );
  const [handback, setHandback] = useState<
    (Handback & { registered: boolean }) | undefined
  >(undefined);
  const latest = useRef({ onDelivery });
  latest.current = { onDelivery };
  const build = () =>
    createAccountTransport(provider, {
      // Asked for once, awaited by whoever needs it. The capability can take
      // seconds to resolve and the first screen must not wait on it: nobody has
      // typed anything yet, so there is nothing to store.
      store: {
        label: "resolving",
        read: async (id: string) => (await store).read(id),
        write: async (id: string, document: Record<string, unknown>) =>
          (await store).write(id, document),
      },
      deliver: (delivery) => latest.current.onDelivery(delivery),
      onHandback: setHandback,
      onStep: setStep,
    });
  const [transport, setTransport] = useState(build);
  const brand = brandOf(provider.manifest.id);
  return createElement(
    "div",
    {
      className: "flow",
      // The brand drives the card's own accent, so the action is the provider's
      // colour rather than the page's.
      style: {
        ["--ceremony-accent"]: brand.tint,
        ["--ceremony-on-accent"]: brand.ink,
      } as CSSProperties,
    },
    createElement(ConnectorCard, {
      manifest: provider.manifest,
      status: cardStatus(step),
      tint: brand.tint,
      ink: brand.ink,
      ...(brand.logo ? { logo: brand.logo } : {}),
      intent: {
        permissions: provider.promises.map((label) => ({ label })),
      },
      ...(started ? { actionLabel: "Start over" } : {}),
      onConnect: () => {
        if (!started) return setStarted(true);
        setHandback(undefined);
        setStep(undefined);
        setTransport(() => build());
        setRun((count) => count + 1);
      },
    }),
    started
      ? createElement(
          "div",
          { className: "flow-live", key: run },
          createElement(Ceremony, {
            manifest: provider.manifest,
            transport,
            templates: [accountTemplate],
            autoFocus: false,
            webmcp: false as const,
          }),
          handback ? createElement(Vault, { handback }) : null,
        )
      : null,
  );
}

/**
 * Where the confirmation code goes, because a published page has no mail server.
 *
 * Naming it a mailbox rather than dressing it as an inbox is the honest move:
 * the courier is the part that is missing, and every other part of the step is
 * real. The code comes from the platform's random source, the store keeps only
 * a derived form of it behind a ten-minute expiry, and it has to come back
 * through the form before anything is issued.
 */
function Mailbox({
  deliveries,
}: {
  deliveries: readonly Delivery[];
}): ReactNode {
  return createElement(
    "div",
    { className: "mailbox" },
    createElement("p", { className: "mailbox-head" }, "Mailbox"),
    deliveries.length
      ? createElement(
          "ol",
          { className: "mailbox-list" },
          ...deliveries.map((delivery) =>
            createElement(
              "li",
              { key: delivery.at },
              createElement(
                "p",
                { className: "mailbox-subject" },
                delivery.reason === "registration"
                  ? "Confirm your new account"
                  : "Confirm it is you",
              ),
              createElement("p", { className: "mailbox-to" }, delivery.to),
              createElement(CopyRow, { value: delivery.code, label: "code" }),
            ),
          ),
        )
      : createElement("p", { className: "mailbox-empty" }, "No codes yet."),
  );
}

/**
 * Every account this page can make, as a card apiece.
 *
 * One grid, one mailbox under it, and no ordering claim beyond the first being
 * the one that finishes here. The rest hand off to a provider that makes the
 * account itself, which is the honest shape of registering at GitHub, Stripe or
 * Atlassian and is not something a page can do on their behalf.
 */
function Accounts({
  getStore,
}: {
  getStore: () => Promise<AccountStore>;
}): ReactNode {
  const [deliveries, setDeliveries] = useState<readonly Delivery[]>([]);
  const pending = useState(() => getStore())[0];
  const onDelivery = useCallback(
    (delivery: Delivery) =>
      setDeliveries((list) => [delivery, ...list].slice(0, 3)),
    [],
  );
  return createElement(
    "div",
    { className: "accounts" },
    createElement(
      "div",
      { className: "live-grid" },
      ...accountProviders.map((provider) =>
        createElement(
          "div",
          { className: "live-cell", key: provider.manifest.id },
          createElement(AccountCard, {
            provider,
            store: pending,
            onDelivery,
          }),
        ),
      ),
    ),
    createElement(Mailbox, { deliveries }),
  );
}

export function mountAccounts(
  root: HTMLElement,
  getStore: () => Promise<AccountStore>,
): void {
  createRoot(root).render(createElement(Accounts, { getStore }));
}

export function mountLive(
  root: HTMLElement,
  getBroker: () => Promise<Broker | null>,
): void {
  createRoot(root).render(createElement(LiveSection, { getBroker }));
}

export { liveConnectors };

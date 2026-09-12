import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ConnectorManifest } from "../../src/core/index.js";
import type { EntryContext } from "../../src/core/resolution.js";
import {
  Ceremony,
  CeremonyView,
  ConnectorCard,
  ConnectorGrid,
  createHttpTransport,
  HandoffMeter,
  type ConnectorStatus,
} from "../../src/react/index.js";
import "../../src/react/styles.css";
import { manifestSchema } from "../../src/core/index.js";
import { z } from "zod";

/**
 * The real connection server, not a stand-in.
 *
 * An earlier version of this page carried an in-page transport that moved
 * snapshots around without contacting anybody, and a footer admitting it. A
 * demonstration that discloses it is not demonstrating anything is still not
 * demonstrating anything, so it is gone: this talks to /api/live/ceremonies,
 * which runs the real adapters against real providers with real encrypted
 * storage. Served statically with no server behind it, the cards report that
 * instead of inventing a result.
 */
const transport = createHttpTransport("/api/live/ceremonies");

import "./showcase.css";

/**
 * Two surfaces, one set of components.
 *
 * The left half is a host application embedding the connector grid. The right
 * half is the same components inside a chat transcript, which is what an MCP
 * App renders. They are not two designs that resemble each other; they are the
 * same `ConnectorCard` and the same `CeremonyView` under different chrome.
 */

const tints: Record<string, string> = {
  github: "#1f2328",
  stripe: "#5b53d3",
  jira: "#1868db",
  supabase: "#2f8f5b",
  neon: "#0f7a6d",
};

/** Host themes: the whole point of the token layer, shown rather than claimed. */
const themes = {
  default: { label: "Default", vars: {} as Record<string, string> },
  ink: {
    label: "Ink",
    vars: {
      "--ceremony-accent": "#111827",
      "--ceremony-accent-wash": "#eef0f4",
      "--ceremony-radius-lg": "6px",
      "--ceremony-radius": "4px",
      "--ceremony-radius-sm": "3px",
    },
  },
  orchid: {
    label: "Orchid",
    vars: {
      "--ceremony-accent": "#8b2fb8",
      "--ceremony-accent-wash": "#f7ecfb",
      "--ceremony-radius-lg": "20px",
      "--ceremony-radius": "14px",
      "--ceremony-radius-sm": "10px",
    },
  },
} as const;

type ThemeName = keyof typeof themes;

const statuses: Record<string, ConnectorStatus> = {
  stripe: "connected",
  jira: "attention",
};

/**
 * What a host declares it needs. Everything a person is shown follows from it,
 * and nothing in it names a protocol — because the question "PKCE or device
 * code?" is one no person has ever wanted to answer.
 */
const declarations = {
  assistant: {
    label: "Coding assistant",
    hint: "Acts as the person, and may interrupt them as often as it takes.",
    intent: {
      permissions: [
        { label: "Read your repositories", scopes: ["read:user"] },
        { label: "Open pull requests for you", scopes: ["read:user"] },
      ],
      identity: "personal",
    },
  },
  kiosk: {
    label: "Unattended job",
    hint: "Nobody is watching, so nothing may stop and ask.",
    intent: {
      permissions: [{ label: "Read public data", scopes: ["read:user"] }],
      interruptions: "none",
    },
  },
  onboarding: {
    label: "First-run setup",
    hint: "One stop at most: a new user who is still deciding.",
    intent: {
      permissions: [{ label: "Set up your workspace", scopes: ["read:user"] }],
      interruptions: "at-most-one",
    },
  },
} as const satisfies Record<
  string,
  { label: string; hint: string; intent: EntryContext }
>;

type DeclarationName = keyof typeof declarations;

function ConnectFlow({
  manifest,
  intent,
  onClose,
}: {
  manifest: ConnectorManifest;
  intent: EntryContext;
  onClose(): void;
}) {
  const [opened, setOpened] = useState("");
  return (
    <>
      <Ceremony
        manifest={manifest}
        transport={transport}
        context={intent}
        navigate={(url) => setOpened(url)}
      >
        {(model) => <CeremonyView model={model} />}
      </Ceremony>
      {opened ? (
        <p className="demo-note" role="status">
          The provider would open at <code>{opened}</code>. It was not opened
          and nothing was sent there.
        </p>
      ) : null}
      <button type="button" className="link" onClick={onClose}>
        ← All connections
      </button>
    </>
  );
}

/**
 * Whether the connection server behind this page is actually configured.
 *
 * undefined while asking; false when the page is being served with nothing
 * behind it, or with a server that has no encrypted storage and no provider
 * credentials. Either way the page says so — the one thing it must never do is
 * render a Connect button that cannot connect.
 */
function useLiveServer(): {
  live: boolean | undefined;
  connectors: ConnectorManifest[];
} {
  const [state, setState] = useState<{
    live: boolean | undefined;
    connectors: ConnectorManifest[];
  }>({ live: undefined, connectors: [] });
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/config")
      .then((response) => (response.ok ? response.json() : undefined))
      .then((config) => {
        // The server's own list, parsed by the production schema. Rendering a
        // card the server cannot serve is the same lie in a smaller place.
        const connectors = z
          .array(manifestSchema)
          .catch([])
          .parse(config?.liveManifests);
        if (!cancelled)
          setState({
            live: Boolean(config?.liveAvailable) && connectors.length > 0,
            connectors,
          });
      })
      .catch(() => {
        if (!cancelled) setState({ live: false, connectors: [] });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

function App() {
  const { live, connectors } = useLiveServer();
  const [theme, setTheme] = useState<ThemeName>("default");
  const [declaration, setDeclaration] = useState<DeclarationName>("assistant");
  const intent = declarations[declaration].intent as EntryContext;
  const [chosen, setChosen] = useState<ConnectorManifest>();
  const [chatChosen, setChatChosen] = useState(false);
  const github = connectors.find((entry) => entry.id === "github");

  const present = (manifest: ConnectorManifest) => ({
    status: statuses[manifest.id] ?? ("available" as ConnectorStatus),
    ...(tints[manifest.id] ? { tint: tints[manifest.id]! } : {}),
  });

  return (
    <div className="page" style={themes[theme].vars as React.CSSProperties}>
      <header className="masthead">
        <div className="masthead-text">
          <p className="eyebrow">Ceremony · connection components</p>
          <h1>Connect with confidence</h1>
          <p className="lede">
            Drop-in components for starting a provider connection. Every card
            declares what the route will cost in human attention before anyone
            commits to it — the one thing a directory of logos never tells you.
          </p>
        </div>
        <div
          className="theme-picker"
          role="group"
          aria-label="What the integration needs"
        >
          <span className="eyebrow">What the integration needs</span>
          <div>
            {(Object.keys(declarations) as DeclarationName[]).map((name) => (
              <button
                key={name}
                type="button"
                aria-pressed={name === declaration}
                className={name === declaration ? "active" : ""}
                onClick={() => setDeclaration(name)}
              >
                {declarations[name].label}
              </button>
            ))}
          </div>
          <p className="hint">{declarations[declaration].hint}</p>
        </div>
        <div className="theme-picker" role="group" aria-label="Host theme">
          <span className="eyebrow">Host theme</span>
          <div>
            {(Object.keys(themes) as ThemeName[]).map((name) => (
              <button
                key={name}
                type="button"
                aria-pressed={name === theme}
                className={name === theme ? "active" : ""}
                onClick={() => setTheme(name)}
              >
                {themes[name].label}
              </button>
            ))}
          </div>
          <p className="hint">
            Same components. Only <code>--ceremony-*</code> changes.
          </p>
        </div>
      </header>

      {live === false && (
        <p className="offline" role="status">
          <strong>No connection server is answering.</strong> Every connection
          on this page is real, so there is nothing to show without one. Run{" "}
          <code>npm run dev</code> with <code>CEREMONY_DATABASE</code> and{" "}
          <code>CEREMONY_VAULT_KEY</code> set, then reload. The components below
          are still the real ones; only the provider round trip is missing.
        </p>
      )}

      <div className="surfaces">
        <section className="surface" aria-label="In a host application">
          <div className="surface-chrome">
            <span className="surface-tab">Your application</span>
            <span className="surface-url">
              app.example/settings/connections
            </span>
          </div>
          <div className="surface-body">
            {chosen ? (
              <ConnectFlow
                manifest={chosen}
                intent={intent}
                onClose={() => setChosen(undefined)}
              />
            ) : (
              <>
                <div className="section-head">
                  <h2>Connections</h2>
                  <p>
                    {connectors.length} services available ·{" "}
                    {
                      Object.values(statuses).filter((s) => s === "connected")
                        .length
                    }{" "}
                    connected
                  </p>
                </div>
                <ConnectorGrid
                  manifests={connectors}
                  intent={intent}
                  present={present}
                  onConnect={setChosen}
                />
              </>
            )}
          </div>
        </section>

        <section className="surface" aria-label="In a chat client">
          <div className="surface-chrome">
            <span className="surface-tab">Chat · MCP app</span>
            <span className="surface-url">ceremony_connect</span>
          </div>
          <div className="surface-body chat">
            <div className="bubble person">
              Connect my GitHub so you can open pull requests for me.
            </div>
            <div className="bubble agent">
              <p>
                GitHub needs someone to approve the installation, so I can get
                everything else ready and then hand it to you once.
              </p>
              {!github ? (
                <p className="chat-foot">
                  The server is not offering a GitHub connector right now, so
                  there is nothing genuine to render here.
                </p>
              ) : chatChosen ? (
                <div className="chat-embed">
                  <ConnectFlow
                    manifest={github}
                    intent={intent}
                    onClose={() => setChatChosen(false)}
                  />
                </div>
              ) : (
                <div className="chat-embed">
                  <ConnectorCard
                    manifest={github}
                    intent={intent}
                    tint={tints.github!}
                    onConnect={() => setChatChosen(true)}
                  />
                </div>
              )}
            </div>
            <p className="chat-foot">
              The MCP App renders the same card and the same ceremony panel the
              web application uses. Credentials go straight to the broker over
              HTTPS; the assistant receives a one-use reference, never a value.
            </p>
          </div>
        </section>
      </div>

      <section className="legend" aria-label="How a route is chosen">
        <h2>Nobody picks a protocol</h2>
        <p className="lede">
          The declaration above is the whole input: what the integration must be
          able to do, whose account it is for, and how much of somebody's
          attention it may spend. The route follows from it — approve at the
          provider, a code on another device, a credential you already hold, or
          nothing at all — and the same resolver answers for the component and
          for the assistant, because both read the same declaration.
        </p>
        <h2>What the meter means</h2>
        <div className="legend-rows">
          <div>
            <HandoffMeter count={0} />
            <p>
              Completes on its own. Anonymous access, or a credential the caller
              already holds.
            </p>
          </div>
          <div>
            <HandoffMeter count={1} />
            <p>
              Stops once. A provider approval, a code to enter, or a value only
              a person can supply.
            </p>
          </div>
          <div>
            <HandoffMeter count={3} />
            <p>
              Stops three times. Each prerequisite in the connector's contract
              declares its own handoff, and they are counted, not estimated.
            </p>
          </div>
        </div>
      </section>

      <footer className="colophon">
        <p>
          Every connection here runs against the live connection server at{" "}
          <code>/api/live/ceremonies</code> — real adapters, real providers,
          real encrypted storage. There is no simulation behind this page. If
          the server is not configured, the cards say so rather than pretending
          to connect to something.
        </p>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

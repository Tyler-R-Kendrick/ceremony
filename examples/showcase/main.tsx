import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ConnectorManifest } from "../../src/core/index.js";
import {
  Ceremony,
  CeremonyView,
  ConnectorCard,
  ConnectorGrid,
  HandoffMeter,
  type ConnectorStatus,
} from "../../src/react/index.js";
import "../../src/react/styles.css";
import { manifests } from "../manifests.js";
import { createShowcaseTransport, type Waiting } from "./transport.js";
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

function ProviderQueue({
  waiting,
  provider,
}: {
  waiting: Waiting[];
  provider: { approve(id: string): void; refuse(id: string): void };
}) {
  if (!waiting.length) return null;
  return (
    <aside className="stand-in">
      <p className="stand-in-note">
        A redirect is finished by the provider, not by the client — so the
        client polls until it hears back. There is no provider here, so this
        stands in.
      </p>
      {waiting.map((item) => (
        <div className="stand-in-row" key={item.id}>
          <span>
            <strong>{item.service}</strong> · {item.method}
            {item.userCode ? <code> {item.userCode}</code> : null}
          </span>
          <span className="stand-in-actions">
            <button type="button" onClick={() => provider.approve(item.id)}>
              Approve
            </button>
            <button type="button" onClick={() => provider.refuse(item.id)}>
              Refuse
            </button>
          </span>
        </div>
      ))}
    </aside>
  );
}

function ConnectFlow({
  manifest,
  transport,
  onClose,
}: {
  manifest: ConnectorManifest;
  transport: ReturnType<typeof createShowcaseTransport>["transport"];
  onClose(): void;
}) {
  const [opened, setOpened] = useState("");
  return (
    <>
      <Ceremony
        manifest={manifest}
        transport={transport}
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

function App() {
  const [waiting, setWaiting] = useState<Waiting[]>([]);
  const [{ transport, provider }] = useState(() =>
    createShowcaseTransport(manifests, setWaiting),
  );
  const [theme, setTheme] = useState<ThemeName>("default");
  const [chosen, setChosen] = useState<ConnectorManifest>();
  const [chatChosen, setChatChosen] = useState(false);
  const github = manifests.find((entry) => entry.id === "github")!;

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
                transport={transport}
                onClose={() => setChosen(undefined)}
              />
            ) : (
              <>
                <div className="section-head">
                  <h2>Connections</h2>
                  <p>
                    {manifests.length} services available ·{" "}
                    {
                      Object.values(statuses).filter((s) => s === "connected")
                        .length
                    }{" "}
                    connected
                  </p>
                </div>
                <ConnectorGrid
                  manifests={manifests}
                  present={present}
                  onConnect={setChosen}
                />
              </>
            )}
            <ProviderQueue waiting={waiting} provider={provider} />
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
              {chatChosen ? (
                <div className="chat-embed">
                  <ConnectFlow
                    manifest={github}
                    transport={transport}
                    onClose={() => setChatChosen(false)}
                  />
                </div>
              ) : (
                <div className="chat-embed">
                  <ConnectorCard
                    manifest={github}
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

      <section className="legend" aria-label="Reading a card">
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
          <strong>Real:</strong> the components, the connector manifests, the
          screen templates, and the schema that validates every snapshot before
          the UI will render it. <strong>Not real:</strong> the transport. No
          provider is contacted, nothing is stored, and no credential is
          handled.
        </p>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

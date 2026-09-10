import { lazy, Suspense, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { browserModelContext, manifestSchema } from "../../src/core/index.js";
import {
  Ceremony,
  CeremonyView,
  createHttpTransport,
} from "../../src/react/index.js";
import "./style.css";
import { connectorDetails } from "../manifests.js";
import { Environment } from "./environment.js";
import { TeachingConnection } from "./teaching.js";
import { usePwaInstall } from "./pwa.js";
const WorkflowStudio = lazy(() => import("./workflow-studio.js"));

// Simulated providers are an explicit test harness, never the default product.
const liveMode = new URLSearchParams(location.search).get("mode") !== "test";
const transport = createHttpTransport(
  liveMode ? "/api/live/ceremonies" : "/api/ceremonies",
);
const configSchema = z.object({
  manifests: z.array(manifestSchema).min(1),
  generationAvailable: z.boolean(),
  liveManifests: z.array(manifestSchema).default([]),
  liveAvailable: z.boolean().default(false),
  teachingAvailable: z.boolean().default(false),
  teachingConnectors: z.array(z.string()).default(["github"]),
});
type Config = z.infer<typeof configSchema>;
function App() {
  const install = usePwaInstall();
  const [config, setConfig] = useState<Config>();
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState(
    new URLSearchParams(location.search).get("section") === "environment"
      ? "environment"
      : new URLSearchParams(location.search).get("section") === "studio"
        ? "studio"
        : "connect",
  );
  const [connectorId, setConnectorId] = useState(
    new URLSearchParams(location.search).get("connector") ?? "github",
  );
  const [resumeId, setResumeId] = useState(
    new URLSearchParams(location.search).get("ceremony") ?? undefined,
  );
  const [studioOpened, setStudioOpened] = useState(tab === "studio");
  const [delegation, setDelegation] = useState(false);
  useEffect(() => {
    void fetch("/api/config")
      .then((response) => response.json())
      .then((value) => setConfig(configSchema.parse(value)))
      .catch(() =>
        setLoadError(
          "Could not load connectors. Check the reference server and reload.",
        ),
      );
  }, []);
  const selectConnector = (next: string) => {
    if (next === connectorId) return;
    setConnectorId(next);
    setResumeId(undefined);
    history.replaceState(
      null,
      "",
      `/?connector=${encodeURIComponent(next)}${liveMode ? "" : "&mode=test"}`,
    );
  };
  const connector =
    (liveMode ? config?.liveManifests : config?.manifests)?.find(
      (value) => value.id === connectorId,
    ) ?? (liveMode ? config?.liveManifests : config?.manifests)?.[0];
  return (
    <div className="app-shell">
      <header className="site-header">
        <a href="/" className="brand">
          <svg
            className="brand-mark"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M9 5H5v14h4M15 5h4v14h-4M8 12h8"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          ceremony
        </a>
        <nav aria-label="Main navigation">
          <button
            aria-current={tab === "connect" ? "page" : undefined}
            onClick={() => setTab("connect")}
          >
            Connect
          </button>
          <button
            aria-current={tab === "studio" ? "page" : undefined}
            onClick={() => {
              setStudioOpened(true);
              setTab("studio");
            }}
          >
            Workflow studio
          </button>
          <button
            aria-current={tab === "environment" ? "page" : undefined}
            onClick={() => setTab("environment")}
          >
            Environment
          </button>
        </nav>
        <details className="install-controls">
          <summary>Install app</summary>
          <p>{install.instructions}</p>
          {install.canInstall && (
            <button onClick={() => void install.install()}>
              Install Ceremony
            </button>
          )}
          {install.updateAvailable && (
            <button onClick={install.update}>Update static shell</button>
          )}
        </details>
        <span className="header-note">
          <span />
          Local workspace
        </span>
      </header>
      <main>
        {tab !== "studio" && loadError && <p role="alert">{loadError}</p>}
        {tab !== "studio" && !config && !loadError && (
          <p role="status">Loading your workspace…</p>
        )}
        {config && tab === "environment" && <Environment />}
        {studioOpened && (
          <div hidden={tab !== "studio"}>
            <Suspense fallback={<p role="status">Loading authoring tools…</p>}>
              <WorkflowStudio />
            </Suspense>
          </div>
        )}
        {config && connector && tab === "connect" && (
          <>
            <div className="page-heading">
              <div>
                <h1>Connections</h1>
                <p>
                  {liveMode
                    ? "Choose a service. We reuse your session setup and guide you through only what’s missing."
                    : "Developer test harness. Local providers only; never enter real credentials."}
                </p>
              </div>
            </div>
            <div className="connect-grid" data-live={liveMode || undefined}>
              <aside className="connector-list" aria-label="Available services">
                <h2 className="rail-heading">Available services</h2>
                {(liveMode ? config.liveManifests : config.manifests).map(
                  (item) => (
                    <button
                      key={item.id}
                      aria-pressed={connector.id === item.id}
                      className={`connector-tile ${connector.id === item.id ? "selected" : ""}`}
                      onClick={() => void selectConnector(item.id)}
                    >
                      <span
                        className={`connector-icon ${item.id}`}
                        aria-hidden="true"
                      >
                        {item.name[0]}
                      </span>
                      <span>
                        <strong>{item.name}</strong>
                        <small>
                          {liveMode
                            ? item.id === "github"
                              ? "App setup · repository access"
                              : item.id === "jira"
                                ? "OAuth consent"
                                : connectorDetails[item.id]?.summary
                            : connectorDetails[item.id]?.summary}
                        </small>
                      </span>
                    </button>
                  ),
                )}
                {!liveMode && (
                  <details className="test-details">
                    <summary>Local test credentials</summary>
                    <p>
                      API key: <code>demo-api-key</code>
                    </p>
                    <p>
                      Atlassian email: <code>demo@example.com</code>
                    </p>
                    <p>
                      Email: <code>demo@example.com</code>
                    </p>
                    <p>
                      Password: <code>ceremony-demo</code>
                    </p>
                    <p>
                      Atlassian API token: <code>ceremony-demo</code>
                    </p>
                    <p>These accounts exist only in the local test provider.</p>
                  </details>
                )}
                {liveMode && (
                  <details className="test-details">
                    <summary>Session and assistance</summary>
                    <label htmlFor="approval-assistance">
                      Approval assistance
                    </label>
                    <select
                      id="approval-assistance"
                      value={delegation ? "agent" : "browser"}
                      onChange={(event) =>
                        setDelegation(event.target.value === "agent")
                      }
                    >
                      <option value="browser">
                        I’ll approve in my browser
                      </option>
                      <option value="agent">
                        Request configured agent assistance
                      </option>
                    </select>
                    <p>
                      Configured agents can assist supported steps. Account
                      consent stays with you; private input never enters model
                      context.
                    </p>
                    <button onClick={() => setTab("environment")}>
                      Manage session environment
                    </button>
                  </details>
                )}
              </aside>
              <section className="connection-card">
                <div className="card-top">
                  <div className="service-heading">
                    <span
                      className={`connector-icon ${connector.id}`}
                      aria-hidden="true"
                    >
                      {connector.name[0]}
                    </span>
                    <div>
                      <h2>{connector.name}</h2>
                      <p>{connector.description}</p>
                    </div>
                  </div>
                  <span className="pill">
                    {liveMode ? "Provider-backed" : "Local simulation"}
                  </span>
                </div>
                {liveMode &&
                config.teachingAvailable &&
                config.teachingConnectors.includes(connector.id) ? (
                  <TeachingConnection
                    key={connector.id}
                    connectorId={connector.id}
                  />
                ) : liveMode && !config.liveAvailable ? (
                  <div className="ceremony">
                    <h3>Configure the connection server</h3>
                    <p>
                      Live connections need persistent encrypted storage. Set
                      CEREMONY_DATABASE and CEREMONY_VAULT_KEY on the server,
                      then restart. Never enter encryption keys in chat.
                    </p>
                  </div>
                ) : (
                  <Ceremony
                    key={`${connector.id}:${delegation}`}
                    manifest={connector}
                    transport={transport}
                    {...(delegation ? { delegation: "agent" as const } : {})}
                    {...(resumeId ? { resumeId } : {})}
                    onInstance={(id) => {
                      setResumeId(id);
                      history.replaceState(
                        null,
                        "",
                        `/?connector=${connector.id}&ceremony=${id}${liveMode ? "" : "&mode=test"}`,
                      );
                    }}
                  >
                    {(model) => (
                      <div className="ceremony-workspace">
                        <CeremonyView model={model} />
                        <aside
                          className="runtime-context"
                          aria-label="Connection context"
                        >
                          <h3>Connection context</h3>
                          <p>
                            {liveMode
                              ? "Private inputs are collected by reference. Provider SDKs run on the server; keys and tokens stay in the encrypted vault."
                              : "Runs locally. Do not enter real service credentials."}
                          </p>
                          <dl>
                            <dt>Current state</dt>
                            <dd>{model.snapshot?.step ?? "Not started"}</dd>
                            <dt>Authentication</dt>
                            <dd>
                              {model.snapshot?.method.label ??
                                "Choose a method"}
                            </dd>
                            <dt>Execution</dt>
                            <dd>
                              {browserModelContext()
                                ? "UI and WebMCP share the same actions"
                                : "WebMCP is unavailable in this browser. Enable WebMCP in Chrome and reload; the UI remains available."}
                            </dd>
                          </dl>
                          <h3>Requested permissions</h3>
                          {model.snapshot ? (
                            model.snapshot.method.scopes.length ? (
                              <ul>
                                {model.snapshot.method.scopes.map((scope) => (
                                  <li key={scope}>
                                    <code>{scope}</code>
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <p>
                                Access is controlled by the service, credential
                                or project policy; no OAuth scopes requested.
                              </p>
                            )
                          ) : (
                            <p>
                              Select a method to review its requested access.
                            </p>
                          )}
                          <details>
                            <summary>Provider setup</summary>
                            <p>
                              {liveMode && connector.id === "github"
                                ? "An existing app is reused when configured. Otherwise, app registration blocks installation, and verified installation blocks signing. Browser completion alone never grants access."
                                : connectorDetails[connector.id]?.note}
                            </p>
                          </details>
                          <a
                            href={
                              liveMode && connector.id === "github"
                                ? "https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest"
                                : connectorDetails[connector.id]
                                    ?.documentationUrl
                            }
                            target="_blank"
                            rel="noreferrer"
                          >
                            Auth documentation
                          </a>
                        </aside>
                      </div>
                    )}
                  </Ceremony>
                )}
                <div className="card-footer">
                  <p>
                    {liveMode
                      ? "Setup is saved between steps. Only verified provider access completes the connection."
                      : "Your credentials go directly to private collection, then to the adapter by reference."}
                    <br />
                    {liveMode
                      ? "You retain control of account access and provider approvals."
                      : "Do not use real credentials in simulations."}
                  </p>
                </div>
              </section>
            </div>
          </>
        )}
      </main>
      <footer className="site-footer">
        <span>
          {liveMode
            ? "Provider-backed connections · Encrypted session storage"
            : "Developer test harness · Test credentials only"}
        </span>
        <span>Ceremony / 0.1</span>
      </footer>
    </div>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);

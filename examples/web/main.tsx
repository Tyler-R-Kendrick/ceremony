import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { browserModelContext, manifestSchema } from "../../src/core/index.js";
import {
  Ceremony,
  CeremonyView,
  createHttpTransport,
} from "../../src/react/index.js";
import "./style.css";
import "./connect.css";
import { connectorDetails } from "../manifests.js";
import { Environment } from "./environment.js";
import { TeachingConnection } from "./teaching.js";
import { AgentConnectors, agentProviderSchema } from "./agent-card.js";
import { usePwaInstall } from "./pwa.js";
import {
  authFamilyLabels,
  capabilityDetails,
  catalog,
  isCustomEntry,
  type CatalogEntry,
} from "./catalog.js";
import { ConnectCatalog } from "./connect-catalog.js";
import { AddConnection, type ConnectionDraft } from "./add-connection.js";
const ExtensionSetup = lazy(() => import("./extension-setup.js"));
const WorkflowStudio = lazy(() => import("./workflow-studio.js"));

// Simulated providers are an explicit test harness, never the default product.
const entryParams = new URLSearchParams(location.search);
const liveMode = entryParams.get("mode") !== "test";
/**
 * The connector the page was opened on, read once.
 *
 * Selecting a service rewrites the query string, so re-reading it per render
 * would turn every click into a resume link and skip the two steps the person
 * came to fill in.
 */
const openedOnConnector = entryParams.get("connector");
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
  agentProviders: z.array(agentProviderSchema).default([]),
});
type Config = z.infer<typeof configSchema>;
type Section = "connect" | "studio" | "environment";

function sectionFromUrl(): Section {
  const section = new URLSearchParams(location.search).get("section");
  return section === "environment"
    ? "environment"
    : section === "studio"
      ? "studio"
      : "connect";
}

function App() {
  const install = usePwaInstall();
  const [config, setConfig] = useState<Config>();
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<Section>(sectionFromUrl);
  const [connectorId, setConnectorId] = useState(openedOnConnector ?? "github");
  // Only a link that already names a connector opens the drawer. Landing
  // inside a modal would put the scrim over the rail, and a directory whose
  // navigation is unreachable on arrival is not a directory.
  const [open, setOpen] = useState(Boolean(openedOnConnector));
  // A link carrying a connector is a resume link: the service is already
  // chosen, so the drawer opens on the run. Picking one from the directory is
  // not, and starts where the choices are.
  const [resuming, setResuming] = useState(Boolean(openedOnConnector));
  const [resumeId, setResumeId] = useState(
    entryParams.get("ceremony") ?? undefined,
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
  // Memoised on the config itself: a fresh array every render would rebuild
  // every entry, and the drawer resets its draft when its entry changes.
  const manifests = useMemo(
    () => (liveMode ? config?.liveManifests : config?.manifests) ?? [],
    [config],
  );
  /**
   * The directory shows every row it can describe; a row with no manifest is
   * still worth browsing, and says on its face that it has to be authored
   * before it can run.
   */
  const entries = useMemo(
    () =>
      catalog.map((entry) =>
        manifests.some((manifest) => manifest.id === entry.id) ||
        entry.support === "declared"
          ? entry
          : { ...entry, support: "declared" as const },
      ),
    [manifests],
  );
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
  const entry = entries.find((item) => item.id === connectorId) ?? entries[0]!;
  const connector =
    manifests.find((value) => value.id === connectorId) ?? manifests[0];
  const goTo = (section: Section) => {
    if (section === "studio") setStudioOpened(true);
    setTab(section);
  };

  /** The connection workspace, unchanged in substance and hosted by the drawer. */
  const renderRun = (draft: ConnectionDraft) => {
    if (loadError) return <p role="alert">{loadError}</p>;
    if (!config) return <p role="status">Loading your workspace…</p>;
    if (!connector || entry.support === "declared")
      return (
        <div className="ceremony">
          <h3>
            {isCustomEntry(entry.id)
              ? "Name the service this protocol belongs to"
              : "Author this connector first"}
          </h3>
          <p>
            {isCustomEntry(entry.id)
              ? `You chose ${authFamilyLabels[draft.family]}. The workflow studio turns that into a connector definition — its methods, Arazzo workflows and human fallbacks — against the origin you give it. Publishing one makes it connectable here, and reusable by anyone else in this workspace.`
              : `${entry.name} has no executable manifest in this workspace yet. The workflow studio creates the connector definition, its authentication methods, Arazzo workflows and human fallbacks; publishing one makes it connectable here.`}
          </p>
          <p className="field-hint">
            Nothing has been stored. What you entered stays in this draft until
            a definition is published.
          </p>
          <button
            type="button"
            className="button-primary"
            onClick={() => goTo("studio")}
          >
            Open workflow studio
          </button>
        </div>
      );
    return (
      <div className="connect-grid" data-live={liveMode || undefined}>
        <aside className="connector-list" aria-label="Available services">
          <h3 className="rail-heading">Available services</h3>
          {manifests.map((item) => (
            <button
              key={item.id}
              aria-pressed={connector.id === item.id}
              className={`connector-tile ${connector.id === item.id ? "selected" : ""}`}
              onClick={() => selectConnector(item.id)}
            >
              <span className={`connector-icon ${item.id}`} aria-hidden="true">
                {item.name[0]}
              </span>
              <span>
                <strong>{item.name}</strong>
                <small>
                  {connectorDetails[item.id]?.summary ?? item.description}
                </small>
              </span>
            </button>
          ))}
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
              <label htmlFor="approval-assistance">Approval assistance</label>
              <select
                id="approval-assistance"
                value={delegation ? "agent" : "browser"}
                onChange={(event) =>
                  setDelegation(event.target.value === "agent")
                }
              >
                <option value="browser">I’ll approve in my browser</option>
                <option value="agent">
                  Request configured agent assistance
                </option>
              </select>
              <p>
                Configured agents can assist supported steps. Account consent
                stays with you; private input never enters model context.
              </p>
              <button onClick={() => goTo("environment")}>
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
              onDeleted={() => {
                void fetch("/api/config")
                  .then((response) => response.json())
                  .then((value) => {
                    const next = configSchema.parse(value);
                    setConfig(next);
                    const remaining =
                      next.teachingConnectors.find(
                        (id) => id !== connector.id,
                      ) ?? next.liveManifests[0]?.id;
                    if (remaining) selectConnector(remaining);
                  });
              }}
            />
          ) : liveMode && !config.liveAvailable ? (
            <div className="ceremony">
              <h3>Configure the connection server</h3>
              <p>
                Live connections need persistent encrypted storage. Set
                CEREMONY_DATABASE and CEREMONY_VAULT_KEY on the server, then
                restart. Never enter encryption keys in chat.
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
                        {model.snapshot?.method.label ?? "Choose a method"}
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
                          Access is controlled by the service, credential or
                          project policy; no OAuth scopes requested.
                        </p>
                      )
                    ) : (
                      <p>Select a method to review its requested access.</p>
                    )}
                    <h3>Enabled capabilities</h3>
                    {draft.capabilities.length ? (
                      <ul>
                        {draft.capabilities.map((capability) => (
                          <li key={capability}>
                            {capabilityDetails[capability].label}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p>
                        Credential collection only. Nothing is taught, reused or
                        delegated.
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
                          : connectorDetails[connector.id]?.documentationUrl
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
    );
  };

  if (tab === "connect")
    return (
      <div data-surface="connect" data-theme="dark">
        <ConnectCatalog
          entries={entries}
          workspace={liveMode ? "Local workspace" : "Test harness"}
          onOpen={(next: CatalogEntry) => {
            selectConnector(next.id);
            setConnectorId(next.id);
            setResuming(false);
            setOpen(true);
          }}
          onNavigate={(section) => {
            if (section === "connect") setOpen(false);
            else goTo(section);
          }}
          footer={
            config && (
              <>
                <Suspense fallback={<p>Loading extension setup…</p>}>
                  <ExtensionSetup />
                </Suspense>
                <AgentConnectors providers={config.agentProviders} />
              </>
            )
          }
        />
        {open && (
          <AddConnection
            entry={entry}
            initialStep={resuming ? 4 : 2}
            key={entry.id}
            renderRun={renderRun}
            onClose={() => setOpen(false)}
            onChangeService={() => setOpen(false)}
          />
        )}
      </div>
    );
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
          <button onClick={() => goTo("connect")}>Connect</button>
          <button
            aria-current={tab === "studio" ? "page" : undefined}
            onClick={() => goTo("studio")}
          >
            Workflow studio
          </button>
          <button
            aria-current={tab === "environment" ? "page" : undefined}
            onClick={() => goTo("environment")}
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
        {tab === "environment" && <Environment />}
        {studioOpened && (
          <div hidden={tab !== "studio"}>
            <Suspense fallback={<p role="status">Loading authoring tools…</p>}>
              <WorkflowStudio />
            </Suspense>
          </div>
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

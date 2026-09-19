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
  type AuthFamily,
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
const openedOnConnector = entryParams.get("connector") || undefined;
/**
 * Whether this page load is somebody coming back to a connection they had
 * already started, rather than arriving to browse.
 *
 * A provider round-trip returns to the host's configured path — which the
 * server requires to carry no query string of its own — with only
 * `teachingRun` appended. So "Return to connection" arrives here as
 * `/?teachingRun=…` and nothing else. Recognising just `connector` would land
 * that person in the directory, which is the one place they were not trying
 * to go.
 */
const returningToRun = Boolean(
  // `??` and not `||` would be wrong here only because an absent parameter and
  // an empty one are different values and the same intent: `?connector=` is
  // nobody's named connector, and reading it as one suppressed the `ceremony`
  // it arrived beside. Normalising the parameter above settles it once, for
  // this and for the id below, rather than at each use.
  openedOnConnector ??
  (entryParams.get("ceremony") || entryParams.get("teachingRun")),
);

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

/**
 * The families a studio-authored manifest actually offers.
 *
 * A manifest names its methods and the directory describes families; these are
 * the same claim in two vocabularies, so the row is built from what the
 * manifest already says rather than from a guess. A method this shell has no
 * family for is dropped instead of approximated, and a row left with none
 * falls back to the one family that needs nothing from the provider to draft.
 */
const methodFamilies: Record<string, AuthFamily> = {
  oauth: "oauth-code",
  "api-key": "api-key",
  basic: "basic",
  form: "basic",
  device: "device",
  anonymous: "anonymous-claim",
};

function authFamiliesOf(manifest: {
  methods: readonly { id: string }[];
}): readonly AuthFamily[] {
  const families = [
    ...new Set(
      manifest.methods
        .map((method) => methodFamilies[method.id])
        .filter((family): family is AuthFamily => family !== undefined),
    ),
  ];
  return families.length ? families : ["api-key"];
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
  const [open, setOpen] = useState(returningToRun);
  // A link carrying a connector is a resume link: the service is already
  // chosen, so the drawer opens on the run. Picking one from the directory is
  // not, and starts where the choices are.
  const [resuming, setResuming] = useState(returningToRun);
  const [resumeId, setResumeId] = useState(
    entryParams.get("ceremony") ?? undefined,
  );
  /** Bumped when a card is chosen again, so the next attempt is a new one. */
  const [attempt, setAttempt] = useState(0);
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
      catalog.map((entry) => {
        // The row claims only what the manifest behind it can do. A fixture
        // that badges itself provider-backed is the one thing a directory
        // must never say, and "declared" is what no manifest at all means.
        const manifest = manifests.find((item) => item.id === entry.id);
        const support = !manifest
          ? ("declared" as const)
          : manifest.support === "live-adapter"
            ? ("provider-backed" as const)
            : ("fixture" as const);
        return support === entry.support ? entry : { ...entry, support };
      }),
    [manifests],
  );
  /**
   * Connectors the server publishes that the static directory has never heard
   * of — anything authored in the studio — still belong in the browse surface
   * that replaced the old picker. They are described from the manifest alone.
   */
  const rows = useMemo(() => {
    const described = new Set(entries.map((entry) => entry.id));
    const authored = manifests
      .filter((manifest) => !described.has(manifest.id))
      .map((manifest): CatalogEntry => ({
        id: manifest.id,
        name: manifest.name,
        summary: manifest.description,
        category: "Other",
        support:
          manifest.support === "live-adapter" ? "provider-backed" : "fixture",
        // Read from the manifest rather than left empty. An empty list is the
        // one thing the drawer cannot open on: a draft starts from the first
        // family a row declares, so a row declaring none started on
        // `undefined` and fell past every branch of the credential form to the
        // anonymous one, under a summary naming no family at all.
        auth: authFamiliesOf(manifest),
        capabilities: ["verification"],
      }));
    return authored.length ? [...entries, ...authored] : entries;
  }, [entries, manifests]);
  /**
   * Point the application at a connector.
   *
   * `restart` is what the directory passes. Picking a card is the act of
   * starting a connection, so the run that was open under that name does not
   * carry over: the same card chosen twice is two attempts, and a resume id
   * held from the first would have the second resume it — quietly ignoring
   * whatever Configure was reopened to change. Arriving on a `&ceremony=`
   * link is the other case and still resumes, because that one is read once,
   * at entry. The tile inside the workspace passes nothing, because pressing
   * the tile that is already selected is a no-op rather than a request to
   * throw the run away.
   */
  const selectConnector = (next: string, restart = false) => {
    if (next === connectorId && !restart) return;
    setConnectorId(next);
    setResumeId(undefined);
    // Picking a card is starting a connection, and React keys on identity: for
    // a *different* service the id alone changes everything downstream, but
    // choosing the same card again changes no key at all, so the drawer stayed
    // on the step it was left on with the old draft and the run kept going
    // under it. Clearing the resume id was never enough on its own, because
    // nothing remounted to notice. This counter is what makes the second
    // attempt a second attempt.
    if (restart) setAttempt((count) => count + 1);
    history.replaceState(
      null,
      "",
      `/?connector=${encodeURIComponent(next)}${liveMode ? "" : "&mode=test"}`,
    );
  };
  const entry = rows.find((item) => item.id === connectorId);
  const connector = manifests.find((value) => value.id === connectorId);
  const goTo = (section: Section) => {
    if (section === "studio") setStudioOpened(true);
    setTab(section);
  };

  /** The connection workspace, unchanged in substance and hosted by the drawer. */
  const renderRun = (draft: ConnectionDraft) => {
    if (loadError) return <p role="alert">{loadError}</p>;
    if (!config) return <p role="status">Loading your workspace…</p>;
    if (!entry)
      return (
        <div className="ceremony">
          <h3>No connector by that name</h3>
          <p>
            This workspace publishes no connector called{" "}
            <code>{connectorId}</code>. Close this and pick one from the
            directory, or author it in the workflow studio.
          </p>
        </div>
      );
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
              /* Without this hook the component falls back to replacing the
                 location with `/`, which reloads the whole workspace to reach
                 a directory that is already on screen behind the drawer. The
                 destination is the same either way; owning it here keeps the
                 studio mounted and the scroll position intact, and it is what
                 the prop exists for. Signing out in another tab arrives the
                 same way, over the session broadcast channel. */
              onSignedOut={() => setOpen(false)}
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
              /* What Customize declared actually reaches the resolver, so the
                 cheapest route that still satisfies it is the one that runs. */
              context={{
                interruptions: draft.interruptions,
                identity: draft.identity,
              }}
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

  /**
   * Both surfaces stay in one tree. Returning early for Connect unmounted the
   * studio, which is the state the studioOpened + hidden pair exists to keep:
   * a person who glances at the directory should not come back to an empty
   * authoring session.
   */
  const connectSurface = (
    <div data-surface="connect" data-theme="dark">
      <ConnectCatalog
        entries={rows}
        workspace={liveMode ? "Local workspace" : "Test harness"}
        onOpen={(next: CatalogEntry) => {
          selectConnector(next.id, true);
          setResuming(false);
          setOpen(true);
        }}
        onNavigate={(section) => {
          if (section === "connect") setOpen(false);
          else goTo(section);
        }}
        /* A directory that cannot reach its server still draws every row it
           can describe, which reads as a working catalogue. Say so on the
           grid rather than only once somebody is inside a drawer. */
        {...(loadError
          ? {
              notice: (
                <p className="catalog-notice" role="alert">
                  {loadError}
                </p>
              ),
            }
          : {})}
        topbarExtra={
          /* This is a PWA, and the install and update controls belong on
               the page people open rather than behind another section. */
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
        }
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
      {/*
       * Mounted whenever a connector is selected, shown only when opened. The
       * drawer hosts the live connection, and a connection that unmounts takes
       * its WebMCP tools with it — so closing the drawer would withdraw
       * `ceremony_<connector>_connect` from every agent watching the page,
       * which is the one caller that cannot open a drawer to get it back.
       */}
      {entry && (
        <AddConnection
          entry={entry}
          open={open}
          initialStep={resuming ? 4 : 2}
          key={`${entry.id}:${attempt}`}
          renderRun={renderRun}
          onClose={() => setOpen(false)}
          onChangeService={() => setOpen(false)}
        />
      )}
    </div>
  );
  return (
    <>
      {/*
       * The studio comes first, and the order is load-bearing rather than
       * cosmetic. It and the connection both register `ceremony_author_*`
       * under the same names, and a second registration of a name already
       * taken is refused — so whichever mounts first owns them. With the
       * connection first, the studio's registration was refused and aborted
       * its own lifetime, and leaving Connect then took the names away with
       * the connection, leaving an authoring surface with no authoring tools.
       * Hidden either way; only the effect order changes.
       */}
      <div className="app-shell" hidden={tab === "connect"}>
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
          {/* The directory says this in its own notice; every other section
              said nothing at all, so a person deep-linking to Environment with
              the server down got an empty editor and no reason for it. */}
          {tab !== "connect" && loadError && <p role="alert">{loadError}</p>}
          {tab === "environment" && <Environment />}
          {studioOpened && (
            <div hidden={tab !== "studio"}>
              <Suspense
                fallback={<p role="status">Loading authoring tools…</p>}
              >
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
      {tab === "connect" && connectSurface}
    </>
  );
}
const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);

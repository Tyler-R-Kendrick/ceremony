import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import {
  actionsFor,
  browserModelContext,
  defaultTemplate,
  fieldsFor,
  flowKinds,
  manifestSchema,
  steps,
  type CeremonySnapshot,
  type CeremonyTemplate,
  type ConnectorManifest,
  type FlowKind,
  type Step,
} from "../../src/core/index.js";
import {
  authoringPrompt,
  BoundCeremony,
  Ceremony,
  CeremonyView,
  createHttpTransport,
  validateTemplate,
} from "../../src/react/index.js";
import "./style.css";
import { connectorDetails } from "../manifests.js";
import { Environment } from "./environment.js";

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
});
type Config = z.infer<typeof configSchema>;
function download(name: string, value: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
function preview(
  manifest: ConnectorManifest,
  kind: FlowKind,
  step: Step,
): CeremonySnapshot {
  const method = manifest.methods.find((value) => value.kind === kind);
  if (!method) throw new Error("No preview method");
  return {
    id: "preview",
    revision: 0,
    connectorId: manifest.id,
    connectorName: manifest.name,
    description: manifest.description,
    method,
    step,
    fields: fieldsFor(step, method),
    actions: actionsFor(step, kind === "authmd-anonymous"),
    expiresAt: 2_000_000_000_000,
    authorizationUrl: "#preview-only",
    verificationUri: "#preview-only",
    userCode: "482913",
    ...(["anonymous", "complete"].includes(step)
      ? {
          outcome: {
            connectionRef: "preview-only",
            ownership:
              step === "anonymous"
                ? ("anonymous" as const)
                : kind === "authmd-anonymous"
                  ? ("claimed" as const)
                  : ("authenticated" as const),
            scopes: method.scopes,
          },
        }
      : {}),
    ...(["error", "expired"].includes(step)
      ? { message: "Example: the provider did not approve this attempt." }
      : {}),
  };
}
function Studio({
  config,
  apply,
}: {
  config: Config;
  apply(template: CeremonyTemplate): void;
}) {
  const [kind, setKind] = useState<FlowKind>("oauth-code");
  const [source, setSource] = useState(
    JSON.stringify(defaultTemplate("oauth-code"), null, 2),
  );
  const [step, setStep] = useState<Step>("intro");
  const [instruction, setInstruction] = useState(
    "Calm, concise copy with a clear next action.",
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    parsed = null;
  }
  const checked = validateTemplate(parsed);
  const valid =
    checked.template?.kind === kind && checked.template.id === kind
      ? checked.template
      : undefined;
  const manifest = [...config.manifests, ...config.liveManifests].find((item) =>
    item.methods.some((method) => method.kind === kind),
  )!;
  const generate = async () => {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, connectorId: manifest.id, instruction }),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          typeof result.error === "string" ? result.error : "Generation failed",
        );
      const generated = validateTemplate(result);
      if (!generated.template) throw new Error(generated.errors.join("; "));
      setSource(JSON.stringify(generated.template, null, 2));
      setMessage(
        "Generated and validated. Review the preview, then export or use it.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Generation failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <h2>Presentation templates</h2>
          <p>
            Customize copy and layout. This isolated preview does not execute
            authentication.
          </p>
        </div>
        <span className="pill">Authoring studio</span>
      </div>
      <div className="studio-grid">
        <section className="editor-card">
          <div className="card-top">
            <h2>Template</h2>
            <span className={`validation ${valid ? "valid" : "invalid"}`}>
              {valid ? "✓ Validated" : "Needs attention"}
            </span>
          </div>
          <label htmlFor="flow-kind">Auth family</label>
          <select
            id="flow-kind"
            value={kind}
            onChange={(event) => {
              const next = flowKinds.find(
                (value) => value === event.target.value,
              );
              if (next) {
                setKind(next);
                setSource(JSON.stringify(defaultTemplate(next), null, 2));
                setMessage("");
              }
            }}
          >
            {flowKinds.map((flow) => (
              <option key={flow}>{flow}</option>
            ))}
          </select>
          <label htmlFor="instruction">Presentation direction</label>
          <textarea
            id="instruction"
            value={instruction}
            maxLength={2000}
            rows={2}
            onChange={(event) => setInstruction(event.target.value)}
          />
          <div className="toolbar">
            <button
              className="primary"
              disabled={!config.generationAvailable || busy}
              onClick={() => void generate()}
            >
              {busy ? "Generating…" : "Generate template"}
            </button>
            <button
              onClick={() =>
                download(
                  "ceremony-prompt.txt",
                  `${authoringPrompt()}\nGenerate kind: ${kind}, id: ${kind}`,
                  "text/plain",
                )
              }
            >
              Export prompt
            </button>
          </div>
          {!config.generationAvailable && (
            <p className="muted small">
              Generation is not configured. Edit a template here, or export the
              prompt and import model output.
            </p>
          )}
          <label htmlFor="template-source">
            Template source · JSON / OpenUI
          </label>
          <textarea
            id="template-source"
            className="code-editor"
            spellCheck={false}
            value={source}
            maxLength={220000}
            onChange={(event) => setSource(event.target.value)}
          />
          {!valid && (
            <div className="diagnostics" role="alert">
              {checked.errors.length ? (
                checked.errors
                  .slice(0, 5)
                  .map((error) => <p key={error}>{error}</p>)
              ) : (
                <p>Template ID and kind must match the selected auth family.</p>
              )}
            </div>
          )}
          <div className="toolbar">
            <label className="button import-button">
              Import
              <input
                type="file"
                accept="application/json,.json"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    if (file.size > 220000)
                      setMessage("Template file is too large.");
                    else void file.text().then(setSource);
                  }
                  event.target.value = "";
                }}
              />
            </label>
            <button
              disabled={!valid}
              onClick={() =>
                valid &&
                download(
                  `${valid.id}.ceremony.json`,
                  JSON.stringify(valid, null, 2),
                )
              }
            >
              Export template
            </button>
            <button
              className="primary"
              disabled={!valid}
              onClick={() => {
                if (valid) {
                  apply(valid);
                  setMessage(
                    "Template is active on the Connect page for this session. Export it to keep a copy.",
                  );
                }
              }}
            >
              Use on Connect page
            </button>
          </div>
          <p role="status" className="small">
            {message}
          </p>
        </section>
        <section className="preview-column">
          <div className="card-top">
            <h2>Presentation preview</h2>
            <span className="pill">Isolated sample data</span>
          </div>
          <label htmlFor="preview-state">Ceremony state</label>
          <select
            id="preview-state"
            value={step}
            onChange={(event) => {
              const next = steps.find((value) => value === event.target.value);
              if (next) setStep(next);
            }}
          >
            {steps.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
          <div
            className="preview-card"
            onClickCapture={(event) => {
              if (
                event.target instanceof Element &&
                event.target.closest("a,button")
              )
                event.preventDefault();
            }}
          >
            {valid ? (
              <BoundCeremony
                snapshot={preview(manifest, kind, step)}
                template={valid}
                busy={false}
                act={() => {}}
              />
            ) : (
              <div className="empty-preview">
                <p>Fix the template to see its preview.</p>
              </div>
            )}
          </div>
          <p className="muted small">
            Preview actions never contact a provider. Runtime values stay
            outside the template.
          </p>
        </section>
      </div>
    </>
  );
}
function App() {
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
  const [templates, setTemplates] = useState<CeremonyTemplate[]>([]);
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
            onClick={() => setTab("studio")}
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
        <span className="header-note">
          <span />
          Local workspace
        </span>
      </header>
      <main>
        {loadError && <p role="alert">{loadError}</p>}
        {!config && !loadError && <p role="status">Loading your workspace…</p>}
        {config && tab === "environment" && <Environment />}
        {config && tab === "studio" && (
          <>
            <div className="page-heading">
              <div>
                <h1>Workflow studio</h1>
                <p>
                  The Connections page runs the workflows. Customize their
                  presentation here.
                </p>
              </div>
            </div>
            <details className="presentation-tools">
              <summary>Advanced: customize presentation templates</summary>
              <Studio
                config={config}
                apply={(template) =>
                  setTemplates((previous) => [
                    ...previous.filter((value) => value.id !== template.id),
                    template,
                  ])
                }
              />
            </details>
            <p>
              Trusted server adapters execute provider operations. OpenUI
              templates control presentation, never authentication logic.
            </p>
            <a href="/api/workflows/github" download="github.arazzo.json">
              Export GitHub Arazzo operations
            </a>
          </>
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
                {liveMode && !config.liveAvailable ? (
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
                    templates={templates}
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
                        <CeremonyView model={model} templates={templates} />
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

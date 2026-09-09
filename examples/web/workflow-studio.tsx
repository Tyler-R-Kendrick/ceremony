import { useState, type ReactNode } from "react";
import type { ConnectorManifest } from "../../src/core/index.js";
import { Ceremony, createHttpTransport } from "../../src/react/index.js";

const liveTransport = createHttpTransport("/api/live/ceremonies");
const simulationTransport = createHttpTransport();

export function WorkflowStudio({
  manifests,
  liveManifests,
  liveAvailable,
  children,
}: {
  manifests: ConnectorManifest[];
  liveManifests: ConnectorManifest[];
  liveAvailable: boolean;
  children: ReactNode;
}) {
  const [selection, setSelection] = useState("live:github");
  const [delegation, setDelegation] = useState(false);
  const [event, setEvent] = useState("");
  const live = selection.startsWith("live:");
  const manifest = (live ? liveManifests : manifests).find(
    (item) => item.id === selection.split(":")[1],
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Workflow studio</h1>
          <p>
            Choose a service. We prepare what’s missing and guide you through
            approval.
          </p>
        </div>
      </div>
      <div className="workflow-studio">
        <aside aria-label="Workflow settings">
          <label htmlFor="workflow-service">Service</label>
          <select
            id="workflow-service"
            value={selection}
            onChange={(e) => {
              setSelection(e.target.value);
              setEvent("");
            }}
          >
            <optgroup label="Live connections">
              {liveManifests.map((item) => (
                <option key={item.id} value={`live:${item.id}`}>
                  {item.name} · live
                </option>
              ))}
            </optgroup>
            <optgroup label="Local simulations · test credentials only">
              {manifests.map((item) => (
                <option key={item.id} value={`test:${item.id}`}>
                  {item.name} · simulation
                </option>
              ))}
            </optgroup>
          </select>
          <p className="supporting">
            {live
              ? "Existing apps are reused. Missing setup is guided."
              : "This service uses the local test provider, not a live account."}
          </p>
          <details>
            <summary>Session settings and assistance</summary>
            <label htmlFor="workflow-assistance">Approval assistance</label>
            <select
              id="workflow-assistance"
              value={delegation ? "agent" : "browser"}
              onChange={(e) => setDelegation(e.target.value === "agent")}
            >
              <option value="browser">I’ll approve in my browser</option>
              <option value="agent">Request configured agent assistance</option>
            </select>
            <p className="small muted">
              Assistance requires a configured browser agent or human handoff.
              If unavailable, use the provider link. Account consent stays with
              you.
            </p>
            <a className="button" href="/?section=environment">
              Manage session environment
            </a>
          </details>
          {live && (
            <details className="workflow-developer">
              <summary>Developer integration</summary>
              <p>
                Octokit executes GitHub calls on the server. Arazzo orders
                registration and access verification. The host binds credentials
                privately.
              </p>
              <a href="/api/workflows/github" download="github.arazzo.json">
                Export Arazzo operations
              </a>
              <p className="small">
                Bound sequential profile, not a standalone credentials bundle.
                Human approval and resumable state are handled by the ceremony
                runtime.
              </p>
              <p className="small">
                Embed the same Ceremony component or framework-neutral client.
                Replace the view without changing execution, WebMCP tools or
                action hooks.
              </p>
            </details>
          )}
        </aside>
        <section className="connection-card" aria-label="Active workflow">
          <div className="card-top">
            <h2>{manifest?.name ?? "Service unavailable"}</h2>
            <span className="pill">
              {live ? "Live connection · Arazzo + Octokit" : "Local simulation"}
            </span>
          </div>
          {manifest && (!live || liveAvailable) ? (
            <Ceremony
              key={`${selection}:${delegation}`}
              manifest={manifest}
              transport={live ? liveTransport : simulationTransport}
              {...(delegation ? { delegation: "agent" as const } : {})}
              onActionSuccess={(e) => {
                if (e.action !== "read") setEvent(`${e.action}: completed`);
              }}
              onActionFailure={(e) => setEvent(`${e.action}: needs attention`)}
            />
          ) : (
            <div className="ceremony">
              <h3>Live server unavailable</h3>
              <p>
                Configure persistent encrypted storage on the server, then
                reload. Simulations remain available above.
              </p>
            </div>
          )}
          <div className="card-footer">
            <p>
              {live
                ? "Approvals happen on GitHub. Private keys and tokens remain in the encrypted server vault."
                : "Do not enter real service credentials."}
            </p>
            <p role="status">{event}</p>
          </div>
        </section>
      </div>
      <details className="presentation-tools">
        <summary>Advanced: customize presentation templates</summary>
        <p>
          OpenUI controls appearance and copy only. It does not execute
          authentication code or alter the trusted workflow.
        </p>
        {children}
      </details>
    </>
  );
}

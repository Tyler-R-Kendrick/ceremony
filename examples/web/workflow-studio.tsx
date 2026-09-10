import { useEffect, useState } from "react";
import {
  connectorProjectSchema,
  exportConnectorFiles,
  newConnectorProject,
  parseConnectorDraft,
} from "../../src/core/connector-authoring.js";
import { createAuthoringTools } from "../../src/core/authoring-tools.js";
import { browserModelContext } from "../../src/core/webmcp.js";
import { PresentationStudio } from "./presentation-studio.js";
import { validateTemplate } from "../../src/react/templates.js";

type Project = ReturnType<typeof newConnectorProject>;

function download(name: string, value: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function authoringRequest(path: string, body?: unknown) {
  const response = await fetch(`/api/v1/teaching${path}`, {
    credentials: "same-origin",
    cache: "no-store",
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  if (!response.ok) throw new Error("denied-or-unavailable");
  return response.json();
}

/** Review/export only. Provider kickoff is the authoring agent, not this page. */
export default function WorkflowStudio({
  generationAvailable = false,
}: {
  generationAvailable?: boolean;
}) {
  const [project, setProject] = useState<Project>();
  const [message, setMessage] = useState("");
  const [dirty, setDirty] = useState(false);
  const [importing, setImporting] = useState(false);
  const [replacement, setReplacement] = useState<Project>();
  const checked = project
    ? connectorProjectSchema.safeParse(project)
    : undefined;
  useEffect(() => {
    const context = browserModelContext();
    if (!context) return;
    const lifetime = new AbortController();
    const tools = createAuthoringTools("ceremony_author", {
      fromProvider: (input) =>
        authoringRequest("/authoring/from-provider", input),
      compose: (input) => authoringRequest("/authoring/compose", input),
      read: (draftId) => authoringRequest(`/authoring/drafts/${draftId}`),
    });
    void (async () => {
      try {
        for (const tool of tools) {
          if (lifetime.signal.aborted) return;
          await context.registerTool(tool, { signal: lifetime.signal });
        }
      } catch {
        lifetime.abort();
      }
    })();
    return () => lifetime.abort();
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [dirty]);
  function load(next: Project) {
    setProject(next);
    setDirty(false);
    setReplacement(undefined);
    setMessage(
      "Project opened for review. The authoring agent drafts connectors; this page does not collect provider setup.",
    );
  }
  async function importFile(file: File) {
    setImporting(true);
    try {
      if (file.size > 256 * 1024) throw new Error("size");
      const next = parseConnectorDraft(await file.text());
      if (
        next.templates.some((template) => !validateTemplate(template).template)
      )
        throw new Error("template");
      if (dirty && project) setReplacement(next);
      else load(next);
    } catch {
      setMessage(
        "Could not open this project. Use a Ceremony connector project under 256 KiB. Your current work is unchanged.",
      );
    } finally {
      setImporting(false);
    }
  }
  const importControl = (
    <label className="button import-button">
      {importing ? "Opening…" : "Open project"}
      <input
        aria-label="Open connector project"
        type="file"
        accept="application/json,.json"
        disabled={importing}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void importFile(file);
        }}
      />
    </label>
  );
  return (
    <section className="connector-authoring" aria-label="Connector authoring">
      <div className="page-heading">
        <div>
          <h1>Workflow studio</h1>
          <p>
            The authoring agent drafts provider ceremonies. This page reviews
            and exports those drafts.
          </p>
        </div>
        {project && (
          <span className="pill">
            {dirty ? "Unsaved changes" : "Draft definition"}
          </span>
        )}
      </div>
      {!project ? (
        <section className="authoring-start">
          <h2>Ask the authoring agent</h2>
          <p>
            Tell your assistant which provider to connect. It disambiguates the
            name, discovers well-known auth methods, and elicits a person only
            for provider consent or private credentials. Do not enter
            credentials here.
          </p>
          <div className="toolbar">{importControl}</div>
        </section>
      ) : (
        <section className="authoring-review" aria-labelledby="review-title">
          <h2 id="review-title">
            Review {project.manifest.name || "your connector"}
          </h2>
          <p>
            {project.manifest.description ||
              "The authoring agent has not recorded a description yet."}
          </p>
          {checked?.success ? (
            <p className="validation valid" role="status">
              Definition valid. Ready to export for host integration.
            </p>
          ) : (
            <div className="diagnostics" role="alert">
              <h3>Unresolved definition issues</h3>
              <ul>
                {checked?.error.issues.slice(0, 12).map((issue, i) => (
                  <li key={i}>
                    {issue.path.join(" › ")}: {issue.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {project.manifest.methods.map((method) => (
            <section key={method.id}>
              <h3>{method.label}</h3>
              <p>
                {method.contract!.prerequisites.length} prerequisite(s), reused
                only with compatible verified context.{" "}
                {method.scopes.length
                  ? `Permissions: ${method.scopes.join(", ")}.`
                  : "No explicit scopes declared."}
              </p>
              <ol>
                {method
                  .contract!.workflows.flatMap(
                    (ref) =>
                      project.workflows
                        .find((d) => d.document === ref.document)
                        ?.workflows.find((w) => w.workflowId === ref.workflowId)
                        ?.steps ?? [],
                  )
                  .map((step) => (
                    <li key={step.stepId}>
                      {step.description || "Unnamed step"}{" "}
                      <code>{step.operationId || "Operation required"}</code>
                    </li>
                  ))}
              </ol>
              <p>
                Human fallback:{" "}
                {method.contract!.handoff.recipient === "authorized-owner"
                  ? "authorized owner"
                  : "person connecting"}
                , via A2H. Completion requires{" "}
                <code>
                  {method.contract!.completion.verifier || "a verifier"}
                </code>
                .
              </p>
            </section>
          ))}
          <div className="authoring-boundary">
            <h3>Before this can run</h3>
            <p>
              This is a connector definition, not a deployed integration. The
              host must bind operations and verifiers. Studio never executes
              provider setup or collects credentials.
            </p>
          </div>
          <div className="toolbar">
            {importControl}
            <button
              className="primary"
              onClick={() => {
                try {
                  const saved = parseConnectorDraft(JSON.stringify(project));
                  download(
                    `${saved.manifest.id || "untitled"}.connector.json`,
                    saved,
                  );
                  setDirty(false);
                  setMessage("Project downloaded.");
                } catch {
                  setMessage(
                    "Could not save: check the 256 KiB project limit. No work was removed.",
                  );
                }
              }}
            >
              Save connector project
            </button>
            <button
              disabled={!checked?.success}
              onClick={() => {
                if (checked?.success)
                  download(
                    `${checked.data.manifest.id}.manifest.json`,
                    exportConnectorFiles(checked.data).manifest,
                  );
              }}
            >
              Export manifest
            </button>
            {checked?.success &&
              exportConnectorFiles(checked.data).workflows.map((file) => (
                <button
                  key={file.name}
                  onClick={() => download(file.name, file.definition)}
                >
                  Export {file.name}
                </button>
              ))}
          </div>
          <details>
            <summary>Advanced: inspect portable definition</summary>
            <pre>{JSON.stringify(project, null, 2)}</pre>
          </details>
          {!!project.manifest.methods.length && (
            <details className="presentation-tools">
              <summary>Customize ceremony presentation</summary>
              <PresentationStudio
                key={project.manifest.methods.map((m) => m.kind).join(":")}
                manifest={project.manifest}
                templates={project.templates}
                generationAvailable={generationAvailable}
                apply={(template) => {
                  setProject((current) => {
                    if (!current) return current;
                    const next = structuredClone(current);
                    next.templates = [
                      ...next.templates.filter(
                        (item) => item.id !== template.id,
                      ),
                      template,
                    ];
                    return next;
                  });
                  setDirty(true);
                }}
              />
            </details>
          )}
        </section>
      )}
      {replacement && (
        <div role="alert">
          <p>Opening this project will replace your unsaved edits.</p>
          <div className="toolbar">
            <button onClick={() => load(replacement)}>
              Replace unsaved draft
            </button>
            <button onClick={() => setReplacement(undefined)}>
              Keep reviewing
            </button>
          </div>
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}

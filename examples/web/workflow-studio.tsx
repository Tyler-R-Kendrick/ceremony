import { useEffect, useState } from "react";
import {
  connectorProjectSchema,
  exportConnectorFiles,
  newAuthoredMethod,
  newConnectorProject,
  parseConnectorDraft,
} from "../../src/core/connector-authoring.js";
import { flowKinds, type FlowKind } from "../../src/core/schema.js";
import { PresentationStudio } from "./presentation-studio.js";
import { validateTemplate } from "../../src/react/templates.js";

type Project = ReturnType<typeof newConnectorProject>;
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
const familyNames: Record<FlowKind, string> = {
  "api-key": "API key",
  basic: "Username and password (Basic)",
  form: "Sign-in form",
  "oauth-code": "Browser authorization (OAuth)",
  device: "Device authorization",
  "authmd-anonymous": "Anonymous access and claiming",
  "github-app": "GitHub App",
};
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

/** This editor has no connection transport, session environment, or provider client. */
export default function WorkflowStudio({
  generationAvailable = false,
}: {
  generationAvailable?: boolean;
}) {
  const [project, setProject] = useState<Project>(newConnectorProject);
  const [started, setStarted] = useState(false);
  const [stage, setStage] = useState<"details" | "ceremonies" | "review">(
    "details",
  );
  const [family, setFamily] = useState<FlowKind>("oauth-code");
  const [message, setMessage] = useState("");
  const [dirty, setDirty] = useState(false);
  const [importing, setImporting] = useState(false);
  const [replacement, setReplacement] = useState<Project>();
  const checked = connectorProjectSchema.safeParse(project);
  const change = (edit: (next: Project) => void) => {
    setProject((previous) => {
      const next = structuredClone(previous);
      edit(next);
      return next;
    });
    setDirty(true);
    setMessage("");
  };
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
    setStarted(true);
    setStage("details");
    setDirty(false);
    setReplacement(undefined);
    setMessage(
      "Project opened for editing. Nothing was installed or executed.",
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
      // Imported support metadata is a declaration, never permission to execute.
      if (dirty) setReplacement(next);
      else load(next);
    } catch {
      setMessage(
        "Could not open this project. Use a Ceremony connector project under 256 KiB with valid manifest and workflow references. Your current work is unchanged.",
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
  const nextMethodId = () => {
    let i = project.manifest.methods.length + 1;
    while (
      project.manifest.methods.some((method) => method.id === `method-${i}`)
    )
      i++;
    return `method-${i}`;
  };
  return (
    <section className="connector-authoring" aria-label="Connector authoring">
      <div className="page-heading">
        <div>
          <h1>Workflow studio</h1>
          <p>Create a connector. Design the ceremonies that connect it.</p>
        </div>
        {started && (
          <span className="pill">
            {dirty ? "Unsaved changes" : "Draft definition"}
          </span>
        )}
      </div>
      {!started ? (
        <section className="authoring-start">
          <h2>What are you connecting?</h2>
          <p>
            Start with your service, choose how users authenticate, and define
            what can run automatically and when a person needs to step in.
          </p>
          <div className="toolbar">
            <button className="primary" onClick={() => setStarted(true)}>
              Create connector
            </button>
            {importControl}
          </div>
          <p className="muted small">
            No account connection or credentials needed. Your work stays
            separate from Connect and Environment.
          </p>
        </section>
      ) : (
        <>
          <nav className="authoring-stages" aria-label="Authoring stages">
            {(["details", "ceremonies", "review"] as const).map(
              (value, index) => (
                <button
                  key={value}
                  aria-current={stage === value ? "step" : undefined}
                  onClick={() => setStage(value)}
                >
                  {index + 1}.{" "}
                  {value === "details"
                    ? "Connector"
                    : value === "ceremonies"
                      ? "Ceremonies"
                      : "Review & export"}
                </button>
              ),
            )}
          </nav>
          {stage === "details" && (
            <section
              className="authoring-form"
              aria-labelledby="connector-details-title"
            >
              <h2 id="connector-details-title">Your connector</h2>
              <label>
                Connector name
                <input
                  value={project.manifest.name}
                  maxLength={100}
                  placeholder="e.g. Acme Workspace"
                  onChange={(e) =>
                    change((p) => {
                      if (
                        !p.manifest.id ||
                        p.manifest.id === slug(p.manifest.name)
                      )
                        p.manifest.id = slug(e.target.value);
                      p.manifest.name = e.target.value;
                    })
                  }
                />
              </label>
              <label>
                Connector ID
                <input
                  aria-label="Connector ID"
                  value={project.manifest.id}
                  maxLength={64}
                  placeholder="acme-workspace"
                  onChange={(e) =>
                    change((p) => {
                      p.manifest.id = e.target.value;
                    })
                  }
                />
                <span className="muted small">
                  A stable name for apps that embed this connector. Lowercase
                  letters, numbers and hyphens.
                </span>
              </label>
              <label>
                What does this connector do?
                <textarea
                  value={project.manifest.description}
                  maxLength={500}
                  rows={3}
                  onChange={(e) =>
                    change((p) => {
                      p.manifest.description = e.target.value;
                    })
                  }
                />
              </label>
              {project.workflows.map((document, di) => (
                <label key={document.document}>
                  Provider OpenAPI document
                  <input
                    type="url"
                    value={document.sourceDescriptions[0]!.url}
                    placeholder="https://api.example.com/openapi.json"
                    maxLength={500}
                    onChange={(e) =>
                      change((p) => {
                        p.workflows[di]!.sourceDescriptions[0]!.url =
                          e.target.value;
                      })
                    }
                  />
                  <span className="muted small">
                    Public documentation only. Studio does not fetch this URL.
                    Never include keys or signed links.
                  </span>
                </label>
              ))}
              <div className="toolbar">
                <button
                  className="primary"
                  onClick={() => setStage("ceremonies")}
                >
                  Design ceremonies
                </button>
                {importControl}
              </div>
            </section>
          )}
          {stage === "ceremonies" && (
            <section aria-labelledby="auth-methods-title">
              <h2 id="auth-methods-title">How should people connect?</h2>
              <p>
                Add supported authentication methods. Each gets its own ordered
                workflow and human fallback. These are definitions, not live
                connection attempts.
              </p>
              <div className="authoring-add toolbar">
                <label>
                  Authentication method
                  <select
                    aria-label="Authentication method"
                    value={family}
                    onChange={(e) => setFamily(e.target.value as FlowKind)}
                  >
                    {flowKinds.map((kind) => (
                      <option key={kind} value={kind}>
                        {familyNames[kind]}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  disabled={project.manifest.methods.length >= 12}
                  onClick={() =>
                    change((p) => {
                      const id = nextMethodId();
                      const method = newAuthoredMethod(family, id);
                      method.contract!.workflows[0]!.document =
                        p.workflows[0]!.document;
                      method.label = familyNames[family];
                      p.manifest.methods.push(method);
                      p.workflows[0]!.workflows.push({
                        workflowId: id,
                        summary: method.label,
                        steps: [
                          {
                            stepId: "step-1",
                            description: "Verify provider access",
                            operationId: "",
                          },
                        ],
                      });
                    })
                  }
                >
                  Add method
                </button>
              </div>
              {!project.manifest.methods.length && (
                <p className="authoring-empty">
                  No ceremonies yet. Choose the first authentication method
                  above.
                </p>
              )}
              {project.manifest.methods.map((method, mi) => {
                const contract = method.contract!;
                const ref = contract.workflows[0]!;
                const docIndex = project.workflows.findIndex(
                  (doc) => doc.document === ref.document,
                );
                const workflowIndex =
                  project.workflows[docIndex]?.workflows.findIndex(
                    (w) => w.workflowId === ref.workflowId,
                  ) ?? -1;
                const workflow =
                  project.workflows[docIndex]?.workflows[workflowIndex];
                return (
                  <section
                    key={method.id}
                    className="authoring-method"
                    aria-label={`${method.label} ceremony`}
                  >
                    <div className="card-top">
                      <h3>{method.label}</h3>
                      <button
                        onClick={() =>
                          change((p) => {
                            p.manifest.methods.splice(mi, 1);
                            const references = new Set(
                              p.manifest.methods.flatMap((m) =>
                                m.contract!.workflows.map(
                                  (r) => `${r.document}:${r.workflowId}`,
                                ),
                              ),
                            );
                            for (const doc of p.workflows)
                              doc.workflows = doc.workflows.filter((w) =>
                                references.has(
                                  `${doc.document}:${w.workflowId}`,
                                ),
                              );
                            if (p.workflows.some((doc) => doc.workflows.length))
                              p.workflows = p.workflows.filter(
                                (doc) => doc.workflows.length,
                              );
                            p.templates = p.templates.filter((t) =>
                              p.manifest.methods.some((m) => m.kind === t.kind),
                            );
                          })
                        }
                      >
                        Remove method
                      </button>
                    </div>
                    <label>
                      Method name
                      <input
                        value={method.label}
                        maxLength={100}
                        onChange={(e) =>
                          change((p) => {
                            p.manifest.methods[mi]!.label = e.target.value;
                          })
                        }
                      />
                    </label>
                    <label>
                      Requested permissions
                      <input
                        value={method.scopes.join(" ")}
                        placeholder="Space-separated scopes, if required"
                        onChange={(e) =>
                          change((p) => {
                            p.manifest.methods[mi]!.scopes =
                              e.target.value.split(" ");
                          })
                        }
                        onBlur={() =>
                          change((p) => {
                            p.manifest.methods[mi]!.scopes =
                              p.manifest.methods[mi]!.scopes.filter(Boolean);
                          })
                        }
                      />
                    </label>
                    <label>
                      Completion verifier
                      <input
                        value={contract.completion.verifier}
                        maxLength={120}
                        placeholder="e.g. acme.verify-access"
                        onChange={(e) =>
                          change((p) => {
                            p.manifest.methods[
                              mi
                            ]!.contract!.completion.verifier = e.target.value;
                          })
                        }
                      />
                      <span className="muted small">
                        The host-registered check that proves access. A human
                        return alone never completes the ceremony.
                      </span>
                    </label>
                    <details>
                      <summary>Inputs and configuration requirements</summary>
                      <p>
                        Declare names and classifications, never credential
                        values. Session configuration is shared by default.
                      </p>
                      {method.fields.map((field, fi) => (
                        <div className="authoring-row" key={fi}>
                          <label>
                            Input name
                            <input
                              value={field.name}
                              onChange={(e) =>
                                change((p) => {
                                  p.manifest.methods[mi]!.fields[fi]!.name =
                                    e.target.value;
                                })
                              }
                            />
                          </label>
                          <label>
                            Input label
                            <input
                              value={field.label}
                              onChange={(e) =>
                                change((p) => {
                                  p.manifest.methods[mi]!.fields[fi]!.label =
                                    e.target.value;
                                })
                              }
                            />
                          </label>
                          <span>
                            {field.classification === "secret"
                              ? "Private credential"
                              : "Personal input"}{" "}
                            · collected privately
                          </span>
                        </div>
                      ))}
                      {contract.configuration.map((item, ci) => (
                        <div className="authoring-row" key={ci}>
                          <label>
                            Variable name
                            <input
                              value={item.name}
                              placeholder="ACME_CLIENT_ID"
                              maxLength={96}
                              onChange={(e) =>
                                change((p) => {
                                  p.manifest.methods[
                                    mi
                                  ]!.contract!.configuration[ci]!.name =
                                    e.target.value;
                                })
                              }
                            />
                          </label>
                          <label>
                            Classification
                            <select
                              value={item.classification}
                              onChange={(e) =>
                                change((p) => {
                                  p.manifest.methods[
                                    mi
                                  ]!.contract!.configuration[
                                    ci
                                  ]!.classification = e.target
                                    .value as typeof item.classification;
                                })
                              }
                            >
                              <option value="secret">Secret</option>
                              <option value="personal">Personal</option>
                              <option value="public">Public</option>
                            </select>
                          </label>
                          <button
                            onClick={() =>
                              change((p) => {
                                p.manifest.methods[
                                  mi
                                ]!.contract!.configuration.splice(ci, 1);
                              })
                            }
                          >
                            Remove variable
                          </button>
                        </div>
                      ))}
                      <button
                        disabled={contract.configuration.length >= 24}
                        onClick={() =>
                          change((p) => {
                            p.manifest.methods[
                              mi
                            ]!.contract!.configuration.push({
                              name: "",
                              source: "session-environment",
                              classification: "secret",
                              required: true,
                            });
                          })
                        }
                      >
                        Add required variable
                      </button>
                    </details>
                    <h4>Workflow steps</h4>
                    <p className="muted small">
                      Run in order through Arazzo. Use operation IDs from the
                      provider’s API and bind them to trusted SDK handlers in
                      the host.
                    </p>
                    {workflow?.steps.map((step, si) => (
                      <fieldset key={step.stepId} className="authoring-step">
                        <legend>Step {si + 1}</legend>
                        <label>
                          What happens?
                          <input
                            value={step.description}
                            maxLength={500}
                            onChange={(e) =>
                              change((p) => {
                                p.workflows[docIndex]!.workflows[
                                  workflowIndex
                                ]!.steps[si]!.description = e.target.value;
                              })
                            }
                          />
                        </label>
                        <label>
                          SDK operation ID
                          <input
                            value={step.operationId}
                            maxLength={120}
                            placeholder="e.g. accounts/get-current"
                            onChange={(e) =>
                              change((p) => {
                                p.workflows[docIndex]!.workflows[
                                  workflowIndex
                                ]!.steps[si]!.operationId = e.target.value;
                              })
                            }
                          />
                        </label>
                        <div className="toolbar">
                          <button
                            disabled={si === 0}
                            onClick={() =>
                              change((p) => {
                                const steps =
                                  p.workflows[docIndex]!.workflows[
                                    workflowIndex
                                  ]!.steps;
                                [steps[si - 1], steps[si]] = [
                                  steps[si]!,
                                  steps[si - 1]!,
                                ];
                              })
                            }
                          >
                            Move up
                          </button>
                          <button
                            disabled={si === workflow.steps.length - 1}
                            onClick={() =>
                              change((p) => {
                                const steps =
                                  p.workflows[docIndex]!.workflows[
                                    workflowIndex
                                  ]!.steps;
                                [steps[si], steps[si + 1]] = [
                                  steps[si + 1]!,
                                  steps[si]!,
                                ];
                              })
                            }
                          >
                            Move down
                          </button>
                          <button
                            disabled={workflow.steps.length === 1}
                            onClick={() =>
                              change((p) => {
                                p.workflows[docIndex]!.workflows[
                                  workflowIndex
                                ]!.steps.splice(si, 1);
                              })
                            }
                          >
                            Remove step
                          </button>
                        </div>
                      </fieldset>
                    ))}
                    <button
                      disabled={
                        !workflow ||
                        project.workflows
                          .flatMap((d) => d.workflows)
                          .reduce((n, w) => n + w.steps.length, 0) >= 32
                      }
                      onClick={() =>
                        change((p) => {
                          const steps =
                            p.workflows[docIndex]!.workflows[workflowIndex]!
                              .steps;
                          let n = steps.length + 1;
                          while (steps.some((s) => s.stepId === `step-${n}`))
                            n++;
                          steps.push({
                            stepId: `step-${n}`,
                            description: "",
                            operationId: "",
                          });
                        })
                      }
                    >
                      Add step
                    </button>
                    <details>
                      <summary>Prerequisites and human fallback</summary>
                      <label>
                        Who should help when human participation is required?
                        <select
                          value={contract.handoff.recipient}
                          onChange={(e) =>
                            change((p) => {
                              p.manifest.methods[
                                mi
                              ]!.contract!.handoff.recipient = e.target
                                .value as typeof contract.handoff.recipient;
                            })
                          }
                        >
                          <option value="initiating-subject">
                            The person connecting
                          </option>
                          <option value="authorized-owner">
                            An authorized owner
                          </option>
                        </select>
                      </label>
                      <p>
                        A2H authorization hands off to the{" "}
                        {contract.handoff.surface === "private-collector"
                          ? "private credential collector"
                          : "provider’s browser"}
                        . On return, verify provider evidence before continuing.
                      </p>
                      {contract.prerequisites.map((item, pi) => (
                        <div className="authoring-row" key={pi}>
                          <label>
                            Prerequisite ID
                            <input
                              value={item.id}
                              placeholder="app-registration"
                              onChange={(e) =>
                                change((p) => {
                                  p.manifest.methods[
                                    mi
                                  ]!.contract!.prerequisites[pi]!.id =
                                    e.target.value;
                                })
                              }
                            />
                          </label>
                          <label>
                            Prerequisite type
                            <select
                              value={item.kind}
                              onChange={(e) =>
                                change((p) => {
                                  p.manifest.methods[
                                    mi
                                  ]!.contract!.prerequisites[pi]!.kind = e
                                    .target.value as typeof item.kind;
                                })
                              }
                            >
                              <option value="configuration">
                                Configuration
                              </option>
                              <option value="provider-registration">
                                App registration
                              </option>
                              <option value="provider-consent">
                                Provider consent
                              </option>
                            </select>
                          </label>
                          <button
                            onClick={() =>
                              change((p) => {
                                p.manifest.methods[
                                  mi
                                ]!.contract!.prerequisites.splice(pi, 1);
                              })
                            }
                          >
                            Remove prerequisite
                          </button>
                        </div>
                      ))}
                      <button
                        disabled={contract.prerequisites.length >= 12}
                        onClick={() =>
                          change((p) => {
                            p.manifest.methods[
                              mi
                            ]!.contract!.prerequisites.push({
                              id: "",
                              kind: "provider-registration",
                              reuse: "verified-context",
                              handoff: {
                                surface: "provider-browser",
                                recipient: "authorized-owner",
                                delegation: "a2h-authorize",
                                resume: "verify",
                              },
                            });
                          })
                        }
                      >
                        Add prerequisite
                      </button>
                    </details>
                  </section>
                );
              })}
              <div className="toolbar">
                <button onClick={() => setStage("details")}>
                  Back to connector
                </button>
                <button className="primary" onClick={() => setStage("review")}>
                  Review connector
                </button>
              </div>
            </section>
          )}
          {stage === "review" && (
            <section
              className="authoring-review"
              aria-labelledby="review-title"
            >
              <h2 id="review-title">
                Review {project.manifest.name || "your connector"}
              </h2>
              <p>
                {project.manifest.description ||
                  "Add a description to explain the connector’s purpose."}
              </p>
              {checked.success ? (
                <p className="validation valid" role="status">
                  Definition valid. Ready to export for host integration.
                </p>
              ) : (
                <div className="diagnostics" role="alert">
                  <h3>Resolve these definition issues</h3>
                  <ul>
                    {checked.error.issues.slice(0, 12).map((issue, i) => (
                      <li key={i}>
                        {issue.path.join(" › ")}: {issue.message}
                      </li>
                    ))}
                  </ul>
                  <button
                    onClick={() =>
                      setStage(
                        project.manifest.name && project.manifest.id
                          ? "ceremonies"
                          : "details",
                      )
                    }
                  >
                    Adjust definition
                  </button>
                </div>
              )}
              {project.manifest.methods.map((method) => (
                <section key={method.id}>
                  <h3>{method.label}</h3>
                  <p>
                    {method.contract!.prerequisites.length} prerequisite(s),
                    reused only with compatible verified context.{" "}
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
                            ?.workflows.find(
                              (w) => w.workflowId === ref.workflowId,
                            )?.steps ?? [],
                      )
                      .map((step) => (
                        <li key={step.stepId}>
                          {step.description || "Unnamed step"}{" "}
                          <code>
                            {step.operationId || "Operation required"}
                          </code>
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
                  This is a connector definition, not a deployed integration.
                  The host must bind every operation and verifier to trusted
                  code, enforce prerequisites and permissions, and test the
                  provider flow. Studio never executes entered code, installs
                  connectors, or uses credentials from Environment.
                </p>
              </div>
              <div className="toolbar">
                <button
                  className="primary"
                  onClick={() => {
                    try {
                      const saved = parseConnectorDraft(
                        JSON.stringify(project),
                      );
                      download(
                        `${saved.manifest.id || "untitled"}.connector.json`,
                        saved,
                      );
                      setDirty(false);
                      setMessage(
                        "Project downloaded. Open this file in Studio to continue editing.",
                      );
                    } catch {
                      setMessage(
                        "Could not save: check the definition fields and the 256 KiB project limit. No work was removed.",
                      );
                    }
                  }}
                >
                  Save connector project
                </button>
                <button
                  disabled={!checked.success}
                  onClick={() => {
                    if (checked.success)
                      download(
                        `${checked.data.manifest.id}.manifest.json`,
                        exportConnectorFiles(checked.data).manifest,
                      );
                  }}
                >
                  Export manifest
                </button>
                {checked.success &&
                  exportConnectorFiles(checked.data).workflows.map((w) => (
                    <button
                      key={w.name}
                      onClick={() => download(w.name, w.definition)}
                    >
                      Export {w.name}
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
                    apply={(template) =>
                      change((p) => {
                        p.templates = [
                          ...p.templates.filter((t) => t.id !== template.id),
                          template,
                        ];
                      })
                    }
                  />
                </details>
              )}
              <button onClick={() => setStage("ceremonies")}>
                Edit ceremonies
              </button>
            </section>
          )}
        </>
      )}
      {replacement && (
        <div role="alert">
          <p>Opening this project will replace your unsaved edits.</p>
          <div className="toolbar">
            <button onClick={() => load(replacement)}>
              Replace unsaved draft
            </button>
            <button onClick={() => setReplacement(undefined)}>
              Keep editing
            </button>
          </div>
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
